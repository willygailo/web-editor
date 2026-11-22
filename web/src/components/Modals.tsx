import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Download, Share2, X } from "lucide-react";
import type { CutProject, HealthResponse, RenderJob } from "@cutflow/shared";
import { startRender, subscribeRenderEvents } from "../api/client";
import { useDialogModal } from "../hooks/useDialogModal";

interface ExportModalProps {
  open: boolean;
  onClose: () => void;
  project: CutProject | null;
}

export function ExportModal({ open, onClose, project }: ExportModalProps) {
  const dialogRef = useDialogModal(open, onClose);
  const [quality, setQuality] = useState<"720p" | "1080p">("1080p");
  const [job, setJob] = useState<RenderJob | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!open) {
      cleanupRef.current?.();
      cleanupRef.current = null;
      setJob(null);
      setErr(null);
    }
    return () => {
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [open]);

  const handleStart = async () => {
    if (!project) return;
    cleanupRef.current?.();
    cleanupRef.current = null;
    setErr(null);

    const sanitizedProject: CutProject = {
      ...project,
      overlays: project.overlays
        .map((o) => ({ ...o, text: o.text.trim() }))
        .filter((o) => o.text.length > 0),
    };

    try {
      const created = await startRender({ project: sanitizedProject, quality });
      setJob(created);

      let settled = false;
      let pollTimer: number | null = null;

      const stopAll = () => {
        if (pollTimer !== null) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
        unsub();
      };

      const startPollFallback = () => {
        if (settled || pollTimer !== null) return;
        pollTimer = window.setInterval(async () => {
          try {
            const res = await fetch(`/api/render/${encodeURIComponent(created.id)}`);
            if (!res.ok) return;
            const data = (await res.json()) as { job: RenderJob };
            setJob(data.job);
            if (data.job.status === "completed" || data.job.status === "failed") {
              settled = true;
              stopAll();
            }
          } catch {
            // keep retrying briefly
          }
        }, 900);
      };

      const unsub = subscribeRenderEvents(
        created.id,
        (updated) => {
          setJob(updated);
          if (updated.status === "completed" || updated.status === "failed") {
            settled = true;
            stopAll();
          }
        },
        () => {
          startPollFallback();
        }
      );

      cleanupRef.current = () => {
        settled = true;
        if (pollTimer !== null) {
          window.clearInterval(pollTimer);
          pollTimer = null;
        }
        unsub();
      };
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to start export");
    }
  };

  const handleNativeShare = async () => {
    if (!job?.outputUrl || !navigator.share) return;
    try {
      await navigator.share({
        title: project?.title || "CutFlow AI Video",
        url: window.location.origin + job.outputUrl,
      });
    } catch {
      // user cancelled share
    }
  };

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby="export-dialog-title"
      className="m-auto w-[calc(100vw-2rem)] max-w-md rounded-2xl border border-slate-700/80 p-5 shadow-2xl"
    >
      <div className="flex items-center justify-between gap-3 pb-3">
        <h2 id="export-dialog-title" className="text-base font-bold text-slate-100">
          Export MP4 Video
        </h2>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Close export dialog"
          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      {!project ? (
        <p className="text-sm text-slate-400">Create an edit or apply a template first before exporting.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-slate-800 bg-[#090b10] p-3 text-xs text-slate-300">
            <div>
              <strong>Project:</strong> {project.title}
            </div>
            <div>
              <strong>Format:</strong> {project.aspectRatio} · {project.clips.length} clips
            </div>
          </div>

          <div className="flex gap-2">
            {(["720p", "1080p"] as const).map((q) => (
              <button
                key={q}
                type="button"
                disabled={job?.status === "rendering"}
                onClick={() => setQuality(q)}
                className={`flex-1 rounded-xl border px-3 py-2 text-xs font-bold transition ${
                  quality === q
                    ? "border-cyan-400 bg-cyan-500/15 text-cyan-200"
                    : "border-slate-800 bg-[#090b10] text-slate-400"
                }`}
              >
                {q === "1080p" ? "1080p Full HD" : "720p Fast Mobile"}
              </button>
            ))}
          </div>

          {err && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-2.5 text-xs text-rose-200">
              {err}
            </div>
          )}

          {job && (
            <div className="flex flex-col gap-2 rounded-xl border border-slate-800 bg-[#090b10] p-3">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-200">{job.stage}</span>
                <span className="font-mono text-cyan-300">{job.progress}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                <div
                  className={`h-full transition-all ${
                    job.status === "failed" ? "bg-rose-500" : "bg-cyan-400"
                  }`}
                  style={{ width: `${job.progress}%` }}
                />
              </div>
              {job.status === "failed" && job.error && (
                <p className="text-[11px] text-rose-300">{job.error}</p>
              )}
            </div>
          )}

          {job?.status === "completed" && job.outputUrl ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-xs font-semibold text-emerald-300">
                <CheckCircle2 className="size-4" aria-hidden="true" />
                <span>Rendered cleanly via FFmpeg!</span>
              </div>
              <div className="flex gap-2">
                <a
                  href={job.outputUrl}
                  download
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-bold text-slate-950 hover:brightness-110"
                >
                  <Download className="size-4" aria-hidden="true" />
                  Download MP4
                </a>
                {"share" in navigator && (
                  <button
                    type="button"
                    onClick={handleNativeShare}
                    className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-slate-700 bg-[#181e2d] px-3.5 py-2.5 text-xs font-semibold text-slate-200"
                  >
                    <Share2 className="size-4" aria-hidden="true" />
                    Share
                  </button>
                )}
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleStart}
              disabled={job?.status === "rendering" || job?.status === "queued"}
              className="w-full rounded-xl bg-gradient-to-r from-cyan-400 to-blue-500 px-4 py-2.5 text-sm font-bold text-slate-950 transition hover:brightness-110 disabled:opacity-50"
            >
              {job?.status === "rendering" ? "Rendering MP4..." : "Start FFmpeg Export"}
            </button>
          )}
        </div>
      )}
    </dialog>
  );
}

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  anthropicKey: string;
  anthropicWorkspaceId: string;
  geminiKey: string;
  onSaveKeys: (keys: {
    anthropicKey: string;
    anthropicWorkspaceId: string;
    geminiKey: string;
  }) => void;
  health: HealthResponse | null;
}

