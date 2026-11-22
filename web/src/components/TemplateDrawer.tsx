import { useState } from "react";
import { BookmarkPlus, Download, Layers, Sparkles, Trash2, Upload } from "lucide-react";
import {
  CutProjectSchema,
  extractTemplateFromProject,
  type CutProject,
  type CutTemplatePreset,
} from "@cutflow/shared";

interface TemplateDrawerProps {
  templates: CutTemplatePreset[];
  activeTemplateId?: string;
  project: CutProject | null;
  onUseTemplateModal: (preset: CutTemplatePreset) => void;
  onAutoFillTemplate: (preset: CutTemplatePreset) => void;
  onSaveCurrentAsTemplate: (name: string, tagline: string) => Promise<void>;
  onDeleteCustomTemplate: (id: string) => Promise<void>;
  onImportProjectJson: (project: CutProject) => void;
  disabled: boolean;
}

export function TemplateDrawer({
  templates,
  activeTemplateId,
  project,
  onUseTemplateModal,
  onAutoFillTemplate,
  onSaveCurrentAsTemplate,
  onDeleteCustomTemplate,
  onImportProjectJson,
  disabled,
}: TemplateDrawerProps) {
  const [tplName, setTplName] = useState("");
  const [saving, setSaving] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!project) return;
    setSaving(true);
    try {
      await onSaveCurrentAsTemplate(
        tplName.trim() || `${project.title} Template`,
        `Saved ${project.clips.length}-slot ${project.aspectRatio} cut template`
      );
      setTplName("");
    } finally {
      setSaving(false);
    }
  };

  const handleExportJson = () => {
    if (!project) return;
    const recipe = extractTemplateFromProject(project, project.title);
    const blob = new Blob([JSON.stringify({ project, template: recipe }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "cutflow"}.cutflow.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-col gap-3 text-xs">
      {project && (
        <section className="flex flex-col gap-2 rounded-2xl border border-cyan-500/35 bg-[#090b10] p-3">
          <div className="flex items-center justify-between gap-2 font-bold text-cyan-200">
            <span className="inline-flex items-center gap-1.5">
              <BookmarkPlus className="size-3.5" aria-hidden="true" />
              Save Edit as Reusable Template
            </span>
          </div>
          <div className="flex gap-1.5">
            <input
              type="text"
              value={tplName}
              onChange={(e) => setTplName(e.target.value)}
              placeholder="Template name (e.g. My TikTok Beat)"
              aria-label="Custom template name"
              className="min-w-0 flex-1 rounded-xl border border-slate-700 bg-[#111520] px-2.5 py-1.5 text-xs text-slate-100"
            />
            <button
              type="button"
              disabled={saving}
              onClick={() => void handleSave()}
              className="shrink-0 rounded-xl bg-cyan-400 px-3 py-1.5 font-bold text-slate-950 hover:brightness-110 disabled:opacity-50"
            >
              {saving ? "Saving..." : "Save"}
            </button>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleExportJson}
              className="inline-flex flex-1 items-center justify-center gap-1 rounded-lg border border-slate-700 bg-[#111520] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-cyan-400"
            >
              <Download className="size-3" aria-hidden="true" />
              Export .cutflow.json
            </button>
            <label className="inline-flex flex-1 cursor-pointer items-center justify-center gap-1 rounded-lg border border-slate-700 bg-[#111520] px-2.5 py-1 text-[11px] font-medium text-slate-300 hover:border-cyan-400">
              <Upload className="size-3" aria-hidden="true" />
              <span>Import JSON</span>
              <input
                type="file"
                accept=".json,application/json"
                className="hidden"
                onChange={async (e) => {
                  setImportError(null);
                  const file = e.target.files?.[0];
                  if (!file) return;
                  try {
                    const text = await file.text();
                    const raw = JSON.parse(text) as { project?: unknown };
                    const parsed = CutProjectSchema.safeParse(raw.project ?? raw);
                    if (parsed.success) {
                      onImportProjectJson(parsed.data);
                    } else {
                      setImportError("Invalid .cutflow.json template structure.");
                    }
                  } catch {
                    setImportError("Unable to parse JSON file.");
                  }
                  e.target.value = "";
                }}
              />
            </label>
          </div>
          {importError && (
            <p className="text-[11px] text-rose-300">{importError}</p>
          )}
        </section>
      )}

      {templates.map((tpl) => {
        const active = tpl.id === activeTemplateId;
        const slotCount = tpl.slots?.length || 3;
        return (
          <div
            key={tpl.id}
            className={`flex flex-col gap-2 rounded-2xl border p-3 transition ${
              active
                ? "border-cyan-400 bg-cyan-500/10"
                : "border-slate-800 bg-[#090b10]"
            }`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-bold text-slate-100">{tpl.name}</span>
              <div className="flex items-center gap-1">
                <span
                  className="rounded-full px-2 py-0.5 text-[10px] font-bold text-slate-950"
                  style={{ backgroundColor: tpl.accentColor }}
                >
                  {tpl.badge}
                </span>
                {tpl.isCustom && (
                  <button
                    type="button"
                    onClick={() => void onDeleteCustomTemplate(tpl.id)}
                    aria-label={`Delete custom template ${tpl.name}`}
                    className="rounded-lg p-1 text-slate-400 hover:text-rose-400"
                  >
                    <Trash2 className="size-3.5" aria-hidden="true" />
                  </button>
                )}
              </div>
            </div>
            <p className="text-xs text-slate-400">{tpl.tagline}</p>
            <div className="text-[11px] text-slate-400">
              {slotCount} slots · {tpl.defaultAspectRatio} · {tpl.defaultDurationSec}s · {tpl.bpm} BPM
            </div>
            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => onUseTemplateModal(tpl)}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded-xl border border-cyan-400/50 bg-cyan-500/15 px-3 py-1.5 text-[11px] font-bold text-cyan-200 hover:bg-cyan-500/25"
              >
                <Layers className="size-3.5" aria-hidden="true" />
                Use Template
              </button>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onAutoFillTemplate(tpl)}
                className="inline-flex items-center justify-center gap-1 rounded-xl border border-slate-700 bg-[#111520] px-2.5 py-1.5 text-[11px] font-semibold text-slate-200 hover:border-rose-400 disabled:opacity-45"
              >
                <Sparkles className="size-3 text-rose-400" aria-hidden="true" />
                AI Fill
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
