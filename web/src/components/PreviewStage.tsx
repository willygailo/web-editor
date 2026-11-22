import { useEffect, useRef, useState } from "react";
import { Frame, Pause, Play, RotateCcw, Sparkles, Upload } from "lucide-react";
import {
  computeTimelineLayout,
  getOverlayNormalizedPos,
  type CutProject,
  type MediaAsset,
} from "@cutflow/shared";
import { hitTestCanvasOverlay, PreviewCompositor } from "../engine/previewPlayer";
import type { EditorSelection } from "../state/useEditorStore";

interface PreviewStageProps {
  project: CutProject | null;
  assetsById: Map<string, MediaAsset>;
  currentTime: number;
  isPlaying: boolean;
  selection: EditorSelection;
  onTimeChange: (t: number) => void;
  onPlayingChange: (playing: boolean) => void;
  onSelectOverlay: (id: string | null) => void;
  onSelectSticker: (id: string | null) => void;
  onBeginDrag: () => void;
  onEndDrag: () => void;
  onMoveOverlayPos: (id: string, xNorm: number, yNorm: number) => void;
  onMoveStickerPos: (id: string, xNorm: number, yNorm: number) => void;
  onLoadDemo: () => void;
  onQuickUpload: () => void;
  isLoadingDemo: boolean;
}

function formatTime(sec: number): string {
  const s = Math.max(0, sec);
  const mins = Math.floor(s / 60);
  const rem = s % 60;
  return `${mins}:${rem.toFixed(1).padStart(4, "0")}`;
}

