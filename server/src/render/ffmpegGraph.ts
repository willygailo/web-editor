import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeTimelineLayout,
  getAspectDimensions,
  getProjectAudioTracks,
  getStickerById,
  type ClipAdjust,
  type ClipTransform,
  type CutProject,
  type FilterPreset,
  type MediaAsset,
  type MotionPreset,
  type TransitionType,
} from "@cutflow/shared";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function resolveDefaultAssetsSubdir(subdir: "fonts" | "stickers"): string | undefined {
  const dir = path.resolve(__dirname, "../../assets", subdir);
  return fs.existsSync(dir) ? dir : undefined;
}

export interface BuildRenderPlanInput {
  project: CutProject;
  quality: "720p" | "1080p";
  assetsById: Map<string, MediaAsset>;
  filePathsById: Map<string, string>;
  outputPath: string;
  assSubtitlePath?: string;
  builtinsDir?: string;
  stickersDir?: string;
  fontsDir?: string;
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

function filterChainForAdjust(adjust?: ClipAdjust): string[] {
  if (!adjust) return [];
  const ops: string[] = [];
  const hasEq =
    Math.abs(adjust.brightness) > 0.01 ||
    Math.abs(adjust.contrast) > 0.01 ||
    Math.abs(adjust.saturation) > 0.01;
  if (hasEq) {
    const b = Math.max(-0.5, Math.min(0.5, adjust.brightness)).toFixed(2);
    const c = Math.max(0.5, Math.min(1.6, 1 + adjust.contrast)).toFixed(2);
    const s = Math.max(0, Math.min(2.2, 1 + adjust.saturation)).toFixed(2);
    ops.push(`eq=brightness=${b}:contrast=${c}:saturation=${s}`);
  }
  if (Math.abs(adjust.warmth) > 0.01) {
    const w = Math.max(-0.4, Math.min(0.4, adjust.warmth));
    ops.push(`colorbalance=rs=${w.toFixed(2)}:bs=${(-w).toFixed(2)}`);
  }
  if (adjust.vignette > 0.02) {
    const angle = (Math.min(1, adjust.vignette) * 0.72).toFixed(2);
    ops.push(`vignette=angle=${angle}`);
  }
  return ops;
}

function buildTransformFilter(
  transform: ClipTransform | undefined,
  width: number,
  height: number
): string[] {
  if (!transform) return [];
  const hasScale = Math.abs(transform.scale - 1) > 0.01;
  const hasShift =
    Math.abs(transform.offsetX) > 0.005 || Math.abs(transform.offsetY) > 0.005;
  const hasRot = Math.abs(transform.rotationDeg) > 0.5;
  if (!hasScale && !hasShift && !hasRot) return [];

  const ops: string[] = [];
  if (hasRot) {
    const rad = ((transform.rotationDeg * Math.PI) / 180).toFixed(4);
    ops.push(`rotate=${rad}:c=black:ow=iw:oh=ih`);
  }

  const sc = Math.max(0.5, Math.min(3, transform.scale));
  const scaledW = Math.max(16, Math.round((width * sc) / 2) * 2);
  const scaledH = Math.max(16, Math.round((height * sc) / 2) * 2);
  const dx = Math.round(transform.offsetX * width);
  const dy = Math.round(transform.offsetY * height);

  if (sc >= 1) {
    const cropX = Math.max(0, Math.min(scaledW - width, Math.round((scaledW - width) / 2 - dx)));
    const cropY = Math.max(0, Math.min(scaledH - height, Math.round((scaledH - height) / 2 - dy)));
    ops.push(`scale=${scaledW}:${scaledH}`, `crop=${width}:${height}:${cropX}:${cropY}`);
  } else {
    const padX = Math.max(0, Math.min(width - scaledW, Math.round((width - scaledW) / 2 + dx)));
    const padY = Math.max(0, Math.min(height - scaledH, Math.round((height - scaledH) / 2 + dy)));
    ops.push(`scale=${scaledW}:${scaledH}`, `pad=${width}:${height}:${padX}:${padY}:black`);
  }

  return ops;
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

export function escapeFfmpegFilterPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  return `'${normalized.replace(/'/g, "'\\\\\\''").replace(/:/g, "\\:")}'`;
}

export function buildFfmpegRenderPlan(input: BuildRenderPlanInput): FfmpegRenderPlan {
  const {
    project,
    quality,
    assetsById,
    filePathsById,
    outputPath,
    assSubtitlePath,
    builtinsDir,
    stickersDir = resolveDefaultAssetsSubdir("stickers"),
    fontsDir = resolveDefaultAssetsSubdir("fonts"),
  } = input;
  const { width, height } = getAspectDimensions(project.aspectRatio, quality);
  const fps = project.fps || 30;
  const layout = computeTimelineLayout(project);

  const inputArgs: string[] = [];
  const filterParts: string[] = [];
  const voiceBranches: string[] = [];
  const duckedBgmBranches: string[] = [];
  const regularAudioBranches: string[] = [];

  // 1. Add visual inputs (one per timeline slot for clean trim/speed/reverse isolation)
  layout.slots.forEach((slotLayout, idx) => {
    const { slot, rawDurationSec } = slotLayout;
    const asset = assetsById.get(slot.assetId);
    const filePath = filePathsById.get(slot.assetId);
    if (!asset || !filePath) {
      throw new Error(`Missing media file for asset ${slot.assetId}`);
    }

    const sourceSpan = Math.max(0.2, slot.sourceEndSec - slot.sourceStartSec);

    if (asset.kind === "image") {
      inputArgs.push(
        "-loop",
        "1",
        "-framerate",
        String(fps),
        "-t",
        String(rawDurationSec),
        "-i",
        filePath
      );
    } else {
      inputArgs.push(
        "-ss",
        String(slot.sourceStartSec),
        "-t",
        String(sourceSpan),
        "-i",
        filePath
      );
    }

    const vfOps: string[] = [];
    if (asset.kind === "video") {
      if (slot.reversed) {
        vfOps.push("reverse");
      }
      if (Math.abs(slot.speed - 1) >= 0.02) {
        vfOps.push(`setpts=(PTS-STARTPTS)/${slot.speed.toFixed(3)}`);
      } else {
        vfOps.push("setpts=PTS-STARTPTS");
      }
      vfOps.push(`fps=${fps}`);
    }

    vfOps.push(...buildMotionFilter(slot.motion, width, height, fps, rawDurationSec));
    vfOps.push(...buildTransformFilter(slot.transform, width, height));
    vfOps.push(...filterChainForPreset(slot.filter));
    vfOps.push(...filterChainForAdjust(slot.adjust));
    vfOps.push(`fps=${fps}`, "settb=1/1000", "setsar=1", "format=yuv420p");

    filterParts.push(`[${idx}:v]${vfOps.join(",")}[v${idx}]`);

    if (asset.kind === "video" && asset.hasAudio && !slot.muteOriginalAudio && slot.volume > 0) {
      const delayMs = Math.max(0, Math.round(slotLayout.timelineStartSec * 1000));
      const nextSlot = layout.slots[idx + 1];
      const nextOverlap = nextSlot?.effectiveTransitionInSec ?? 0;
      const afOps = [
        ...(slot.reversed ? ["areverse"] : []),
        ...buildAtempoChain(slot.speed),
        `volume=${slot.volume.toFixed(2)}`,
      ];
      if (slotLayout.effectiveTransitionInSec > 0.05) {
        afOps.push(`afade=t=in:st=0:d=${slotLayout.effectiveTransitionInSec.toFixed(2)}`);
      }
      if (nextOverlap > 0.05 && slotLayout.rawDurationSec > nextOverlap + 0.05) {
        const fadeOutStart = Math.max(0, slotLayout.rawDurationSec - nextOverlap);
        afOps.push(`afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${nextOverlap.toFixed(2)}`);
      }
      afOps.push(
        `adelay=${delayMs}|${delayMs}`,
        "aformat=sample_rates=44100:channel_layouts=stereo"
      );
      filterParts.push(`[${idx}:a]${afOps.join(",")}[aslot${idx}]`);
      voiceBranches.push(`[aslot${idx}]`);
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

  let nextInputIdx = layout.slots.length;
  const finalTotalSec = Math.max(0.5, Number(currentDuration.toFixed(3)));

  // 3. Composite stickers (uploaded image assets or bundled PNG / fallback SVG)
  const stickers = project.stickers || [];
  if (stickers.length > 0) {
    stickers.forEach((st, idx) => {
      if (st.startSec >= finalTotalSec) return;
      const start = Math.max(0, st.startSec);
      const end = Math.min(finalTotalSec, st.endSec);
      if (end <= start) return;

      let stickerInputPath: string | undefined;
      if (st.assetId) {
        const customPath = filePathsById.get(st.assetId);
        if (customPath) {
          stickerInputPath = customPath;
        }
      }

      if (!stickerInputPath) {
        if (st.assetId) return;
        const item = getStickerById(st.stickerId);
        const bundledPngPath = stickersDir
          ? path.join(stickersDir, `sticker-${item.id}.png`)
          : undefined;

        stickerInputPath =
          bundledPngPath && fs.existsSync(bundledPngPath) ? bundledPngPath : undefined;

        if (!stickerInputPath && builtinsDir) {
          fs.mkdirSync(builtinsDir, { recursive: true });
          const svgPath = path.join(builtinsDir, `sticker-${item.id}.svg`);
          if (!fs.existsSync(svgPath)) {
            fs.writeFileSync(svgPath, item.svg, "utf8");
          }
          stickerInputPath = svgPath;
        }
      }

      if (!stickerInputPath) return;

      const stickerIn = nextInputIdx++;
      inputArgs.push(
        "-loop",
        "1",
        "-framerate",
        String(fps),
        "-t",
        String(finalTotalSec),
        "-i",
        stickerInputPath
      );

      const targetStickerW = Math.max(48, Math.round((width * 0.22 * st.scale) / 2) * 2);
      const rotOp =
        Math.abs(st.rotationDeg) > 0.5
          ? `,rotate=${((st.rotationDeg * Math.PI) / 180).toFixed(4)}:c=none:ow=rotw(iw):oh=roth(ih)`
          : "";
      filterParts.push(
        `[${stickerIn}:v]format=rgba,scale=${targetStickerW}:-2${rotOp}[stk${idx}]`
      );

      const outLabel = `vst${idx}`;
      filterParts.push(
        `[${currentVideoLabel}][stk${idx}]overlay=x='round(${st.xNorm.toFixed(3)}*W-w/2)':y='round(${st.yNorm.toFixed(3)}*H-h/2)':enable='between(t,${start.toFixed(2)},${end.toFixed(2)})'[${outLabel}]`
      );
      currentVideoLabel = outLabel;
    });
  }

  // 4. Burn in ASS subtitles/text overlays if present
  if (assSubtitlePath && project.overlays.length > 0) {
    const assOptions = [`filename=${escapeFfmpegFilterPath(assSubtitlePath)}`];
    if (fontsDir) {
      assOptions.push(`fontsdir=${escapeFfmpegFilterPath(fontsDir)}`);
    }
    filterParts.push(`[${currentVideoLabel}]ass=${assOptions.join(":")}[vout]`);
    currentVideoLabel = "vout";
  }

  // Ensure standard TV-range yuv420p output format (cleanly converts JPEG yuvj420p / rgba overlays)
  filterParts.push(`[${currentVideoLabel}]scale=out_range=tv,format=yuv420p[vfinal]`);
  currentVideoLabel = "vfinal";

  // 5. Add multi-track audio (BGM, SFX, Voiceovers) with optional BGM ducking under voice
  const audioTracks = getProjectAudioTracks(project);
  audioTracks.forEach((track, idx) => {
    const audioPath = filePathsById.get(track.assetId);
    if (!audioPath) return;

    const remainingTotal = finalTotalSec - (track.timelineStartSec || 0);
    if (remainingTotal <= 0.05) return;

    const audioIn = nextInputIdx++;
    const trackAsset = assetsById.get(track.assetId);
    const offsetSec = Math.max(0, track.startOffsetSec || 0);
    const clipDur = Math.max(
      0.2,
      Math.min(track.durationSec ?? remainingTotal, remainingTotal)
    );
    const assetDur = trackAsset?.durationSec ?? 0;
    const needsLoop =
      track.kind === "bgm" && (assetDur <= 0.1 || assetDur - offsetSec < clipDur - 0.05);

    if (needsLoop) {
      inputArgs.push("-vn", "-stream_loop", "-1", "-i", audioPath);
    } else {
      inputArgs.push("-vn", "-ss", String(offsetSec), "-t", String(clipDur), "-i", audioPath);
    }

    const fadeIn = Math.min(clipDur * 0.4, track.fadeInSec || 0);
    const fadeOut = Math.min(clipDur * 0.4, track.fadeOutSec || 0);
    const fadeOutStart = Math.max(0, clipDur - fadeOut);
    const delayMs = Math.max(0, Math.round((track.timelineStartSec || 0) * 1000));

    const afOps: string[] = [];
    if (needsLoop) {
      afOps.push(
        `atrim=start=${offsetSec.toFixed(3)}:duration=${clipDur.toFixed(3)}`,
        "asetpts=PTS-STARTPTS"
      );
    } else {
      afOps.push("asetpts=PTS-STARTPTS", `atrim=0:${clipDur.toFixed(3)}`);
    }
    afOps.push(`volume=${track.volume.toFixed(2)}`);
    if (fadeIn > 0.02) afOps.push(`afade=t=in:st=0:d=${fadeIn.toFixed(2)}`);
    if (fadeOut > 0.02) afOps.push(`afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${fadeOut.toFixed(2)}`);
    if (delayMs > 0) afOps.push(`adelay=${delayMs}|${delayMs}`);
    afOps.push("aformat=sample_rates=44100:channel_layouts=stereo");

    const branchLabel = `atrk${idx}`;
    filterParts.push(`[${audioIn}:a]${afOps.join(",")}[${branchLabel}]`);
    if (track.kind === "voiceover") {
      voiceBranches.push(`[${branchLabel}]`);
    } else if (track.kind === "bgm" && track.duckUnderVoice) {
      duckedBgmBranches.push(`[${branchLabel}]`);
    } else {
      regularAudioBranches.push(`[${branchLabel}]`);
    }
  });

  let audioBranches: string[];
  if (duckedBgmBranches.length > 0 && voiceBranches.length > 0) {
    if (voiceBranches.length === 1) {
      const voiceName = voiceBranches[0].replace(/^\[|\]$/g, "");
      filterParts.push(`[${voiceName}]apad,atrim=0:${finalTotalSec.toFixed(3)}[vcomb]`);
    } else {
      filterParts.push(
        `${voiceBranches.join("")}amix=inputs=${voiceBranches.length}:duration=longest:normalize=0,apad,atrim=0:${finalTotalSec.toFixed(3)}[vcomb]`
      );
    }

    const scLabels = duckedBgmBranches.map((_, i) => `[vsc${i}]`);
    filterParts.push(
      `[vcomb]asplit=${duckedBgmBranches.length + 1}[voicemix]${scLabels.join("")}`
    );

    const compressedBgm: string[] = [];
    duckedBgmBranches.forEach((branch, i) => {
      const rawName = branch.replace(/^\[|\]$/g, "");
      filterParts.push(
        `[${rawName}]apad,atrim=0:${finalTotalSec.toFixed(3)}[bgmpad${i}]`
      );
      filterParts.push(
        `[bgmpad${i}]${scLabels[i]}sidechaincompress=threshold=0.02:ratio=6:attack=40:release=350:level_sc=2:mix=0.85[bgmduck${i}]`
      );
      compressedBgm.push(`[bgmduck${i}]`);
    });

    audioBranches = ["[voicemix]", ...compressedBgm, ...regularAudioBranches];
  } else {
    audioBranches = [...voiceBranches, ...duckedBgmBranches, ...regularAudioBranches];
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
