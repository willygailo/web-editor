import crypto from "node:crypto";
import {
  buildProjectFromTemplate,
  computeTimelineLayout,
  CUT_TEMPLATE_PRESETS,
  getProjectAudioTracks,
  getTemplatePresetById,
  type AutoEditRequest,
  type ClipAdjust,
  type ClipSlot,
  type CutProjectInput,
  type CutProject,
  type CutTemplatePreset,
  type MediaAsset,
  type PlatformPreset,
  type TextOverlay,
} from "@cutflow/shared";
import {
  clampAiOverlaysToSafeZones,
  mergeAiSfxTracks,
  resolvePlatformSettings,
} from "./proSchema.js";
import { resolveAiAudioTracks, resolveAiStickers, sanitizeCutProject } from "./sanitize.js";

function pickTemplateFromPrompt(
  prompt: string,
  explicitId: string | undefined,
  platform: PlatformPreset,
  allTemplates: CutTemplatePreset[]
): CutTemplatePreset {
  if (explicitId) return getTemplatePresetById(explicitId, allTemplates);
  const lower = prompt.toLowerCase();

  let bestPreset = allTemplates[0] ?? CUT_TEMPLATE_PRESETS[0];
  let bestScore = -1;

  for (const preset of allTemplates) {
    let score = 0;
    for (const kw of preset.keywords) {
      if (lower.includes(kw)) score += 2;
    }
    if (platform === "instagram-feed" && preset.id === "ig-feed-aesthetic") score += 3;
    if (platform === "tiktok" && preset.id === "tiktok-viral-hook") score += 3;
    if (platform === "youtube-shorts" && preset.id === "yt-shorts-explainer") score += 3;
    if (platform === "youtube-landscape" && preset.id === "cinematic-story") score += 3;
    if (platform === "promo-ad" && preset.id === "product-showcase") score += 3;
    if (score > bestScore) {
      bestScore = score;
      bestPreset = preset;
    }
  }

  return bestPreset;
}

function inferTargetDuration(
  prompt: string,
  explicit: number | undefined,
  preset: CutTemplatePreset,
  platform: PlatformPreset
): number {
  if (explicit) return explicit;
  const secMatch = /\b(\d{1,3})\s*(?:s|sec|secs|second|seconds)\b/i.exec(prompt);
  if (secMatch) {
    return Math.min(90, Math.max(4, Number(secMatch[1])));
  }
  const minMatch = /\b(\d{1})\s*(?:m|min|mins|minute|minutes)\b/i.exec(prompt);
  if (minMatch) {
    return Math.min(90, Math.max(15, Number(minMatch[1]) * 60));
  }
  if (platform === "tiktok" || platform === "instagram-reels") {
    return Math.max(9, preset.defaultDurationSec);
  }
  return preset.defaultDurationSec;
}

