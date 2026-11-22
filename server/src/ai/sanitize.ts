import {
  computeTimelineLayout,
  CutProjectSchema,
  type CutProject,
  type MediaAsset,
} from "@cutflow/shared";

/**
 * Ensures any AI-generated or preset CutProject strictly conforms to real
 * asset durations, valid IDs, safe transition lengths, and timeline bounds.
 */
export function sanitizeCutProject(
  candidate: CutProject,
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
      warnings.push(`Slot ${index + 1} referenced unavailable asset; reassigned to ${asset.originalName}.`);
    }

    const maxDuration = Math.max(0.5, asset.durationSec);
    let sourceStartSec = Math.max(0, Math.min(slot.sourceStartSec, maxDuration - 0.35));
    let sourceEndSec = Math.min(maxDuration, Math.max(sourceStartSec + 0.35, slot.sourceEndSec));

    if (asset.kind === "image") {
      const requestedDur = Math.max(0.6, Math.min(6, slot.sourceEndSec - slot.sourceStartSec));
      sourceStartSec = 0;
      sourceEndSec = requestedDur;
    }

    const speed = Math.min(2.5, Math.max(0.5, slot.speed || 1));

    return {
      ...slot,
      id: slot.id || `slot-${index + 1}`,
      assetId: asset.id,
      sourceStartSec: Number(sourceStartSec.toFixed(2)),
      sourceEndSec: Number(sourceEndSec.toFixed(2)),
      speed: Number(speed.toFixed(2)),
      transitionIn: index === 0 ? ("cut" as const) : slot.transitionIn,
      transitionDurationSec:
        index === 0 || slot.transitionIn === "cut"
          ? 0
          : Math.min(0.75, Math.max(0.1, slot.transitionDurationSec)),
    };
  });

  const layout = computeTimelineLayout({ clips: sanitizedClips });
  const totalSec = Math.max(1, layout.totalDurationSec);

  const sanitizedOverlays = (candidate.overlays || [])
    .filter((o) => o.text.trim().length > 0)
    .map((overlay, idx) => {
      const startSec = Math.max(0, Math.min(overlay.startSec, Math.max(0, totalSec - 0.5)));
      const endSec = Math.min(totalSec, Math.max(startSec + 0.5, overlay.endSec));
      return {
        ...overlay,
        id: overlay.id || `txt-${idx + 1}`,
        text: overlay.text.trim().slice(0, 160),
        startSec: Number(startSec.toFixed(2)),
        endSec: Number(endSec.toFixed(2)),
      };
    });

  let audioTrack = candidate.audioTrack;
  if (audioTrack) {
    const audioAsset = assetsById.get(audioTrack.assetId);
    if (!audioAsset || audioAsset.kind !== "audio") {
      warnings.push("Requested audio track not found; cleared audioTrack.");
      audioTrack = undefined;
    } else {
      audioTrack = {
        ...audioTrack,
        title: audioTrack.title ?? audioAsset.originalName,
        startOffsetSec: Math.max(0, Math.min(audioTrack.startOffsetSec, Math.max(0, audioAsset.durationSec - 1))),
        beatMarkersSec:
          audioTrack.beatMarkersSec.length > 0
            ? audioTrack.beatMarkersSec
            : audioAsset.beatMarkersSec,
      };
    }
  }

  const parsed = CutProjectSchema.parse({
    ...candidate,
    clips: sanitizedClips,
    overlays: sanitizedOverlays,
    audioTrack,
    targetDurationSec: Number(totalSec.toFixed(2)),
  });

  return { project: parsed, warnings };
}
