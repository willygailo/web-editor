#!/usr/bin/env python3
"""Probe raw footage, snap transcript/cuts.json to whole frames, and build/verify outputs."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from fractions import Fraction
from pathlib import Path
from urllib.parse import quote
from xml.sax.saxutils import escape

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

VIDEO_EXTS = {".mp4", ".mov", ".mkv", ".m4v", ".avi", ".webm", ".mts", ".m2ts"}
ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "raw"
CUTS_JSON = ROOT / "transcript" / "cuts.json"


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
        sys.exit(f"ERROR: No video clip found in {RAW_DIR}.")
    if len(candidates) > 1:
        names = ", ".join(p.name for p in candidates)
        sys.exit(f"ERROR: Multiple clips in {RAW_DIR} ({names}). Pass the target file path explicitly.")
    return candidates[0]


def run_ffprobe(media_path: Path, count_frames: bool = False) -> dict:
    cmd = ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams"]
    if count_frames:
        cmd.append("-count_frames")
    cmd.append(str(media_path))
    proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return json.loads(proc.stdout)


def parse_rotation(video_stream: dict) -> int:
    tags = video_stream.get("tags") or {}
    if "rotate" in tags:
        try:
            return int(float(tags["rotate"])) % 360
        except ValueError:
            pass
    for sd in video_stream.get("side_data_list") or []:
        if "rotation" in sd:
            try:
                return int(float(sd["rotation"])) % 360
            except ValueError:
                pass
    return 0


def parse_timecode(probe: dict, video_stream: dict) -> str | None:
    for container in (video_stream.get("tags") or {}, (probe.get("format") or {}).get("tags") or {}):
        for k, v in container.items():
            if k.lower() == "timecode" and v:
                return str(v)
    return None


def probe_media(media_path: Path, count_frames: bool = False) -> dict:
    data = run_ffprobe(media_path, count_frames=count_frames)
    streams = data.get("streams", [])
    v_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    a_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not v_stream:
        sys.exit(f"ERROR: No video stream found in {media_path}")

    r_fps = Fraction(v_stream.get("r_frame_rate", "0/1"))
    avg_fps_str = v_stream.get("avg_frame_rate", "0/1")
    avg_fps = Fraction(avg_fps_str) if avg_fps_str != "0/0" else r_fps
    fps = avg_fps if avg_fps > 0 else r_fps
    is_cfr = r_fps > 0 and avg_fps > 0 and abs(float(r_fps - avg_fps)) / float(r_fps) < 0.002

    width = int(v_stream["width"])
    height = int(v_stream["height"])
    rotation = parse_rotation(v_stream)
    display_w, display_h = (height, width) if rotation in (90, 270) else (width, height)
    orientation = "vertical" if display_h > display_w else ("square" if display_h == display_w else "horizontal")

    duration = float((data.get("format") or {}).get("duration") or v_stream.get("duration") or 0.0)
    nb_frames_raw = v_stream.get("nb_read_frames") or v_stream.get("nb_frames")
    nb_frames = int(nb_frames_raw) if nb_frames_raw and str(nb_frames_raw).isdigit() else round(duration * float(fps))

    return {
        "path": str(media_path),
        "width": width,
        "height": height,
        "rotation": rotation,
        "display_width": display_w,
        "display_height": display_h,
        "orientation": orientation,
        "r_frame_rate": f"{r_fps.numerator}/{r_fps.denominator}",
        "avg_frame_rate": f"{avg_fps.numerator}/{avg_fps.denominator}",
        "fps_fraction": f"{fps.numerator}/{fps.denominator}",
        "fps_float": float(fps),
        "is_cfr": is_cfr,
        "duration": duration,
        "nb_frames": nb_frames,
        "timecode": parse_timecode(data, v_stream),
        "has_audio": a_stream is not None,
        "audio_sample_rate": int(a_stream["sample_rate"]) if a_stream and a_stream.get("sample_rate") else None,
        "audio_channels": int(a_stream["channels"]) if a_stream and a_stream.get("channels") else None,
    }


def load_cuts(cuts_path: Path) -> list[dict]:
    if not cuts_path.is_file():
        sys.exit(f"ERROR: Cut list not found: {cuts_path}")
    data = json.loads(cuts_path.read_text(encoding="utf-8"))
    segs = data.get("segments")
    if not isinstance(segs, list) or not segs:
        sys.exit(f"ERROR: {cuts_path} must contain a non-empty 'segments' list.")
    return segs


def snap_segments(segs: list[dict], fps: Fraction, max_frames: int) -> list[dict]:
    snapped: list[dict] = []
    prev_end = 0
    for i, seg in enumerate(segs):
        start_s = float(seg["start"])
        end_s = float(seg["end"])
        if end_s <= start_s:
            sys.exit(f"ERROR: Segment {i} has end <= start ({start_s} -> {end_s})")

        sf = max(0, round(start_s * float(fps)))
        ef = min(max_frames, round(end_s * float(fps)))
        if sf < prev_end:
            sf = prev_end
        if ef <= sf:
            sys.exit(f"ERROR: Segment {i} collapsed to <= 0 frames after snapping ({sf} -> {ef})")

        frames = ef - sf
        snapped.append({
            "index": i,
            "start_frame": sf,
            "end_frame": ef,  # exclusive
            "frames": frames,
            "start_sec": float(Fraction(sf, 1) / fps),
            "end_sec": float(Fraction(ef, 1) / fps),
            "duration_sec": float(Fraction(frames, 1) / fps),
            "text": seg.get("text", ""),
        })
        prev_end = ef
    return snapped


def cmd_probe(args: argparse.Namespace) -> None:
    raw = find_raw_clip(args.raw_clip)
    info = probe_media(raw, count_frames=args.count_frames)
    print(json.dumps(info, indent=2))


def cmd_validate(args: argparse.Namespace) -> None:
    raw = find_raw_clip(args.raw_clip)
    info = probe_media(raw, count_frames=False)
    fps = Fraction(args.fps) if args.fps else Fraction(info["fps_fraction"])
    segs = load_cuts(Path(args.cuts))
    snapped = snap_segments(segs, fps, info["nb_frames"])
    total_frames = sum(s["frames"] for s in snapped)
    total_sec = float(Fraction(total_frames, 1) / fps)
    summary = {
        "raw": info["path"],
        "fps": f"{fps.numerator}/{fps.denominator}",
        "clip_count": len(snapped),
        "total_frames": total_frames,
        "total_duration_sec": round(total_sec, 4),
        "clips": snapped,
    }
    print(json.dumps(summary, indent=2))


PLATFORM_SPECS: dict[str, dict[str, int | str]] = {
    "tiktok": {"width": 1080, "height": 1920, "crf": 18, "audio_bitrate": "192k"},
    "reels": {"width": 1080, "height": 1920, "crf": 18, "audio_bitrate": "192k"},
    "shorts": {"width": 1080, "height": 1920, "crf": 18, "audio_bitrate": "192k"},
    "ig_feed": {"width": 1080, "height": 1350, "crf": 18, "audio_bitrate": "192k"},
    "youtube": {"width": 1920, "height": 1080, "crf": 17, "audio_bitrate": "256k"},
    "square": {"width": 1080, "height": 1080, "crf": 18, "audio_bitrate": "192k"},
}

COLOR_LOOK_FILTERS: dict[str, str] = {
    "none": "",
    "natural": "eq=contrast=1.04:saturation=1.08:brightness=0.01",
    "warm": "eq=contrast=1.06:saturation=1.12:brightness=0.02,colorbalance=rs=0.05:gs=0.01:bs=-0.04",
    "cinematic": "eq=contrast=1.12:saturation=0.94:brightness=-0.01,colorbalance=rs=0.03:gs=0.0:bs=0.04",
    "punchy": "eq=contrast=1.10:saturation=1.20:brightness=0.01",
}


def escape_ffmpeg_filter_path(p: Path) -> str:
    return str(p).replace("\\", "/").replace(":", "\\:").replace("'", "\\'")


def resolve_bgm_path(bgm_arg: str | None) -> Path | None:
    if not bgm_arg or bgm_arg == "none":
        return None
    if bgm_arg == "auto":
        builtins = ROOT / "data" / "builtins"
        for candidate in (
            builtins / "builtin-beat-chill-92.m4a",
            builtins / "builtin-beat-hype-128.m4a",
            builtins / "builtin-beat-flash-135.m4a",
        ):
            if candidate.is_file():
                return candidate
        return None
    p = Path(bgm_arg).expanduser().resolve()
    return p if p.is_file() else None


def cmd_render_mp4(args: argparse.Namespace) -> None:
    raw = find_raw_clip(args.raw_clip)
    info = probe_media(raw, count_frames=False)
    fps = Fraction(info["fps_fraction"])
    segs = load_cuts(Path(args.cuts))
    snapped = snap_segments(segs, fps, info["nb_frames"])
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    polished_audio = Path(args.polished_audio).expanduser().resolve() if getattr(args, "polished_audio", None) else None
    if polished_audio and not polished_audio.is_file():
        sys.exit(f"ERROR: Polished audio file not found: {polished_audio}")

    bgm_path = resolve_bgm_path(getattr(args, "bgm", None))
    bgm_vol = float(getattr(args, "bgm_vol", 0.14))
    audio_fade_ms = max(0.0, float(getattr(args, "audio_fade_ms", 0.0)))
    punch_in = float(getattr(args, "punch_in", 1.0))
    look = str(getattr(args, "look", "none") or "none")
    lut_path = Path(args.lut).expanduser().resolve() if getattr(args, "lut", None) else None
    captions_ass = Path(args.captions).expanduser().resolve() if getattr(args, "captions", None) else None
    platform = str(getattr(args, "platform", "native") or "native")
    intro_clip = Path(args.intro).expanduser().resolve() if getattr(args, "intro", None) else None
    outro_clip = Path(args.outro).expanduser().resolve() if getattr(args, "outro", None) else None
    broll_manifest_path = Path(args.broll_manifest).expanduser().resolve() if getattr(args, "broll_manifest", None) else None
    broll_style_override = getattr(args, "broll_style", None)

    broll_cues: list[dict] = []
    if broll_manifest_path and broll_manifest_path.is_file():
        manifest_data = json.loads(broll_manifest_path.read_text(encoding="utf-8"))
        for cue in manifest_data.get("cues") or []:
            lp = cue.get("local_path")
            if lp and Path(str(lp)).expanduser().is_file():
                broll_cues.append(
                    {
                        "path": Path(str(lp)).expanduser().resolve(),
                        "start": max(0.0, float(cue.get("timeline_start_sec", 0.0))),
                        "duration": max(0.4, float(cue.get("duration_sec", 2.5))),
                        "style": str(broll_style_override or cue.get("style") or "cutaway").lower(),
                    }
                )

    target_w = info["display_width"]
    target_h = info["display_height"]
    crf = 18
    audio_bitrate = "192k"
    if platform in PLATFORM_SPECS:
        spec = PLATFORM_SPECS[platform]
        target_w = int(spec["width"])
        target_h = int(spec["height"])
        crf = int(spec["crf"])
        audio_bitrate = str(spec["audio_bitrate"])

    has_audio = info["has_audio"] or (polished_audio is not None)
    input_args: list[str] = ["-i", str(raw)]
    next_input_idx = 1
    audio_in_idx = 0

    if polished_audio:
        input_args += ["-i", str(polished_audio)]
        audio_in_idx = next_input_idx
        next_input_idx += 1

    bgm_in_idx: int | None = None
    if bgm_path:
        input_args += ["-stream_loop", "-1", "-i", str(bgm_path)]
        bgm_in_idx = next_input_idx
        next_input_idx += 1

    intro_in_idx: int | None = None
    if intro_clip and intro_clip.is_file():
        input_args += ["-i", str(intro_clip)]
        intro_in_idx = next_input_idx
        next_input_idx += 1

    outro_in_idx: int | None = None
    if outro_clip and outro_clip.is_file():
        input_args += ["-i", str(outro_clip)]
        outro_in_idx = next_input_idx
        next_input_idx += 1

    broll_inputs: list[tuple[int, dict]] = []
    img_exts = {".png", ".jpg", ".jpeg", ".webp"}
    for cue in broll_cues:
        if cue["path"].suffix.lower() in img_exts:
            input_args += ["-loop", "1", "-t", f"{cue['duration']:.3f}", "-i", str(cue["path"])]
        else:
            input_args += ["-stream_loop", "-1", "-i", str(cue["path"])]
        broll_inputs.append((next_input_idx, cue))
        next_input_idx += 1

    filter_parts: list[str] = []
    concat_inputs: list[str] = []
    fade_s = audio_fade_ms / 1000.0

    for i, clip in enumerate(snapped):
        if info["is_cfr"]:
            v_chain = f"[0:v]trim=start_frame={clip['start_frame']}:end_frame={clip['end_frame']},setpts=PTS-STARTPTS"
        else:
            v_chain = f"[0:v]trim=start={clip['start_sec']:.9f}:end={clip['end_sec']:.9f},setpts=PTS-STARTPTS"

        # Alternating subtle punch-in zoom on odd jump-cut segments to mask visual jumps
        if punch_in > 1.005 and (i % 2 == 1):
            cw = max(2, int(round(info["display_width"] / punch_in)) & ~1)
            ch = max(2, int(round(info["display_height"] / punch_in)) & ~1)
            cx = max(0, (info["display_width"] - cw) // 2)
            cy = max(0, int((info["display_height"] - ch) * 0.35))
            v_chain += f",crop={cw}:{ch}:{cx}:{cy},scale={info['display_width']}:{info['display_height']}:flags=lanczos,setsar=1"
        elif punch_in > 1.005:
            v_chain += ",setsar=1"

        filter_parts.append(f"{v_chain}[v{i}]")

        if has_audio:
            a_chain = f"[{audio_in_idx}:a]atrim=start={clip['start_sec']:.9f}:end={clip['end_sec']:.9f},asetpts=PTS-STARTPTS"
            if fade_s > 0.001 and clip["duration_sec"] > fade_s * 2.5:
                fade_out_st = max(0.0, clip["duration_sec"] - fade_s)
                a_chain += f",afade=t=in:st=0:d={fade_s:.4f},afade=t=out:st={fade_out_st:.4f}:d={fade_s:.4f}"
            filter_parts.append(f"{a_chain}[a{i}]")
            concat_inputs.append(f"[v{i}][a{i}]")
        else:
            concat_inputs.append(f"[v{i}]")

    a_count = 1 if has_audio else 0
    filter_parts.append(
        f"{''.join(concat_inputs)}concat=n={len(snapped)}:v=1:a={a_count}[basev]" + ("[basea]" if has_audio else "")
    )

    v_label = "basev"
    v_post: list[str] = []
    if target_w != info["display_width"] or target_h != info["display_height"]:
        v_post.append(
            f"scale={target_w}:{target_h}:force_original_aspect_ratio=increase,crop={target_w}:{target_h},setsar=1"
        )
    if look in COLOR_LOOK_FILTERS and COLOR_LOOK_FILTERS[look]:
        v_post.append(COLOR_LOOK_FILTERS[look])
    if lut_path and lut_path.is_file():
        v_post.append(f"lut3d=file='{escape_ffmpeg_filter_path(lut_path)}'")

    if v_post:
        filter_parts.append(f"[{v_label}]{','.join(v_post)}[gradedv]")
        v_label = "gradedv"

    # Composite Higgsfield / external B-roll cutaways or PiP cards over video (dialogue audio stays continuous)
    for b_idx, (in_idx, cue) in enumerate(broll_inputs):
        b_start = cue["start"]
        b_dur = cue["duration"]
        b_end = b_start + b_dur
        if cue["style"] == "pip":
            pip_w = max(64, int(round(target_w * 0.38)) & ~1)
            pip_h = max(64, int(round(target_h * 0.28)) & ~1)
            ox = max(12, target_w - pip_w - int(round(target_w * 0.04)))
            oy = max(12, int(round(target_h * 0.08)))
            filter_parts.append(
                f"[{in_idx}:v]trim=start=0:duration={b_dur:.4f},"
                f"scale={pip_w}:{pip_h}:force_original_aspect_ratio=increase,crop={pip_w}:{pip_h},"
                f"pad={pip_w + 6}:{pip_h + 6}:3:3:color=white@0.9,"
                f"fps={fps.numerator}/{fps.denominator},setsar=1,"
                f"setpts=PTS-STARTPTS+{b_start:.4f}/TB[br{b_idx}]"
            )
            filter_parts.append(
                f"[{v_label}][br{b_idx}]overlay=x={ox}:y={oy}:enable='between(t,{b_start:.4f},{b_end:.4f})':eof_action=pass[bov{b_idx}]"
            )
        else:
            filter_parts.append(
                f"[{in_idx}:v]trim=start=0:duration={b_dur:.4f},"
                f"scale={target_w}:{target_h}:force_original_aspect_ratio=increase,crop={target_w}:{target_h},"
                f"fps={fps.numerator}/{fps.denominator},setsar=1,"
                f"setpts=PTS-STARTPTS+{b_start:.4f}/TB[br{b_idx}]"
            )
            filter_parts.append(
                f"[{v_label}][br{b_idx}]overlay=x=0:y=0:enable='between(t,{b_start:.4f},{b_end:.4f})':eof_action=pass[bov{b_idx}]"
            )
        v_label = f"bov{b_idx}"

    # Burn captions AFTER B-roll so subtitles stay crisp on top of cutaways
    if captions_ass and captions_ass.is_file():
        filter_parts.append(f"[{v_label}]ass='{escape_ffmpeg_filter_path(captions_ass)}'[capv]")
        v_label = "capv"

    a_label = "basea" if has_audio else None
    if has_audio and bgm_in_idx is not None:
        total_dur_est = sum(c["duration_sec"] for c in snapped)
        fade_out_bgm = max(0.0, total_dur_est - 1.2)
        filter_parts.append(
            f"[{bgm_in_idx}:a]atrim=0:{total_dur_est:.4f},asetpts=PTS-STARTPTS,"
            f"volume={bgm_vol:.3f},afade=t=in:st=0:d=0.6,afade=t=out:st={fade_out_bgm:.4f}:d=1.2[bgm_trimmed]"
        )
        filter_parts.append(f"[{a_label}]asplit=2[voice_mix][voice_sc]")
        filter_parts.append(
            "[bgm_trimmed][voice_sc]sidechaincompress=threshold=0.03:ratio=5:attack=15:release=250[bgm_ducked]"
        )
        filter_parts.append("[voice_mix][bgm_ducked]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[mixa]")
        a_label = "mixa"

    # Optional HyperFrames intro / outro concatenation
    if intro_in_idx is not None or outro_in_idx is not None:
        bookends: list[str] = []
        if intro_in_idx is not None:
            filter_parts.append(
                f"[{intro_in_idx}:v]scale={target_w}:{target_h}:force_original_aspect_ratio=increase,"
                f"crop={target_w}:{target_h},fps={fps.numerator}/{fps.denominator},setsar=1[introv]"
            )
            if has_audio:
                filter_parts.append(f"anullsrc=r=48000:cl=stereo[introsil]")
                intro_info = probe_media(intro_clip, count_frames=False)
                filter_parts.append(f"[introsil]atrim=0:{intro_info['duration']:.4f},asetpts=PTS-STARTPTS[introa]")
                bookends.append("[introv][introa]")
            else:
                bookends.append("[introv]")
        bookends.append(f"[{v_label}][{a_label}]" if has_audio else f"[{v_label}]")
        if outro_in_idx is not None:
            filter_parts.append(
                f"[{outro_in_idx}:v]scale={target_w}:{target_h}:force_original_aspect_ratio=increase,"
                f"crop={target_w}:{target_h},fps={fps.numerator}/{fps.denominator},setsar=1[outrov]"
            )
            if has_audio:
                outro_info = probe_media(outro_clip, count_frames=False)
                filter_parts.append(f"anullsrc=r=48000:cl=stereo[outrosil]")
                filter_parts.append(f"[outrosil]atrim=0:{outro_info['duration']:.4f},asetpts=PTS-STARTPTS[outroa]")
                bookends.append("[outrov][outroa]")
            else:
                bookends.append("[outrov]")
        filter_parts.append(
            f"{''.join(bookends)}concat=n={len(bookends)}:v=1:a={a_count}[outv]" + ("[outa]" if has_audio else "")
        )
        v_label = "outv"
        a_label = "outa" if has_audio else None

    filtergraph = ";".join(filter_parts)

    cmd = [
        "ffmpeg",
        "-y",
        *input_args,
        "-filter_complex",
        filtergraph,
        "-map",
        f"[{v_label}]",
    ]
    if has_audio and a_label:
        cmd += ["-map", f"[{a_label}]"]
    cmd += [
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        str(crf),
        "-pix_fmt",
        "yuv420p",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-colorspace",
        "bt709",
        "-fps_mode",
        "passthrough",
    ]
    if has_audio:
        cmd += ["-c:a", "aac", "-b:a", audio_bitrate, "-ar", "48000"]
    cmd += ["-movflags", "+faststart", str(out_path)]

    print(f"[ffmpeg] Rendering {len(snapped)} segments -> {out_path}")
    subprocess.run(cmd, check=True)

    # Frame-for-frame verification
    expected_frames = sum(c["frames"] for c in snapped)
    expected_dur = float(Fraction(expected_frames, 1) / fps)
    out_info = probe_media(out_path, count_frames=True)

    report = {
        "output": str(out_path),
        "clip_count": len(snapped),
        "expected_frames": expected_frames,
        "actual_frames": out_info["nb_frames"],
        "frame_diff": out_info["nb_frames"] - expected_frames,
        "expected_duration_sec": round(expected_dur, 4),
        "actual_duration_sec": round(out_info["duration"], 4),
        "duration_diff_sec": round(out_info["duration"] - expected_dur, 4),
        "expected_dimensions": f"{target_w}x{target_h} ({'vertical' if target_h > target_w else ('square' if target_h == target_w else 'horizontal')})",
        "actual_dimensions": f"{out_info['display_width']}x{out_info['display_height']} ({out_info['orientation']})",
        "raw_fps": info["fps_fraction"],
        "output_fps": out_info["fps_fraction"],
        "platform": platform,
        "look": look,
        "punch_in": punch_in,
        "has_bgm": bgm_in_idx is not None,
        "has_captions": bool(captions_ass and captions_ass.is_file()),
        "broll_cues_composited": len(broll_inputs),
    }
    print(json.dumps(report, indent=2))
    if out_info["display_width"] != target_w or out_info["display_height"] != target_h:
        sys.exit("ERROR: Output dimensions do not match target display dimensions!")


def timecode_to_frames(tc: str, fps_int: int) -> int:
    clean = tc.replace(";", ":")
    hh, mm, ss, ff = [int(x) for x in clean.split(":")]
    return ((hh * 3600) + (mm * 60) + ss) * fps_int + ff


def fmt_rational(frames: int, fps: Fraction) -> str:
    # frames / fps = frames * fps.denominator / fps.numerator
    val = Fraction(frames, 1) / fps
    if val == 0:
        return "0s"
    return f"{val.numerator}/{val.denominator}s"


def cmd_fcpxml(args: argparse.Namespace) -> None:
    raw = find_raw_clip(args.raw_clip)
    info = probe_media(raw, count_frames=False)
    fps = Fraction(info["fps_fraction"])
    segs = load_cuts(Path(args.cuts))
    snapped = snap_segments(segs, fps, info["nb_frames"])
    out_path = Path(args.out).resolve()
    bundle_path = (ROOT / f"{raw.stem}_starter.fcpbundle").resolve()

    tc_frames = 0
    if info["timecode"]:
        tc_frames = timecode_to_frames(info["timecode"], round(float(fps)))

    frame_dur = fmt_rational(1, fps)
    asset_start = fmt_rational(tc_frames, fps)
    asset_dur = fmt_rational(info["nb_frames"], fps)
    total_frames = sum(c["frames"] for c in snapped)
    seq_dur = fmt_rational(total_frames, fps)
    src_uri = "file://" + quote(str(raw))
    lib_uri = "file://" + quote(str(bundle_path))

    clips_xml: list[str] = []
    offset_frames = 0
    for i, c in enumerate(snapped):
        clip_start = fmt_rational(tc_frames + c["start_frame"], fps)
        clip_dur = fmt_rational(c["frames"], fps)
        clip_offset = fmt_rational(offset_frames, fps)
        clips_xml.append(
            f'            <asset-clip ref="r2" offset="{clip_offset}" '
            f'name="{escape(raw.stem)}_{i + 1:02d}" start="{clip_start}" '
            f'duration="{clip_dur}" audioRole="dialogue"/>'
        )
        offset_frames += c["frames"]

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="{args.version}">
  <import-options>
    <option key="library location" value="{escape(lib_uri)}"/>
    <option key="copy assets" value="0"/>
    <option key="suppress warnings" value="1"/>
  </import-options>
  <resources>
    <format id="r1" name="FFVideoFormatRateUndefined" frameDuration="{frame_dur}" width="{info['display_width']}" height="{info['display_height']}"/>
    <asset id="r2" name="{escape(raw.stem)}" start="{asset_start}" duration="{asset_dur}" hasVideo="1" format="r1" hasAudio="{'1' if info['has_audio'] else '0'}" audioSources="{'1' if info['has_audio'] else '0'}" audioChannels="{info['audio_channels'] or 2}" audioRate="{info['audio_sample_rate'] or 48000}">
      <media-rep kind="original-media" src="{escape(src_uri)}"/>
    </asset>
  </resources>
  <library>
    <event name="Starter Cut">
      <project name="{escape(raw.stem)} Cut">
        <sequence format="r1" duration="{seq_dur}" tcStart="0s" tcFormat="NDF">
          <spine>
{chr(10).join(clips_xml)}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
"""
    out_path.write_text(xml, encoding="utf-8")
    print(f"[done] Wrote {len(snapped)} frame-snapped clips ({total_frames} frames) -> {out_path}")


