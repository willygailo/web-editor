import {
  ClipSlotSchema,
  computeTimelineLayout,
  CutProjectSchema,
  getProjectAudioTracks,
  type AudioTrack,
  type CutProject,
  type CutProjectInput,
  type MediaAsset,
} from "@cutflow/shared";

/**
 * Ensures any AI-generated or preset CutProject strictly conforms to real
 * asset durations, valid IDs, safe transition lengths, and timeline bounds.
 */
export function sanitizeCutProject(
  candidate: CutProjectInput,
  assetsById: Map<string, MediaAsset>
): { project: CutProject; warnings: string[] } {
  const warnings: string[] = [];
  const visualAssets = Array.from(assetsById.values()).filter(
    (a) => a.kind === "video" || a.kind === "image"
  );

  if (visualAssets.length === 0) {
    throw new Error("At least one video or image asset is required.");
  }

  const sanitizedClips = candidate.clips.map((slot, index) => {
    let asset = assetsById.get(slot.assetId);
    if (!asset || asset.kind === "audio") {
      asset = visualAssets[index % visualAssets.length];
      warnings.push(
        `Slot ${index + 1} referenced unavailable asset; reassigned to ${asset.originalName}.`
      );
    }

    const maxDuration = Math.max(0.5, asset.durationSec);
    let sourceStartSec = Math.max(0, Math.min(slot.sourceStartSec, maxDuration - 0.35));
    let sourceEndSec = Math.min(
      maxDuration,
      Math.max(sourceStartSec + 0.35, slot.sourceEndSec)
    );

    if (asset.kind === "image") {
      const requestedDur = Math.max(
        0.6,
        Math.min(10, slot.sourceEndSec - slot.sourceStartSec)
      );
      sourceStartSec = 0;
      sourceEndSec = requestedDur;
    }

    const speed = Math.min(2.5, Math.max(0.5, slot.speed ?? 1));
    const transitionIn = index === 0 ? ("cut" as const) : (slot.transitionIn ?? "cut");
    const rawTransitionDur = slot.transitionDurationSec ?? 0.25;

    return ClipSlotSchema.parse({
      ...slot,
      id: slot.id || `slot-${index + 1}`,
      assetId: asset.id,
      sourceStartSec: Number(sourceStartSec.toFixed(2)),
      sourceEndSec: Number(sourceEndSec.toFixed(2)),
      speed: Number(speed.toFixed(2)),
      reversed: Boolean(slot.reversed && asset.kind === "video"),
      transitionIn,
      transitionDurationSec:
        index === 0 || transitionIn === "cut"
          ? 0
          : Math.min(0.75, Math.max(0.1, rawTransitionDur)),
    });
  });

  const layout = computeTimelineLayout({ clips: sanitizedClips });
  const totalSec = Math.max(0.4, layout.totalDurationSec);

  const sanitizedOverlays = (candidate.overlays || [])
    .filter((o) => o.text.trim().length > 0)
    .map((overlay, idx) => {
      const startSec = Math.max(
        0,
        Math.min(overlay.startSec, Math.max(0, totalSec - 0.35))
      );
      const endSec = Math.min(totalSec, Math.max(startSec + 0.35, overlay.endSec));
      return {
        ...overlay,
        id: overlay.id || `txt-${idx + 1}`,
        text: overlay.text.trim().slice(0, 160),
        startSec: Number(startSec.toFixed(2)),
        endSec: Number(endSec.toFixed(2)),
      };
    });

  const sanitizedStickers = (candidate.stickers || [])
    .filter((st) => {
      if (!st.assetId) return true;
      const img = assetsById.get(st.assetId);
      if (!img || img.kind !== "image") {
        warnings.push(`Sticker image "${st.assetId}" not found; skipped.`);
        return false;
      }
      return true;
    })
    .map((st, idx) => {
      const startSec = Math.max(0, Math.min(st.startSec, Math.max(0, totalSec - 0.35)));
      const endSec = Math.min(totalSec, Math.max(startSec + 0.35, st.endSec));
      return {
        ...st,
        id: st.id || `stk-${idx + 1}`,
        startSec: Number(startSec.toFixed(2)),
        endSec: Number(endSec.toFixed(2)),
      };
    });

  const rawAudioTracks = getProjectAudioTracks(candidate);
  const sanitizedAudioTracks: AudioTrack[] = [];

  for (const track of rawAudioTracks) {
    const audioAsset = assetsById.get(track.assetId);
    if (!audioAsset || audioAsset.kind !== "audio") {
      warnings.push(`Audio track "${track.title || track.assetId}" not found; skipped.`);
      continue;
    }

    const timelineStartSec = Math.max(
      0,
      Math.min(totalSec - 0.2, track.timelineStartSec ?? 0)
    );
    const maxRemaining = Math.max(0.25, totalSec - timelineStartSec);
    const defaultDur =
      track.kind === "bgm"
        ? maxRemaining
        : Math.min(maxRemaining, audioAsset.durationSec);

    sanitizedAudioTracks.push({
      ...track,
      id: track.id,
      kind: track.kind,
      title: track.title ?? audioAsset.originalName,
      timelineStartSec: Number(timelineStartSec.toFixed(2)),
      durationSec: Number(
        Math.min(maxRemaining, Math.max(0.2, track.durationSec ?? defaultDur)).toFixed(2)
      ),
      startOffsetSec: Number(
        Math.max(
          0,
          Math.min(track.startOffsetSec ?? 0, Math.max(0, audioAsset.durationSec - 0.3))
        ).toFixed(2)
      ),
      beatMarkersSec:
        track.beatMarkersSec && track.beatMarkersSec.length > 0
          ? track.beatMarkersSec
          : audioAsset.beatMarkersSec,
    });
  }

  const parsed = CutProjectSchema.parse({
    ...candidate,
    clips: sanitizedClips,
    overlays: sanitizedOverlays,
    stickers: sanitizedStickers,
    audioTracks: sanitizedAudioTracks,
    audioTrack: sanitizedAudioTracks[0],
    targetDurationSec: Number(totalSec.toFixed(2)),
  });

  return { project: parsed, warnings };
}

