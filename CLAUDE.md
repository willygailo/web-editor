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
- **CapCut / DaVinci Resolve Free / No editing app** + **CutFlow AI Web App** (plus cross-platform connector scripts for **Adobe Premiere Pro MCP v1.2.3** and **Final Cut Pro SpliceKit MCP**).
- **Pro Automated CLI / Folder Watcher**:
  - Environment doctor: `pnpm doctor` (or `python3 scripts/setup_connectors.py doctor`)
  - URL ingest (`yt-dlp`): `pnpm ingest-url -- <URL>` (or `python3 scripts/auto_edit.py --url <URL>`)
  - One-shot: `pnpm auto-edit` (supports `--polish fast|studio`, `--captions karaoke|minimal`, `--punch-in 1.08`, `--look natural|warm|cinematic|punchy`, `--bgm auto`, `--platform tiktok|reels|shorts|youtube|ig_feed`, `--motion-gfx`, `--export-nle fcpxml,edl,cutflow`, `--script-check`, `--review`)
  - Continuous `raw/` watcher: `pnpm auto-watch`
  - ClearerVoice-Studio optional isolated venv: `python3 scripts/setup_connectors.py clearvoice` (`~/.cache/video-editor/clearvoice-venv`)
  - Higgsfield Remote MCP (`https://mcp.higgsfield.ai/mcp`): `pnpm connect-higgsfield` (registers `.mcp.json` with OAuth login, no API key needed); optional headless B-roll CLI: `pnpm plan-broll` & `pnpm gen-broll` (uses `HF_KEY` / `HF_API_KEY_ID` + `HF_API_KEY_SECRET`), composited via `--broll-manifest` (`cutaway` or `pip`).
  - Outputs saved to `output/<stem>_cut.mp4` + `./cut.mp4`, with Edit QA report in `transcript/<stem>.qa_report.json`.
- **CutFlow AI Web App**:
  - **Import URL** (`POST /api/media/import-url` via `yt-dlp`) & **AI Gen B-Roll (Higgsfield)** (`POST /api/media/generate-higgsfield`) in the Clips bin
  - **Polish Voice** (`POST /api/media/:id/polish-audio` via ClearerVoice / 2-pass `-14 LUFS` mastering) on video clips
  - **Auto Jump-Cut** (`POST /api/projects/talking-head-cut`) with WhisperX + Claude/Gemini/Offline + waveform boundary snapping + automatic edited-timeline captions + alternating punch-in zoom on trimmable clips.
- **Upgraded v2 Prompt**: See `docs/PRO_STARTER_PROMPT.md`.

## Raw Footage Notes
- *(Populated once raw clip is placed in `raw/` and probed with `scripts/build_cut.py probe`)*
