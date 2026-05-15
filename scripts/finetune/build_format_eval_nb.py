"""Generate `format_eval.ipynb` from inline cell definitions.

Run once:
    python build_format_eval_nb.py
Produces:
    format_eval.ipynb  (Jupyter notebook, evaluates 3 local Ollama models on
                       recent traces for JSON formatting compliance)
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).parent
OUT = HERE / "format_eval.ipynb"


def md(text: str) -> dict:
    return {
        "cell_type": "markdown",
        "metadata": {},
        "source": [line + "\n" for line in text.splitlines()],
    }


def code(text: str) -> dict:
    return {
        "cell_type": "code",
        "execution_count": None,
        "metadata": {},
        "outputs": [],
        "source": [line + "\n" for line in text.splitlines()],
    }


CELLS = [
    md("""# Format Evaluation — Local Models

Score three local Gemma 4 variants on reasoning traces captured by the Knowable macOS app **in the last hour**.

**Models compared**
- `gemma4:e4b` — baseline (unmodified Gemma 4 E4B)
- `gemma4:knowable-tuned-hf` — PEFT/TRL LoRA fine-tune (merged + quantized)
- `gemma4:knowable-tuned-unsloth` — Unsloth LoRA fine-tune (merged + quantized)

**Criteria (three only, per spec)**
1. Output parses as JSON
2. All five required keys present: `understanding`, `events`, `hint`, `hint_speech`, `state`
3. `events` is a valid array

The eval re-runs each captured trace's input through each model under the same conditions Sonnet saw (same system prompt, same multimodal user message). Each model runs to completion against all traces, then is evicted from VRAM via `keep_alive=0` before the next model loads — required because we have 24 GB of VRAM and each model is ~9.6 GB.

**Run cells top to bottom.** Expect ~10–15 min wall-clock for 40 traces × 3 models on a single-GPU machine."""),
    code("""from __future__ import annotations

import base64
import json
import os
import subprocess
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

import requests

# ---- Config ----
BUCKET = "knowable-finetune-traces"
AWS_PROFILE = os.environ.get("AWS_PROFILE", "knowable")
AWS_REGION = os.environ.get("AWS_REGION", "us-east-1")
OLLAMA_URL = "http://localhost:11434"

MODELS: list[str] = [
    "gemma4:e4b",
    "gemma4:knowable-tuned-hf",
    "gemma4:knowable-tuned-unsloth",
]

# Look-back window for "recent" traces (uses S3 LastModified).
LOOKBACK_HOURS = 1

# Per-trace inference timeout. Generous because the first request after a
# model swap triggers a cold load (~30–60 s on M-series), then steady ~3 s.
INFERENCE_TIMEOUT_S = 180

TRACES_DIR = Path("./format_eval_traces")
OUTPUTS_DIR = Path("./format_eval_outputs")
TRACES_DIR.mkdir(parents=True, exist_ok=True)
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

# JSON Schema mirrors the production Swift client at
# Knowable/Services/Reasoning/LocalReasoningBackend.swift so the eval
# runs under the SAME format constraint the app applies in production.
JSON_SCHEMA: dict[str, Any] = {
    "type": "object",
    "required": ["understanding", "events", "hint", "hint_speech", "state"],
    "additionalProperties": False,
    "properties": {
        "understanding": {"type": "string", "maxLength": 2000},
        "events": {
            "type": "array",
            "maxItems": 20,
            "items": {"type": "string"},
        },
        "hint": {"type": ["string", "null"], "maxLength": 500},
        "hint_speech": {"type": ["string", "null"], "maxLength": 500},
        "state": {
            "type": "string",
            "enum": ["active", "camera_lost", "positioning_camera"],
        },
    },
}

print(f"Models to evaluate: {MODELS}")
print(f"Lookback window:    {LOOKBACK_HOURS} h")"""),
    md("""## Sync traces from S3

Lists manifests in the bucket, filters to those whose S3 `LastModified` falls within the look-back window, downloads the manifest + frame images for each. Idempotent — re-running skips files already on disk.

The "now" anchor is the timestamp of the most recent manifest in the bucket, not the local wall clock. This lets the notebook re-run identically against a frozen dataset even after time has passed."""),
    code("""result = subprocess.run(
    ["aws", "s3", "ls", f"s3://{BUCKET}/traces/", "--recursive",
     "--profile", AWS_PROFILE, "--region", AWS_REGION],
    capture_output=True, text=True, check=True,
)
manifest_lines = [l for l in result.stdout.splitlines() if l.strip().endswith("manifest.json")]


def parse_ts(line: str) -> datetime:
    return datetime.strptime(" ".join(line.split()[:2]), "%Y-%m-%d %H:%M:%S")


entries = sorted([(parse_ts(l), l.split()[-1]) for l in manifest_lines], reverse=True)
if not entries:
    raise RuntimeError("No manifests in bucket — enable trace capture in the app first.")

