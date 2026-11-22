import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Film,
  LayoutTemplate,
  Scissors,
  Settings,
  SlidersHorizontal,
  Sparkles,
} from "lucide-react";
import {
  computeTimelineLayout,
  CUT_TEMPLATE_PRESETS,
  type AspectRatio,
  type ClipSlot,
  type CutProject,
  type CutTemplatePreset,
  type HealthResponse,
  type MediaAsset,
  type TextOverlay,
} from "@cutflow/shared";
import {
  deleteMedia,
  fetchHealth,
  fetchMedia,
  loadSamplePack,
  runAutoEdit,
  uploadMediaFiles,
} from "./api/client";
import { MediaBin } from "./components/MediaBin";
import { ExportModal, SettingsModal } from "./components/Modals";
import { PreviewStage } from "./components/PreviewStage";
import { PromptBar, type AiMode } from "./components/PromptBar";
import { SlotInspector } from "./components/SlotInspector";
import { TemplateDrawer } from "./components/TemplateDrawer";
import { TimelineBar } from "./components/TimelineBar";

type MobileTab = "clips" | "templates" | "timeline" | "inspector";
type DesktopLeftTab = "clips" | "templates";

const MOBILE_TABS: Array<{ id: MobileTab; label: string }> = [
  { id: "clips", label: "Clips" },
  { id: "templates", label: "Templates" },
  { id: "timeline", label: "Timeline" },
  { id: "inspector", label: "Inspector" },
];

