import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Music2,
  Plus,
  Redo2,
  Scissors,
  Sparkles,
  Sticker,
  Type,
  Undo2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  computeTimelineLayout,
  getProjectAudioTracks,
  type ClipSlot,
  type CutProject,
  type MediaAsset,
  type StickerOverlay,
  type TextOverlay,
  type TransitionType,
} from "@cutflow/shared";
import { fetchWaveform } from "../api/client";
import type { EditorSelection } from "../state/useEditorStore";

interface TimelineBarProps {
  project: CutProject | null;
  assetsById: Map<string, MediaAsset>;
  currentTime: number;
  selection: EditorSelection;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  onSplitAtPlayhead: () => void;
  onDuplicateSlot: (slotId: string) => void;
  onMoveSlot: (slotId: string, dir: -1 | 1) => void;
  onUpdateSlot: (slotId: string, patch: Partial<ClipSlot>, recordHistory?: boolean) => void;
  onUpdateOverlay: (
    overlayId: string,
    patch: Partial<TextOverlay>,
    recordHistory?: boolean
  ) => void;
  onUpdateSticker: (
    stickerId: string,
    patch: Partial<StickerOverlay>,
    recordHistory?: boolean
  ) => void;
  onBeginDrag?: () => void;
  onEndDrag?: () => void;
  onSelectSlot: (slotId: string) => void;
  onSelectAudioTrack: (id: string) => void;
  onSelectOverlay: (id: string) => void;
  onSelectSticker: (id: string) => void;
  onSeek: (sec: number) => void;
  onSnapBeats: () => void;
  onOpenAddClip: () => void;
  onOpenAddMusic: () => void;
  onAddTextShortcut: () => void;
}

const TRANSITION_CYCLE: TransitionType[] = [
  "cut",
  "crossfade",
  "flash-white",
  "zoom-blur",
  "slide-left",
];

