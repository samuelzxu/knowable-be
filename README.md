# knowable-be

Knowable's AWS backend (TypeScript Lambdas + Terraform) and the offline tooling
for distilling LLM reasoning traces into Gemma 4 E4B.

```
src/handlers/         Lambda entry points (reason-stream, share, classes, …)
src/lib/              shared utilities (bedrock, dynamo, reason-schemas, trace-capture)
infrastructure/       Terraform (Lambdas, DynamoDB, Cognito, S3 buckets)
scripts/finetune/     LLM -> Gemma 4 E4B distillation tooling
```

## Running locally

```bash
npm install
npm test                   # vitest, ~250ms
npm run typecheck          # tsc --noEmit
npm run build:lambdas      # esbuild + zip into infrastructure/build/*.zip
```

## Deploying

```bash
cd infrastructure
terraform apply -var-file=.env.tfvars
```

Single-Lambda deploys (after `npm run build:lambdas`):

```bash
terraform apply -var-file=.env.tfvars -target=aws_lambda_function.reason_stream
```

---

## LLM → Gemma 4 E4B distillation

The reason-stream Lambda can capture (frames, request_context, sonnet_response)
tuples to S3 when the client sets `capture: true` on its request. Those tuples
become a fine-tune dataset for Gemma 4 E4B, run on a 1× H100 box on Lambda
Labs.

### One-time AWS setup

`infrastructure/finetune.tf` defines the bucket + IAM. Deploy with:

```bash
cd infrastructure
terraform apply -var-file=.env.tfvars \
  -target=aws_s3_bucket.finetune_traces \
  -target=aws_iam_policy.finetune_traces_put \
  -target=aws_iam_role_policy_attachment.finetune_traces_put \
  -target=aws_lambda_function.reason_stream
```

The bucket has 30-day object expiration, all public access blocked, and
SSE-S3 encryption. Bucket name: `knowable-finetune-traces`.

### Collecting traces

1. In the macOS app, open Settings → **Developer** → toggle
   **"Capture traces for fine-tune"** on.
2. Make sure **Private reasoning** is OFF (capture only fires for cloud
   requests; the local Ollama path doesn't reach the Lambda).
3. Run a session and work problems in your target domain (factoring
   quadratics, etc.). Each /reason-stream pass writes one trace to S3.
4. Aim for ~50 traces for a POC. Turn the toggle off when done.
5. Each trace lives at:
   ```
   s3://knowable-finetune-traces/traces/YYYY-MM-DD/<uuid>/
     ├── manifest.json           # full context + Sonnet response
     ├── frame-0.jpg             # frames as the model saw them
     └── frame-1.jpg
   ```

### Fine-tuning on Lambda Labs

The training scripts live in `scripts/finetune/`. They're designed for a
**1× H100 80GB on Lambda Labs** (CUDA 12.x, Ubuntu 22.04, Python 3.10/3.11).

```bash
# On the Lambda Labs instance
git clone <this repo>
cd knowable-be/scripts/finetune

# Python deps
pip install -r requirements.txt

# Authenticate to S3 and HuggingFace
aws configure                              # IAM keys with s3:Get on the bucket
huggingface-cli login                      # Gemma 4 is a gated model

# 1. Sync traces from S3 + build the HF dataset
python build_dataset.py --sync --out ./dataset
#   → wipes ./dataset, reads s3://knowable-finetune-traces/, writes:
#       ./dataset/dataset.jsonl     (one row per trace, messages-shaped)
#       ./dataset/frames/<trace>/   (resized RGB JPEGs)

# 2. Pre-flight validation against the actual Gemma 4 processor
python validate_dataset.py --dataset ./dataset
#   → runs apply_chat_template on every row; fails fast if anything's
#     incompatible BEFORE we spin up the training run.

# 3. Train the LoRA adapter (~5-15 min for 50 examples, 3 epochs)
python train_lora.py --dataset ./dataset --out ./adapter
#   → ./adapter/final contains the saved PEFT adapter + processor.

# 4. Inspect base vs adapted side-by-side
python inference_test.py --dataset ./dataset --adapter ./adapter/final --n 5
```

### Deploying the adapter to the macOS app (Ollama)

The Mac app uses Ollama as its on-device runtime. To run the adapted model
on-device, merge + convert to GGUF:

```bash
# Still on the Lambda Labs box (or any CUDA host with llama.cpp):
# 1. Merge LoRA into a standalone HF model
python -c "
from transformers import AutoModelForImageTextToText
from peft import PeftModel
import torch
base = AutoModelForImageTextToText.from_pretrained('google/gemma-4-E4B-it', torch_dtype=torch.bfloat16)
model = PeftModel.from_pretrained(base, './adapter/final').merge_and_unload()
model.save_pretrained('./merged')
"

# 2. Convert to GGUF (Q4_K_M is a good default for desk-class hardware)
git clone https://github.com/ggerganov/llama.cpp /tmp/llama.cpp
python /tmp/llama.cpp/convert_hf_to_gguf.py ./merged --outfile ./gemma4-e4b-knowable.gguf

# 3. Package as an Ollama model
cat > Modelfile <<EOF
FROM ./gemma4-e4b-knowable.gguf
PARAMETER temperature 0.4
EOF
ollama create knowable-gemma4 -f Modelfile

# 4. On the Mac, update LocalReasoningBackend.swift to use the new tag:
#    static let modelTag = "knowable-gemma4:latest"
#    (or keep gemma4:e4b and point Ollama at the new file via tag aliases.)
```

### Gemma 4 E4B compatibility checklist

The scripts already enforce these — listed here so you know what's being
checked and what to fix if a trace is rejected:

| Check | Where enforced |
|---|---|
| Images are RGB (alpha stripped) | `build_dataset.py crop_to_multiple` |
| Image sides are multiples of 48 px (Gemma vision patch size) | `build_dataset.py crop_to_multiple` |
| No reserved-token collisions (`<\|*\|>`/`<*\|>`) | `build_dataset.py has_reserved_token_collision` |
| `<thinking>...</thinking>` blocks stripped from response | `build_dataset.py clean_response_text` |
| Total prompt tokens ≤ 8192 | `validate_dataset.py` |
| `processor.apply_chat_template` succeeds | `validate_dataset.py` |
| All rows share the same system prompt | `build_dataset.py` (warns if drift) |
| 1–3 frames per row | upstream — client never sends more |

### Cost notes

- **Per trace**: ~0.2-0.5 MB of S3 storage (~300 KB per JPEG × 1-3 frames + ~10 KB manifest).
- **Per training run** (50 traces, 3 epochs, H100): ~$1-3 of Lambda Labs time.
- **30-day bucket lifecycle**: enabled by default; traces auto-delete unless you copy them elsewhere first.

### Turning capture off

- **Per-session**: toggle off in app settings.
- **Globally** (block all captures regardless of client request): remove the
  `FINETUNE_TRACE_BUCKET` env var from `infrastructure/lambda.tf` and redeploy.
  The capture function early-returns when the env var is absent.

---

## Other backend areas

(Not exhaustive — read the file-level header comments for the full picture.)

- **reason-stream** (`src/handlers/reason-stream.ts`) — SSE Lambda for the
  main reasoning loop; calls Bedrock + ElevenLabs in parallel.
- **share** (`src/handlers/share.ts`) — student → educator trace sharing.
- **classes**, **educator** — class CRUD + invite-code gating.
- **DynamoDB tables** — sessions, messages, classes, memberships, traces,
  invites. See `infrastructure/dynamodb.tf`.
- **Cognito** — student + educator pools, Apple/Google IdP. See
  `infrastructure/cognito*.tf`.
