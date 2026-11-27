#!/usr/bin/env python3
"""Remap WhisperX word timestamps through cuts.json onto edited timeline -> SRT, Karaoke ASS, and CutFlow overlays."""

from __future__ import annotations

import argparse
import json
import os
import sys
from fractions import Fraction
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

import build_cut  # noqa: E402


def fmt_srt_time(sec: float) -> str:
    safe = max(0.0, sec)
    ms_total = int(round(safe * 1000.0))
    hours = ms_total // 3_600_000
    mins = (ms_total % 3_600_000) // 60_000
    secs = (ms_total % 60_000) // 1000
    ms = ms_total % 1000
    return f"{hours:02d}:{mins:02d}:{secs:02d},{ms:03d}"


def fmt_ass_time(sec: float) -> str:
    safe = max(0.0, sec)
    cs_total = int(round(safe * 100.0))
    hours = cs_total // 360_000
    mins = (cs_total % 360_000) // 6_000
    secs = (cs_total % 6_000) // 100
    cs = cs_total % 100
    return f"{hours}:{mins:02d}:{secs:02d}.{cs:02d}"


def escape_ass(text: str) -> str:
    return (
        text.replace("\\", "\\\\")
        .replace("{", "\\{")
        .replace("}", "\\}")
        .replace("\r\n", "\\N")
        .replace("\n", "\\N")
    )


def remap_words_to_edited_timeline(
    words: list[dict],
    snapped_segments: list[dict],
) -> list[dict]:
    """Map raw words falling inside kept frame-snapped segments onto the edited timeline clock."""
    timeline_words: list[dict] = []
    cursor_sec = 0.0

    for seg in snapped_segments:
        s_start = float(seg["start_sec"])
        s_end = float(seg["end_sec"])
        seg_dur = float(seg["duration_sec"])

        for w in words:
            text = str(w.get("word", "")).strip()
            if not text:
                continue
            ws = w.get("start")
            we = w.get("end")
            if ws is None or we is None:
                continue
            ws_f = float(ws)
            we_f = float(we)
            mid = (ws_f + we_f) / 2.0
            if s_start - 0.02 <= mid <= s_end + 0.02:
                rel_s = max(0.0, ws_f - s_start)
                rel_e = min(seg_dur, max(rel_s + 0.05, we_f - s_start))
                timeline_words.append(
                    {
                        "word": text,
                        "start": round(cursor_sec + rel_s, 3),
                        "end": round(cursor_sec + rel_e, 3),
                    }
                )
        cursor_sec += seg_dur

    # Fallback if words.json had missing timestamps: synthesize proportional timing from segment text
    if not timeline_words:
        cursor_sec = 0.0
        for seg in snapped_segments:
            seg_dur = float(seg["duration_sec"])
            tokens = [t for t in str(seg.get("text", "")).strip().split() if t]
            if tokens:
                step = seg_dur / len(tokens)
                for idx, tok in enumerate(tokens):
                    timeline_words.append(
                        {
                            "word": tok,
                            "start": round(cursor_sec + idx * step, 3),
                            "end": round(cursor_sec + (idx + 1) * step, 3),
                        }
                    )
            cursor_sec += seg_dur

    return timeline_words


def chunk_words(
    timeline_words: list[dict],
    *,
    max_words: int = 4,
    max_chars: int = 26,
    max_gap_sec: float = 0.42,
) -> list[dict]:
    """Group timed words into punchy short-form caption phrases."""
    chunks: list[dict] = []
    current: list[dict] = []

    def _flush() -> None:
        if not current:
            return
        chunks.append(
            {
                "start": current[0]["start"],
                "end": max(current[-1]["end"], current[0]["start"] + 0.12),
                "text": " ".join(w["word"] for w in current),
                "words": list(current),
            }
        )
        current.clear()

    for w in timeline_words:
        if current:
            gap = w["start"] - current[-1]["end"]
            projected_len = sum(len(x["word"]) + 1 for x in current) + len(w["word"])
            ends_sentence = current[-1]["word"][-1:] in ".!?"
            if (
                len(current) >= max_words
                or projected_len > max_chars
                or gap > max_gap_sec
                or ends_sentence
            ):
                _flush()
        current.append(w)

    _flush()
    return chunks


def render_srt(chunks: list[dict]) -> str:
    blocks: list[str] = []
    for idx, ch in enumerate(chunks, 1):
        blocks.append(f"{idx}\n{fmt_srt_time(ch['start'])} --> {fmt_srt_time(ch['end'])}\n{ch['text']}\n")
    return "\n".join(blocks)


