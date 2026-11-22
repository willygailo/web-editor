import { z } from "zod";
import {
  AspectRatioSchema,
  ClipAdjustSchema,
  ClipTransformSchema,
  computeTimelineLayout,
  FilterPresetSchema,
  MotionPresetSchema,
  OverlayPositionSchema,
  OverlayStyleSchema,
  StickerOverlaySchema,
  TransitionTypeSchema,
  type AspectRatio,
  type AudioTrack,
  type ClipSlot,
  type CutProject,
  type FilterPreset,
  type MediaAsset,
  type MotionPreset,
  type OverlayPosition,
  type OverlayStyle,
  type StickerOverlay,
  type TextOverlay,
  type TransitionType,
} from "./edl.js";

export const TemplateSlotBlueprintSchema = z.object({
  durationSec: z.number().min(0.4).max(15),
  motion: MotionPresetSchema.default("zoom-in"),
  transitionIn: TransitionTypeSchema.default("cut"),
  transitionDurationSec: z.number().min(0).max(0.8).default(0.25),
  filter: FilterPresetSchema.default("none"),
  speed: z.number().min(0.5).max(2.5).default(1),
  reversed: z.boolean().optional(),
  adjust: ClipAdjustSchema.optional(),
  transform: ClipTransformSchema.optional(),
  label: z.string().default("Clip"),
});
export type TemplateSlotBlueprint = z.infer<typeof TemplateSlotBlueprintSchema>;

export const TemplateOverlayBlueprintSchema = z.object({
  text: z.string().min(1).max(160),
  startSec: z.number().min(0),
  endSec: z.number().positive(),
  position: OverlayPositionSchema.default("center"),
  style: OverlayStyleSchema.default("capcut-pop"),
  xNorm: z.number().min(0.05).max(0.95).optional(),
  yNorm: z.number().min(0.05).max(0.95).optional(),
  scale: z.number().min(0.4).max(2.5).optional(),
  rotationDeg: z.number().min(-180).max(180).optional(),
  color: z.string().optional(),
  bgColor: z.string().optional(),
  animation: z.enum(["none", "pop", "fade", "slide-up"]).optional(),
});
export type TemplateOverlayBlueprint = z.infer<typeof TemplateOverlayBlueprintSchema>;

export const TemplateStickerBlueprintSchema = StickerOverlaySchema.omit({ id: true });
export type TemplateStickerBlueprint = z.infer<typeof TemplateStickerBlueprintSchema>;

export const CutTemplatePresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  tagline: z.string().max(180),
  badge: z.string().max(40),
  defaultAspectRatio: AspectRatioSchema,
  defaultDurationSec: z.number().min(1).max(180),
  bpm: z.number().min(50).max(200),
  minClipSec: z.number().min(0.4).max(10),
  maxClipSec: z.number().min(0.5).max(15),
  motions: z.array(MotionPresetSchema),
  transitions: z.array(TransitionTypeSchema),
  transitionDurationSec: z.number().min(0).max(0.8),
  filter: FilterPresetSchema,
  overlayStyle: OverlayStyleSchema,
  defaultHookText: z.string(),
  keywords: z.array(z.string()).default([]),
  accentColor: z.string().default("#22d3ee"),
  defaultAudioId: z.string().optional(),
  slots: z.array(TemplateSlotBlueprintSchema).default([]),
  overlays: z.array(TemplateOverlayBlueprintSchema).default([]),
  stickers: z.array(TemplateStickerBlueprintSchema).optional(),
  isCustom: z.boolean().default(false),
});
export type CutTemplatePreset = z.infer<typeof CutTemplatePresetSchema>;

