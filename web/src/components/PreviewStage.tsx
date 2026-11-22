import { useEffect, useRef, useState } from "react";
import { Pause, Play, RotateCcw, Sparkles, Upload } from "lucide-react";
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

  const [liveStatus, setLiveStatus] = useState("");
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
    });
  }, [project, assetsById, currentTime, isPlaying, selection.overlayId, selection.stickerId]);

  useEffect(() => {
    if (!isPlaying) return;
    const canvas = canvasRef.current;
    const comp = compositorRef.current;
    if (!canvas || !comp || !project) return;

    const total = Math.max(0.5, computeTimelineLayout(project).totalDurationSec);
    let rafId = 0;
    let lastPerf = performance.now();

    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastPerf) / 1000);
      lastPerf = now;

      let nextTime = timeRef.current + dt;
      if (nextTime >= total) nextTime = 0;
      timeRef.current = nextTime;
      onTimeChange(nextTime);

      comp.syncAudio(project, assetsById, nextTime, true);
      comp.renderFrame(canvas, project, assetsById, nextTime, true, {
        overlayId: selection.overlayId,
        stickerId: selection.stickerId,
      });
      rafId = requestAnimationFrame(tick);
    };

    comp.syncAudio(project, assetsById, timeRef.current, true);
    comp.renderFrame(canvas, project, assetsById, timeRef.current, true, {
      overlayId: selection.overlayId,
      stickerId: selection.stickerId,
    });
    rafId = requestAnimationFrame(tick);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      comp.pauseAll();
    };
  }, [project, assetsById, isPlaying, onTimeChange, selection.overlayId, selection.stickerId]);

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
    const nextX = Math.max(0.08, Math.min(0.92, drag.origXNorm + dx / Math.max(1, rect.width)));
    const nextY = Math.max(0.08, Math.min(0.92, drag.origYNorm + dy / Math.max(1, rect.height)));

    if (drag.kind === "overlay") {
      onMoveOverlayPos(drag.id, Number(nextX.toFixed(3)), Number(nextY.toFixed(3)));
    } else {
      onMoveStickerPos(drag.id, Number(nextX.toFixed(3)), Number(nextY.toFixed(3)));
    }
  };

  const handleCanvasPointerUp = () => {
    const drag = dragStateRef.current;
    if (drag?.moved) {
      setLiveStatus(`${drag.kind === "overlay" ? "Text" : "Sticker"} repositioned on canvas`);
      window.setTimeout(() => setLiveStatus(""), 900);
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
