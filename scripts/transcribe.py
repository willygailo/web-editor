#!/usr/bin/env python3
"""Extract 16 kHz mono WAV and transcribe raw footage once with WhisperX large-v3."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
os.environ.setdefault("MPLCONFIGDIR", "/tmp/matplotlib")

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".m4v", ".avi", ".webm", ".mts", ".m2ts"}
ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "raw"
TRANSCRIPT_DIR = ROOT / "transcript"
WORDS_JSON = TRANSCRIPT_DIR / "words.json"
AUDIO_WAV = TRANSCRIPT_DIR / "audio_16k.wav"


def find_raw_clip(explicit: str | None) -> Path:
    if explicit:
        p = Path(explicit).expanduser().resolve()
        if not p.is_file():
            sys.exit(f"ERROR: Raw clip not found: {p}")
        return p

    candidates = sorted(
        p for p in RAW_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in VIDEO_EXTS and not p.name.startswith(".")
    )
    if not candidates:
        sys.exit(f"ERROR: No video clip found in {RAW_DIR}. Drop your raw footage into raw/ first.")
    if len(candidates) > 1:
        names = ", ".join(p.name for p in candidates)
        sys.exit(f"ERROR: Multiple clips in {RAW_DIR} ({names}). Pass the target file path explicitly.")
    return candidates[0]


def source_signature(raw_path: Path) -> dict[str, object]:
    st = raw_path.stat()
    return {
        "filename": raw_path.name,
        "path": str(raw_path),
        "size_bytes": st.st_size,
        "mtime_ns": st.st_mtime_ns,
    }


def already_transcribed(sig: dict[str, object], words_json: Path) -> bool:
    if not words_json.is_file():
        return False
    try:
        data = json.loads(words_json.read_text(encoding="utf-8"))
    except Exception:
        return False
    prev = data.get("source")
    if not isinstance(prev, dict):
        return False
    return (
        prev.get("filename") == sig["filename"]
        and prev.get("size_bytes") == sig["size_bytes"]
        and prev.get("mtime_ns") == sig["mtime_ns"]
        and bool(data.get("words"))
    )


def extract_wav(raw_path: Path, wav_path: Path) -> None:
    wav_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(raw_path),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        str(wav_path),
    ]
    print(f"[ffmpeg] Extracting 16 kHz mono WAV -> {wav_path}")
    subprocess.run(cmd, check=True)


def run_whisperx(wav_path: Path, language: str | None) -> dict[str, object]:
    import torch
    import whisperx

    device = "cuda" if torch.cuda.is_available() else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"
    batch_size = 16 if device == "cuda" else 4

    def _transcribe_and_align(dev: str, ctype: str, bsize: int) -> dict[str, object]:
        print(f"[whisperx] Loading large-v3 on device={dev} compute_type={ctype}...")
        model = whisperx.load_model("large-v3", device=dev, compute_type=ctype)
        audio = whisperx.load_audio(str(wav_path))
        transcribe_kwargs: dict[str, object] = {"batch_size": bsize}
        if language:
            transcribe_kwargs["language"] = language
        result = model.transcribe(audio, **transcribe_kwargs)
        detected_lang = result.get("language") or language or "en"
        print(f"[whisperx] Aligning word timestamps (language={detected_lang})...")
        align_model, metadata = whisperx.load_align_model(language_code=detected_lang, device=dev)
        aligned = whisperx.align(
            result["segments"],
            align_model,
            metadata,
            audio,
            dev,
            return_char_alignments=False,
        )
        return {
            "language": detected_lang,
            "device": dev,
            "compute_type": ctype,
            "segments": aligned.get("segments", []),
            "word_segments": aligned.get("word_segments", []),
        }

    try:
        return _transcribe_and_align(device, compute_type, batch_size)
    except Exception as exc:
        if device == "cuda":
            print(f"[whisperx] CUDA failed ({exc}); falling back to CPU int8...", file=sys.stderr)
            return _transcribe_and_align("cpu", "int8", 4)
        raise


def flatten_words(segments: list[dict[str, object]]) -> list[dict[str, object]]:
    words: list[dict[str, object]] = []
    for seg in segments:
        seg_start = seg.get("start")
        seg_end = seg.get("end")
        for w in seg.get("words", []):
            entry = {
                "word": w.get("word", ""),
                "start": w.get("start", seg_start),
                "end": w.get("end", seg_end),
            }
            if "score" in w:
                entry["score"] = w["score"]
            words.append(entry)
    return words


def main() -> None:
    parser = argparse.ArgumentParser(description="Transcribe raw talking-head footage with WhisperX large-v3.")
    parser.add_argument("raw_clip", nargs="?", help="Path to raw video file (defaults to sole clip in raw/).")
    parser.add_argument("--language", default=None, help="Optional ISO language code (auto-detected if omitted).")
    parser.add_argument("--out", default=str(WORDS_JSON), help="Output words.json path.")
    parser.add_argument("--wav", default=str(AUDIO_WAV), help="Intermediate 16 kHz mono WAV path.")
    args = parser.parse_args()

    raw_path = find_raw_clip(args.raw_clip)
    out_path = Path(args.out).expanduser().resolve()
    wav_path = Path(args.wav).expanduser().resolve()
    sig = source_signature(raw_path)

    if already_transcribed(sig, out_path):
        data = json.loads(out_path.read_text(encoding="utf-8"))
        print(
            f"[skip] {out_path} already exists for {raw_path.name} "
            f"({len(data.get('words', []))} words). Never transcribing the same footage twice."
        )
        return

    extract_wav(raw_path, wav_path)
    out = run_whisperx(wav_path, args.language)
    words = flatten_words(out["segments"])

    payload = {
        "source": sig,
        "language": out["language"],
        "device": out["device"],
        "compute_type": out["compute_type"],
        "word_count": len(words),
        "segments": out["segments"],
        "words": words,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[done] Wrote {len(words)} aligned words -> {out_path}")


if __name__ == "__main__":
    main()