export const CUT_TEMPLATE_PRESETS: CutTemplatePreset[] = [
  {
    id: "hype-zoom",
    name: "Hype Beat Zoom",
    tagline: "Fast TikTok/Reels cuts with punch zoom & flash transitions",
    badge: "Viral Reels",
    defaultAspectRatio: "9:16",
    defaultDurationSec: 10,
    bpm: 128,
    minClipSec: 0.9,
    maxClipSec: 1.7,
    motions: ["punch-zoom", "zoom-in", "zoom-out", "punch-zoom"],
    transitions: ["zoom-blur", "flash-white", "slide-left"],
    transitionDurationSec: 0.22,
    filter: "vivid",
    overlayStyle: "bold-hook",
    defaultHookText: "WAIT FOR THE DROP",
    keywords: ["hype", "tiktok", "reels", "mabilis", "fast", "zoom", "drop", "party", "dance", "edit"],
    accentColor: "#ff4d6d",
    defaultAudioId: "builtin-beat-hype-128",
    isCustom: false,
    slots: [
      { durationSec: 1.8, motion: "zoom-in", transitionIn: "cut", transitionDurationSec: 0, filter: "vivid", speed: 1, label: "Intro Hook" },
      { durationSec: 1.4, motion: "punch-zoom", transitionIn: "flash-white", transitionDurationSec: 0.2, filter: "vivid", speed: 1.1, label: "Beat Drop 1" },
      { durationSec: 1.2, motion: "zoom-out", transitionIn: "zoom-blur", transitionDurationSec: 0.22, filter: "vivid", speed: 1.15, label: "Beat Drop 2" },
      { durationSec: 1.4, motion: "punch-zoom", transitionIn: "slide-left", transitionDurationSec: 0.22, filter: "vivid", speed: 1.1, label: "Climax" },
      { durationSec: 1.8, motion: "zoom-in", transitionIn: "flash-white", transitionDurationSec: 0.2, filter: "vivid", speed: 1, label: "Outro" },
    ],
    overlays: [
      { text: "WAIT FOR THE DROP", startSec: 0.15, endSec: 2.0, position: "center", style: "bold-hook" },
    ],
  },
  {
    id: "chill-vlog",
    name: "Chill Travel Vlog",
    tagline: "Warm film tones, smooth pans, and laid-back pacing",
    badge: "Aesthetic",
    defaultAspectRatio: "9:16",
    defaultDurationSec: 12,
    bpm: 92,
    minClipSec: 2.0,
    maxClipSec: 3.4,
    motions: ["zoom-in", "pan-right", "zoom-out", "pan-left"],
    transitions: ["crossfade"],
    transitionDurationSec: 0.4,
    filter: "warm-film",
    overlayStyle: "minimal-caption",
    defaultHookText: "weekend escape",
    keywords: ["chill", "vlog", "travel", "beach", "aesthetic", "relax", "smooth", "warm", "day in my life"],
    accentColor: "#f59e0b",
    defaultAudioId: "builtin-beat-chill-92",
    isCustom: false,
    slots: [
      { durationSec: 3.0, motion: "zoom-in", transitionIn: "cut", transitionDurationSec: 0, filter: "warm-film", speed: 1, label: "Establishing" },
      { durationSec: 3.0, motion: "pan-right", transitionIn: "crossfade", transitionDurationSec: 0.4, filter: "warm-film", speed: 1, label: "Vibe Moment" },
      { durationSec: 3.0, motion: "pan-left", transitionIn: "crossfade", transitionDurationSec: 0.4, filter: "warm-film", speed: 1, label: "Golden Detail" },
      { durationSec: 3.2, motion: "zoom-out", transitionIn: "crossfade", transitionDurationSec: 0.4, filter: "warm-film", speed: 1, label: "Sunset Outro" },
    ],
    overlays: [
      { text: "weekend escape", startSec: 0.3, endSec: 3.2, position: "bottom", style: "minimal-caption" },
    ],
  },
  {
    id: "beat-flash",
    name: "Beat Flash Sync",
    tagline: "Ultra-snappy montage locked to rhythmic beat drops",
    badge: "135 BPM",
    defaultAspectRatio: "9:16",
    defaultDurationSec: 9,
    bpm: 135,
    minClipSec: 0.65,
    maxClipSec: 1.15,
    motions: ["punch-zoom", "zoom-in"],
    transitions: ["flash-white", "cut", "flash-white"],
    transitionDurationSec: 0.16,
    filter: "vivid",
    overlayStyle: "neon-badge",
    defaultHookText: "ON THE BEAT",
    keywords: ["beat", "flash", "montage", "sync", "gym", "gaming", "highlights", "action", "astig"],
    accentColor: "#22d3ee",
    defaultAudioId: "builtin-beat-flash-135",
    isCustom: false,
    slots: [
      { durationSec: 1.3, motion: "punch-zoom", transitionIn: "cut", transitionDurationSec: 0, filter: "vivid", speed: 1.2, label: "Hit 1" },
      { durationSec: 1.1, motion: "zoom-in", transitionIn: "flash-white", transitionDurationSec: 0.16, filter: "vivid", speed: 1.2, label: "Hit 2" },
      { durationSec: 1.1, motion: "punch-zoom", transitionIn: "flash-white", transitionDurationSec: 0.16, filter: "vivid", speed: 1.2, label: "Hit 3" },
      { durationSec: 1.1, motion: "zoom-out", transitionIn: "cut", transitionDurationSec: 0, filter: "vivid", speed: 1.2, label: "Hit 4" },
      { durationSec: 1.2, motion: "punch-zoom", transitionIn: "flash-white", transitionDurationSec: 0.16, filter: "vivid", speed: 1.2, label: "Hit 5" },
      { durationSec: 1.5, motion: "zoom-in", transitionIn: "zoom-blur", transitionDurationSec: 0.2, filter: "vivid", speed: 1, label: "Final Drop" },
    ],
    overlays: [
      { text: "ON THE BEAT", startSec: 0.1, endSec: 2.2, position: "top", style: "neon-badge" },
    ],
  },
  {
    id: "cinematic-story",
    name: "Cinematic Story",
    tagline: "Widescreen moody color grade with gentle crossfades",
    badge: "16:9 Film",
    defaultAspectRatio: "16:9",
    defaultDurationSec: 14,
    bpm: 80,
    minClipSec: 2.4,
    maxClipSec: 4.2,
    motions: ["zoom-out", "pan-left", "zoom-in", "pan-right"],
    transitions: ["crossfade"],
    transitionDurationSec: 0.5,
    filter: "cinematic",
    overlayStyle: "minimal-caption",
    defaultHookText: "CHAPTER ONE",
    keywords: ["cinematic", "movie", "film", "story", "landscape", "youtube", "moody", "dramatic"],
    accentColor: "#a78bfa",
    defaultAudioId: "builtin-beat-chill-92",
    isCustom: false,
    slots: [
      { durationSec: 3.6, motion: "zoom-out", transitionIn: "cut", transitionDurationSec: 0, filter: "cinematic", speed: 0.9, label: "Opening Wide" },
      { durationSec: 3.4, motion: "pan-left", transitionIn: "crossfade", transitionDurationSec: 0.5, filter: "cinematic", speed: 1, label: "Middle Scene" },
      { durationSec: 3.4, motion: "zoom-in", transitionIn: "crossfade", transitionDurationSec: 0.5, filter: "cinematic", speed: 1, label: "Close Focus" },
      { durationSec: 3.8, motion: "pan-right", transitionIn: "crossfade", transitionDurationSec: 0.5, filter: "cinematic", speed: 0.9, label: "Closing Shot" },
    ],
    overlays: [
      { text: "CHAPTER ONE", startSec: 0.4, endSec: 3.5, position: "center", style: "minimal-caption" },
    ],
  },
  {
    id: "product-showcase",
    name: "Smart Product Ad",
    tagline: "Punchy e-commerce showcase with slide transitions & CTA hook",
    badge: "Promo / Ad",
    defaultAspectRatio: "1:1",
    defaultDurationSec: 10,
    bpm: 118,
    minClipSec: 1.2,
    maxClipSec: 2.2,
    motions: ["zoom-in", "punch-zoom", "pan-right"],
    transitions: ["slide-left", "zoom-blur"],
    transitionDurationSec: 0.24,
    filter: "vivid",
    overlayStyle: "capcut-pop",
    defaultHookText: "MUST HAVE THIS",
    keywords: ["product", "ad", "promo", "shop", "sale", "food", "review", "unboxing", "square"],
    accentColor: "#10b981",
    defaultAudioId: "builtin-beat-hype-128",
    isCustom: false,
    slots: [
      { durationSec: 2.0, motion: "punch-zoom", transitionIn: "cut", transitionDurationSec: 0, filter: "vivid", speed: 1, label: "Product Hook" },
      { durationSec: 1.8, motion: "zoom-in", transitionIn: "slide-left", transitionDurationSec: 0.24, filter: "vivid", speed: 1, label: "Feature 1" },
      { durationSec: 1.8, motion: "pan-right", transitionIn: "slide-left", transitionDurationSec: 0.24, filter: "vivid", speed: 1, label: "Feature 2" },
      { durationSec: 2.2, motion: "zoom-out", transitionIn: "zoom-blur", transitionDurationSec: 0.24, filter: "vivid", speed: 1, label: "Call To Action" },
    ],
    overlays: [
      { text: "MUST HAVE THIS", startSec: 0.15, endSec: 2.4, position: "top", style: "capcut-pop" },
    ],
  },
];

