import { z } from "zod";
import {
  AspectRatioSchema,
  CutProjectSchema,
  MediaAssetSchema,
  TextOverlaySchema,
} from "./edl.js";
import { CutTemplatePresetSchema } from "./templates.js";

export const AutoEditRequestSchema = z.object({
  prompt: z.string().min(1).max(600),
  assetIds: z.array(z.string().min(1)).min(1),
  audioAssetId: z.string().optional(),
  templateId: z.string().optional(),
  aspectRatio: AspectRatioSchema.optional(),
  targetDurationSec: z.number().min(3).max(180).optional(),
  mode: z.enum(["auto", "claude", "gemini", "offline"]).default("auto"),
  previousProject: CutProjectSchema.optional(),
});
export type AutoEditRequest = z.infer<typeof AutoEditRequestSchema>;

export const AutoEditResponseSchema = z.object({
  project: CutProjectSchema,
  warnings: z.array(z.string()).default([]),
});
export type AutoEditResponse = z.infer<typeof AutoEditResponseSchema>;

export const RenderRequestSchema = z.object({
  project: CutProjectSchema,
  quality: z.enum(["720p", "1080p"]).default("1080p"),
});
export type RenderRequest = z.infer<typeof RenderRequestSchema>;

export const RenderJobStatusSchema = z.enum([
  "queued",
  "rendering",
  "completed",
  "failed",
]);
export type RenderJobStatus = z.infer<typeof RenderJobStatusSchema>;

export const RenderJobSchema = z.object({
  id: z.string(),
  status: RenderJobStatusSchema,
  progress: z.number().min(0).max(100),
  stage: z.string(),
  outputUrl: z.string().optional(),
  error: z.string().optional(),
  createdAt: z.string(),
});
export type RenderJob = z.infer<typeof RenderJobSchema>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  ffmpegAvailable: z.boolean(),
  anthropicConfigured: z.boolean(),
  anthropicModel: z.string(),
  geminiConfigured: z.boolean(),
  geminiModel: z.string(),
  assetsCount: z.number().int().nonnegative(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const UploadMediaResponseSchema = z.object({
  assets: z.array(MediaAssetSchema),
});
export type UploadMediaResponse = z.infer<typeof UploadMediaResponseSchema>;

export const WaveformResponseSchema = z.object({
  assetId: z.string(),
  durationSec: z.number(),
  peaks: z.array(z.number()),
});
export type WaveformResponse = z.infer<typeof WaveformResponseSchema>;

export const SaveTemplateRequestSchema = CutTemplatePresetSchema.omit({
  id: true,
}).extend({
  id: z.string().optional(),
});
export type SaveTemplateRequest = z.infer<typeof SaveTemplateRequestSchema>;

export const TranscribeResponseSchema = z.object({
  overlays: z.array(TextOverlaySchema),
  source: z.enum(["gemini", "offline"]),
});
export type TranscribeResponse = z.infer<typeof TranscribeResponseSchema>;
