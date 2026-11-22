import {
  computeTimelineLayout,
  getAspectDimensions,
  type CutProject,
  type FilterPreset,
  type MediaAsset,
  type MotionPreset,
  type TransitionType,
} from "@cutflow/shared";

export interface BuildRenderPlanInput {
  project: CutProject;
  quality: "720p" | "1080p";
  assetsById: Map<string, MediaAsset>;
  filePathsById: Map<string, string>;
  outputPath: string;
  assSubtitlePath?: string;
}

export interface FfmpegRenderPlan {
  args: string[];
  totalDurationSec: number;
}

function mapTransition(t: TransitionType): string {
  switch (t) {
    case "crossfade":
      return "fade";
    case "slide-left":
      return "slideleft";
    case "flash-white":
      return "fadewhite";
    case "zoom-blur":
      return "zoomin";
    case "cut":
      return "fade";
  }
}

function filterChainForPreset(preset: FilterPreset): string[] {
  switch (preset) {
    case "vivid":
      return ["eq=contrast=1.08:saturation=1.28:brightness=0.02"];
    case "cinematic":
      return [
        "eq=contrast=1.12:saturation=0.86:brightness=-0.02",
        "colorbalance=rs=-0.03:gs=0.01:bs=0.04",
      ];
    case "warm-film":
      return [
        "eq=contrast=1.05:saturation=1.12:brightness=0.02",
        "colorbalance=rs=0.05:gs=0.02:bs=-0.05",
      ];
    case "bw-contrast":
      return ["hue=s=0", "eq=contrast=1.22"];
    case "none":
      return [];
  }
}

function buildMotionFilter(
  motion: MotionPreset,
  width: number,
  height: number,
  fps: number,
  durationSec: number
): string[] {
  if (motion === "none") {
    return [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
    ];
  }

  const totalFrames = Math.max(12, Math.round(durationSec * fps));
  const upW = Math.round(width * 1.15);
  const upH = Math.round(height * 1.15);

  let zoomExpr = "1.0";
  let xExpr = "iw/2-(iw/zoom/2)";
  let yExpr = "ih/2-(ih/zoom/2)";

  switch (motion) {
    case "zoom-in":
      zoomExpr = `min(1.18,1+0.16*(on/${totalFrames}))`;
      break;
    case "zoom-out":
      zoomExpr = `max(1.0,1.16-0.16*(on/${totalFrames}))`;
      break;
    case "punch-zoom":
      zoomExpr = `if(lt(on,10),1.20-0.018*on,1.02+0.05*((on-10)/${Math.max(1, totalFrames - 10)}))`;
      break;
    case "pan-left":
      zoomExpr = "1.12";
      xExpr = `(iw-iw/zoom)*(1-min(1,on/${totalFrames}))`;
      break;
    case "pan-right":
      zoomExpr = "1.12";
      xExpr = `(iw-iw/zoom)*min(1,on/${totalFrames})`;
      break;
  }

  return [
    `scale=${upW}:${upH}:force_original_aspect_ratio=increase`,
    `crop=${upW}:${upH}`,
    `zoompan=z='${zoomExpr}':x='${xExpr}':y='${yExpr}':d=1:s=${width}x${height}:fps=${fps}`,
  ];
}

function buildAtempoChain(speed: number): string[] {
  if (Math.abs(speed - 1) < 0.02) return [];
  if (speed <= 2.0) return [`atempo=${speed.toFixed(3)}`];
  return ["atempo=2.0", `atempo=${(speed / 2).toFixed(3)}`];
}

function escapeFfmpegFilterPath(filePath: string): string {
  return filePath
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/ /g, "\\ ");
}

