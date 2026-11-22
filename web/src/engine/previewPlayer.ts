import {
  computeTimelineLayout,
  getAspectDimensions,
  type ComputedSlotLayout,
  type CutProject,
  type FilterPreset,
  type MediaAsset,
  type MotionPreset,
  type TextOverlay,
} from "@cutflow/shared";

function cssFilterForPreset(preset: FilterPreset): string {
  switch (preset) {
    case "vivid":
      return "contrast(1.08) saturate(1.3) brightness(1.02)";
    case "cinematic":
      return "contrast(1.12) saturate(0.86) brightness(0.97) sepia(0.1)";
    case "warm-film":
      return "contrast(1.05) saturate(1.12) sepia(0.18) brightness(1.02)";
    case "bw-contrast":
      return "grayscale(1) contrast(1.24)";
    case "none":
      return "none";
  }
}

function drawVisualCover(
  ctx: CanvasRenderingContext2D,
  source: HTMLVideoElement | HTMLImageElement,
  canvasW: number,
  canvasH: number,
  motion: MotionPreset,
  progress01: number,
  filter: FilterPreset,
  extraScale = 1
): void {
  const srcW =
    source instanceof HTMLVideoElement
      ? source.videoWidth
      : source.naturalWidth;
  const srcH =
    source instanceof HTMLVideoElement
      ? source.videoHeight
      : source.naturalHeight;

  if (!srcW || !srcH) return;

  const baseScale = Math.max(canvasW / srcW, canvasH / srcH);
  let zoom = 1;
  let panX = 0;

  switch (motion) {
    case "zoom-in":
      zoom = 1 + 0.16 * progress01;
      break;
    case "zoom-out":
      zoom = 1.16 - 0.16 * progress01;
      break;
    case "punch-zoom":
      zoom = progress01 < 0.22 ? 1.2 - 0.18 * (progress01 / 0.22) : 1.02 + 0.05 * progress01;
      break;
    case "pan-left":
      zoom = 1.12;
      panX = (0.5 - progress01) * (canvasW * 0.08);
      break;
    case "pan-right":
      zoom = 1.12;
      panX = (progress01 - 0.5) * (canvasW * 0.08);
      break;
    case "none":
      zoom = 1;
      break;
  }

  const drawW = srcW * baseScale * zoom * extraScale;
  const drawH = srcH * baseScale * zoom * extraScale;
  const dx = (canvasW - drawW) / 2 + panX;
  const dy = (canvasH - drawH) / 2;

  ctx.save();
  ctx.filter = cssFilterForPreset(filter);
  ctx.drawImage(source, dx, dy, drawW, drawH);
  ctx.restore();
}

function drawTextOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: TextOverlay,
  canvasW: number,
  canvasH: number
): void {
  const scale = canvasW / 1080;
  const paddingX = 28 * scale;
  const paddingY = 14 * scale;
  const fontSize =
    overlay.style === "bold-hook"
      ? Math.round(64 * scale)
      : overlay.style === "minimal-caption"
        ? Math.round(44 * scale)
        : Math.round(54 * scale);

  ctx.save();
  ctx.font = `${overlay.style === "minimal-caption" ? "500" : "800"} ${fontSize}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  const y =
    overlay.position === "top"
      ? canvasH * 0.14
      : overlay.position === "center"
        ? canvasH * 0.5
        : canvasH * 0.84;

  const words = overlay.text.split(/\s+/);
  const maxWidth = canvasW * 0.84;
  const lines: string[] = [];
  let current = "";
  for (const w of words) {
    const test = current ? `${current} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);

  const lineHeight = fontSize * 1.24;
  const blockH = lines.length * lineHeight;
  const startY = y - blockH / 2 + lineHeight / 2;

  lines.forEach((line, idx) => {
    const ly = startY + idx * lineHeight;
    const metrics = ctx.measureText(line);

    if (overlay.style === "capcut-pop") {
      const boxW = metrics.width + paddingX * 1.4;
      const boxH = lineHeight + paddingY * 0.4;
      ctx.fillStyle = "#fde047";
      ctx.beginPath();
      ctx.roundRect(canvasW / 2 - boxW / 2, ly - boxH / 2, boxW, boxH, 16 * scale);
      ctx.fill();
      ctx.fillStyle = "#0f172a";
      ctx.fillText(line, canvasW / 2, ly);
    } else if (overlay.style === "neon-badge") {
      const boxW = metrics.width + paddingX * 1.4;
      const boxH = lineHeight + paddingY * 0.4;
      ctx.fillStyle = "rgba(15, 23, 42, 0.88)";
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = Math.max(2, 4 * scale);
      ctx.beginPath();
      ctx.roundRect(canvasW / 2 - boxW / 2, ly - boxH / 2, boxW, boxH, 18 * scale);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = "#22d3ee";
      ctx.fillText(line, canvasW / 2, ly);
    } else if (overlay.style === "bold-hook") {
      ctx.lineWidth = Math.max(4, 10 * scale);
      ctx.strokeStyle = "#090b10";
      ctx.strokeText(line, canvasW / 2, ly);
      ctx.fillStyle = "#ffffff";
      ctx.fillText(line, canvasW / 2, ly);
    } else {
      const boxW = metrics.width + paddingX;
      const boxH = lineHeight + paddingY * 0.2;
      ctx.fillStyle = "rgba(9, 11, 16, 0.56)";
      ctx.beginPath();
      ctx.roundRect(canvasW / 2 - boxW / 2, ly - boxH / 2, boxW, boxH, 12 * scale);
      ctx.fill();
      ctx.fillStyle = "#f8fafc";
      ctx.fillText(line, canvasW / 2, ly);
    }
  });

  ctx.restore();
}

