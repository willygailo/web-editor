import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Download,
  Film,
  LayoutTemplate,
  Music2,
  Redo2,
  Scissors,
  Settings,
  Sliders,
  Sparkles,
  Sticker,
  Type,
  Undo2,
} from "lucide-react";
import {
  CutProjectSchema,
  extractTemplateFromProject,
  getProjectAudioTracks,
  type AspectRatio,
  type AudioCategory,
  type CutProject,
  type CutTemplatePreset,
  type HealthResponse,
  type MediaAsset,
  type PlatformPreset,
} from "@cutflow/shared";

const PLATFORM_DEFAULT_ASPECT: Partial<Record<PlatformPreset, AspectRatio>> = {
  tiktok: "9:16",
  "instagram-reels": "9:16",
  "instagram-feed": "4:5",
  "youtube-shorts": "9:16",
  "youtube-landscape": "16:9",
  "promo-ad": "1:1",
};
import {
  deleteCustomTemplate,
  deleteMedia,
  extractAudioFromVideo,
  fetchHealth,
  fetchMedia,
  fetchTemplates,
  generateHiggsfieldMedia,
  importMediaFromUrl,
  loadSamplePack,
  polishMediaAudio,
  runAutoEdit,
  runTalkingHeadCut,
  saveCustomTemplate,
  transcribeMedia,
  uploadMediaFiles,
} from "./api/client";
import { AudioDrawer } from "./components/AudioDrawer";
import { MediaBin } from "./components/MediaBin";
import { ExportModal, SettingsModal } from "./components/Modals";
import { PreviewStage } from "./components/PreviewStage";
import { PromptBar, type AiMode } from "./components/PromptBar";
import { SlotInspector, type InspectorSection } from "./components/SlotInspector";
import { TemplateDrawer } from "./components/TemplateDrawer";
import { TemplateStudioModal } from "./components/TemplateStudioModal";
import { TimelineBar } from "./components/TimelineBar";
import { AUTOSAVE_STORAGE_KEY, useEditorStore } from "./state/useEditorStore";

type ToolPanel = "clips" | "audio" | "templates" | "ai" | "edit" | "adjust" | "text" | "stickers";