export function getTemplatePresetById(
  id?: string,
  allTemplates: CutTemplatePreset[] = CUT_TEMPLATE_PRESETS
): CutTemplatePreset {
  return (
    allTemplates.find((preset) => preset.id === id) ??
    CUT_TEMPLATE_PRESETS.find((preset) => preset.id === id) ??
    CUT_TEMPLATE_PRESETS[0]
  );
}

/**
 * Instantiates a ready-to-edit CutProject from a template's concrete slots
 * and user-selected clip assignments (CapCut "Use Template" workflow).
 */
export function buildProjectFromTemplate(params: {
  template: CutTemplatePreset;
  slotAssetIds: string[];
  assetsById: Map<string, MediaAsset>;
  audioAsset?: MediaAsset;
  customTexts?: string[];
  projectId: string;
}): CutProject {
  const { template, slotAssetIds, assetsById, audioAsset, customTexts, projectId } = params;
  const visualFallback = Array.from(assetsById.values()).filter((a) => a.kind !== "audio");

  const blueprints =
    template.slots.length > 0
      ? template.slots
      : [
          {
            durationSec: 2.5,
            motion: template.motions[0] ?? "zoom-in",
            transitionIn: "cut" as const,
            transitionDurationSec: 0,
            filter: template.filter,
            speed: 1,
            label: "Clip 1",
          },
          {
            durationSec: 2.5,
            motion: template.motions[1] ?? "punch-zoom",
            transitionIn: template.transitions[0] ?? "crossfade",
            transitionDurationSec: template.transitionDurationSec,
            filter: template.filter,
            speed: 1,
            label: "Clip 2",
          },
        ];

  const clips: ClipSlot[] = blueprints.map((bp, idx) => {
    const requestedId = slotAssetIds[idx % Math.max(1, slotAssetIds.length)];
    const asset =
      (requestedId ? assetsById.get(requestedId) : undefined) ??
      visualFallback[idx % Math.max(1, visualFallback.length)];

    if (!asset) {
      throw new Error("At least one visual clip is required to use a template.");
    }

    const sourceSpan = Math.min(
      asset.durationSec,
      Math.max(0.4, bp.durationSec * (bp.speed || 1))
    );

    return {
      id: `slot-${idx + 1}`,
      assetId: asset.id,
      sourceStartSec: 0,
      sourceEndSec: Number(sourceSpan.toFixed(2)),
      speed: bp.speed || 1,
      motion: bp.motion,
      transitionIn: idx === 0 ? "cut" : bp.transitionIn,
      transitionDurationSec: idx === 0 ? 0 : bp.transitionDurationSec,
      filter: bp.filter,
      muteOriginalAudio: Boolean(audioAsset),
      volume: audioAsset ? 0 : 1,
      reversed: Boolean(bp.reversed && asset.kind === "video"),
      adjust: bp.adjust,
      transform: bp.transform,
      label: bp.label || `Slot ${idx + 1}`,
    };
  });

  const layout = computeTimelineLayout({ clips });
  const totalSec = Math.max(0.6, layout.totalDurationSec);

  const overlays: TextOverlay[] = (
    template.overlays.length > 0
      ? template.overlays
      : [
          {
            text: template.defaultHookText,
            startSec: 0.2,
            endSec: Math.min(totalSec, 2.8),
            position: "center" as OverlayPosition,
            style: template.overlayStyle as OverlayStyle,
          },
        ]
  ).map((ov, idx) => {
    const startSec = Number(Math.max(0, Math.min(totalSec - 0.4, ov.startSec)).toFixed(2));
    const endSec = Number(Math.min(totalSec, Math.max(startSec + 0.4, ov.endSec)).toFixed(2));
    return {
      id: `txt-${idx + 1}`,
      text: (customTexts?.[idx]?.trim() || ov.text).slice(0, 160),
      startSec,
      endSec,
      position: ov.position,
      style: ov.style,
      xNorm: ov.xNorm,
      yNorm: ov.yNorm,
      scale: ov.scale ?? 1,
      rotationDeg: ov.rotationDeg ?? 0,
      color: ov.color,
      bgColor: ov.bgColor,
      animation: ov.animation ?? "pop",
    };
  });

  const stickers: StickerOverlay[] = (template.stickers || []).map((st, idx) => {
    const startSec = Number(Math.max(0, Math.min(totalSec - 0.35, st.startSec)).toFixed(2));
    const endSec = Number(Math.min(totalSec, Math.max(startSec + 0.35, st.endSec)).toFixed(2));
    return {
      ...st,
      id: `stk-${idx + 1}`,
      startSec,
      endSec,
    };
  });

  const resolvedAudio =
    audioAsset ??
    (template.defaultAudioId ? assetsById.get(template.defaultAudioId) : undefined);

  const audioTracks: AudioTrack[] =
    resolvedAudio && resolvedAudio.kind === "audio"
      ? [
          {
            id: "aud-bgm-1",
            kind: "bgm",
            assetId: resolvedAudio.id,
            title: resolvedAudio.originalName,
            timelineStartSec: 0,
            durationSec: totalSec,
            startOffsetSec: 0,
            volume: 0.85,
            fadeInSec: 0.25,
            fadeOutSec: 0.8,
            beatMarkersSec: resolvedAudio.beatMarkersSec,
          },
        ]
      : [];

  return {
    id: projectId,
    title: template.name,
    templateId: template.id,
    promptUsed: `Template: ${template.name}`,
    aiSummary: `Applied "${template.name}" (${clips.length} customizable slots, ${template.defaultAspectRatio}).`,
    modeUsed: "template",
    aspectRatio: template.defaultAspectRatio as AspectRatio,
    fps: 30,
    targetDurationSec: totalSec,
    clips,
    overlays,
    stickers,
    audioTrack: audioTracks[0],
    audioTracks,
  };
}

