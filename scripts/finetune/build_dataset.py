#!/usr/bin/env python3
"""
Build a Gemma 4 E4B fine-tune dataset from Sonnet-captured traces.

Pipeline:
  1. (optional) `aws s3 sync s3://knowable-finetune-traces ./raw`
  2. Walk `./raw/traces/**/manifest.json`
  3. For each manifest:
     - Load frames, strip alpha, crop to multiple of 48 px (Gemma vision req)
     - Strip any `<thinking>...</thinking>` blocks from response (defense-in-depth)
     - Reject if reserved-token collisions
     - Build HF-compatible messages row pointing at on-disk frames
  4. Write `./dataset/dataset.jsonl` + copy resized frames to `./dataset/frames/`

Run on the Lambda Labs box BEFORE training:
  python build_dataset.py --raw ./raw --out ./dataset

Optional flags:
  --sync         Run `aws s3 sync` first (requires AWS creds).
  --bucket NAME  Override bucket name (default: knowable-finetune-traces).
  --limit N      Stop after N accepted rows.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

from PIL import Image

# Gemma 4 reserved tokens — any literal match in the captured text will
# collide with the tokenizer's special vocab and corrupt training.
RESERVED_TOKEN_RE = re.compile(r"<\|[a-z_]+\|?>|<[a-z_]+\|>", re.IGNORECASE)

# Sonnet sometimes wraps reasoning in <thinking>...</thinking>. Currently the
# Lambda doesn't enable extended thinking, but stripping defensively means
# the pipeline stays correct if that changes.
THINKING_BLOCK_RE = re.compile(r"<thinking>.*?</thinking>", re.DOTALL | re.IGNORECASE)

# Per the Gemma 4 vision processor, images should have side lengths that
# are multiples of 48 (the patch size after the encoder downsamples).
IMAGE_PATCH_MULTIPLE = 48

# Safety ceiling — way above what 1-3 notebook frames need.
MAX_IMAGE_SIDE = 1920


def crop_to_multiple(img: Image.Image, multiple: int = IMAGE_PATCH_MULTIPLE) -> Image.Image:
    """Crop to the nearest smaller multiple-of-N dimensions, RGB, no alpha."""
    if img.mode != "RGB":
        img = img.convert("RGB")
    w, h = img.size
    # Cap maximum side first to keep file sizes sane.
    if max(w, h) > MAX_IMAGE_SIDE:
        scale = MAX_IMAGE_SIDE / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)
        w, h = img.size
    new_w = (w // multiple) * multiple
    new_h = (h // multiple) * multiple
    if new_w == w and new_h == h:
        return img
    # Center-crop to the cleaner dimensions.
    left = (w - new_w) // 2
    top = (h - new_h) // 2
    return img.crop((left, top, left + new_w, top + new_h))


def format_user_text(manifest: dict[str, Any]) -> str:
    """Render request fields as a single text block for the user turn.

    The system prompt already describes the input schema, so this just lays
    out the fields in the order the prompt describes them.
    """
    req = manifest["request"]
    flags = req["flags"]
    user_query = flags.get("user_query")
    user_query_line = f"user_query: {user_query}" if user_query else "user_query: (none)"
    return (
        f"FLAGS:\n"
        f"  is_milo_speaking: {flags['is_milo_speaking']}\n"
        f"  force_reply: {flags['force_reply']}\n"
        f"  {user_query_line}\n"
        f"\n"
        f"CURRENT_ANALYSIS:\n{req['current_analysis'] or '(empty)'}\n"
        f"\n"
        f"EVENT_LOG:\n{req['event_log'] or '(empty)'}\n"
    )


def clean_response_text(raw: str) -> str:
    """Strip Sonnet thinking blocks. Other normalization stays minimal —
    the section structure (UNDERSTANDING/EVENTS/HINT/HINT_SPEECH/STATE) is
    exactly what we want the student model to learn to reproduce."""
    return THINKING_BLOCK_RE.sub("", raw).strip()


def has_reserved_token_collision(*texts: str) -> str | None:
    """Return the first match found, or None if all texts are safe."""
    for t in texts:
        m = RESERVED_TOKEN_RE.search(t)
        if m:
            return m.group(0)
    return None


def process_trace(
    manifest_path: Path,
    out_root: Path,
) -> dict[str, Any] | None:
    """Convert one trace into a single dataset row, or return None on reject.

    Side effect: writes resized frames into `out_root / "frames" / trace_id /`.
    """
    with open(manifest_path) as f:
        manifest = json.load(f)

    trace_id = manifest["trace_id"]
    src_dir = manifest_path.parent
    dst_dir = out_root / "frames" / trace_id
    dst_dir.mkdir(parents=True, exist_ok=True)

    # 1. Resize frames + write to output tree.
    rel_paths: list[str] = []
    for fname in manifest["request"]["frame_files"]:
        src = src_dir / fname
        if not src.exists():
            print(f"[skip {trace_id}] missing frame {fname}")
            return None
        img = Image.open(src)
        cropped = crop_to_multiple(img)
        if min(cropped.size) < 96:
            print(f"[skip {trace_id}] frame {fname} too small after crop: {cropped.size}")
            return None
        dst = dst_dir / fname
        cropped.save(dst, "JPEG", quality=92)
        rel_paths.append(str(dst.relative_to(out_root)))

    if not rel_paths:
        print(f"[skip {trace_id}] no usable frames")
        return None

    # 2. Build user text + clean response.
    user_text = format_user_text(manifest)
    raw_response = manifest["response"]["raw_text"]
    cleaned_response = clean_response_text(raw_response)

    if not cleaned_response.strip():
        print(f"[skip {trace_id}] response empty after cleanup")
        return None

    # 3. Reserved-token collision check.
    system_prompt = manifest["system_prompt"]
    collision = has_reserved_token_collision(system_prompt, user_text, cleaned_response)
    if collision:
        print(f"[skip {trace_id}] reserved-token collision: {collision!r}")
        return None

    # 4. Build HF-compatible messages row.
    user_content: list[dict[str, Any]] = [
        {"type": "image", "image": p} for p in rel_paths
    ]
    user_content.append({"type": "text", "text": user_text})

    return {
        "trace_id": trace_id,
        "system_prompt_sha256": manifest["system_prompt_sha256"],
        "messages": [
            {
                "role": "system",
                "content": [{"type": "text", "text": system_prompt}],
            },
            {"role": "user", "content": user_content},
            {
                "role": "assistant",
                "content": [{"type": "text", "text": cleaned_response}],
            },
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--raw", default="./raw", help="Local dir for S3-synced traces.")
    ap.add_argument("--out", default="./dataset", help="Output dir for the assembled dataset.")
    ap.add_argument("--bucket", default="knowable-finetune-traces", help="S3 bucket to sync from.")
    ap.add_argument("--sync", action="store_true", help="Run `aws s3 sync` before processing.")
    ap.add_argument("--limit", type=int, default=0, help="Stop after N accepted rows (0 = no limit).")
    args = ap.parse_args()

    raw = Path(args.raw)
    out = Path(args.out)
    raw.mkdir(parents=True, exist_ok=True)
    out.mkdir(parents=True, exist_ok=True)

    if args.sync:
        print(f"[sync] aws s3 sync s3://{args.bucket} {raw}")
        subprocess.run(
            ["aws", "s3", "sync", f"s3://{args.bucket}", str(raw)],
            check=True,
        )

    manifests = sorted(raw.rglob("manifest.json"))
    if not manifests:
        print(f"No manifest.json under {raw}/. Run with --sync first?")
        return 1
    print(f"Found {len(manifests)} traces under {raw}/")

    # Wipe + recreate dataset dir for idempotency.
    if (out / "frames").exists():
        shutil.rmtree(out / "frames")

    rows: list[dict[str, Any]] = []
    distinct_prompts: set[str] = set()
    for m in manifests:
        row = process_trace(m, out)
        if row is None:
            continue
        rows.append(row)
        distinct_prompts.add(row["system_prompt_sha256"])
        if args.limit and len(rows) >= args.limit:
            break

    out_jsonl = out / "dataset.jsonl"
    with open(out_jsonl, "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")

    print(f"\n[done] wrote {len(rows)} rows to {out_jsonl}")
    if len(distinct_prompts) > 1:
        print(
            f"[warn] {len(distinct_prompts)} distinct system prompts across the dataset — "
            f"the LoRA will learn prompt-conditioning noise. "
            f"Consider keeping only rows whose system_prompt_sha256 matches the most recent."
        )
    else:
        print(f"[ok] all rows share one system prompt ({next(iter(distinct_prompts))[:12]}…)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
