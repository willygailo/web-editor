import { useState } from "react";
import {
  Captions,
  Copy,
  Move,
  Plus,
  RotateCcw,
  Sliders,
  Sparkles,
  Sticker,
  Trash2,
  Volume2,
  VolumeX,
} from "lucide-react";
import {
  STICKER_CATALOG,
  type ClipAdjust,
  type ClipSlot,
  type ClipTransform,
  type CutProject,
  type FilterPreset,
  type MediaAsset,
  type MotionPreset,
  type OverlayPosition,
  type OverlayStyle,
  type StickerOverlay,
  type TextAnimation,
  type TextOverlay,
  type TransitionType,
} from "@cutflow/shared";
import type { EditorSelection } from "../state/useEditorStore";

export type InspectorSection = "clip" | "adjust" | "text" | "stickers";

interface SlotInspectorProps {
  project: CutProject | null;
  selection: EditorSelection;
  activeSection?: InspectorSection;
  assets: MediaAsset[];
  assetsById: Map<string, MediaAsset>;
  currentTime: number;
  onBeginSlider?: () => void;
  onEndSlider?: () => void;
  onUpdateSlot: (slotId: string, patch: Partial<ClipSlot>, recordHistory?: boolean) => void;
  onReplaceSlotAsset: (slotId: string, asset: MediaAsset) => void;
  onDuplicateSlot: (slotId: string) => void;
  onDeleteSlot: (slotId: string) => void;
  onUpdateOverlays: (overlays: TextOverlay[], recordHistory?: boolean) => void;
  onUpdateStickers: (stickers: StickerOverlay[], recordHistory?: boolean) => void;
  onSelectOverlay: (id: string | null) => void;
  onSelectSticker: (id: string | null) => void;
  onAutoCaptions: (videoAssetId: string) => Promise<void>;
}

const MOTIONS: MotionPreset[] = ["none", "zoom-in", "zoom-out", "punch-zoom", "pan-left", "pan-right"];
const TRANSITIONS: TransitionType[] = ["cut", "crossfade", "slide-left", "flash-white", "zoom-blur"];
const FILTERS: FilterPreset[] = ["none", "vivid", "cinematic", "warm-film", "bw-contrast"];
const OVERLAY_STYLES: OverlayStyle[] = ["bold-hook", "capcut-pop", "minimal-caption", "neon-badge"];
const OVERLAY_ANIMS: TextAnimation[] = ["pop", "fade", "slide-up", "none"];

const DEFAULT_ADJUST: ClipAdjust = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  warmth: 0,
  vignette: 0,
};

const DEFAULT_TRANSFORM: ClipTransform = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  rotationDeg: 0,
};