function extractHookText(prompt: string, preset: CutTemplatePreset): string | null {
  const lower = prompt.toLowerCase();
  if (/(no text|walang text|remove text|no caption)/.test(lower)) return null;

  const quoted = /["']([^"']{2,60})["']/.exec(prompt);
  if (quoted) return quoted[1].trim();

  const textDirective = /(?:text|title|hook|caption)\s*[:=-]\s*([^\n,.]+)/i.exec(prompt);
  if (textDirective) return textDirective[1].trim();

  const cleaned = prompt
    .replace(
      /\b(gawa ka ng|gawan mo ng|make|create|edit|video|cut|template|with|na|ng|for|sa|ang|yung|mga|please|pls|tiktok|reels|instagram|ig|shorts|youtube|feed)\b/gi,
      " "
    )
    .replace(/\b\d+\s*(s|sec|secs|second|seconds|m|min)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (cleaned.length >= 4 && cleaned.length <= 36) {
    return cleaned.toUpperCase();
  }
  return preset.defaultHookText;
}

function findBestSegmentInAsset(
  asset: MediaAsset,
  desiredDuration: number,
  cursorHint: number
): { startSec: number; endSec: number } {
  if (asset.kind === "image") {
    return { startSec: 0, endSec: Math.min(6, Math.max(0.8, desiredDuration)) };
  }

  const maxDur = asset.durationSec;
  const clipLen = Math.min(maxDur, Math.max(0.5, desiredDuration));

  // Prioritize visual scene/action peaks on muted B-roll + audio energy peaks on sound clips
  const combinedPeaks = Array.from(
    new Set([...(asset.visualHighlightsSec ?? []), ...(asset.energyPeaksSec ?? [])])
  ).sort((a, b) => a - b);

  const candidateStarts: number[] = [];
  for (const peak of combinedPeaks) {
    if (peak + 0.15 < cursorHint && combinedPeaks.some((p) => p >= cursorHint)) continue;
    const start = Math.max(0, Math.min(maxDur - clipLen, peak - 0.15));
    candidateStarts.push(start);
  }
  candidateStarts.push(Math.max(0, Math.min(maxDur - clipLen, cursorHint % Math.max(0.5, maxDur))));

  for (const start of candidateStarts) {
    const end = start + clipLen;
    const mostlySilent = asset.silenceRanges.some(
      (s) => start >= s.startSec && end <= s.endSec
    );
    if (!mostlySilent) {
      return {
        startSec: Number(start.toFixed(2)),
        endSec: Number(end.toFixed(2)),
      };
    }
  }

  const safeStart = Math.max(0, Math.min(maxDur - clipLen, cursorHint % Math.max(0.5, maxDur)));
  return {
    startSec: Number(safeStart.toFixed(2)),
    endSec: Number(Math.min(maxDur, safeStart + clipLen).toFixed(2)),
  };
}

function buildAdjustForFilter(filter: CutTemplatePreset["filter"]): ClipAdjust {
  switch (filter) {
    case "vivid":
      return { brightness: 0.02, contrast: 0.08, saturation: 0.12, warmth: 0, vignette: 0.12 };
    case "warm-film":
      return { brightness: 0.02, contrast: 0.05, saturation: 0.06, warmth: 0.1, vignette: 0.2 };
    case "cinematic":
      return { brightness: -0.02, contrast: 0.1, saturation: -0.05, warmth: -0.04, vignette: 0.25 };
    default:
      return { brightness: 0, contrast: 0.04, saturation: 0.05, warmth: 0, vignette: 0.08 };
  }
}

function buildSocialCopy(params: {
  prompt: string;
  platform: PlatformPreset;
  hookText: string | null;
}): { socialCaption: string; hashtags: string[] } {
  const { prompt, platform, hookText } = params;
  const isTagalog = /\b(gawa|ng|sa|yung|para|grabe|astig|ganda|vlog|tara)\b/i.test(prompt);
  const headline = hookText ? hookText : isTagalog ? "Bagong edit!" : "Wait for the beat drop ✨";

  const socialCaption = isTagalog
    ? `${headline} 🔥 Save & share kung trip mo 'tong edit!`
    : `${headline} ✨ Drop a comment below if you'd watch till the end!`;

  const baseTags =
    platform === "tiktok"
      ? ["#fyp", "#tiktok", "#capcutedit", "#viral"]
      : platform === "instagram-feed" || platform === "instagram-reels"
        ? ["#reels", "#instagram", "#aesthetic", "#explorepage"]
        : platform === "youtube-shorts" || platform === "youtube-landscape"
          ? ["#shorts", "#youtube", "#videoedit"]
          : platform === "promo-ad"
            ? ["#budol", "#musthave", "#promo", "#shopnow"]
            : ["#reels", "#fyp", "#cutflowai"];

  return { socialCaption, hashtags: baseTags };
}

function pickDefaultAudio(
  preset: CutTemplatePreset,
  explicitAudioId: string | undefined,
  assetsById: Map<string, MediaAsset>
): MediaAsset | undefined {
  if (explicitAudioId) {
    const found = assetsById.get(explicitAudioId);
    if (found?.kind === "audio") return found;
  }

  const audios = Array.from(assetsById.values()).filter(
    (a) => a.kind === "audio" && a.audioCategory !== "sfx" && a.audioCategory !== "voiceover"
  );
  if (audios.length === 0) return undefined;

  const userAudios = audios.filter((a) => !a.isBuiltIn);
  if (userAudios.length > 0) return userAudios[userAudios.length - 1];

  if (preset.id === "chill-vlog" || preset.id === "cinematic-story" || preset.id === "ig-feed-aesthetic") {
    return audios.find((a) => a.id.includes("chill")) ?? audios[0];
  }
  if (preset.id === "beat-flash") {
    return audios.find((a) => a.id.includes("flash")) ?? audios[0];
  }
  return audios.find((a) => a.id.includes("hype")) ?? audios[0];
}

export function generateOfflineCutProject(
  request: AutoEditRequest,
  assetsById: Map<string, MediaAsset>,
  allTemplates: CutTemplatePreset[] = CUT_TEMPLATE_PRESETS
): { project: CutProject; warnings: string[] } {
  const visualAssets = request.assetIds
    .map((id) => assetsById.get(id))
    .filter((a): a is MediaAsset => Boolean(a && a.kind !== "audio"));

  if (visualAssets.length === 0) {
    throw new Error("No valid video or image assets selected.");
  }

  const lowerPrompt = request.prompt.toLowerCase();
  const prev = request.previousProject;

  const isRefinement =
    Boolean(prev) &&
    /(mas mabilis|faster|speed up|slower|mas mabagal|change text|palitan|remove text|walang text|flash|crossfade|zoom|make it \d+s)/i.test(
      lowerPrompt
    );

  const initialPlatformSettings = resolvePlatformSettings({
    platform: request.platform ?? (isRefinement ? prev?.platform : undefined),
    explicitAspect: request.aspectRatio ?? (isRefinement ? prev?.aspectRatio : undefined),
    prompt: request.prompt,
  });

  const preset = pickTemplateFromPrompt(
    request.prompt,
    request.templateId ?? (isRefinement ? prev?.templateId : undefined),
    initialPlatformSettings.platform,
    allTemplates
  );

  const { platform, aspectRatio } = resolvePlatformSettings({
    platform: initialPlatformSettings.platform,
    explicitAspect: request.aspectRatio ?? (isRefinement ? prev?.aspectRatio : undefined),
    prompt: request.prompt,
    fallbackAspect: preset.defaultAspectRatio,
  });

  const targetDurationSec = inferTargetDuration(
    request.prompt,
    request.targetDurationSec,
    preset,
    platform
  );

  const prevTracks = prev ? getProjectAudioTracks(prev) : [];
  const audioAsset = pickDefaultAudio(
    preset,
    request.audioAssetId ?? prevTracks[0]?.assetId,
    assetsById
  );
  const preservedStickers = resolveAiStickers({
    previousProject: prev,
    prompt: request.prompt,
  });

  if (preset.isCustom && preset.slots.length > 0 && request.templateId === preset.id) {
    const built = buildProjectFromTemplate({
      template: { ...preset, defaultAspectRatio: aspectRatio },
      slotAssetIds: visualAssets.map((a) => a.id),
      assetsById,
      audioAsset,
      projectId: prev?.id ?? crypto.randomUUID(),
    });
    const mergedTracks = resolveAiAudioTracks({
      previousProject: prev,
      chosenBgm: audioAsset,
      totalDurationSec: built.targetDurationSec,
    });
    return sanitizeCutProject(
      {
        ...built,
        platform,
        promptUsed: request.prompt,
        modeUsed: "offline",
        stickers: preservedStickers.length > 0 ? preservedStickers : built.stickers,
        audioTrack: mergedTracks[0],
        audioTracks: mergedTracks,
      },
      assetsById
    );
  }

  const beatStepSec = 60 / preset.bpm;
  const beatsPerCut =
    /(mas mabilis|faster|ultra|flash|montage)/.test(lowerPrompt)
      ? 1.5
      : /(chill|slow|mabagal|cinematic|smooth)/.test(lowerPrompt) || platform === "youtube-landscape"
        ? 4
        : platform === "tiktok" || platform === "instagram-reels"
          ? 2
          : 2.5;

  const baseCutLength = Math.min(
    preset.maxClipSec,
    Math.max(preset.minClipSec, Number((beatStepSec * beatsPerCut).toFixed(2)))
  );

  const clips: ClipSlot[] = [];
  const sfxCues: Array<{ assetId: string; timelineStartSec: number; volume: number }> = [];
  let accumulatedSec = 0;
  let slotIndex = 0;
  const perAssetCursor = new Map<string, number>();
  const colorPolish = buildAdjustForFilter(preset.filter);

  while (accumulatedSec < targetDurationSec - 0.3 && slotIndex < 24) {
    const asset = visualAssets[slotIndex % visualAssets.length];
    const cursor = perAssetCursor.get(asset.id) ?? 0;

    // 3-act pacing: punchy 1.1-1.5s scroll-stop opening hook, then beat-aligned cuts
    let desiredDur =
      slotIndex === 0 && (platform === "tiktok" || platform === "instagram-reels" || platform === "youtube-shorts")
        ? Math.min(1.5, Math.max(1.0, baseCutLength * 0.85))
        : baseCutLength;

    if (audioAsset && audioAsset.beatMarkersSec.length > 2) {
      const nextBeat = audioAsset.beatMarkersSec.find(
        (b) => b >= accumulatedSec + preset.minClipSec && b <= accumulatedSec + preset.maxClipSec
      );
      if (nextBeat) {
        desiredDur = Number((nextBeat - accumulatedSec).toFixed(2));
      }
    }

    const remaining = targetDurationSec - accumulatedSec;
    if (remaining < desiredDur * 1.15 && remaining >= 0.6) {
      desiredDur = Number(remaining.toFixed(2));
    }

    const seg = findBestSegmentInAsset(asset, desiredDur, cursor);
    perAssetCursor.set(asset.id, seg.endSec + 0.35);

    const motion =
      slotIndex === 0 && (platform === "tiktok" || platform === "promo-ad")
        ? "punch-zoom"
        : preset.motions[slotIndex % preset.motions.length];
    const transitionIn =
      slotIndex === 0
        ? "cut"
        : /(flash)/.test(lowerPrompt)
          ? "flash-white"
          : /(crossfade|smooth|fade)/.test(lowerPrompt)
            ? "crossfade"
            : preset.transitions[(slotIndex - 1) % preset.transitions.length];

    const slotDuration = seg.endSec - seg.startSec;
    const overlap =
      transitionIn === "cut" ? 0 : Math.min(preset.transitionDurationSec, slotDuration * 0.35);

    if (slotIndex > 0 && sfxCues.length < 3) {
      if (transitionIn === "flash-white" && assetsById.has("builtin-sfx-bass-drop")) {
        sfxCues.push({ assetId: "builtin-sfx-bass-drop", timelineStartSec: accumulatedSec, volume: 0.55 });
      } else if (
        (transitionIn === "slide-left" || transitionIn === "zoom-blur") &&
        assetsById.has("builtin-sfx-whoosh")
      ) {
        sfxCues.push({ assetId: "builtin-sfx-whoosh", timelineStartSec: Math.max(0, accumulatedSec - 0.1), volume: 0.45 });
      }
    }

    const roleLabel =
      slotIndex === 0
        ? "Hook"
        : remaining <= desiredDur * 1.2
          ? "Climax"
          : `Beat ${slotIndex + 1}`;

    clips.push({
      id: `slot-${slotIndex + 1}`,
      assetId: asset.id,
      sourceStartSec: seg.startSec,
      sourceEndSec: seg.endSec,
      speed: /(mas mabilis|faster)/.test(lowerPrompt) ? 1.15 : 1,
      motion: /(zoom)/.test(lowerPrompt) && motion === "none" ? "zoom-in" : motion,
      transitionIn,
      transitionDurationSec: Number(overlap.toFixed(2)),
      filter: preset.filter,
      adjust: colorPolish,
      muteOriginalAudio: Boolean(audioAsset),
      volume: audioAsset ? 0 : 1,
      reversed: false,
      label: `${roleLabel}: ${asset.originalName}`,
    });

    accumulatedSec = Math.max(0.5, accumulatedSec + slotDuration - overlap);
    slotIndex += 1;
  }

  const layout = computeTimelineLayout({ clips });
  const totalSec = layout.totalDurationSec;
  const hookText = extractHookText(request.prompt, preset);
  const rawOverlays: TextOverlay[] = [];

  if (hookText) {
    rawOverlays.push({
      id: "txt-hook-1",
      text: hookText,
      startSec: 0.1,
      endSec: Number(Math.min(totalSec, Math.max(1.8, Math.min(2.6, totalSec * 0.36))).toFixed(2)),
      position: preset.id === "chill-vlog" ? "bottom" : "top",
      yNorm: aspectRatio === "9:16" ? 0.22 : aspectRatio === "4:5" ? 0.2 : 0.22,
      style: preset.overlayStyle,
      scale: 1,
      rotationDeg: 0,
      animation: "pop",
    });

    if (assetsById.has("builtin-sfx-pop")) {
      sfxCues.unshift({ assetId: "builtin-sfx-pop", timelineStartSec: 0.1, volume: 0.48 });
    }

    if (totalSec >= 4.5 && !/(no text|walang text)/.test(lowerPrompt)) {
      const ctaStart = Number(Math.max(2.6, totalSec * 0.62).toFixed(2));
      const ctaEnd = Number(Math.min(totalSec, ctaStart + 2.2).toFixed(2));
      if (ctaEnd - ctaStart >= 0.7) {
        const ctaText =
          platform === "promo-ad"
            ? "CHECK LINK IN BIO"
            : platform === "youtube-shorts" || platform === "youtube-landscape"
              ? "FOLLOW FOR PART 2"
              : "WAIT FOR IT 🔥";
        rawOverlays.push({
          id: "txt-cta-2",
          text: ctaText,
          startSec: ctaStart,
          endSec: ctaEnd,
          position: "bottom",
          yNorm: aspectRatio === "9:16" ? 0.72 : aspectRatio === "4:5" ? 0.76 : 0.82,
          style: "capcut-pop",
          scale: 0.95,
          rotationDeg: 0,
          animation: "slide-up",
        });
      }
    }
  }

  const overlays = clampAiOverlaysToSafeZones(rawOverlays, aspectRatio);
  const baseTracks = resolveAiAudioTracks({
    previousProject: prev,
    chosenBgm: audioAsset,
    totalDurationSec: totalSec,
  });
  const mergedTracks = mergeAiSfxTracks({
    baseTracks,
    sfxCues,
    assetsById,
    totalDurationSec: totalSec,
    hasPreviousProject: Boolean(prev),
  });
  const { socialCaption, hashtags } = buildSocialCopy({
    prompt: request.prompt,
    platform,
    hookText,
  });

  const draft: CutProjectInput = {
    id: prev?.id ?? crypto.randomUUID(),
    title: hookText ? `${preset.name}: ${hookText.slice(0, 28)}` : preset.name,
    templateId: preset.id,
    promptUsed: request.prompt,
    aiSummary: `Pro Smart Director (${platform}, ${aspectRatio}, ${clips.length} beat cuts${sfxCues.length > 0 ? ` + ${sfxCues.length} SFX` : ""}).`,
    platform,
    socialCaption,
    hashtags,
    modeUsed: "offline",
    aspectRatio,
    fps: 30,
    targetDurationSec: totalSec,
    clips,
    overlays,
    stickers: preservedStickers,
    audioTrack: mergedTracks[0],
    audioTracks: mergedTracks,
  };

  return sanitizeCutProject(draft, assetsById);
}
