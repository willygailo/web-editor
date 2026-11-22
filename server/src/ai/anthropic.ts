import fs from "node:fs";
import {
  CUT_TEMPLATE_PRESETS,
  type AutoEditRequest,
  type CutProject,
  type CutTemplatePreset,
  type MediaAsset,
} from "@cutflow/shared";
import { runProcess } from "../media/exec.js";
import {
  assembleProAiCutProject,
  buildProDirectorPromptPayload,
  buildProSystemInstruction,
  PRO_EDL_JSON_SCHEMA,
  resolvePlatformSettings,
  type ParsedProAiEdl,
} from "./proSchema.js";

const workspaceCache = new Map<string, string>();

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
  templates?: CutTemplatePreset[];
}): Promise<{ project: CutProject; warnings: string[] }> {
  const {
    apiKey,
    model,
    workspaceId,
    request,
    assetsById,
    filePathsById,
    fetchFn = fetch,
    templates = CUT_TEMPLATE_PRESETS,
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

  const { platform, aspectRatio } = resolvePlatformSettings({
    platform: request.platform,
    explicitAspect: request.aspectRatio,
    prompt: request.prompt,
  });

  const promptText = [
    buildProDirectorPromptPayload({
      request,
      visualAssets,
      assetsById,
      selectedAudio,
      templates,
      resolvedPlatform: platform,
      resolvedAspect: aspectRatio,
    }),
    "Call the emit_cut_project tool with the complete edited timeline JSON.",
  ].join("\n\n");

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
      system: buildProSystemInstruction(platform),
      tools: [
        {
          name: "emit_cut_project",
          description: "Emit the structured CapCut-style pro social video timeline JSON.",
          input_schema: PRO_EDL_JSON_SCHEMA,
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

  return assembleProAiCutProject({
    parsed: toolBlock.input as unknown as ParsedProAiEdl,
    request,
    modeUsed: "claude",
    assetsById,
    selectedAudio,
    fallbackSummary: `Edited by ${model}`,
  });
}