newest = entries[0][0]
cutoff = newest - timedelta(hours=LOOKBACK_HOURS)
recent = [(ts, key) for ts, key in entries if ts >= cutoff]
print(f"Newest manifest:    {newest}")
print(f"Cutoff (lookback):  {cutoff}")
print(f"Traces in window:   {len(recent)}")


def fetch_trace(s3_key: str) -> Path:
    parts = s3_key.split("/")  # e.g. ["traces", "2026-05-15", "<uuid>", "manifest.json"]
    local_dir = TRACES_DIR / "/".join(parts[1:-1])
    local_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = local_dir / "manifest.json"
    if not manifest_path.exists():
        subprocess.run(
            ["aws", "s3", "cp", f"s3://{BUCKET}/{s3_key}", str(manifest_path),
             "--profile", AWS_PROFILE, "--region", AWS_REGION, "--quiet"],
            check=True,
        )
    manifest = json.loads(manifest_path.read_text())
    for frame_name in manifest["request"]["frame_files"]:
        frame_local = local_dir / frame_name
        if not frame_local.exists():
            frame_s3 = f"traces/{'/'.join(parts[1:-1])}/{frame_name}"
            subprocess.run(
                ["aws", "s3", "cp", f"s3://{BUCKET}/{frame_s3}", str(frame_local),
                 "--profile", AWS_PROFILE, "--region", AWS_REGION, "--quiet"],
                check=True,
            )
    return manifest_path


manifest_paths = [fetch_trace(k) for _, k in recent]
print(f"Fetched {len(manifest_paths)} manifests + their frames → {TRACES_DIR}/")"""),
    md("""## Helpers — inference, format check, VRAM eviction

These wrap the Ollama HTTP API and the three formatting criteria. All cells below this one call into these helpers."""),
    code("""def format_user_text(manifest: dict) -> str:
    \"\"\"Render request fields as the same text block the training pipeline uses.\"\"\"
    req = manifest["request"]
    flags = req["flags"]
    uq = flags.get("user_query")
    uq_line = f"user_query: {uq}" if uq else "user_query: (none)"
    return (
        f"FLAGS:\\n"
        f"  is_milo_speaking: {flags['is_milo_speaking']}\\n"
        f"  force_reply: {flags['force_reply']}\\n"
        f"  {uq_line}\\n"
        f"\\n"
        f"CURRENT_ANALYSIS:\\n{req['current_analysis'] or '(empty)'}\\n"
        f"\\n"
        f"EVENT_LOG:\\n{req['event_log'] or '(empty)'}\\n"
    )


def load_frames_b64(manifest_path: Path, manifest: dict) -> list[str]:
    frames = []
    for name in manifest["request"]["frame_files"]:
        path = manifest_path.parent / name
        frames.append(base64.b64encode(path.read_bytes()).decode())
    return frames


def run_inference(model: str, manifest_path: Path) -> dict:
    \"\"\"Single Ollama chat call. Returns {trace_id, raw_text}.\"\"\"
    manifest = json.loads(manifest_path.read_text())
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": manifest["system_prompt"]},
            {
                "role": "user",
                "content": format_user_text(manifest),
                "images": load_frames_b64(manifest_path, manifest),
            },
        ],
        "stream": False,
        "format": JSON_SCHEMA,
        "options": {"temperature": 0.4},
    }
    r = requests.post(f"{OLLAMA_URL}/api/chat", json=payload, timeout=INFERENCE_TIMEOUT_S)
    r.raise_for_status()
    return {
        "trace_id": manifest["trace_id"],
        "raw_text": r.json()["message"]["content"],
    }


def check_format(raw_text: str) -> dict:
    \"\"\"Three criteria, per the eval spec.\"\"\"
    try:
        obj = json.loads(raw_text)
    except json.JSONDecodeError as e:
        return {
            "valid_json": False,
            "all_keys_present": False,
            "events_is_array": False,
            "missing_keys": [],
            "json_error": str(e)[:160],
        }
    required = {"understanding", "events", "hint", "hint_speech", "state"}
    present = set(obj.keys())
    return {
        "valid_json": True,
        "all_keys_present": required.issubset(present),
        "events_is_array": isinstance(obj.get("events"), list),
        "missing_keys": sorted(required - present),
        "json_error": None,
    }


def unload(model: str) -> None:
    \"\"\"Evict the model from VRAM. Idempotent; swallows network errors.\"\"\"
    try:
        requests.post(
            f"{OLLAMA_URL}/api/generate",
            json={"model": model, "keep_alive": 0},
            timeout=10,
        )
    except requests.exceptions.RequestException:
        pass


