import { useEffect, useState } from "react";
import { Film, Sparkles, X } from "lucide-react";
import {
  buildProjectFromTemplate,
  type CutProject,
  type CutTemplatePreset,
  type MediaAsset,
} from "@cutflow/shared";
import { useDialogModal } from "../hooks/useDialogModal";

interface TemplateStudioModalProps {
  open: boolean;
  template: CutTemplatePreset | null;
  assets: MediaAsset[];
  selectedAudioId?: string;
  onClose: () => void;
  onApplyProject: (project: CutProject) => void;
}

export function TemplateStudioModal({
  open,
  template,
  assets,
  selectedAudioId,
  onClose,
  onApplyProject,
}: TemplateStudioModalProps) {
  const dialogRef = useDialogModal(open && Boolean(template), onClose);
  const visuals = assets.filter((a) => a.kind !== "audio");

  const [slotAssets, setSlotAssets] = useState<string[]>([]);
  const [textDrafts, setTextDrafts] = useState<string[]>([]);
  const [audioId, setAudioId] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!template || !open) return;
    const bpCount = Math.max(2, template.slots.length);
    setSlotAssets(
      Array.from({ length: bpCount }, (_, i) => visuals[i % Math.max(1, visuals.length)]?.id ?? "")
    );
    const initialTexts =
      template.overlays.length > 0
        ? template.overlays.map((o) => o.text)
        : [template.defaultHookText];
    setTextDrafts(initialTexts);
    setAudioId(template.defaultAudioId || selectedAudioId);
  }, [template, open]);

  if (!template) return null;

  const blueprints =
    template.slots.length > 0
      ? template.slots
      : [
          { durationSec: 2, motion: "zoom-in" as const, transitionIn: "cut" as const, transitionDurationSec: 0, filter: template.filter, speed: 1, label: "Clip 1" },
          { durationSec: 2, motion: "punch-zoom" as const, transitionIn: "crossfade" as const, transitionDurationSec: 0.3, filter: template.filter, speed: 1, label: "Clip 2" },
        ];

  const handleApply = () => {
    const assetsMap = new Map(assets.map((a) => [a.id, a]));
    const project = buildProjectFromTemplate({
      template,
      slotAssetIds: slotAssets.filter(Boolean),
      assetsById: assetsMap,
      audioAsset: audioId ? assetsMap.get(audioId) : undefined,
      customTexts: textDrafts,
      projectId: crypto.randomUUID(),
    });
    onApplyProject(project);
    dialogRef.current?.close();
  };

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby="template-use-title"
      className="m-auto w-[calc(100vw-2rem)] max-w-lg rounded-2xl border border-slate-700/80 p-5 shadow-2xl"
    >
      <div className="flex items-center justify-between gap-3 pb-3">
        <div>
          <h2 id="template-use-title" className="text-base font-bold text-slate-100">
            Use Template: {template.name}
          </h2>
          <p className="text-xs text-slate-400">
            {blueprints.length} editable slots · {template.defaultAspectRatio} · {template.bpm} BPM
          </p>
        </div>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Close template studio"
          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {visuals.length === 0 ? (
        <p className="rounded-xl bg-[#090b10] p-4 text-xs text-slate-300">
          Upload video/photo clips or load Demo Clips first so you can assign them into template slots.
        </p>
      ) : (
        <div className="flex max-h-[65dvh] flex-col gap-3 overflow-y-auto pr-1 text-xs">
          <div className="flex flex-col gap-2">
            <span className="font-bold text-slate-200">Assign Clips to Template Slots</span>
            {blueprints.map((bp, idx) => (
              <div
                key={idx}
                className="flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#090b10] p-2.5"
              >
                <div className="min-w-0">
                  <div className="font-bold text-slate-100">
                    #{idx + 1} {bp.label}
                  </div>
                  <div className="text-[10px] text-slate-400">
                    {bp.durationSec}s · {bp.motion} · {bp.transitionIn}
                  </div>
                </div>

                <select
                  aria-label={`Select clip for slot ${idx + 1}`}
                  value={slotAssets[idx] ?? visuals[0]?.id ?? ""}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSlotAssets((prev) => prev.map((item, i) => (i === idx ? val : item)));
                  }}
                  className="max-w-[180px] rounded-lg border border-slate-700 bg-[#111520] px-2 py-1.5 text-xs text-slate-100"
                >
                  {visuals.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.originalName}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="font-bold text-slate-200">Edit Template Text</span>
            {textDrafts.map((txt, idx) => (
              <input
                key={idx}
                type="text"
                value={txt}
                aria-label={`Template text ${idx + 1}`}
                onChange={(e) => {
                  const val = e.target.value;
                  setTextDrafts((prev) => prev.map((t, i) => (i === idx ? val : t)));
                }}
                className="rounded-xl border border-slate-700 bg-[#090b10] px-3 py-2 text-xs text-slate-100"
              />
            ))}
          </div>

          <label className="flex flex-col gap-1">
            <span className="font-bold text-slate-200">Template Music</span>
            <select
              value={audioId ?? ""}
              onChange={(e) => setAudioId(e.target.value || undefined)}
              className="rounded-xl border border-slate-700 bg-[#090b10] px-3 py-2 text-xs text-slate-100"
            >
              <option value="">No music</option>
              {assets
                .filter((a) => a.kind === "audio" && a.audioCategory !== "sfx")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.originalName}
                  </option>
                ))}
            </select>
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={() => dialogRef.current?.close()}
              className="rounded-xl border border-slate-700 px-3.5 py-2 font-semibold text-slate-300"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleApply}
              className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-cyan-400 to-blue-500 px-4 py-2 font-bold text-slate-950"
            >
              <Film className="size-4" aria-hidden="true" />
              <span>Open in Editor</span>
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
}
