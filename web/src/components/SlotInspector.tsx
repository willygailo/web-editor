import { Plus, Trash2, Volume2, VolumeX } from "lucide-react";
import type {
  ClipSlot,
  CutProject,
  FilterPreset,
  MediaAsset,
  MotionPreset,
  OverlayPosition,
  OverlayStyle,
  TextOverlay,
  TransitionType,
} from "@cutflow/shared";

interface SlotInspectorProps {
  project: CutProject | null;
  selectedSlotId: string | null;
  assetsById: Map<string, MediaAsset>;
  onUpdateSlot: (slotId: string, patch: Partial<ClipSlot>) => void;
  onDeleteSlot: (slotId: string) => void;
  onUpdateOverlays: (overlays: TextOverlay[]) => void;
}

const MOTIONS: MotionPreset[] = ["none", "zoom-in", "zoom-out", "punch-zoom", "pan-left", "pan-right"];
const TRANSITIONS: TransitionType[] = ["cut", "crossfade", "slide-left", "flash-white", "zoom-blur"];
const FILTERS: FilterPreset[] = ["none", "vivid", "cinematic", "warm-film", "bw-contrast"];
const OVERLAY_STYLES: OverlayStyle[] = ["bold-hook", "capcut-pop", "minimal-caption", "neon-badge"];
const OVERLAY_POSITIONS: OverlayPosition[] = ["top", "center", "bottom"];

