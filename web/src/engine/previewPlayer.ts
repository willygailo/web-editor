import {
  computeTimelineLayout,
  getAspectDimensions,
  getOverlayNormalizedPos,
  getProjectAudioTracks,
  getStickerById,
  type ClipAdjust,
  type ClipTransform,
  type ComputedSlotLayout,
  type CutProject,
  type FilterPreset,
  type MediaAsset,
  type MotionPreset,
  type StickerOverlay,
  type TextOverlay,
} from "@cutflow/shared";

function buildCanvasFilter(preset: FilterPreset, adjust?: ClipAdjust): string {
  const parts: string[] = [];
  switch (preset) {
    case "vivid":
      parts.push("contrast(1.08) saturate(1.3) brightness(1.02)");
      break;
    case "cinematic":
      parts.push("contrast(1.12) saturate(0.86) brightness(0.97) sepia(0.1)");
      break;
    case "warm-film":
      parts.push("contrast(1.05) saturate(1.12) sepia(0.18) brightness(1.02)");
      break;
    case "bw-contrast":
      parts.push("grayscale(1) contrast(1.24)");
      break;
    case "none":
      break;
  }

  if (adjust) {
    if (Math.abs(adjust.brightness) > 0.01) {
      parts.push(`brightness(${(1 + adjust.brightness).toFixed(2)})`);
    }
    if (Math.abs(adjust.contrast) > 0.01) {
      parts.push(`contrast(${(1 + adjust.contrast).toFixed(2)})`);
    }
    if (Math.abs(adjust.saturation) > 0.01) {
      parts.push(`saturate(${Math.max(0, 1 + adjust.saturation).toFixed(2)})`);
    }
    if (adjust.warmth > 0.01) {
      parts.push(`sepia(${(adjust.warmth * 0.6).toFixed(2)})`);
    } else if (adjust.warmth < -0.01) {
      parts.push(`hue-rotate(${Math.round(adjust.warmth * 35)}deg)`);
    }
  }

  return parts.length > 0 ? parts.join(" ") : "none";
}

function drawVisualCover(
  ctx: CanvasRenderingContext2D,
  source: HTMLVideoElement | HTMLImageElement,
  canvasW: number,
  canvasH: number,
  motion: MotionPreset,
  progress01: number,
  filter: FilterPreset,
  adjust?: ClipAdjust,
  transform?: ClipTransform,
  extraScale = 1
): void {
  const srcW =
    source instanceof HTMLVideoElement ? source.videoWidth : source.naturalWidth;
  const srcH =
    source instanceof HTMLVideoElement ? source.videoHeight : source.naturalHeight;

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
      zoom =
        progress01 < 0.22
          ? 1.2 - 0.18 * (progress01 / 0.22)
          : 1.02 + 0.05 * progress01;
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

  const tfScale = transform?.scale ?? 1;
  const tfOffX = (transform?.offsetX ?? 0) * canvasW;
  const tfOffY = (transform?.offsetY ?? 0) * canvasH;
  const tfRot = ((transform?.rotationDeg ?? 0) * Math.PI) / 180;

  const drawW = srcW * baseScale * zoom * tfScale * extraScale;
  const drawH = srcH * baseScale * zoom * tfScale * extraScale;

  ctx.save();
  ctx.filter = buildCanvasFilter(filter, adjust);
  ctx.translate(canvasW / 2 + panX + tfOffX, canvasH / 2 + tfOffY);
  if (Math.abs(tfRot) > 0.002) ctx.rotate(tfRot);
  ctx.drawImage(source, -drawW / 2, -drawH / 2, drawW, drawH);
  ctx.restore();

  if (adjust && adjust.vignette > 0.02) {
    ctx.save();
    const grad = ctx.createRadialGradient(
      canvasW / 2,
      canvasH / 2,
      Math.min(canvasW, canvasH) * 0.25,
      canvasW / 2,
      canvasH / 2,
      Math.max(canvasW, canvasH) * 0.72
    );
    grad.addColorStop(0, "rgba(0,0,0,0)");
    grad.addColorStop(1, `rgba(0,0,0,${(adjust.vignette * 0.72).toFixed(2)})`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, canvasW, canvasH);
    ctx.restore();
  }
}

