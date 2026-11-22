import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import {
  CUT_TEMPLATE_PRESETS,
  CutProjectSchema,
  type AutoEditRequest,
  type CutProject,
  type MediaAsset,
} from "@cutflow/shared";
import { createGeminiVideoProxy } from "../media/probe.js";
import { sanitizeCutProject } from "./sanitize.js";

const EDL_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    templateId: {
      type: "string",
      enum: CUT_TEMPLATE_PRESETS.map((p) => p.id),
    },
    aiSummary: { type: "string" },
    aspectRatio: { type: "string", enum: ["9:16", "16:9", "1:1"] },
    clips: {
      type: "array",
      minItems: 1,
      maxItems: 20,
      items: {
        type: "object",
        properties: {
          assetId: { type: "string" },
          sourceStartSec: { type: "number" },
          sourceEndSec: { type: "number" },
          speed: { type: "number" },
          motion: {
            type: "string",
            enum: ["none", "zoom-in", "zoom-out", "pan-left", "pan-right", "punch-zoom"],
          },
          transitionIn: {
            type: "string",
            enum: ["cut", "crossfade", "slide-left", "flash-white", "zoom-blur"],
          },
          transitionDurationSec: { type: "number" },
          filter: {
            type: "string",
            enum: ["none", "vivid", "cinematic", "warm-film", "bw-contrast"],
          },
          muteOriginalAudio: { type: "boolean" },
          volume: { type: "number" },
          label: { type: "string" },
        },
        required: [
          "assetId",
          "sourceStartSec",
          "sourceEndSec",
          "speed",
          "motion",
          "transitionIn",
          "transitionDurationSec",
          "filter",
          "muteOriginalAudio",
          "volume",
        ],
      },
    },
    overlays: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          startSec: { type: "number" },
          endSec: { type: "number" },
          position: { type: "string", enum: ["top", "center", "bottom"] },
          style: {
            type: "string",
            enum: ["bold-hook", "capcut-pop", "minimal-caption", "neon-badge"],
          },
        },
        required: ["text", "startSec", "endSec", "position", "style"],
      },
    },
    audioAssetId: { type: "string" },
  },
  required: ["title", "templateId", "aiSummary", "aspectRatio", "clips", "overlays"],
};

async function waitForFileActive(
  client: GoogleGenAI,
  fileName: string,
  timeoutMs = 30_000
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await client.files.get({ name: fileName });
    if (info.state === "ACTIVE") return info.uri;
    if (info.state === "FAILED") {
      throw new Error(`Gemini file processing failed for ${fileName}`);
    }
    await new Promise((r) => setTimeout(r, 1200));
  }
  return undefined;
}