def render_ass(
    chunks: list[dict],
    *,
    width: int = 1080,
    height: int = 1920,
    style: str = "karaoke",
) -> str:
    is_vertical = height > width
    scale = width / 1080.0
    font_size = int(round((64 if is_vertical else 52) * scale))
    # Clamp inside TikTok/Reels/Shorts safe zone (above bottom UI bar)
    margin_v = int(round(height * (0.20 if is_vertical else 0.08)))
    margin_h = int(round(width * 0.08))

    if style == "karaoke":
        # Bold white text with deep dark outline; active word highlighted in vibrant yellow (&H003CE6FF in BGR)
        style_line = (
            f"Style: Default,DejaVu Sans,{font_size},&H00FFFFFF,&H003CE6FF,&H00120A1E,&H96000000,"
            f"-1,0,0,0,100,100,1,0,1,4,2,2,{margin_h},{margin_h},{margin_v},1"
        )
    else:
        style_line = (
            f"Style: Default,DejaVu Sans,{max(24, int(font_size * 0.82))},&H00F8FAFC,&H00FFFFFF,&H00101010,&H70000000,"
            f"0,0,0,0,100,100,0,0,3,6,0,2,{margin_h},{margin_h},{margin_v},1"
        )

    events: list[str] = []
    for ch in chunks:
        if style == "karaoke" and ch.get("words"):
            words = ch["words"]
            # Emit active-word highlight events so the spoken word pops in vibrant gold
            for active_i, active_w in enumerate(words):
                ev_start = active_w["start"]
                ev_end = words[active_i + 1]["start"] if active_i + 1 < len(words) else ch["end"]
                ev_end = max(ev_start + 0.04, ev_end)
                rendered_tokens: list[str] = []
                for j, w in enumerate(words):
                    esc = escape_ass(w["word"].upper())
                    if j == active_i:
                        rendered_tokens.append(f"{{\\1c&H003CE6FF&\\fscx110\\fscy110}}{esc}{{\\r}}")
                    else:
                        rendered_tokens.append(esc)
                events.append(
                    f"Dialogue: 0,{fmt_ass_time(ev_start)},{fmt_ass_time(ev_end)},Default,,0,0,0,,{' '.join(rendered_tokens)}"
                )
        else:
            events.append(
                f"Dialogue: 0,{fmt_ass_time(ch['start'])},{fmt_ass_time(ch['end'])},Default,,0,0,0,,{escape_ass(ch['text'])}"
            )

    return "\n".join(
        [
            "[Script Info]",
            "ScriptType: v4.00+",
            f"PlayResX: {width}",
            f"PlayResY: {height}",
            "WrapStyle: 1",
            "ScaledBorderAndShadow: yes",
            "",
            "[V4+ Styles]",
            "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
            style_line,
            "",
            "[Events]",
            "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
            *events,
            "",
        ]
    )


def build_cutflow_overlays(chunks: list[dict], *, style: str = "capcut-pop", is_vertical: bool = True) -> list[dict]:
    overlays: list[dict] = []
    for idx, ch in enumerate(chunks, 1):
        overlays.append(
            {
                "id": f"cap-{idx}",
                "text": ch["text"][:160],
                "startSec": round(float(ch["start"]), 3),
                "endSec": round(max(float(ch["end"]), float(ch["start"]) + 0.15), 3),
                "position": "bottom",
                "style": style,
                "xNorm": 0.5,
                "yNorm": 0.78 if is_vertical else 0.86,
                "scale": 1,
                "rotationDeg": 0,
                "animation": "pop",
            }
        )
    return overlays


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate edited-timeline SRT, Karaoke ASS, and CutFlow overlays.")
    parser.add_argument("--words", required=True, help="Path to WhisperX words.json.")
    parser.add_argument("--cuts", required=True, help="Path to approved cuts.json.")
    parser.add_argument("--fps", default="30/1", help="Footage FPS fraction (e.g. 30/1 or 30000/1001).")
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1920)
    parser.add_argument("--style", choices=["karaoke", "minimal"], default="karaoke")
    parser.add_argument("--out-srt", default=None, help="Output .srt file path.")
    parser.add_argument("--out-ass", default=None, help="Output .ass file path.")
    parser.add_argument("--out-overlays", default=None, help="Output CutFlow TextOverlay[] JSON file path.")
    args = parser.parse_args()

    words_data = json.loads(Path(args.words).expanduser().resolve().read_text(encoding="utf-8"))
    words = words_data.get("words") or []
    segs = build_cut.load_cuts(Path(args.cuts).expanduser().resolve())
    fps = Fraction(args.fps)
    max_frames = max(10_000_000, int(max(s["end"] for s in segs) * float(fps)) + 100)
    snapped = build_cut.snap_segments(segs, fps, max_frames)

    timeline_words = remap_words_to_edited_timeline(words, snapped)
    chunks = chunk_words(timeline_words)

    written: dict[str, object] = {
        "word_count": len(timeline_words),
        "caption_chunks": len(chunks),
    }

    if args.out_srt:
        p = Path(args.out_srt).expanduser().resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(render_srt(chunks), encoding="utf-8")
        written["srt"] = str(p)

    if args.out_ass:
        p = Path(args.out_ass).expanduser().resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(render_ass(chunks, width=args.width, height=args.height, style=args.style), encoding="utf-8")
        written["ass"] = str(p)

    if args.out_overlays:
        p = Path(args.out_overlays).expanduser().resolve()
        p.parent.mkdir(parents=True, exist_ok=True)
        overlays = build_cutflow_overlays(chunks, is_vertical=args.height > args.width)
        p.write_text(json.dumps({"overlays": overlays}, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        written["overlays_json"] = str(p)

    print(json.dumps(written, indent=2))


if __name__ == "__main__":
    main()