export function extractTemplateFromProject(
  project: CutProject,
  name: string,
  tagline = "Custom reusable cut template"
): Omit<CutTemplatePreset, "id"> {
  const layout = computeTimelineLayout(project);
  const firstSlot = project.clips[0];
  const mainAudio = project.audioTracks?.[0] ?? project.audioTrack;

  return {
    name: name.trim().slice(0, 80) || "My Cut Template",
    tagline: tagline.trim().slice(0, 180),
    badge: "My Template",
    defaultAspectRatio: project.aspectRatio,
    defaultDurationSec: Math.max(3, Math.round(layout.totalDurationSec)),
    bpm: 120,
    minClipSec: 0.6,
    maxClipSec: 6.0,
    motions: Array.from(new Set(project.clips.map((c) => c.motion))),
    transitions: Array.from(new Set(project.clips.map((c) => c.transitionIn))),
    transitionDurationSec: firstSlot?.transitionDurationSec ?? 0.25,
    filter: firstSlot?.filter ?? "none",
    overlayStyle: project.overlays[0]?.style ?? "capcut-pop",
    defaultHookText: project.overlays[0]?.text ?? "MY EDIT",
    keywords: ["custom"],
    accentColor: "#22d3ee",
    defaultAudioId: mainAudio?.assetId,
    isCustom: true,
    slots: layout.slots.map((sl, idx) => ({
      durationSec: Number(Math.max(0.4, sl.rawDurationSec).toFixed(2)),
      motion: sl.slot.motion as MotionPreset,
      transitionIn: sl.slot.transitionIn as TransitionType,
      transitionDurationSec: sl.slot.transitionDurationSec,
      filter: sl.slot.filter as FilterPreset,
      speed: sl.slot.speed,
      reversed: sl.slot.reversed,
      adjust: sl.slot.adjust,
      transform: sl.slot.transform,
      label: sl.slot.label || `Slot ${idx + 1}`,
    })),
    overlays: project.overlays
      .filter((o) => o.text.trim().length > 0)
      .map((o) => ({
        text: o.text.trim(),
        startSec: o.startSec,
        endSec: o.endSec,
        position: o.position,
        style: o.style,
        xNorm: o.xNorm,
        yNorm: o.yNorm,
        scale: o.scale,
        rotationDeg: o.rotationDeg,
        color: o.color,
        bgColor: o.bgColor,
        animation: o.animation,
      })),
    stickers: (project.stickers || []).map(({ id: _ignored, ...rest }) => rest),
  };
}
