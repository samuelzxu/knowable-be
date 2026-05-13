#!/usr/bin/env python3
"""
Fine-tune Gemma 4 E4B using Unsloth on the Knowable dataset.

Mirrors the PEFT/TRL training but uses Unsloth for the Unsloth finetuning track.

Usage:
  python train_unsloth.py --dataset ./dataset --output ./unsloth-output
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image


def load_dataset_rows(dataset_root: Path):
    jsonl = dataset_root / "dataset.jsonl"
    rows = []
    with open(jsonl) as f:
        for line in f:
            rows.append(json.loads(line))
    return rows


def convert_row_to_unsloth(row: dict, dataset_root: Path) -> dict:
    """Convert our dataset format to Unsloth's expected format.
    Images must be PIL objects inline, placed before text in user messages.
    """
    new_messages = []
    for msg in row["messages"]:
        new_content = []
        for part in msg["content"]:
            if part["type"] == "image":
                img_path = dataset_root / part["image"]
                img = Image.open(img_path).convert("RGB")
                new_content.append({"type": "image", "image": img})
            else:
                new_content.append({"type": "text", "text": part["text"]})
        new_messages.append({"role": msg["role"], "content": new_content})
    return {"messages": new_messages}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default="./dataset")
    ap.add_argument("--output", default="./unsloth-output")
    ap.add_argument("--model", default="unsloth/gemma-4-E4B-it")
    ap.add_argument("--epochs", type=int, default=5)
    ap.add_argument("--lr", type=float, default=1e-4)
    ap.add_argument("--r", type=int, default=32, help="LoRA rank")
    ap.add_argument("--lora-alpha", type=int, default=32)
    ap.add_argument("--batch-size", type=int, default=1)
    ap.add_argument("--grad-accum", type=int, default=4)
    ap.add_argument("--max-seq-length", type=int, default=8192)
    ap.add_argument("--wandb-project", default="knowable-gemma4-distill")
    ap.add_argument("--run-name", default="unsloth_r32_a32_lr1e-4_ep5")
    ap.add_argument("--load-in-4bit", action="store_true",
                    help="Use QLoRA (4-bit quantized base)")
    ap.add_argument("--finetune-vision", action="store_true",
                    help="Also fine-tune vision layers (default: text only)")
    args = ap.parse_args()

    dataset_root = Path(args.dataset)
    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    import wandb
    wandb.init(project=args.wandb_project, name=args.run_name)

    # --- Load model with Unsloth ---
    from unsloth import FastVisionModel, get_chat_template
    import torch

    print("[model] Loading %s via Unsloth..." % args.model)
    model, processor = FastVisionModel.from_pretrained(
        args.model,
        max_seq_length=args.max_seq_length,
        load_in_4bit=args.load_in_4bit,
        dtype=torch.bfloat16,
        use_gradient_checkpointing="unsloth",
    )

    processor = get_chat_template(processor, "gemma-4")

    print("[model] Applying LoRA...")
    model = FastVisionModel.get_peft_model(
        model,
        r=args.r,
        lora_alpha=args.lora_alpha,
        lora_dropout=0,
        bias="none",
        finetune_vision_layers=args.finetune_vision,
        finetune_language_layers=True,
        finetune_attention_modules=True,
        finetune_mlp_modules=True,
        use_rslora=False,
        random_state=3407,
    )
    model.print_trainable_parameters()

    # --- Load and prepare dataset ---
    print("[data] Loading dataset from %s" % dataset_root)
    raw_rows = load_dataset_rows(dataset_root)
    print("[data] %d rows loaded" % len(raw_rows))

    eval_count = min(15, len(raw_rows) // 10)
    train_rows = raw_rows[:-eval_count] if eval_count > 0 else raw_rows
    eval_rows = raw_rows[-eval_count:] if eval_count > 0 else []
    print("[data] Split: %d train, %d eval" % (len(train_rows), len(eval_rows)))

    # Unsloth expects a plain list of dicts, NOT an HF Dataset (PIL serialization issues)
    converted_train = [convert_row_to_unsloth(r, dataset_root) for r in train_rows]
    converted_eval = [convert_row_to_unsloth(r, dataset_root) for r in eval_rows] if eval_rows else None

    # --- Trainer ---
    from unsloth.trainer import UnslothVisionDataCollator
    from trl import SFTTrainer, SFTConfig

    sft_config = SFTConfig(
        output_dir=str(output_dir / "checkpoints"),
        per_device_train_batch_size=args.batch_size,
        gradient_accumulation_steps=args.grad_accum,
        num_train_epochs=args.epochs,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.1,
        weight_decay=0.01,
        max_grad_norm=0.3,
        logging_steps=1,
        save_strategy="epoch",
        eval_strategy="epoch" if converted_eval else "no",
        load_best_model_at_end=True if converted_eval else False,
        metric_for_best_model="eval_loss" if converted_eval else None,
        bf16=True,
        optim="adamw_8bit",
        seed=3407,
        max_seq_length=args.max_seq_length,
        report_to="wandb",
        run_name=args.run_name,
        remove_unused_columns=False,
        dataset_text_field="",
        dataset_kwargs={"skip_prepare_dataset": True},
    )

    trainer = SFTTrainer(
        model=model,
        args=sft_config,
        train_dataset=converted_train,
        eval_dataset=converted_eval,
        processing_class=processor.tokenizer,
        data_collator=UnslothVisionDataCollator(model, processor),
    )

    # --- Train ---
    print("[train] Starting training...")
    trainer.train()

    if converted_eval:
        metrics = trainer.evaluate()
        print("[eval] %s" % metrics)

    # --- Save ---
    final_dir = str(output_dir / "final")
    print("[save] Saving LoRA adapter to %s" % final_dir)
    model.save_pretrained(final_dir)
    processor.save_pretrained(final_dir)

    merged_dir = str(output_dir / "merged")
    print("[save] Saving merged model to %s" % merged_dir)
    model.save_pretrained_merged(
        merged_dir,
        processor,
        save_method="merged_16bit",
    )

    print("\n[done] Adapter: %s" % final_dir)
    print("[done] Merged:  %s" % merged_dir)
    print("[done] To load in Ollama:")
    print("  ollama create knowable-unsloth -f %s/Modelfile --quantize q4_K_M" % merged_dir)

    # Create Modelfile in merged dir
    with open(Path(merged_dir) / "Modelfile", "w") as f:
        f.write("FROM .\nPARAMETER temperature 0.4\nPARAMETER num_ctx 8192\n")

    wandb.finish()
    return 0


if __name__ == "__main__":
    sys.exit(main())
