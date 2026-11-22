import { useEffect, useRef } from "react";
import { Pause, Play, RotateCcw, Sparkles, Upload } from "lucide-react";
import {
  computeTimelineLayout,
  type CutProject,
  type MediaAsset,
} from "@cutflow/shared";
import { PreviewCompositor } from "../engine/previewPlayer";

interface PreviewStageProps {
  project: CutProject | null;
  assetsById: Map<string, MediaAsset>;
  currentTime: number;
  isPlaying: boolean;
  onTimeChange: (t: number) => void;
  onPlayingChange: (playing: boolean) => void;
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
  onTimeChange,
  onPlayingChange,
  onLoadDemo,
  onQuickUpload,
  isLoadingDemo,
}: PreviewStageProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const compositorRef = useRef<PreviewCompositor | null>(null);
  const timeRef = useRef(currentTime);
  timeRef.current = currentTime;

  useEffect(() => {
    const comp = new PreviewCompositor();
    compositorRef.current = comp;
    return () => {
      comp.destroy();
      compositorRef.current = null;
    };
  }, []);

  // Scrub / paused single-frame render
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
    comp.renderFrame(canvas, project, assetsById, currentTime, false);
  }, [project, assetsById, currentTime, isPlaying]);

  // Continuous playback animation loop (does not restart on every currentTime tick)
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
      if (nextTime >= total) {
        nextTime = 0;
      }
      timeRef.current = nextTime;
      onTimeChange(nextTime);

      comp.syncAudio(project, assetsById, nextTime, true);
      comp.renderFrame(canvas, project, assetsById, nextTime, true);
      rafId = requestAnimationFrame(tick);
    };

    comp.syncAudio(project, assetsById, timeRef.current, true);
    comp.renderFrame(canvas, project, assetsById, timeRef.current, true);
    rafId = requestAnimationFrame(tick);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      comp.pauseAll();
    };
  }, [project, assetsById, isPlaying, onTimeChange]);

  const totalSec = project ? computeTimelineLayout(project).totalDurationSec : 0;
  const aspectCss =
    project?.aspectRatio === "16:9"
      ? "aspect-video"
      : project?.aspectRatio === "1:1"
        ? "aspect-square"
        : "aspect-[9/16]";

  return (
    <div className="flex flex-col items-center justify-center gap-2">
      <div className="relative flex w-full items-center justify-center rounded-2xl border border-slate-800/90 bg-[#05070b] p-2 sm:p-3">
        {project ? (
          <div className={`relative max-h-[38dvh] w-auto overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-slate-700/60 lg:max-h-[54dvh] ${aspectCss}`}>
            <canvas
              ref={canvasRef}
              onClick={() => onPlayingChange(!isPlaying)}
              className="h-full w-full cursor-pointer object-contain"
            />
            <span className="pointer-events-none absolute top-2 left-2 rounded-full bg-slate-950/75 px-2 py-0.5 text-[10px] font-bold text-cyan-300 backdrop-blur">
              {project.aspectRatio} ·{" "}
              {project.modeUsed === "claude"
                ? "Claude Sonnet 5.5"
                : project.modeUsed === "gemini"
                  ? "Gemini AI"
                  : "Smart Auto"}
            </span>
          </div>
        ) : (
          <div className="flex min-h-[220px] w-full max-w-md flex-col items-center justify-center gap-3 p-4 text-center lg:min-h-[340px]">
            <div className="rounded-2xl bg-gradient-to-br from-cyan-500/20 to-rose-500/20 p-3 ring-1 ring-cyan-400/30">
              <Sparkles className="size-7 text-cyan-300" aria-hidden="true" />
            </div>
            <div className="space-y-1">
              <h2 className="text-base font-bold text-slate-100">
                Drop your clips, type a vibe, let AI cut it.
              </h2>
              <p className="text-xs text-slate-400">
                Works on both phone & laptop — instant preview + FFmpeg MP4 export.
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
        <div className="flex w-full items-center justify-between gap-2 rounded-xl bg-[#111520] px-3 py-1.5 text-xs">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onPlayingChange(!isPlaying)}
              aria-label={isPlaying ? "Pause preview" : "Play preview"}
              className="inline-flex items-center justify-center rounded-lg bg-cyan-400 px-2.5 py-1.5 font-bold text-slate-950"
            >
              {isPlaying ? (
                <Pause className="size-4" aria-hidden="true" />
              ) : (
                <Play className="size-4" aria-hidden="true" />
              )}
            </button>
            <button
              type="button"
              onClick={() => {
                onPlayingChange(false);
                onTimeChange(0);
              }}
              aria-label="Restart preview"
              className="inline-flex items-center justify-center rounded-lg border border-slate-700 p-1.5 text-slate-300 hover:text-white"
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
