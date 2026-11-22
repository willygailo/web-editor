import { CUT_TEMPLATE_PRESETS, type AutoEditRequest, type AutoEditResponse, type CutTemplatePreset, type MediaAsset } from "@cutflow/shared";
import type { ServerConfig } from "../config.js";
import { generateAnthropicCutProject } from "./anthropic.js";
import { generateGeminiCutProject } from "./gemini.js";
import { generateOfflineCutProject } from "./offline.js";

export async function runAutoEditDirector(params: {
  request: AutoEditRequest;
  userGeminiKey?: string;
  userAnthropicKey?: string;
  userAnthropicWorkspaceId?: string;
  config: ServerConfig;
  assetsById: Map<string, MediaAsset>;
  filePathsById: Map<string, string>;
  templates?: CutTemplatePreset[];
}): Promise<AutoEditResponse> {
  const {
    request,
    userGeminiKey,
    userAnthropicKey,
    userAnthropicWorkspaceId,
    config,
    assetsById,
    filePathsById,
    templates = CUT_TEMPLATE_PRESETS,
  } = params;

  const effectiveAnthropicKey = (userAnthropicKey || config.anthropicApiKey || "").trim();
  const effectiveWorkspaceId = (
    userAnthropicWorkspaceId ||
    config.anthropicWorkspaceId ||
    ""
  ).trim();
  const effectiveGeminiKey = (userGeminiKey || config.geminiApiKey || "").trim();

  if (request.mode === "offline") {
    return generateOfflineCutProject(request, assetsById, templates);
  }

  const runClaude = async () =>
    generateAnthropicCutProject({
      apiKey: effectiveAnthropicKey,
      model: config.anthropicModel,
      workspaceId: effectiveWorkspaceId || undefined,
      request,
      assetsById,
      filePathsById,
      templates,
    });

  const runGemini = async () =>
    generateGeminiCutProject({
      apiKey: effectiveGeminiKey,
      model: config.geminiModel,
      request,
      assetsById,
      filePathsById,
      proxiesDir: config.proxiesDir,
      templates,
    });

  if (request.mode === "claude") {
    if (!effectiveAnthropicKey) {
      const fallback = generateOfflineCutProject(request, assetsById, templates);
      return {
        project: fallback.project,
        warnings: [
          "No Anthropic Claude API key configured; used Offline Smart Fallback instead.",
          ...fallback.warnings,
        ],
      };
    }
    try {
      return await runClaude();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const fallback = generateOfflineCutProject(request, assetsById, templates);
      return {
        project: fallback.project,
        warnings: [
          `Claude AI unavailable (${reason}); used Offline Smart Fallback instead.`,
          ...fallback.warnings,
        ],
      };
    }
  }

  if (request.mode === "gemini") {
    if (!effectiveGeminiKey) {
      const fallback = generateOfflineCutProject(request, assetsById, templates);
      return {
        project: fallback.project,
        warnings: [
          "No Gemini API key configured; used Offline Smart Fallback instead.",
          ...fallback.warnings,
        ],
      };
    }
    try {
      return await runGemini();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const fallback = generateOfflineCutProject(request, assetsById, templates);
      return {
        project: fallback.project,
        warnings: [
          `Gemini AI unavailable (${reason}); used Offline Smart Fallback instead.`,
          ...fallback.warnings,
        ],
      };
    }
  }

  // mode === "auto": try Claude if configured, else Gemini, else Offline Smart Fallback
  const warnings: string[] = [];
  if (effectiveAnthropicKey) {
    try {
      return await runClaude();
    } catch (err) {
      warnings.push(
        `Claude (${config.anthropicModel}) unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  if (effectiveGeminiKey) {
    try {
      const res = await runGemini();
      return { project: res.project, warnings: [...warnings, ...res.warnings] };
    } catch (err) {
      warnings.push(
        `Gemini (${config.geminiModel}) unavailable: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const fallback = generateOfflineCutProject(request, assetsById, templates);
  return {
    project: fallback.project,
    warnings: [
      ...(warnings.length > 0
        ? [`${warnings.join(" | ")}. Used Offline Smart Fallback instead.`]
        : []),
      ...fallback.warnings,
    ],
  };
}
