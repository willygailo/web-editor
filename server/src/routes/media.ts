import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { FastifyInstance } from "fastify";
import {
  HiggsfieldGenerateRequestSchema,
  ImportUrlRequestSchema,
  PolishAudioRequestSchema,
  type MediaAsset,
  type MediaKind,
} from "@cutflow/shared";
import { REPO_ROOT, type ServerConfig } from "../config.js";
import { generateAutoCaptions } from "../ai/transcribe.js";
import { ensureSampleDemoClips } from "../media/audioSynth.js";
import { runProcess } from "../media/exec.js";
import {
  extractAudioFromVideo,
  extractWaveformPeaks,
  generateThumbnail,
  probeMediaFile,
} from "../media/probe.js";
import type { MediaStore } from "../media/store.js";

function inferMediaKind(mimeType: string, filename: string): MediaKind | null {
  const lowerMime = mimeType.toLowerCase();
  const ext = path.extname(filename).toLowerCase();
  if (lowerMime.startsWith("audio/") || /\.(mp3|wav|m4a|aac|ogg|flac)$/.test(ext)) {
    return "audio";
  }
  if (lowerMime.startsWith("image/") || /\.(png|jpe?g|webp|gif)$/.test(ext)) {
    return "image";
  }
  if (lowerMime.startsWith("video/") || /\.(mp4|mov|webm|mkv|avi|m4v)$/.test(ext)) {
    return "video";
  }
  return null;
}

function inferAudioCategory(filename: string): "bgm" | "sfx" | "voiceover" {
  const lower = filename.toLowerCase();
  if (lower.startsWith("voiceover-") || lower.includes("voiceover") || lower.includes("-vo-")) {
    return "voiceover";
  }
  if (lower.startsWith("sfx-") || lower.includes("sfx")) {
    return "sfx";
  }
  return "bgm";
}

