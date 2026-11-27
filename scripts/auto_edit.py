#!/usr/bin/env python3
"""Pro automated AI talking-head video editor CLI & raw/ folder watcher.

Integrates:
  - yt-dlp URL ingest (optional --url)
  - ClearerVoice-Studio + 2-pass -14 LUFS audio mastering (--polish fast|studio|none)
  - WhisperX large-v3 word alignment + optional speaker diarization
  - Multi-engine AI rough-cut selection (Claude / Gemini / Offline + Taglish rules)
  - Waveform RMS & zero-crossing boundary snapping (default ON)
  - Edited-timeline SRT / Karaoke ASS captions + CutFlow overlays
  - Finishing: micro audio fades, alternating punch-in zoom, color looks/LUTs, sidechain-ducked BGM, platform specs
  - Optional HyperFrames HTML/CSS/JS intro/outro motion graphics
  - Multi-NLE trimmable exports (FCPXML, CMX 3600 EDL, CutFlow JSON)
  - Automated Edit QA verification (frame check, splice RMS audit, black/freeze check, optional round-trip script diff)
"""

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
        preview = (text[:72] + "...") if len(text) > 75 else text
        qa = s.get("qa") or {}
        qa_str = f" [in:{qa['start_db']:.0f}dB out:{qa['end_db']:.0f}dB]" if "start_db" in qa else ""
        lines.append(f"  {i:02d}. {s['start']:7.2f}s -> {s['end']:7.2f}s ({dur:5.2f}s){qa_str} | {preview}")
    lines.append(f"Total kept duration: {total:.2f}s\n")
    return "\n".join(lines)