export class PreviewCompositor {
  private videoPair: [HTMLVideoElement, HTMLVideoElement];
  private slotAssetBound: [string | null, string | null] = [null, null];
  private images = new Map<string, HTMLImageElement>();
  private audioEl: HTMLAudioElement;
  private boundAudioUrl: string | null = null;

  constructor() {
    this.videoPair = [this.createVideoEl(), this.createVideoEl()];
    this.audioEl = document.createElement("audio");
    this.audioEl.crossOrigin = "anonymous";
    this.audioEl.preload = "auto";
    this.audioEl.loop = true;
  }

  private createVideoEl(): HTMLVideoElement {
    const v = document.createElement("video");
    v.playsInline = true;
    v.muted = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
    return v;
  }

  private getImage(asset: MediaAsset): HTMLImageElement {
    const existing = this.images.get(asset.id);
    if (existing) return existing;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = asset.url;
    this.images.set(asset.id, img);
    return img;
  }

  private ensureVideoBound(
    channelIdx: 0 | 1,
    asset: MediaAsset,
    sourceTime: number,
    speed: number,
    isPlaying: boolean,
    unmuted: boolean,
    volume: number
  ): HTMLVideoElement {
    const video = this.videoPair[channelIdx];
    if (this.slotAssetBound[channelIdx] !== asset.url) {
      this.slotAssetBound[channelIdx] = asset.url;
      video.src = asset.url;
      video.load();
    }

    video.playbackRate = speed;
    video.muted = !unmuted;
    video.volume = Math.min(1, Math.max(0, volume));

    if (video.readyState >= 1) {
      const drift = Math.abs(video.currentTime - sourceTime);
      if (drift > (isPlaying ? 0.25 : 0.06)) {
        try {
          video.currentTime = Math.max(0, sourceTime);
        } catch {
          // ignore seeking before metadata ready
        }
      }
    }

    if (isPlaying) {
      if (video.paused && video.readyState >= 2) {
        void video.play().catch(() => undefined);
      }
    } else if (!video.paused) {
      video.pause();
    }

    return video;
  }

  syncAudio(project: CutProject | null, assetsById: Map<string, MediaAsset>, timelineSec: number, isPlaying: boolean): void {
    const track = project?.audioTrack;
    const audioAsset = track ? assetsById.get(track.assetId) : undefined;
    if (!track || !audioAsset) {
      if (!this.audioEl.paused) this.audioEl.pause();
      return;
    }

    if (this.boundAudioUrl !== audioAsset.url) {
      this.boundAudioUrl = audioAsset.url;
      this.audioEl.src = audioAsset.url;
      this.audioEl.load();
    }

    this.audioEl.volume = Math.min(1, Math.max(0, track.volume));
    const targetAudioTime =
      ((track.startOffsetSec || 0) + timelineSec) % Math.max(1, audioAsset.durationSec);

    if (this.audioEl.readyState >= 1) {
      const drift = Math.abs(this.audioEl.currentTime - targetAudioTime);
      if (drift > (isPlaying ? 0.28 : 0.08)) {
        try {
          this.audioEl.currentTime = targetAudioTime;
        } catch {
          // ignore
        }
      }
    }

    if (isPlaying) {
      if (this.audioEl.paused) {
        void this.audioEl.play().catch(() => undefined);
      }
    } else if (!this.audioEl.paused) {
      this.audioEl.pause();
    }
  }

  pauseAll(): void {
    for (const v of this.videoPair) {
      if (!v.paused) v.pause();
    }
    if (!this.audioEl.paused) this.audioEl.pause();
  }