export function registerMediaRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  store: MediaStore
): void {
  app.get("/api/media", async () => {
    return { assets: store.list() };
  });

  app.post("/api/media/sample-pack", async () => {
    const created = await ensureSampleDemoClips(
      config.builtinsDir,
      config.proxiesDir,
      store
    );
    return { assets: created };
  });

  app.post("/api/media/upload", async (request, reply) => {
    const parts = request.parts({
      limits: {
        fileSize: config.maxUploadBytes,
        files: 12,
      },
    });

    const uploaded: MediaAsset[] = [];

    for await (const part of parts) {
      if (part.type !== "file") continue;

      const kind = inferMediaKind(part.mimetype || "", part.filename || "clip.mp4");
      if (!kind) {
        part.file.resume();
        continue;
      }

      const id = crypto.randomUUID();
      const safeExt = path.extname(part.filename || "").replace(/[^a-zA-Z0-9.]/g, "") || ".bin";
      const storedFilename = `${id}${safeExt}`;
      const filePath = path.join(config.uploadsDir, storedFilename);

      await pipeline(part.file, fs.createWriteStream(filePath));

      try {
        const probed = await probeMediaFile(filePath, kind);
        const thumbPath = path.join(config.proxiesDir, `${id}.jpg`);
        const hasThumb = await generateThumbnail(filePath, kind, thumbPath, probed.durationSec);

        const asset: MediaAsset = {
          id,
          filename: storedFilename,
          originalName: part.filename || storedFilename,
          kind,
          audioCategory: kind === "audio" ? inferAudioCategory(part.filename || "") : undefined,
          mimeType: part.mimetype || "application/octet-stream",
          url: `/api/media/${id}/stream`,
          thumbnailUrl: hasThumb ? `/api/media/${id}/thumb` : undefined,
          durationSec: probed.durationSec,
          width: probed.width,
          height: probed.height,
          fps: probed.fps,
          hasAudio: probed.hasAudio,
          beatMarkersSec: probed.beatMarkersSec,
          energyPeaksSec: probed.energyPeaksSec,
          visualHighlightsSec: probed.visualHighlightsSec,
          silenceRanges: probed.silenceRanges,
          isBuiltIn: false,
        };

        store.upsert(asset, filePath, hasThumb ? thumbPath : undefined);
        uploaded.push(asset);
      } catch (err) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        request.log.error(err, "Failed probing uploaded file");
      }
    }

    if (uploaded.length === 0) {
      return reply.status(400).send({
        error: "No supported video, image, or audio files found in upload.",
      });
    }

    return { assets: uploaded };
  });

  app.get<{ Params: { id: string } }>("/api/media/:id/thumb", async (request, reply) => {
    const entry = store.get(request.params.id);
    if (!entry || !entry.thumbPath || !fs.existsSync(entry.thumbPath)) {
      return reply.status(404).send({ error: "Thumbnail not found" });
    }
    reply.header("Content-Type", "image/jpeg");
    reply.header("Cache-Control", "public, max-age=86400");
    return reply.send(fs.createReadStream(entry.thumbPath));
  });

  app.get<{ Params: { id: string } }>("/api/media/:id/stream", async (request, reply) => {
    const entry = store.get(request.params.id);
    if (!entry || !fs.existsSync(entry.filePath)) {
      return reply.status(404).send({ error: "Media not found" });
    }

    const stat = fs.statSync(entry.filePath);
    const total = stat.size;
    const range = request.headers.range;

    reply.header("Accept-Ranges", "bytes");
    reply.header("Content-Type", entry.asset.mimeType);

    if (range) {
      const match = /bytes=(\d+)-(\d*)/.exec(range);
      if (match) {
        const start = Number(match[1]);
        const end = match[2] ? Math.min(total - 1, Number(match[2])) : total - 1;
        if (start >= total || start > end) {
          return reply.status(416).header("Content-Range", `bytes */${total}`).send();
        }
        reply.status(206);
        reply.header("Content-Range", `bytes ${start}-${end}/${total}`);
        reply.header("Content-Length", String(end - start + 1));
        return reply.send(fs.createReadStream(entry.filePath, { start, end }));
      }
    }

    reply.header("Content-Length", String(total));
    return reply.send(fs.createReadStream(entry.filePath));
  });

  app.delete<{ Params: { id: string } }>("/api/media/:id", async (request, reply) => {
    const entry = store.get(request.params.id);
    if (!entry) return reply.status(404).send({ error: "Not found" });
    if (entry.asset.isBuiltIn) {
      return reply.status(400).send({ error: "Built-in assets cannot be deleted." });
    }
    store.remove(request.params.id);
    return { ok: true };
  });

  app.get<{ Params: { id: string }; Querystring: { bins?: string } }>(
    "/api/media/:id/waveform",
    async (request, reply) => {
      const entry = store.get(request.params.id);
      if (!entry || !fs.existsSync(entry.filePath)) {
        return reply.status(404).send({ error: "Media not found" });
      }
      const bins = Math.min(240, Math.max(24, Number(request.query.bins || "100")));
      const cachePath = path.join(config.proxiesDir, `${entry.asset.id}.wave-${bins}.json`);
      const peaks = await extractWaveformPeaks(entry.filePath, cachePath, bins);
      return {
        assetId: entry.asset.id,
        durationSec: entry.asset.durationSec,
        peaks,
      };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/media/:id/extract-audio",
    async (request, reply) => {
      const entry = store.get(request.params.id);
      if (!entry || !fs.existsSync(entry.filePath)) {
        return reply.status(404).send({ error: "Media not found" });
      }
      if (!entry.asset.hasAudio) {
        return reply.status(400).send({ error: "This video clip has no audio stream." });
      }

      const id = crypto.randomUUID();
      const storedFilename = `${id}.m4a`;
      const outPath = path.join(config.uploadsDir, storedFilename);
      const ok = await extractAudioFromVideo(entry.filePath, outPath);
      if (!ok) {
        return reply.status(500).send({ error: "Failed to extract audio from video." });
      }

      const probed = await probeMediaFile(outPath, "audio");
      const audioAsset: MediaAsset = {
        id,
        filename: storedFilename,
        originalName: `${entry.asset.originalName} (Audio)`,
        kind: "audio",
        audioCategory: "bgm",
        mimeType: "audio/mp4",
        url: `/api/media/${id}/stream`,
        durationSec: probed.durationSec,
        hasAudio: true,
        beatMarkersSec: probed.beatMarkersSec,
        energyPeaksSec: probed.energyPeaksSec,
        visualHighlightsSec: [],
        silenceRanges: probed.silenceRanges,
        isBuiltIn: false,
      };

      store.upsert(audioAsset, outPath);
      return { asset: audioAsset };
    }
  );

  app.post<{ Params: { id: string } }>(
    "/api/media/:id/transcribe",
    async (request, reply) => {
      const entry = store.get(request.params.id);
      if (!entry || !fs.existsSync(entry.filePath)) {
        return reply.status(404).send({ error: "Media not found" });
      }
      const geminiHeader = request.headers["x-gemini-api-key"];
      const geminiModelHeader = request.headers["x-gemini-model"];
      const key =
        (typeof geminiHeader === "string" && geminiHeader.trim()) ||
        config.geminiApiKey;
      const model =
        (typeof geminiModelHeader === "string" && geminiModelHeader.trim()) ||
        config.geminiModel;

      const result = await generateAutoCaptions({
        asset: entry.asset,
        filePath: entry.filePath,
        geminiApiKey: key,
        model,
      });
      return result;
    }
  );

  app.post("/api/media/import-url", async (request, reply) => {
    const parsed = ImportUrlRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid URL import payload",
        details: parsed.error.flatten(),
      });
    }

    const scriptPath = path.join(REPO_ROOT, "scripts", "ingest_url.py");
    if (!fs.existsSync(scriptPath)) {
      return reply.status(500).send({ error: "URL ingest script not found." });
    }

    const id = crypto.randomUUID();
    const pyBin = process.platform === "win32" ? "python" : "python3";
    const args = [
      scriptPath,
      parsed.data.url,
      "--out-dir",
      config.uploadsDir,
      "--kind",
      parsed.data.kind,
      "--max-height",
      String(parsed.data.maxHeight),
      "--name",
      id,
    ];
    if (parsed.data.section?.trim()) {
      args.push("--section", parsed.data.section.trim());
    }

    const res = await runProcess(pyBin, args, { timeoutMs: 5 * 60_000 });
    if (res.code !== 0) {
      return reply.status(400).send({
        error: res.stderr.trim() || res.stdout.trim() || "Failed downloading media from URL via yt-dlp.",
      });
    }

    let meta: { path?: string; filename?: string } = {};
    try {
      meta = JSON.parse(res.stdout) as { path?: string; filename?: string };
    } catch {
      return reply.status(500).send({ error: "URL download completed but returned invalid metadata." });
    }

    const filePath = meta.path;
    if (!filePath || !fs.existsSync(filePath)) {
      return reply.status(500).send({ error: "Downloaded file could not be located on disk." });
    }

    try {
      const kind: MediaKind = parsed.data.kind === "audio" ? "audio" : "video";
      const storedFilename = path.basename(filePath);
      const probed = await probeMediaFile(filePath, kind);
      const thumbPath = path.join(config.proxiesDir, `${id}.jpg`);
      const hasThumb = await generateThumbnail(filePath, kind, thumbPath, probed.durationSec);
      const urlHost = new URL(parsed.data.url).hostname.replace(/^www\./, "");

      const asset: MediaAsset = {
        id,
        filename: storedFilename,
        originalName: `${urlHost}-${storedFilename}`.slice(0, 96),
        kind,
        audioCategory: kind === "audio" ? "bgm" : undefined,
        mimeType: kind === "audio" ? "audio/mp4" : "video/mp4",
        url: `/api/media/${id}/stream`,
        thumbnailUrl: hasThumb ? `/api/media/${id}/thumb` : undefined,
        durationSec: probed.durationSec,
        width: probed.width,
        height: probed.height,
        fps: probed.fps,
        hasAudio: probed.hasAudio,
        beatMarkersSec: probed.beatMarkersSec,
        energyPeaksSec: probed.energyPeaksSec,
        visualHighlightsSec: probed.visualHighlightsSec,
        silenceRanges: probed.silenceRanges,
        isBuiltIn: false,
      };
      store.upsert(asset, filePath, hasThumb ? thumbPath : undefined);
      return { asset };
    } catch (err) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return reply.status(500).send({
        error: err instanceof Error ? err.message : "Failed probing imported media.",
      });
    }
  });

  app.post<{ Params: { id: string } }>(
    "/api/media/:id/polish-audio",
    async (request, reply) => {
      const entry = store.get(request.params.id);
      if (!entry || !fs.existsSync(entry.filePath)) {
        return reply.status(404).send({ error: "Media not found" });
      }
      if (!entry.asset.hasAudio) {
        return reply.status(400).send({ error: "Selected media clip has no audio stream to polish." });
      }

      const parsed = PolishAudioRequestSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({ error: "Invalid audio polish options" });
      }

      const scriptPath = path.join(REPO_ROOT, "scripts", "polish_audio.py");
      if (!fs.existsSync(scriptPath)) {
        return reply.status(500).send({ error: "Audio polish script not found." });
      }

      const id = crypto.randomUUID();
      const pyBin = process.platform === "win32" ? "python" : "python3";
      const tmpWav = path.join(config.proxiesDir, `${id}.polished.wav`);
      const isVideo = entry.asset.kind === "video";
      const storedFilename = isVideo ? `${id}.mp4` : `${id}.wav`;
      const outPath = path.join(config.uploadsDir, storedFilename);

      const args = [
        scriptPath,
        entry.filePath,
        "--out",
        isVideo ? tmpWav : outPath,
        "--denoise",
        parsed.data.denoise,
      ];
      if (isVideo) {
        args.push("--mux-video", outPath);
      }

      const res = await runProcess(pyBin, args, { timeoutMs: 8 * 60_000 });
      if (res.code !== 0 || !fs.existsSync(outPath)) {
        return reply.status(500).send({
          error: res.stderr.trim() || res.stdout.trim() || "Audio polish failed.",
        });
      }

      let polishInfo: { engine_used?: string; output_lufs?: string; warnings?: string[] } = {};
      try {
        polishInfo = JSON.parse(res.stdout) as typeof polishInfo;
      } catch {
        // non-fatal
      }

      const kind: MediaKind = isVideo ? "video" : "audio";
      const probed = await probeMediaFile(outPath, kind);
      const thumbPath = path.join(config.proxiesDir, `${id}.jpg`);
      const hasThumb = await generateThumbnail(outPath, kind, thumbPath, probed.durationSec);

      const polishedAsset: MediaAsset = {
        id,
        filename: storedFilename,
        originalName: `${path.parse(entry.asset.originalName).name} (Polished Voice)${isVideo ? ".mp4" : ".wav"}`,
        kind,
        audioCategory: kind === "audio" ? (entry.asset.audioCategory ?? "voiceover") : undefined,
        mimeType: isVideo ? "video/mp4" : "audio/wav",
        url: `/api/media/${id}/stream`,
        thumbnailUrl: hasThumb ? `/api/media/${id}/thumb` : undefined,
        durationSec: probed.durationSec,
        width: probed.width,
        height: probed.height,
        fps: probed.fps,
        hasAudio: probed.hasAudio,
        beatMarkersSec: probed.beatMarkersSec,
        energyPeaksSec: probed.energyPeaksSec,
        visualHighlightsSec: probed.visualHighlightsSec,
        silenceRanges: probed.silenceRanges,
        isBuiltIn: false,
      };
      store.upsert(polishedAsset, outPath, hasThumb ? thumbPath : undefined);
      return {
        asset: polishedAsset,
        engineUsed: polishInfo.engine_used ?? "ffmpeg-broadcast",
        outputLufs: polishInfo.output_lufs ?? null,
        warnings: polishInfo.warnings ?? [],
      };
    }
  );

  app.post("/api/media/generate-higgsfield", async (request, reply) => {
    const parsed = HiggsfieldGenerateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid Higgsfield generation payload",
        details: parsed.error.flatten(),
      });
    }

    const headerKey = request.headers["x-higgsfield-key"];
    const apiKey =
      (typeof headerKey === "string" && headerKey.trim()) || config.higgsfieldKey;
    if (!apiKey || !apiKey.includes(":")) {
      return reply.status(400).send({
        error:
          "Higgsfield API key (key_id:key_secret) not configured. Add it in Settings or .env (HF_KEY), or use the Remote MCP connector (https://mcp.higgsfield.ai/mcp).",
      });
    }

    const scriptPath = path.join(REPO_ROOT, "scripts", "generate_broll.py");
    if (!fs.existsSync(scriptPath)) {
      return reply.status(500).send({ error: "Higgsfield generator script not found." });
    }

    const id = crypto.randomUUID();
    const isImage = parsed.data.kind === "image";
    const storedFilename = `${id}${isImage ? ".png" : ".mp4"}`;
    const outPath = path.join(config.uploadsDir, storedFilename);
    const pyBin = process.platform === "win32" ? "python" : "python3";

    const args = [
      scriptPath,
      "--prompt",
      parsed.data.prompt,
      "--kind",
      parsed.data.kind,
      "--model",
      parsed.data.model,
      "--aspect",
      parsed.data.aspectRatio,
      "--duration",
      String(parsed.data.durationSec),
      "--out",
      outPath,
    ];
    if (parsed.data.imageUrl) {
      args.push("--image-url", parsed.data.imageUrl);
    }

    const res = await runProcess(pyBin, args, {
      timeoutMs: 6 * 60_000,
      env: { HF_KEY: apiKey },
    });
    if (res.code !== 0 || !fs.existsSync(outPath)) {
      return reply.status(502).send({
        error: res.stderr.trim() || res.stdout.trim() || "Higgsfield generation failed.",
      });
    }

    let meta: { request_id?: string; model?: string } = {};
    try {
      meta = JSON.parse(res.stdout) as typeof meta;
    } catch {
      // non-fatal
    }

    try {
      const kind: MediaKind = isImage ? "image" : "video";
      const probed = await probeMediaFile(outPath, kind);
      const thumbPath = path.join(config.proxiesDir, `${id}.jpg`);
      const hasThumb = await generateThumbnail(outPath, kind, thumbPath, probed.durationSec);
      const shortPrompt = parsed.data.prompt.slice(0, 36).trim();

      const asset: MediaAsset = {
        id,
        filename: storedFilename,
        originalName: `Higgsfield (${parsed.data.model}) ${shortPrompt}${isImage ? ".png" : ".mp4"}`,
        kind,
        mimeType: isImage ? "image/png" : "video/mp4",
        url: `/api/media/${id}/stream`,
        thumbnailUrl: hasThumb ? `/api/media/${id}/thumb` : undefined,
        durationSec: probed.durationSec,
        width: probed.width,
        height: probed.height,
        fps: probed.fps,
        hasAudio: probed.hasAudio,
        beatMarkersSec: probed.beatMarkersSec,
        energyPeaksSec: probed.energyPeaksSec,
        visualHighlightsSec: probed.visualHighlightsSec,
        silenceRanges: probed.silenceRanges,
        isBuiltIn: false,
      };
      store.upsert(asset, outPath, hasThumb ? thumbPath : undefined);
      return {
        asset,
        requestId: meta.request_id ?? id,
        modelUsed: meta.model ?? parsed.data.model,
      };
    } catch (err) {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      return reply.status(500).send({
        error: err instanceof Error ? err.message : "Failed probing Higgsfield generated media.",
      });
    }
  });
}