export function SlotInspector({
  project,
  selection,
  activeSection,
  assets,
  assetsById,
  currentTime,
  onBeginSlider,
  onEndSlider,
  onUpdateSlot,
  onReplaceSlotAsset,
  onDuplicateSlot,
  onDeleteSlot,
  onUpdateOverlays,
  onUpdateStickers,
  onSelectOverlay,
  onSelectSticker,
  onAutoCaptions,
}: SlotInspectorProps) {
  const [capturingCaptions, setCapturingCaptions] = useState(false);

  if (!project) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-[#090b10] p-4 text-xs text-slate-400">
        Select a clip, text, sticker, or template to edit properties here.
      </div>
    );
  }

  const slot = project.clips.find((c) => c.id === selection.slotId) ?? project.clips[0];
  const asset = slot ? assetsById.get(slot.assetId) : undefined;
  const visualAssets = assets.filter((a) => a.kind !== "audio");
  const maxDur = asset?.durationSec ?? 10;
  const adjust = { ...DEFAULT_ADJUST, ...(slot?.adjust ?? {}) };
  const transform = { ...DEFAULT_TRANSFORM, ...(slot?.transform ?? {}) };

  const selectedOverlay =
    project.overlays.find((o) => o.id === selection.overlayId) ?? project.overlays[0];
  const selectedSticker =
    (project.stickers || []).find((s) => s.id === selection.stickerId) ??
    (project.stickers || [])[0];

  // Determine which section(s) to emphasize
  const showAllDesktop = !activeSection;
  const showClip = showAllDesktop || activeSection === "clip";
  const showAdjust = showAllDesktop || activeSection === "adjust";
  const showText = showAllDesktop || activeSection === "text" || Boolean(selection.overlayId);
  const showStickers =
    showAllDesktop || activeSection === "stickers" || Boolean(selection.stickerId);

  return (
    <div className="flex flex-col gap-3 text-xs">
      {slot && showClip && (
        <section className="flex flex-col gap-2.5 rounded-2xl border border-slate-800 bg-[#090b10] p-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="truncate text-xs font-bold text-slate-100">
              Clip: {asset?.originalName ?? slot.id}
            </h3>
            <div className="flex gap-1">
              <button
                type="button"
                onClick={() => onDuplicateSlot(slot.id)}
                aria-label="Duplicate clip"
                className="rounded-lg border border-slate-700 p-1 text-slate-300 hover:border-cyan-400"
              >
                <Copy className="size-3.5" aria-hidden="true" />
              </button>
              {project.clips.length > 1 && (
                <button
                  type="button"
                  onClick={() => onDeleteSlot(slot.id)}
                  aria-label="Remove clip from timeline"
                  className="rounded-lg bg-rose-500/15 p-1 text-rose-300 hover:bg-rose-500/25"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>

          {/* CapCut Replace Clip + Reverse */}
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-slate-400">
              <span>Replace Clip</span>
              <select
                value={slot.assetId}
                onChange={(e) => {
                  const next = assetsById.get(e.target.value);
                  if (next) onReplaceSlotAsset(slot.id, next);
                }}
                className="rounded-lg border border-slate-700 bg-[#111520] px-2 py-1.5 text-xs text-slate-100"
              >
                {visualAssets.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.originalName}
                  </option>
                ))}
              </select>
            </label>

            <div className="flex flex-col justify-end gap-1">
              {asset?.kind === "video" && (
                <button
                  type="button"
                  onClick={() => onUpdateSlot(slot.id, { reversed: !slot.reversed })}
                  className={`inline-flex items-center justify-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-semibold ${
                    slot.reversed
                      ? "border-cyan-400 bg-cyan-500/20 text-cyan-200"
                      : "border-slate-700 bg-[#111520] text-slate-300"
                  }`}
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  <span>{slot.reversed ? "Reversed On" : "Reverse"}</span>
                </button>
              )}
            </div>
          </div>

          {asset?.kind === "image" ? (
            <label className="flex flex-col gap-0.5 text-[11px] text-slate-400">
              <span>Photo Duration ({(slot.sourceEndSec - slot.sourceStartSec).toFixed(1)}s)</span>
              <input
                type="range"
                min={0.6}
                max={10}
                step={0.1}
                value={Math.max(0.6, slot.sourceEndSec - slot.sourceStartSec)}
                onPointerDown={onBeginSlider}
                onPointerUp={onEndSlider}
                onBlur={onEndSlider}
                onChange={(e) =>
                  onUpdateSlot(
                    slot.id,
                    { sourceStartSec: 0, sourceEndSec: Number(e.target.value) },
                    false
                  )
                }
              />
            </label>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-0.5 text-[11px] text-slate-400">
                <span>In ({slot.sourceStartSec.toFixed(1)}s)</span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(0.2, slot.sourceEndSec - 0.35)}
                  step={0.1}
                  value={slot.sourceStartSec}
                  onPointerDown={onBeginSlider}
                  onPointerUp={onEndSlider}
                  onBlur={onEndSlider}
                  onChange={(e) =>
                    onUpdateSlot(slot.id, { sourceStartSec: Number(e.target.value) }, false)
                  }
                />
              </label>
              <label className="flex flex-col gap-0.5 text-[11px] text-slate-400">
                <span>Out ({slot.sourceEndSec.toFixed(1)}s)</span>
                <input
                  type="range"
                  min={Math.min(maxDur, slot.sourceStartSec + 0.35)}
                  max={maxDur}
                  step={0.1}
                  value={slot.sourceEndSec}
                  onPointerDown={onBeginSlider}
                  onPointerUp={onEndSlider}
                  onBlur={onEndSlider}
                  onChange={(e) =>
                    onUpdateSlot(slot.id, { sourceEndSec: Number(e.target.value) }, false)
                  }
                />
              </label>
            </div>
          )}

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
              <span>Filter</span>
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

            <label className="flex flex-col gap-0.5 text-[11px] text-slate-400">
              <span>Speed ({slot.speed.toFixed(2)}x)</span>
              <input
                type="range"
                min={0.5}
                max={2.5}
                step={0.05}
                value={slot.speed}
                onPointerDown={onBeginSlider}
                onPointerUp={onEndSlider}
                onBlur={onEndSlider}
                onChange={(e) =>
                  onUpdateSlot(slot.id, { speed: Number(e.target.value) }, false)
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
                <span>Original Audio Muted</span>
              </>
            ) : (
              <>
                <Volume2 className="size-3.5 text-cyan-400" aria-hidden="true" />
                <span>Original Audio On ({Math.round(slot.volume * 100)}%)</span>
              </>
            )}
          </button>
        </section>
      )}

      {/* Color Adjust & Transform */}
      {slot && showAdjust && (
        <section className="flex flex-col gap-2 rounded-2xl border border-slate-800 bg-[#090b10] p-3">
          <div className="flex items-center justify-between">
            <h3 className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-100">
              <Sliders className="size-3.5 text-cyan-400" aria-hidden="true" />
              Adjust &amp; Crop Transform
            </h3>
            <button
              type="button"
              onClick={() =>
                onUpdateSlot(slot.id, { adjust: DEFAULT_ADJUST, transform: DEFAULT_TRANSFORM })
              }
              className="text-[11px] text-slate-400 hover:text-cyan-300"
            >
              Reset
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400">
            <label className="flex flex-col">
              <span>Brightness ({adjust.brightness.toFixed(2)})</span>
              <input
                type="range"
                min={-0.35}
                max={0.35}
                step={0.02}
                value={adjust.brightness}
                onPointerDown={onBeginSlider}
                onPointerUp={onEndSlider}
                onBlur={onEndSlider}
                onChange={(e) =>
                  onUpdateSlot(
                    slot.id,
                    { adjust: { ...adjust, brightness: Number(e.target.value) } },
                    false
                  )
                }
              />
            </label>
            <label className="flex flex-col">
              <span>Contrast ({adjust.contrast.toFixed(2)})</span>
              <input
                type="range"
                min={-0.35}
                max={0.45}
                step={0.02}
                value={adjust.contrast}
                onPointerDown={onBeginSlider}
                onPointerUp={onEndSlider}
                onBlur={onEndSlider}
                onChange={(e) =>
                  onUpdateSlot(
                    slot.id,
                    { adjust: { ...adjust, contrast: Number(e.target.value) } },
                    false
                  )
                }
              />
            </label>
            <label className="flex flex-col">
              <span>Saturation ({adjust.saturation.toFixed(2)})</span>
              <input
                type="range"
                min={-1}
                max={1}
                step={0.05}
                value={adjust.saturation}
                onPointerDown={onBeginSlider}
                onPointerUp={onEndSlider}
                onBlur={onEndSlider}
                onChange={(e) =>
                  onUpdateSlot(
                    slot.id,
                    { adjust: { ...adjust, saturation: Number(e.target.value) } },
                    false
                  )
                }
              />
            </label>
            <label className="flex flex-col">
              <span>Warmth ({adjust.warmth.toFixed(2)})</span>
              <input
                type="range"
                min={-0.4}
                max={0.4}
                step={0.02}
                value={adjust.warmth}
                onPointerDown={onBeginSlider}
                onPointerUp={onEndSlider}
                onBlur={onEndSlider}
                onChange={(e) =>
                  onUpdateSlot(
                    slot.id,
                    { adjust: { ...adjust, warmth: Number(e.target.value) } },
                    false
                  )
                }
              />
            </label>
            <label className="flex flex-col">
              <span>Vignette ({Math.round(adjust.vignette * 100)}%)</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={adjust.vignette}
                onPointerDown={onBeginSlider}
                onPointerUp={onEndSlider}
                onBlur={onEndSlider}
                onChange={(e) =>
                  onUpdateSlot(
                    slot.id,
                    { adjust: { ...adjust, vignette: Number(e.target.value) } },
                    false
                  )
                }
              />
            </label>
            <label className="flex flex-col">
              <span>Zoom Scale ({transform.scale.toFixed(2)}x)</span>
              <input
                type="range"
                min={0.6}
                max={2.2}
                step={0.05}
                value={transform.scale}
                onPointerDown={onBeginSlider}
                onPointerUp={onEndSlider}
                onBlur={onEndSlider}
                onChange={(e) =>
                  onUpdateSlot(
                    slot.id,
                    { transform: { ...transform, scale: Number(e.target.value) } },
                    false
                  )
                }
              />
            </label>
          </div>
        </section>
      )}

      {/* Text & Auto-Captions Designer */}
      {showText && (
        <section className="flex flex-col gap-2.5 rounded-2xl border border-slate-800 bg-[#090b10] p-3">
          <div className="flex flex-wrap items-center justify-between gap-1.5">
            <h3 className="text-xs font-bold text-slate-100">Text &amp; Captions</h3>
            <div className="flex gap-1">
              {asset?.hasAudio && (
                <button
                  type="button"
                  disabled={capturingCaptions}
                  onClick={async () => {
                    setCapturingCaptions(true);
                    try {
                      await onAutoCaptions(asset.id);
                    } finally {
                      setCapturingCaptions(false);
                    }
                  }}
                  className="inline-flex items-center gap-1 rounded-lg bg-amber-400/20 px-2 py-1 text-[11px] font-bold text-amber-200 hover:bg-amber-400/30 disabled:opacity-50"
                >
                  <Captions className="size-3.5" aria-hidden="true" />
                  <span>{capturingCaptions ? "Listening..." : "Auto Captions"}</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  const id = `txt-${Date.now().toString(36)}`;
                  const safeStart = Math.max(
                    0,
                    Math.min(Math.max(0, project.targetDurationSec - 1), currentTime)
                  );
                  const safeEnd = Math.min(
                    project.targetDurationSec,
                    Math.max(safeStart + 0.6, safeStart + 2.5)
                  );
                  onUpdateOverlays([
                    ...project.overlays,
                    {
                      id,
                      text: "NEW TEXT",
                      startSec: Number(safeStart.toFixed(2)),
                      endSec: Number(safeEnd.toFixed(2)),
                      position: "center",
                      style: "capcut-pop",
                      xNorm: 0.5,
                      yNorm: 0.5,
                      scale: 1,
                      rotationDeg: 0,
                      animation: "pop",
                    },
                  ]);
                  onSelectOverlay(id);
                }}
                className="inline-flex items-center gap-1 rounded-lg bg-cyan-500/15 px-2 py-1 text-[11px] font-semibold text-cyan-300 hover:bg-cyan-500/25"
              >
                <Plus className="size-3.5" aria-hidden="true" />
                Add Text
              </button>
            </div>
          </div>

          {selectedOverlay ? (
            <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-[#111520] p-2.5">
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={selectedOverlay.text}
                  onChange={(e) =>
                    onUpdateOverlays(
                      project.overlays.map((o) =>
                        o.id === selectedOverlay.id ? { ...o, text: e.target.value } : o
                      )
                    )
                  }
                  onBlur={() => {
                    if (!selectedOverlay.text.trim()) {
                      onUpdateOverlays(
                        project.overlays.map((o) =>
                          o.id === selectedOverlay.id ? { ...o, text: "TEXT" } : o
                        )
                      );
                    }
                  }}
                  aria-label="Overlay text"
                  className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-[#090b10] px-2.5 py-1 text-xs text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => {
                    onUpdateOverlays(project.overlays.filter((o) => o.id !== selectedOverlay.id));
                    onSelectOverlay(null);
                  }}
                  aria-label="Delete text overlay"
                  className="rounded-lg px-2 text-slate-400 hover:text-rose-400"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <select
                  value={selectedOverlay.style}
                  aria-label="Overlay style"
                  onChange={(e) =>
                    onUpdateOverlays(
                      project.overlays.map((o) =>
                        o.id === selectedOverlay.id
                          ? { ...o, style: e.target.value as OverlayStyle }
                          : o
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
                  value={selectedOverlay.animation ?? "pop"}
                  aria-label="Text animation"
                  onChange={(e) =>
                    onUpdateOverlays(
                      project.overlays.map((o) =>
                        o.id === selectedOverlay.id
                          ? { ...o, animation: e.target.value as TextAnimation }
                          : o
                      )
                    )
                  }
                  className="rounded-lg border border-slate-700 bg-[#090b10] px-2 py-1 text-[11px]"
                >
                  {OVERLAY_ANIMS.map((an) => (
                    <option key={an} value={an}>
                      anim: {an}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="inline-flex items-center gap-1 text-slate-400">
                  <Move className="size-3" aria-hidden="true" />
                  Drag on preview or snap:
                </span>
                <div className="flex gap-1">
                  {(["top", "center", "bottom"] as OverlayPosition[]).map((pos) => (
                    <button
                      key={pos}
                      type="button"
                      onClick={() =>
                        onUpdateOverlays(
                          project.overlays.map((o) =>
                            o.id === selectedOverlay.id
                              ? {
                                  ...o,
                                  position: pos,
                                  xNorm: 0.5,
                                  yNorm: pos === "top" ? 0.14 : pos === "center" ? 0.5 : 0.84,
                                }
                              : o
                          )
                        )
                      }
                      className="rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-300 hover:border-cyan-400"
                    >
                      {pos}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px] text-slate-400">
                <label className="flex flex-col">
                  <span>Size ({(selectedOverlay.scale ?? 1).toFixed(2)}x)</span>
                  <input
                    type="range"
                    min={0.5}
                    max={2.2}
                    step={0.05}
                    value={selectedOverlay.scale ?? 1}
                    onPointerDown={onBeginSlider}
                    onPointerUp={onEndSlider}
                    onBlur={onEndSlider}
                    onChange={(e) =>
                      onUpdateOverlays(
                        project.overlays.map((o) =>
                          o.id === selectedOverlay.id
                            ? { ...o, scale: Number(e.target.value) }
                            : o
                        ),
                        false
                      )
                    }
                  />
                </label>
                <label className="flex flex-col">
                  <span>Rotate ({Math.round(selectedOverlay.rotationDeg ?? 0)}°)</span>
                  <input
                    type="range"
                    min={-45}
                    max={45}
                    step={1}
                    value={selectedOverlay.rotationDeg ?? 0}
                    onPointerDown={onBeginSlider}
                    onPointerUp={onEndSlider}
                    onBlur={onEndSlider}
                    onChange={(e) =>
                      onUpdateOverlays(
                        project.overlays.map((o) =>
                          o.id === selectedOverlay.id
                            ? { ...o, rotationDeg: Number(e.target.value) }
                            : o
                        ),
                        false
                      )
                    }
                  />
                </label>
              </div>
            </div>
          ) : (
            <p className="text-[11px] text-slate-500">
              Tap <strong>Add Text</strong> or <strong>Auto Captions</strong> to add text layers.
            </p>
          )}
        </section>
      )}

      {/* Stickers */}
      {showStickers && (
        <section className="flex flex-col gap-2 rounded-2xl border border-slate-800 bg-[#090b10] p-3">
          <h3 className="inline-flex items-center gap-1.5 text-xs font-bold text-slate-100">
            <Sticker className="size-3.5 text-emerald-400" aria-hidden="true" />
            Stickers (tap to add @ {currentTime.toFixed(1)}s)
          </h3>

          <div className="grid grid-cols-3 gap-1.5">
            {STICKER_CATALOG.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  const id = `stk-${Date.now().toString(36)}`;
                  const safeStart = Math.max(
                    0,
                    Math.min(Math.max(0, project.targetDurationSec - 1), currentTime)
                  );
                  const safeEnd = Math.min(
                    project.targetDurationSec,
                    Math.max(safeStart + 0.6, safeStart + 2.5)
                  );
                  onUpdateStickers([
                    ...(project.stickers || []),
                    {
                      id,
                      stickerId: item.id,
                      startSec: Number(safeStart.toFixed(2)),
                      endSec: Number(safeEnd.toFixed(2)),
                      xNorm: 0.5,
                      yNorm: 0.28,
                      scale: 1,
                      rotationDeg: 0,
                    },
                  ]);
                  onSelectSticker(id);
                }}
                className="flex flex-col items-center gap-1 rounded-xl border border-slate-800 bg-[#111520] p-2 hover:border-emerald-400"
              >
                <img
                  src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(item.svg)}`}
                  alt={item.label}
                  className="size-8 object-contain"
                />
                <span className="truncate text-[10px] text-slate-300">{item.label}</span>
              </button>
            ))}
          </div>

          {assets.some((a) => a.kind === "image") && (
            <div className="flex flex-col gap-1.5 pt-1">
              <span className="text-[11px] font-semibold text-slate-400">
                Custom Logo / Image Stickers
              </span>
              <div className="grid grid-cols-3 gap-1.5">
                {assets
                  .filter((a) => a.kind === "image")
                  .slice(0, 9)
                  .map((imgAsset) => (
                    <button
                      key={imgAsset.id}
                      type="button"
                      onClick={() => {
                        const id = `stk-${Date.now().toString(36)}`;
                        const safeStart = Math.max(
                          0,
                          Math.min(Math.max(0, project.targetDurationSec - 1), currentTime)
                        );
                        const safeEnd = Math.min(
                          project.targetDurationSec,
                          Math.max(safeStart + 0.6, safeStart + 3.0)
                        );
                        onUpdateStickers([
                          ...(project.stickers || []),
                          {
                            id,
                            stickerId: "custom-image",
                            assetId: imgAsset.id,
                            startSec: Number(safeStart.toFixed(2)),
                            endSec: Number(safeEnd.toFixed(2)),
                            xNorm: 0.5,
                            yNorm: 0.28,
                            scale: 1,
                            rotationDeg: 0,
                          },
                        ]);
                        onSelectSticker(id);
                      }}
                      className="flex flex-col items-center gap-1 rounded-xl border border-slate-800 bg-[#111520] p-1.5 hover:border-emerald-400"
                    >
                      <img
                        src={imgAsset.thumbnailUrl ?? imgAsset.url}
                        alt={imgAsset.originalName}
                        className="size-8 rounded object-contain"
                      />
                      <span className="w-full truncate text-[10px] text-slate-300">
                        {imgAsset.originalName}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          )}

          {selectedSticker && (
            <div className="flex flex-col gap-1.5 rounded-xl border border-emerald-500/40 bg-[#111520] p-2.5">
              <div className="flex items-center justify-between">
                <span className="truncate font-bold text-emerald-200">
                  Sticker:{" "}
                  {selectedSticker.assetId
                    ? (assetsById.get(selectedSticker.assetId)?.originalName ?? "Image")
                    : selectedSticker.stickerId}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    onUpdateStickers(
                      (project.stickers || []).filter((s) => s.id !== selectedSticker.id)
                    );
                    onSelectSticker(null);
                  }}
                  aria-label="Delete sticker"
                  className="text-rose-300 hover:text-rose-400"
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </button>
              </div>
              <label className="flex flex-col text-[11px] text-slate-400">
                <span>Sticker Size ({selectedSticker.scale.toFixed(2)}x)</span>
                <input
                  type="range"
                  min={0.4}
                  max={2.2}
                  step={0.05}
                  value={selectedSticker.scale}
                  onPointerDown={onBeginSlider}
                  onPointerUp={onEndSlider}
                  onBlur={onEndSlider}
                  onChange={(e) =>
                    onUpdateStickers(
                      (project.stickers || []).map((s) =>
                        s.id === selectedSticker.id ? { ...s, scale: Number(e.target.value) } : s
                      ),
                      false
                    )
                  }
                />
              </label>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