function drawTextOverlay(
  ctx: CanvasRenderingContext2D,
  overlay: TextOverlay,
  canvasW: number,
  canvasH: number,
  timelineSec: number,
  isSelected: boolean
): void {
  const baseScale = canvasW / 1080;
  const userScale = overlay.scale ?? 1;
  const elapsed = Math.max(0, timelineSec - overlay.startSec);

  let animScale = 1;
  let animAlpha = 1;
  let animShiftY = 0;

  if (overlay.animation === "pop" && elapsed < 0.22) {
    const p = elapsed / 0.22;
    animScale = p < 0.6 ? 0.72 + (p / 0.6) * 0.35 : 1.07 - ((p - 0.6) / 0.4) * 0.07;
    animAlpha = Math.min(1, p * 1.6);
  } else if (overlay.animation === "fade" && elapsed < 0.24) {
    animAlpha = elapsed / 0.24;
  } else if (overlay.animation === "slide-up" && elapsed < 0.24) {
    const p = elapsed / 0.24;
    animShiftY = (1 - p) * canvasH * 0.04;
    animAlpha = p;
  }

  const fontSize =
    (overlay.style === "bold-hook"
      ? 64
      : overlay.style === "minimal-caption"
        ? 44
        : 54) *
    baseScale *
    userScale;

  const { xNorm, yNorm } = getOverlayNormalizedPos(overlay);
  const cx = xNorm * canvasW;
  const cy = yNorm * canvasH + animShiftY;

  ctx.save();
  ctx.globalAlpha = animAlpha;
  ctx.translate(cx, cy);
  if (Math.abs(overlay.rotationDeg ?? 0) > 0.2) {
    ctx.rotate(((overlay.rotationDeg ?? 0) * Math.PI) / 180);
  }
  ctx.scale(animScale, animScale);

  ctx.font = `${overlay.style === "minimal-caption" ? "500" : "800"} ${Math.round(fontSize)}px Inter, system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

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
  const startY = -blockH / 2 + lineHeight / 2;
  const paddingX = 28 * baseScale * userScale;
  const paddingY = 14 * baseScale * userScale;

  let maxLineW = 0;
  lines.forEach((line, idx) => {
    const ly = startY + idx * lineHeight;
    const metrics = ctx.measureText(line);
    maxLineW = Math.max(maxLineW, metrics.width);

    if (overlay.style === "capcut-pop") {
      const boxW = metrics.width + paddingX * 1.4;
      const boxH = lineHeight + paddingY * 0.4;
      ctx.fillStyle = overlay.bgColor || "#fde047";
      ctx.beginPath();
      ctx.roundRect(-boxW / 2, ly - boxH / 2, boxW, boxH, 16 * baseScale);
      ctx.fill();
      ctx.fillStyle = overlay.color || "#0f172a";
      ctx.fillText(line, 0, ly);
    } else if (overlay.style === "neon-badge") {
      const boxW = metrics.width + paddingX * 1.4;
      const boxH = lineHeight + paddingY * 0.4;
      ctx.fillStyle = overlay.bgColor || "rgba(15, 23, 42, 0.88)";
      ctx.strokeStyle = overlay.color || "#22d3ee";
      ctx.lineWidth = Math.max(2, 4 * baseScale);
      ctx.beginPath();
      ctx.roundRect(-boxW / 2, ly - boxH / 2, boxW, boxH, 18 * baseScale);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = overlay.color || "#22d3ee";
      ctx.fillText(line, 0, ly);
    } else if (overlay.style === "bold-hook") {
      ctx.lineWidth = Math.max(4, 10 * baseScale * userScale);
      ctx.strokeStyle = overlay.bgColor || "#090b10";
      ctx.strokeText(line, 0, ly);
      ctx.fillStyle = overlay.color || "#ffffff";
      ctx.fillText(line, 0, ly);
    } else {
      const boxW = metrics.width + paddingX;
      const boxH = lineHeight + paddingY * 0.2;
      ctx.fillStyle = overlay.bgColor || "rgba(9, 11, 16, 0.56)";
      ctx.beginPath();
      ctx.roundRect(-boxW / 2, ly - boxH / 2, boxW, boxH, 12 * baseScale);
      ctx.fill();
      ctx.fillStyle = overlay.color || "#f8fafc";
      ctx.fillText(line, 0, ly);
    }
  });

  if (isSelected) {
    const bw = maxLineW + paddingX * 1.8;
    const bh = blockH + paddingY * 1.2;
    ctx.strokeStyle = "#22d3ee";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(-bw / 2, -bh / 2, bw, bh);
  }

  ctx.restore();
}

export class PreviewCompositor {
  private videoPair: [HTMLVideoElement, HTMLVideoElement];
  private slotAssetBound: [string | null, string | null] = [null, null];
  private images = new Map<string, HTMLImageElement>();
  private stickerImages = new Map<string, HTMLImageElement>();
  private audioElements = new Map<string, HTMLAudioElement>();
  private onFrameReady?: () => void;

  constructor() {
    this.videoPair = [this.createVideoEl(), this.createVideoEl()];
  }

  setOnFrameReady(cb?: () => void): void {
    this.onFrameReady = cb;
  }

  private createVideoEl(): HTMLVideoElement {
    const v = document.createElement("video");
    v.playsInline = true;
    v.muted = true;
    v.preload = "auto";
    v.crossOrigin = "anonymous";
    const notify = () => this.onFrameReady?.();
    v.addEventListener("loadeddata", notify);
    v.addEventListener("seeked", notify);
    return v;
  }

  private getImage(asset: MediaAsset): HTMLImageElement {
    const existing = this.images.get(asset.id);
    if (existing) return existing;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => this.onFrameReady?.();
    img.src = asset.url;
    this.images.set(asset.id, img);
    return img;
  }

  private getStickerImage(stickerId: string): HTMLImageElement {
    const existing = this.stickerImages.get(stickerId);
    if (existing) return existing;
    const item = getStickerById(stickerId);
    const img = new Image();
    img.onload = () => this.onFrameReady?.();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(item.svg)}`;
    this.stickerImages.set(stickerId, img);
    return img;
  }

  private ensureVideoBound(
    channelIdx: 0 | 1,
    asset: MediaAsset,
    sourceTime: number,
    speed: number,
    reversed: boolean,
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

    video.playbackRate = reversed ? 1 : speed;
    video.muted = reversed || !unmuted;
    video.volume = Math.min(1, Math.max(0, volume));

    if (video.readyState >= 1) {
      const drift = Math.abs(video.currentTime - sourceTime);
      const threshold = reversed ? 0.055 : isPlaying ? 0.25 : 0.06;
      if (drift > threshold && !(reversed && isPlaying && video.seeking)) {
        try {
          video.currentTime = Math.max(0, sourceTime);
        } catch {
          // ignore
        }
      }
    }

    if (isPlaying && !reversed) {
      if (video.paused && video.readyState >= 2) {
        void video.play().catch(() => undefined);
      }
    } else if (!video.paused) {
      video.pause();
    }

    return video;
  }

  syncAudio(
    project: CutProject | null,
    assetsById: Map<string, MediaAsset>,
    timelineSec: number,
    isPlaying: boolean
  ): void {
    const tracks = project ? getProjectAudioTracks(project) : [];
    const activeIds = new Set(tracks.map((t) => t.id));

    for (const [id, el] of this.audioElements.entries()) {
      if (!activeIds.has(id)) {
        el.pause();
        el.removeAttribute("src");
        this.audioElements.delete(id);
      }
    }

    for (const track of tracks) {
      const asset = assetsById.get(track.assetId);
      if (!asset) continue;

      let el = this.audioElements.get(track.id);
      if (!el) {
        el = document.createElement("audio");
        el.crossOrigin = "anonymous";
        el.preload = "auto";
        el.dataset.assetUrl = asset.url;
        el.src = asset.url;
        this.audioElements.set(track.id, el);
      } else if (el.dataset.assetUrl !== asset.url) {
        el.dataset.assetUrl = asset.url;
        el.src = asset.url;
        el.load();
      }

      el.loop = track.kind === "bgm";
      const startSec = track.timelineStartSec ?? 0;
      const dur = track.durationSec ?? asset.durationSec;
      const endSec = startSec + dur;
      const inRange = timelineSec >= startSec && timelineSec <= endSec;

      if (!inRange || !isPlaying) {
        if (!el.paused) el.pause();
        continue;
      }

      const localT = timelineSec - startSec;
      let env = 1;
      if (track.fadeInSec > 0.02 && localT < track.fadeInSec) {
        env = Math.min(env, localT / track.fadeInSec);
      }
      if (track.fadeOutSec > 0.02 && dur - localT < track.fadeOutSec) {
        env = Math.min(env, Math.max(0, (dur - localT) / track.fadeOutSec));
      }

      el.volume = Math.min(1, Math.max(0, track.volume * env));
      const targetAudioTime =
        track.kind === "bgm"
          ? ((track.startOffsetSec || 0) + localT) % Math.max(0.5, asset.durationSec)
          : Math.min(asset.durationSec, (track.startOffsetSec || 0) + localT);

      if (track.kind !== "bgm" && targetAudioTime >= asset.durationSec - 0.04) {
        if (!el.paused) el.pause();
        continue;
      }

      if (el.readyState >= 1) {
        const drift = Math.abs(el.currentTime - targetAudioTime);
        if (drift > 0.28) {
          try {
            el.currentTime = targetAudioTime;
          } catch {
            // ignore
          }
        }
      }

      if (el.paused) {
        void el.play().catch(() => undefined);
      }
    }
  }

  pauseAll(): void {
    for (const v of this.videoPair) {
      if (!v.paused) v.pause();
    }
    for (const el of this.audioElements.values()) {
      if (!el.paused) el.pause();
    }
  }

  renderFrame(
    canvas: HTMLCanvasElement,
    project: CutProject,
    assetsById: Map<string, MediaAsset>,
    timelineSec: number,
    isPlaying: boolean,
    selectedIds?: { overlayId?: string | null; stickerId?: string | null }
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

    const drawSlot = (sl: ComputedSlotLayout, channel: 0 | 1, extraScale = 1) => {
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
            sl.slot.adjust,
            sl.slot.transform,
            extraScale
          );
        }
      } else {
        const sourceTime = sl.slot.reversed
          ? Math.max(
              sl.slot.sourceStartSec,
              sl.slot.sourceEndSec - elapsed * sl.slot.speed
            )
          : Math.min(
              sl.slot.sourceEndSec,
              sl.slot.sourceStartSec + elapsed * sl.slot.speed
            );
        const video = this.ensureVideoBound(
          channel,
          asset,
          sourceTime,
          sl.slot.speed,
          Boolean(sl.slot.reversed),
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
            sl.slot.adjust,
            sl.slot.transform,
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
        drawSlot(
          trProgress < 0.5 ? prevLayout : currentLayout,
          trProgress < 0.5 ? prevChannel : currChannel
        );
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

    // Stickers layer
    for (const st of project.stickers || []) {
      if (t >= st.startSec && t <= st.endSec) {
        const img = this.getStickerImage(st.stickerId);
        if (img.complete && img.naturalWidth > 0) {
          const w = targetW * 0.22 * st.scale;
          const h = (img.naturalHeight / img.naturalWidth) * w;
          const cx = st.xNorm * targetW;
          const cy = st.yNorm * targetH;
          ctx.save();
          ctx.translate(cx, cy);
          if (Math.abs(st.rotationDeg) > 0.2) {
            ctx.rotate((st.rotationDeg * Math.PI) / 180);
          }
          ctx.drawImage(img, -w / 2, -h / 2, w, h);
          if (selectedIds?.stickerId === st.id) {
            ctx.strokeStyle = "#22d3ee";
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 4]);
            ctx.strokeRect(-w / 2 - 4, -h / 2 - 4, w + 8, h + 8);
          }
          ctx.restore();
        }
      }
    }

    // Text overlays layer
    for (const overlay of project.overlays) {
      if (t >= overlay.startSec && t <= overlay.endSec) {
        drawTextOverlay(
          ctx,
          overlay,
          targetW,
          targetH,
          t,
          selectedIds?.overlayId === overlay.id
        );
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
    for (const el of this.audioElements.values()) {
      el.removeAttribute("src");
      el.load();
    }
    this.audioElements.clear();
  }
}

export function hitTestCanvasOverlay(
  project: CutProject,
  timelineSec: number,
  normX: number,
  normY: number
): { kind: "overlay" | "sticker"; id: string } | null {
  const activeStickers = (project.stickers || []).filter(
    (s) => timelineSec >= s.startSec && timelineSec <= s.endSec
  );
  for (let i = activeStickers.length - 1; i >= 0; i--) {
    const s = activeStickers[i];
    const radius = 0.14 * s.scale;
    if (Math.abs(normX - s.xNorm) <= radius && Math.abs(normY - s.yNorm) <= radius) {
      return { kind: "sticker", id: s.id };
    }
  }

  const activeTexts = project.overlays.filter(
    (o) => timelineSec >= o.startSec && timelineSec <= o.endSec
  );
  for (let i = activeTexts.length - 1; i >= 0; i--) {
    const o = activeTexts[i];
    const pos = getOverlayNormalizedPos(o);
    if (
      Math.abs(normX - pos.xNorm) <= 0.35 * (o.scale ?? 1) &&
      Math.abs(normY - pos.yNorm) <= 0.1 * (o.scale ?? 1)
    ) {
      return { kind: "overlay", id: o.id };
    }
  }

  return null;
}

export type { StickerOverlay };
