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


def cmd_render_mp4(args: argparse.Namespace) -> None:
    raw = find_raw_clip(args.raw_clip)
    info = probe_media(raw, count_frames=False)
    fps = Fraction(info["fps_fraction"])
    segs = load_cuts(Path(args.cuts))
    snapped = snap_segments(segs, fps, info["nb_frames"])
    out_path = Path(args.out).resolve()

    filter_parts: list[str] = []
    concat_inputs: list[str] = []
    has_audio = info["has_audio"]

    for i, clip in enumerate(snapped):
        if info["is_cfr"]:
            filter_parts.append(
                f"[0:v]trim=start_frame={clip['start_frame']}:end_frame={clip['end_frame']},setpts=PTS-STARTPTS[v{i}]"
            )
        else:
            filter_parts.append(
                f"[0:v]trim=start={clip['start_sec']:.9f}:end={clip['end_sec']:.9f},setpts=PTS-STARTPTS[v{i}]"
            )
        if has_audio:
            filter_parts.append(
                f"[0:a]atrim=start={clip['start_sec']:.9f}:end={clip['end_sec']:.9f},asetpts=PTS-STARTPTS[a{i}]"
            )
            concat_inputs.append(f"[v{i}][a{i}]")
        else:
            concat_inputs.append(f"[v{i}]")

    a_count = 1 if has_audio else 0
    filter_parts.append(f"{''.join(concat_inputs)}concat=n={len(snapped)}:v=1:a={a_count}[outv]" + ("[outa]" if has_audio else ""))
    filtergraph = ";".join(filter_parts)

    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(raw),
        "-filter_complex",
        filtergraph,
        "-map",
        "[outv]",
    ]
    if has_audio:
        cmd += ["-map", "[outa]"]
    cmd += [
        "-c:v",
        "libx264",
        "-preset",
        "medium",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-fps_mode",
        "passthrough",
    ]
    if has_audio:
        cmd += ["-c:a", "aac", "-b:a", "192k"]
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
        "expected_dimensions": f"{info['display_width']}x{info['display_height']} ({info['orientation']})",
        "actual_dimensions": f"{out_info['display_width']}x{out_info['display_height']} ({out_info['orientation']})",
        "raw_fps": info["fps_fraction"],
        "output_fps": out_info["fps_fraction"],
    }
    print(json.dumps(report, indent=2))
    if out_info["display_width"] != info["display_width"] or out_info["display_height"] != info["display_height"]:
        sys.exit("ERROR: Output dimensions do not match raw footage display dimensions!")


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

    p_mp4 = sub.add_parser("render-mp4", help="Render single-pass ./cut.mp4 with -fps_mode passthrough and verify.")
    p_mp4.add_argument("raw_clip", nargs="?")
    p_mp4.add_argument("--cuts", default=str(CUTS_JSON))
    p_mp4.add_argument("--out", default=str(ROOT / "cut.mp4"))
    p_mp4.set_defaults(func=cmd_render_mp4)

    p_fcp = sub.add_parser("fcpxml", help="Export frame-snapped FCPXML for Final Cut Pro.")
    p_fcp.add_argument("raw_clip", nargs="?")
    p_fcp.add_argument("--cuts", default=str(CUTS_JSON))
    p_fcp.add_argument("--out", default=str(ROOT / "cut.fcpxml"))
    p_fcp.add_argument("--version", default="1.11")
    p_fcp.set_defaults(func=cmd_fcpxml)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
