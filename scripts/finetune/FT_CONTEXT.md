# Fine-tune context (pass this to the agent that runs on Lambda Labs)

You are picking up a Sonnet → Gemma 4 E4B distillation task for the Knowable
tutoring app. Everything below is the ground truth you need to drive the
workflow autonomously. Read once, then execute.

## Mission

Knowable is a macOS tutoring app where a student works on paper while a
camera-watching AI (Milo) reads the page and (when asked) speaks Socratic
hints. The cloud path runs Claude Sonnet 4.6 via Bedrock; the on-device
path runs Gemma 4 E4B via Ollama. Sonnet is currently noticeably better at
reading handwritten math than out-of-the-box Gemma. Goal: **distill Sonnet
outputs into a Gemma 4 E4B LoRA adapter** so the on-device path closes the
gap, at least on the narrow target domain.

Scope (POC):
- Domain: **factoring quadratics** (high-school algebra). 50 traces is
  enough.
- Hardware: **1× H100 80GB on Lambda Labs** (CUDA 12.x, Ubuntu 22.04,
  Python 3.10/3.11).
- Quality bar: subjective. You're aiming to see, by eyeballing the
  base-vs-adapted side-by-side comparison, that the adapter pulled the
  student model toward Sonnet's behavior on the factoring-quadratics
  examples in your held-out subset.

## What's already been built (don't redo this)

1. **S3 capture pipeline** is deployed.
   - Bucket: `s3://knowable-finetune-traces` (us-east-1, private, 30-day
     lifecycle, SSE-S3).
   - Lambda `knowable-reason-stream` writes one `manifest.json` + N
     `frame-{i}.jpg` per captured pass when the client sends `capture: true`
     in the `/reason-stream` request.
   - Object layout: `traces/YYYY-MM-DD/<trace_uuid>/{manifest.json, frame-0.jpg, ...}`
   - End-to-end smoke-tested: a verified manifest exists at
     `s3://knowable-finetune-traces/traces/2026-05-12/a14dff4a-2fd1-4455-89e7-872ee9670870/`.
2. **macOS client toggle**. Settings → Developer → "Capture traces for
   fine-tune" is wired to AppStorage `milo_finetune_capture`. When on AND
   Private reasoning is OFF, every cloud /reason-stream call carries
   `capture: true`. (The local Ollama path never reaches the Lambda, so
   privacy mode + capture is a no-op.)
3. **Fine-tune scripts at `scripts/finetune/`**:
   - `requirements.txt` — Python deps for the H100 box.
   - `build_dataset.py` — S3 sync + manifest walk + image preprocessing +
     reserved-token check + HF JSONL emission.
   - `validate_dataset.py` — pre-flight using the real Gemma 4 processor.
   - `train_lora.py` — PEFT LoRA SFT on the H100, bf16 default, QLoRA
     optional via `--qlora`.
   - `inference_test.py` — base vs adapted on held-out rows.
4. **Documentation**. `knowable-be/README.md` has the user-facing
   walkthrough. This file is the deeper context for an agent.

## What the captured manifest contains

Every captured pass writes a manifest with this shape:

```json
{
  "trace_id": "uuid",
  "session_id": "...",
  "user_id": "...",
  "captured_at": "2026-05-12T16:12:41.123Z",
  "model_id": "us.anthropic.claude-sonnet-4-6",
  "system_prompt": "<full Milo system prompt, verbatim>",
  "system_prompt_sha256": "<sha>",
  "request": {
    "event_log": "[MM:SS] event_type: description\n...",
    "current_analysis": "...",
    "flags": { "is_milo_speaking": bool, "force_reply": bool, "user_query": "..." },
    "frame_count": 1-3,
    "frame_files": ["frame-0.jpg", ...]
  },
  "response": {
    "raw_text": "<exactly what Sonnet streamed, with UNDERSTANDING/EVENTS/HINT/HINT_SPEECH/STATE sections>",
    "parsed": {
      "understanding": "...",
      "events": ["[MM:SS] event_type: ...", ...],
      "hint": "..." | null,
      "hint_speech": "..." | null,
      "state": "active" | "camera_lost" | "positioning_camera"
    }
  }
}
```