def frames_to_smpte(frames: int, fps_int: int) -> str:
    safe = max(0, frames)
    ff = safe % fps_int
    total_sec = safe // fps_int
    ss = total_sec % 60
    mm = (total_sec // 60) % 60
    hh = total_sec // 3600
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"


def cmd_edl(args: argparse.Namespace) -> None:
    """Export CMX 3600 EDL for DaVinci Resolve Free/Studio, Premiere Pro, and universal NLE import."""
    raw = find_raw_clip(args.raw_clip)
    info = probe_media(raw, count_frames=False)
    fps = Fraction(info["fps_fraction"])
    fps_int = max(1, round(float(fps)))
    segs = load_cuts(Path(args.cuts))
    snapped = snap_segments(segs, fps, info["nb_frames"])
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    tc_frames = timecode_to_frames(info["timecode"], fps_int) if info["timecode"] else 0
    rec_base = 3600 * fps_int  # standard 01:00:00:00 timeline start
    rec_cursor = rec_base

    lines = [
        f"TITLE: {raw.stem}_CUT",
        "FCM: NON-DROP FRAME",
        "",
    ]
    for idx, c in enumerate(snapped, 1):
        src_in = frames_to_smpte(tc_frames + c["start_frame"], fps_int)
        src_out = frames_to_smpte(tc_frames + c["end_frame"], fps_int)
        rec_in = frames_to_smpte(rec_cursor, fps_int)
        rec_out = frames_to_smpte(rec_cursor + c["frames"], fps_int)
        rec_cursor += c["frames"]
        lines.append(f"{idx:03d}  AX       AA/V  C        {src_in} {src_out} {rec_in} {rec_out}")
        lines.append(f"* FROM CLIP NAME: {raw.name}")
        if c.get("text"):
            clean_comment = str(c["text"]).replace("\n", " ")[:72]
            lines.append(f"* COMMENT: {clean_comment}")
        lines.append("")

    out_path.write_text("\n".join(lines), encoding="utf-8")
    print(f"[done] Wrote CMX 3600 EDL ({len(snapped)} events) -> {out_path}")


def cmd_cutflow(args: argparse.Namespace) -> None:
    """Export a CutFlow AI .cutflow.json timeline blueprint with real trimmable clips."""
    raw = find_raw_clip(args.raw_clip)
    info = probe_media(raw, count_frames=False)
    fps = Fraction(info["fps_fraction"])
    segs = load_cuts(Path(args.cuts))
    snapped = snap_segments(segs, fps, info["nb_frames"])
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    ratio = info["display_width"] / max(1, info["display_height"])
    aspect = "9:16" if ratio < 0.72 else ("4:5" if ratio < 0.92 else ("1:1" if ratio <= 1.15 else "16:9"))
    asset_id = args.asset_id or raw.stem
    punch_in = float(getattr(args, "punch_in", 1.0))

    clips = []
    for idx, c in enumerate(snapped, 1):
        slot: dict = {
            "id": f"th-cli-{idx}",
            "assetId": asset_id,
            "sourceStartSec": round(c["start_sec"], 3),
            "sourceEndSec": round(c["end_sec"], 3),
            "speed": 1,
            "motion": "none",
            "transitionIn": "cut",
            "transitionDurationSec": 0,
            "filter": "none",
            "muteOriginalAudio": False,
            "volume": 1,
            "reversed": False,
            "label": str(c.get("text", "")).strip()[:48] or f"Take {idx}",
        }
        if punch_in > 1.005 and idx % 2 == 0:
            slot["transform"] = {"scale": round(punch_in, 2), "offsetX": 0, "offsetY": -0.04, "rotationDeg": 0}
        clips.append(slot)

    total_sec = round(sum(c["duration_sec"] for c in snapped), 3)
    project = {
        "version": 1,
        "sourceClip": str(raw),
        "project": {
            "id": f"proj-cli-{raw.stem}",
            "title": f"{raw.stem} (Pro Auto Cut)"[:120],
            "templateId": "talking-head-auto",
            "promptUsed": "Pro AI Talking-Head Auto-Cut",
            "modeUsed": "offline",
            "aspectRatio": aspect,
            "fps": max(24, min(60, round(float(fps)))),
            "targetDurationSec": min(180.0, max(0.4, total_sec)),
            "clips": clips,
            "overlays": [],
            "stickers": [],
            "audioTracks": [],
        },
    }
    out_path.write_text(json.dumps(project, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"[done] Wrote CutFlow JSON ({len(clips)} trimmable clips) -> {out_path}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Probe footage, validate cuts, and build outputs.")
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_probe = sub.add_parser("probe", help="Inspect raw clip metadata with ffprobe.")
    p_probe.add_argument("raw_clip", nargs="?")
    p_probe.add_argument("--count-frames", action="store_true")
    p_probe.set_defaults(func=cmd_probe)

    p_val = sub.add_parser("validate-cuts", help="Validate cuts.json and print frame-snapped schedule.")
    p_val.add_argument("raw_clip", nargs="?")
    p_val.add_argument("--cuts", default=str(CUTS_JSON))
    p_val.add_argument("--fps", default=None, help="Override FPS rational/float (e.g. from Resolve clip property).")
    p_val.set_defaults(func=cmd_validate)

    p_mp4 = sub.add_parser("render-mp4", help="Render single-pass MP4 with -fps_mode passthrough, optional finishing, and verify.")
    p_mp4.add_argument("raw_clip", nargs="?")
    p_mp4.add_argument("--cuts", default=str(CUTS_JSON))
    p_mp4.add_argument("--out", default=str(ROOT / "cut.mp4"))
    p_mp4.add_argument("--polished-audio", default=None, help="Optional polished 48 kHz WAV replacing raw audio before trimming.")
    p_mp4.add_argument("--audio-fade-ms", type=float, default=0.0, help="Micro audio fade-in/out per cut in ms (e.g. 12).")
    p_mp4.add_argument("--punch-in", type=float, default=1.0, help="Alternating jump-cut punch-in zoom scale (e.g. 1.08).")
    p_mp4.add_argument("--look", choices=list(COLOR_LOOK_FILTERS.keys()), default="none", help="Color look preset.")
    p_mp4.add_argument("--lut", default=None, help="Optional .cube 3D LUT file path.")
    p_mp4.add_argument("--captions", default=None, help="Optional .ass subtitles file to burn in.")
    p_mp4.add_argument("--bgm", default=None, help="Optional BGM path or 'auto' (uses built-in track with voice ducking).")
    p_mp4.add_argument("--bgm-vol", type=float, default=0.14, help="BGM base volume before sidechain ducking.")
    p_mp4.add_argument("--platform", choices=["native", *PLATFORM_SPECS.keys()], default="native", help="Locked platform export spec.")
    p_mp4.add_argument("--intro", default=None, help="Optional HyperFrames rendered intro MP4.")
    p_mp4.add_argument("--outro", default=None, help="Optional HyperFrames rendered outro MP4.")
    p_mp4.add_argument("--broll-manifest", default=None, help="Optional broll_plan.json with local_path clips to overlay as cutaways/PiP.")
    p_mp4.add_argument("--broll-style", choices=["cutaway", "pip"], default=None, help="Optional global override for B-roll overlay style.")
    p_mp4.set_defaults(func=cmd_render_mp4)

    p_fcp = sub.add_parser("fcpxml", help="Export frame-snapped FCPXML for Final Cut Pro / DaVinci Resolve.")
    p_fcp.add_argument("raw_clip", nargs="?")
    p_fcp.add_argument("--cuts", default=str(CUTS_JSON))
    p_fcp.add_argument("--out", default=str(ROOT / "cut.fcpxml"))
    p_fcp.add_argument("--version", default="1.11")
    p_fcp.set_defaults(func=cmd_fcpxml)

    p_edl = sub.add_parser("edl", help="Export CMX 3600 EDL for Resolve Free/Studio & universal NLE import.")
    p_edl.add_argument("raw_clip", nargs="?")
    p_edl.add_argument("--cuts", default=str(CUTS_JSON))
    p_edl.add_argument("--out", default=str(ROOT / "cut.edl"))
    p_edl.set_defaults(func=cmd_edl)

    p_cf = sub.add_parser("cutflow", help="Export CutFlow AI .cutflow.json timeline with trimmable clips.")
    p_cf.add_argument("raw_clip", nargs="?")
    p_cf.add_argument("--cuts", default=str(CUTS_JSON))
    p_cf.add_argument("--out", default=str(ROOT / "cut.cutflow.json"))
    p_cf.add_argument("--asset-id", default=None)
    p_cf.add_argument("--punch-in", type=float, default=1.0)
    p_cf.set_defaults(func=cmd_cutflow)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
