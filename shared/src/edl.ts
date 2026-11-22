import { z } from "zod";

export const AspectRatioSchema = z.enum(["9:16", "16:9", "1:1"]);
export type AspectRatio = z.infer<typeof AspectRatioSchema>;

export const MotionPresetSchema = z.enum([
  "none",
  "zoom-in",
  "zoom-out",
  "pan-left",
  "pan-right",
  "punch-zoom",
]);
export type MotionPreset = z.infer<typeof MotionPresetSchema>;

export const TransitionTypeSchema = z.enum([
  "cut",
  "crossfade",
  "slide-left",
  "flash-white",
  "zoom-blur",
]);
export type TransitionType = z.infer<typeof TransitionTypeSchema>;

export const FilterPresetSchema = z.enum([
  "none",
  "vivid",
  "cinematic",
  "warm-film",
  "bw-contrast",
]);
export type FilterPreset = z.infer<typeof FilterPresetSchema>;

export const OverlayPositionSchema = z.enum(["top", "center", "bottom"]);
export type OverlayPosition = z.infer<typeof OverlayPositionSchema>;

export const OverlayStyleSchema = z.enum([
  "bold-hook",
  "capcut-pop",
  "minimal-caption",
  "neon-badge",
]);
export type OverlayStyle = z.infer<typeof OverlayStyleSchema>;

export const TextAnimationSchema = z.enum(["none", "pop", "fade", "slide-up"]);
export type TextAnimation = z.infer<typeof TextAnimationSchema>;

export const MediaKindSchema = z.enum(["video", "image", "audio"]);
export type MediaKind = z.infer<typeof MediaKindSchema>;

export const AudioCategorySchema = z.enum(["bgm", "sfx", "voiceover"]);
export type AudioCategory = z.infer<typeof AudioCategorySchema>;

export const SilenceRangeSchema = z.object({
  startSec: z.number().min(0),
  endSec: z.number().min(0),
});
export type SilenceRange = z.infer<typeof SilenceRangeSchema>;

export const MediaAssetSchema = z.object({
  id: z.string().min(1),
  filename: z.string().min(1),
  originalName: z.string().min(1),
  kind: MediaKindSchema,
  audioCategory: AudioCategorySchema.optional(),
  mimeType: z.string().min(1),
  url: z.string().min(1),
  thumbnailUrl: z.string().optional(),
  durationSec: z.number().positive(),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  fps: z.number().positive().optional(),
  hasAudio: z.boolean().default(false),
  beatMarkersSec: z.array(z.number().min(0)).default([]),
  energyPeaksSec: z.array(z.number().min(0)).default([]),
  silenceRanges: z.array(SilenceRangeSchema).default([]),
  isBuiltIn: z.boolean().default(false),
});
export type MediaAsset = z.infer<typeof MediaAssetSchema>;

export const ClipAdjustSchema = z.object({
  brightness: z.number().min(-0.5).max(0.5).default(0),
  contrast: z.number().min(-0.5).max(0.5).default(0),
  saturation: z.number().min(-1).max(1).default(0),
  warmth: z.number().min(-0.5).max(0.5).default(0),
  vignette: z.number().min(0).max(1).default(0),
});
export type ClipAdjust = z.infer<typeof ClipAdjustSchema>;

export const ClipTransformSchema = z.object({
  scale: z.number().min(0.5).max(3).default(1),
  offsetX: z.number().min(-0.5).max(0.5).default(0),
  offsetY: z.number().min(-0.5).max(0.5).default(0),
  rotationDeg: z.number().min(-180).max(180).default(0),
});
export type ClipTransform = z.infer<typeof ClipTransformSchema>;

export const ClipSlotSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  sourceStartSec: z.number().min(0),
  sourceEndSec: z.number().positive(),
  speed: z.number().min(0.5).max(2.5).default(1),
  motion: MotionPresetSchema.default("none"),
  transitionIn: TransitionTypeSchema.default("cut"),
  transitionDurationSec: z.number().min(0).max(0.8).default(0.25),
  filter: FilterPresetSchema.default("none"),
  muteOriginalAudio: z.boolean().default(false),
  volume: z.number().min(0).max(2).default(1),
  reversed: z.boolean().default(false),
  adjust: ClipAdjustSchema.optional(),
  transform: ClipTransformSchema.optional(),
  label: z.string().optional(),
});
export type ClipSlot = z.infer<typeof ClipSlotSchema>;

export const TextOverlaySchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1).max(160),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  position: OverlayPositionSchema.default("bottom"),
  style: OverlayStyleSchema.default("capcut-pop"),
  xNorm: z.number().min(0.05).max(0.95).optional(),
  yNorm: z.number().min(0.05).max(0.95).optional(),
  scale: z.number().min(0.4).max(2.5).default(1),
  rotationDeg: z.number().min(-180).max(180).default(0),
  color: z.string().optional(),
  bgColor: z.string().optional(),
  animation: TextAnimationSchema.default("pop"),
});
export type TextOverlay = z.infer<typeof TextOverlaySchema>;

export const StickerOverlaySchema = z.object({
  id: z.string().min(1),
  stickerId: z.string().min(1),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  xNorm: z.number().min(0.05).max(0.95).default(0.5),
  yNorm: z.number().min(0.05).max(0.95).default(0.26),
  scale: z.number().min(0.3).max(2.5).default(1),
  rotationDeg: z.number().min(-180).max(180).default(0),
});
export type StickerOverlay = z.infer<typeof StickerOverlaySchema>;