def evaluate_model(model: str, manifest_paths: list[Path]) -> list[dict]:
    print(f"\\n=== {model} ===")
    safe_name = model.replace(':', '_').replace('/', '_')
    out_file = OUTPUTS_DIR / f"{safe_name}.jsonl"
    results = []
    t0 = time.time()
    for i, mp in enumerate(manifest_paths, 1):
        try:
            r = run_inference(model, mp)
            r.update(check_format(r["raw_text"]))
        except Exception as e:
            r = {
                "trace_id": mp.parent.name,
                "raw_text": "",
                "valid_json": False,
                "all_keys_present": False,
                "events_is_array": False,
                "missing_keys": [],
                "json_error": f"inference exception: {type(e).__name__}: {e}",
            }
        results.append(r)
        elapsed = time.time() - t0
        rate = i / max(elapsed, 1e-3)
        eta_s = (len(manifest_paths) - i) / max(rate, 1e-3)
        flag = "OK " if (r["valid_json"] and r["all_keys_present"] and r["events_is_array"]) else "FAIL"
        print(
            f"  [{i:2d}/{len(manifest_paths)}] {r['trace_id'][:8]}…  "
            f"{flag}  json={r['valid_json']} keys={r['all_keys_present']} events={r['events_is_array']}  "
            f"ETA {eta_s:.0f}s",
            flush=True,
        )
    with open(out_file, "w") as f:
        for r in results:
            f.write(json.dumps(r) + "\\n")
    print(f"Wrote {len(results)} results → {out_file}")
    return results"""),
    md("""## Run — `gemma4:e4b` (baseline)

Loads the base Gemma 4 E4B model and runs all traces. First call triggers a cold load (~30–60 s); subsequent calls run at steady state."""),
    code("""results_base = evaluate_model(MODELS[0], manifest_paths)
unload(MODELS[0])"""),
    md("## Run — `gemma4:knowable-tuned-hf` (PEFT LoRA)"),
    code("""results_peft = evaluate_model(MODELS[1], manifest_paths)
unload(MODELS[1])"""),
    md("## Run — `gemma4:knowable-tuned-unsloth` (Unsloth LoRA)"),
    code("""results_unsloth = evaluate_model(MODELS[2], manifest_paths)
unload(MODELS[2])"""),
    md("""## Summary table

Pass rate (%) on each criterion, across all traces, for each model. Higher is better; green = pass, red = fail."""),
    code("""import pandas as pd


def summarize(name: str, results: list[dict]) -> dict:
    n = len(results)
    return {
        "model": name,
        "n": n,
        "valid_json_pct": 100.0 * sum(r["valid_json"] for r in results) / max(n, 1),
        "all_keys_pct": 100.0 * sum(r["all_keys_present"] for r in results) / max(n, 1),
        "events_array_pct": 100.0 * sum(r["events_is_array"] for r in results) / max(n, 1),
        "all_three_pct": 100.0 * sum(
            r["valid_json"] and r["all_keys_present"] and r["events_is_array"]
            for r in results
        ) / max(n, 1),
    }


summary = pd.DataFrame([
    summarize(MODELS[0], results_base),
    summarize(MODELS[1], results_peft),
    summarize(MODELS[2], results_unsloth),
])

styled = summary.style.format({
    "valid_json_pct": "{:.1f}%",
    "all_keys_pct": "{:.1f}%",
    "events_array_pct": "{:.1f}%",
    "all_three_pct": "{:.1f}%",
}).background_gradient(
    subset=["valid_json_pct", "all_keys_pct", "events_array_pct", "all_three_pct"],
    cmap="RdYlGn", vmin=0, vmax=100,
)
styled"""),
    md("## Sample failures per model"),
    code("""def show_failures(name: str, results: list[dict], n: int = 3):
    failures = [
        r for r in results
        if not (r["valid_json"] and r["all_keys_present"] and r["events_is_array"])
    ]
    print(f"\\n{name}: {len(failures)} / {len(results)} formatting failures")
    for r in failures[:n]:
        print(f"\\n--- {r['trace_id'][:12]}… ---")
        print(
            f"  valid_json={r['valid_json']}  "
            f"all_keys={r['all_keys_present']}  "
            f"events_array={r['events_is_array']}"
        )
        if r.get("json_error"):
            print(f"  json_error: {r['json_error']}")
        if r.get("missing_keys"):
            print(f"  missing_keys: {r['missing_keys']}")
        raw = (r.get("raw_text") or "")[:400]
        print(f"  raw[:400]: {raw!r}")


show_failures(MODELS[0], results_base)
show_failures(MODELS[1], results_peft)
show_failures(MODELS[2], results_unsloth)"""),
]


notebook = {
    "cells": CELLS,
    "metadata": {
        "kernelspec": {
            "display_name": "Python 3",
            "language": "python",
            "name": "python3",
        },
        "language_info": {
            "name": "python",
            "version": "3.11",
        },
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}


OUT.write_text(json.dumps(notebook, indent=1))
print(f"Wrote {OUT} ({len(CELLS)} cells)")
