# Starter AI Video Editor — Local Setup Notes

## Machine Environment (Verified)
- **OS**: Linux `x86_64` (Kali GNU/Linux Rolling)
- **ffmpeg**: `/usr/bin/ffmpeg` (`9.0.2-4`)
- **ffprobe**: `/usr/bin/ffprobe` (`9.0.2-4`)
- **uv**: `/home/willygailo/.local/bin/uv` (`0.13.8`)
- **git**: `/usr/bin/git` (`2.54.0`)
- **node**: `/home/willygailo/.nvm/versions/node/v24.18.0/bin/node` (`v24.18.0`)
- **Python 3.11 (via uv)**: `/home/willygailo/.local/share/uv/python/cpython-3.11-linux-x86_64-gnu/bin/python3.11`
- **GPU**: None detected (`nvidia-smi` unavailable) → WhisperX runs on **CPU `int8`**.
- **WhisperX venv**: `~/.cache/video-editor/whisperx-venv` (installed & verified: `whisperx 3.8.6`, `torch 2.8.0+cu128`, `cuda: False`, runs CPU `int8`; harmless `libtorchcodec` warning with FFmpeg 9.0.2 is expected because WhisperX uses `ffmpeg` CLI directly).

## Workspace Layout
- This folder (`/home/willygailo/Downloads/web editor`) also contains the `cutflow-ai` git repository.
- Starter files live strictly in `raw/`, `transcript/`, `scripts/`, `vendor/`, `CLAUDE.md`, and root outputs (`cut.mp4` / `cut.fcpxml`) without modifying `cutflow-ai` source files.

## Target Editing App
- **CapCut / DaVinci Resolve Free / No editing app** + **CutFlow AI Web App**
- **100% Automatic CLI / Folder Watcher**:
  - One-shot: `pnpm auto-edit` (or `python3 scripts/auto_edit.py` — add `--review` to pause and approve `cuts.json` first)
  - Continuous `raw/` watcher: `pnpm auto-watch` (or `python3 scripts/auto_edit.py --watch`)
  - Outputs saved to `output/<stem>_cut.mp4` and mirrored to `./cut.mp4` (single-pass FFmpeg `-fps_mode passthrough`, frame-verified with `ffprobe`).
- **CutFlow AI Web App**: 1-click **Auto Jump-Cut** button calls `POST /api/projects/talking-head-cut` and creates a real multi-clip trimmable timeline.

## Raw Footage Notes
- *(Populated once raw clip is placed in `raw/` and probed with `scripts/build_cut.py probe`)*