export const AudioTrackSchema = z.object({
  id: z.string().min(1).optional(),
  kind: AudioCategorySchema.default("bgm"),
  assetId: z.string().min(1),
  title: z.string().optional(),
  timelineStartSec: z.number().min(0).default(0),
  durationSec: z.number().positive().optional(),
  startOffsetSec: z.number().min(0).default(0),
  volume: z.number().min(0).max(2).default(0.85),
  fadeInSec: z.number().min(0).max(5).default(0.25),
  fadeOutSec: z.number().min(0).max(8).default(0.8),
  beatMarkersSec: z.array(z.number().min(0)).default([]),
});
export type AudioTrack = z.infer<typeof AudioTrackSchema>;

export const CutProjectSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1).max(120),
  templateId: z.string().min(1),
  promptUsed: z.string().default(""),
  aiSummary: z.string().optional(),
  modeUsed: z.enum(["claude", "gemini", "offline", "template"]).default("offline"),
  aspectRatio: AspectRatioSchema.default("9:16"),
  fps: z.number().int().min(24).max(60).default(30),
  targetDurationSec: z.number().min(0.4).max(180).default(15),
  clips: z.array(ClipSlotSchema).min(1),
  overlays: z.array(TextOverlaySchema).default([]),
  stickers: z.array(StickerOverlaySchema).default([]),
  audioTrack: AudioTrackSchema.optional(),
  audioTracks: z.array(AudioTrackSchema).default([]),
});
export type CutProject = z.infer<typeof CutProjectSchema>;
export type CutProjectInput = z.input<typeof CutProjectSchema>;

export interface ComputedSlotLayout {
  slot: ClipSlot;
  index: number;
  rawDurationSec: number;
  effectiveTransitionInSec: number;
  timelineStartSec: number;
  timelineEndSec: number;
}

export interface ComputedTimelineLayout {
  slots: ComputedSlotLayout[];
  totalDurationSec: number;
}

export function getOverlayNormalizedPos(overlay: Pick<TextOverlay, "position" | "xNorm" | "yNorm">): {
  xNorm: number;
  yNorm: number;
} {
  const defaultY =
    overlay.position === "top" ? 0.14 : overlay.position === "center" ? 0.5 : 0.84;
  return {
    xNorm: overlay.xNorm ?? 0.5,
    yNorm: overlay.yNorm ?? defaultY,
  };
}

export function getProjectAudioTracks(
  project: Pick<CutProjectInput, "audioTrack" | "audioTracks">
): Array<AudioTrack & { id: string; kind: AudioCategory; timelineStartSec: number }> {
  const raw =
    project.audioTracks && project.audioTracks.length > 0
      ? project.audioTracks
      : project.audioTrack
        ? [project.audioTrack]
        : [];

  return raw.map((t, idx) => {
    const parsed = AudioTrackSchema.parse(t);
    return {
      ...parsed,
      id: parsed.id || `aud-${idx + 1}`,
      kind: parsed.kind || "bgm",
      timelineStartSec: parsed.timelineStartSec ?? 0,
    };
  });
}

export function getAspectDimensions(
  aspectRatio: AspectRatio,
  preset: "720p" | "1080p" = "1080p"
): { width: number; height: number } {
  const longSide = preset === "1080p" ? 1920 : 1280;
  const shortSide = preset === "1080p" ? 1080 : 720;

  switch (aspectRatio) {
    case "9:16":
      return { width: shortSide, height: longSide };
    case "16:9":
      return { width: longSide, height: shortSide };
    case "1:1":
      return { width: shortSide, height: shortSide };
  }
}

export function getSlotRawDuration(slot: ClipSlot): number {
  const sourceSpan = Math.max(0.2, slot.sourceEndSec - slot.sourceStartSec);
  const speed = Math.min(2.5, Math.max(0.5, slot.speed || 1));
  return Number((sourceSpan / speed).toFixed(3));
}

/**
 * Computes exact non-negative timeline placements shared by both the live
 * browser canvas preview and the FFmpeg xfade filter graph compiler.
 */
export function computeTimelineLayout(
  project: Pick<CutProject, "clips">
): ComputedTimelineLayout {
  const slots: ComputedSlotLayout[] = [];
  let cursorSec = 0;

  for (let i = 0; i < project.clips.length; i++) {
    const slot = project.clips[i];
    const rawDurationSec = getSlotRawDuration(slot);

    let effectiveTransitionInSec = 0;
    if (i > 0 && slot.transitionIn !== "cut") {
      const prevRaw = slots[i - 1].rawDurationSec;
      const maxAllowed = Math.min(prevRaw, rawDurationSec) * 0.4;
      effectiveTransitionInSec = Number(
        Math.min(Math.max(0, slot.transitionDurationSec), maxAllowed, 0.8).toFixed(3)
      );
      if (effectiveTransitionInSec < 0.08) {
        effectiveTransitionInSec = 0;
      }
    }

    const timelineStartSec = Number(
      Math.max(0, cursorSec - effectiveTransitionInSec).toFixed(3)
    );
    const timelineEndSec = Number((timelineStartSec + rawDurationSec).toFixed(3));

    slots.push({
      slot,
      index: i,
      rawDurationSec,
      effectiveTransitionInSec,
      timelineStartSec,
      timelineEndSec,
    });

    cursorSec = timelineEndSec;
  }

  return {
    slots,
    totalDurationSec: Number(cursorSec.toFixed(3)),
  };
}