export function PreviewStage({
  project,
  assetsById,
  currentTime,
  isPlaying,
  selection,
  onTimeChange,
  onPlayingChange,
  onSelectOverlay,
  onSelectSticker,
  onBeginDrag,
  onEndDrag,
  onMoveOverlayPos,
  onMoveStickerPos,
  onLoadDemo,
  onQuickUpload,
  isLoadingDemo,
}: PreviewStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<PreviewCompositor | null>(null);
  const timeRef = useRef(currentTime);
  timeRef.current = currentTime;
  const projectRef = useRef(project);
  projectRef.current = project;
  const assetsRef = useRef(assetsById);
  assetsRef.current = assetsById;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const [liveStatus, setLiveStatus] = useState("");
  const [showSafeZones, setShowSafeZones] = useState(false);
  const showSafeZonesRef = useRef(false);
  showSafeZonesRef.current = showSafeZones;
  const activeSnapRef = useRef<{ snapX: boolean; snapY: boolean }>({
    snapX: false,
    snapY: false,
  });
  const dragStateRef = useRef<{
    kind: "overlay" | "sticker";
    id: string;
    startX: number;
    startY: number;
    origXNorm: number;
    origYNorm: number;
    moved: boolean;
  } | null>(null);

  useEffect(() => {
    const comp = new PreviewCompositor();
    compositorRef.current = comp;
    comp.setOnFrameReady(() => {
      if (isPlayingRef.current) return;
      const canvas = canvasRef.current;
      const proj = projectRef.current;
      if (!canvas || !proj) return;
      comp.renderFrame(canvas, proj, assetsRef.current, timeRef.current, false, {
        overlayId: selectionRef.current.overlayId,
        stickerId: selectionRef.current.stickerId,
        snapX: activeSnapRef.current.snapX,
        snapY: activeSnapRef.current.snapY,
        showSafeZones: showSafeZonesRef.current,
      });
    });
    return () => {
      comp.destroy();
      compositorRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (isPlaying) return;
    const canvas = canvasRef.current;
    const comp = compositorRef.current;
    if (!canvas || !comp || !project) {
      comp?.pauseAll();
      return;
    }
    comp.pauseAll();
    comp.syncAudio(project, assetsById, currentTime, false);
    comp.renderFrame(canvas, project, assetsById, currentTime, false, {
      overlayId: selection.overlayId,
      stickerId: selection.stickerId,
      snapX: activeSnapRef.current.snapX,
      snapY: activeSnapRef.current.snapY,
      showSafeZones,
    });
  }, [project, assetsById, currentTime, isPlaying, selection.overlayId, selection.stickerId, showSafeZones]);

  const hasProject = Boolean(project);
  useEffect(() => {
    if (!isPlaying || !hasProject) return;
    const canvas = canvasRef.current;
    const comp = compositorRef.current;
    if (!canvas || !comp) return;

    let rafId = 0;
    let lastPerf = performance.now();

    const tick = (now: number) => {
      const proj = projectRef.current;
      if (!proj) return;
      const total = Math.max(0.5, computeTimelineLayout(proj).totalDurationSec);
      const dt = Math.min(0.1, (now - lastPerf) / 1000);
      lastPerf = now;

      let nextTime = timeRef.current + dt;
      if (nextTime >= total) nextTime = 0;
      timeRef.current = nextTime;
      onTimeChange(nextTime);

      comp.syncAudio(proj, assetsRef.current, nextTime, true);
      comp.renderFrame(canvas, proj, assetsRef.current, nextTime, true, {
        overlayId: selectionRef.current.overlayId,
        stickerId: selectionRef.current.stickerId,
        snapX: activeSnapRef.current.snapX,
        snapY: activeSnapRef.current.snapY,
        showSafeZones: showSafeZonesRef.current,
      });
      rafId = requestAnimationFrame(tick);
    };

    if (projectRef.current) {
      comp.syncAudio(projectRef.current, assetsRef.current, timeRef.current, true);
      comp.renderFrame(canvas, projectRef.current, assetsRef.current, timeRef.current, true, {
        overlayId: selectionRef.current.overlayId,
        stickerId: selectionRef.current.stickerId,
        snapX: activeSnapRef.current.snapX,
        snapY: activeSnapRef.current.snapY,
        showSafeZones: showSafeZonesRef.current,
      });
    }
    rafId = requestAnimationFrame(tick);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      comp.pauseAll();
    };
  }, [isPlaying, hasProject, onTimeChange]);

  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !project || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    const normX = (e.clientX - rect.left) / Math.max(1, rect.width);
    const normY = (e.clientY - rect.top) / Math.max(1, rect.height);

    const hit = hitTestCanvasOverlay(project, currentTime, normX, normY);
    if (!hit) {
      dragStateRef.current = null;
      return;
    }

    canvasRef.current.setPointerCapture(e.pointerId);
    onBeginDrag();

    if (hit.kind === "sticker") {
      onSelectSticker(hit.id);
      const st = (project.stickers || []).find((s) => s.id === hit.id);
      if (st) {
        dragStateRef.current = {
          kind: "sticker",
          id: hit.id,
          startX: e.clientX,
          startY: e.clientY,
          origXNorm: st.xNorm,
          origYNorm: st.yNorm,
          moved: false,
        };
      }
    } else {
      onSelectOverlay(hit.id);
      const ov = project.overlays.find((o) => o.id === hit.id);
      if (ov) {
        const pos = getOverlayNormalizedPos(ov);
        dragStateRef.current = {
          kind: "overlay",
          id: hit.id,
          startX: e.clientX,
          startY: e.clientY,
          origXNorm: pos.xNorm,
          origYNorm: pos.yNorm,
          moved: false,
        };
      }
    }
  };

  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragStateRef.current;
    const canvas = canvasRef.current;
    if (!drag || !canvas || !canvas.hasPointerCapture(e.pointerId)) return;

    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;

    const rect = canvas.getBoundingClientRect();
    const rawX = Math.max(0.08, Math.min(0.92, drag.origXNorm + dx / Math.max(1, rect.width)));
    const rawY = Math.max(0.08, Math.min(0.92, drag.origYNorm + dy / Math.max(1, rect.height)));
    const SNAP_THRESHOLD = 0.025;
    const snapX = Math.abs(rawX - 0.5) <= SNAP_THRESHOLD;
    const snapY = Math.abs(rawY - 0.5) <= SNAP_THRESHOLD;
    activeSnapRef.current = { snapX, snapY };
    const nextX = snapX ? 0.5 : rawX;
    const nextY = snapY ? 0.5 : rawY;

    if (drag.kind === "overlay") {
      onMoveOverlayPos(drag.id, Number(nextX.toFixed(3)), Number(nextY.toFixed(3)));
    } else {
      onMoveStickerPos(drag.id, Number(nextX.toFixed(3)), Number(nextY.toFixed(3)));
    }
  };

  const handleCanvasPointerUp = () => {
    const drag = dragStateRef.current;
    const hadSnap = activeSnapRef.current.snapX || activeSnapRef.current.snapY;
    activeSnapRef.current = { snapX: false, snapY: false };
    onEndDrag();
    if (drag?.moved) {
      setLiveStatus(`${drag.kind === "overlay" ? "Text" : "Sticker"} repositioned on canvas`);
      window.setTimeout(() => setLiveStatus(""), 900);
      if (hadSnap && canvasRef.current && projectRef.current && compositorRef.current && !isPlayingRef.current) {
        compositorRef.current.renderFrame(
          canvasRef.current,
          projectRef.current,
          assetsRef.current,
          timeRef.current,
          false,
          {
            overlayId: selectionRef.current.overlayId,
            stickerId: selectionRef.current.stickerId,
            snapX: false,
            snapY: false,
            showSafeZones: showSafeZonesRef.current,
          }
        );
      }
    } else if (!drag) {
      onPlayingChange(!isPlaying);
    }
    dragStateRef.current = null;
  };

  const totalSec = project ? computeTimelineLayout(project).totalDurationSec : 0;
  const aspectCss =
    project?.aspectRatio === "16:9"
      ? "aspect-video"
      : project?.aspectRatio === "1:1"
        ? "aspect-square"
        : project?.aspectRatio === "4:5"
          ? "aspect-[4/5]"
          : "aspect-[9/16]";

  return (
    <div className="flex flex-col items-center justify-center gap-1.5">
      <div className="sr-only" aria-live="polite">
        {liveStatus}
      </div>

      <div className="relative flex w-full items-center justify-center rounded-2xl border border-slate-800/90 bg-[#05070b] p-2">
        {project ? (
          <div
            className={`relative max-h-[34dvh] w-auto overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-slate-700/60 lg:max-h-[48dvh] ${aspectCss}`}
          >
            <canvas
              ref={canvasRef}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
              onPointerCancel={() => {
                activeSnapRef.current = { snapX: false, snapY: false };
                dragStateRef.current = null;
              }}
              className="canvas-draggable h-full w-full cursor-pointer object-contain"
            />
            <span className="pointer-events-none absolute top-2 left-2 rounded-full bg-slate-950/75 px-2 py-0.5 text-[10px] font-bold text-cyan-300 backdrop-blur">
              {project.aspectRatio} ·{" "}
              {project.modeUsed === "claude"
                ? "Claude Sonnet 5.5"
                : project.modeUsed === "gemini"
                  ? "Gemini AI"
                  : project.modeUsed === "template"
                    ? "Template"
                    : "Smart Auto"}
            </span>
          </div>
        ) : (
          <div className="flex min-h-[190px] w-full max-w-md flex-col items-center justify-center gap-3 p-4 text-center lg:min-h-[300px]">
            <div className="rounded-2xl bg-gradient-to-br from-cyan-500/20 to-rose-500/20 p-3 ring-1 ring-cyan-400/30">
              <Sparkles className="size-6 text-cyan-300" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <h2 className="text-sm font-bold text-slate-100 sm:text-base">
                Drop clips, pick a template or prompt, edit like CapCut.
              </h2>
              <p className="text-xs text-slate-400">
                Split, trim, add music &amp; voiceover, adjust colors, drag text &amp; stickers, export MP4.
              </p>
            </div>
            <div className="studio-toolbar justify-center gap-2">
              <button
                type="button"
                onClick={onQuickUpload}
                className="inline-flex items-center gap-1.5 rounded-xl bg-cyan-400 px-3.5 py-2 text-xs font-bold text-slate-950 transition hover:brightness-110"
              >
                <Upload className="size-4" aria-hidden="true" />
                Upload Media
              </button>
              <button
                type="button"
                disabled={isLoadingDemo}
                onClick={onLoadDemo}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-[#111520] px-3.5 py-2 text-xs font-semibold text-slate-200 transition hover:border-rose-400"
              >
                <Sparkles className="size-4 text-rose-400" aria-hidden="true" />
                {isLoadingDemo ? "Creating Demo..." : "Try Demo Clips"}
              </button>
            </div>
          </div>
        )}
      </div>

      {project && (
        <div className="flex w-full items-center justify-between gap-2 rounded-xl bg-[#111520] px-3 py-1 text-xs">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onPlayingChange(!isPlaying)}
              aria-label={isPlaying ? "Pause preview" : "Play preview"}
              className="inline-flex items-center justify-center rounded-lg bg-cyan-400 px-2.5 py-1 font-bold text-slate-950"
            >
              {isPlaying ? (
                <Pause className="size-3.5" aria-hidden="true" />
              ) : (
                <Play className="size-3.5" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                onPlayingChange(false);
                onTimeChange(0);
              }}
              aria-label="Restart preview"
              className="inline-flex items-center justify-center rounded-lg border border-slate-700 p-1 text-slate-300 hover:text-white"
            >
              <RotateCcw className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-pressed={showSafeZones}
              onClick={() => setShowSafeZones((v) => !v)}
              title="Toggle TikTok / Reels UI safe-zone guides"
              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-[10px] font-semibold transition ${
                showSafeZones
                  ? "border-amber-400/70 bg-amber-400/15 text-amber-200"
                  : "border-slate-700 text-slate-300 hover:text-white"
              }`}
            >
              <Frame className="size-3" aria-hidden="true" />
              <span className="hidden sm:inline">Safe Zone</span>
            </button>
            <span className="ml-1 font-mono text-[11px] text-slate-200">
              {formatTime(currentTime)} / {formatTime(totalSec)}
            </span>
          </div>

          {project.aiSummary && (
            <span className="hidden truncate text-[11px] text-slate-400 sm:inline">
              {project.aiSummary}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
