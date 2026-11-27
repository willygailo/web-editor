#!/usr/bin/env python3
"""Generate a timed Higgsfield AI B-roll cue sheet from transcript/cuts.json (Claude / Gemini / Offline)."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

import choose_cuts  # noqa: E402


def build_timeline_segments(segments: list[dict]) -> tuple[list[dict], float]:
    cursor = 0.0
    out: list[dict] = []
    for idx, seg in enumerate(segments):
        dur = max(0.0, float(seg["end"]) - float(seg["start"]))
        if dur <= 0.01:
            continue
        out.append(
            {
                "index": idx,
                "timeline_start": round(cursor, 3),
                "timeline_end": round(cursor + dur, 3),
                "duration": round(dur, 3),
                "text": str(seg.get("text", "")).strip(),
            }
        )
        cursor += dur
    return out, round(cursor, 3)


def plan_cues_offline(
    tl_segments: list[dict],
    total_dur: float,
    *,
    max_cues: int = 4,
    aspect_ratio: str = "9:16",
    style: str = "cutaway",
    model: str = "kling",
) -> list[dict]:
    """Deterministic fallback: pick visual moments safely outside opening 1.5s hook and closing 1.5s CTA."""
    safe_start = min(1.5, total_dur * 0.15)
    safe_end = max(safe_start + 1.0, total_dur - min(1.5, total_dur * 0.15))
    usable_span = safe_end - safe_start
    if usable_span < 1.2 or not tl_segments:
        return []

    target_count = max(1, min(max_cues, int(usable_span // 3.5) or 1))
    stride = usable_span / target_count
    orient_hint = "vertical 9:16 social framing" if aspect_ratio == "9:16" else ("square 1:1 framing" if aspect_ratio == "1:1" else "cinematic 16:9 framing")

    cues: list[dict] = []
    last_end = 0.0
    for i in range(target_count):
        t_start = round(max(safe_start + i * stride, last_end + 0.6), 2)
        dur = round(min(3.0, max(1.5, safe_end - t_start)), 2)
        if t_start + 1.2 > safe_end:
            break
        # Find spoken text active around t_start
        matched_text = ""
        for seg in tl_segments:
            if seg["timeline_start"] <= t_start + 0.5 and seg["timeline_end"] >= t_start:
                matched_text = seg["text"]
                break
        if not matched_text:
            matched_text = tl_segments[min(i, len(tl_segments) - 1)]["text"]
        clean_topic = re.sub(r"\s+", " ", matched_text).strip()[:96] or "modern creator studio workflow"
        cues.append(
            {
                "id": f"broll-{i + 1:02d}",
                "timeline_start_sec": t_start,
                "duration_sec": dur,
                "style": style,
                "kind": "video",
                "model": model,
                "prompt": f"Cinematic B-roll illustrating '{clean_topic}', crisp lighting, smooth slow dolly motion, shallow depth of field, {orient_hint}, no text",
                "reason": f"Visual cutaway supporting: {clean_topic[:54]}",
                "local_path": None,
            }
        )
        last_end = t_start + dur

    return cues


def _sanitize_llm_cues(
    raw_cues: list[dict],
    total_dur: float,
    *,
    max_cues: int,
    default_style: str,
    default_model: str,
) -> list[dict]:
    safe_start = min(1.5, total_dur * 0.12)
    safe_end = max(safe_start + 1.0, total_dur - min(1.5, total_dur * 0.12))
    cleaned: list[dict] = []
    last_end = 0.0

    for item in sorted(raw_cues, key=lambda x: float(x.get("timeline_start_sec", 0.0))):
        if len(cleaned) >= max_cues:
            break
        st = max(safe_start, last_end + 0.4, float(item.get("timeline_start_sec", 0.0)))
        dur = min(5.0, max(1.2, float(item.get("duration_sec", 2.5))))
        if st + 1.0 > safe_end:
            continue
        dur = min(dur, safe_end - st)
        prompt = str(item.get("prompt", "")).strip()
        if not prompt:
            continue
        style = str(item.get("style", default_style)).strip().lower()
        if style not in ("cutaway", "pip"):
            style = default_style
        kind = str(item.get("kind", "video")).strip().lower()
        if kind not in ("video", "image"):
            kind = "video"
        cleaned.append(
            {
                "id": f"broll-{len(cleaned) + 1:02d}",
                "timeline_start_sec": round(st, 2),
                "duration_sec": round(dur, 2),
                "style": style,
                "kind": kind,
                "model": str(item.get("model") or default_model).strip() or default_model,
                "prompt": prompt[:400],
                "reason": str(item.get("reason", "")).strip()[:140],
                "local_path": None,
            }
        )
        last_end = st + dur
    return cleaned


def plan_cues_claude(
    tl_segments: list[dict],
    total_dur: float,
    *,
    api_key: str,
    model_id: str,
    workspace_id: str,
    max_cues: int,
    aspect_ratio: str,
    style: str,
    broll_model: str,
) -> list[dict]:
    script_lines = "\n".join(
        f"[{s['timeline_start']:.2f}s-{s['timeline_end']:.2f}s] {s['text']}"
        for s in tl_segments
    )
    prompt = (
        f"You are a senior short-form video B-roll director using Higgsfield AI (video/image models).\n"
        f"Edited talking-head timeline duration: {total_dur:.2f}s, aspect ratio: {aspect_ratio}.\n"
        f"Pick up to {max_cues} non-overlapping B-roll cutaways that elevate visual retention.\n"
        "Rules:\n"
        "- NEVER cover the opening 1.5s hook or closing 1.5s CTA so the speaker's face anchors the edit.\n"
        "- Each B-roll prompt should be vivid, concrete, cinematic, specify camera movement & lighting, and include 'no text'.\n"
        "- Return STRICT JSON ONLY: {\"cues\": [{\"timeline_start_sec\": float, \"duration_sec\": float, \"style\": \"cutaway\"|\"pip\", \"kind\": \"video\"|\"image\", \"model\": str, \"prompt\": str, \"reason\": str}]}\n\n"
        + script_lines
    )
    headers = {
        "content-type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    ws_id = choose_cuts.resolve_anthropic_workspace(api_key, workspace_id)
    if ws_id:
        headers["anthropic-workspace-id"] = ws_id

    payload = {
        "model": model_id,
        "max_tokens": 2048,
        "temperature": 0.3,
        "messages": [{"role": "user", "content": prompt}],
    }
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    text_out = "\n".join(b.get("text", "") for b in (body.get("content") or []) if b.get("type") == "text")
    parsed = choose_cuts.extract_json_object(text_out)
    return _sanitize_llm_cues(
        parsed.get("cues") or [],
        total_dur,
        max_cues=max_cues,
        default_style=style,
        default_model=broll_model,
    )


def plan_cues_gemini(
    tl_segments: list[dict],
    total_dur: float,
    *,
    api_key: str,
    model_id: str,
    max_cues: int,
    aspect_ratio: str,
    style: str,
    broll_model: str,
) -> list[dict]:
    script_lines = "\n".join(
        f"[{s['timeline_start']:.2f}s-{s['timeline_end']:.2f}s] {s['text']}"
        for s in tl_segments
    )
    prompt = (
        f"You are a senior video B-roll director using Higgsfield AI.\n"
        f"Timeline duration: {total_dur:.2f}s, aspect ratio: {aspect_ratio}. Pick up to {max_cues} non-overlapping B-roll cutaways.\n"
        "Never cover the first 1.5s hook or last 1.5s CTA. Include concrete camera motion, lighting, and 'no text'.\n"
        "Return STRICT JSON ONLY: {\"cues\": [{\"timeline_start_sec\": float, \"duration_sec\": float, \"style\": \"cutaway\"|\"pip\", \"kind\": \"video\"|\"image\", \"model\": str, \"prompt\": str, \"reason\": str}]}\n\n"
        + script_lines
    )
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent?key={api_key}"
    payload = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3, "responseMimeType": "application/json"},
    }
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        body = json.loads(resp.read().decode("utf-8"))
    candidates = body.get("candidates") or []
    parts = ((candidates[0].get("content") or {}).get("parts") or []) if candidates else []
    text_out = "\n".join(str(p.get("text", "")) for p in parts)
    parsed = choose_cuts.extract_json_object(text_out)
    return _sanitize_llm_cues(
        parsed.get("cues") or [],
        total_dur,
        max_cues=max_cues,
        default_style=style,
        default_model=broll_model,
    )


def main() -> None:
    choose_cuts.load_dotenv(ROOT / ".env")

    parser = argparse.ArgumentParser(description="Plan timed Higgsfield AI B-roll cutaways from transcript/cuts.json.")
    parser.add_argument("cuts_json", nargs="?", default=str(ROOT / "transcript" / "cuts.json"))
    parser.add_argument("--out", default=str(ROOT / "transcript" / "broll_plan.json"))
    parser.add_argument("--mode", choices=["auto", "claude", "gemini", "offline"], default="auto")
    parser.add_argument("--aspect", choices=["9:16", "16:9", "1:1", "4:5"], default="9:16")
    parser.add_argument("--style", choices=["cutaway", "pip"], default="cutaway")
    parser.add_argument("--model", default="kling", help="Default Higgsfield model preset (e.g. kling, seedance, veo, dop, soul).")
    parser.add_argument("--max-cues", type=int, default=4)
    args = parser.parse_args()

    cuts_path = Path(args.cuts_json).expanduser().resolve()
    if not cuts_path.is_file():
        sys.exit(f"ERROR: cuts.json not found: {cuts_path}")

    segs = json.loads(cuts_path.read_text(encoding="utf-8")).get("segments") or []
    tl_segments, total_dur = build_timeline_segments(segs)
    if not tl_segments:
        sys.exit("ERROR: cuts.json has no valid segments.")

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    claude_model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5").strip() or "claude-sonnet-5-5"
    ws_id = os.environ.get("ANTHROPIC_WORKSPACE_ID", "").strip()
    gem_key = os.environ.get("GEMINI_API_KEY", "").strip()
    gem_model = os.environ.get("GEMINI_MODEL", "gemini-4-hydrogen").strip() or "gemini-4-hydrogen"

    cues: list[dict] | None = None
    engine = "offline"
    warning: str | None = None

    if args.mode in ("auto", "claude") and api_key:
        try:
            cues = plan_cues_claude(
                tl_segments, total_dur, api_key=api_key, model_id=claude_model,
                workspace_id=ws_id, max_cues=args.max_cues, aspect_ratio=args.aspect,
                style=args.style, broll_model=args.model,
            )
            if cues:
                engine = "claude"
        except Exception as exc:
            warning = f"Claude B-roll planner fallback ({exc})"

    if not cues and args.mode in ("auto", "gemini") and gem_key:
        try:
            cues = plan_cues_gemini(
                tl_segments, total_dur, api_key=gem_key, model_id=gem_model,
                max_cues=args.max_cues, aspect_ratio=args.aspect,
                style=args.style, broll_model=args.model,
            )
            if cues:
                engine = "gemini"
        except Exception as exc:
            warning = f"Gemini B-roll planner fallback ({exc})"

    if not cues:
        cues = plan_cues_offline(
            tl_segments, total_dur, max_cues=args.max_cues,
            aspect_ratio=args.aspect, style=args.style, model=args.model,
        )
        engine = "offline"

    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "source_cuts": str(cuts_path),
        "edited_duration_sec": total_dur,
        "aspect_ratio": args.aspect,
        "default_style": args.style,
        "engine": engine,
        "mcp_endpoint": "https://mcp.higgsfield.ai/mcp",
        "warning": warning,
        "cues": cues,
    }
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(out_path), "engine": engine, "cues_count": len(cues), "warning": warning}, indent=2))


if __name__ == "__main__":
    main()
