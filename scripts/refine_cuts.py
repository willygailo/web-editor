#!/usr/bin/env python3
"""Waveform-aware cut boundary refinement: snaps rough cuts to quiet RMS valleys & zero-crossings."""

from __future__ import annotations

import argparse
import array
import json
import math
import os
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

ROOT = Path(__file__).resolve().parent.parent


def load_mono_pcm16(audio_or_video: Path) -> tuple[array.array, int]:
    """Load mono 16-bit PCM samples directly from a WAV or extract via ffmpeg."""
    if audio_or_video.suffix.lower() == ".wav":
        try:
            with wave.open(str(audio_or_video), "rb") as wf:
                if wf.getnchannels() == 1 and wf.getsampwidth() == 2:
                    sr = wf.getframerate()
                    raw = wf.readframes(wf.getnframes())
                    samples = array.array("h")
                    samples.frombytes(raw)
                    if sys.byteorder == "big":
                        samples.byteswap()
                    return samples, sr
        except Exception:
            pass

    with tempfile.TemporaryDirectory() as tmp:
        wav_path = Path(tmp) / "mono.wav"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(audio_or_video),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                str(wav_path),
            ],
            check=True,
            capture_output=True,
        )
        with wave.open(str(wav_path), "rb") as wf:
            sr = wf.getframerate()
            raw = wf.readframes(wf.getnframes())
            samples = array.array("h")
            samples.frombytes(raw)
            if sys.byteorder == "big":
                samples.byteswap()
            return samples, sr


def rms_dbfs(samples: array.array, start_idx: int, end_idx: int) -> float:
    n = len(samples)
    s = max(0, min(n, start_idx))
    e = max(s + 1, min(n, end_idx))
    if e <= s:
        return -96.0
    acc = 0.0
    for i in range(s, e):
        v = samples[i]
        acc += v * v
    rms = math.sqrt(acc / (e - s)) / 32768.0
    if rms <= 1e-6:
        return -96.0
    return 20.0 * math.log10(rms)


def find_nearest_zero_crossing(samples: array.array, idx: int, radius_samples: int) -> int:
    n = len(samples)
    if n < 2:
        return 0
    idx = max(0, min(n - 1, idx))
    best_idx = idx
    best_abs = abs(samples[idx])

    lo = max(1, idx - radius_samples)
    hi = min(n - 1, idx + radius_samples)
    best_dist = radius_samples + 1

    for i in range(lo, hi + 1):
        a = samples[i - 1]
        b = samples[i]
        if (a <= 0 <= b) or (b <= 0 <= a):
            dist = abs(i - idx)
            if dist < best_dist:
                best_dist = dist
                best_idx = i
        elif best_dist > radius_samples and abs(b) < best_abs:
            best_abs = abs(b)
            best_idx = i
    return best_idx


