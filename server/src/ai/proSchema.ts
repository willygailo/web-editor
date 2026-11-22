import crypto from "node:crypto";
import {
  computeTimelineLayout,
  CutProjectSchema,
  getProjectAudioTracks,
  type AspectRatio,
  type AudioTrack,
  type AutoEditRequest,
  type CutProject,
  type CutProjectInput,
  type CutTemplatePreset,
  type MediaAsset,
  type PlatformPreset,
  type TextOverlay,
} from "@cutflow/shared";
import { resolveAiAudioTracks, resolveAiStickers, sanitizeCutProject } from "./sanitize.js";

export const PRO_EDL_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    templateId: { type: "string" },
    aiSummary: { type: "string" },
    aspectRatio: { type: "string", enum: ["9:16", "4:5", "16:9", "1:1"] },
    socialCaption: { type: "string" },
    hashtags: {
      type: "array",
      maxItems: 8,
      items: { type: "string" },
    },
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
          reversed: { type: "boolean" },
          label: { type: "string" },
          adjust: {
            type: "object",
            properties: {
              brightness: { type: "number" },
              contrast: { type: "number" },
              saturation: { type: "number" },
              warmth: { type: "number" },
              vignette: { type: "number" },
            },
          },
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
          animation: {
            type: "string",
            enum: ["none", "pop", "fade", "slide-up"],
          },
          yNorm: { type: "number" },
        },
        required: ["text", "startSec", "endSec", "position", "style"],
      },
    },
    audioAssetId: { type: "string" },
    sfxCues: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        properties: {
          assetId: { type: "string" },
          timelineStartSec: { type: "number" },
          volume: { type: "number" },
        },
        required: ["assetId", "timelineStartSec", "volume"],
      },
    },
  },
  required: ["title", "templateId", "aiSummary", "aspectRatio", "clips", "overlays"],
};

export interface ParsedProAiEdl {
  title: string;
  templateId: string;
  aiSummary: string;
  aspectRatio: AspectRatio;
  socialCaption?: string;
  hashtags?: string[];
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
    reversed?: boolean;
    label?: string;
    adjust?: CutProject["clips"][number]["adjust"];
  }>;
  overlays: Array<{
    text: string;
    startSec: number;
    endSec: number;
    position: CutProject["overlays"][number]["position"];
    style: CutProject["overlays"][number]["style"];
    animation?: TextOverlay["animation"];
    yNorm?: number;
  }>;
  audioAssetId?: string;
  sfxCues?: Array<{
    assetId: string;
    timelineStartSec: number;
    volume: number;
  }>;
}

export function resolvePlatformSettings(params: {
  platform?: PlatformPreset;
  explicitAspect?: AspectRatio;
  prompt: string;
  fallbackAspect?: AspectRatio;
}): { platform: PlatformPreset; aspectRatio: AspectRatio } {
  const { platform, explicitAspect, prompt, fallbackAspect = "9:16" } = params;
  const lower = prompt.toLowerCase();

  let resolvedPlatform: PlatformPreset = platform ?? "auto";
  if (resolvedPlatform === "auto") {
    if (/(instagram feed|ig feed|4:5|photo dump|ootd dump)/.test(lower)) {
      resolvedPlatform = "instagram-feed";
    } else if (/(ig reels|instagram reels|reels)/.test(lower)) {
      resolvedPlatform = "instagram-reels";
    } else if (/(youtube shorts|yt shorts|\bshorts\b)/.test(lower)) {
      resolvedPlatform = "youtube-shorts";
    } else if (/(16:9|youtube|landscape|widescreen|horizontal|vlog)/.test(lower) && !/(tiktok|reels|shorts)/.test(lower)) {
      resolvedPlatform = "youtube-landscape";
    } else if (/(1:1|shopee|lazada|product ad|promo|unboxing)/.test(lower)) {
      resolvedPlatform = "promo-ad";
    } else if (/(tiktok|fyp|viral|hook)/.test(lower)) {
      resolvedPlatform = "tiktok";
    }
  }

  let aspectRatio: AspectRatio = fallbackAspect;
  if (explicitAspect) {
    aspectRatio = explicitAspect;
  } else if (/(4:5|ig feed|instagram feed)/.test(lower) || resolvedPlatform === "instagram-feed") {
    aspectRatio = "4:5";
  } else if (/(16:9|widescreen|horizontal)/.test(lower) || resolvedPlatform === "youtube-landscape") {
    aspectRatio = "16:9";
  } else if (/(1:1|square|shopee|lazada)/.test(lower) || resolvedPlatform === "promo-ad") {
    aspectRatio = "1:1";
  } else if (
    /(9:16|tiktok|reels|shorts|portrait|vertical|story|myday)/.test(lower) ||
    resolvedPlatform === "tiktok" ||
    resolvedPlatform === "instagram-reels" ||
    resolvedPlatform === "youtube-shorts"
  ) {
    aspectRatio = "9:16";
  }

  return { platform: resolvedPlatform, aspectRatio };
}