export function SlotInspector({
  project,
  selectedSlotId,
  assetsById,
  onUpdateSlot,
  onDeleteSlot,
  onUpdateOverlays,
}: SlotInspectorProps) {
  if (!project) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-[#090b10] p-4 text-xs text-slate-400">
        No active timeline yet. Run AI Auto Edit or apply a template to fine-tune clips and text.
      </div>
    );
  }

  const slot = project.clips.find((c) => c.id === selectedSlotId) ?? project.clips[0];
  const asset = slot ? assetsById.get(slot.assetId) : undefined;
  const maxDur = asset?.durationSec ?? 10;

  return (
    <div className="flex flex-col gap-4 text-xs">
      {slot && (
        <section className="flex flex-col gap-2.5 rounded-2xl border border-slate-800 bg-[#090b10] p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate text-xs font-bold text-slate-100">
              Clip Slot: {asset?.originalName ?? slot.id}
            </h3>
            {project.clips.length > 1 && (
              <button
                type="button"
                onClick={() => onDeleteSlot(slot.id)}
                aria-label="Remove clip from timeline"
                className="inline-flex items-center gap-1 rounded-lg bg-rose-500/15 px-2 py-1 text-[11px] font-semibold text-rose-300 hover:bg-rose-500/25"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
                Remove
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-slate-400">
              <span>In ({slot.sourceStartSec.toFixed(1)}s)</span>
              <input
                type="range"
                min={0}
                max={Math.max(0.2, slot.sourceEndSec - 0.35)}
                step={0.1}
                value={slot.sourceStartSec}
                onChange={(e) =>
                  onUpdateSlot(slot.id, { sourceStartSec: Number(e.target.value) })
                }
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-slate-400">
              <span>Out ({slot.sourceEndSec.toFixed(1)}s)</span>
              <input
                type="range"
                min={Math.min(maxDur, slot.sourceStartSec + 0.35)}
                max={maxDur}
                step={0.1}
                value={slot.sourceEndSec}
                onChange={(e) =>
                  onUpdateSlot(slot.id, { sourceEndSec: Number(e.target.value) })
                }
              />
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-slate-400">
              <span>Motion</span>
              <select
                value={slot.motion}
                onChange={(e) =>
                  onUpdateSlot(slot.id, { motion: e.target.value as MotionPreset })
                }
                className="rounded-lg border border-slate-700 bg-[#111520] px-2 py-1.5 text-xs text-slate-100"
              >
                {MOTIONS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-slate-400">
              <span>Transition In</span>
              <select
                value={slot.transitionIn}
                onChange={(e) => {
                  const val = e.target.value as TransitionType;
                  onUpdateSlot(slot.id, {
                    transitionIn: val,
                    transitionDurationSec: val === "cut" ? 0 : Math.max(0.2, slot.transitionDurationSec),
                  });
                }}
                className="rounded-lg border border-slate-700 bg-[#111520] px-2 py-1.5 text-xs text-slate-100"
              >
                {TRANSITIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-slate-400">
              <span>Color Filter</span>
              <select
                value={slot.filter}
                onChange={(e) =>
                  onUpdateSlot(slot.id, { filter: e.target.value as FilterPreset })
                }
                className="rounded-lg border border-slate-700 bg-[#111520] px-2 py-1.5 text-xs text-slate-100"
              >
                {FILTERS.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-[11px] text-slate-400">
              <span>Speed ({slot.speed.toFixed(2)}x)</span>
              <input
                type="range"
                min={0.5}
                max={2.0}
                step={0.05}
                value={slot.speed}
                onChange={(e) =>
                  onUpdateSlot(slot.id, { speed: Number(e.target.value) })
                }
              />
            </label>
          </div>

          <button
            type="button"
            onClick={() =>
              onUpdateSlot(slot.id, {
                muteOriginalAudio: !slot.muteOriginalAudio,
                volume: slot.muteOriginalAudio ? 1 : 0,
              })
            }
            className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-[#111520] px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-cyan-400"
          >
            {slot.muteOriginalAudio ? (
              <>
                <VolumeX className="size-3.5 text-slate-400" aria-hidden="true" />
                <span>Original Clip Audio Muted</span>
              </>
            ) : (
              <>
                <Volume2 className="size-3.5 text-cyan-400" aria-hidden="true" />
                <span>Original Clip Audio On</span>
              </>
            )}
          </button>
        </section>
      )}

      <section className="flex flex-col gap-2.5 rounded-2xl border border-slate-800 bg-[#090b10] p-3">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-bold text-slate-100">Text Overlays</h3>
          <button
            type="button"
            onClick={() =>
              onUpdateOverlays([
                ...project.overlays,
                {
                  id: `txt-${Date.now()}`,
                  text: "NEW HOOK",
                  startSec: 0.2,
                  endSec: Math.min(project.targetDurationSec, 3.0),
                  position: "center",
                  style: "capcut-pop",
                },
              ])
            }
            className="inline-flex items-center gap-1 rounded-lg bg-cyan-500/15 px-2.5 py-1 text-[11px] font-semibold text-cyan-300 hover:bg-cyan-500/25"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            Add Text
          </button>
        </div>

        {project.overlays.length === 0 ? (
          <p className="text-[11px] text-slate-500">No text overlays on timeline.</p>
        ) : (
          project.overlays.map((ov) => (
            <div
              key={ov.id}
              className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-[#111520] p-2.5"
            >
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={ov.text}
                  onChange={(e) =>
                    onUpdateOverlays(
                      project.overlays.map((item) =>
                        item.id === ov.id ? { ...item, text: e.target.value } : item
                      )
                    )
                  }
                  aria-label="Overlay text"
                  className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-[#090b10] px-2.5 py-1 text-xs text-slate-100"
                />
                <button
                  type="button"
                  onClick={() =>
                    onUpdateOverlays(project.overlays.filter((item) => item.id !== ov.id))
                  }
                  aria-label="Delete text overlay"
                  className="rounded-lg px-2 text-slate-400 hover:text-rose-400"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-1.5">
                <select
                  value={ov.style}
                  aria-label="Overlay style"
                  onChange={(e) =>
                    onUpdateOverlays(
                      project.overlays.map((item) =>
                        item.id === ov.id
                          ? { ...item, style: e.target.value as OverlayStyle }
                          : item
                      )
                    )
                  }
                  className="rounded-lg border border-slate-700 bg-[#090b10] px-2 py-1 text-[11px]"
                >
                  {OVERLAY_STYLES.map((st) => (
                    <option key={st} value={st}>
                      {st}
                    </option>
                  ))}
                </select>
                <select
                  value={ov.position}
                  aria-label="Overlay position"
                  onChange={(e) =>
                    onUpdateOverlays(
                      project.overlays.map((item) =>
                        item.id === ov.id
                          ? { ...item, position: e.target.value as OverlayPosition }
                          : item
                      )
                    )
                  }
                  className="rounded-lg border border-slate-700 bg-[#090b10] px-2 py-1 text-[11px]"
                >
                  {OVERLAY_POSITIONS.map((pos) => (
                    <option key={pos} value={pos}>
                      {pos}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
