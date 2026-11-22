# CutFlow AI — Auto Cut-Template Video Studio (Phone & Laptop)

CapCut-inspired responsive PWA video editor where AI automatically turns raw clips into beat-aligned, stylized cut templates from natural-language prompts (English, Tagalog, or Taglish) with instant browser preview and server-side FFmpeg MP4 export.

## Prerequisites
- **Node.js** >= 22
- **pnpm**
- **FFmpeg & ffprobe** available in `PATH`
- Optional: `ANTHROPIC_API_KEY` (`claude-sonnet-5-5`, including `sk-ant-usr-*` workspace auto-discovery) and/or `GEMINI_API_KEY` (`gemini-4-hydrogen`) in `.env` or the UI Settings dialog. When omitted or out of credits, CutFlow AI automatically falls back to its built-in Offline Smart Engine.

## Quick Start

```bash
cp .env.example .env
pnpm install
pnpm dev
```

- **Laptop**: open `http://localhost:5173`
- **Phone (same Wi-Fi)**: open `http://<your-laptop-lan-ip>:5173` and use **Add to Home Screen** to install as a PWA.

## Scripts

- `pnpm dev` — run backend (`:3001`) + Vite PWA frontend (`:5173`)
- `pnpm build` — build `shared`, `server`, and `web`
- `pnpm test` — run shared + server tests (includes real FFmpeg render verification)
- `pnpm typecheck` — run strict TypeScript checks across all packages
