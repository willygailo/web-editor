import { z } from "zod";
import {
  AspectRatioSchema,
  CutProjectSchema,
  MediaAssetSchema,
  PlatformPresetSchema,
  TextOverlaySchema,
} from "./edl.js";
import { CutTemplatePresetSchema } from "./templates.js";

export const AutoEditRequestSchema = z.object({
  prompt: z.string().min(1).max(600),
  assetIds: z.array(z.string().min(1)).min(1),
  audioAssetId: z.string().optional(),
  templateId: z.string().optional(),
  platform: PlatformPresetSchema.optional(),
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
  higgsfieldConfigured: z.boolean().default(false),
  higgsfieldMcpConfigured: z.boolean().default(false),
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

export const ImportUrlRequestSchema = z.object({
  url: z.string().url(),
  kind: z.enum(["video", "audio"]).default("video"),
  section: z.string().max(48).optional(),
  maxHeight: z.number().int().min(360).max(2160).default(1080),
});
export type ImportUrlRequest = z.infer<typeof ImportUrlRequestSchema>;

export const PolishAudioRequestSchema = z.object({
  denoise: z.enum(["ffmpeg", "fast", "studio"]).default("ffmpeg"),
});
export type PolishAudioRequest = z.infer<typeof PolishAudioRequestSchema>;

export const HiggsfieldGenerateRequestSchema = z.object({
  prompt: z.string().min(3).max(500),
  kind: z.enum(["video", "image"]).default("video"),
  model: z.string().min(1).max(120).default("kling"),
  aspectRatio: AspectRatioSchema.default("9:16"),
  durationSec: z.number().int().min(2).max(10).default(5),
  imageUrl: z.string().url().optional(),
});
export type HiggsfieldGenerateRequest = z.infer<typeof HiggsfieldGenerateRequestSchema>;

export const HiggsfieldGenerateResponseSchema = z.object({
  asset: MediaAssetSchema,
  requestId: z.string(),
  modelUsed: z.string(),
});
export type HiggsfieldGenerateResponse = z.infer<typeof HiggsfieldGenerateResponseSchema>;

export const TalkingHeadCutRequestSchema = z.object({
  assetId: z.string().min(1),
  mode: z.enum(["auto", "claude", "gemini", "offline"]).default("auto"),
  language: z.string().max(16).optional(),
  autoCaptions: z.boolean().default(true),
  autoPunchIn: z.boolean().default(true),
  polishAudio: z.enum(["none", "fast", "studio"]).default("none"),
});
export type TalkingHeadCutRequest = z.infer<typeof TalkingHeadCutRequestSchema>;

export const TalkingHeadCutResponseSchema = z.object({
  project: CutProjectSchema,
  segmentsCount: z.number().int().positive(),
  originalDurationSec: z.number().positive(),
  editedDurationSec: z.number().positive(),
  removedSec: z.number().min(0),
  source: z.enum(["claude", "gemini", "offline"]),
  waveformRefined: z.boolean().default(false),
  captionsAdded: z.number().int().nonnegative().default(0),
  warnings: z.array(z.string()).default([]),
});
export type TalkingHeadCutResponse = z.infer<typeof TalkingHeadCutResponseSchema>;