export function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [selectedVisualIds, setSelectedVisualIds] = useState<string[]>([]);
  const [selectedAudioId, setSelectedAudioId] = useState<string | undefined>(undefined);
  const [templates] = useState<CutTemplatePreset[]>(CUT_TEMPLATE_PRESETS);

  const [prompt, setPrompt] = useState("Gawa ka ng hype 15s TikTok edit with smooth zoom");
  const [mode, setMode] = useState<AiMode>("auto");
  const [project, setProject] = useState<CutProject | null>(null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [mobileTab, setMobileTab] = useState<MobileTab>("clips");
  const [desktopLeftTab, setDesktopLeftTab] = useState<DesktopLeftTab>("clips");

  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isLoadingDemo, setIsLoadingDemo] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [anthropicKey, setAnthropicKey] = useState<string>(() => {
    try {
      return localStorage.getItem("cutflow_anthropic_key") ?? "";
    } catch {
      return "";
    }
  });
  const [anthropicWorkspaceId, setAnthropicWorkspaceId] = useState<string>(() => {
    try {
      return localStorage.getItem("cutflow_anthropic_workspace") ?? "";
    } catch {
      return "";
    }
  });
  const [geminiKey, setGeminiKey] = useState<string>(() => {
    try {
      return localStorage.getItem("cutflow_gemini_key") ?? "";
    } catch {
      return "";
    }
  });

  const quickFileInputRef = useRef<HTMLInputElement | null>(null);

  const assetsById = useMemo(
    () => new Map(assets.map((a) => [a.id, a])),
    [assets]
  );

  useEffect(() => {
    void (async () => {
      try {
        const [h, media] = await Promise.all([fetchHealth(), fetchMedia()]);
        setHealth(h);
        setAssets(media);
        const visuals = media.filter((m) => m.kind !== "audio").map((m) => m.id);
        if (visuals.length > 0) setSelectedVisualIds(visuals);
        const firstBeat = media.find((m) => m.kind === "audio");
        if (firstBeat) setSelectedAudioId(firstBeat.id);
      } catch (err) {
        setBannerError(err instanceof Error ? err.message : "Unable to reach API server.");
      }
    })();
  }, []);

  const handleSaveKeys = (keys: {
    anthropicKey: string;
    anthropicWorkspaceId: string;
    geminiKey: string;
  }) => {
    setAnthropicKey(keys.anthropicKey);
    setAnthropicWorkspaceId(keys.anthropicWorkspaceId);
    setGeminiKey(keys.geminiKey);
    try {
      if (keys.anthropicKey) localStorage.setItem("cutflow_anthropic_key", keys.anthropicKey);
      else localStorage.removeItem("cutflow_anthropic_key");

      if (keys.anthropicWorkspaceId) {
        localStorage.setItem("cutflow_anthropic_workspace", keys.anthropicWorkspaceId);
      } else {
        localStorage.removeItem("cutflow_anthropic_workspace");
      }

      if (keys.geminiKey) localStorage.setItem("cutflow_gemini_key", keys.geminiKey);
      else localStorage.removeItem("cutflow_gemini_key");
    } catch {
      // ignore storage errors
    }
  };

  const handleUploadFiles = async (files: File[]) => {
    setBannerError(null);
    setUploadProgress(5);
    try {
      const added = await uploadMediaFiles(files, (pct) => setUploadProgress(pct));
      setAssets((prev) => [...prev, ...added]);
      const addedVisuals = added.filter((a) => a.kind !== "audio").map((a) => a.id);
      if (addedVisuals.length > 0) {
        setSelectedVisualIds((prev) => Array.from(new Set([...prev, ...addedVisuals])));
      }
      const addedAudio = added.find((a) => a.kind === "audio");
      if (addedAudio) setSelectedAudioId(addedAudio.id);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploadProgress(null);
    }
  };

  const handleLoadDemo = async () => {
    setBannerError(null);
    setIsLoadingDemo(true);
    try {
      const demoClips = await loadSamplePack();
      setAssets((prev) => {
        const map = new Map(prev.map((a) => [a.id, a]));
        for (const c of demoClips) map.set(c.id, c);
        return Array.from(map.values());
      });
      setSelectedVisualIds((prev) =>
        Array.from(new Set([...prev, ...demoClips.map((c) => c.id)]))
      );
      if (!selectedAudioId) {
        const firstAudio = assets.find((a) => a.kind === "audio");
        if (firstAudio) setSelectedAudioId(firstAudio.id);
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Failed to load demo clips");
    } finally {
      setIsLoadingDemo(false);
    }
  };

  const handleDeleteAsset = async (id: string) => {
    try {
      await deleteMedia(id);
      setAssets((prev) => prev.filter((a) => a.id !== id));
      setSelectedVisualIds((prev) => prev.filter((vid) => vid !== id));
      if (selectedAudioId === id) setSelectedAudioId(undefined);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Delete failed");
    }
  };

  const triggerAutoEdit = async (
    overridePrompt?: string,
    templateOverride?: CutTemplatePreset
  ) => {
    if (selectedVisualIds.length === 0) {
      setBannerError("Select or upload at least 1 video/photo clip first.");
      return;
    }

    const activePrompt = (overridePrompt ?? prompt).trim();
    if (!activePrompt) return;

    setBannerError(null);
    setWarnings([]);
    setIsGenerating(true);
    setIsPlaying(false);

    try {
      const res = await runAutoEdit(
        {
          prompt: activePrompt,
          assetIds: selectedVisualIds,
          audioAssetId: selectedAudioId,
          templateId: templateOverride?.id,
          aspectRatio: templateOverride?.defaultAspectRatio ?? project?.aspectRatio,
          targetDurationSec: templateOverride?.defaultDurationSec,
          mode,
          previousProject: templateOverride ? undefined : project ?? undefined,
        },
        {
          anthropicApiKey: anthropicKey,
          anthropicWorkspaceId,
          geminiApiKey: geminiKey,
        }
      );
      setProject(res.project);
      setSelectedSlotId(res.project.clips[0]?.id ?? null);
      setCurrentTime(0);
      setWarnings(res.warnings);
      setIsPlaying(true);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Auto-edit failed");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleAspectChange = (aspectRatio: AspectRatio) => {
    if (!project) return;
    setProject({ ...project, aspectRatio });
  };

  const handleUpdateSlot = (slotId: string, patch: Partial<ClipSlot>) => {
    if (!project) return;
    const nextClips = project.clips.map((c) => (c.id === slotId ? { ...c, ...patch } : c));
    const layout = computeTimelineLayout({ clips: nextClips });
    setProject({
      ...project,
      clips: nextClips,
      targetDurationSec: layout.totalDurationSec,
    });
  };

  const handleDeleteSlot = (slotId: string) => {
    if (!project || project.clips.length <= 1) return;
    const nextClips = project.clips
      .filter((c) => c.id !== slotId)
      .map((c, idx) => (idx === 0 ? { ...c, transitionIn: "cut" as const, transitionDurationSec: 0 } : c));
    const layout = computeTimelineLayout({ clips: nextClips });
    setProject({
      ...project,
      clips: nextClips,
      targetDurationSec: layout.totalDurationSec,
    });
    setSelectedSlotId(nextClips[0]?.id ?? null);
    setCurrentTime(0);
  };

  const handleMoveSlot = (slotId: string, dir: -1 | 1) => {
    if (!project) return;
    const idx = project.clips.findIndex((c) => c.id === slotId);
    const targetIdx = idx + dir;
    if (idx === -1 || targetIdx < 0 || targetIdx >= project.clips.length) return;
    const copy = [...project.clips];
    const [item] = copy.splice(idx, 1);
    copy.splice(targetIdx, 0, item);
    const normalized = copy.map((c, i) =>
      i === 0 ? { ...c, transitionIn: "cut" as const, transitionDurationSec: 0 } : c
    );
    const layout = computeTimelineLayout({ clips: normalized });
    setProject({
      ...project,
      clips: normalized,
      targetDurationSec: layout.totalDurationSec,
    });
  };

  const handleUpdateOverlays = (overlays: TextOverlay[]) => {
    if (!project) return;
    setProject({ ...project, overlays });
  };

  const handleTimeChange = useCallback((t: number) => {
    setCurrentTime(t);
  }, []);

  return (
    <div className="flex min-h-dvh flex-col bg-[#090b10] text-slate-100">
      <input
        ref={quickFileInputRef}
        type="file"
        multiple
        accept="video/*,image/*,audio/*"
        className="hidden"
        onChange={(e) => {
          const list = e.target.files ? Array.from(e.target.files) : [];
          if (list.length > 0) void handleUploadFiles(list);
          e.target.value = "";
        }}
      />

      {/* Top Studio Bar */}
      <header className="safe-top flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/90 bg-[#0d111a]/95 px-3 py-2 backdrop-blur sm:px-4">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-rose-500 text-slate-950 shadow">
            <Scissors className="size-4" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-sm font-extrabold tracking-tight text-white">CutFlow AI</h1>
            <p className="hidden text-[11px] text-slate-400 sm:block">
              Auto Cut Templates · Phone & Laptop
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          {project && (
            <div
              role="group"
              aria-label="Aspect ratio"
              className="flex items-center rounded-xl border border-slate-800 bg-[#090b10] p-0.5 text-[11px] font-bold"
            >
              {(["9:16", "16:9", "1:1"] as AspectRatio[]).map((ratio) => (
                <button
                  key={ratio}
                  type="button"
                  onClick={() => handleAspectChange(ratio)}
                  className={`rounded-lg px-2 py-1 transition ${
                    project.aspectRatio === ratio
                      ? "bg-cyan-400 text-slate-950"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  {ratio}
                </button>
              ))}
            </div>
          )}

          <button
            type="button"
            onClick={() => setSettingsOpen(true)}
            aria-label="Open AI and server settings"
            className="inline-flex items-center justify-center rounded-xl border border-slate-700/80 bg-[#111520] p-2 text-slate-300 hover:border-cyan-400 hover:text-white"
          >
            <Settings className="size-4" aria-hidden="true" />
          </button>

          <button
            type="button"
            disabled={!project}
            onClick={() => {
              setIsPlaying(false);
              setExportOpen(true);
            }}
            className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-rose-500 to-amber-400 px-3 py-2 text-xs font-extrabold text-slate-950 shadow transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Download className="size-4" aria-hidden="true" />
            <span>Export MP4</span>
          </button>
        </div>
      </header>

      {(bannerError || warnings.length > 0) && (
        <div className="flex flex-col gap-1 border-b border-slate-800 bg-[#111520] px-3 py-2 text-xs">
          {bannerError && (
            <div className="flex items-center justify-between gap-2 text-rose-300">
              <span>{bannerError}</span>
              <button
                type="button"
                onClick={() => setBannerError(null)}
                className="font-bold text-slate-400 hover:text-white"
              >
                Dismiss
              </button>
            </div>
          )}
          {warnings.map((w, idx) => (
            <div key={idx} className="text-amber-300">
              {w}
            </div>
          ))}
        </div>
      )}

      {/* Adaptive Phone + Laptop Workspace Grid */}
      <main className="safe-bottom grid flex-1 grid-cols-1 gap-3 p-2.5 sm:p-3 lg:grid-cols-[340px_minmax(0,1fr)_320px] lg:grid-rows-[minmax(0,1fr)_auto]">
        {/* Left Pane (Desktop: Media & Templates; Mobile: Clips or Templates tab) */}
        <aside
          className={`flex flex-col gap-2.5 overflow-y-auto rounded-2xl border border-slate-800/80 bg-[#111520] p-3 lg:max-h-[calc(100dvh-16rem)] ${
            mobileTab === "clips" || mobileTab === "templates" ? "block" : "hidden lg:flex"
          }`}
        >
          {/* Desktop Left Switcher */}
          <div
            role="tablist"
            aria-label="Media and templates"
            className="studio-tablist hidden border-b border-slate-800 pb-1 lg:flex"
          >
            <button
              type="button"
              role="tab"
              aria-selected={desktopLeftTab === "clips"}
              onClick={() => setDesktopLeftTab("clips")}
              className="studio-tab inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-slate-300"
            >
              <Film className="size-3.5" aria-hidden="true" />
              Clips & Audio
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={desktopLeftTab === "templates"}
              onClick={() => setDesktopLeftTab("templates")}
              className="studio-tab inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-slate-300"
            >
              <LayoutTemplate className="size-3.5" aria-hidden="true" />
              Cut Templates
            </button>
          </div>

          <div
            className={
              mobileTab === "clips"
                ? "block lg:hidden"
                : "hidden"
            }
          >
            <MediaBin
              assets={assets}
              selectedVisualIds={selectedVisualIds}
              selectedAudioId={selectedAudioId}
              onToggleVisual={(id) =>
                setSelectedVisualIds((prev) =>
                  prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                )
              }
              onSelectAudio={setSelectedAudioId}
              onUploadFiles={handleUploadFiles}
              onLoadSamplePack={handleLoadDemo}
              onDeleteAsset={handleDeleteAsset}
              uploadProgress={uploadProgress}
              isLoadingSample={isLoadingDemo}
            />
          </div>

          <div
            className={
              mobileTab === "templates"
                ? "block lg:hidden"
                : "hidden"
            }
          >
            <TemplateDrawer
              templates={templates}
              activeTemplateId={project?.templateId}
              disabled={selectedVisualIds.length === 0 || isGenerating}
              onApplyTemplate={(tpl) => {
                const nextPrompt = `${tpl.name}: ${tpl.tagline}`;
                setPrompt(nextPrompt);
                void triggerAutoEdit(nextPrompt, tpl);
              }}
            />
          </div>

          <div className="hidden lg:block">
            {desktopLeftTab === "clips" ? (
              <MediaBin
                assets={assets}
                selectedVisualIds={selectedVisualIds}
                selectedAudioId={selectedAudioId}
                onToggleVisual={(id) =>
                  setSelectedVisualIds((prev) =>
                    prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                  )
                }
                onSelectAudio={setSelectedAudioId}
                onUploadFiles={handleUploadFiles}
                onLoadSamplePack={handleLoadDemo}
                onDeleteAsset={handleDeleteAsset}
                uploadProgress={uploadProgress}
                isLoadingSample={isLoadingDemo}
              />
            ) : (
              <TemplateDrawer
                templates={templates}
                activeTemplateId={project?.templateId}
                disabled={selectedVisualIds.length === 0 || isGenerating}
                onApplyTemplate={(tpl) => {
                  const nextPrompt = `${tpl.name}: ${tpl.tagline}`;
                  setPrompt(nextPrompt);
                  void triggerAutoEdit(nextPrompt, tpl);
                }}
              />
            )}
          </div>
        </aside>

        {/* Center Stage: Preview + AI Prompt + Mobile Tab Switcher */}
        <section className="order-first flex min-w-0 flex-col gap-2.5 lg:order-none">
          <PreviewStage
            project={project}
            assetsById={assetsById}
            currentTime={currentTime}
            isPlaying={isPlaying}
            onTimeChange={handleTimeChange}
            onPlayingChange={setIsPlaying}
            onLoadDemo={handleLoadDemo}
            onQuickUpload={() => quickFileInputRef.current?.click()}
            isLoadingDemo={isLoadingDemo}
          />

          <PromptBar
            prompt={prompt}
            onPromptChange={setPrompt}
            onSubmit={(override) => void triggerAutoEdit(override)}
            isGenerating={isGenerating}
            disabled={selectedVisualIds.length === 0}
            mode={mode}
            onModeChange={setMode}
            hasProject={Boolean(project)}
          />

          {/* Mobile Single-Row Accessible Tablist */}
          <div
            role="tablist"
            aria-label="Mobile studio panels"
            className="studio-tablist rounded-2xl border border-slate-800/80 bg-[#111520] px-2 pt-1 lg:hidden"
            onKeyDown={(e) => {
              const idx = MOBILE_TABS.findIndex((t) => t.id === mobileTab);
              if (e.key === "ArrowRight") {
                const next = MOBILE_TABS[(idx + 1) % MOBILE_TABS.length];
                setMobileTab(next.id);
              } else if (e.key === "ArrowLeft") {
                const prev = MOBILE_TABS[(idx - 1 + MOBILE_TABS.length) % MOBILE_TABS.length];
                setMobileTab(prev.id);
              }
            }}
          >
            {MOBILE_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={mobileTab === t.id}
                onClick={(e) => {
                  setMobileTab(t.id);
                  e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
                }}
                className="studio-tab px-3.5 py-2 text-xs font-bold text-slate-300"
              >
                {t.label}
              </button>
            ))}
          </div>
        </section>

        {/* Right Pane: Slot & Text Inspector */}
        <aside
          className={`overflow-y-auto rounded-2xl border border-slate-800/80 bg-[#111520] p-3 lg:max-h-[calc(100dvh-16rem)] ${
            mobileTab === "inspector" ? "block" : "hidden lg:block"
          }`}
        >
          <div className="mb-2.5 flex items-center gap-1.5 text-xs font-bold text-slate-200">
            <SlidersHorizontal className="size-3.5 text-cyan-400" aria-hidden="true" />
            <span>Slot & Overlay Inspector</span>
          </div>
          <SlotInspector
            project={project}
            selectedSlotId={selectedSlotId}
            assetsById={assetsById}
            onUpdateSlot={handleUpdateSlot}
            onDeleteSlot={handleDeleteSlot}
            onUpdateOverlays={handleUpdateOverlays}
          />
        </aside>

        {/* Bottom Pane: Visual Timeline */}
        <section
          className={`lg:col-span-3 ${
            mobileTab === "timeline" ? "block" : "hidden lg:block"
          }`}
        >
          <TimelineBar
            project={project}
            assetsById={assetsById}
            currentTime={currentTime}
            selectedSlotId={selectedSlotId}
            onSelectSlot={setSelectedSlotId}
            onSeek={(sec) => {
              setIsPlaying(false);
              setCurrentTime(sec);
            }}
            onMoveSlot={handleMoveSlot}
          />
        </section>
      </main>

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        project={project}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        anthropicKey={anthropicKey}
        anthropicWorkspaceId={anthropicWorkspaceId}
        geminiKey={geminiKey}
        onSaveKeys={handleSaveKeys}
        health={health}
      />

      {isGenerating && (
        <div
          aria-live="polite"
          className="fixed right-4 bottom-4 z-40 inline-flex items-center gap-2 rounded-full border border-cyan-400/50 bg-[#111520]/95 px-4 py-2 text-xs font-bold text-cyan-200 shadow-xl backdrop-blur"
        >
          <Sparkles className="size-4 animate-pulse text-cyan-400" aria-hidden="true" />
          <span>AI Director is cutting your template...</span>
        </div>
      )}
    </div>
  );
}
