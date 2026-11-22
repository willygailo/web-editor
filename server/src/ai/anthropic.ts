import crypto from "node:crypto";
import fs from "node:fs";
import {
  CUT_TEMPLATE_PRESETS,
  CutProjectSchema,
  type AutoEditRequest,
  type CutProject,
  type CutProjectInput,
  type MediaAsset,
} from "@cutflow/shared";
import { runProcess } from "../media/exec.js";
import { sanitizeCutProject } from "./sanitize.js";

const workspaceCache = new Map<string, string>();

const EDL_TOOL_SCHEMA = {
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

async function extractKeyframesForClaude(
  filePath: string,
  durationSec: number
): Promise<Array<{ timeSec: number; base64Jpeg: string }>> {
  const sampleTimes =
    durationSec >= 2.5
      ? [0.2, Number((durationSec * 0.5).toFixed(2)), Number(Math.max(0.4, durationSec - 0.3).toFixed(2))]
      : [0.1, Number((durationSec * 0.5).toFixed(2))];

  const frames: Array<{ timeSec: number; base64Jpeg: string }> = [];
  for (const t of sampleTimes) {
    try {
      const res = await runProcess(
        "ffmpeg",
        [
          "-ss",
          String(t),
          "-i",
          filePath,
          "-vframes",
          "1",
          "-vf",
          "scale='min(480,iw)':-2",
          "-q:v",
          "5",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "pipe:1",
        ],
        { timeoutMs: 8000 }
      );
      if (res.code === 0 && res.stdoutBuffer.length > 0) {
        frames.push({
          timeSec: t,
          base64Jpeg: res.stdoutBuffer.toString("base64"),
        });
      }
    } catch {
      // skip frame extraction errors
    }
  }
  return frames;
}

export async function resolveAnthropicWorkspaceId(
  apiKey: string,
  explicitWorkspaceId?: string,
  fetchFn: typeof fetch = fetch
): Promise<string | undefined> {
  if (explicitWorkspaceId?.trim()) return explicitWorkspaceId.trim();
  if (!apiKey.startsWith("sk-ant-usr-")) return undefined;

  const cached = workspaceCache.get(apiKey);
  if (cached) return cached;

  const res = await fetchFn("https://api.anthropic.com/v1/organizations/workspaces", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Unable to resolve Anthropic workspace (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    data?: Array<{ id: string; archived_at?: string | null }>;
  };
  const active = data.data?.find((w) => !w.archived_at) ?? data.data?.[0];
  if (!active?.id) {
    throw new Error("No Anthropic workspace found for user API key.");
  }
  workspaceCache.set(apiKey, active.id);
  return active.id;
}

export async function generateAnthropicCutProject(params: {
  apiKey: string;
  model: string;
  workspaceId?: string;
  request: AutoEditRequest;
  assetsById: Map<string, MediaAsset>;
  filePathsById: Map<string, string>;
  fetchFn?: typeof fetch;
}): Promise<{ project: CutProject; warnings: string[] }> {
  const {
    apiKey,
    model,
    workspaceId,
    request,
    assetsById,
    filePathsById,
    fetchFn = fetch,
  } = params;

  const resolvedWorkspaceId = await resolveAnthropicWorkspaceId(
    apiKey,
    workspaceId,
    fetchFn
  );

  const visualAssets = request.assetIds
    .map((id) => assetsById.get(id))
    .filter((a): a is MediaAsset => Boolean(a && a.kind !== "audio"));

  const audioAssets = Array.from(assetsById.values()).filter(
    (a) => a.kind === "audio" && a.audioCategory !== "sfx"
  );
  const selectedAudio = request.audioAssetId
    ? assetsById.get(request.audioAssetId)
    : audioAssets[0];

  const userContent: Array<Record<string, unknown>> = [];

  // Attach visual keyframes for up to 4 clips so Claude Sonnet 5.5 inspects actual visuals
  for (const asset of visualAssets.slice(0, 4)) {
    const filePath = filePathsById.get(asset.id);
    if (!filePath || !fs.existsSync(filePath)) continue;

    if (asset.kind === "image") {
      const supportedMime = ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
        asset.mimeType
      )
        ? asset.mimeType
        : "image/jpeg";
      userContent.push({
        type: "text",
        text: `Image Asset "${asset.originalName}" (assetId="${asset.id}"):`,
      });
      userContent.push({
        type: "image",
        source: {
          type: "base64",
          media_type: supportedMime,
          data: fs.readFileSync(filePath).toString("base64"),
        },
      });
    } else {
      const frames = await extractKeyframesForClaude(filePath, asset.durationSec);
      if (frames.length > 0) {
        userContent.push({
          type: "text",
          text: `Video Asset "${asset.originalName}" (assetId="${asset.id}", duration=${asset.durationSec}s) keyframes:`,
        });
        for (const frame of frames) {
          userContent.push({
            type: "text",
            text: `Frame @ ${frame.timeSec}s:`,
          });
          userContent.push({
            type: "image",
            source: {
              type: "base64",
              media_type: "image/jpeg",
              data: frame.base64Jpeg,
            },
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
    "Call the emit_cut_project tool with the complete edited timeline JSON.",
  ]
    .filter(Boolean)
    .join("\n\n");

  userContent.push({ type: "text", text: promptText });

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  };
  if (resolvedWorkspaceId) {
    headers["anthropic-workspace-id"] = resolvedWorkspaceId;
  }

  const res = await fetchFn("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      system:
        "You are an expert CapCut-style viral video editor AI. Analyze the user's prompt (English, Tagalog, or Taglish) and visual keyframes, pick the strongest moments avoiding dead air, align cuts to music beats, choose energetic or moody motion/transitions/filters, and generate crisp hook text overlays. Keep sourceStartSec and sourceEndSec strictly within each asset's durationSec.",
      tools: [
        {
          name: "emit_cut_project",
          description: "Emit the structured CapCut-style video cut template timeline JSON.",
          input_schema: EDL_TOOL_SCHEMA,
        },
      ],
      tool_choice: { type: "tool", name: "emit_cut_project" },
      messages: [{ role: "user", content: userContent }],
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text();
    let msg = bodyText;
    try {
      const parsedErr = JSON.parse(bodyText) as { error?: { message?: string } };
      if (parsedErr.error?.message) msg = parsedErr.error.message;
    } catch {
      // use raw text
    }
    throw new Error(`Anthropic API (${res.status}): ${msg}`);
  }

  const payload = (await res.json()) as {
    content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }>;
  };
  const toolBlock = payload.content?.find(
    (block) => block.type === "tool_use" && block.name === "emit_cut_project"
  );

  if (!toolBlock?.input) {
    throw new Error("Claude response did not contain emit_cut_project tool output.");
  }

  const parsed = toolBlock.input as {
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

  const audioTrackObj = chosenAudio
    ? {
        id: "aud-bgm-1",
        kind: "bgm" as const,
        assetId: chosenAudio.id,
        title: chosenAudio.originalName,
        timelineStartSec: 0,
        startOffsetSec: 0,
        volume: 0.85,
        fadeInSec: 0.2,
        fadeOutSec: 0.7,
        beatMarkersSec: chosenAudio.beatMarkersSec,
      }
    : undefined;

  const draft: CutProjectInput = {
    id: request.previousProject?.id ?? crypto.randomUUID(),
    title: parsed.title || "Claude Cut Edit",
    templateId: parsed.templateId || "hype-zoom",
    promptUsed: request.prompt,
    aiSummary: parsed.aiSummary || `Edited by ${model}`,
    modeUsed: "claude",
    aspectRatio: request.aspectRatio ?? parsed.aspectRatio ?? "9:16",
    fps: 30,
    targetDurationSec: request.targetDurationSec ?? 15,
    clips: (parsed.clips || []).map((c, idx) => ({
      ...c,
      id: `slot-${idx + 1}`,
    })),
    overlays: (parsed.overlays || []).map((o, idx) => ({
      ...o,
      id: `txt-${idx + 1}`,
    })),
    audioTrack: audioTrackObj,
    audioTracks: audioTrackObj ? [audioTrackObj] : [],
  };

  const sanitized = sanitizeCutProject(draft, assetsById);
  return {
    project: CutProjectSchema.parse(sanitized.project),
    warnings: sanitized.warnings,
  };
}
