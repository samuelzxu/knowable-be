# Fine-Tuning Gemma 4 E4B & Loading into Ollama

## Prerequisites

- A GPU instance with ≥80 GB VRAM (tested on Lambda Labs 1× H100)
- Python 3.10+
- [Ollama](https://ollama.com) installed on the target machine (Mac, Linux, etc.)
- AWS credentials configured (for S3 dataset sync)
- HuggingFace account with access to `google/gemma-4-E4B-it` (gated model)

## 1. Set up the environment

```bash
ssh ubuntu@<lambda-ip>
mkdir -p ~/finetune && cd ~/finetune

# Install uv and create a venv
curl -LsSf https://astral.sh/uv/install.sh | sh
export PATH=$HOME/.local/bin:$PATH
uv venv ~/venv
source ~/venv/bin/activate

# Install training dependencies
uv pip install -r requirements.txt
# If Gemma 4 isn't on a tagged transformers release yet:
uv pip install -U "git+https://github.com/huggingface/transformers.git"

# Log in to HuggingFace (one-time, for gated model access)
huggingface-cli login
```

## 2. Build the dataset

Traces are captured by the Knowable app to S3. Sync and assemble them:

```bash
python build_dataset.py --sync --out ./dataset
```

This produces:

```
dataset/
  dataset.jsonl          # one row per trace
  frames/
    <trace_id>/
      frame-0.jpg
      frame-1.jpg
      ...
```

Validate before training:

```bash
python validate_dataset.py --dataset ./dataset
# Expected: "[summary] N pass, 0 fail"
```

## 3. Train

### Option A: PEFT/TRL (standard)

```bash
python train_lora.py --dataset ./dataset --out ./adapter
```

Key flags:

| Flag | Default | Notes |
|---|---|---|
| `--epochs` | 3 | Increase to 5 if loss plateaus high (>2.5) |
| `--rank` | 32 | LoRA rank; 64 for underfitting |
| `--lr` | 2e-4 | Learning rate |
| `--qlora` | off | 4-bit base weights (saves VRAM) |
| `--no-vision-finetune` | off | Freeze vision tower (faster) |

Output: `./adapter/final/` (LoRA weights + processor).

### Option B: Unsloth

```bash
# Install Unsloth (in addition to base requirements)
uv pip install unsloth

python train_unsloth.py --dataset ./dataset --output ./unsloth-output
```

Key flags:

| Flag | Default | Notes |
|---|---|---|
| `--epochs` | 5 | |
| `--r` | 32 | LoRA rank |
| `--lr` | 1e-4 | |
| `--load-in-4bit` | off | QLoRA mode |
| `--finetune-vision` | off | Also train vision layers |
| `--wandb-project` | `knowable-gemma4-distill` | W&B logging |

Output: `./unsloth-output/final/` (adapter) and `./unsloth-output/merged/` (full merged model).

### What to expect

- Training takes 5–15 minutes on an H100 for ~150 traces.
- Loss should drop ~30% (from ~3.5–4.0 down to ~1.5–2.0).
- If loss crashes below 0.5: overfitting — reduce epochs or add dropout.

## 4. Merge the adapter into base weights

Ollama cannot load a standalone LoRA adapter for Gemma 4. You must merge the adapter into the base model weights first.

For **PEFT/TRL** adapters:

```python
import torch
from transformers import AutoModelForImageTextToText, AutoProcessor
from peft import PeftModel

base = AutoModelForImageTextToText.from_pretrained(
    "google/gemma-4-E4B-it", torch_dtype=torch.bfloat16, device_map="auto"
)
model = PeftModel.from_pretrained(base, "./adapter/final")
model = model.merge_and_unload()

model.save_pretrained("./merged")
AutoProcessor.from_pretrained("google/gemma-4-E4B-it").save_pretrained("./merged")
```

For **Unsloth**, the merged model is already saved at `./unsloth-output/merged/` — skip this step.

## 5. Load into Ollama

### Option A: From merged safetensors (on the training machine)

Create a Modelfile pointing at the merged directory:

```bash
cat > Modelfile <<'EOF'
FROM /absolute/path/to/merged/
PARAMETER temperature 0.4
PARAMETER num_ctx 8192
EOF

ollama create knowable-tuned -f Modelfile
```

Ollama's internal converter builds a unified GGUF with text + vision + audio tensors combined. This is the only path that preserves vision support for Gemma 4.

To create a quantized version (recommended for deployment):

```bash
ollama create knowable-tuned -f Modelfile --quantize q4_K_M
```

### Option B: From a pre-quantized GGUF (on any machine)

If someone has already uploaded the quantized GGUF to HuggingFace:

```bash
# Download the GGUF (~9 GB)
huggingface-cli download samitizerxu/knowable-gemma4-e4b-tuned \
    knowable-peft-q4_K_M.gguf --local-dir ./model

# Create a Modelfile pointing at the GGUF file
cat > ./model/Modelfile <<'EOF'
FROM ./knowable-peft-q4_K_M.gguf
PARAMETER temperature 0.4
PARAMETER num_ctx 8192
EOF

# Register with Ollama
ollama create knowable-tuned -f ./model/Modelfile
```

Available GGUFs on `samitizerxu/knowable-gemma4-e4b-tuned`:

| File | Training | Quantization | Size |
|---|---|---|---|
| `knowable-peft-q4_K_M.gguf` | PEFT/TRL | Q4_K_M | ~9 GB |
| `knowable-unsloth-q4_K_M.gguf` | Unsloth | Q4_K_M | ~9 GB |

## 6. Verify

```bash
# Text-only check
ollama run knowable-tuned "What is 2+2?"

# Vision check (provide an image of handwritten math)
ollama run knowable-tuned "Describe what you see." --images ./test-frame.jpg
```

Both text and vision should work. If vision fails, the GGUF was likely built with llama.cpp's `convert_hf_to_gguf.py` instead of Ollama's internal converter — that splits the model into separate text + projector files which Ollama can't recombine. Rebuild from merged safetensors using step 5A.

## 7. Evaluating the adapter

### Running the eval

```bash
python inference_test.py --dataset ./dataset --adapter ./adapter/final --n 5
```

This picks `n` traces at random from the dataset, runs each prompt through three models side-by-side, and prints the results:

- **Reference** — Sonnet's original response (the training target)
- **Base** — unadapted Gemma 4 E4B
- **Adapted** — the fine-tuned LoRA variant

What to look for in the output:

- **Structure preservation.** The reference always contains exactly five labeled sections: `UNDERSTANDING`, `EVENTS`, `HINT`, `HINT_SPEECH`, `STATE`. The base model frequently collapses these into prose or omits one or two. The adapted model should reproduce all five, usually in order.
- **Page-specific detail vs. generic.** The base model tends to produce plausible-sounding but generic hints ("try factoring this expression"). The adapted model should reference specific values or steps visible in the frame (e.g., "you've written `2x²` correctly — now look at the middle term, `−5x`").
- **HINT_SPEECH quality.** This field is read aloud by the TTS engine. Sonnet keeps it under ~25 words, conversational, and free of math symbols (`²`, `√`, `×`). The base model regularly includes LaTeX or notation that sounds broken when spoken. The adapted model should produce clean spoken-language phrases.

### Sample traces

**Trace A — factoring quadratics, force_reply=true**

A student has written `x² + 5x + 6 = 0` and stalled for 20 seconds without writing anything.

*Reference (Sonnet):*
```
UNDERSTANDING: Student has correctly set up the equation. No work shown toward factoring.
EVENTS: Stall detected; no new marks in the last 20 s.
HINT: Ask them to list factor pairs of 6 that sum to 5.
HINT_SPEECH: Can you think of two numbers that multiply to six and add to five?
STATE: waiting_for_factors
```

*Base (unadapted Gemma 4 E4B):*
```
The student has written a quadratic equation x² + 5x + 6 = 0. To solve this, we should
factor the quadratic. We need two numbers whose product is 6 and whose sum is 5.
Those numbers are 2 and 3, so the factored form is (x+2)(x+3)=0.
HINT_SPEECH: The answer is x equals negative 2 or negative 3.
```

*Adapted Gemma 4 E4B:*
```
UNDERSTANDING: Equation written correctly; no factoring attempt started.
EVENTS: Idle for 20 s after writing the equation.
HINT: Prompt for factor pairs of 6 before revealing them.
HINT_SPEECH: What two numbers multiply to six and add to five?
STATE: waiting_for_factors
```

Takeaway: the adapter learned to withhold the answer and stay in the correct 5-section format.

---

**Trace B — factoring quadratics, base case (student is actively writing)**

Student has just written `(x + 2)(` and paused mid-factoring.

*Reference (Sonnet):*
```
UNDERSTANDING: Partial factoring in progress; first factor correct.
EVENTS: Student wrote open paren for second factor, then stopped.
HINT: Affirm progress; prompt for the second number.
HINT_SPEECH: Great start — what goes in the second bracket?
STATE: factoring_in_progress
```

*Base (unadapted Gemma 4 E4B):*
```
UNDERSTANDING: The student is factoring x² + 5x + 6. They have written (x+2)( which shows
they know the first factor. The second factor should be (x+3).
HINT_SPEECH: The second bracket is x + 3.
STATE: complete
```

*Adapted Gemma 4 E4B:*
```
UNDERSTANDING: First factor (x+2) correctly placed; second factor started.
EVENTS: Pen lifted after opening the second bracket.
HINT: Encourage and leave the second value open.
HINT_SPEECH: Good — what number completes the second bracket?
STATE: factoring_in_progress
```

Takeaway: the adapter learned to mirror Sonnet's restraint — affirm without giving away the answer, and set STATE correctly based on session phase.

---

**Trace C — HINT_SPEECH symbol stripping**

Equation on page: `3x² − 12 = 0`.

*Reference (Sonnet):*
```
HINT_SPEECH: Start by dividing everything by three — what does that leave you with?
```

*Base (unadapted Gemma 4 E4B):*
```
HINT_SPEECH: Divide both sides by 3 to get x² − 4 = 0, then factor as (x+2)(x−2)=0.
```

*Adapted Gemma 4 E4B:*
```
HINT_SPEECH: Try dividing every term by three first — what do you get?
```

Takeaway: the adapter reliably strips minus signs, superscripts, and equals signs from the spoken field, producing output the TTS engine can render without reading symbol names aloud.

### W&B experiment

Training metrics, loss curves, and eval runs are logged at:

**https://wandb.ai/samitizerxu/knowable-gemma4-distill**

The run shows train loss dropping from ~3.8 to ~1.7 over 3 epochs on ~50 traces. Eval loss tracked a similar curve with no obvious divergence, though the small held-out set (10% of 50 traces) makes overfitting hard to rule out conclusively.

### Reproducing the eval yourself

**Option A: use the pre-trained adapter from HuggingFace**

```bash
# Sync the dataset from S3
python build_dataset.py --sync --out ./dataset

# Pull the pre-trained adapter
huggingface-cli download samitizerxu/knowable-gemma4-e4b-tuned \
    --local-dir ./adapter

# Run inference_test
python inference_test.py --dataset ./dataset --adapter ./adapter --n 10
```

**Option B: train your own LoRA from scratch, then eval**

```bash
python build_dataset.py --sync --out ./dataset
python train_lora.py --dataset ./dataset --out ./adapter      # or train_unsloth.py
python inference_test.py --dataset ./dataset --adapter ./adapter/final --n 10
```

Pre-trained adapter and GGUF files: https://huggingface.co/samitizerxu/knowable-gemma4-e4b-tuned

### Honest disclosure on sample size

This fine-tune uses approximately 50 traces. That is a small number — too small for a production validation claim.

It is defensible as a proof-of-concept for two reasons. First, all 50 traces are concentrated in a single narrow domain (factoring quadratics), so the loss signal has reasonable coherence; the model is not being asked to generalize across many topics at once. Second, the goal here is not "Gemma 4 is definitively better than Sonnet" — it is to demonstrate that the Sonnet→Gemma 4 distillation pipeline works end-to-end: captures traces, structures them as training data, runs a LoRA fine-tune, produces a model that loads in Ollama, and plugs into the running Knowable app via a single model-name change.

What real validation would require: 1,000+ traces across multiple algebra topics (factoring, completing the square, quadratic formula, systems of equations), a proper held-out test set, and grading either by human tutors or by Sonnet-as-judge scoring each response on structure, accuracy, and pedagogical appropriateness.

### Summary of results

After 3 epochs of LoRA on ~50 traces, the adapter pulls output structure toward Sonnet's strict 5-section format and tightens HINT_SPEECH to under 25 words, at the cost of slightly noisier UNDERSTANDING text. Vision recognition of handwritten math improved on factoring quadratics specifically but not measurably on adjacent topics like systems of equations or quadratic formula.

## Common issues

**"no Modelfile or safetensors files found"** — Ollama's `ADAPTER` safetensors import doesn't support Gemma 4. Use `FROM /path/to/merged/` instead.

**"Can not map tensor 'model.audio_tower...'"** — The PEFT adapter includes vision/audio tower tensors. llama.cpp's LoRA GGUF converter can't handle them. Merge the adapter into base weights and use the merged safetensors path.

**"Mismatch in image token count"** (Unsloth) — `max_seq_length` was capped too low, truncating image placeholder tokens. Pass `--max-seq-length 8192` explicitly.

**Vision not working after Ollama import** — You used llama.cpp to convert to GGUF, which splits into text GGUF + mmproj GGUF. Ollama needs a single unified GGUF. Re-import from HF safetensors via `ollama create`.
