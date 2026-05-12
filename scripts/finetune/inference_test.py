#!/usr/bin/env python3
"""
Side-by-side comparison of base Gemma 4 E4B vs the LoRA-fine-tuned variant
on a held-out subset of your traces. Use this to sanity-check that distillation
actually moved the needle before bothering with GGUF conversion + Ollama
deployment.

Usage:
  python inference_test.py --dataset ./dataset --adapter ./adapter/final --n 5

Prints each example's reference (Sonnet) response, base response, and
adapted response — so you can eyeball whether the LoRA pulled the student
toward the teacher.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image


def load_row_with_pil(row: dict, dataset_root: Path) -> dict:
    new_messages = []
    for msg in row["messages"]:
        new_content = []
        for part in msg["content"]:
            if part["type"] == "image":
                new_content.append({"type": "image", "image": Image.open(dataset_root / part["image"]).convert("RGB")})
            else:
                new_content.append(part)
        new_messages.append({"role": msg["role"], "content": new_content})
    return {**row, "messages": new_messages}


def generate(model, processor, messages, max_new_tokens: int) -> str:
    """Strip the assistant turn from messages, prompt the model, return its text."""
    user_only = [m for m in messages if m["role"] != "assistant"]
    inputs = processor.apply_chat_template(
        user_only,
        add_generation_prompt=True,
        tokenize=True,
        return_tensors="pt",
        return_dict=True,
    )
    inputs = {k: v.to(model.device) for k, v in inputs.items() if hasattr(v, "to")}
    import torch  # type: ignore

    with torch.no_grad():
        out_ids = model.generate(
            **inputs,
            max_new_tokens=max_new_tokens,
            do_sample=False,
        )
    new_tokens = out_ids[0][inputs["input_ids"].shape[-1]:]
    return processor.decode(new_tokens, skip_special_tokens=True)


def reference_response(row: dict) -> str:
    for m in row["messages"]:
        if m["role"] == "assistant":
            for part in m["content"]:
                if part["type"] == "text":
                    return part["text"]
    return "(no reference assistant turn)"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default="./dataset")
    ap.add_argument("--adapter", default="./adapter/final")
    ap.add_argument("--model", default="google/gemma-4-E4B-it")
    ap.add_argument("--n", type=int, default=5, help="Number of rows to test.")
    ap.add_argument("--max-new-tokens", type=int, default=600)
    ap.add_argument("--skip-base", action="store_true", help="Don't load the unadapted base (saves time + VRAM).")
    args = ap.parse_args()

    dataset_root = Path(args.dataset)
    jsonl = dataset_root / "dataset.jsonl"

    rows = []
    with open(jsonl) as f:
        for line in f:
            rows.append(json.loads(line))
    # Take the LAST N as held-out (training shuffles, so this is a coarse split).
    rows = rows[-args.n:]
    print(f"[data] testing on {len(rows)} held-out rows")

    import torch  # type: ignore
    from transformers import AutoProcessor, AutoModelForImageTextToText  # type: ignore
    from peft import PeftModel  # type: ignore

    processor = AutoProcessor.from_pretrained(args.model, trust_remote_code=True)

    print(f"[model] loading adapted variant from {args.adapter}")
    base_for_adapter = AutoModelForImageTextToText.from_pretrained(
        args.model, torch_dtype=torch.bfloat16, device_map="auto", trust_remote_code=True
    )
    adapted = PeftModel.from_pretrained(base_for_adapter, args.adapter)
    adapted.eval()

    base_model = None
    if not args.skip_base:
        print(f"[model] loading base {args.model}")
        base_model = AutoModelForImageTextToText.from_pretrained(
            args.model, torch_dtype=torch.bfloat16, device_map="auto", trust_remote_code=True
        )
        base_model.eval()

    for i, row in enumerate(rows):
        loaded = load_row_with_pil(row, dataset_root)
        print(f"\n{'=' * 80}")
        print(f"Trace {row.get('trace_id', f'row-{i}')}")
        print("=" * 80)

        print("\n--- REFERENCE (Sonnet) ---")
        print(reference_response(loaded))

        if base_model is not None:
            print("\n--- BASE Gemma 4 E4B ---")
            print(generate(base_model, processor, loaded["messages"], args.max_new_tokens))

        print("\n--- ADAPTED Gemma 4 E4B ---")
        print(generate(adapted, processor, loaded["messages"], args.max_new_tokens))

    return 0


if __name__ == "__main__":
    sys.exit(main())