export function TimelineBar({
  project,
  assetsById,
  currentTime,
  selection,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onSplitAtPlayhead,
  onDuplicateSlot,
  onMoveSlot,
  onUpdateSlot,
  onUpdateOverlay,
  onUpdateSticker,
  onBeginDrag,
  onEndDrag,
  onSelectSlot,
  onSelectAudioTrack,
  onSelectOverlay,
  onSelectSticker,
  onSeek,
  onSnapBeats,
  onOpenAddClip,
  onOpenAddMusic,
  onAddTextShortcut,
}: TimelineBarProps) {
  const [pxPerSec, setPxPerSec] = useState(56);
  const [waveforms, setWaveforms] = useState<Map<string, number[]>>(new Map());
  const pendingRef = useRef<Set<string>>(new Set());

  const tracks = project ? getProjectAudioTracks(project) : [];

  useEffect(() => {
    for (const tr of tracks) {
      if (waveforms.has(tr.assetId) || pendingRef.current.has(tr.assetId)) continue;
      pendingRef.current.add(tr.assetId);
      void fetchWaveform(tr.assetId, 80)
        .then((res) => {
          setWaveforms((prev) => new Map(prev).set(tr.assetId, res.peaks));
        })
        .catch(() => undefined)
        .finally(() => {
          pendingRef.current.delete(tr.assetId);
        });
    }
  }, [tracks, waveforms]);

  if (!project) {
    return (
      <div className="flex h-full items-center justify-center rounded-2xl border border-slate-800/80 bg-[#0d111a] p-4 text-xs text-slate-500">
        Upload clips, tap <strong>Try Demo Clips</strong>, or pick a template to start editing on the timeline.
      </div>
    );
  }

  const layout = computeTimelineLayout(project);
  const totalSec = Math.max(0.5, layout.totalDurationSec);
  const trackWidth = Math.max(320, Math.round(totalSec * pxPerSec) + 96);
  const playheadLeft = Math.min(totalSec * pxPerSec, Math.max(0, currentTime * pxPerSec));
  const bgmBeats = tracks[0]?.beatMarkersSec ?? [];

  const startEdgeTrimDrag = (
    e: React.PointerEvent<HTMLButtonElement>,
    slot: ClipSlot,
    edge: "start" | "end",
    maxAssetDur: number
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    onBeginDrag?.();
    const startX = e.clientX;
    const origStart = slot.sourceStartSec;
    const origEnd = slot.sourceEndSec;
    const speed = slot.speed || 1;

    const onMove = (ev: PointerEvent) => {
      if (!handle.hasPointerCapture(ev.pointerId)) return;
      const deltaSec = ((ev.clientX - startX) / pxPerSec) * speed;
      if (edge === "start") {
        const nextStart = Math.max(0, Math.min(origEnd - 0.35, origStart + deltaSec));
        onUpdateSlot(slot.id, { sourceStartSec: Number(nextStart.toFixed(2)) }, false);
      } else {
        const nextEnd = Math.min(maxAssetDur, Math.max(origStart + 0.35, origEnd + deltaSec));
        onUpdateSlot(slot.id, { sourceEndSec: Number(nextEnd.toFixed(2)) }, false);
      }
    };

    const onEnd = () => {
      onEndDrag?.();
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("lostpointercapture", onEnd);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("lostpointercapture", onEnd);
  };

  const startTimedRangeTrimDrag = (
    e: React.PointerEvent<HTMLButtonElement>,
    origStart: number,
    origEnd: number,
    edge: "start" | "end",
    onPatch: (patch: { startSec?: number; endSec?: number }) => void
  ) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    onBeginDrag?.();
    const startX = e.clientX;

    const onMove = (ev: PointerEvent) => {
      if (!handle.hasPointerCapture(ev.pointerId)) return;
      const deltaSec = (ev.clientX - startX) / pxPerSec;
      if (edge === "start") {
        const nextStart = Math.max(0, Math.min(origEnd - 0.35, origStart + deltaSec));
        onPatch({ startSec: Number(nextStart.toFixed(2)) });
      } else {
        const nextEnd = Math.min(totalSec, Math.max(origStart + 0.35, origEnd + deltaSec));
        onPatch({ endSec: Number(nextEnd.toFixed(2)) });
      }
    };

    const onEnd = () => {
      onEndDrag?.();
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("lostpointercapture", onEnd);
    };

    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("lostpointercapture", onEnd);
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-2xl border border-slate-800/90 bg-[#0d111a] p-2">
      {/* CapCut Timeline Action Toolbar */}
      <div className="studio-toolbar items-center justify-between gap-1.5 text-[11px]">
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            disabled={!canUndo}
            onClick={onUndo}
            aria-label="Undo edit"
            title="Undo (Ctrl+Z)"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-700/80 bg-[#111520] px-2 py-1 text-slate-200 hover:border-cyan-400 disabled:opacity-35"
          >
            <Undo2 className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            disabled={!canRedo}
            onClick={onRedo}
            aria-label="Redo edit"
            title="Redo (Ctrl+Shift+Z)"
            className="inline-flex items-center gap-1 rounded-lg border border-slate-700/80 bg-[#111520] px-2 py-1 text-slate-200 hover:border-cyan-400 disabled:opacity-35"
          >
            <Redo2 className="size-3.5" aria-hidden="true" />
          </button>

          <button
            type="button"
            onClick={onSplitAtPlayhead}
            title="Split clip at playhead (S)"
            className="inline-flex items-center gap-1 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-2.5 py-1 font-bold text-cyan-200 hover:bg-cyan-500/25"
          >
            <Scissors className="size-3.5" aria-hidden="true" />
            <span>Split</span>
          </button>

          {selection.slotId && (
            <>
              <button
                type="button"
                onClick={() => onDuplicateSlot(selection.slotId!)}
                aria-label="Duplicate selected clip"
                title="Duplicate clip"
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-[#111520] px-2 py-1 text-slate-200 hover:border-cyan-400"
              >
                <Copy className="size-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onMoveSlot(selection.slotId!, -1)}
                aria-label="Move clip earlier"
                className="inline-flex items-center rounded-lg border border-slate-700 bg-[#111520] px-1.5 py-1 text-slate-200 hover:border-cyan-400"
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => onMoveSlot(selection.slotId!, 1)}
                aria-label="Move clip later"
                className="inline-flex items-center rounded-lg border border-slate-700 bg-[#111520] px-1.5 py-1 text-slate-200 hover:border-cyan-400"
              >
                <ArrowRight className="size-3.5" aria-hidden="true" />
              </button>
            </>
          )}

          {bgmBeats.length >= 2 && (
            <button
              type="button"
              onClick={onSnapBeats}
              className="inline-flex items-center gap-1 rounded-lg border border-amber-400/40 bg-amber-500/15 px-2 py-1 font-semibold text-amber-200 hover:bg-amber-500/25"
            >
              <Sparkles className="size-3" aria-hidden="true" />
              <span className="hidden sm:inline">Snap Beats</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1 text-slate-400">
          <span className="hidden font-mono text-[11px] text-slate-300 sm:inline">
            {layout.slots.length} cuts · {totalSec.toFixed(1)}s
          </span>
          <button
            type="button"
            onClick={() => setPxPerSec((z) => Math.max(28, z - 12))}
            aria-label="Zoom out timeline"
            className="rounded-lg border border-slate-800 bg-[#111520] p-1 text-slate-300 hover:text-white"
          >
            <ZoomOut className="size-3.5" aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setPxPerSec((z) => Math.min(128, z + 12))}
            aria-label="Zoom in timeline"
            className="rounded-lg border border-slate-800 bg-[#111520] p-1 text-slate-300 hover:text-white"
          >
            <ZoomIn className="size-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Scrollable Multi-Track Canvas */}
      <div
        role="region"
        aria-label="CapCut multi-track timeline"
        tabIndex={0}
        className="relative overflow-x-auto rounded-xl bg-[#090b10] pb-2"
      >
        <div className="relative select-none" style={{ width: `${trackWidth}px` }}>
          {/* Ruler + Beat Diamonds */}
          <div
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              const x = Math.max(0, Math.min(totalSec * pxPerSec, e.clientX - rect.left));
              onSeek(Number((x / pxPerSec).toFixed(2)));
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
            {bgmBeats
              .filter((b) => b <= totalSec)
              .map((beat, idx) => (
                <span
                  key={`${beat}-${idx}`}
                  title={`Beat @ ${beat.toFixed(2)}s`}
                  className="absolute bottom-0.5 size-1.5 -translate-x-1/2 rotate-45 bg-rose-400"
                  style={{ left: `${beat * pxPerSec}px` }}
                />
              ))}
          </div>

          {/* Track 1: Visual Clips + Trim Handles + Transition Badges + Add Clip */}
          <div className="relative mt-1.5 flex h-14 items-center">
            {layout.slots.map((sl) => {
              const asset = assetsById.get(sl.slot.assetId);
              const left = sl.timelineStartSec * pxPerSec;
              const width = Math.max(36, (sl.timelineEndSec - sl.timelineStartSec) * pxPerSec);
              const isSelected = sl.slot.id === selection.slotId;
              const maxDur = asset?.durationSec ?? sl.slot.sourceEndSec;

              return (
                <div
                  key={sl.slot.id}
                  style={{ left: `${left}px`, width: `${width}px` }}
                  className={`absolute top-0 flex h-14 overflow-hidden rounded-lg border transition ${
                    isSelected
                      ? "z-10 border-cyan-300 ring-2 ring-cyan-400/60"
                      : "border-slate-700 hover:border-slate-500"
                  }`}
                >
                  {asset?.thumbnailUrl && (
                    <img
                      src={asset.thumbnailUrl}
                      alt=""
                      className="pointer-events-none absolute inset-0 h-full w-full object-cover opacity-35"
                    />
                  )}
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-slate-950/90 via-slate-950/40 to-transparent" />

                  {/* Left Trim Edge */}
                  {isSelected && (
                    <button
                      type="button"
                      aria-label={`Trim start of clip ${sl.index + 1}`}
                      onPointerDown={(e) => startEdgeTrimDrag(e, sl.slot, "start", maxDur)}
                      className="drag-handle relative z-20 flex h-full w-2.5 shrink-0 items-center justify-center bg-cyan-400 text-slate-950"
                    >
                      <span className="h-5 w-0.5 rounded bg-slate-950" />
                    </button>
                  )}

                  {/* Clip Body */}
                  <button
                    type="button"
                    onClick={() => {
                      onSelectSlot(sl.slot.id);
                      onSeek(sl.timelineStartSec + 0.05);
                    }}
                    className="relative z-10 flex min-w-0 flex-1 flex-col justify-between px-1.5 py-1 text-left"
                  >
                    <span className="truncate text-[10px] font-bold text-white drop-shadow">
                      {sl.slot.reversed ? "↺ " : ""}
                      {asset?.originalName ?? `Clip ${sl.index + 1}`}
                    </span>
                    <div className="flex items-center justify-between gap-1 text-[9px] text-slate-200">
                      <span className="truncate">
                        {sl.slot.speed !== 1 ? `${sl.slot.speed}x · ` : ""}
                        {sl.slot.motion}
                      </span>
                      <span className="shrink-0 font-mono">{sl.rawDurationSec.toFixed(1)}s</span>
                    </div>
                  </button>

                  {/* Right Trim Edge */}
                  {isSelected && (
                    <button
                      type="button"
                      aria-label={`Trim end of clip ${sl.index + 1}`}
                      onPointerDown={(e) => startEdgeTrimDrag(e, sl.slot, "end", maxDur)}
                      className="drag-handle relative z-20 flex h-full w-2.5 shrink-0 items-center justify-center bg-cyan-400 text-slate-950"
                    >
                      <span className="h-5 w-0.5 rounded bg-slate-950" />
                    </button>
                  )}

                  {/* Transition Connector Pill on Slot Boundary */}
                  {sl.index > 0 && (
                    <button
                      type="button"
                      title={`Transition: ${sl.slot.transitionIn} (tap to cycle)`}
                      aria-label={`Cycle transition for clip ${sl.index + 1}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        const nextIdx =
                          (TRANSITION_CYCLE.indexOf(sl.slot.transitionIn) + 1) %
                          TRANSITION_CYCLE.length;
                        const nextTr = TRANSITION_CYCLE[nextIdx];
                        onUpdateSlot(sl.slot.id, {
                          transitionIn: nextTr,
                          transitionDurationSec: nextTr === "cut" ? 0 : 0.25,
                        });
                      }}
                      className={`absolute top-1/2 -left-0.5 z-30 flex size-5 -translate-y-1/2 items-center justify-center rounded-md border text-[9px] font-bold shadow ${
                        sl.slot.transitionIn === "cut"
                          ? "border-slate-600 bg-slate-900 text-slate-300"
                          : "border-rose-300 bg-rose-500 text-white"
                      }`}
                    >
                      {sl.slot.transitionIn === "cut" ? "|" : "⚡"}
                    </button>
                  )}
                </div>
              );
            })}

            {/* Append Clip "+" button at end of track */}
            <button
              type="button"
              onClick={onOpenAddClip}
              aria-label="Add clip to timeline"
              style={{ left: `${totalSec * pxPerSec + 10}px` }}
              className="absolute top-2 inline-flex h-10 w-10 items-center justify-center rounded-xl border border-dashed border-cyan-400/60 bg-cyan-500/10 text-cyan-300 hover:bg-cyan-500/20"
            >
              <Plus className="size-4" aria-hidden="true" />
            </button>
          </div>

          {/* Track 2: Text & Sticker Overlays */}
          <div className="relative mt-1.5 flex h-7 items-center">
            {project.overlays.map((ov) => {
              const left = ov.startSec * pxPerSec;
              const width = Math.max(44, (ov.endSec - ov.startSec) * pxPerSec);
              const active = selection.overlayId === ov.id;
              return (
                <div
                  key={ov.id}
                  style={{ left: `${left}px`, width: `${width}px` }}
                  className={`absolute top-0 flex h-6 overflow-hidden rounded-md border text-[10px] font-semibold ${
                    active
                      ? "z-10 border-amber-300 bg-amber-400/30 text-amber-100 ring-1 ring-amber-300"
                      : "border-amber-400/45 bg-amber-500/15 text-amber-200"
                  }`}
                >
                  {active && (
                    <button
                      type="button"
                      aria-label={`Trim start of text ${ov.text}`}
                      onPointerDown={(e) =>
                        startTimedRangeTrimDrag(e, ov.startSec, ov.endSec, "start", (patch) =>
                          onUpdateOverlay(ov.id, patch, false)
                        )
                      }
                      className="drag-handle flex h-full w-2 shrink-0 items-center justify-center bg-amber-300 text-slate-950"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      onSelectOverlay(ov.id);
                      onSeek(ov.startSec + 0.05);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1 px-1.5 text-left"
                  >
                    <Type className="size-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{ov.text}</span>
                  </button>
                  {active && (
                    <button
                      type="button"
                      aria-label={`Trim end of text ${ov.text}`}
                      onPointerDown={(e) =>
                        startTimedRangeTrimDrag(e, ov.startSec, ov.endSec, "end", (patch) =>
                          onUpdateOverlay(ov.id, patch, false)
                        )
                      }
                      className="drag-handle flex h-full w-2 shrink-0 items-center justify-center bg-amber-300 text-slate-950"
                    />
                  )}
                </div>
              );
            })}
            {(project.stickers || []).map((st) => {
              const left = st.startSec * pxPerSec;
              const width = Math.max(36, (st.endSec - st.startSec) * pxPerSec);
              const active = selection.stickerId === st.id;
              const stickerLabel = st.assetId
                ? (assetsById.get(st.assetId)?.originalName ?? "Logo")
                : st.stickerId;
              return (
                <div
                  key={st.id}
                  style={{ left: `${left}px`, width: `${width}px` }}
                  className={`absolute top-0 flex h-6 overflow-hidden rounded-md border text-[10px] font-semibold ${
                    active
                      ? "z-10 border-emerald-300 bg-emerald-400/30 text-emerald-100 ring-1 ring-emerald-300"
                      : "border-emerald-400/45 bg-emerald-500/15 text-emerald-200"
                  }`}
                >
                  {active && (
                    <button
                      type="button"
                      aria-label={`Trim start of sticker ${stickerLabel}`}
                      onPointerDown={(e) =>
                        startTimedRangeTrimDrag(e, st.startSec, st.endSec, "start", (patch) =>
                          onUpdateSticker(st.id, patch, false)
                        )
                      }
                      className="drag-handle flex h-full w-2 shrink-0 items-center justify-center bg-emerald-300 text-slate-950"
                    />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      onSelectSticker(st.id);
                      onSeek(st.startSec + 0.05);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1 px-1.5 text-left"
                  >
                    <Sticker className="size-3 shrink-0" aria-hidden="true" />
                    <span className="truncate">{stickerLabel}</span>
                  </button>
                  {active && (
                    <button
                      type="button"
                      aria-label={`Trim end of sticker ${stickerLabel}`}
                      onPointerDown={(e) =>
                        startTimedRangeTrimDrag(e, st.startSec, st.endSec, "end", (patch) =>
                          onUpdateSticker(st.id, patch, false)
                        )
                      }
                      className="drag-handle flex h-full w-2 shrink-0 items-center justify-center bg-emerald-300 text-slate-950"
                    />
                  )}
                </div>
              );
            })}
            {project.overlays.length === 0 && (project.stickers || []).length === 0 && (
              <button
                type="button"
                onClick={onAddTextShortcut}
                className="inline-flex h-6 items-center gap-1 rounded-md border border-dashed border-slate-700 px-2.5 text-[10px] text-slate-400 hover:border-amber-400 hover:text-amber-200"
              >
                <Plus className="size-3" aria-hidden="true" />
                <span>Add Text / Captions</span>
              </button>
            )}
          </div>

          {/* Track 3+: Audio Tracks (BGM, SFX, Voiceover) with Real Waveforms */}
          <div className="mt-1.5 flex flex-col gap-1">
            {tracks.length === 0 ? (
              <button
                type="button"
                onClick={onOpenAddMusic}
                className="flex h-8 w-56 items-center justify-center gap-1.5 rounded-lg border border-dashed border-rose-400/50 bg-rose-500/10 text-[11px] font-semibold text-rose-200 hover:bg-rose-500/20"
              >
                <Music2 className="size-3.5" aria-hidden="true" />
                <span>+ Add Music / Sound Effect</span>
              </button>
            ) : (
              tracks.map((tr) => {
                const start = tr.timelineStartSec ?? 0;
                const dur = tr.durationSec ?? Math.max(0.5, totalSec - start);
                const left = start * pxPerSec;
                const width = Math.max(48, dur * pxPerSec);
                const active = selection.audioTrackId === tr.id;
                const peaks = waveforms.get(tr.assetId) ?? [];

                return (
                  <div key={tr.id} className="relative h-8">
                    <button
                      type="button"
                      onClick={() => {
                        onSelectAudioTrack(tr.id);
                        onSeek(start + 0.05);
                      }}
                      style={{ left: `${left}px`, width: `${width}px` }}
                      className={`absolute top-0 flex h-8 items-center overflow-hidden rounded-lg border px-2 text-left ${
                        active
                          ? "z-10 border-rose-300 bg-rose-500/25 ring-1 ring-rose-300"
                          : tr.kind === "sfx"
                            ? "border-amber-500/45 bg-amber-500/15"
                            : "border-rose-500/45 bg-rose-500/15"
                      }`}
                    >
                      {/* Waveform background bars (reflects active Song Start & Length slice) */}
                      {peaks.length > 0 && (() => {
                        const asset = assetsById.get(tr.assetId);
                        const assetDur = Math.max(0.5, asset?.durationSec ?? dur);
                        const offsetSec = tr.startOffsetSec || 0;
                        const totalBins = peaks.length;
                        const barCount = Math.min(48, Math.max(12, Math.round(dur * 5)));
                        return (
                          <div
                            aria-hidden="true"
                            className="pointer-events-none absolute inset-0 flex items-center gap-[1px] px-1 opacity-45"
                          >
                            {Array.from({ length: barCount }).map((_, i) => {
                              const sampleT = offsetSec + (i / barCount) * dur;
                              const normPos =
                                tr.kind === "bgm"
                                  ? (sampleT % assetDur) / assetDur
                                  : Math.min(0.99, sampleT / assetDur);
                              const binIdx = Math.min(
                                totalBins - 1,
                                Math.max(0, Math.floor(normPos * totalBins))
                              );
                              const p = peaks[binIdx] ?? 0.2;
                              return (
                                <span
                                  key={i}
                                  className="flex-1 rounded-full bg-rose-300"
                                  style={{ height: `${Math.max(15, Math.round(p * 90))}%` }}
                                />
                              );
                            })}
                          </div>
                        );
                      })()}
                      <span className="relative z-10 flex items-center gap-1 truncate text-[10px] font-bold text-rose-100">
                        <Music2 className="size-3 shrink-0" aria-hidden="true" />
                        <span className="truncate">{tr.title || tr.kind}</span>
                      </span>
                    </button>
                  </div>
                );
              })
            )}
            {tracks.length > 0 && (
              <button
                type="button"
                onClick={onOpenAddMusic}
                className="inline-flex h-6 w-fit items-center gap-1 rounded-md border border-dashed border-rose-400/45 bg-rose-500/10 px-2.5 text-[10px] font-semibold text-rose-200 hover:bg-rose-500/20"
              >
                <Plus className="size-3" aria-hidden="true" />
                <span>Add Music / SFX</span>
              </button>
            )}
          </div>

          {/* Playhead Needle */}
          <div
            className="pointer-events-none absolute top-0 bottom-0 z-30 w-0.5 bg-cyan-300 shadow-[0_0_8px_#22d3ee]"
            style={{ left: `${playheadLeft}px` }}
          >
            <div className="-ml-1.5 h-2.5 w-3.5 rounded-b bg-cyan-300" />
          </div>
        </div>
      </div>
    </div>
  );
}