def snap_edge_to_quiet_valley(
    samples: array.array,
    sr: int,
    target_sec: float,
    min_sec: float,
    max_sec: float,
    *,
    prefer_earlier: bool,
    window_ms: float = 20.0,
    step_ms: float = 5.0,
) -> tuple[float, float]:
    """Search [min_sec, max_sec] for the quietest RMS window, with gentle distance bias toward target_sec."""
    total_sec = len(samples) / sr
    lo_s = max(0.0, min(total_sec, min_sec))
    hi_s = max(lo_s, min(total_sec, max_sec))
    target_s = max(lo_s, min(hi_s, target_sec))

    if hi_s - lo_s < 0.01:
        idx = int(round(target_s * sr))
        win = max(1, int(sr * window_ms / 1000.0))
        return round(target_s, 4), round(rms_dbfs(samples, idx - win // 2, idx + win // 2), 2)

    half_win = max(1, int(sr * (window_ms / 2000.0)))
    step_s = max(0.002, step_ms / 1000.0)

    best_score = float("inf")
    best_t = target_s
    best_db = -96.0

    t = lo_s
    while t <= hi_s + 1e-6:
        idx = int(round(t * sr))
        db = rms_dbfs(samples, idx - half_win, idx + half_win)
        # Prefer quiet valleys while penalizing excessive drift away from the word-padded target
        drift_ms = abs(t - target_s) * 1000.0
        # Slight preference for breathing room outward from speech (earlier for start, later for end)
        outward_bonus = -0.8 if ((prefer_earlier and t <= target_s) or (not prefer_earlier and t >= target_s)) else 0.0
        score = db + (drift_ms * 0.045) + outward_bonus
        if score < best_score:
            best_score = score
            best_t = t
            best_db = db
        t += step_s

    zc_idx = find_nearest_zero_crossing(samples, int(round(best_t * sr)), int(sr * 0.004))
    snapped_t = max(lo_s, min(hi_s, zc_idx / sr))
    return round(snapped_t, 4), round(best_db, 2)


def refine_segments(
    segments: list[dict],
    samples: array.array,
    sr: int,
    *,
    words: list[dict] | None = None,
    search_ms: float = 120.0,
) -> tuple[list[dict], dict]:
    """Refine every segment's start/end onto quiet audio valleys without clipping words or overlapping."""
    total_sec = len(samples) / sr
    search_s = max(0.02, search_ms / 1000.0)
    words_sorted = sorted(
        (
            {"start": float(w["start"]), "end": float(w["end"])}
            for w in (words or [])
            if w.get("start") is not None and w.get("end") is not None
        ),
        key=lambda x: x["start"],
    )

    def _prev_cut_word_end(seg_start: float) -> float:
        best = 0.0
        for w in words_sorted:
            if w["end"] <= seg_start + 0.005:
                best = w["end"]
            else:
                break
        return best

    def _next_cut_word_start(seg_end: float) -> float:
        for w in words_sorted:
            if w["start"] >= seg_end - 0.005:
                return w["start"]
        return total_sec

    refined: list[dict] = []
    shifts_ms: list[float] = []
    hot_boundaries = 0

    for i, seg in enumerate(segments):
        orig_s = max(0.0, min(total_sec, float(seg["start"])))
        orig_e = max(orig_s + 0.05, min(total_sec, float(seg["end"])))
        seg_len = orig_e - orig_s

        prev_bound = refined[-1]["end"] if refined else 0.0
        next_bound = float(segments[i + 1]["start"]) if i + 1 < len(segments) else total_sec

        # Never reach back into a previously cut word, and never trim deeper than 35ms into the spoken segment
        in_lo = max(prev_bound, _prev_cut_word_end(orig_s) + 0.004, orig_s - search_s)
        in_hi = min(orig_e - 0.08, orig_s + min(0.035, seg_len * 0.15))
        if in_hi < in_lo:
            in_lo = in_hi = max(prev_bound, orig_s)

        new_s, start_db = snap_edge_to_quiet_valley(
            samples, sr, orig_s, in_lo, in_hi, prefer_earlier=True
        )

        out_lo = max(new_s + 0.08, orig_e - min(0.035, seg_len * 0.15))
        out_hi = min(next_bound, _next_cut_word_start(orig_e) - 0.004, orig_e + search_s)
        if out_hi < out_lo:
            out_lo = out_hi = min(next_bound, orig_e)

        new_e, end_db = snap_edge_to_quiet_valley(
            samples, sr, orig_e, out_lo, out_hi, prefer_earlier=False
        )

        if new_e <= new_s + 0.04:
            new_s, new_e = orig_s, orig_e

        shift_s_ms = round((new_s - orig_s) * 1000.0, 1)
        shift_e_ms = round((new_e - orig_e) * 1000.0, 1)
        shifts_ms.extend([abs(shift_s_ms), abs(shift_e_ms)])
        if start_db > -24.0:
            hot_boundaries += 1
        if end_db > -24.0:
            hot_boundaries += 1

        entry = dict(seg)
        entry["start"] = round(new_s, 4)
        entry["end"] = round(new_e, 4)
        entry["qa"] = {
            "start_db": start_db,
            "end_db": end_db,
            "shift_start_ms": shift_s_ms,
            "shift_end_ms": shift_e_ms,
        }
        refined.append(entry)

    # Guarantee strict non-overlapping monotonicity
    for i in range(1, len(refined)):
        if refined[i]["start"] < refined[i - 1]["end"]:
            mid = round((refined[i - 1]["end"] + refined[i]["start"]) / 2.0, 4)
            refined[i - 1]["end"] = mid
            refined[i]["start"] = mid

    stats = {
        "segments_refined": len(refined),
        "avg_shift_ms": round(sum(shifts_ms) / max(1, len(shifts_ms)), 1),
        "max_shift_ms": round(max(shifts_ms, default=0.0), 1),
        "hot_boundaries_over_neg24db": hot_boundaries,
    }
    return refined, stats


def main() -> None:
    parser = argparse.ArgumentParser(description="Refine cuts.json boundaries onto quiet waveform valleys.")
    parser.add_argument("cuts_json", help="Input cuts.json path.")
    parser.add_argument("--audio", required=True, help="WAV or source video path for waveform analysis.")
    parser.add_argument("--words", default=None, help="Optional words.json path to avoid intruding into cut words.")
    parser.add_argument("--out", default=None, help="Output refined cuts.json path (defaults to overwriting input).")
    parser.add_argument("--search-ms", type=float, default=120.0, help="Boundary search radius in ms (default: 120).")
    args = parser.parse_args()

    cuts_path = Path(args.cuts_json).expanduser().resolve()
    audio_path = Path(args.audio).expanduser().resolve()
    out_path = Path(args.out).expanduser().resolve() if args.out else cuts_path

    if not cuts_path.is_file():
        sys.exit(f"ERROR: cuts.json not found: {cuts_path}")
    if not audio_path.is_file():
        sys.exit(f"ERROR: Audio/video file not found: {audio_path}")

    cuts_data = json.loads(cuts_path.read_text(encoding="utf-8"))
    segs = cuts_data.get("segments") or []
    if not segs:
        sys.exit(f"ERROR: No segments found in {cuts_path}")

    words = None
    if args.words:
        wp = Path(args.words).expanduser().resolve()
        if wp.is_file():
            words = json.loads(wp.read_text(encoding="utf-8")).get("words")

    samples, sr = load_mono_pcm16(audio_path)
    refined, stats = refine_segments(segs, samples, sr, words=words, search_ms=args.search_ms)

    cuts_data["segments"] = refined
    cuts_data["refined_by"] = "waveform_rms_zero_crossing"
    cuts_data["refinement_stats"] = stats

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(cuts_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(out_path), **stats}, indent=2))


if __name__ == "__main__":
    main()
