# Fine-Tuning Gemma 4 E4B & Loading into Ollama

## Prerequisites

- A GPU instance with ≥80 GB VRAM (tested on Lambda Labs 1× H100)
- Python 3.10+
- [Ollama](https://ollama.com) installed on the target machine (Mac, Linux, etc.)
- AWS CLI installed (dataset is in a public S3 bucket — no credentials needed)
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

Traces are in a public S3 bucket. Sync and assemble them:

```bash
aws s3 sync s3://knowable-finetune-traces-public ./raw --no-sign-request
python build_dataset.py --raw ./raw --out ./dataset
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

## Common issues

**"no Modelfile or safetensors files found"** — Ollama's `ADAPTER` safetensors import doesn't support Gemma 4. Use `FROM /path/to/merged/` instead.

**"Can not map tensor 'model.audio_tower...'"** — The PEFT adapter includes vision/audio tower tensors. llama.cpp's LoRA GGUF converter can't handle them. Merge the adapter into base weights and use the merged safetensors path.

**"Mismatch in image token count"** (Unsloth) — `max_seq_length` was capped too low, truncating image placeholder tokens. Pass `--max-seq-length 8192` explicitly.

**Vision not working after Ollama import** — You used llama.cpp to convert to GGUF, which splits into text GGUF + mmproj GGUF. Ollama needs a single unified GGUF. Re-import from HF safetensors via `ollama create`.
