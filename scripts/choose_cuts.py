#!/usr/bin/env python3
"""Automated AI talking-head jump-cut selector (Claude AI + offline fallback)."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_WORDS = ROOT / "transcript" / "words.json"
DEFAULT_CUTS = ROOT / "transcript" / "cuts.json"

FILLER_WORDS = {
    "um",
    "uh",
    "uhm",
    "umm",
    "er",
    "erm",
    "ah",
    "ahh",
    "hmm",
    "hm",
    "mhm",
}


def load_dotenv(env_path: Path) -> None:
    if not env_path.is_file():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, val = line.split("=", 1)
        key = key.strip()
        val = val.strip()
        if (val.startswith('"') and val.endswith('"')) or (
            val.startswith("'") and val.endswith("'")
        ):
            val = val[1:-1]
        if key and not os.environ.get(key):
            os.environ[key] = val


def probe_duration(media_path: Path | None) -> float | None:
    if not media_path or not media_path.is_file():
        return None
    try:
        proc = subprocess.run(
            [
                "ffprobe",
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "default=noprint_wrappers=1:nokey=1",
                str(media_path),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return float(proc.stdout.strip())
    except Exception:
        return None


def normalize_words(raw_words: list[dict]) -> list[dict]:
    cleaned: list[dict] = []
    last_t = 0.0
    for item in raw_words:
        text = str(item.get("word", "")).strip()
        if not text:
            continue
        start = item.get("start")
        end = item.get("end")
        if start is None and end is None:
            start = last_t
            end = last_t + 0.12
        elif start is None:
            end = float(end)
            start = max(last_t, end - 0.12)
        elif end is None:
            start = float(start)
            end = start + 0.12
        else:
            start = float(start)
            end = float(end)

        if start < 0:
            start = 0.0
        if end < start:
            end = start + 0.04
        cleaned.append({"word": text, "start": start, "end": end})
        last_t = max(last_t, end)
    return cleaned


def clean_token(word: str) -> str:
    return re.sub(r"^[^a-zA-Z0-9]+|[^a-zA-Z0-9]+$", "", word).lower()


def resolve_anthropic_workspace(api_key: str, explicit: str = "") -> str | None:
    if explicit.strip():
        return explicit.strip()
    if not api_key.startswith("sk-ant-usr-"):
        return None
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/organizations/workspaces",
        headers={
            "x-api-key": api_key,
            "anthropic-version": "2023-06-01",
        },
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=20) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    workspaces = data.get("data") or []
    active = next((w for w in workspaces if not w.get("archived_at")), None)
    if not active and workspaces:
        active = workspaces[0]
    return active.get("id") if isinstance(active, dict) else None


def extract_json_object(text: str) -> dict:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
    if fence:
        text = fence.group(1)
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError("No JSON object found in Claude response")
    return json.loads(text[start : end + 1])


def choose_spans_claude(
    words: list[dict],
    api_key: str,
    model: str,
    workspace_id: str = "",
) -> list[tuple[int, int]]:
    lines = [
        f"[{i}] {w['start']:.2f}-{w['end']:.2f} {w['word']}"
        for i, w in enumerate(words)
    ]
    transcript_block = "\n".join(lines)

    system_prompt = (
        "You are an expert talking-head video rough-cut editor. "
        "Given a word-level transcript with [index] start-end word, choose ONLY the word spans to KEEP "
        "so the video flows tightly and naturally.\n"
        "Rules:\n"
        "1. Cut dead air / long pauses (>= 0.45s silence between spoken phrases).\n"
        "2. Cut filler words (um, uh, uhm, er, ah, hmm, and purely hesitant Tagalog/Taglish fillers like standalone 'ano'/'eh' stumbles).\n"
        "3. Cut false starts, stumbles, restarts, and aborted sentences.\n"
        "4. When the speaker says a line or thought more than once (retakes), keep ONLY the best complete take (usually the last one) and never keep a trailing fragment.\n"
        "5. Keep the speaker's personality, natural phrasing, and energy intact. Do not over-cut normal conversational cadence.\n"
        "6. Output STRICT JSON ONLY matching: {\"keep\": [{\"start_idx\": int, \"end_idx\": int}]}\n"
        "   - Indices are inclusive, strictly increasing, non-overlapping, within 0.."
        + str(len(words) - 1)
        + ".\n"
        "   - Never invent indices or timestamps; only reference indices present in the transcript."
    )

    payload = {
        "model": model,
        "max_tokens": 4096,
        "temperature": 0,
        "system": system_prompt,
        "messages": [
            {
                "role": "user",
                "content": (
                    "Select the kept word index spans for this talking-head transcript. "
                    "Return JSON only.\n\n" + transcript_block
                ),
            }
        ],
    }

    headers = {
        "content-type": "application/json",
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
    }
    ws_id = resolve_anthropic_workspace(api_key, workspace_id)
    if ws_id:
        headers["anthropic-workspace-id"] = ws_id

    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages",
        data=json.dumps(payload).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=90) as resp:
        body = json.loads(resp.read().decode("utf-8"))

    content_blocks = body.get("content") or []
    text_out = "\n".join(
        b.get("text", "") for b in content_blocks if b.get("type") == "text"
    )
    parsed = extract_json_object(text_out)
    raw_keep = parsed.get("keep")
    if not isinstance(raw_keep, list) or not raw_keep:
        raise ValueError("Claude returned empty 'keep' spans")

    spans: list[tuple[int, int]] = []
    n = len(words)
    last_end = -1
    for item in raw_keep:
        s = int(item["start_idx"])
        e = int(item["end_idx"])
        if s < 0 or e >= n or e < s:
            continue
        if s <= last_end:
            s = last_end + 1
            if s > e:
                continue
        spans.append((s, e))
        last_end = e

    if not spans:
        raise ValueError("No valid spans parsed from Claude response")
    return spans


def choose_spans_offline(
    words: list[dict],
    silence_threshold: float = 0.55,
) -> list[tuple[int, int]]:
    """Deterministic fallback: strip fillers, split dead air, and drop obvious short false starts."""
    kept_indices = [
        i for i, w in enumerate(words) if clean_token(w["word"]) not in FILLER_WORDS
    ]
    if not kept_indices:
        return [(0, len(words) - 1)] if words else []

    raw_spans: list[tuple[int, int]] = []
    span_start = kept_indices[0]
    prev_idx = kept_indices[0]

    for idx in kept_indices[1:]:
        gap = words[idx]["start"] - words[prev_idx]["end"]
        is_contiguous = idx == prev_idx + 1
        if (not is_contiguous) or gap > silence_threshold:
            raw_spans.append((span_start, prev_idx))
            span_start = idx
        prev_idx = idx
    raw_spans.append((span_start, prev_idx))

    # Drop obvious short false starts where a 1-4 word fragment repeats the start of the next span
    filtered: list[tuple[int, int]] = []
    for i, (s, e) in enumerate(raw_spans):
        length = e - s + 1
        if i + 1 < len(raw_spans) and length <= 4:
            ns, ne = raw_spans[i + 1]
            next_len = ne - ns + 1
            gap = words[ns]["start"] - words[e]["end"]
            cur_tokens = [clean_token(words[k]["word"]) for k in range(s, e + 1)]
            next_tokens = [clean_token(words[k]["word"]) for k in range(ns, ne + 1)]
            prefix_match = min(len(cur_tokens), len(next_tokens), 2)
            if (
                prefix_match >= 1
                and cur_tokens[:prefix_match] == next_tokens[:prefix_match]
                and next_len >= length
                and gap >= 0.20
            ):
                continue
        filtered.append((s, e))

    return filtered or raw_spans


def merge_close_contiguous_spans(
    words: list[dict],
    spans: list[tuple[int, int]],
    merge_gap: float = 0.25,
) -> list[tuple[int, int]]:
    if not spans:
        return []
    merged: list[tuple[int, int]] = [spans[0]]
    for s, e in spans[1:]:
        ps, pe = merged[-1]
        if s == pe + 1 and (words[s]["start"] - words[pe]["end"]) < merge_gap:
            merged[-1] = (ps, e)
        else:
            merged.append((s, e))
    return merged


def build_padded_segments(
    words: list[dict],
    spans: list[tuple[int, int]],
    total_duration: float,
    pre_pad: float = 0.08,
    post_pad: float = 0.12,
) -> list[dict]:
    if not words or not spans:
        return []

    spans = merge_close_contiguous_spans(words, spans)
    n = len(words)
    items: list[dict] = []

    for s, e in spans:
        raw_start = words[s]["start"]
        raw_end = words[e]["end"]

        min_start = words[s - 1]["end"] + 0.005 if s > 0 else 0.0
        max_end = words[e + 1]["start"] - 0.005 if e + 1 < n else total_duration

        padded_start = max(0.0, min_start, raw_start - pre_pad)
        padded_start = min(padded_start, raw_start)

        padded_end = min(total_duration, max_end, raw_end + post_pad)
        padded_end = max(padded_end, raw_end)

        text = " ".join(words[k]["word"] for k in range(s, e + 1)).strip()
        items.append(
            {
                "start": padded_start,
                "end": padded_end,
                "raw_start": raw_start,
                "raw_end": raw_end,
                "text": text,
            }
        )

    # Split any gap where adjacent padded segments would overlap
    for i in range(1, len(items)):
        prev = items[i - 1]
        curr = items[i]
        if prev["end"] > curr["start"]:
            mid = (prev["raw_end"] + curr["raw_start"]) / 2.0
            mid = max(prev["raw_end"], min(curr["raw_start"], mid))
            prev["end"] = mid
            curr["start"] = mid

    segments: list[dict] = []
    prev_end_r = 0.0
    for it in items:
        s_r = round(max(prev_end_r, it["start"]), 3)
        e_r = round(min(total_duration, it["end"]), 3)
        if e_r <= s_r:
            continue
        segments.append({"start": s_r, "end": e_r, "text": it["text"]})
        prev_end_r = e_r

    return segments


def main() -> None:
    load_dotenv(ROOT / ".env")

    parser = argparse.ArgumentParser(description="Automatically select talking-head jump-cuts from words.json.")
    parser.add_argument("words_json", nargs="?", default=str(DEFAULT_WORDS), help="Path to WhisperX words.json.")
    parser.add_argument("--raw", default=None, help="Optional raw video path for exact duration clamping.")
    parser.add_argument("--out", default=str(DEFAULT_CUTS), help="Output cuts.json path.")
    parser.add_argument("--mode", choices=["auto", "claude", "offline"], default="auto")
    parser.add_argument("--pre-pad", type=float, default=0.08)
    parser.add_argument("--post-pad", type=float, default=0.12)
    parser.add_argument("--silence", type=float, default=0.55, help="Offline silence threshold in seconds.")
    args = parser.parse_args()

    words_path = Path(args.words_json).expanduser().resolve()
    if not words_path.is_file():
        sys.exit(f"ERROR: Transcript file not found: {words_path}")

    data = json.loads(words_path.read_text(encoding="utf-8"))
    words = normalize_words(data.get("words") or [])
    if not words:
        sys.exit(f"ERROR: No words found in {words_path}")

    raw_path = Path(args.raw).expanduser().resolve() if args.raw else None
    if not raw_path and isinstance(data.get("source"), dict) and data["source"].get("path"):
        candidate = Path(str(data["source"]["path"]))
        if candidate.is_file():
            raw_path = candidate

    probed_dur = probe_duration(raw_path)
    total_duration = max(probed_dur or 0.0, words[-1]["end"] + 0.15)

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    model = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-5-5").strip() or "claude-sonnet-5-5"
    workspace_id = os.environ.get("ANTHROPIC_WORKSPACE_ID", "").strip()

    source_used = "offline"
    warning: str | None = None

    if args.mode in ("auto", "claude") and api_key:
        try:
            spans = choose_spans_claude(words, api_key=api_key, model=model, workspace_id=workspace_id)
            source_used = "claude"
        except Exception as exc:
            if args.mode == "claude":
                warning = f"Claude API unavailable ({exc}); fell back to offline word-timestamp cut engine."
            else:
                warning = f"Claude API unavailable ({exc}); used offline word-timestamp cut engine."
            print(f"[warn] {warning}", file=sys.stderr)
            spans = choose_spans_offline(words, silence_threshold=args.silence)
    else:
        if args.mode == "claude" and not api_key:
            warning = "ANTHROPIC_API_KEY not configured; used offline word-timestamp cut engine."
            print(f"[warn] {warning}", file=sys.stderr)
        spans = choose_spans_offline(words, silence_threshold=args.silence)

    segments = build_padded_segments(
        words,
        spans,
        total_duration=total_duration,
        pre_pad=args.pre_pad,
        post_pad=args.post_pad,
    )
    if not segments:
        sys.exit("ERROR: Cut selection produced zero kept segments.")

    out_path = Path(args.out).expanduser().resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        json.dumps({"segments": segments}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    edited_dur = sum(s["end"] - s["start"] for s in segments)
    removed_sec = max(0.0, total_duration - edited_dur)
    summary = {
        "out": str(out_path),
        "source": source_used,
        "segments_count": len(segments),
        "original_duration_sec": round(total_duration, 3),
        "edited_duration_sec": round(edited_dur, 3),
        "removed_sec": round(removed_sec, 3),
        "warning": warning,
    }
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
