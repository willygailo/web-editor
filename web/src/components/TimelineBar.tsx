import { ArrowLeft, ArrowRight, Music2, Type } from "lucide-react";
import {
  computeTimelineLayout,
  type CutProject,
  type MediaAsset,
} from "@cutflow/shared";

interface TimelineBarProps {
  project: CutProject | null;
  assetsById: Map<string, MediaAsset>;
  currentTime: number;
  selectedSlotId: string | null;
  onSelectSlot: (slotId: string) => void;
  onSeek: (sec: number) => void;
  onMoveSlot: (slotId: string, dir: -1 | 1) => void;
}

export function TimelineBar({
  project,
  assetsById,
  currentTime,
  selectedSlotId,
  onSelectSlot,
  onSeek,
  onMoveSlot,
}: TimelineBarProps) {
  if (!project) {
    return (
      <div className="flex h-full items-center justify-center rounded-2xl border border-slate-800/80 bg-[#0d111a] p-4 text-xs text-slate-500">
        Generate an AI edit or pick a template to see your cut timeline & beat markers.
      </div>
    );
  }

  const layout = computeTimelineLayout(project);
  const totalSec = Math.max(0.5, layout.totalDurationSec);
  const pxPerSec = 52;
  const trackWidth = Math.max(320, Math.round(totalSec * pxPerSec));
  const playheadLeft = Math.min(trackWidth, Math.max(0, currentTime * pxPerSec));

  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-slate-800/90 bg-[#0d111a] p-2.5">
      <div className="flex items-center justify-between gap-2 text-[11px] text-slate-400">
        <span className="font-semibold text-slate-200">
          Timeline · {layout.slots.length} cuts · {totalSec.toFixed(1)}s
        </span>
        {selectedSlotId && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onMoveSlot(selectedSlotId, -1)}
              aria-label="Move selected clip earlier"
              className="inline-flex items-center justify-center rounded-lg border border-slate-700 bg-[#111520] px-2 py-1 text-slate-200 hover:border-cyan-400"
            >
              <ArrowLeft className="size-3.5" aria-hidden="true" />
            </button>
            <button
              type="button"
              onClick={() => onMoveSlot(selectedSlotId, 1)}
              aria-label="Move selected clip later"
              className="inline-flex items-center justify-center rounded-lg border border-slate-700 bg-[#111520] px-2 py-1 text-slate-200 hover:border-cyan-400"
            >
              <ArrowRight className="size-3.5" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      <div
        role="region"
        aria-label="Interactive video timeline"
        tabIndex={0}
        className="relative overflow-x-auto rounded-xl bg-[#090b10] pb-2"
      >
        <div
          className="relative select-none"
          style={{ width: `${trackWidth}px` }}
        >
          {/* Clickable Scrub Ruler + Beat Ticks */}
          <div
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
              onSeek(Number(((x / trackWidth) * totalSec).toFixed(2)));
            }}
            className="relative h-6 cursor-pointer border-b border-slate-800 bg-[#111520]"
          >
            {Array.from({ length: Math.ceil(totalSec) + 1 }).map((_, sec) => (
              <span
                key={sec}
                className="absolute top-1 text-[9px] font-mono text-slate-500"
                style={{ left: `${sec * pxPerSec + 3}px` }}
              >
                {sec}s
              </span>
            ))}
            {project.audioTrack?.beatMarkersSec
              .filter((b) => b <= totalSec)
              .map((beat, idx) => (
                <span
                  key={`${beat}-${idx}`}
                  title={`Beat @ ${beat.toFixed(2)}s`}
                  className="absolute bottom-0 h-2 w-0.5 bg-rose-400/80"
                  style={{ left: `${beat * pxPerSec}px` }}
                />
              ))}
          </div>

          {/* Visual Slots Track */}
          <div className="relative mt-1.5 h-14">
            {layout.slots.map((sl) => {
              const asset = assetsById.get(sl.slot.assetId);
              const left = sl.timelineStartSec * pxPerSec;
              const width = Math.max(28, (sl.timelineEndSec - sl.timelineStartSec) * pxPerSec);
              const isSelected = sl.slot.id === selectedSlotId;

              return (
                <button
                  key={sl.slot.id}
                  type="button"
                  onClick={() => {
                    onSelectSlot(sl.slot.id);
                    onSeek(sl.timelineStartSec + 0.05);
                  }}
                  style={{ left: `${left}px`, width: `${width}px` }}
                  className={`absolute top-0 flex h-14 flex-col justify-between overflow-hidden rounded-lg border px-1.5 py-1 text-left transition ${
                    isSelected
                      ? "z-10 border-cyan-300 bg-cyan-500/25 ring-2 ring-cyan-400/50"
                      : "border-slate-700 bg-[#181e2d] hover:border-slate-500"
                  }`}
                >
                  <span className="truncate text-[10px] font-bold text-slate-100">
                    {asset?.originalName ?? `Clip ${sl.index + 1}`}
                  </span>
                  <div className="flex items-center justify-between gap-1 text-[9px] text-slate-300">
                    <span className="truncate">{sl.slot.motion}</span>
                    <span className="shrink-0 font-mono">{sl.rawDurationSec.toFixed(1)}s</span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Overlays Track */}
          {project.overlays.length > 0 && (
            <div className="relative mt-1.5 h-7">
              {project.overlays.map((ov) => {
                const left = ov.startSec * pxPerSec;
                const width = Math.max(40, (ov.endSec - ov.startSec) * pxPerSec);
                return (
                  <div
                    key={ov.id}
                    style={{ left: `${left}px`, width: `${width}px` }}
                    className="absolute top-0 flex h-6 items-center gap-1 overflow-hidden rounded-md border border-amber-400/50 bg-amber-500/15 px-1.5 text-[10px] font-semibold text-amber-200"
                  >
                    <Type className="size-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{ov.text}</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* Audio Track Strip */}
          {project.audioTrack && (
            <div className="mt-1.5 flex h-6 items-center gap-1.5 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 text-[10px] font-medium text-rose-200">
              <Music2 className="size-3 shrink-0" aria-hidden="true" />
              <span className="truncate">{project.audioTrack.title || "Background Beat"}</span>
            </div>
          )}

          {/* Playhead */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-20 w-0.5 bg-cyan-300 shadow-[0_0_8px_#22d3ee]"
            style={{ left: `${playheadLeft}px` }}
          >
            <div className="-ml-1.5 h-2.5 w-3.5 rounded-b bg-cyan-300" />
          </div>
        </div>
      </div>
    </div>
  );
}