export function buildProSystemInstruction(platform: PlatformPreset): string {
  const platformNote =
    platform === "tiktok"
      ? "Target Platform: TikTok (9:16). Lead with an immediate 1.0-1.6s scroll-stop hook + punch-zoom + pop SFX, keep energetic 0.8-1.6s beat cuts, keep text yNorm between 0.16 and 0.72 so TikTok bottom captions & right buttons never overlap text."
      : platform === "instagram-reels"
        ? "Target Platform: Instagram Reels (9:16). Crisp aesthetic pacing, smooth transitions or beat flashes, keep text yNorm between 0.16 and 0.72 away from Reels bottom UI."
        : platform === "instagram-feed"
          ? "Target Platform: Instagram Feed (4:5 portrait, 1080x1350). Balanced 1.6-2.8s aesthetic framing with cohesive warm/vivid color adjustments and clean minimal/pop captions."
          : platform === "youtube-shorts"
            ? "Target Platform: YouTube Shorts (9:16). Strong retention hook in first 2s, progressive beat callout captions (Point/Detail/Payoff), crisp yNorm between 0.16 and 0.72."
            : platform === "youtube-landscape"
              ? "Target Platform: YouTube 16:9 Landscape. Cinematic storytelling, intentional 2.2-4.0s shots, smooth crossfades, subtle film/cinematic color grading, and uncluttered lower-third captions."
              : platform === "promo-ad"
                ? "Target Platform: E-Commerce / Social Promo Ad (1:1 or 9:16). Fast product reveal in first 1.5s, feature highlight beats, clear CTA overlay, and crisp SFX hits."
                : "Auto-select optimal social platform pacing (TikTok/Reels/Shorts/IG/YouTube) matching user prompt.";

  return [
    "You are an award-winning CapCut-style social video director AI (TikTok, Instagram Reels/Feed, YouTube Shorts).",
    platformNote,
    "Direct edits using a clear 3-act rhythm: (1) Scroll-stop Hook (0-2s), (2) Beat-synced Body avoiding silenceRanges and prioritizing visualHighlightsSec / energyPeaksSec, (3) Climax + Payoff/CTA.",
    "Use subtle cohesive color adjust (contrast/warmth/vignette), varied motions (punch-zoom, zoom-in, pan-left/right, zoom-out), and timed sfxCues from Available SFX Tracks (e.g. pop on hook reveal, whoosh on slide/zoom transitions, bass-drop on climax, shutter on flash-white).",
    "Create 2-4 crisp paced overlays with animation (pop/slide-up/fade) in the prompt's language (English/Tagalog/Taglish), plus a ready-to-post socialCaption and 3-6 relevant hashtags. Keep sourceStartSec and sourceEndSec strictly within each asset's durationSec.",
  ].join(" ");
}

