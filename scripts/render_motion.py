#!/usr/bin/env python3
"""Render deterministic motion graphics (hook card, lower third, CTA outro) via heygen-com/hyperframes with FFmpeg fallback."""

from __future__ import annotations

import argparse
import html
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

ROOT = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = Path(__file__).resolve().parent / "motion_templates"
DEFAULT_OUT_DIR = ROOT / "output" / "motion"


def populate_template(
    template_name: str,
    *,
    title: str,
    subtitle: str,
    badge: str,
    accent: str,
    width: int,
    height: int,
    fps: int,
    duration: float,
    out_html: Path,
) -> Path:
    tpl_path = TEMPLATES_DIR / f"{template_name}.html"
    if not tpl_path.is_file():
        raise FileNotFoundError(f"Motion template not found: {tpl_path}")

    raw_html = tpl_path.read_text(encoding="utf-8")
    replacements = {
        "{{TITLE}}": html.escape(title),
        "{{SUBTITLE}}": html.escape(subtitle),
        "{{BADGE}}": html.escape(badge),
        "{{ACCENT}}": accent,
        "{{WIDTH}}": str(width),
        "{{HEIGHT}}": str(height),
        "{{FPS}}": str(fps),
        "{{DURATION}}": f"{duration:.2f}",
    }
    rendered = raw_html
    for k, v in replacements.items():
        rendered = rendered.replace(k, v)

    out_html.parent.mkdir(parents=True, exist_ok=True)
    out_html.write_text(rendered, encoding="utf-8")
    return out_html


def detect_hyperframes_cli() -> list[str] | None:
    local_bin = ROOT / "node_modules" / ".bin" / "hyperframes"
    if local_bin.is_file():
        return [str(local_bin)]
    vendor_bin = ROOT / "vendor" / "hyperframes" / "node_modules" / ".bin" / "hyperframes"
    if vendor_bin.is_file():
        return [str(vendor_bin)]
    global_bin = shutil.which("hyperframes")
    if global_bin:
        return [global_bin]
    return None


def render_with_hyperframes(cli: list[str], html_path: Path, out_mp4: Path, *, snapshot: bool = False) -> tuple[bool, str]:
    out_mp4.parent.mkdir(parents=True, exist_ok=True)
    lint_proc = subprocess.run([*cli, "lint", "--composition", str(html_path)], capture_output=True, text=True)
    if lint_proc.returncode != 0:
        return False, f"hyperframes lint failed: {(lint_proc.stderr or lint_proc.stdout).strip()}"

    if snapshot:
        subprocess.run(
            [*cli, "snapshot", "--composition", str(html_path), "--at", "0,0.5"],
            capture_output=True,
            text=True,
        )

    render_proc = subprocess.run(
        [*cli, "render", "--composition", str(html_path), "--output", str(out_mp4)],
        capture_output=True,
        text=True,
    )
    if render_proc.returncode == 0 and out_mp4.is_file():
        return True, "hyperframes"
    return False, f"hyperframes render failed: {(render_proc.stderr or render_proc.stdout).strip()}"


def render_ffmpeg_card_fallback(
    *,
    title: str,
    subtitle: str,
    width: int,
    height: int,
    fps: int,
    duration: float,
    out_mp4: Path,
) -> str:
    """Clean offline fallback graphic card rendered purely with FFmpeg when HyperFrames CLI is not installed yet."""
    out_mp4.parent.mkdir(parents=True, exist_ok=True)
    safe_title = title.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")[:48]
    safe_sub = subtitle.replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")[:64]
    title_size = max(24, int(round(width * 0.058)))
    sub_size = max(18, int(round(width * 0.032)))

    vf = (
        f"drawbox=x=0:y=0:w={width}:h={height}:color=#090b12@1:t=fill,"
        f"drawtext=text='{safe_title}':fontcolor=white:fontsize={title_size}:"
        f"x=(w-text_w)/2:y=(h-text_h)/2-{int(title_size * 0.6)},"
        f"drawtext=text='{safe_sub}':fontcolor=#fbbf24:fontsize={sub_size}:"
        f"x=(w-text_w)/2:y=(h-text_h)/2+{int(title_size * 0.7)}"
    )
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c=#090b12:s={width}x{height}:r={fps}:d={duration:.2f}",
            "-vf",
            vf,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-movflags",
            "+faststart",
            str(out_mp4),
        ],
        check=True,
        capture_output=True,
    )
    return "ffmpeg-fallback"


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate & render HyperFrames HTML/CSS/JS motion graphics.")
    parser.add_argument("--template", choices=["hook_card", "lower_third", "cta_outro"], default="hook_card")
    parser.add_argument("--title", required=True, help="Main headline / speaker name.")
    parser.add_argument("--subtitle", default="", help="Secondary line / handle.")
    parser.add_argument("--badge", default="WATCH THIS", help="Top badge label.")
    parser.add_argument("--accent", default="#fbbf24", help="Hex accent color (default: #fbbf24).")
    parser.add_argument("--width", type=int, default=1080)
    parser.add_argument("--height", type=int, default=1920)
    parser.add_argument("--fps", type=int, default=30)
    parser.add_argument("--duration", type=float, default=2.2)
    parser.add_argument("--out", default=None, help="Output MP4 path.")
    parser.add_argument("--html-only", action="store_true", help="Only generate the HyperFrames HTML composition.")
    parser.add_argument("--snapshot", action="store_true", help="Capture HyperFrames QA snapshots if CLI is installed.")
    args = parser.parse_args()

    out_mp4 = Path(args.out).expanduser().resolve() if args.out else (DEFAULT_OUT_DIR / f"{args.template}.mp4")
    out_html = out_mp4.with_suffix(".html")

    populate_template(
        args.template,
        title=args.title,
        subtitle=args.subtitle,
        badge=args.badge,
        accent=args.accent,
        width=args.width,
        height=args.height,
        fps=args.fps,
        duration=args.duration,
        out_html=out_html,
    )

    if args.html_only:
        print(json.dumps({"html": str(out_html), "engine": "html-only"}, indent=2))
        return

    cli = detect_hyperframes_cli()
    warning = None
    if cli:
        ok, engine_or_err = render_with_hyperframes(cli, out_html, out_mp4, snapshot=args.snapshot)
        if ok:
            print(json.dumps({"html": str(out_html), "mp4": str(out_mp4), "engine": engine_or_err}, indent=2))
            return
        warning = engine_or_err
    else:
        warning = (
            "HyperFrames CLI not installed locally (install with `npx skills add heygen-com/hyperframes` "
            "or `npm i -D hyperframes`); used FFmpeg card fallback."
        )

    engine = render_ffmpeg_card_fallback(
        title=args.title,
        subtitle=args.subtitle,
        width=args.width,
        height=args.height,
        fps=args.fps,
        duration=args.duration,
        out_mp4=out_mp4,
    )
    print(json.dumps({"html": str(out_html), "mp4": str(out_mp4), "engine": engine, "warning": warning}, indent=2))


if __name__ == "__main__":
    main()