Key facts about what's captured:
- **Every successful Bedrock pass is captured** when `capture: true` is set
  — both passive observation passes (no HINT) and explicit-ask passes
  (HINT + HINT_SPEECH). This is intentional.
- **Frames are the original JPEG bytes** the model saw, not re-encoded.
  Resolution is whatever the macOS Desk View capture produced (typically
  ~640×480 to ~1920×1080).
- **`raw_text` is the source of truth** for training. `parsed` is for
  debugging / filtering. Train on `raw_text`.

## Gemma 4 E4B training format (the part you must NOT get wrong)

This is the section that determines whether the trained model loads or
hard-fails. The compatibility rules below were researched against
`https://ai.google.dev/gemma/docs/core/prompt-formatting-gemma4` and
HuggingFace's Gemma 4 docs.

1. **Chat template tokens** — Gemma 4 uses `<|turn>role` / `<turn|>`, NOT
   `<start_of_turn>` like Gemma 2/3. **Never hand-build the template**;
   always call `processor.apply_chat_template(messages, ...)`. The
   processor knows the right tokens for the model version it's loaded for.
2. **System role is native** — Gemma 4 supports a `system` turn directly.
   Use `{"role": "system", "content": [...]}`, do NOT fold into the first
   user turn (that's the old Gemma 2 workaround).
3. **Image format** — RGB JPEG, sides must be **multiples of 48 px** (patch
   size of the SigLIP-derived vision tower). `build_dataset.py`
   center-crops to enforce this. Min side ~96 px to be safe.
4. **Image placement** — within a user turn, images must come **before**
   text. `build_dataset.py` enforces this.
5. **Reserved tokens** — the regex `<\|[a-z_]+\|?>|<[a-z_]+\|>` matches
   Gemma's special-token namespace. Plain `<` and `>` in math notation
   are safe. Any match in our captured text is a reject. Enforced by
   `build_dataset.py`.
6. **Thinking blocks** — Sonnet's extended-thinking syntax
   (`<thinking>...</thinking>`) uses different tokens than Gemma 4's
   (`<|channel>...<channel|>`). Strip Sonnet thinking blocks before
   training; do not attempt to translate them. Enforced by
   `build_dataset.py`. (Note: the current Lambda doesn't enable Sonnet
   thinking anyway, so this is defense-in-depth.)
7. **Sequence length** — E4B supports long context but trains slowly past
   ~8K tokens. The scripts enforce 8192 as a ceiling. With 1-3 frames
   plus the ~3K-token Milo system prompt, real traces land around 3-5K
   tokens.

The `validate_dataset.py` script runs `processor.apply_chat_template()` on
every row using `google/gemma-4-E4B-it` BEFORE training. If it passes
validation, it'll pass in training. Do not skip validation.

## Environment setup on Lambda Labs

You'll be on a fresh 1× H100 instance. Standard image has CUDA + Python.

```bash
# Clone the repo
git clone <repo-url> knowable-be
cd knowable-be/scripts/finetune

# Python deps (~5 min, big install — torch is the bulk)
pip install -r requirements.txt

# AWS creds for the S3 sync. IAM user needs s3:Get* + s3:List on
# arn:aws:s3:::knowable-finetune-traces. Configure once:
aws configure

# HuggingFace login (Gemma 4 is gated — you must accept the license on
# the model card first at https://huggingface.co/google/gemma-4-E4B-it).
huggingface-cli login
```

## The workflow, in order

```bash
# 1. Sync traces + build dataset
python build_dataset.py --sync --out ./dataset
#   Reads s3://knowable-finetune-traces/, writes:
#     ./dataset/dataset.jsonl     — one row per accepted trace
#     ./dataset/frames/<trace>/   — resized RGB JPEGs
#   Watch the [skip ...] lines: each is a rejected trace, with a reason.
#   Common rejections: too small after crop (low-res webcam frames),
#   reserved-token collision (Sonnet quoted a Gemma special token).
#   Sanity check: open one row and confirm `messages` is shaped like
#     system → user(image*, text) → assistant.

# 2. Pre-flight validation against the real Gemma 4 processor
python validate_dataset.py --dataset ./dataset
#   Should print "[summary] N pass, 0 fail" where N == accepted row count.
#   ANY fail is a blocker — do not proceed to training. Look at the
#   specific error message for the failing row, fix at the manifest or
#   build_dataset.py level, re-run.

# 3. Train the LoRA adapter
python train_lora.py --dataset ./dataset --out ./adapter
#   Starting hyperparameters (defaults):
#     rank=32, alpha=32, dropout=0, target_modules="all-linear"
#     bf16, gradient_checkpointing on, lr=2e-4 cosine, warmup 5%
#     epochs=3, batch=1, grad_accum=4 (effective batch=4)
#     max_length=8192
#   On 50 examples, expect 5-15 minutes total. Watch the loss curve —
#   on this small a dataset, train loss should drop from ~3.5-4.0 to
#   ~1.5-2.0 over 3 epochs. If it plateaus high (>2.5), bump epochs to
#   5 or rank to 64. If it crashes to <0.5 in epoch 1, you're
#   overfitting hard; cut epochs to 1 or add dropout.
#   Adapter saved to ./adapter/final/

# 4. Compare base vs adapted, eyeball quality
python inference_test.py --dataset ./dataset --adapter ./adapter/final --n 5
#   Prints reference (Sonnet) / base Gemma / adapted Gemma side-by-side
#   for the last 5 traces in the dataset. Look for:
#     - Adapted output produces the correct UNDERSTANDING/EVENTS/HINT/
#       HINT_SPEECH/STATE structure (base often won't without prompting).
#     - Adapted output references the page content the way Sonnet did,
#       not generically.
#     - Adapted output's HINT_SPEECH is symbol-free conversational English.
#   If the adapter is clearly worse than base — start over. The most
#   likely cause is too few traces and/or the system prompt drifted
#   across the dataset (validate_dataset.py warns if you have multiple
#   system_prompt_sha256 values).
```

## After training succeeds (deploy to the macOS app)

The macOS app runs Gemma 4 E4B via Ollama. To use the adapted weights
on-device, merge + convert to GGUF, then publish as an Ollama model.

```bash
# 1. Merge LoRA into a standalone HF model
python -c "
from transformers import AutoModelForImageTextToText
from peft import PeftModel
import torch
base = AutoModelForImageTextToText.from_pretrained(
    'google/gemma-4-E4B-it', torch_dtype=torch.bfloat16, trust_remote_code=True
)
m = PeftModel.from_pretrained(base, './adapter/final').merge_and_unload()
m.save_pretrained('./merged')
"

# 2. Convert to GGUF (Q4_K_M is the standard 'fits on a kid's laptop' quant)
git clone https://github.com/ggerganov/llama.cpp /tmp/llama.cpp
cd /tmp/llama.cpp && pip install -r requirements.txt && cd -
python /tmp/llama.cpp/convert_hf_to_gguf.py ./merged --outfile ./gemma4-e4b-knowable.gguf --outtype q4_k_m

# 3. Build an Ollama Modelfile + publish
cat > Modelfile <<EOF
FROM ./gemma4-e4b-knowable.gguf
PARAMETER temperature 0.4
PARAMETER num_ctx 8192
EOF
ollama create knowable-gemma4 -f Modelfile

# 4. To make the Mac app use it, edit one line in
#    `Knowable/Services/Reasoning/LocalReasoningBackend.swift`:
#    `static let modelTag = "knowable-gemma4:latest"`
```

## Decisions you may need to make autonomously

You're free to act on any of these without checking back:

- **Reject more aggressively than the script does** if a manifest looks
  bad (e.g. frame is blank/dark/glare, response is truncated mid-sentence).
  Hand-edit `dataset.jsonl` to drop the row, or extend
  `build_dataset.py` filters and re-run.
- **Pick `--qlora`** if you somehow OOM on bf16 (unlikely on H100; we have
  80GB and bf16 LoRA for E4B is ~17GB peak).
- **Increase `--epochs`** to 5-10 if you observe under-fitting (loss
  plateaus high). With 50 examples, more epochs is cheap and the risk of
  overfitting is bounded by LoRA's parameter count.
- **Add a `--hints-only` mode to `build_dataset.py`** if you want a
  separate filtered dataset with only force_reply=true traces (rows where
  `parsed.hint` is non-null). Useful if you want to train a hint-style
  adapter rather than a full-output adapter.

## Things to NOT do

- **Don't change the system prompt** in `build_dataset.py`. Every captured
  manifest stores the exact prompt Sonnet saw; training on that prompt
  preserves the conditioning. If you swap in a different system prompt,
  the LoRA will overfit to the swap.
- **Don't try to translate `<thinking>` → `<|channel>`**. Just strip.
- **Don't train on H100 with the model in fp32**. bf16 is mandatory at
  E4B's size — fp32 will OOM and waste time.
- **Don't merge the adapter into base and re-finetune**. If you want a
  second pass, train a new LoRA on top of the merged base, but keep the
  adapters separate so you can A/B them.
- **Don't push the merged weights anywhere public**. They contain
  Sonnet's outputs; redistribution of Anthropic-generated content is
  Anthropic-ToS-sensitive. POC use only.

## Sanity-check checklist before declaring done

- [ ] `build_dataset.py` accepted ≥40 of your ~50 captured traces.
- [ ] `validate_dataset.py` returned 0 failures.
- [ ] Training loss dropped meaningfully (≥30% from start to end).
- [ ] `inference_test.py` shows the adapted model producing well-formed
      UNDERSTANDING / EVENTS / HINT_SPEECH / STATE sections, referencing
      page-specific content.
- [ ] Adapter checkpoint at `./adapter/final/` is < 500 MB (LoRA at rank
      32 produces ~100-300 MB).
- [ ] If deploying: GGUF file builds and `ollama run knowable-gemma4`
      responds without errors.

## Where to look when something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| `ImportError: cannot import name 'AutoModelForImageTextToText'` | Transformers too old | `pip install -U "git+https://github.com/huggingface/transformers.git"` |
| `OSError: google/gemma-4-E4B-it not found` | No HF auth or didn't accept license | `huggingface-cli login` + visit the model page |
| `AccessDenied` on S3 sync | IAM user lacks Get/List on the bucket | Attach `s3:GetObject` + `s3:ListBucket` to your AWS user |
| `RuntimeError: CUDA out of memory` | bf16 LoRA shouldn't OOM on H100; check `nvidia-smi` for stragglers | Restart, or fall back to `--qlora` |
| Training loss stays flat | LR too low, or all-zero labels | Bump `--lr` to 5e-4; verify dataset rows have `assistant` turns |
| `apply_chat_template` errors | Reserved-token collision or malformed messages | Re-run `validate_dataset.py`, fix the specific row |
| Adapter inference produces garbage | Wrong base model checkpoint or `add_generation_prompt=False` in trainer | Confirm `train_lora.py` saved `processor` alongside adapter; reload both together |

## Contact / where to report back

You're operating autonomously. Report back to the user when you have:
1. A trained adapter at `./adapter/final/`, AND
2. Output from `inference_test.py --n 5` showing the base vs adapted
   comparison on 5 traces.

That's the deliverable. The user will eyeball the side-by-side and decide
whether to deploy via GGUF + Ollama. Don't wait for confirmation between
steps — the whole loop (sync → build → validate → train → test) is one
~30-minute run end to end.