export function SettingsModal({
  open,
  onClose,
  anthropicKey,
  anthropicWorkspaceId,
  geminiKey,
  onSaveKeys,
  health,
}: SettingsModalProps) {
  const dialogRef = useDialogModal(open, onClose);
  const [draftAnthropic, setDraftAnthropic] = useState(anthropicKey);
  const [draftWorkspace, setDraftWorkspace] = useState(anthropicWorkspaceId);
  const [draftGemini, setDraftGemini] = useState(geminiKey);

  useEffect(() => {
    setDraftAnthropic(anthropicKey);
    setDraftWorkspace(anthropicWorkspaceId);
    setDraftGemini(geminiKey);
  }, [anthropicKey, anthropicWorkspaceId, geminiKey, open]);

  return (
    <dialog
      ref={dialogRef}
      closedby="any"
      aria-labelledby="settings-dialog-title"
      className="m-auto w-[calc(100vw-2rem)] max-w-md rounded-2xl border border-slate-700/80 p-5 shadow-2xl"
    >
      <div className="flex items-center justify-between gap-3 pb-3">
        <h2 id="settings-dialog-title" className="text-base font-bold text-slate-100">
          AI & Server Settings
        </h2>
        <button
          type="button"
          onClick={() => dialogRef.current?.close()}
          aria-label="Close settings dialog"
          className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 hover:text-white"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      </div>

      <div className="flex flex-col gap-3.5 text-xs">
        <div className="rounded-xl border border-slate-800 bg-[#090b10] p-3 text-slate-300">
          <div className="flex justify-between py-0.5">
            <span>Server FFmpeg Engine</span>
            <span className={health?.ffmpegAvailable ? "text-emerald-400" : "text-rose-400"}>
              {health?.ffmpegAvailable ? "Ready" : "Unavailable"}
            </span>
          </div>
          <div className="flex justify-between py-0.5">
            <span>Claude ({health?.anthropicModel || "claude-sonnet-5-5"})</span>
            <span className={health?.anthropicConfigured ? "text-emerald-400" : "text-amber-300"}>
              {health?.anthropicConfigured ? "Configured in .env" : "Not set"}
            </span>
          </div>
          <div className="flex justify-between py-0.5">
            <span>Gemini ({health?.geminiModel || "gemini-4-hydrogen"})</span>
            <span className={health?.geminiConfigured ? "text-emerald-400" : "text-amber-300"}>
              {health?.geminiConfigured ? "Configured in .env" : "Not set"}
            </span>
          </div>
        </div>

        <label className="flex flex-col gap-1">
          <span className="font-semibold text-slate-200">
            Optional Browser Anthropic Key (Claude Sonnet 5.5)
          </span>
          <input
            type="password"
            value={draftAnthropic}
            onChange={(e) => setDraftAnthropic(e.target.value)}
            placeholder="sk-ant-api03-... or sk-ant-usr-..."
            className="rounded-xl border border-slate-700 bg-[#090b10] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-semibold text-slate-200">
            Optional Anthropic Workspace ID (for sk-ant-usr- keys)
          </span>
          <input
            type="text"
            value={draftWorkspace}
            onChange={(e) => setDraftWorkspace(e.target.value)}
            placeholder="wrkspc_... (auto-detected if blank)"
            className="rounded-xl border border-slate-700 bg-[#090b10] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-semibold text-slate-200">
            Optional Browser Gemini API Key
          </span>
          <input
            type="password"
            value={draftGemini}
            onChange={(e) => setDraftGemini(e.target.value)}
            placeholder="AIza... (stored only in your browser)"
            className="rounded-xl border border-slate-700 bg-[#090b10] px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500"
          />
          <span className="text-[11px] text-slate-400">
            Leave blank to use server `.env` or built-in Offline Smart Auto-Edit.
          </span>
        </label>

        <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/10 p-3 text-[11px] text-cyan-200">
          <strong>Phone & Laptop Tip:</strong> Open this same network URL on your phone browser and choose{" "}
          <em>Add to Home Screen</em> to install CutFlow AI as a PWA!
        </div>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={() => dialogRef.current?.close()}
            className="rounded-xl border border-slate-700 px-3.5 py-2 font-semibold text-slate-300"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              onSaveKeys({
                anthropicKey: draftAnthropic.trim(),
                anthropicWorkspaceId: draftWorkspace.trim(),
                geminiKey: draftGemini.trim(),
              });
              dialogRef.current?.close();
            }}
            className="rounded-xl bg-cyan-400 px-4 py-2 font-bold text-slate-950"
          >
            Save
          </button>
        </div>
      </div>
    </dialog>
  );
}
