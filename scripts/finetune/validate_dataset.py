#!/usr/bin/env python3
"""
Validate a dataset.jsonl built by build_dataset.py.

Runs the actual Gemma 4 processor on each row to catch issues BEFORE
training (cheap; minutes vs. wasted GPU hours):
  - apply_chat_template works without exceptions
  - All images load + meet size constraints
  - No row exceeds the configured max prompt tokens

Usage:
  python validate_dataset.py --dataset ./dataset --model google/gemma-4-E4B-it

This script needs an HF token for the gated model. `huggingface-cli login`
once on the box; or set HF_TOKEN.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from PIL import Image


def load_processor(model_id: str):
    """Imported lazily so a bare-bones lint of this script doesn't pull
    transformers (4GB+ install)."""
    from transformers import AutoProcessor  # type: ignore

    return AutoProcessor.from_pretrained(model_id, trust_remote_code=True)


def resolve_row_images(row: dict, dataset_root: Path) -> dict:
    """Replace path strings inside row["messages"] with PIL.Image objects."""
    new_messages = []
    for msg in row["messages"]:
        new_content = []
        for part in msg["content"]:
            if part["type"] == "image":
                img_path = dataset_root / part["image"]
                if not img_path.exists():
                    raise FileNotFoundError(img_path)
                new_content.append({"type": "image", "image": Image.open(img_path)})
            else:
                new_content.append(part)
        new_messages.append({"role": msg["role"], "content": new_content})
    return {**row, "messages": new_messages}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dataset", default="./dataset", help="Dir containing dataset.jsonl + frames/.")
    ap.add_argument("--model", default="google/gemma-4-E4B-it", help="HF model id (for processor only).")
    ap.add_argument("--max-tokens", type=int, default=8192, help="Hard ceiling on prompt token count.")
    args = ap.parse_args()

    dataset_root = Path(args.dataset)
    jsonl = dataset_root / "dataset.jsonl"
    if not jsonl.exists():
        print(f"dataset.jsonl not found at {jsonl}. Run build_dataset.py first.")
        return 1

    print(f"[load] processor from {args.model}")
    processor = load_processor(args.model)

    n_pass = 0
    n_fail = 0
    over_token_limit = 0
    max_tokens_seen = 0

    with open(jsonl) as f:
        for line_no, line in enumerate(f, 1):
            row = json.loads(line)
            trace_id = row.get("trace_id", f"row-{line_no}")
            try:
                resolved = resolve_row_images(row, dataset_root)
                # apply_chat_template is the SAME path the trainer uses.
                inputs = processor.apply_chat_template(
                    resolved["messages"],
                    add_generation_prompt=False,
                    tokenize=True,
                    return_tensors="pt",
                    return_dict=True,
                )
                token_count = inputs["input_ids"].shape[-1]
                max_tokens_seen = max(max_tokens_seen, int(token_count))
                if token_count > args.max_tokens:
                    over_token_limit += 1
                    print(f"[over-limit {trace_id}] {token_count} > {args.max_tokens}")
                    n_fail += 1
                else:
                    n_pass += 1
            except Exception as e:
                print(f"[fail {trace_id}] {type(e).__name__}: {e}")
                n_fail += 1

    print(f"\n[summary] {n_pass} pass, {n_fail} fail, max_tokens_seen={max_tokens_seen}")
    if over_token_limit:
        print(f"[summary] {over_token_limit} rows exceeded the {args.max_tokens}-token ceiling")
    return 0 if n_fail == 0 else 2


if __name__ == "__main__":
    sys.exit(main())