  renderFrame(
    canvas: HTMLCanvasElement,
    project: CutProject,
    assetsById: Map<string, MediaAsset>,
    timelineSec: number,
    isPlaying: boolean
  ): ComputedSlotLayout | null {
    const dims = getAspectDimensions(project.aspectRatio, "720p");
    const targetW = Math.round(dims.width * 0.75);
    const targetH = Math.round(dims.height * 0.75);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return null;

    ctx.fillStyle = "#090b10";
    ctx.fillRect(0, 0, targetW, targetH);

    const layout = computeTimelineLayout(project);
    if (layout.slots.length === 0) return null;

    const t = Math.max(0, Math.min(layout.totalDurationSec, timelineSec));

    let activeIdx = layout.slots.findIndex(
      (s) => t >= s.timelineStartSec && t <= s.timelineEndSec
    );
    if (activeIdx === -1) activeIdx = layout.slots.length - 1;

    const currentLayout = layout.slots[activeIdx];
    const prevLayout = activeIdx > 0 ? layout.slots[activeIdx - 1] : null;
    const inTransition =
      prevLayout !== null &&
      currentLayout.effectiveTransitionInSec > 0 &&
      t < currentLayout.timelineStartSec + currentLayout.effectiveTransitionInSec;

    const drawSlot = (
      sl: ComputedSlotLayout,
      channel: 0 | 1,
      extraScale = 1
    ) => {
      const asset = assetsById.get(sl.slot.assetId);
      if (!asset) return;

      const elapsed = Math.max(0, t - sl.timelineStartSec);
      const progress01 = Math.min(1, elapsed / Math.max(0.2, sl.rawDurationSec));

      if (asset.kind === "image") {
        const img = this.getImage(asset);
        if (img.complete && img.naturalWidth > 0) {
          drawVisualCover(
            ctx,
            img,
            targetW,
            targetH,
            sl.slot.motion,
            progress01,
            sl.slot.filter,
            extraScale
          );
        }
      } else {
        const sourceTime = Math.min(
          sl.slot.sourceEndSec,
          sl.slot.sourceStartSec + elapsed * sl.slot.speed
        );
        const video = this.ensureVideoBound(
          channel,
          asset,
          sourceTime,
          sl.slot.speed,
          isPlaying,
          !sl.slot.muteOriginalAudio && sl.slot.volume > 0,
          sl.slot.volume
        );
        if (video.readyState >= 2) {
          drawVisualCover(
            ctx,
            video,
            targetW,
            targetH,
            sl.slot.motion,
            progress01,
            sl.slot.filter,
            extraScale
          );
        }
      }
    };

    const currChannel = (currentLayout.index % 2) as 0 | 1;
    const prevChannel = (currChannel === 0 ? 1 : 0) as 0 | 1;

    if (inTransition && prevLayout) {
      const trProgress =
        (t - currentLayout.timelineStartSec) / currentLayout.effectiveTransitionInSec;
      const trType = currentLayout.slot.transitionIn;

      if (trType === "slide-left") {
        drawSlot(prevLayout, prevChannel);
        ctx.save();
        ctx.translate(targetW * (1 - trProgress), 0);
        drawSlot(currentLayout, currChannel);
        ctx.restore();
      } else if (trType === "flash-white") {
        drawSlot(trProgress < 0.5 ? prevLayout : currentLayout, trProgress < 0.5 ? prevChannel : currChannel);
        const flashAlpha = 1 - Math.abs(trProgress * 2 - 1);
        ctx.save();
        ctx.fillStyle = `rgba(255,255,255,${(flashAlpha * 0.92).toFixed(3)})`;
        ctx.fillRect(0, 0, targetW, targetH);
        ctx.restore();
      } else if (trType === "zoom-blur") {
        drawSlot(prevLayout, prevChannel, 1 + trProgress * 0.25);
        ctx.save();
        ctx.globalAlpha = trProgress;
        drawSlot(currentLayout, currChannel, 1.2 - trProgress * 0.2);
        ctx.restore();
      } else {
        drawSlot(prevLayout, prevChannel);
        ctx.save();
        ctx.globalAlpha = trProgress;
        drawSlot(currentLayout, currChannel);
        ctx.restore();
      }
    } else {
      drawSlot(currentLayout, currChannel);
      // Preload next slot quietly onto the inactive channel
      const nextLayout = layout.slots[activeIdx + 1];
      if (nextLayout) {
        const nextAsset = assetsById.get(nextLayout.slot.assetId);
        if (nextAsset?.kind === "video") {
          const inactiveVideo = this.videoPair[prevChannel];
          if (this.slotAssetBound[prevChannel] !== nextAsset.url) {
            this.slotAssetBound[prevChannel] = nextAsset.url;
            inactiveVideo.src = nextAsset.url;
            inactiveVideo.load();
          }
        }
      }
    }

    for (const overlay of project.overlays) {
      if (t >= overlay.startSec && t <= overlay.endSec) {
        drawTextOverlay(ctx, overlay, targetW, targetH);
      }
    }

    return currentLayout;
  }

  destroy(): void {
    this.pauseAll();
    for (const v of this.videoPair) {
      v.removeAttribute("src");
      v.load();
    }
    this.audioEl.removeAttribute("src");
    this.audioEl.load();
  }
}
