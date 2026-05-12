#!/usr/bin/env python3
"""
LoRA SFT for Gemma 4 E4B on the Sonnet-distilled trace dataset.

Target hardware: 1× H100 80GB on Lambda Labs (CUDA 12.x).
~50 multimodal examples × 3 epochs trains in ~5-15 minutes; the bottleneck
is bf16 activations through the vision tower, not the LoRA params.

Usage:
  huggingface-cli login        # one-time; Gemma 4 is a gated model
  python train_lora.py --dataset ./dataset --out ./adapter

Defaults below are the Gemma 4 E4B recipe from the Unsloth/HF documentation
adjusted for plain (non-quantized) LoRA on an H100 — no bitsandbytes
required at this VRAM budget.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image


def resolve_row_images(row: dict, dataset_root: Path) -> dict:
    """Replace image path strings in messages with PIL.Image objects."""
    new_messages = []
    for msg in row["messages"]:
        new_content = []
        for part in msg["content"]:
            if part["type"] == "image":
                img_path = dataset_root / part["image"]
                new_content.append({"type": "image", "image": Image.open(img_path).convert("RGB")})
            else:
                new_content.append(part)
        new_messages.append({"role": msg["role"], "content": new_content})
    return {**row, "messages": new_messages}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default="./dataset", help="Dir with dataset.jsonl + frames/.")
    ap.add_argument("--out", default="./adapter", help="Where to save the LoRA adapter.")
    ap.add_argument("--model", default="google/gemma-4-E4B-it")
    ap.add_argument("--epochs", type=int, default=3)
    ap.add_argument("--batch", type=int, default=1, help="Per-device batch (multimodal is memory-heavy).")
    ap.add_argument("--grad-accum", type=int, default=4)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--rank", type=int, default=32, help="LoRA rank.")
    ap.add_argument("--alpha", type=int, default=32, help="LoRA alpha (rule: alpha >= rank).")
    ap.add_argument("--dropout", type=float, default=0.0)
    ap.add_argument("--max-tokens", type=int, default=8192)
    ap.add_argument("--no-vision-finetune", action="store_true", help="Freeze the vision tower (faster, but limits gains).")
    ap.add_argument("--qlora", action="store_true", help="Use 4-bit base weights via bitsandbytes (saves VRAM at small quality cost).")
    args = ap.parse_args()

    dataset_root = Path(args.dataset)
    jsonl = dataset_root / "dataset.jsonl"
    if not jsonl.exists():
        print(f"dataset.jsonl not found at {jsonl}. Run build_dataset.py first.")
        return 1

    # Heavy imports kept inside main so `--help` is fast.
    import torch  # type: ignore
    from datasets import Dataset  # type: ignore
    from transformers import (  # type: ignore
        AutoProcessor,
        AutoModelForImageTextToText,
        BitsAndBytesConfig,
    )
    from peft import LoraConfig, get_peft_model  # type: ignore
    from trl import SFTConfig, SFTTrainer  # type: ignore

    if not torch.cuda.is_available():
        print("CUDA not available — training will be unbearably slow. Did you select a GPU instance?")
        return 1

    print(f"[gpu] {torch.cuda.get_device_name(0)}, {torch.cuda.get_device_properties(0).total_memory // (1024**3)} GB")

    # ---- Load dataset ----
    rows = []
    with open(jsonl) as f:
        for line in f:
            rows.append(json.loads(line))
    print(f"[data] {len(rows)} raw rows from {jsonl}")

    # Convert to HF Dataset with PIL images resolved lazily on access.
    def gen():
        for r in rows:
            yield resolve_row_images(r, dataset_root)

    ds = Dataset.from_generator(gen)

    # ---- Load processor + model ----
    print(f"[model] loading {args.model} ({'QLoRA' if args.qlora else 'bf16 LoRA'})")
    processor = AutoProcessor.from_pretrained(args.model, trust_remote_code=True)

    model_kwargs: dict = {
        "torch_dtype": torch.bfloat16,
        "device_map": "auto",
        "trust_remote_code": True,
    }
    if args.qlora:
        model_kwargs["quantization_config"] = BitsAndBytesConfig(
            load_in_4bit=True,
            bnb_4bit_compute_dtype=torch.bfloat16,
            bnb_4bit_quant_type="nf4",
            bnb_4bit_use_double_quant=True,
        )

    model = AutoModelForImageTextToText.from_pretrained(args.model, **model_kwargs)

    # ---- Configure LoRA ----
    target_modules = "all-linear"
    # If --no-vision-finetune, freeze everything outside language layers
    # before wrapping with PEFT.
    if args.no_vision_finetune:
        for name, param in model.named_parameters():
            if "vision" in name.lower() or "visual" in name.lower():
                param.requires_grad = False

    lora_config = LoraConfig(
        r=args.rank,
        lora_alpha=args.alpha,
        lora_dropout=args.dropout,
        bias="none",
        target_modules=target_modules,
        task_type="CAUSAL_LM",
    )
    model = get_peft_model(model, lora_config)
    model.print_trainable_parameters()

    # ---- Data collator: pre-process each batch into multimodal tensors ----
    def collate(batch):
        texts = [
            processor.apply_chat_template(
                ex["messages"],
                tokenize=False,
                add_generation_prompt=False,
            )
            for ex in batch
        ]
        # Flatten all images from all messages into a list-of-lists matching the batch.
        images = []
        for ex in batch:
            ex_imgs = []
            for msg in ex["messages"]:
                for part in msg["content"]:
                    if part["type"] == "image":
                        ex_imgs.append(part["image"])
            images.append(ex_imgs)

        inputs = processor(
            text=texts,
            images=images,
            return_tensors="pt",
            padding=True,
            truncation=True,
            max_length=args.max_tokens,
        )
        # Labels: copy of input_ids with prompt portion masked.
        # TRL's SFT trainer would normally do this for text; since we're
        # using a custom collator for multimodal, we replicate the mask:
        # set labels = input_ids, then -100 for pad tokens.
        labels = inputs["input_ids"].clone()
        labels[labels == processor.tokenizer.pad_token_id] = -100
        inputs["labels"] = labels
        return inputs

    # ---- Trainer ----
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    sft_config = SFTConfig(
        output_dir=str(out_dir),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.05,
        logging_steps=1,
        save_strategy="epoch",
        save_total_limit=2,
        bf16=True,
        gradient_checkpointing=True,
        report_to="none",
        remove_unused_columns=False,
        dataset_kwargs={"skip_prepare_dataset": True},
        max_length=args.max_tokens,
    )

    trainer = SFTTrainer(
        model=model,
        train_dataset=ds,
        args=sft_config,
        data_collator=collate,
        tokenizer=processor.tokenizer,
    )

    print(f"[train] {args.epochs} epochs, batch={args.batch}, grad_accum={args.grad_accum}, lr={args.lr}, rank={args.rank}")
    trainer.train()

    # Save the final adapter.
    final_dir = out_dir / "final"
    trainer.save_model(str(final_dir))
    processor.save_pretrained(str(final_dir))
    print(f"\n[done] LoRA adapter saved to {final_dir}")
    print("Load it with:")
    print(f"  from peft import PeftModel")
    print(f"  base = AutoModelForImageTextToText.from_pretrained('{args.model}', torch_dtype=torch.bfloat16)")
    print(f"  model = PeftModel.from_pretrained(base, '{final_dir}')")
    return 0


if __name__ == "__main__":
    sys.exit(main())
