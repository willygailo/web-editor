#!/usr/bin/env python3
"""Download talking-head footage, B-roll, or audio from URLs via yt-dlp."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlparse

os.environ.setdefault("PYTHONUTF8", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")

ROOT = Path(__file__).resolve().parent.parent
RAW_DIR = ROOT / "raw"
SCRIPTS_DIR = ROOT / "scripts"


def validate_url(url: str) -> str:
    cleaned = url.strip()
    parsed = urlparse(cleaned)
    if parsed.scheme not in ("http", "https") or not parsed.netloc:
        raise ValueError(f"Unsupported or invalid URL: {url}")
    return cleaned


def resolve_ytdlp() -> str:
    exe = shutil.which("yt-dlp")
    if not exe:
        raise RuntimeError(
            "yt-dlp is not installed or not in PATH. "
            "Install it with: uv tool install yt-dlp (or brew install yt-dlp / pip install yt-dlp)"
        )
    return exe


def sanitize_stem(name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9._-]+", "_", name.strip()).strip("._-")
    return cleaned[:96] or "imported_clip"


def build_ytdlp_command(
    *,
    ytdlp_bin: str,
    url: str,
    out_dir: Path,
    kind: str = "video",
    max_height: int = 1080,
    section: str | None = None,
    filename_stem: str | None = None,
) -> list[str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    if filename_stem:
        template = str(out_dir / f"{sanitize_stem(filename_stem)}.%(ext)s")
    else:
        template = str(out_dir / "%(title).72B_%(id)s.%(ext)s")

    cmd = [
        ytdlp_bin,
        "--no-playlist",
        "--restrict-filenames",
        "--no-progress",
        "--print",
        "after_move:filepath",
        "-o",
        template,
    ]

    if kind == "audio":
        cmd += [
            "-f",
            "bestaudio/best",
            "-x",
            "--audio-format",
            "m4a",
            "--audio-quality",
            "0",
        ]
    else:
        fmt = (
            f"bestvideo[height<={max_height}][vcodec^=avc1]+bestaudio[ext=m4a]/"
            f"bestvideo[height<={max_height}]+bestaudio/"
            f"best[height<={max_height}]/best"
        )
        cmd += [
            "-f",
            fmt,
            "--merge-output-format",
            "mp4",
        ]

    if section and section.strip():
        sec = section.strip()
        if not sec.startswith("*"):
            sec = f"*{sec}"
        cmd += ["--download-sections", sec, "--force-keyframes-at-cuts"]

    cmd.append(url)
    return cmd


def probe_downloaded(path: Path) -> dict:
    proc = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    data = json.loads(proc.stdout)
    streams = data.get("streams") or []
    v_stream = next((s for s in streams if s.get("codec_type") == "video"), None)
    a_stream = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = float((data.get("format") or {}).get("duration") or 0.0)
    return {
        "path": str(path),
        "filename": path.name,
        "duration": round(duration, 3),
        "width": int(v_stream["width"]) if v_stream and v_stream.get("width") else None,
        "height": int(v_stream["height"]) if v_stream and v_stream.get("height") else None,
        "has_video": v_stream is not None,
        "has_audio": a_stream is not None,
    }


def download_url(
    url: str,
    *,
    out_dir: Path = RAW_DIR,
    kind: str = "video",
    max_height: int = 1080,
    section: str | None = None,
    filename_stem: str | None = None,
    dry_run: bool = False,
) -> dict:
    safe_url = validate_url(url)
    ytdlp_bin = resolve_ytdlp()
    cmd = build_ytdlp_command(
        ytdlp_bin=ytdlp_bin,
        url=safe_url,
        out_dir=out_dir,
        kind=kind,
        max_height=max_height,
        section=section,
        filename_stem=filename_stem,
    )
    if dry_run:
        return {"dry_run": True, "command": cmd}

    proc = subprocess.run(cmd, check=True, capture_output=True, text=True)
    lines = [ln.strip() for ln in proc.stdout.splitlines() if ln.strip()]
    if not lines:
        raise RuntimeError(f"yt-dlp completed but did not report an output file path. stderr={proc.stderr.strip()}")
    downloaded = Path(lines[-1]).expanduser().resolve()
    if not downloaded.is_file():
        raise FileNotFoundError(f"yt-dlp output file missing: {downloaded}")

    meta = probe_downloaded(downloaded)
    meta["url"] = safe_url
    meta["kind"] = kind
    return meta


def main() -> None:
    parser = argparse.ArgumentParser(description="Download video or audio from URL via yt-dlp into raw/ or target folder.")
    parser.add_argument("url", help="HTTP/HTTPS URL supported by yt-dlp.")
    parser.add_argument("--out-dir", default=str(RAW_DIR), help="Destination directory (default: raw/).")
    parser.add_argument("--kind", choices=["video", "audio"], default="video", help="Download full video or audio-only m4a.")
    parser.add_argument("--max-height", type=int, default=1080, help="Maximum video height (default: 1080).")
    parser.add_argument("--section", default=None, help="Optional trim range, e.g. '00:10-00:45'.")
    parser.add_argument("--name", default=None, help="Optional clean filename stem.")
    parser.add_argument("--dry-run", action="store_true", help="Print the yt-dlp command without downloading.")
    args = parser.parse_args()

    try:
        result = download_url(
            args.url,
            out_dir=Path(args.out_dir).expanduser().resolve(),
            kind=args.kind,
            max_height=max(240, min(2160, args.max_height)),
            section=args.section,
            filename_stem=args.name,
            dry_run=args.dry_run,
        )
        print(json.dumps(result, indent=2))
    except Exception as exc:
        sys.exit(f"ERROR: {exc}")


if __name__ == "__main__":
    main()
