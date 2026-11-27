#!/usr/bin/env python3
"""Automated Edit QA & Playback Verification: frame accuracy, splice audio audit, black/freeze check & round-trip script proof."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from difflib import SequenceMatcher
from fractions import Fraction
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

SCRIPTS_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS_DIR))

import build_cut  # noqa: E402
import polish_audio  # noqa: E402
import refine_cuts  # noqa: E402


def normalize_script_tokens(text: str) -> list[str]:
    return re.findall(r"[a-z0-9]+", text.lower())


def compare_scripts(expected_text: str, actual_text: str) -> dict:
    exp_tokens = normalize_script_tokens(expected_text)
    act_tokens = normalize_script_tokens(actual_text)
    if not exp_tokens:
        return {
            "expected_words": 0,
            "actual_words": len(act_tokens),
            "similarity_pct": 100.0,
            "missing_sample": [],
            "extra_sample": [],
        }

    matcher = SequenceMatcher(None, exp_tokens, act_tokens)
    sim = round(matcher.ratio() * 100.0, 2)
    missing: list[str] = []
    extra: list[str] = []
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag in ("delete", "replace"):
            missing.extend(exp_tokens[i1:i2])
        if tag in ("insert", "replace"):
            extra.extend(act_tokens[j1:j2])

    return {
        "expected_words": len(exp_tokens),
        "actual_words": len(act_tokens),
        "similarity_pct": sim,
        "missing_sample": missing[:20],
        "extra_sample": extra[:20],
    }


def detect_black_and_freeze(video_path: Path) -> dict:
    proc = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-i",
            str(video_path),
            "-vf",
            "blackdetect=d=0.15:pix_th=0.10,freezedetect=n=-60dB:d=1.5",
            "-an",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
    )
    stderr = proc.stderr
    blacks = re.findall(r"black_start:([\d.]+)\s+black_end:([\d.]+)\s+black_duration:([\d.]+)", stderr)
    freezes = re.findall(r"freeze_duration:\s*([\d.]+)", stderr)
    return {
        "black_segments": [
            {"start": float(a), "end": float(b), "duration": float(c)} for a, b, c in blacks
        ],
        "freeze_count": len(freezes),
    }


def audit_splice_boundaries(video_path: Path, snapped_clips: list[dict]) -> dict:
    """Measure audio RMS and sudden peak jumps right at each splice boundary in the rendered file."""
    samples, sr = refine_cuts.load_mono_pcm16(video_path)
    if len(samples) == 0 or len(snapped_clips) <= 1:
        return {"splice_count": 0, "hot_splices": [], "max_splice_db": -96.0}

    cursor_sec = 0.0
    hot_splices: list[dict] = []
    max_db = -96.0
    win = max(1, int(sr * 0.015))

    for idx, clip in enumerate(snapped_clips[:-1], 1):
        cursor_sec += clip["duration_sec"]
        sample_idx = int(round(cursor_sec * sr))
        db = round(refine_cuts.rms_dbfs(samples, sample_idx - win, sample_idx + win), 2)
        if db > max_db:
            max_db = db
        # Check single-sample step discontinuity right at splice (click detector)
        step_click = 0.0
        if 2 <= sample_idx < len(samples) - 2:
            local_diffs = [
                abs(samples[k] - samples[k - 1]) / 32768.0
                for k in range(sample_idx - 2, sample_idx + 3)
            ]
            step_click = round(max(local_diffs), 4)
        if db > -18.0 or step_click > 0.35:
            hot_splices.append(
                {
                    "splice_index": idx,
                    "timeline_sec": round(cursor_sec, 3),
                    "rms_db": db,
                    "step_delta": step_click,
                }
            )

    return {
        "splice_count": len(snapped_clips) - 1,
        "hot_splices": hot_splices,
        "max_splice_db": round(max_db, 2),
    }


def resolve_whisperx_python() -> Path | None:
    base = Path.home() / ".cache" / "video-editor" / "whisperx-venv"
    for c in (base / "bin" / "python", base / "Scripts" / "python.exe"):
        if c.is_file():
            return c
    return None


def run_roundtrip_transcript(rendered_mp4: Path, model_size: str = "small", language: str | None = None) -> str | None:
    py = resolve_whisperx_python()
    if not py:
        return None
    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        wav = tmp_dir / "qa_16k.wav"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(rendered_mp4),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "16000",
                "-c:a",
                "pcm_s16le",
                str(wav),
            ],
            check=True,
            capture_output=True,
        )
        helper = (
            "import json, sys, torch, whisperx\n"
            "wav, model_size, lang = sys.argv[1], sys.argv[2], sys.argv[3]\n"
            "dev = 'cuda' if torch.cuda.is_available() else 'cpu'\n"
            "ctype = 'float16' if dev == 'cuda' else 'int8'\n"
            "m = whisperx.load_model(model_size, device=dev, compute_type=ctype)\n"
            "audio = whisperx.load_audio(wav)\n"
            "kw = {'batch_size': 8 if dev == 'cuda' else 4}\n"
            "if lang: kw['language'] = lang\n"
            "res = m.transcribe(audio, **kw)\n"
            "text = ' '.join(s.get('text', '').strip() for s in res.get('segments', []))\n"
            "print(json.dumps({'text': text}))\n"
        )
        proc = subprocess.run(
            [str(py), "-c", helper, str(wav), model_size, language or ""],
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            return None
        for line in reversed(proc.stdout.splitlines()):
            line = line.strip()
            if line.startswith("{") and line.endswith("}"):
                try:
                    return str(json.loads(line).get("text", ""))
                except Exception:
                    continue
    return None


def verify_rendered_edit(
    rendered_mp4: Path,
    cuts_json: Path,
    *,
    raw_clip: Path | None = None,
    script_check: bool = False,
    qa_model: str = "small",
    language: str | None = None,
    out_report: Path | None = None,
) -> dict:
    rendered_mp4 = rendered_mp4.expanduser().resolve()
    cuts_json = cuts_json.expanduser().resolve()
    if not rendered_mp4.is_file():
        raise FileNotFoundError(f"Rendered video not found: {rendered_mp4}")
    if not cuts_json.is_file():
        raise FileNotFoundError(f"cuts.json not found: {cuts_json}")

    out_info = build_cut.probe_media(rendered_mp4, count_frames=True)
    segs = build_cut.load_cuts(cuts_json)

    if raw_clip and raw_clip.is_file():
        raw_info = build_cut.probe_media(raw_clip, count_frames=False)
        fps = Fraction(raw_info["fps_fraction"])
        max_frames = raw_info["nb_frames"]
    else:
        raw_info = None
        fps = Fraction(out_info["fps_fraction"])
        max_frames = max(10_000_000, int(max(s["end"] for s in segs) * float(fps)) + 100)

    snapped = build_cut.snap_segments(segs, fps, max_frames)
    expected_frames = sum(c["frames"] for c in snapped)
    expected_dur = float(Fraction(expected_frames, 1) / fps)
    frame_diff = out_info["nb_frames"] - expected_frames
    dur_diff = round(out_info["duration"] - expected_dur, 4)

    issues: list[str] = []
    warnings: list[str] = []

    if abs(frame_diff) > 2:
        issues.append(f"Frame count mismatch: expected {expected_frames}, actual {out_info['nb_frames']} (diff={frame_diff}).")
    elif frame_diff != 0:
        warnings.append(f"Minor frame count delta: {frame_diff} frame(s).")

    if raw_info and (
        out_info["display_width"] != raw_info["display_width"]
        or out_info["display_height"] != raw_info["display_height"]
    ):
        # Not always an error if a platform aspect ratio override was requested, so warn
        warnings.append(
            f"Dimensions changed from {raw_info['display_width']}x{raw_info['display_height']} "
            f"to {out_info['display_width']}x{out_info['display_height']}."
        )

    visual_audit = detect_black_and_freeze(rendered_mp4)
    if visual_audit["black_segments"]:
        warnings.append(f"Detected {len(visual_audit['black_segments'])} black segment(s) in rendered output.")
    if visual_audit["freeze_count"] > 0:
        warnings.append(f"Detected {visual_audit['freeze_count']} frozen-frame segment(s).")

    loudness = polish_audio.measure_loudness(rendered_mp4) if out_info["has_audio"] else None
    splice_audit = audit_splice_boundaries(rendered_mp4, snapped) if out_info["has_audio"] else {"splice_count": 0, "hot_splices": []}
    if splice_audit.get("hot_splices"):
        warnings.append(
            f"{len(splice_audit['hot_splices'])} splice boundary(ies) had elevated audio level/step (check splice_audit)."
        )

    script_audit = None
    if script_check and out_info["has_audio"]:
        expected_text = " ".join(str(s.get("text", "")).strip() for s in segs).strip()
        if expected_text:
            actual_text = run_roundtrip_transcript(rendered_mp4, model_size=qa_model, language=language)
            if actual_text is not None:
                script_audit = compare_scripts(expected_text, actual_text)
                script_audit["actual_transcript"] = actual_text
                if script_audit["similarity_pct"] < 75.0:
                    issues.append(
                        f"Round-trip script similarity low ({script_audit['similarity_pct']}%): playback may have clipped or dropped lines."
                    )
                elif script_audit["similarity_pct"] < 88.0:
                    warnings.append(f"Round-trip script similarity is {script_audit['similarity_pct']}%.")
            else:
                warnings.append("Skipped round-trip WhisperX verification (venv unavailable or transcription returned empty).")

    verdict = "FAIL" if issues else ("WARN" if warnings else "PASS")
    report = {
        "verdict": verdict,
        "rendered_mp4": str(rendered_mp4),
        "clip_count": len(snapped),
        "expected_frames": expected_frames,
        "actual_frames": out_info["nb_frames"],
        "frame_diff": frame_diff,
        "expected_duration_sec": round(expected_dur, 4),
        "actual_duration_sec": round(out_info["duration"], 4),
        "duration_diff_sec": dur_diff,
        "dimensions": f"{out_info['display_width']}x{out_info['display_height']} ({out_info['orientation']})",
        "fps": out_info["fps_fraction"],
        "loudness": {
            "integrated_lufs": loudness.get("input_i") if loudness else None,
            "true_peak_db": loudness.get("input_tp") if loudness else None,
            "lra": loudness.get("input_lra") if loudness else None,
        },
        "splice_audit": splice_audit,
        "visual_audit": visual_audit,
        "script_audit": script_audit,
        "issues": issues,
        "warnings": warnings,
    }

    if out_report:
        out_report = out_report.expanduser().resolve()
        out_report.parent.mkdir(parents=True, exist_ok=True)
        out_report.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Verify rendered talking-head edit quality & script playback.")
    parser.add_argument("rendered_mp4", help="Path to rendered cut.mp4.")
    parser.add_argument("--cuts", required=True, help="Path to approved cuts.json.")
    parser.add_argument("--raw", default=None, help="Optional original raw clip for dimension/FPS comparison.")
    parser.add_argument("--script-check", action="store_true", help="Re-transcribe rendered MP4 with WhisperX and diff against cuts.json.")
    parser.add_argument("--qa-model", default="small", help="WhisperX model size for --script-check (default: small).")
    parser.add_argument("--language", default=None, help="Optional ISO language hint for --script-check.")
    parser.add_argument("--out", default=None, help="Optional output path for qa_report.json.")
    args = parser.parse_args()

    try:
        report = verify_rendered_edit(
            Path(args.rendered_mp4),
            Path(args.cuts),
            raw_clip=Path(args.raw) if args.raw else None,
            script_check=args.script_check,
            qa_model=args.qa_model,
            language=args.language,
            out_report=Path(args.out) if args.out else None,
        )
        print(json.dumps(report, indent=2, ensure_ascii=False))
        if report["verdict"] == "FAIL":
            sys.exit(2)
    except Exception as exc:
        sys.exit(f"ERROR: {exc}")


if __name__ == "__main__":
    main()
