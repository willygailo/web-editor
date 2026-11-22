import fs from "node:fs";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import {
  CUT_TEMPLATE_PRESETS,
  type AutoEditRequest,
  type CutProject,
  type CutTemplatePreset,
  type MediaAsset,
} from "@cutflow/shared";
import { createGeminiVideoProxy } from "../media/probe.js";
import {
  assembleProAiCutProject,
  buildProDirectorPromptPayload,
  buildProSystemInstruction,
  PRO_EDL_JSON_SCHEMA,
  resolvePlatformSettings,
  type ParsedProAiEdl,
} from "./proSchema.js";

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
  templates?: CutTemplatePreset[];
}): Promise<{ project: CutProject; warnings: string[] }> {
  const {
    apiKey,
    model,
    request,
    assetsById,
    filePathsById,
    proxiesDir,
    templates = CUT_TEMPLATE_PRESETS,
  } = params;
  const client = new GoogleGenAI({ apiKey });

  const visualAssets = request.assetIds
    .map((id) => assetsById.get(id))
    .filter((a): a is MediaAsset => Boolean(a && a.kind !== "audio"));

  const audioAssets = Array.from(assetsById.values()).filter(
    (a) => a.kind === "audio" && a.audioCategory !== "sfx"
  );
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

    const { platform, aspectRatio } = resolvePlatformSettings({
      platform: request.platform,
      explicitAspect: request.aspectRatio,
      prompt: request.prompt,
    });

    const promptText = buildProDirectorPromptPayload({
      request,
      visualAssets,
      assetsById,
      selectedAudio,
      templates,
      resolvedPlatform: platform,
      resolvedAspect: aspectRatio,
    });

    contentBlocks.push({ type: "text", text: promptText });

    const interaction = await client.interactions.create({
      model,
      system_instruction: buildProSystemInstruction(platform),
      input: contentBlocks as never,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: PRO_EDL_JSON_SCHEMA,
      },
      store: false,
    });

    const rawText = interaction.output_text;
    if (!rawText) {
      throw new Error("Gemini returned empty output_text.");
    }

    const parsed = JSON.parse(rawText) as ParsedProAiEdl;
    return assembleProAiCutProject({
      parsed,
      request,
      modeUsed: "gemini",
      assetsById,
      selectedAudio,
      fallbackSummary: `Edited by ${model}`,
      initialWarnings: warnings,
    });
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
