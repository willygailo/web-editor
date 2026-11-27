#!/usr/bin/env python3
"""Programmatic Higgsfield Cloud API client (https://platform.higgsfield.ai) for AI video/image B-roll generation."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

import choose_cuts  # noqa: E402

HIGGSFIELD_API_BASE = "https://platform.higgsfield.ai"

# Friendly model presets mapped to platform.higgsfield.ai model paths
VIDEO_MODEL_PATHS: dict[str, str] = {
    "kling": "kling-video/v2.1/master/text-to-video",
    "kling-i2v": "kling-video/v2.1/master/image-to-video",
    "seedance": "bytedance/seedance/v1/pro/text-to-video",
    "seedance-i2v": "bytedance/seedance/v1/pro/image-to-video",
    "veo": "google/veo3/text-to-video",
    "minimax": "minimax/hailuo/text-to-video",
    "dop": "higgsfield-ai/dop/standard",
}

IMAGE_MODEL_PATHS: dict[str, str] = {
    "soul": "higgsfield-ai/soul/standard",
    "seedream": "bytedance/seedream/v3/text-to-image",
    "nano-banana": "google/nano-banana/text-to-image",
}


def resolve_credentials(explicit_key: str | None = None) -> str:
    choose_cuts.load_dotenv(ROOT / ".env")
    if explicit_key and ":" in explicit_key.strip():
        return explicit_key.strip()
    hf_key = os.environ.get("HF_KEY", "").strip()
    if ":" in hf_key:
        return hf_key
    kid = os.environ.get("HF_API_KEY_ID", "").strip()
    ksec = os.environ.get("HF_API_KEY_SECRET", "").strip()
    if kid and ksec:
        return f"{kid}:{ksec}"
    raise RuntimeError(
        "Higgsfield API credentials not found. Set HF_KEY='key_id:key_secret' (or HF_API_KEY_ID + HF_API_KEY_SECRET) "
        "in .env, or use the OAuth remote MCP connector (`pnpm connect-higgsfield` -> https://mcp.higgsfield.ai/mcp)."
    )


def resolve_model_path(model: str, kind: str, has_image: bool) -> str:
    cleaned = model.strip()
    if "/" in cleaned:
        return cleaned.lstrip("/")
    key = cleaned.lower()
    if kind == "image":
        return IMAGE_MODEL_PATHS.get(key, IMAGE_MODEL_PATHS["soul"])
    if has_image and f"{key}-i2v" in VIDEO_MODEL_PATHS:
        return VIDEO_MODEL_PATHS[f"{key}-i2v"]
    return VIDEO_MODEL_PATHS.get(key, VIDEO_MODEL_PATHS["kling"])


def build_generation_request(
    *,
    prompt: str,
    kind: str = "video",
    model: str = "kling",
    aspect_ratio: str = "9:16",
    duration: int = 5,
    image_url: str | None = None,
    api_base: str = HIGGSFIELD_API_BASE,
) -> tuple[str, dict]:
    model_path = resolve_model_path(model, kind, has_image=bool(image_url))
    url = f"{api_base.rstrip('/')}/{model_path}"
    payload: dict[str, object] = {
        "prompt": prompt.strip(),
        "aspect_ratio": aspect_ratio,
    }
    if kind == "video":
        payload["duration"] = max(2, min(10, int(duration)))
        if image_url:
            payload["image_url"] = image_url.strip()
    return url, payload


def _http_json(
    url: str,
    *,
    method: str = "GET",
    headers: dict[str, str],
    payload: dict | None = None,
    timeout: int = 60,
) -> dict:
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def extract_output_url(status_body: dict) -> str | None:
    for path_keys in (
        ("video", "url"),
        ("image", "url"),
        ("output", "url"),
    ):
        cur: object = status_body
        for k in path_keys:
            cur = cur.get(k) if isinstance(cur, dict) else None
        if isinstance(cur, str) and cur.startswith(("http://", "https://")):
            return cur
    for list_key in ("videos", "images", "outputs"):
        arr = status_body.get(list_key)
        if isinstance(arr, list) and arr:
            first = arr[0]
            if isinstance(first, str) and first.startswith(("http://", "https://")):
                return first
            if isinstance(first, dict) and isinstance(first.get("url"), str):
                return first["url"]
    if isinstance(status_body.get("url"), str) and status_body["url"].startswith(("http://", "https://")):
        return status_body["url"]
    return None


def submit_and_poll(
    *,
    url: str,
    payload: dict,
    credentials: str,
    api_base: str = HIGGSFIELD_API_BASE,
    poll_interval_sec: float = 3.0,
    timeout_sec: float = 300.0,
    http_fn=_http_json,
) -> dict:
    headers = {
        "Authorization": f"Key {credentials}",
        "Content-Type": "application/json",
        "Accept": "application/json",
    }
    submitted = http_fn(url, method="POST", headers=headers, payload=payload, timeout=60)
    request_id = str(submitted.get("request_id") or submitted.get("id") or "").strip()
    status_url = str(submitted.get("status_url") or "").strip()
    if not status_url and request_id:
        status_url = f"{api_base.rstrip('/')}/requests/{request_id}/status"

    # Some synchronous/fast endpoints return output immediately
    immediate_url = extract_output_url(submitted)
    if immediate_url:
        return {"request_id": request_id or "sync", "status": "completed", "output_url": immediate_url, "raw": submitted}

    if not status_url:
        raise RuntimeError(f"Higgsfield API did not return a request_id or status_url: {submitted}")

    deadline = time.monotonic() + timeout_sec
    sleep_s = max(0.2, poll_interval_sec)
    while time.monotonic() < deadline:
        polled = http_fn(status_url, method="GET", headers=headers, payload=None, timeout=30)
        state = str(polled.get("status") or "").strip().lower()
        if state in ("completed", "succeeded", "done"):
            out_url = extract_output_url(polled)
            if not out_url and request_id:
                # Fallback fetch on /v1/requests/{id}
                detail = http_fn(f"{api_base.rstrip('/')}/v1/requests/{request_id}", method="GET", headers=headers, payload=None, timeout=30)
                out_url = extract_output_url(detail)
            if not out_url:
                raise RuntimeError(f"Higgsfield job {request_id} completed without an output URL: {polled}")
            return {"request_id": request_id, "status": "completed", "output_url": out_url, "raw": polled}
        if state in ("failed", "error", "canceled", "cancelled", "nsfw"):
            err_msg = polled.get("error") or polled.get("detail") or state
            raise RuntimeError(f"Higgsfield job {request_id} failed: {err_msg}")
        time.sleep(sleep_s)
        sleep_s = min(8.0, sleep_s * 1.15)

    raise TimeoutError(f"Higgsfield job {request_id} timed out after {timeout_sec:.0f}s.")


def download_asset(output_url: str, dest_path: Path) -> Path:
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(output_url, headers={"User-Agent": "CutFlow-AI/1.0"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        dest_path.write_bytes(resp.read())
    return dest_path


def sanitize_filename(text: str) -> str:
    return re.sub(r"[^a-zA-Z0-9._-]+", "_", text.strip()).strip("._-")[:64] or "higgsfield_clip"


def generate_single(
    *,
    prompt: str,
    out_path: Path,
    kind: str = "video",
    model: str = "kling",
    aspect_ratio: str = "9:16",
    duration: int = 5,
    image_url: str | None = None,
    explicit_key: str | None = None,
    dry_run: bool = False,
) -> dict:
    url, payload = build_generation_request(
        prompt=prompt,
        kind=kind,
        model=model,
        aspect_ratio=aspect_ratio,
        duration=duration,
        image_url=image_url,
    )
    if dry_run:
        return {
            "dry_run": True,
            "endpoint": url,
            "payload": payload,
            "out": str(out_path),
        }

    creds = resolve_credentials(explicit_key)
    res = submit_and_poll(url=url, payload=payload, credentials=creds)
    download_asset(res["output_url"], out_path)

    # Probe file lightly with ffprobe to confirm valid media
    probe_ok = False
    try:
        subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(out_path)],
            check=True,
            capture_output=True,
        )
        probe_ok = True
    except Exception:
        probe_ok = False

    return {
        "request_id": res["request_id"],
        "model": model,
        "endpoint": url,
        "kind": kind,
        "output_url": res["output_url"],
        "local_path": str(out_path),
        "probe_ok": probe_ok,
    }


def run_batch_plan(
    plan_path: Path,
    *,
    out_dir: Path,
    explicit_key: str | None = None,
    dry_run: bool = False,
) -> dict:
    plan_data = json.loads(plan_path.read_text(encoding="utf-8"))
    cues = plan_data.get("cues") or []
    aspect = str(plan_data.get("aspect_ratio") or "9:16")
    results: list[dict] = []

    for cue in cues:
        existing = cue.get("local_path")
        if existing and Path(existing).is_file():
            results.append({"id": cue.get("id"), "skipped": True, "local_path": existing})
            continue
        kind = str(cue.get("kind") or "video")
        ext = ".png" if kind == "image" else ".mp4"
        dest = (out_dir / f"{sanitize_filename(str(cue.get('id') or 'broll'))}{ext}").resolve()
        res = generate_single(
            prompt=str(cue["prompt"]),
            out_path=dest,
            kind=kind,
            model=str(cue.get("model") or "kling"),
            aspect_ratio=aspect,
            duration=max(3, min(10, int(round(float(cue.get("duration_sec") or 5))))),
            explicit_key=explicit_key,
            dry_run=dry_run,
        )
        if not dry_run:
            cue["local_path"] = str(dest)
            cue["request_id"] = res["request_id"]
        results.append({"id": cue.get("id"), **res})

    if not dry_run:
        plan_path.write_text(json.dumps(plan_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    return {"plan": str(plan_path), "generated": len(results), "results": results}


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate AI video/image B-roll via Higgsfield Cloud API.")
    parser.add_argument("--prompt", default=None, help="Single generation prompt.")
    parser.add_argument("--plan", default=None, help="Batch B-roll cue sheet JSON from scripts/plan_broll.py.")
    parser.add_argument("--kind", choices=["video", "image"], default="video")
    parser.add_argument("--model", default="kling", help="Preset (kling, seedance, veo, minimax, dop, soul, seedream) or full model path.")
    parser.add_argument("--aspect", choices=["9:16", "16:9", "1:1", "4:5"], default="9:16")
    parser.add_argument("--duration", type=int, default=5, help="Video duration in seconds (default: 5).")
    parser.add_argument("--image-url", default=None, help="Optional start image URL for image-to-video.")
    parser.add_argument("--out", default=None, help="Output file path for single generation.")
    parser.add_argument("--out-dir", default=str(ROOT / "raw" / "broll"), help="Output folder for batch --plan.")
    parser.add_argument("--api-key", default=None, help="Optional explicit 'key_id:key_secret' override.")
    parser.add_argument("--dry-run", action="store_true", help="Build request payload without calling the API.")
    args = parser.parse_args()

    try:
        if args.plan:
            res = run_batch_plan(
                Path(args.plan).expanduser().resolve(),
                out_dir=Path(args.out_dir).expanduser().resolve(),
                explicit_key=args.api_key,
                dry_run=args.dry_run,
            )
            print(json.dumps(res, indent=2))
            return

        if not args.prompt:
            sys.exit("ERROR: Provide either --prompt '...' or --plan transcript/broll_plan.json")

        ext = ".png" if args.kind == "image" else ".mp4"
        default_out = Path(args.out_dir).expanduser().resolve() / f"{sanitize_filename(args.prompt[:32])}_{int(time.time())}{ext}"
        out_path = Path(args.out).expanduser().resolve() if args.out else default_out
        res = generate_single(
            prompt=args.prompt,
            out_path=out_path,
            kind=args.kind,
            model=args.model,
            aspect_ratio=args.aspect,
            duration=args.duration,
            image_url=args.image_url,
            explicit_key=args.api_key,
            dry_run=args.dry_run,
        )
        print(json.dumps(res, indent=2))
    except Exception as exc:
        sys.exit(f"ERROR: {exc}")


if __name__ == "__main__":
    main()
