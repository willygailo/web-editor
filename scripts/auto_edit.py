#!/usr/bin/env python3
"""100% automatic AI talking-head video editor CLI & raw/ folder watcher."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".m4v", ".avi", ".webm", ".mts", ".m2ts"}
ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "raw"
TRANSCRIPT_DIR = ROOT / "transcript"
OUTPUT_DIR = ROOT / "output"
SCRIPTS_DIR = ROOT / "scripts"
PROCESSED_DB = TRANSCRIPT_DIR / ".processed.json"


def resolve_whisperx_python() -> Path:
    base = Path.home() / ".cache" / "video-editor" / "whisperx-venv"
    candidates = [
        base / "bin" / "python",
        base / "Scripts" / "python.exe",
    ]
    for c in candidates:
        if c.is_file():
            return c
    sys.exit(
        f"ERROR: WhisperX venv not found at {base}. "
        "Run: uv venv ~/.cache/video-editor/whisperx-venv --python 3.11 && "
        "uv pip install --python ~/.cache/video-editor/whisperx-venv/bin/python whisperx"
    )


def load_processed() -> dict:
    if not PROCESSED_DB.is_file():
        return {}
    try:
        return json.loads(PROCESSED_DB.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_processed(db: dict) -> None:
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    PROCESSED_DB.write_text(json.dumps(db, indent=2) + "\n", encoding="utf-8")


def file_sig(p: Path) -> dict:
    st = p.stat()
    return {"size_bytes": st.st_size, "mtime_ns": st.st_mtime_ns}


def list_raw_videos() -> list[Path]:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    return sorted(
        p for p in RAW_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS and not p.name.startswith(".")
    )


def format_cut_table(cuts_path: Path) -> str:
    data = json.loads(cuts_path.read_text(encoding="utf-8"))
    segs = data.get("segments") or []
    lines = [f"\n--- Proposed Cut List ({len(segs)} segments) ---"]
    total = 0.0
    for i, s in enumerate(segs, 1):
        dur = float(s["end"]) - float(s["start"])
        total += dur
        text = str(s.get("text", "")).strip()
        preview = (text[:78] + "...") if len(text) > 81 else text
        lines.append(f"  {i:02d}. {s['start']:7.2f}s -> {s['end']:7.2f}s ({dur:5.2f}s) | {preview}")
    lines.append(f"Total kept duration: {total:.2f}s\n")
    return "\n".join(lines)


def process_clip(
    clip_path: Path,
    *,
    mode: str = "auto",
    language: str | None = None,
    review: bool = False,
    force: bool = False,
    mirror_latest: bool = True,
) -> dict | None:
    clip_path = clip_path.expanduser().resolve()
    if not clip_path.is_file():
        raise FileNotFoundError(f"Clip not found: {clip_path}")

    db = load_processed()
    sig = file_sig(clip_path)
    prev = db.get(clip_path.name)
    out_mp4 = OUTPUT_DIR / f"{clip_path.stem}_cut.mp4"

    if (
        not force
        and isinstance(prev, dict)
        and prev.get("size_bytes") == sig["size_bytes"]
        and prev.get("mtime_ns") == sig["mtime_ns"]
        and out_mp4.is_file()
    ):
        print(f"[skip] Already auto-edited: {clip_path.name} -> {out_mp4}")
        return prev

    whisperx_py = resolve_whisperx_python()
    TRANSCRIPT_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    words_json = TRANSCRIPT_DIR / f"{clip_path.stem}.words.json"
    wav_path = TRANSCRIPT_DIR / f"{clip_path.stem}_16k.wav"
    cuts_json = TRANSCRIPT_DIR / f"{clip_path.stem}.cuts.json"

    print(f"\n=== Auto-Editing: {clip_path.name} ===")

    # Step 1: Probe footage
    probe_proc = subprocess.run(
        [sys.executable, str(SCRIPTS_DIR / "build_cut.py"), "probe", str(clip_path)],
        check=True,
        capture_output=True,
        text=True,
    )
    probe_info = json.loads(probe_proc.stdout)
    print(
        f"[probe] {probe_info['display_width']}x{probe_info['display_height']} "
        f"({probe_info['orientation']}) @ {probe_info['fps_float']:.3f} fps, "
        f"{probe_info['duration']:.2f}s"
    )

    # Step 2: Transcribe once with WhisperX large-v3
    t_cmd = [
        str(whisperx_py),
        str(SCRIPTS_DIR / "transcribe.py"),
        str(clip_path),
        "--out",
        str(words_json),
        "--wav",
        str(wav_path),
    ]
    if language:
        t_cmd += ["--language", language]
    subprocess.run(t_cmd, check=True)
    if mirror_latest:
        shutil.copy2(words_json, TRANSCRIPT_DIR / "words.json")

    # Step 3: Choose cuts automatically (Claude AI + offline fallback)
    c_cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "choose_cuts.py"),
        str(words_json),
        "--raw",
        str(clip_path),
        "--out",
        str(cuts_json),
        "--mode",
        mode,
    ]
    c_proc = subprocess.run(c_cmd, check=True, capture_output=True, text=True)
    if c_proc.stderr.strip():
        print(c_proc.stderr.strip(), file=sys.stderr)
    cut_summary = json.loads(c_proc.stdout)
    if mirror_latest:
        shutil.copy2(cuts_json, TRANSCRIPT_DIR / "cuts.json")

    print(
        f"[cuts] Engine={cut_summary['source']} | "
        f"Kept {cut_summary['segments_count']} segments | "
        f"{cut_summary['original_duration_sec']:.2f}s -> {cut_summary['edited_duration_sec']:.2f}s "
        f"(trimmed {cut_summary['removed_sec']:.2f}s)"
    )

    if review:
        print(format_cut_table(cuts_json))
        ans = input("Approve cut list and render MP4? [y/N]: ").strip().lower()
        if ans not in ("y", "yes"):
            print(f"[paused] Edit {cuts_json} then re-run scripts/build_cut.py render-mp4.")
            return None

    # Step 4: Render frame-accurate MP4 and verify with ffprobe
    r_cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "build_cut.py"),
        "render-mp4",
        str(clip_path),
        "--cuts",
        str(cuts_json),
        "--out",
        str(out_mp4),
    ]
    subprocess.run(r_cmd, check=True)

    latest_mp4 = ROOT / "cut.mp4"
    if mirror_latest:
        shutil.copy2(out_mp4, latest_mp4)

    record = {
        **sig,
        "output_mp4": str(out_mp4),
        "latest_mp4": str(latest_mp4) if mirror_latest else None,
        "words_json": str(words_json),
        "cuts_json": str(cuts_json),
        "source_engine": cut_summary["source"],
        "segments_count": cut_summary["segments_count"],
        "original_duration_sec": cut_summary["original_duration_sec"],
        "edited_duration_sec": cut_summary["edited_duration_sec"],
        "removed_sec": cut_summary["removed_sec"],
        "processed_at": datetime.now(timezone.utc).isoformat(),
    }
    db[clip_path.name] = record
    save_processed(db)
    print(f"[ready] Saved -> {out_mp4}" + (f" (also updated {latest_mp4})" if mirror_latest else ""))
    return record


def watch_folder(*, mode: str, language: str | None, review: bool, interval: float) -> None:
    print(f"[watch] Watching {RAW_DIR} every {interval:.1f}s (mode={mode}, review={review}). Press Ctrl+C to stop.")
    pending_sigs: dict[str, tuple[int, int, int]] = {}

    try:
        while True:
            db = load_processed()
            for clip in list_raw_videos():
                try:
                    sig = file_sig(clip)
                except OSError:
                    continue
                prev = db.get(clip.name)
                out_mp4 = OUTPUT_DIR / f"{clip.stem}_cut.mp4"
                if (
                    isinstance(prev, dict)
                    and prev.get("size_bytes") == sig["size_bytes"]
                    and prev.get("mtime_ns") == sig["mtime_ns"]
                    and out_mp4.is_file()
                ):
                    pending_sigs.pop(clip.name, None)
                    continue

                if sig["size_bytes"] == 0:
                    continue

                last = pending_sigs.get(clip.name)
                if last and last[0] == sig["size_bytes"] and last[1] == sig["mtime_ns"]:
                    stable_checks = last[2] + 1
                else:
                    stable_checks = 1
                pending_sigs[clip.name] = (sig["size_bytes"], sig["mtime_ns"], stable_checks)

                # Wait for 2 consecutive identical checks so partial copies never trigger early
                if stable_checks >= 2:
                    pending_sigs.pop(clip.name, None)
                    try:
                        process_clip(clip, mode=mode, language=language, review=review, force=False)
                    except Exception as exc:
                        print(f"[error] Failed auto-editing {clip.name}: {exc}", file=sys.stderr)

            time.sleep(interval)
    except KeyboardInterrupt:
        print("\n[watch] Stopped.")


def main() -> None:
    parser = argparse.ArgumentParser(description="100% automatic AI talking-head video editor.")
    parser.add_argument("clip", nargs="?", help="Optional specific raw video file (defaults to unprocessed files in raw/).")
    parser.add_argument("--watch", action="store_true", help="Continuously watch raw/ and auto-edit new clips.")
    parser.add_argument("--interval", type=float, default=2.0, help="Watcher polling interval in seconds.")
    parser.add_argument("--mode", choices=["auto", "claude", "offline"], default="auto")
    parser.add_argument("--language", default=None, help="Optional ISO language hint for WhisperX.")
    parser.add_argument("--review", action="store_true", help="Pause after cuts.json and ask for approval before rendering.")
    parser.add_argument("--force", action="store_true", help="Re-process even if already recorded in .processed.json.")
    args = parser.parse_args()

    if args.watch:
        watch_folder(mode=args.mode, language=args.language, review=args.review, interval=args.interval)
        return

    if args.clip:
        process_clip(Path(args.clip), mode=args.mode, language=args.language, review=args.review, force=args.force)
        return

    clips = list_raw_videos()
    if not clips:
        print(f"No video files in {RAW_DIR}. Drop a talking-head clip into raw/ or run with --watch.")
        return

    for clip in clips:
        process_clip(clip, mode=args.mode, language=args.language, review=args.review, force=args.force)


if __name__ == "__main__":
    main()
