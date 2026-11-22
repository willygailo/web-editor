import crypto from "node:crypto";
import {
  computeTimelineLayout,
  CUT_TEMPLATE_PRESETS,
  getTemplatePresetById,
  type AspectRatio,
  type AutoEditRequest,
  type ClipSlot,
  type CutProjectInput,
  type CutProject,
  type CutTemplatePreset,
  type MediaAsset,
  type TextOverlay,
} from "@cutflow/shared";
import { sanitizeCutProject } from "./sanitize.js";

function pickTemplateFromPrompt(prompt: string, explicitId?: string): CutTemplatePreset {
  if (explicitId) return getTemplatePresetById(explicitId);
  const lower = prompt.toLowerCase();

  let bestPreset = CUT_TEMPLATE_PRESETS[0];
  let bestScore = -1;

  for (const preset of CUT_TEMPLATE_PRESETS) {
    let score = 0;
    for (const kw of preset.keywords) {
      if (lower.includes(kw)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPreset = preset;
    }
  }

  return bestPreset;
}

function inferAspectRatio(
  prompt: string,
  explicit: AspectRatio | undefined,
  preset: CutTemplatePreset
): AspectRatio {
  if (explicit) return explicit;
  const lower = prompt.toLowerCase();
  if (/(16:9|youtube|landscape|widescreen|horizontal)/.test(lower)) return "16:9";
  if (/(1:1|square|instagram post|shopee|lazada)/.test(lower)) return "1:1";
  if (/(9:16|tiktok|reels|shorts|portrait|vertical|story|myday)/.test(lower)) return "9:16";
  return preset.defaultAspectRatio;
}

function inferTargetDuration(
  prompt: string,
  explicit: number | undefined,
  preset: CutTemplatePreset
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
  return preset.defaultDurationSec;
}

function extractHookText(prompt: string, preset: CutTemplatePreset): string | null {
  const lower = prompt.toLowerCase();
  if (/(no text|walang text|remove text|no caption)/.test(lower)) return null;

  const quoted = /["']([^"']{2,60})["']/.exec(prompt);
  if (quoted) return quoted[1].trim();

  const textDirective = /(?:text|title|hook|caption)\s*[:=-]\s*([^\n,.]+)/i.exec(prompt);
  if (textDirective) return textDirective[1].trim();

  // Derive concise punchy title from descriptive words if present
  const cleaned = prompt
    .replace(/\b(gawa ka ng|gawan mo ng|make|create|edit|video|cut|template|with|na|ng|for|sa|ang|yung|mga|please|pls)\b/gi, " ")
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

  // Try picking a non-silent energy peak near cursorHint
  const candidateStarts: number[] = [];
  for (const peak of asset.energyPeaksSec) {
    const start = Math.max(0, Math.min(maxDur - clipLen, peak - 0.2));
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
    (a) => a.kind === "audio" && a.audioCategory !== "sfx"
  );
  if (audios.length === 0) return undefined;

  // Prefer user-uploaded audio first if they uploaded one
  const userAudio = audios.find((a) => !a.isBuiltIn);
  if (userAudio) return userAudio;

  if (preset.id === "chill-vlog" || preset.id === "cinematic-story") {
    return audios.find((a) => a.id.includes("chill")) ?? audios[0];
  }
  if (preset.id === "beat-flash") {
    return audios.find((a) => a.id.includes("flash")) ?? audios[0];
  }
  return audios.find((a) => a.id.includes("hype")) ?? audios[0];
}

export function generateOfflineCutProject(
  request: AutoEditRequest,
  assetsById: Map<string, MediaAsset>
): { project: CutProject; warnings: string[] } {
  const visualAssets = request.assetIds
    .map((id) => assetsById.get(id))
    .filter((a): a is MediaAsset => Boolean(a && a.kind !== "audio"));

  if (visualAssets.length === 0) {
    throw new Error("No valid video or image assets selected.");
  }

  const lowerPrompt = request.prompt.toLowerCase();
  const prev = request.previousProject;

  // Check if user is asking for an incremental tweak on an existing project
  const isRefinement =
    Boolean(prev) &&
    /(mas mabilis|faster|speed up|slower|mas mabagal|change text|palitan|remove text|walang text|flash|crossfade|zoom|make it \d+s)/i.test(
      lowerPrompt
    );

  const preset = pickTemplateFromPrompt(
    request.prompt,
    request.templateId ?? (isRefinement ? prev?.templateId : undefined)
  );
  const aspectRatio = inferAspectRatio(
    request.prompt,
    request.aspectRatio ?? (isRefinement ? prev?.aspectRatio : undefined),
    preset
  );
  const targetDurationSec = inferTargetDuration(
    request.prompt,
    request.targetDurationSec,
    preset
  );

  const audioAsset = pickDefaultAudio(
    preset,
    request.audioAssetId ?? prev?.audioTrack?.assetId,
    assetsById
  );

  const beatStepSec = 60 / preset.bpm;
  const beatsPerCut =
    /(mas mabilis|faster|ultra|flash|montage)/.test(lowerPrompt)
      ? 1.5
      : /(chill|slow|mabagal|cinematic|smooth)/.test(lowerPrompt)
        ? 4
        : 2;

  const baseCutLength = Math.min(
    preset.maxClipSec,
    Math.max(preset.minClipSec, Number((beatStepSec * beatsPerCut).toFixed(2)))
  );

  const clips: ClipSlot[] = [];
  let accumulatedSec = 0;
  let slotIndex = 0;
  const perAssetCursor = new Map<string, number>();

  while (accumulatedSec < targetDurationSec - 0.3 && slotIndex < 24) {
    const asset = visualAssets[slotIndex % visualAssets.length];
    const cursor = perAssetCursor.get(asset.id) ?? 0;

    // Align segment length to beat markers if audio has them
    let desiredDur = baseCutLength;
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

    const motion = preset.motions[slotIndex % preset.motions.length];
    const transitionIn =
      slotIndex === 0
        ? "cut"
        : /(flash)/.test(lowerPrompt)
          ? "flash-white"
          : /(crossfade|smooth|fade)/.test(lowerPrompt)
            ? "crossfade"
            : preset.transitions[(slotIndex - 1) % preset.transitions.length];

    const slotDuration = seg.endSec - seg.startSec;
    const overlap = transitionIn === "cut" ? 0 : Math.min(preset.transitionDurationSec, slotDuration * 0.35);

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
      muteOriginalAudio: Boolean(audioAsset),
      volume: audioAsset ? 0 : 1,
      reversed: false,
      label: `${asset.originalName} (#${slotIndex + 1})`,
    });

    accumulatedSec = Math.max(0.5, accumulatedSec + slotDuration - overlap);
    slotIndex += 1;
  }

  const layout = computeTimelineLayout({ clips });
  const hookText = extractHookText(request.prompt, preset);
  const overlays: TextOverlay[] = [];

  if (hookText) {
    overlays.push({
      id: "txt-hook-1",
      text: hookText,
      startSec: 0.15,
      endSec: Math.min(layout.totalDurationSec, Math.max(2.2, Math.min(3.5, layout.totalDurationSec * 0.4))),
      position: preset.id === "chill-vlog" ? "bottom" : "center",
      style: preset.overlayStyle,
      scale: 1,
      rotationDeg: 0,
      animation: "pop",
    });
  }

  const audioTrackObj = audioAsset
    ? {
        id: "aud-bgm-1",
        kind: "bgm" as const,
        assetId: audioAsset.id,
        title: audioAsset.originalName,
        timelineStartSec: 0,
        durationSec: layout.totalDurationSec,
        startOffsetSec: 0,
        volume: 0.85,
        fadeInSec: 0.2,
        fadeOutSec: 0.7,
        beatMarkersSec: audioAsset.beatMarkersSec,
      }
    : undefined;

  const draft: CutProjectInput = {
    id: prev?.id ?? crypto.randomUUID(),
    title: hookText ? `${preset.name}: ${hookText.slice(0, 28)}` : preset.name,
    templateId: preset.id,
    promptUsed: request.prompt,
    aiSummary: `Offline Smart Engine applied "${preset.name}" (${aspectRatio}, ${clips.length} beat-aligned cuts${audioAsset ? ` synced to ${audioAsset.originalName}` : ""}).`,
    modeUsed: "offline",
    aspectRatio,
    fps: 30,
    targetDurationSec: layout.totalDurationSec,
    clips,
    overlays,
    stickers: [],
    audioTrack: audioTrackObj,
    audioTracks: audioTrackObj ? [audioTrackObj] : [],
  };

  return sanitizeCutProject(draft, assetsById);
}