export function buildProDirectorPromptPayload(params: {
  request: AutoEditRequest;
  visualAssets: MediaAsset[];
  assetsById: Map<string, MediaAsset>;
  selectedAudio?: MediaAsset;
  templates: CutTemplatePreset[];
  resolvedPlatform: PlatformPreset;
  resolvedAspect: AspectRatio;
}): string {
  const {
    request,
    visualAssets,
    assetsById,
    selectedAudio,
    templates,
    resolvedPlatform,
    resolvedAspect,
  } = params;

  const musicAssets = Array.from(assetsById.values()).filter(
    (a) => a.kind === "audio" && a.audioCategory !== "sfx" && a.audioCategory !== "voiceover"
  );
  const sfxAssets = Array.from(assetsById.values()).filter(
    (a) => a.kind === "audio" && a.audioCategory === "sfx"
  );

  const assetManifest = visualAssets.map((a) => ({
    assetId: a.id,
    name: a.originalName,
    kind: a.kind,
    durationSec: a.durationSec,
    dimensions: a.width && a.height ? `${a.width}x${a.height}` : "unknown",
    visualHighlightsSec: (a.visualHighlightsSec ?? []).slice(0, 12),
    energyPeaksSec: (a.energyPeaksSec ?? []).slice(0, 12),
    silenceRanges: (a.silenceRanges ?? []).slice(0, 8),
  }));

  const musicManifest = musicAssets.map((a) => ({
    assetId: a.id,
    title: a.originalName,
    durationSec: a.durationSec,
    beatMarkersSec: a.beatMarkersSec.slice(0, 32),
    energyPeaksSec: a.energyPeaksSec.slice(0, 6),
  }));

  const sfxManifest = sfxAssets.map((a) => ({
    assetId: a.id,
    title: a.originalName,
    durationSec: a.durationSec,
  }));

  const templateSummary = templates.map((t) => ({
    id: t.id,
    name: t.name,
    tagline: t.tagline,
    defaultAspectRatio: t.defaultAspectRatio,
    bpm: t.bpm,
    isCustom: Boolean(t.isCustom),
  }));

  return [
    `User Request: "${request.prompt}"`,
    `Target Platform: ${resolvedPlatform} | Target Aspect Ratio: ${resolvedAspect}`,
    request.templateId ? `Preferred Template ID: ${request.templateId}` : "",
    request.targetDurationSec ? `Target Duration: ${request.targetDurationSec}s` : "",
    selectedAudio ? `Preferred BGM Audio Asset ID: ${selectedAudio.id}` : "",
    `Available Visual Assets:\n${JSON.stringify(assetManifest, null, 2)}`,
    `Available Music Tracks:\n${JSON.stringify(musicManifest, null, 2)}`,
    `Available SFX Tracks:\n${JSON.stringify(sfxManifest, null, 2)}`,
    `Cut Template Presets:\n${JSON.stringify(templateSummary, null, 2)}`,
    request.previousProject
      ? `Previous Edit JSON (modify according to user's follow-up prompt):\n${JSON.stringify(request.previousProject)}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function clampAiOverlaysToSafeZones(
  overlays: TextOverlay[],
  aspectRatio: AspectRatio
): TextOverlay[] {
  const maxY = aspectRatio === "9:16" ? 0.72 : aspectRatio === "4:5" ? 0.78 : 0.86;
  const minY = aspectRatio === "9:16" ? 0.16 : 0.12;
  return overlays.map((ov) => {
    const rawY =
      ov.yNorm ??
      (ov.position === "top" ? 0.18 : ov.position === "center" ? 0.48 : maxY);
    const safeY = Number(Math.max(minY, Math.min(maxY, rawY)).toFixed(3));
    return {
      ...ov,
      xNorm: ov.xNorm ?? 0.5,
      yNorm: safeY,
    };
  });
}

export function mergeAiSfxTracks(params: {
  baseTracks: AudioTrack[];
  sfxCues?: ParsedProAiEdl["sfxCues"];
  assetsById: Map<string, MediaAsset>;
  totalDurationSec: number;
  hasPreviousProject: boolean;
}): AudioTrack[] {
  const { baseTracks, sfxCues, assetsById, totalDurationSec, hasPreviousProject } = params;
  // On Remix, keep user's curated audio & SFX unless no SFX exist yet
  const alreadyHasSfx = baseTracks.some((t) => t.kind === "sfx");
  if ((hasPreviousProject && alreadyHasSfx) || !sfxCues?.length) {
    return baseTracks;
  }

  const addedSfx: AudioTrack[] = [];
  let lastSfxSec = -1;
  for (const cue of sfxCues.slice(0, 6)) {
    const asset = assetsById.get(cue.assetId);
    if (!asset || asset.kind !== "audio" || asset.audioCategory !== "sfx") continue;
    const startSec = Number(
      Math.max(0, Math.min(Math.max(0, totalDurationSec - 0.25), cue.timelineStartSec)).toFixed(2)
    );
    if (startSec - lastSfxSec < 0.35) continue;
    lastSfxSec = startSec;

    addedSfx.push({
      id: `aud-sfx-ai-${addedSfx.length + 1}`,
      kind: "sfx",
      assetId: asset.id,
      title: asset.originalName,
      timelineStartSec: startSec,
      durationSec: Number(Math.min(asset.durationSec, totalDurationSec - startSec).toFixed(2)),
      startOffsetSec: 0,
      volume: Number(Math.max(0.2, Math.min(1.0, cue.volume || 0.55)).toFixed(2)),
      fadeInSec: 0.02,
      fadeOutSec: 0.08,
      beatMarkersSec: [],
    });
  }

  return [...baseTracks, ...addedSfx];
}

export function assembleProAiCutProject(params: {
  parsed: ParsedProAiEdl;
  request: AutoEditRequest;
  modeUsed: "claude" | "gemini";
  assetsById: Map<string, MediaAsset>;
  selectedAudio?: MediaAsset;
  fallbackSummary: string;
  initialWarnings?: string[];
}): { project: CutProject; warnings: string[] } {
  const {
    parsed,
    request,
    modeUsed,
    assetsById,
    selectedAudio,
    fallbackSummary,
    initialWarnings = [],
  } = params;

  const { platform, aspectRatio } = resolvePlatformSettings({
    platform: request.platform,
    explicitAspect: request.aspectRatio ?? parsed.aspectRatio,
    prompt: request.prompt,
  });

  const clips = (parsed.clips || []).map((c, idx) => ({
    ...c,
    id: `slot-${idx + 1}`,
    reversed: Boolean(c.reversed),
    adjust: c.adjust
      ? {
          brightness: Math.max(-0.4, Math.min(0.4, c.adjust.brightness ?? 0)),
          contrast: Math.max(-0.4, Math.min(0.45, c.adjust.contrast ?? 0)),
          saturation: Math.max(-0.8, Math.min(0.8, c.adjust.saturation ?? 0)),
          warmth: Math.max(-0.4, Math.min(0.4, c.adjust.warmth ?? 0)),
          vignette: Math.max(0, Math.min(0.85, c.adjust.vignette ?? 0)),
        }
      : undefined,
  }));
  const approxTotalSec =
    clips.length > 0
      ? computeTimelineLayout({ clips }).totalDurationSec
      : request.targetDurationSec ?? 15;

  const chosenAudio =
    (parsed.audioAssetId ? assetsById.get(parsed.audioAssetId) : undefined) ??
    selectedAudio;

  const baseTracks = resolveAiAudioTracks({
    previousProject: request.previousProject,
    chosenBgm: chosenAudio,
    totalDurationSec: approxTotalSec,
  });
  const mergedTracks = mergeAiSfxTracks({
    baseTracks,
    sfxCues: parsed.sfxCues,
    assetsById,
    totalDurationSec: approxTotalSec,
    hasPreviousProject: Boolean(request.previousProject),
  });
  const preservedStickers = resolveAiStickers({
    previousProject: request.previousProject,
    prompt: request.prompt,
  });

  const overlays = clampAiOverlaysToSafeZones(
    (parsed.overlays || []).map((o, idx) => ({
      id: `txt-${idx + 1}`,
      text: o.text,
      startSec: o.startSec,
      endSec: o.endSec,
      position: o.position,
      style: o.style,
      scale: 1,
      rotationDeg: 0,
      animation: o.animation ?? "pop",
      yNorm: o.yNorm,
    })),
    aspectRatio
  );

  const normalizedHashtags = (parsed.hashtags || [])
    .map((h) => h.trim())
    .filter(Boolean)
    .map((h) => (h.startsWith("#") ? h : `#${h.replace(/\s+/g, "")}`).slice(0, 40))
    .slice(0, 8);

  const draft: CutProjectInput = {
    id: request.previousProject?.id ?? crypto.randomUUID(),
    title: parsed.title || "AI Cut Edit",
    templateId: parsed.templateId || "tiktok-viral-hook",
    promptUsed: request.prompt,
    aiSummary: parsed.aiSummary || fallbackSummary,
    platform,
    socialCaption: parsed.socialCaption?.trim().slice(0, 400) || undefined,
    hashtags: normalizedHashtags.length > 0 ? normalizedHashtags : undefined,
    modeUsed,
    aspectRatio,
    fps: 30,
    targetDurationSec: request.targetDurationSec ?? approxTotalSec,
    clips,
    overlays,
    stickers: preservedStickers,
    audioTrack: mergedTracks[0],
    audioTracks: mergedTracks,
  };

  const sanitized = sanitizeCutProject(draft, assetsById);
  return {
    project: CutProjectSchema.parse(sanitized.project),
    warnings: [...initialWarnings, ...sanitized.warnings],
  };
}