export function buildFfmpegRenderPlan(input: BuildRenderPlanInput): FfmpegRenderPlan {
  const { project, quality, assetsById, filePathsById, outputPath, assSubtitlePath } = input;
  const { width, height } = getAspectDimensions(project.aspectRatio, quality);
  const fps = project.fps || 30;
  const layout = computeTimelineLayout(project);

  const inputArgs: string[] = [];
  const filterParts: string[] = [];
  const audioBranches: string[] = [];

  // 1. Add visual inputs (one per timeline slot for clean trim/speed isolation)
  layout.slots.forEach((slotLayout, idx) => {
    const { slot, rawDurationSec } = slotLayout;
    const asset = assetsById.get(slot.assetId);
    const filePath = filePathsById.get(slot.assetId);
    if (!asset || !filePath) {
      throw new Error(`Missing media file for asset ${slot.assetId}`);
    }

    const sourceSpan = Math.max(0.2, slot.sourceEndSec - slot.sourceStartSec);

    if (asset.kind === "image") {
      inputArgs.push("-loop", "1", "-framerate", String(fps), "-t", String(rawDurationSec), "-i", filePath);
    } else {
      inputArgs.push("-ss", String(slot.sourceStartSec), "-t", String(sourceSpan), "-i", filePath);
    }

    const vfOps: string[] = [];
    if (asset.kind === "video") {
      if (Math.abs(slot.speed - 1) >= 0.02) {
        vfOps.push(`setpts=(PTS-STARTPTS)/${slot.speed.toFixed(3)}`);
      } else {
        vfOps.push("setpts=PTS-STARTPTS");
      }
      vfOps.push(`fps=${fps}`);
    }

    vfOps.push(...buildMotionFilter(slot.motion, width, height, fps, rawDurationSec));
    vfOps.push(...filterChainForPreset(slot.filter));
    vfOps.push(`fps=${fps}`, "settb=1/1000", "setsar=1", "format=yuv420p");

    filterParts.push(`[${idx}:v]${vfOps.join(",")}[v${idx}]`);

    // Keep original clip audio if enabled and stream exists
    if (asset.kind === "video" && asset.hasAudio && !slot.muteOriginalAudio && slot.volume > 0) {
      const delayMs = Math.max(0, Math.round(slotLayout.timelineStartSec * 1000));
      const afOps = [
        ...buildAtempoChain(slot.speed),
        `volume=${slot.volume.toFixed(2)}`,
        `adelay=${delayMs}|${delayMs}`,
        "aformat=sample_rates=44100:channel_layouts=stereo",
      ];
      filterParts.push(`[${idx}:a]${afOps.join(",")}[aslot${idx}]`);
      audioBranches.push(`[aslot${idx}]`);
    }
  });

  // 2. Chain video slots with transitions or cuts
  let currentVideoLabel = "v0";
  let currentDuration = layout.slots[0].rawDurationSec;

  for (let i = 1; i < layout.slots.length; i++) {
    const slotLayout = layout.slots[i];
    const nextLabel = `vc${i}`;

    if (slotLayout.effectiveTransitionInSec > 0) {
      const offset = Math.max(
        0,
        Number((currentDuration - slotLayout.effectiveTransitionInSec).toFixed(3))
      );
      const xfadeName = mapTransition(slotLayout.slot.transitionIn);
      filterParts.push(
        `[${currentVideoLabel}][v${i}]xfade=transition=${xfadeName}:duration=${slotLayout.effectiveTransitionInSec.toFixed(3)}:offset=${offset.toFixed(3)},settb=1/1000[${nextLabel}]`
      );
      currentDuration =
        currentDuration + slotLayout.rawDurationSec - slotLayout.effectiveTransitionInSec;
    } else {
      filterParts.push(
        `[${currentVideoLabel}][v${i}]concat=n=2:v=1:a=0,settb=1/1000[${nextLabel}]`
      );
      currentDuration += slotLayout.rawDurationSec;
    }

    currentVideoLabel = nextLabel;
  }

  // 3. Burn in ASS subtitles/text overlays if present
  if (assSubtitlePath && project.overlays.length > 0) {
    filterParts.push(
      `[${currentVideoLabel}]ass=${escapeFfmpegFilterPath(assSubtitlePath)}[vout]`
    );
    currentVideoLabel = "vout";
  }

  // 4. Add background music track or silent fallback audio stream
  let nextInputIdx = layout.slots.length;
  const finalTotalSec = Math.max(0.5, Number(currentDuration.toFixed(3)));

  if (project.audioTrack) {
    const musicPath = filePathsById.get(project.audioTrack.assetId);
    if (musicPath) {
      inputArgs.push(
        "-stream_loop",
        "-1",
        "-ss",
        String(project.audioTrack.startOffsetSec || 0),
        "-t",
        String(finalTotalSec),
        "-i",
        musicPath
      );

      const fadeOutStart = Math.max(0, finalTotalSec - (project.audioTrack.fadeOutSec || 0.6));
      const afOps = [
        `volume=${project.audioTrack.volume.toFixed(2)}`,
        `afade=t=in:st=0:d=${(project.audioTrack.fadeInSec || 0.2).toFixed(2)}`,
        `afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${(project.audioTrack.fadeOutSec || 0.6).toFixed(2)}`,
        "aformat=sample_rates=44100:channel_layouts=stereo",
      ];
      filterParts.push(`[${nextInputIdx}:a]${afOps.join(",")}[abgm]`);
      audioBranches.push("[abgm]");
      nextInputIdx += 1;
    }
  }

  if (audioBranches.length === 0) {
    inputArgs.push(
      "-f",
      "lavfi",
      "-t",
      String(finalTotalSec),
      "-i",
      "anullsrc=channel_layout=stereo:sample_rate=44100"
    );
    filterParts.push(`[${nextInputIdx}:a]anull[aout]`);
  } else if (audioBranches.length === 1) {
    const single = audioBranches[0].replace(/^\[|\]$/g, "");
    filterParts.push(`[${single}]apad,atrim=0:${finalTotalSec.toFixed(3)}[aout]`);
  } else {
    filterParts.push(
      `${audioBranches.join("")}amix=inputs=${audioBranches.length}:duration=longest:normalize=0,atrim=0:${finalTotalSec.toFixed(3)}[aout]`
    );
  }

  const args = [
    "-y",
    "-progress",
    "pipe:1",
    "-nostats",
    ...inputArgs,
    "-filter_complex",
    filterParts.join(";"),
    "-map",
    `[${currentVideoLabel}]`,
    "-map",
    "[aout]",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    quality === "1080p" ? "20" : "23",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    "-movflags",
    "+faststart",
    "-t",
    finalTotalSec.toFixed(3),
    outputPath,
  ];

  return { args, totalDurationSec: finalTotalSec };
}