export function App() {
  const store = useEditorStore();
  const { project, selection } = store;

  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [assets, setAssets] = useState<MediaAsset[]>([]);
  const [selectedVisualIds, setSelectedVisualIds] = useState<string[]>([]);
  const [templates, setTemplates] = useState<CutTemplatePreset[]>([]);

  const [prompt, setPrompt] = useState("Gawa ka ng hype 15s TikTok edit with smooth zoom");
  const [mode, setMode] = useState<AiMode>("auto");
  const [platform, setPlatform] = useState<PlatformPreset>("auto");
  const [currentTime, setCurrentTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [mobilePanel, setMobilePanel] = useState<ToolPanel | null>("ai");
  const [desktopLeftTab, setDesktopLeftTab] = useState<"clips" | "audio" | "templates">("clips");
  const [pendingAudioId, setPendingAudioId] = useState<string | null>(null);

  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [isLoadingDemo, setIsLoadingDemo] = useState(false);
  const [isImportingUrl, setIsImportingUrl] = useState(false);
  const [isGeneratingHiggsfield, setIsGeneratingHiggsfield] = useState(false);
  const [polishingAssetId, setPolishingAssetId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isTalkingHeadCutting, setIsTalkingHeadCutting] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  const [templateModalTarget, setTemplateModalTarget] = useState<CutTemplatePreset | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const [anthropicKey, setAnthropicKey] = useState<string>(() => {
    try {
      return localStorage.getItem("cutflow_anthropic_key") ?? "";
    } catch {
      return "";
    }
  });
  const [anthropicModel, setAnthropicModel] = useState<string>(() => {
    try {
      return localStorage.getItem("cutflow_anthropic_model") ?? "";
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
  const [geminiModel, setGeminiModel] = useState<string>(() => {
    try {
      return localStorage.getItem("cutflow_gemini_model") ?? "";
    } catch {
      return "";
    }
  });
  const [higgsfieldKey, setHiggsfieldKey] = useState<string>(() => {
    try {
      return localStorage.getItem("cutflow_higgsfield_key") ?? "";
    } catch {
      return "";
    }
  });

  const quickFileInputRef = useRef<HTMLInputElement | null>(null);
  const assetsById = useMemo(() => new Map(assets.map((a) => [a.id, a])), [assets]);

  useEffect(() => {
    void (async () => {
      try {
        const [h, media, tpls] = await Promise.all([
          fetchHealth(),
          fetchMedia(),
          fetchTemplates(),
        ]);
        setHealth(h);
        setAssets(media);
        setTemplates(tpls);
        const visuals = media.filter((m) => m.kind !== "audio").map((m) => m.id);
        if (visuals.length > 0) setSelectedVisualIds(visuals);

        try {
          const savedRaw = localStorage.getItem(AUTOSAVE_STORAGE_KEY);
          if (savedRaw) {
            const parsed = CutProjectSchema.safeParse(JSON.parse(savedRaw));
            if (parsed.success) {
              const mediaMap = new Map(media.map((m) => [m.id, m]));
              const validClips = parsed.data.clips.filter((c) => {
                const a = mediaMap.get(c.assetId);
                return Boolean(a && a.kind !== "audio");
              });
              if (validClips.length > 0) {
                const validTracks = getProjectAudioTracks(parsed.data).filter(
                  (t) => mediaMap.get(t.assetId)?.kind === "audio"
                );
                const validStickers = (parsed.data.stickers || []).filter(
                  (st) => !st.assetId || mediaMap.get(st.assetId)?.kind === "image"
                );
                store.loadProject(
                  {
                    ...parsed.data,
                    clips: validClips,
                    stickers: validStickers,
                    audioTracks: validTracks,
                    audioTrack: validTracks[0],
                  },
                  false
                );
              }
            }
          }
        } catch {
          // Ignore malformed autosave draft
        }
      } catch (err) {
        setBannerError(err instanceof Error ? err.message : "Unable to reach API server.");
      }
    })();
  }, [store.loadProject]);

  // Desktop & keyboard shortcuts (Undo/Redo/Split/Play-Pause/Delete)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable)
      ) {
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
      } else if (e.code === "Space" && project) {
        e.preventDefault();
        setIsPlaying((p) => !p);
      } else if (e.key.toLowerCase() === "s" && project) {
        e.preventDefault();
        store.splitAtPlayhead(currentTime);
      } else if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && project) {
        e.preventDefault();
        const step = e.shiftKey ? 1.0 : 0.1;
        const delta = e.key === "ArrowRight" ? step : -step;
        setIsPlaying(false);
        setCurrentTime((t) =>
          Number(Math.max(0, Math.min(project.targetDurationSec, t + delta)).toFixed(2))
        );
      } else if (e.key === "Home" && project) {
        e.preventDefault();
        setIsPlaying(false);
        setCurrentTime(0);
      } else if (e.key === "End" && project) {
        e.preventDefault();
        setIsPlaying(false);
        setCurrentTime(project.targetDurationSec);
      } else if ((e.key === "Delete" || e.key === "Backspace") && project) {
        e.preventDefault();
        store.deleteSelection();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [project, currentTime, store]);

  useEffect(() => {
    if (!project) return;
    setCurrentTime((t) => (t > project.targetDurationSec ? project.targetDurationSec : t));
  }, [project?.targetDurationSec]);

  const handleSaveKeys = (keys: {
    anthropicKey: string;
    anthropicModel: string;
    anthropicWorkspaceId: string;
    geminiKey: string;
    geminiModel: string;
    higgsfieldKey: string;
  }) => {
    setAnthropicKey(keys.anthropicKey);
    setAnthropicModel(keys.anthropicModel);
    setAnthropicWorkspaceId(keys.anthropicWorkspaceId);
    setGeminiKey(keys.geminiKey);
    setGeminiModel(keys.geminiModel);
    setHiggsfieldKey(keys.higgsfieldKey);
    try {
      if (keys.anthropicKey) localStorage.setItem("cutflow_anthropic_key", keys.anthropicKey);
      else localStorage.removeItem("cutflow_anthropic_key");
      if (keys.anthropicModel) localStorage.setItem("cutflow_anthropic_model", keys.anthropicModel);
      else localStorage.removeItem("cutflow_anthropic_model");
      if (keys.anthropicWorkspaceId) {
        localStorage.setItem("cutflow_anthropic_workspace", keys.anthropicWorkspaceId);
      } else {
        localStorage.removeItem("cutflow_anthropic_workspace");
      }
      if (keys.geminiKey) localStorage.setItem("cutflow_gemini_key", keys.geminiKey);
      else localStorage.removeItem("cutflow_gemini_key");
      if (keys.geminiModel) localStorage.setItem("cutflow_gemini_model", keys.geminiModel);
      else localStorage.removeItem("cutflow_gemini_model");
      if (keys.higgsfieldKey) localStorage.setItem("cutflow_higgsfield_key", keys.higgsfieldKey);
      else localStorage.removeItem("cutflow_higgsfield_key");
    } catch {
      // ignore storage errors
    }
  };

  const handleUploadFiles = async (files: File[], autoAudioKind?: AudioCategory) => {
    setBannerError(null);
    setUploadProgress(5);
    try {
      const added = await uploadMediaFiles(files, (pct) => setUploadProgress(pct));
      setAssets((prev) => [...prev, ...added]);
      const addedVisuals = added.filter((a) => a.kind !== "audio").map((a) => a.id);
      if (addedVisuals.length > 0) {
        setSelectedVisualIds((prev) => Array.from(new Set([...prev, ...addedVisuals])));
      }
      const uploadedAudios = added.filter((a) => a.kind === "audio");
      const lastAudio = uploadedAudios[uploadedAudios.length - 1];
      if (lastAudio) {
        const targetKind =
          autoAudioKind ?? (lastAudio.audioCategory === "sfx" ? "sfx" : "bgm");
        if (project) {
          store.addAudioTrack(lastAudio, targetKind, currentTime);
        } else {
          setPendingAudioId(lastAudio.id);
        }
        if (addedVisuals.length === 0 && !autoAudioKind) {
          setDesktopLeftTab("audio");
          setMobilePanel("audio");
        }
      }
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
      setPendingAudioId((curr) => (curr === id ? null : curr));
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

    const sanitizedPrev =
      project && !templateOverride
        ? {
            ...project,
            overlays: project.overlays
              .map((o) => ({ ...o, text: o.text.trim() }))
              .filter((o) => o.text.length > 0),
          }
        : undefined;

    try {
      const res = await runAutoEdit(
        {
          prompt: activePrompt,
          assetIds: selectedVisualIds,
          audioAssetId: project?.audioTracks?.[0]?.assetId ?? pendingAudioId ?? undefined,
          templateId: templateOverride?.id,
          aspectRatio:
            templateOverride?.defaultAspectRatio ??
            (platform !== "auto" ? PLATFORM_DEFAULT_ASPECT[platform] : project?.aspectRatio),
          targetDurationSec: templateOverride?.defaultDurationSec,
          mode,
          platform,
          previousProject: sanitizedPrev,
        },
        {
          anthropicApiKey: anthropicKey,
          anthropicModel,
          anthropicWorkspaceId,
          geminiApiKey: geminiKey,
          geminiModel,
        }
      );
      store.loadProject(res.project);
      setCurrentTime(0);
      setWarnings(res.warnings);
      setIsPlaying(true);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Auto-edit failed");
    } finally {
      setIsGenerating(false);
    }
  };

  const selectedTalkingHeadAsset = useMemo(() => {
    for (const id of selectedVisualIds) {
      const a = assetsById.get(id);
      if (a && a.kind === "video") return a;
    }
    return null;
  }, [selectedVisualIds, assetsById]);

  const triggerTalkingHeadCut = async () => {
    if (!selectedTalkingHeadAsset) {
      setBannerError("Select or upload a talking-head video clip first.");
      return;
    }

    setBannerError(null);
    setWarnings([]);
    setIsTalkingHeadCutting(true);
    setIsPlaying(false);

    try {
      const res = await runTalkingHeadCut(
        {
          assetId: selectedTalkingHeadAsset.id,
          mode,
          autoCaptions: true,
          autoPunchIn: true,
          polishAudio: "none",
        },
        {
          anthropicApiKey: anthropicKey,
          anthropicModel,
          anthropicWorkspaceId,
          geminiApiKey: geminiKey,
          geminiModel,
        }
      );
      store.loadProject(res.project);
      setCurrentTime(0);
      setWarnings(res.warnings);
      setIsPlaying(true);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Auto talking-head cut failed");
    } finally {
      setIsTalkingHeadCutting(false);
    }
  };

  const handleImportUrl = async (url: string, kind: "video" | "audio") => {
    setBannerError(null);
    setIsImportingUrl(true);
    try {
      const asset = await importMediaFromUrl({ url, kind, maxHeight: 1080 });
      setAssets((prev) => [asset, ...prev]);
      if (asset.kind !== "audio") {
        setSelectedVisualIds((prev) => [asset.id, ...prev]);
      } else {
        setPendingAudioId(asset.id);
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Failed importing media from URL");
    } finally {
      setIsImportingUrl(false);
    }
  };

  const handleGenerateHiggsfield = async (opts: {
    prompt: string;
    kind: "video" | "image";
    model: string;
    aspectRatio: AspectRatio;
  }) => {
    setBannerError(null);
    setIsGeneratingHiggsfield(true);
    try {
      const res = await generateHiggsfieldMedia(
        {
          prompt: opts.prompt,
          kind: opts.kind,
          model: opts.model,
          aspectRatio: opts.aspectRatio,
          durationSec: 5,
        },
        higgsfieldKey
      );
      setAssets((prev) => [res.asset, ...prev]);
      setSelectedVisualIds((prev) => [res.asset.id, ...prev]);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Higgsfield generation failed");
    } finally {
      setIsGeneratingHiggsfield(false);
    }
  };

  const handlePolishAudio = async (asset: MediaAsset) => {
    setBannerError(null);
    setPolishingAssetId(asset.id);
    try {
      const res = await polishMediaAudio(asset.id, { denoise: "ffmpeg" });
      setAssets((prev) => [res.asset, ...prev]);
      if (res.asset.kind !== "audio") {
        setSelectedVisualIds((prev) => [res.asset.id, ...prev.filter((id) => id !== asset.id)]);
      }
      if (res.warnings.length > 0) {
        setWarnings(res.warnings);
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Failed polishing audio");
    } finally {
      setPolishingAssetId(null);
    }
  };

  const handleExtractAudio = async (videoAssetId: string) => {
    setBannerError(null);
    try {
      const audioAsset = await extractAudioFromVideo(videoAssetId);
      setAssets((prev) => [...prev, audioAsset]);
      if (project) {
        store.addAudioTrack(audioAsset, "bgm", 0);
      } else {
        setPendingAudioId(audioAsset.id);
      }
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Failed extracting audio");
    }
  };

  const handleAutoCaptions = async (videoAssetId: string) => {
    if (!project) return;
    setBannerError(null);
    try {
      const res = await transcribeMedia(videoAssetId, geminiKey, geminiModel);
      store.updateOverlays([...project.overlays, ...res.overlays]);
      if (res.overlays[0]) store.selectOverlay(res.overlays[0].id);
    } catch (err) {
      setBannerError(err instanceof Error ? err.message : "Auto-captions failed");
    }
  };

  const handleSaveTemplate = async (name: string, tagline: string) => {
    if (!project) return;
    const blueprint = extractTemplateFromProject(project, name, tagline);
    const saved = await saveCustomTemplate(blueprint);
    setTemplates((prev) => [saved, ...prev.filter((t) => t.id !== saved.id)]);
  };

  const handleDeleteTemplate = async (id: string) => {
    await deleteCustomTemplate(id);
    setTemplates((prev) => prev.filter((t) => t.id !== id));
  };

  const handleTimeChange = useCallback((t: number) => {
    setCurrentTime(t);
  }, []);

  const audioDrawerProps = {
    project,
    assets,
    selectedAudioTrackId: selection.audioTrackId,
    pendingAudioId,
    currentTime,
    onSelectAudioTrack: store.selectAudioTrack,
    onSelectPendingAudio: (id: string) => setPendingAudioId(id),
    onAddAudioTrack: store.addAudioTrack,
    onUpdateAudioTrack: store.updateAudioTrack,
    onDeleteAudioTrack: store.deleteAudioTrack,
    onUploadAudio: (files: File[], kind?: AudioCategory) => handleUploadFiles(files, kind),
    onExtractAudio: handleExtractAudio,
    onSnapCutsToBeats: () => store.snapCutsToBeats(assetsById),
    onBeginSlider: store.beginGesture,
    onEndSlider: store.endGesture,
  };

  // Determine mobile inspector sub-section when a mobile tool button is active
  const mobileInspectorSection: InspectorSection | undefined =
    mobilePanel === "adjust"
      ? "adjust"
      : mobilePanel === "text"
        ? "text"
        : mobilePanel === "stickers"
          ? "stickers"
          : mobilePanel === "edit"
            ? "clip"
            : undefined;

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
      <header className="safe-top flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/90 bg-[#0d111a]/95 px-3 py-1.5 backdrop-blur sm:px-4">
        <div className="flex items-center gap-2">
          <div className="flex size-8 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-400 to-rose-500 text-slate-950 shadow">
            <Scissors className="size-4" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-sm font-extrabold tracking-tight text-white">CutFlow AI</h1>
            <p className="hidden text-[11px] text-slate-400 sm:block">
              CapCut-Style AI Studio · Phone &amp; Laptop
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 sm:gap-2">
          {project && (
            <>
              <div className="flex items-center gap-0.5 lg:hidden">
                <button
                  type="button"
                  disabled={!store.canUndo}
                  onClick={store.undo}
                  aria-label="Undo"
                  className="rounded-lg border border-slate-800 bg-[#111520] p-1.5 text-slate-300 disabled:opacity-35"
                >
                  <Undo2 className="size-3.5" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  disabled={!store.canRedo}
                  onClick={store.redo}
                  aria-label="Redo"
                  className="rounded-lg border border-slate-800 bg-[#111520] p-1.5 text-slate-300 disabled:opacity-35"
                >
                  <Redo2 className="size-3.5" aria-hidden="true" />
                </button>
              </div>

              <div
                role="group"
                aria-label="Aspect ratio"
                className="flex items-center rounded-xl border border-slate-800 bg-[#090b10] p-0.5 text-[11px] font-bold"
              >
                {(["9:16", "4:5", "16:9", "1:1"] as AspectRatio[]).map((ratio) => (
                  <button
                    key={ratio}
                    type="button"
                    onClick={() => store.commit((p) => ({ ...p, aspectRatio: ratio }))}
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
              <button
                type="button"
                onClick={() => {
                  setIsPlaying(false);
                  setCurrentTime(0);
                  store.clearProject();
                }}
                title="Reset timeline & clear autosaved draft"
                className="rounded-xl border border-slate-700/80 bg-[#111520] px-2.5 py-1.5 text-[11px] font-semibold text-slate-300 hover:border-rose-400 hover:text-rose-200"
              >
                Reset
              </button>
            </>
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
            className="inline-flex items-center gap-1.5 rounded-xl bg-gradient-to-r from-rose-500 to-amber-400 px-3 py-1.5 text-xs font-extrabold text-slate-950 shadow transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Download className="size-4" aria-hidden="true" />
            <span>Export</span>
          </button>
        </div>
      </header>

      {(bannerError || warnings.length > 0) && (
        <div className="flex flex-col gap-1 border-b border-slate-800 bg-[#111520] px-3 py-1.5 text-xs">
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

      {/* Main Studio Grid */}
      <main className="safe-bottom grid flex-1 grid-cols-1 gap-2.5 p-2 sm:p-3 lg:grid-cols-[345px_minmax(0,1fr)_330px] lg:grid-rows-[minmax(0,1fr)_auto]">
        {/* Desktop Left Library (Clips / Audio & SFX / Templates) */}
        <aside className="hidden flex-col gap-2.5 overflow-y-auto rounded-2xl border border-slate-800/80 bg-[#111520] p-3 lg:flex lg:max-h-[calc(100dvh-19rem)]">
          <div
            role="tablist"
            aria-label="Studio library"
            className="studio-tablist border-b border-slate-800 pb-1"
          >
            {(
              [
                { id: "clips", label: "Clips", Icon: Film },
                { id: "audio", label: "Music & SFX", Icon: Music2 },
                { id: "templates", label: "Templates", Icon: LayoutTemplate },
              ] as const
            ).map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={desktopLeftTab === id}
                onClick={() => setDesktopLeftTab(id)}
                className="studio-tab inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold text-slate-300"
              >
                <Icon className="size-3.5" aria-hidden="true" />
                {label}
              </button>
            ))}
          </div>

          {desktopLeftTab === "clips" && (
            <MediaBin
              assets={assets}
              selectedVisualIds={selectedVisualIds}
              onToggleVisual={(id) =>
                setSelectedVisualIds((prev) =>
                  prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                )
              }
              onAppendToTimeline={(asset) =>
                store.appendVisualAsset(
                  asset,
                  pendingAudioId ? assetsById.get(pendingAudioId) : undefined
                )
              }
              onUploadFiles={(files) => void handleUploadFiles(files)}
              onImportUrl={(url, kind) => void handleImportUrl(url, kind)}
              onGenerateHiggsfield={(opts) => void handleGenerateHiggsfield(opts)}
              onPolishAudio={(asset) => void handlePolishAudio(asset)}
              onLoadSamplePack={() => void handleLoadDemo()}
              onDeleteAsset={(id) => void handleDeleteAsset(id)}
              uploadProgress={uploadProgress}
              isLoadingSample={isLoadingDemo}
              isImportingUrl={isImportingUrl}
              isGeneratingHiggsfield={isGeneratingHiggsfield}
              polishingAssetId={polishingAssetId}
            />
          )}

          {desktopLeftTab === "audio" && <AudioDrawer {...audioDrawerProps} />}

          {desktopLeftTab === "templates" && (
            <TemplateDrawer
              templates={templates}
              activeTemplateId={project?.templateId}
              project={project}
              disabled={selectedVisualIds.length === 0 || isGenerating}
              onUseTemplateModal={(tpl) => setTemplateModalTarget(tpl)}
              onAutoFillTemplate={(tpl) => {
                const nextPrompt = `${tpl.name}: ${tpl.tagline}`;
                setPrompt(nextPrompt);
                void triggerAutoEdit(nextPrompt, tpl);
              }}
              onSaveCurrentAsTemplate={handleSaveTemplate}
              onDeleteCustomTemplate={handleDeleteTemplate}
              onImportProjectJson={(imported) => {
                store.loadProject(imported);
                setCurrentTime(0);
              }}
            />
          )}
        </aside>

        {/* Center Stage: Preview Player + Desktop PromptBar */}
        <section className="flex min-w-0 flex-col gap-2">
          <PreviewStage
            project={project}
            assetsById={assetsById}
            currentTime={currentTime}
            isPlaying={isPlaying}
            selection={selection}
            onTimeChange={handleTimeChange}
            onPlayingChange={setIsPlaying}
            onSelectOverlay={(id) => {
              store.selectOverlay(id);
              if (id) setMobilePanel("text");
            }}
            onSelectSticker={(id) => {
              store.selectSticker(id);
              if (id) setMobilePanel("stickers");
            }}
            onBeginDrag={store.beginGesture}
            onEndDrag={store.endGesture}
            onMoveOverlayPos={(id, xNorm, yNorm) => {
              store.updateOverlays(
                (prev) => prev.map((o) => (o.id === id ? { ...o, xNorm, yNorm } : o)),
                false
              );
            }}
            onMoveStickerPos={(id, xNorm, yNorm) => {
              store.updateStickers(
                (prev) => prev.map((s) => (s.id === id ? { ...s, xNorm, yNorm } : s)),
                false
              );
            }}
            onLoadDemo={() => void handleLoadDemo()}
            onQuickUpload={() => quickFileInputRef.current?.click()}
            isLoadingDemo={isLoadingDemo}
          />

          <div className="hidden lg:block">
            <PromptBar
              prompt={prompt}
              onPromptChange={setPrompt}
              onSubmit={(override) => void triggerAutoEdit(override)}
              onAutoTalkingHeadCut={() => void triggerTalkingHeadCut()}
              canTalkingHeadCut={Boolean(selectedTalkingHeadAsset)}
              isTalkingHeadCutting={isTalkingHeadCutting}
              isGenerating={isGenerating}
              disabled={selectedVisualIds.length === 0}
              mode={mode}
              onModeChange={setMode}
              platform={platform}
              onPlatformChange={setPlatform}
              hasProject={Boolean(project)}
            />
          </div>
        </section>

        {/* Desktop Right Contextual Inspector */}
        <aside className="hidden overflow-y-auto rounded-2xl border border-slate-800/80 bg-[#111520] p-3 lg:block lg:max-h-[calc(100dvh-19rem)]">
          {selection.audioTrackId && project ? (
            <AudioDrawer {...audioDrawerProps} />
          ) : (
            <SlotInspector
              project={project}
              selection={selection}
              assets={assets}
              assetsById={assetsById}
              currentTime={currentTime}
              onBeginSlider={store.beginGesture}
              onEndSlider={store.endGesture}
              onUpdateSlot={store.updateSlot}
              onReplaceSlotAsset={store.replaceSlotAsset}
              onDuplicateSlot={store.duplicateSlot}
              onDeleteSlot={store.deleteSlot}
              onUpdateOverlays={store.updateOverlays}
              onUpdateStickers={store.updateStickers}
              onSelectOverlay={store.selectOverlay}
              onSelectSticker={store.selectSticker}
              onAutoCaptions={handleAutoCaptions}
            />
          )}
        </aside>

        {/* Always-Visible Multi-Track Timeline (Both Phone & Laptop!) */}
        <section className="lg:col-span-3">
          <TimelineBar
            project={project}
            assetsById={assetsById}
            currentTime={currentTime}
            selection={selection}
            canUndo={store.canUndo}
            canRedo={store.canRedo}
            onUndo={store.undo}
            onRedo={store.redo}
            onSplitAtPlayhead={() => store.splitAtPlayhead(currentTime)}
            onDuplicateSlot={store.duplicateSlot}
            onMoveSlot={store.moveSlot}
            onUpdateSlot={store.updateSlot}
            onUpdateOverlay={(overlayId, patch, recordHistory) =>
              store.updateOverlays(
                (prev) => prev.map((o) => (o.id === overlayId ? { ...o, ...patch } : o)),
                recordHistory
              )
            }
            onUpdateSticker={(stickerId, patch, recordHistory) =>
              store.updateStickers(
                (prev) => prev.map((s) => (s.id === stickerId ? { ...s, ...patch } : s)),
                recordHistory
              )
            }
            onBeginDrag={store.beginGesture}
            onEndDrag={store.endGesture}
            onSelectSlot={(id) => {
              store.selectSlot(id);
              setMobilePanel("edit");
            }}
            onSelectAudioTrack={(id) => {
              store.selectAudioTrack(id);
              setMobilePanel("audio");
            }}
            onSelectOverlay={(id) => {
              store.selectOverlay(id);
              setMobilePanel("text");
            }}
            onSelectSticker={(id) => {
              store.selectSticker(id);
              setMobilePanel("stickers");
            }}
            onSeek={(sec) => {
              setIsPlaying(false);
              setCurrentTime(sec);
            }}
            onSnapBeats={() => store.snapCutsToBeats(assetsById)}
            onOpenAddClip={() => {
              setDesktopLeftTab("clips");
              setMobilePanel("clips");
            }}
            onOpenAddMusic={() => {
              setDesktopLeftTab("audio");
              setMobilePanel("audio");
            }}
            onAddTextShortcut={() => {
              setMobilePanel("text");
            }}
          />
        </section>

        {/* Mobile CapCut Bottom Contextual Toolbar + Tool Drawer */}
        <section className="flex flex-col gap-2 lg:hidden">
          <div
            role="tablist"
            aria-label="CapCut mobile tools"
            className="studio-tablist rounded-2xl border border-slate-800/90 bg-[#111520] px-1.5 pt-1"
          >
            {(
              [
                { id: "ai", label: "AI Magic", Icon: Sparkles },
                { id: "clips", label: "Clips", Icon: Film },
                { id: "audio", label: "Audio", Icon: Music2 },
                { id: "templates", label: "Templates", Icon: LayoutTemplate },
                { id: "edit", label: "Edit Clip", Icon: Scissors },
                { id: "adjust", label: "Adjust", Icon: Sliders },
                { id: "text", label: "Text", Icon: Type },
                { id: "stickers", label: "Stickers", Icon: Sticker },
              ] as const
            ).map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={mobilePanel === id}
                onClick={(e) => {
                  setMobilePanel((curr) => (curr === id ? null : id));
                  e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
                }}
                className="studio-tab inline-flex flex-col items-center gap-0.5 px-3 py-1.5 text-[10px] font-bold text-slate-300"
              >
                <Icon className="size-4" aria-hidden="true" />
                <span>{label}</span>
              </button>
            ))}
          </div>

          {mobilePanel && (
            <div className="max-h-[38dvh] overflow-y-auto rounded-2xl border border-slate-800/80 bg-[#111520] p-3">
              {mobilePanel === "ai" && (
                <PromptBar
                  prompt={prompt}
                  onPromptChange={setPrompt}
                  onSubmit={(override) => void triggerAutoEdit(override)}
                  onAutoTalkingHeadCut={() => void triggerTalkingHeadCut()}
                  canTalkingHeadCut={Boolean(selectedTalkingHeadAsset)}
                  isTalkingHeadCutting={isTalkingHeadCutting}
                  isGenerating={isGenerating}
                  disabled={selectedVisualIds.length === 0}
                  mode={mode}
                  onModeChange={setMode}
                  platform={platform}
                  onPlatformChange={setPlatform}
                  hasProject={Boolean(project)}
                />
              )}

              {mobilePanel === "clips" && (
                <MediaBin
                  assets={assets}
                  selectedVisualIds={selectedVisualIds}
                  onToggleVisual={(id) =>
                    setSelectedVisualIds((prev) =>
                      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
                    )
                  }
                  onAppendToTimeline={(asset) =>
                    store.appendVisualAsset(
                      asset,
                      pendingAudioId ? assetsById.get(pendingAudioId) : undefined
                    )
                  }
                  onUploadFiles={(files) => void handleUploadFiles(files)}
                  onImportUrl={(url, kind) => void handleImportUrl(url, kind)}
                  onGenerateHiggsfield={(opts) => void handleGenerateHiggsfield(opts)}
                  onPolishAudio={(asset) => void handlePolishAudio(asset)}
                  onLoadSamplePack={() => void handleLoadDemo()}
                  onDeleteAsset={(id) => void handleDeleteAsset(id)}
                  uploadProgress={uploadProgress}
                  isLoadingSample={isLoadingDemo}
                  isImportingUrl={isImportingUrl}
                  isGeneratingHiggsfield={isGeneratingHiggsfield}
                  polishingAssetId={polishingAssetId}
                />
              )}

              {mobilePanel === "audio" && <AudioDrawer {...audioDrawerProps} />}

              {mobilePanel === "templates" && (
                <TemplateDrawer
                  templates={templates}
                  activeTemplateId={project?.templateId}
                  project={project}
                  disabled={selectedVisualIds.length === 0 || isGenerating}
                  onUseTemplateModal={(tpl) => setTemplateModalTarget(tpl)}
                  onAutoFillTemplate={(tpl) => {
                    const nextPrompt = `${tpl.name}: ${tpl.tagline}`;
                    setPrompt(nextPrompt);
                    void triggerAutoEdit(nextPrompt, tpl);
                  }}
                  onSaveCurrentAsTemplate={handleSaveTemplate}
                  onDeleteCustomTemplate={handleDeleteTemplate}
                  onImportProjectJson={(imported) => {
                    store.loadProject(imported);
                    setCurrentTime(0);
                  }}
                />
              )}

              {(mobilePanel === "edit" ||
                mobilePanel === "adjust" ||
                mobilePanel === "text" ||
                mobilePanel === "stickers") && (
                <SlotInspector
                  project={project}
                  selection={selection}
                  activeSection={mobileInspectorSection}
                  assets={assets}
                  assetsById={assetsById}
                  currentTime={currentTime}
                  onBeginSlider={store.beginGesture}
                  onEndSlider={store.endGesture}
                  onUpdateSlot={store.updateSlot}
                  onReplaceSlotAsset={store.replaceSlotAsset}
                  onDuplicateSlot={store.duplicateSlot}
                  onDeleteSlot={store.deleteSlot}
                  onUpdateOverlays={store.updateOverlays}
                  onUpdateStickers={store.updateStickers}
                  onSelectOverlay={store.selectOverlay}
                  onSelectSticker={store.selectSticker}
                  onAutoCaptions={handleAutoCaptions}
                />
              )}
            </div>
          )}
        </section>
      </main>

      <TemplateStudioModal
        open={Boolean(templateModalTarget)}
        template={templateModalTarget}
        assets={assets}
        selectedAudioId={project?.audioTracks?.[0]?.assetId ?? pendingAudioId ?? undefined}
        onClose={() => setTemplateModalTarget(null)}
        onApplyProject={(built) => {
          store.loadProject(built);
          setCurrentTime(0);
          setIsPlaying(true);
        }}
      />

      <ExportModal
        open={exportOpen}
        onClose={() => setExportOpen(false)}
        project={project}
        onOpenAudioDrawer={() => {
          setDesktopLeftTab("audio");
          setMobilePanel("audio");
        }}
      />

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        anthropicKey={anthropicKey}
        anthropicModel={anthropicModel}
        anthropicWorkspaceId={anthropicWorkspaceId}
        geminiKey={geminiKey}
        geminiModel={geminiModel}
        higgsfieldKey={higgsfieldKey}
        onSaveKeys={handleSaveKeys}
        health={health}
      />

      {(isGenerating || isTalkingHeadCutting) && (
        <div
          aria-live="polite"
          className="fixed right-4 bottom-4 z-40 inline-flex items-center gap-2 rounded-full border border-cyan-400/50 bg-[#111520]/95 px-4 py-2 text-xs font-bold text-cyan-200 shadow-xl backdrop-blur"
        >
          <Sparkles className="size-4 animate-pulse text-cyan-400" aria-hidden="true" />
          <span>
            {isTalkingHeadCutting
              ? "Auto-cutting dead air, fillers & retakes (WhisperX + AI)..."
              : "AI Director is cutting your template..."}
          </span>
        </div>
      )}
    </div>
  );
}