def process_clip(
    clip_path: Path,
    *,
    mode: str = "auto",
    language: str | None = None,
    diarize: bool = False,
    speaker: str | None = None,
    polish: str = "fast",
    refine_waveform: bool = True,
    captions: str = "none",
    punch_in: float = 1.0,
    look: str = "none",
    lut: str | None = None,
    bgm: str | None = None,
    bgm_vol: float = 0.14,
    audio_fade_ms: float = 12.0,
    platform: str = "native",
    motion_gfx: bool = False,
    broll_plan: bool = False,
    broll_generate: bool = False,
    broll_manifest: str | None = None,
    broll_style: str = "cutaway",
    broll_model: str = "kling",
    export_nle: list[str] | None = None,
    verify: bool = True,
    script_check: bool = False,
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
    polished_wav = TRANSCRIPT_DIR / f"{clip_path.stem}.polished.wav"
    cuts_json = TRANSCRIPT_DIR / f"{clip_path.stem}.cuts.json"
    qa_report_path = TRANSCRIPT_DIR / f"{clip_path.stem}.qa_report.json"

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

    # Step 2: Optional Audio Polish (FFmpeg Broadcast Mastering / ClearerVoice-Studio)
    active_polished_wav: Path | None = None
    if polish != "none" and probe_info.get("has_audio"):
        denoise_arg = "studio" if polish == "studio" else "ffmpeg"
        p_proc = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "polish_audio.py"),
                str(clip_path),
                "--out",
                str(polished_wav),
                "--denoise",
                denoise_arg,
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        p_info = json.loads(p_proc.stdout)
        active_polished_wav = polished_wav
        print(
            f"[audio] Polished via {p_info.get('engine_used')} "
            f"(LUFS: {p_info.get('input_lufs')} -> {p_info.get('output_lufs')})"
        )
        for w in p_info.get("warnings") or []:
            print(f"[warn] {w}", file=sys.stderr)

    # Step 3: Transcribe once with WhisperX large-v3
    t_cmd = [
        str(whisperx_py),
        str(SCRIPTS_DIR / "transcribe.py"),
        str(clip_path),
        "--out",
        str(words_json),
        "--wav",
        str(wav_path),
    ]
    if active_polished_wav and active_polished_wav.is_file():
        t_cmd += ["--wav-input", str(active_polished_wav)]
    if language:
        t_cmd += ["--language", language]
    if diarize:
        t_cmd += ["--diarize"]
    subprocess.run(t_cmd, check=True)
    if mirror_latest:
        shutil.copy2(words_json, TRANSCRIPT_DIR / "words.json")

    # Step 4: Choose rough cuts (Claude / Gemini / Offline)
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
    if speaker:
        c_cmd += ["--speaker", speaker]
    c_proc = subprocess.run(c_cmd, check=True, capture_output=True, text=True)
    if c_proc.stderr.strip():
        print(c_proc.stderr.strip(), file=sys.stderr)
    cut_summary = json.loads(c_proc.stdout)

    # Step 5: Waveform boundary snapping (PCM RMS valley + zero-crossing)
    if refine_waveform and (wav_path.is_file() or probe_info.get("has_audio")):
        ref_audio = active_polished_wav if (active_polished_wav and active_polished_wav.is_file()) else (wav_path if wav_path.is_file() else clip_path)
        ref_proc = subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "refine_cuts.py"),
                str(cuts_json),
                "--audio",
                str(ref_audio),
                "--words",
                str(words_json),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        ref_stats = json.loads(ref_proc.stdout)
        print(
            f"[waveform] Snapped {ref_stats['segments_refined']} segments "
            f"(avg shift {ref_stats['avg_shift_ms']}ms, max {ref_stats['max_shift_ms']}ms)"
        )

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
        ans = input("Approve cut list and render? [y/N]: ").strip().lower()
        if ans not in ("y", "yes"):
            print(f"[paused] Edit {cuts_json} then re-run scripts/build_cut.py render-mp4.")
            return None

    # Step 6: Captions (SRT + Karaoke/Minimal ASS)
    ass_path: Path | None = None
    srt_path = OUTPUT_DIR / f"{clip_path.stem}_cut.srt"
    if captions != "none":
        ass_path = OUTPUT_DIR / f"{clip_path.stem}_cut.ass"
        cap_w = probe_info["display_width"]
        cap_h = probe_info["display_height"]
        subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "generate_captions.py"),
                "--words",
                str(words_json),
                "--cuts",
                str(cuts_json),
                "--fps",
                probe_info["fps_fraction"],
                "--width",
                str(cap_w),
                "--height",
                str(cap_h),
                "--style",
                captions,
                "--out-srt",
                str(srt_path),
                "--out-ass",
                str(ass_path),
            ],
            check=True,
            capture_output=True,
        )
        print(f"[captions] Wrote {srt_path.name} & {ass_path.name} ({captions})")

    # Step 7: Optional HyperFrames Motion Graphics Intro/Outro
    intro_mp4: Path | None = None
    outro_mp4: Path | None = None
    if motion_gfx:
        cuts_data = json.loads(cuts_json.read_text(encoding="utf-8"))
        first_line = str((cuts_data.get("segments") or [{}])[0].get("text", clip_path.stem))[:46]
        intro_mp4 = OUTPUT_DIR / "motion" / f"{clip_path.stem}_intro.mp4"
        outro_mp4 = OUTPUT_DIR / "motion" / f"{clip_path.stem}_outro.mp4"
        fps_int = max(24, min(60, round(probe_info["fps_float"])))
        subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "render_motion.py"),
                "--template",
                "hook_card",
                "--title",
                first_line or clip_path.stem,
                "--subtitle",
                "Edited with CutFlow AI",
                "--width",
                str(probe_info["display_width"]),
                "--height",
                str(probe_info["display_height"]),
                "--fps",
                str(fps_int),
                "--duration",
                "2.0",
                "--out",
                str(intro_mp4),
            ],
            check=True,
            capture_output=True,
        )
        subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "render_motion.py"),
                "--template",
                "cta_outro",
                "--badge",
                "FOLLOW FOR MORE",
                "--title",
                "Thanks for watching!",
                "--subtitle",
                "Save & share if this helped",
                "--width",
                str(probe_info["display_width"]),
                "--height",
                str(probe_info["display_height"]),
                "--fps",
                str(fps_int),
                "--duration",
                "2.0",
                "--out",
                str(outro_mp4),
            ],
            check=True,
            capture_output=True,
        )
        print(f"[motion] Rendered HyperFrames intro & outro -> {OUTPUT_DIR / 'motion'}")

    # Step 7B: Optional Higgsfield B-roll planning & Cloud API generation
    active_broll_manifest: Path | None = Path(broll_manifest).expanduser().resolve() if broll_manifest else None
    if broll_plan or broll_generate:
        plan_out = TRANSCRIPT_DIR / f"{clip_path.stem}.broll_plan.json"
        ratio = probe_info["display_width"] / max(1, probe_info["display_height"])
        aspect = "9:16" if ratio < 0.72 else ("4:5" if ratio < 0.92 else ("1:1" if ratio <= 1.15 else "16:9"))
        subprocess.run(
            [
                sys.executable,
                str(SCRIPTS_DIR / "plan_broll.py"),
                str(cuts_json),
                "--out",
                str(plan_out),
                "--mode",
                mode,
                "--aspect",
                aspect,
                "--style",
                broll_style,
                "--model",
                broll_model,
            ],
            check=True,
            capture_output=True,
        )
        print(f"[broll] Planned Higgsfield B-roll cues -> {plan_out}")
        active_broll_manifest = plan_out
        if broll_generate:
            g_proc = subprocess.run(
                [
                    sys.executable,
                    str(SCRIPTS_DIR / "generate_broll.py"),
                    "--plan",
                    str(plan_out),
                    "--out-dir",
                    str(RAW_DIR / "broll"),
                ],
                capture_output=True,
                text=True,
            )
            if g_proc.returncode == 0:
                print(f"[broll] Generated Higgsfield clips -> {RAW_DIR / 'broll'}")
            else:
                print(f"[warn] Higgsfield B-roll generation skipped ({g_proc.stderr.strip() or g_proc.stdout.strip()})", file=sys.stderr)

    # Step 8: Render frame-accurate MP4
    r_cmd = [
        sys.executable,
        str(SCRIPTS_DIR / "build_cut.py"),
        "render-mp4",
        str(clip_path),
        "--cuts",
        str(cuts_json),
        "--out",
        str(out_mp4),
        "--audio-fade-ms",
        str(audio_fade_ms),
        "--punch-in",
        str(punch_in),
        "--look",
        look,
        "--platform",
        platform,
    ]
    if active_polished_wav and active_polished_wav.is_file():
        r_cmd += ["--polished-audio", str(active_polished_wav)]
    if lut:
        r_cmd += ["--lut", lut]
    if ass_path and ass_path.is_file():
        r_cmd += ["--captions", str(ass_path)]
    if bgm and bgm != "none":
        r_cmd += ["--bgm", bgm, "--bgm-vol", str(bgm_vol)]
    if intro_mp4 and intro_mp4.is_file():
        r_cmd += ["--intro", str(intro_mp4)]
    if outro_mp4 and outro_mp4.is_file():
        r_cmd += ["--outro", str(outro_mp4)]
    if active_broll_manifest and active_broll_manifest.is_file():
        r_cmd += ["--broll-manifest", str(active_broll_manifest), "--broll-style", broll_style]

    subprocess.run(r_cmd, check=True)

    latest_mp4 = ROOT / "cut.mp4"
    if mirror_latest:
        shutil.copy2(out_mp4, latest_mp4)

    # Step 9: Optional multi-NLE trimmable timeline exports
    nle_exports: dict[str, str] = {}
    for fmt in (export_nle or []):
        fmt_clean = fmt.strip().lower()
        if fmt_clean == "fcpxml":
            f_out = OUTPUT_DIR / f"{clip_path.stem}_cut.fcpxml"
            subprocess.run(
                [sys.executable, str(SCRIPTS_DIR / "build_cut.py"), "fcpxml", str(clip_path), "--cuts", str(cuts_json), "--out", str(f_out)],
                check=True,
                capture_output=True,
            )
            nle_exports["fcpxml"] = str(f_out)
        elif fmt_clean == "edl":
            e_out = OUTPUT_DIR / f"{clip_path.stem}_cut.edl"
            subprocess.run(
                [sys.executable, str(SCRIPTS_DIR / "build_cut.py"), "edl", str(clip_path), "--cuts", str(cuts_json), "--out", str(e_out)],
                check=True,
                capture_output=True,
            )
            nle_exports["edl"] = str(e_out)
        elif fmt_clean == "cutflow":
            c_out = OUTPUT_DIR / f"{clip_path.stem}.cutflow.json"
            subprocess.run(
                [sys.executable, str(SCRIPTS_DIR / "build_cut.py"), "cutflow", str(clip_path), "--cuts", str(cuts_json), "--out", str(c_out), "--punch-in", str(punch_in)],
                check=True,
                capture_output=True,
            )
            nle_exports["cutflow"] = str(c_out)

    # Step 10: Automated Edit QA Verification
    qa_verdict = None
    if verify and not motion_gfx:
        v_cmd = [
            sys.executable,
            str(SCRIPTS_DIR / "verify_edit.py"),
            str(out_mp4),
            "--cuts",
            str(cuts_json),
            "--raw",
            str(clip_path),
            "--out",
            str(qa_report_path),
        ]
        if script_check:
            v_cmd += ["--script-check"]
            if language:
                v_cmd += ["--language", language]
        v_proc = subprocess.run(v_cmd, capture_output=True, text=True)
        if qa_report_path.is_file():
            qa_data = json.loads(qa_report_path.read_text(encoding="utf-8"))
            qa_verdict = qa_data.get("verdict")
            print(
                f"[qa] Verdict={qa_verdict} | frame_diff={qa_data.get('frame_diff')} | "
                f"hot_splices={len((qa_data.get('splice_audit') or {}).get('hot_splices', []))} | "
                f"report={qa_report_path}"
            )
            if v_proc.returncode != 0:
                print(f"[qa] Issues: {qa_data.get('issues')}", file=sys.stderr)

    record = {
        **sig,
        "output_mp4": str(out_mp4),
        "latest_mp4": str(latest_mp4) if mirror_latest else None,
        "words_json": str(words_json),
        "cuts_json": str(cuts_json),
        "qa_report": str(qa_report_path) if qa_report_path.is_file() else None,
        "qa_verdict": qa_verdict,
        "nle_exports": nle_exports,
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


def watch_folder(**kwargs: object) -> None:
    interval = float(kwargs.pop("interval", 2.0))
    print(f"[watch] Watching {RAW_DIR} every {interval:.1f}s. Press Ctrl+C to stop.")
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
                stable_checks = (last[2] + 1) if (last and last[0] == sig["size_bytes"] and last[1] == sig["mtime_ns"]) else 1
                pending_sigs[clip.name] = (sig["size_bytes"], sig["mtime_ns"], stable_checks)

                if stable_checks >= 2:
                    pending_sigs.pop(clip.name, None)
                    try:
                        process_clip(clip, force=False, **kwargs)  # type: ignore[arg-type]
                    except Exception as exc:
                        print(f"[error] Failed auto-editing {clip.name}: {exc}", file=sys.stderr)

            time.sleep(interval)
    except KeyboardInterrupt:
        print("\n[watch] Stopped.")


def main() -> None:
    parser = argparse.ArgumentParser(description="Pro automated AI talking-head video editor.")
    parser.add_argument("clip", nargs="?", help="Optional specific raw video file (defaults to unprocessed files in raw/).")
    parser.add_argument("--url", default=None, help="Download clip via yt-dlp into raw/ and auto-edit it immediately.")
    parser.add_argument("--section", default=None, help="Optional yt-dlp trim section with --url, e.g. '00:10-01:00'.")
    parser.add_argument("--watch", action="store_true", help="Continuously watch raw/ and auto-edit new clips.")
    parser.add_argument("--interval", type=float, default=2.0, help="Watcher polling interval in seconds.")
    parser.add_argument("--mode", choices=["auto", "claude", "gemini", "offline"], default="auto")
    parser.add_argument("--language", default=None, help="Optional ISO language hint for WhisperX.")
    parser.add_argument("--diarize", action="store_true", help="Enable WhisperX speaker diarization (requires HF_TOKEN).")
    parser.add_argument("--speaker", default=None, help="Keep only one speaker ID when --diarize is enabled.")
    parser.add_argument("--polish", choices=["none", "fast", "studio"], default="fast", help="Audio polish: none, fast (FFmpeg -14 LUFS), studio (ClearerVoice-Studio + -14 LUFS).")
    parser.add_argument("--no-refine", action="store_true", help="Disable PCM waveform boundary snapping.")
    parser.add_argument("--captions", choices=["none", "karaoke", "minimal"], default="none", help="Generate & burn in edited-timeline captions.")
    parser.add_argument("--punch-in", type=float, default=1.0, help="Alternating punch-in zoom scale on jump cuts (e.g. 1.08).")
    parser.add_argument("--look", choices=["none", "natural", "warm", "cinematic", "punchy"], default="none")
    parser.add_argument("--lut", default=None, help="Optional .cube 3D LUT file.")
    parser.add_argument("--bgm", default=None, help="Optional BGM path or 'auto' (sidechain-ducked under voice).")
    parser.add_argument("--bgm-vol", type=float, default=0.14)
    parser.add_argument("--audio-fade-ms", type=float, default=12.0, help="Micro audio fade at cut edges (default: 12ms).")
    parser.add_argument("--platform", choices=["native", "tiktok", "reels", "shorts", "youtube", "ig_feed", "square"], default="native")
    parser.add_argument("--motion-gfx", action="store_true", help="Add HyperFrames animated hook intro & CTA outro.")
    parser.add_argument("--broll-plan", action="store_true", help="Generate Higgsfield AI B-roll cue sheet (broll_plan.json).")
    parser.add_argument("--broll-generate", action="store_true", help="Generate planned B-roll clips via Higgsfield Cloud API.")
    parser.add_argument("--broll-manifest", default=None, help="Existing broll_plan.json with local_path clips to composite.")
    parser.add_argument("--broll-style", choices=["cutaway", "pip"], default="cutaway")
    parser.add_argument("--broll-model", default="kling", help="Default Higgsfield B-roll model preset.")
    parser.add_argument("--export-nle", default="", help="Comma-separated NLE exports: fcpxml,edl,cutflow.")
    parser.add_argument("--no-verify", action="store_true", help="Skip automated Edit QA report.")
    parser.add_argument("--script-check", action="store_true", help="Re-transcribe cut.mp4 with WhisperX to prove script playback.")
    parser.add_argument("--review", action="store_true", help="Pause after cuts.json and ask for approval before rendering.")
    parser.add_argument("--force", action="store_true", help="Re-process even if already recorded in .processed.json.")
    args = parser.parse_args()

    nle_list = [x.strip() for x in args.export_nle.split(",") if x.strip()]
    common_kwargs = dict(
        mode=args.mode,
        language=args.language,
        diarize=args.diarize,
        speaker=args.speaker,
        polish=args.polish,
        refine_waveform=not args.no_refine,
        captions=args.captions,
        punch_in=args.punch_in,
        look=args.look,
        lut=args.lut,
        bgm=args.bgm,
        bgm_vol=args.bgm_vol,
        audio_fade_ms=args.audio_fade_ms,
        platform=args.platform,
        motion_gfx=args.motion_gfx,
        broll_plan=args.broll_plan,
        broll_generate=args.broll_generate,
        broll_manifest=args.broll_manifest,
        broll_style=args.broll_style,
        broll_model=args.broll_model,
        export_nle=nle_list,
        verify=not args.no_verify,
        script_check=args.script_check,
        review=args.review,
    )

    if args.url:
        ing_cmd = [sys.executable, str(SCRIPTS_DIR / "ingest_url.py"), args.url, "--out-dir", str(RAW_DIR)]
        if args.section:
            ing_cmd += ["--section", args.section]
        proc = subprocess.run(ing_cmd, check=True, capture_output=True, text=True)
        meta = json.loads(proc.stdout)
        print(f"[yt-dlp] Downloaded -> {meta['path']}")
        process_clip(Path(meta["path"]), force=args.force, **common_kwargs)
        return

    if args.watch:
        watch_folder(interval=args.interval, **common_kwargs)
        return

    if args.clip:
        process_clip(Path(args.clip), force=args.force, **common_kwargs)
        return

    clips = list_raw_videos()
    if not clips:
        print(f"No video files in {RAW_DIR}. Drop a talking-head clip into raw/, pass --url <URL>, or run with --watch.")
        return

    for clip in clips:
        process_clip(clip, force=args.force, **common_kwargs)


if __name__ == "__main__":
    main()
