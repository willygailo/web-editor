import { Sparkles } from "lucide-react";
import type { CutTemplatePreset } from "@cutflow/shared";

interface TemplateDrawerProps {
  templates: CutTemplatePreset[];
  activeTemplateId?: string;
  onApplyTemplate: (preset: CutTemplatePreset) => void;
  disabled: boolean;
}

export function TemplateDrawer({
  templates,
  activeTemplateId,
  onApplyTemplate,
  disabled,
}: TemplateDrawerProps) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="text-xs text-slate-400">
        Tap a CapCut-style cut template to auto-rearrange your selected clips & beat pacing.
      </p>
      {templates.map((tpl) => {
        const active = tpl.id === activeTemplateId;
        return (
          <button
            key={tpl.id}
            type="button"
            disabled={disabled}
            onClick={() => onApplyTemplate(tpl)}
            className={`flex flex-col gap-1.5 rounded-2xl border p-3 text-left transition disabled:opacity-50 ${
              active
                ? "border-cyan-400 bg-cyan-500/10"
                : "border-slate-800 bg-[#090b10] hover:border-slate-700"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold text-slate-100">{tpl.name}</span>
              <span
                className="rounded-full px-2 py-0.5 text-[10px] font-bold text-slate-950"
                style={{ backgroundColor: tpl.accentColor }}
              >
                {tpl.badge}
              </span>
            </div>
            <p className="text-xs text-slate-400">{tpl.tagline}</p>
            <div className="flex items-center justify-between pt-1 text-[11px] text-slate-400">
              <span>
                {tpl.defaultAspectRatio} · {tpl.defaultDurationSec}s · {tpl.bpm} BPM
              </span>
              <span className="inline-flex items-center gap-1 font-semibold text-cyan-300">
                <Sparkles className="size-3" aria-hidden="true" />
                Apply
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