export async function generateGeminiCutProject(params: {
  apiKey: string;
  model: string;
  request: AutoEditRequest;
  assetsById: Map<string, MediaAsset>;
  filePathsById: Map<string, string>;
  proxiesDir: string;
}): Promise<{ project: CutProject; warnings: string[] }> {
  const { apiKey, model, request, assetsById, filePathsById, proxiesDir } = params;
  const client = new GoogleGenAI({ apiKey });

  const visualAssets = request.assetIds
    .map((id) => assetsById.get(id))
    .filter((a): a is MediaAsset => Boolean(a && a.kind !== "audio"));

  const audioAssets = Array.from(assetsById.values()).filter((a) => a.kind === "audio");
  const selectedAudio = request.audioAssetId
    ? assetsById.get(request.audioAssetId)
    : audioAssets[0];

  const uploadedFileNames: string[] = [];
  const tempProxyPaths: string[] = [];
  const warnings: string[] = [];

  try {
    const contentBlocks: Array<Record<string, unknown>> = [];

    // Attach compact proxies for up to 4 visual clips so multimodal Gemini can inspect actual visuals
    for (const asset of visualAssets.slice(0, 4)) {
      const originalPath = filePathsById.get(asset.id);
      if (!originalPath || !fs.existsSync(originalPath)) continue;

      if (asset.kind === "image") {
        const b64 = fs.readFileSync(originalPath).toString("base64");
        contentBlocks.push({
          type: "image",
          data: b64,
          mime_type: asset.mimeType,
        });
      } else {
        const proxyPath = path.join(proxiesDir, `gemini-${asset.id}.mp4`);
        let fileToUpload = originalPath;
        const ok = fs.existsSync(proxyPath)
          ? true
          : await createGeminiVideoProxy(originalPath, proxyPath, 35);
        if (ok && fs.existsSync(proxyPath)) {
          fileToUpload = proxyPath;
          tempProxyPaths.push(proxyPath);
        }

        const uploaded = await client.files.upload({
          file: fileToUpload,
          config: { mimeType: "video/mp4", displayName: asset.originalName },
        });
        if (uploaded.name) {
          uploadedFileNames.push(uploaded.name);
          const activeUri =
            uploaded.state === "ACTIVE"
              ? uploaded.uri
              : await waitForFileActive(client, uploaded.name);
          if (activeUri) {
            contentBlocks.push({
              type: "video",
              uri: activeUri,
              mime_type: "video/mp4",
            });
          }
        }
      }
    }

    const assetManifest = visualAssets.map((a) => ({
      assetId: a.id,
      name: a.originalName,
      kind: a.kind,
      durationSec: a.durationSec,
      dimensions: a.width && a.height ? `${a.width}x${a.height}` : "unknown",
      energyPeaksSec: a.energyPeaksSec.slice(0, 12),
      silenceRanges: a.silenceRanges.slice(0, 8),
    }));

    const musicManifest = audioAssets.map((a) => ({
      assetId: a.id,
      title: a.originalName,
      durationSec: a.durationSec,
      beatMarkersSec: a.beatMarkersSec.slice(0, 32),
    }));

    const templateSummary = CUT_TEMPLATE_PRESETS.map((t) => ({
      id: t.id,
      name: t.name,
      tagline: t.tagline,
      defaultAspectRatio: t.defaultAspectRatio,
      bpm: t.bpm,
    }));

    const promptText = [
      `User Request: "${request.prompt}"`,
      request.aspectRatio ? `Forced Aspect Ratio: ${request.aspectRatio}` : "",
      request.templateId ? `Preferred Template ID: ${request.templateId}` : "",
      request.targetDurationSec ? `Target Duration: ${request.targetDurationSec}s` : "",
      selectedAudio ? `Preferred Audio Asset ID: ${selectedAudio.id}` : "",
      `Available Visual Assets:\n${JSON.stringify(assetManifest, null, 2)}`,
      `Available Audio Tracks:\n${JSON.stringify(musicManifest, null, 2)}`,
      `Cut Template Presets:\n${JSON.stringify(templateSummary, null, 2)}`,
      request.previousProject
        ? `Previous Edit JSON (modify according to user's follow-up prompt):\n${JSON.stringify(request.previousProject)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");

    contentBlocks.push({ type: "text", text: promptText });

    const interaction = await client.interactions.create({
      model,
      system_instruction:
        "You are an expert CapCut-style viral video editor AI. Analyze the user's prompt (English, Tagalog, or Taglish) and media assets, pick the best visual moments avoiding dead air, align cuts to music beats, choose energetic or moody motion/transitions/filters, and generate crisp hook text overlays. Return ONLY valid JSON matching the schema. Keep sourceStartSec and sourceEndSec strictly within each asset's durationSec.",
      input: contentBlocks as never,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: EDL_JSON_SCHEMA,
      },
      store: false,
    });

    const rawText = interaction.output_text;
    if (!rawText) {
      throw new Error("Gemini returned empty output_text.");
    }

    const parsed = JSON.parse(rawText) as {
      title: string;
      templateId: string;
      aiSummary: string;
      aspectRatio: "9:16" | "16:9" | "1:1";
      clips: Array<{
        assetId: string;
        sourceStartSec: number;
        sourceEndSec: number;
        speed: number;
        motion: CutProject["clips"][number]["motion"];
        transitionIn: CutProject["clips"][number]["transitionIn"];
        transitionDurationSec: number;
        filter: CutProject["clips"][number]["filter"];
        muteOriginalAudio: boolean;
        volume: number;
        label?: string;
      }>;
      overlays: Array<{
        text: string;
        startSec: number;
        endSec: number;
        position: CutProject["overlays"][number]["position"];
        style: CutProject["overlays"][number]["style"];
      }>;
      audioAssetId?: string;
    };

    const chosenAudio =
      (parsed.audioAssetId ? assetsById.get(parsed.audioAssetId) : undefined) ??
      selectedAudio;

    const draft: CutProject = {
      id: request.previousProject?.id ?? crypto.randomUUID(),
      title: parsed.title || "AI Cut Edit",
      templateId: parsed.templateId || "hype-zoom",
      promptUsed: request.prompt,
      aiSummary: parsed.aiSummary,
      modeUsed: "gemini",
      aspectRatio: request.aspectRatio ?? parsed.aspectRatio ?? "9:16",
      fps: 30,
      targetDurationSec: request.targetDurationSec ?? 15,
      clips: parsed.clips.map((c, idx) => ({
        ...c,
        id: `slot-${idx + 1}`,
      })),
      overlays: (parsed.overlays || []).map((o, idx) => ({
        ...o,
        id: `txt-${idx + 1}`,
      })),
      audioTrack: chosenAudio
        ? {
            assetId: chosenAudio.id,
            title: chosenAudio.originalName,
            startOffsetSec: 0,
            volume: 0.85,
            fadeInSec: 0.2,
            fadeOutSec: 0.7,
            beatMarkersSec: chosenAudio.beatMarkersSec,
          }
        : undefined,
    };

    const sanitized = sanitizeCutProject(draft, assetsById);
    return {
      project: CutProjectSchema.parse(sanitized.project),
      warnings: [...warnings, ...sanitized.warnings],
    };
  } finally {
    for (const fileName of uploadedFileNames) {
      void client.files.delete({ name: fileName }).catch(() => undefined);
    }
    for (const p of tempProxyPaths) {
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // ignore cleanup failures
        }
      }
    }
  }
}
