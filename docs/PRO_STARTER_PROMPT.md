# Pro AI Video Editor Setup Prompt (v2 — Full Open-Source Studio Stack)

Copy and paste this upgraded prompt into Claude Code / Antigravity inside any project folder. It upgrades the original starter workflow by closing every gap from Step 7 and integrating `yt-dlp`, `ClearerVoice-Studio`, `WhisperX`, `HyperFrames`, `SpliceKit`, and `Adobe_Premiere_Pro_MCP`, with full support for **Linux, macOS (Apple Silicon), and Windows (Git Bash)**.

---

```text
Set up a Pro AI Video Editor in this folder. You are the editor: I film raw talking-head footage (or hand you a URL), you polish the audio, cut dead air/fillers/retakes with waveform precision, add optional captions/motion graphics/finishing, put a real trimmable cut in front of me in my editing app, and run automated Edit QA to prove the cut plays back cleanly.

Keep everything in this folder: raw footage in raw/, transcripts/cuts/QA reports in transcript/, scripts in scripts/, rendered exports in output/, cloned connectors in vendor/.

## 1. Set up my machine (Linux, macOS, or Windows)
Assume I have never installed a developer tool. Check for ffmpeg, ffprobe, uv, git, Node 22+, yt-dlp, and Python 3.11 via uv (`uv python find 3.11`; if missing, `uv python install 3.11`).
- macOS: verify Apple Silicon (`uname -m` prints `arm64`; stop and tell me on Intel Mac because WhisperX torch lacks Intel macOS wheels). Install missing tools with `brew install ffmpeg uv git node yt-dlp` (add `eval "$(/opt/homebrew/bin/brew shellenv)"` to `~/.zprofile`).
- Linux: install missing system packages via apt/dnf/pacman (`ffmpeg git yt-dlp`), `uv`, and Node 22+ via nvm/NodeSource. Detect NVIDIA GPU via `nvidia-smi`; if unavailable, default AI inference cleanly to CPU `int8`.
- Windows: run in Git Bash (never WSL). Install with winget (`Gyan.FFmpeg`, `astral-sh.uv`, `OpenJS.NodeJS.LTS`, `yt-dlp.yt-dlp`). Always export `PYTHONUTF8=1` and `HF_HUB_DISABLE_SYMLINKS=1` in every script, and verify write access before installing (Controlled Folder Access check).

## 2. Ingest footage & ask where I finish
- If I give you a URL (YouTube, social clip, B-roll, or audio), download it cleanly into `raw/` using `yt-dlp` (CFR-friendly H.264/AAC MP4 or M4A, optional `--download-sections`).
- Ask which editing app I finish in:
  1. **Adobe Premiere Pro**: live MCP control via `hetpatel-11/Adobe_Premiere_Pro_MCP` (cloned to `vendor/premiere-mcp`, pinned at v1.2.3 commit `12684e3`, never `npm install -g`).
  2. **DaVinci Resolve Studio 21.1+**: live built-in AI Assistants MCP connector (`File > Setup AI Assistants`). For Resolve Free, export FCPXML + CMX 3600 EDL (imports as real trimmable clips!) plus finished MP4.
  3. **Final Cut Pro (macOS)**: live MCP control via `elliotttate/SpliceKit` (`vendor/splicekit`) with validated FCPXML v1.11 fallback.
  4. **CutFlow AI Web Studio / CapCut / No app**: finished MP4 at locked platform specs + trimmable `.cutflow.json` / `.fcpxml` / `.edl` + `.srt`/`.ass` captions.
For Premiere or Resolve Studio, tell me to create a NEW empty project saved to disk under a real name and keep it open.

## 3. Connect live NLE MCP (when applicable)
- Premiere: build `vendor/premiere-mcp`, install CEP panel (`setup:mac` / `setup:win`, `setup:doctor`), enable `PlayerDebugMode 1` for `com.adobe.CSXS.9..15` on macOS, write `.mcp.json` with matching `PREMIERE_TEMP_DIR`, `PREMIERE_MCP_TELEMETRY=0`, and `"timeout": 600000`.
- Final Cut Pro (macOS): configure `vendor/splicekit` MCP or use validated FCPXML v1.11.
- Resolve Studio 21.1+: register via `File > Setup AI Assistants`, set `timelineFrameRate` to ffprobe rate, and run a non-destructive marker connection test before editing.

## 4. Studio Audio Polish (ClearerVoice-Studio + EBU R128 Mastering)
Before or alongside transcription, polish the talking-head dialogue:
- Fast default: FFmpeg broadcast voice chain (`highpass=80Hz`, subtle warmth/presence EQ, `acompressor`, `afftdn`) + 2-pass EBU R128 `loudnorm` targeting `-14 LUFS` / `-1.5 dBTP` / `LRA 7`.
- Studio AI mode (`--polish studio`): run `modelscope/ClearerVoice-Studio` (`clearvoice` in isolated `~/.cache/video-editor/clearvoice-venv`, Python 3.11) using `MossFormer2_SE_48K` (or `FRCRN_SE_16K` for fast CPU, `MossFormer2_SS_16K` for overlapping speakers), followed by 2-pass `-14 LUFS` mastering. Cache output per file signature.

## 5. Transcribe once with WhisperX
Reuse `~/.cache/video-editor/whisperx-venv` (Python 3.11, never recreate or `--clear`). Transcribe 16 kHz mono WAV (preferring polished audio if generated) with `large-v3` + word-level alignment (CUDA `float16` on NVIDIA GPU with matching cu128 torch/torchaudio; CPU `int8` fallback). Support optional `--diarize` for multi-speaker clips. Save `transcript/words.json` and never transcribe the same footage twice.

## 6. Choose cuts + Waveform Boundary Snapping
- Choose kept spans with Claude / Gemini (or deterministic offline Taglish + English fallback): strip dead air, fillers, false starts, and inferior retakes while preserving personality.
- Run **waveform boundary refinement** on the PCM audio: snap every cut IN/OUT within a bounded safe window onto the quietest RMS energy trough + nearest zero-crossing so no consonant or breath gets clipped and no two segments overlap.
- Show me the cut table (with boundary dBFS levels) and wait for approval in `--review` mode.

## 7. Captions, Motion Graphics & Finishing
- **Word-Synced Captions**: remap `words.json` through frame-snapped `cuts.json` onto the edited timeline to generate `.srt` and safe-zone-clamped word-highlighted Karaoke `.ass` captions.
- **Programmatic Motion Graphics (Optional)**: use `heygen-com/hyperframes` HTML/CSS/JS compositions (`hook_card`, `lower_third`, `cta_outro`) with `lint` + `snapshot` + deterministic render (FFmpeg fallback if HyperFrames CLI is absent).
- **Generative AI B-Roll & Cutaways (Higgsfield MCP)**:
  - Connect Higgsfield's managed remote MCP (`https://mcp.higgsfield.ai/mcp`) in `.mcp.json` (OAuth sign-in, zero API key needed — `pnpm connect-higgsfield`) OR set `HF_KEY` (`key_id:key_secret`) for headless generation via `scripts/generate_broll.py`.
  - Run `scripts/plan_broll.py` on `transcript/cuts.json` to create `transcript/<stem>.broll_plan.json` (preserving the opening 1.5s hook and closing 1.5s CTA), generate clips into `raw/broll/` via Higgsfield (`kling`, `seedance`, `veo`, `dop`, `soul`), and composite them as full-frame cutaways or PiP cards with `build_cut.py --broll-manifest` while keeping talking-head dialogue continuous and captions on top.
- **Finishing**: micro audio fades (`12ms`) across jump cuts, optional alternating punch-in zoom (`1.08x`), color look / `.cube` 3D LUT, sidechain-ducked BGM (`sidechaincompress`), and locked platform export specs (`tiktok`, `reels`, `shorts`, `youtube`, `ig_feed`, `bt709`, `yuv420p`, `48kHz AAC`, `-fps_mode passthrough`).
- Build trimmable NLE timelines (Premiere / Resolve / FCP / FCPXML / CMX 3600 EDL / CutFlow JSON) — never flatten an app timeline into a single clip.

## 8. Automated Edit QA (Prove the Edit)
After building, run automated Edit QA (`scripts/verify_edit.py`) and save `transcript/<stem>.qa_report.json`:
1. Exact `ffprobe` frame count, duration, dimensions, FPS, and measured integrated `LUFS` / `True Peak`.
2. Splice boundary RMS & sample-step click audit at every edit point.
3. Video integrity scan (`blackdetect` + `freezedetect`).
4. Optional `--script-check`: re-transcribe the rendered MP4 with WhisperX and diff against the approved `cuts.json` script to prove zero dropped lines.

Report the QA verdict (`PASS` / `WARN` / `FAIL`) plainly and concisely.
```