/**
 * Preserves user-configured multi-track audio (BGM offsets/volumes, SFX, and
 * voiceovers) across AI Remix iterations while cleanly switching BGM if requested.
 */
export function resolveAiAudioTracks(params: {
  previousProject?: CutProject;
  chosenBgm?: MediaAsset;
  totalDurationSec?: number;
}): AudioTrack[] {
  const { previousProject, chosenBgm, totalDurationSec } = params;
  const prevTracks = previousProject ? getProjectAudioTracks(previousProject) : [];
  const prevBgm = prevTracks.find((t) => t.kind === "bgm");
  const prevExtras = prevTracks.filter((t) => t.kind !== "bgm");

  if (!chosenBgm) {
    return prevTracks;
  }

  if (prevBgm && prevBgm.assetId === chosenBgm.id) {
    const prevTotal = previousProject?.targetDurationSec;
    const wasFullLength =
      prevBgm.durationSec === undefined ||
      (prevTotal !== undefined && Math.abs(prevBgm.durationSec - prevTotal) < 0.3);
    return [
      {
        ...prevBgm,
        durationSec: wasFullLength ? totalDurationSec : prevBgm.durationSec,
        beatMarkersSec:
          prevBgm.beatMarkersSec.length > 0
            ? prevBgm.beatMarkersSec
            : chosenBgm.beatMarkersSec,
      },
      ...prevExtras,
    ];
  }

  const freshBgm: AudioTrack = {
    id: "aud-bgm-1",
    kind: "bgm",
    assetId: chosenBgm.id,
    title: chosenBgm.originalName,
    timelineStartSec: 0,
    durationSec: totalDurationSec,
    startOffsetSec: 0,
    volume: 0.85,
    fadeInSec: 0.2,
    fadeOutSec: 0.7,
    beatMarkersSec: chosenBgm.beatMarkersSec,
  };

  return [freshBgm, ...prevExtras];
}
