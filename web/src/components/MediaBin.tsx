import { useRef, useState } from "react";
import { Check, Clapperboard, Film, Link2, Mic, Plus, Sparkles, Trash2, Upload } from "lucide-react";
import type { AspectRatio, MediaAsset } from "@cutflow/shared";

interface MediaBinProps {
  assets: MediaAsset[];
  selectedVisualIds: string[];
  onToggleVisual: (id: string) => void;
  onAppendToTimeline: (asset: MediaAsset) => void;
  onUploadFiles: (files: File[]) => void;
  onImportUrl?: (url: string, kind: "video" | "audio") => void;
  onGenerateHiggsfield?: (opts: {
    prompt: string;
    kind: "video" | "image";
    model: string;
    aspectRatio: AspectRatio;
  }) => void;
  onPolishAudio?: (asset: MediaAsset) => void;
  onLoadSamplePack: () => void;
  onDeleteAsset: (id: string) => void;
  uploadProgress: number | null;
  isLoadingSample: boolean;
  isImportingUrl?: boolean;
  isGeneratingHiggsfield?: boolean;
  polishingAssetId?: string | null;
}

export function MediaBin({
  assets,
  selectedVisualIds,
  onToggleVisual,
  onAppendToTimeline,
  onUploadFiles,
  onImportUrl,
  onGenerateHiggsfield,
  onPolishAudio,
  onLoadSamplePack,
  onDeleteAsset,
  uploadProgress,
  isLoadingSample,
  isImportingUrl = false,
  isGeneratingHiggsfield = false,
  polishingAssetId = null,
}: MediaBinProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);
  const [urlInput, setUrlInput] = useState("");
  const [urlKind, setUrlKind] = useState<"video" | "audio">("video");
  const [hfOpen, setHfOpen] = useState(false);
  const [hfPrompt, setHfPrompt] = useState("");
  const [hfKind, setHfKind] = useState<"video" | "image">("video");
  const [hfModel, setHfModel] = useState("kling");
  const [hfAspect, setHfAspect] = useState<AspectRatio>("9:16");

  const visualAssets = assets.filter((a) => a.kind !== "audio");
  const uploadedAudioCount = assets.filter((a) => a.kind === "audio" && !a.isBuiltIn).length;

  return (
    <div className="panel-container flex flex-col gap-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const files = Array.from(e.dataTransfer.files);
          if (files.length > 0) onUploadFiles(files);
        }}
        className={`flex flex-col gap-2 rounded-2xl border border-dashed p-3 transition ${
          dragging
            ? "border-cyan-400 bg-cyan-500/10"
            : "border-slate-700/80 bg-[#090b10]/70"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept="video/*,image/*,audio/*"
          className="hidden"
          onChange={(e) => {
            const list = e.target.files ? Array.from(e.target.files) : [];
            if (list.length > 0) onUploadFiles(list);
            e.target.value = "";
          }}
        />
        <div className="studio-toolbar gap-2">
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-cyan-500/15 px-3 py-2 text-xs font-semibold text-cyan-200 ring-1 ring-cyan-400/40 transition hover:bg-cyan-500/25"
          >
            <Upload className="size-4" aria-hidden="true" />
            <span>Upload Clips</span>
          </button>
          <button
            type="button"
            onClick={onLoadSamplePack}
            disabled={isLoadingSample}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-rose-500/15 px-3 py-2 text-xs font-semibold text-rose-200 ring-1 ring-rose-400/40 transition hover:bg-rose-500/25 disabled:opacity-50"
          >
            <Sparkles className="size-4" aria-hidden="true" />
            <span>{isLoadingSample ? "Generating..." : "Demo Clips"}</span>
          </button>
        </div>

        {uploadProgress !== null && (
          <div className="flex flex-col gap-1">
            <div className="flex justify-between text-[11px] text-cyan-300">
              <span>Uploading & analyzing...</span>
              <span>{uploadProgress}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-slate-800">
              <div
                className="h-full bg-cyan-400 transition-all"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}

        {onImportUrl && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (!urlInput.trim() || isImportingUrl) return;
              onImportUrl(urlInput.trim(), urlKind);
              setUrlInput("");
            }}
            className="flex items-center gap-1.5 pt-1"
          >
            <div className="relative flex min-w-0 flex-1 items-center">
              <Link2 className="pointer-events-none absolute left-2.5 size-3.5 text-slate-400" aria-hidden="true" />
              <input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="Paste URL (yt-dlp video/audio)..."
                aria-label="Import media from URL"
                className="w-full rounded-lg border border-slate-700/80 bg-[#0d111a] py-1.5 pr-2 pl-8 text-[11px] text-slate-100 placeholder:text-slate-500 focus:border-cyan-400 focus:outline-none"
              />
            </div>
            <select
              value={urlKind}
              onChange={(e) => setUrlKind(e.target.value as "video" | "audio")}
              aria-label="URL download type"
              className="rounded-lg border border-slate-700/80 bg-[#0d111a] px-1.5 py-1.5 text-[11px] text-slate-200 focus:border-cyan-400 focus:outline-none"
            >
              <option value="video">MP4</option>
              <option value="audio">Audio</option>
            </select>
            <button
              type="submit"
              disabled={!urlInput.trim() || isImportingUrl}
              className="shrink-0 rounded-lg bg-indigo-500/20 px-2.5 py-1.5 text-[11px] font-semibold text-indigo-200 ring-1 ring-indigo-400/40 transition hover:bg-indigo-500/30 disabled:opacity-40"
            >
              {isImportingUrl ? "..." : "Import"}
            </button>
          </form>
        )}

        {onGenerateHiggsfield && (
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setHfOpen((v) => !v)}
              className="inline-flex w-full items-center justify-between rounded-lg border border-fuchsia-500/30 bg-fuchsia-500/10 px-2.5 py-1.5 text-[11px] font-semibold text-fuchsia-200 transition hover:bg-fuchsia-500/20"
            >
              <span className="inline-flex items-center gap-1.5">
                <Clapperboard className="size-3.5" aria-hidden="true" />
                <span>AI Gen B-Roll (Higgsfield)</span>
              </span>
              <span className="text-[10px] opacity-75">{hfOpen ? "Hide" : "Open"}</span>
            </button>
            {hfOpen && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!hfPrompt.trim() || isGeneratingHiggsfield) return;
                  onGenerateHiggsfield({
                    prompt: hfPrompt.trim(),
                    kind: hfKind,
                    model: hfModel,
                    aspectRatio: hfAspect,
                  });
                  setHfPrompt("");
                }}
                className="mt-1.5 flex flex-col gap-1.5 rounded-xl border border-slate-800 bg-[#0d111a] p-2"
              >
                <input
                  type="text"
                  value={hfPrompt}
                  onChange={(e) => setHfPrompt(e.target.value)}
                  placeholder="Describe B-roll shot (e.g. Neon Manila skyline dolly shot)..."
                  aria-label="Higgsfield AI generation prompt"
                  className="w-full rounded-lg border border-slate-700/80 bg-[#090b10] px-2.5 py-1.5 text-[11px] text-slate-100 placeholder:text-slate-500 focus:border-fuchsia-400 focus:outline-none"
                />
                <div className="flex flex-wrap items-center gap-1.5">
                  <select
                    value={hfKind}
                    onChange={(e) => {
                      const next = e.target.value as "video" | "image";
                      setHfKind(next);
                      setHfModel(next === "image" ? "soul" : "kling");
                    }}
                    aria-label="Higgsfield media kind"
                    className="rounded-lg border border-slate-700/80 bg-[#090b10] px-1.5 py-1 text-[11px] text-slate-200"
                  >
                    <option value="video">Video</option>
                    <option value="image">Image</option>
                  </select>
                  <select
                    value={hfModel}
                    onChange={(e) => setHfModel(e.target.value)}
                    aria-label="Higgsfield model preset"
                    className="flex-1 rounded-lg border border-slate-700/80 bg-[#090b10] px-1.5 py-1 text-[11px] text-slate-200"
                  >
                    {hfKind === "video" ? (
                      <>
                        <option value="kling">Kling 2.1</option>
                        <option value="seedance">Seedance Pro</option>
                        <option value="veo">Veo 3</option>
                        <option value="minimax">MiniMax</option>
                        <option value="dop">Higgsfield DoP</option>
                      </>
                    ) : (
                      <>
                        <option value="soul">Higgsfield Soul</option>
                        <option value="seedream">Seedream v3</option>
                        <option value="nano-banana">Nano Banana</option>
                      </>
                    )}
                  </select>
                  <select
                    value={hfAspect}
                    onChange={(e) => setHfAspect(e.target.value as AspectRatio)}
                    aria-label="Higgsfield aspect ratio"
                    className="rounded-lg border border-slate-700/80 bg-[#090b10] px-1.5 py-1 text-[11px] text-slate-200"
                  >
                    <option value="9:16">9:16</option>
                    <option value="16:9">16:9</option>
                    <option value="1:1">1:1</option>
                    <option value="4:5">4:5</option>
                  </select>
                  <button
                    type="submit"
                    disabled={!hfPrompt.trim() || isGeneratingHiggsfield}
                    className="rounded-lg bg-fuchsia-500/25 px-2.5 py-1 text-[11px] font-bold text-fuchsia-100 ring-1 ring-fuchsia-400/50 transition hover:bg-fuchsia-500/35 disabled:opacity-40"
                  >
                    {isGeneratingHiggsfield ? "Generating..." : "Generate"}
                  </button>
                </div>
              </form>
            )}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-300">
          <span className="inline-flex items-center gap-1.5">
            <Film className="size-3.5 text-cyan-400" aria-hidden="true" />
            Clips ({selectedVisualIds.length}/{visualAssets.length} for AI)
          </span>
          {uploadedAudioCount > 0 && (
            <span className="text-[10px] font-medium text-rose-300">
              +{uploadedAudioCount} audio in Music &amp; SFX
            </span>
          )}
        </div>

        {visualAssets.length === 0 ? (
          <p className="rounded-xl bg-[#090b10] p-3 text-xs text-slate-400">
            No clips yet. Tap <strong>Upload Clips</strong> or <strong>Demo Clips</strong> to start.
          </p>
        ) : (
          <div className="media-grid">
            {visualAssets.map((asset) => {
              const selected = selectedVisualIds.includes(asset.id);
              return (
                <div
                  key={asset.id}
                  className={`group relative overflow-hidden rounded-xl border bg-[#090b10] transition ${
                    selected
                      ? "border-cyan-400 ring-1 ring-cyan-400/50"
                      : "border-slate-800 hover:border-slate-600"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => onToggleVisual(asset.id)}
                    aria-pressed={selected}
                    className="block w-full text-left"
                  >
                    <div className="relative aspect-[4/3] w-full overflow-hidden bg-slate-900">
                      {asset.thumbnailUrl ? (
                        <img
                          src={asset.thumbnailUrl}
                          alt={asset.originalName}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full items-center justify-center text-xs text-slate-500">
                          {asset.kind.toUpperCase()}
                        </div>
                      )}
                      <span
                        className={`absolute top-1.5 left-1.5 inline-flex size-5 items-center justify-center rounded-full text-[10px] font-bold ${
                          selected
                            ? "bg-cyan-400 text-slate-950"
                            : "bg-slate-950/75 text-slate-300 ring-1 ring-slate-600"
                        }`}
                      >
                        {selected ? <Check className="size-3" aria-hidden="true" /> : "+"}
                      </span>
                      <span className="absolute right-1.5 bottom-1.5 rounded bg-slate-950/80 px-1.5 py-0.5 text-[10px] font-semibold text-slate-200">
                        {asset.kind === "image" ? "IMG" : `${asset.durationSec.toFixed(1)}s`}
                      </span>
                    </div>
                    <div className="truncate px-2 py-1.5 text-[11px] font-medium text-slate-200">
                      {asset.originalName}
                    </div>
                  </button>

                  <div className="card-reveal-actions absolute top-1.5 right-1.5 flex gap-1">
                    {onPolishAudio && asset.kind === "video" && asset.hasAudio && (
                      <button
                        type="button"
                        onClick={() => onPolishAudio(asset)}
                        disabled={polishingAssetId === asset.id}
                        aria-label={`Polish voice audio for ${asset.originalName}`}
                        title="Polish Voice (Denoise + -14 LUFS Mastering)"
                        className="inline-flex items-center justify-center rounded-full bg-emerald-400 p-1 text-slate-950 shadow disabled:opacity-50"
                      >
                        <Mic className="size-3" aria-hidden="true" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => onAppendToTimeline(asset)}
                      aria-label={`Add ${asset.originalName} to timeline`}
                      title="Add directly to timeline"
                      className="inline-flex items-center justify-center rounded-full bg-cyan-400 p-1 text-slate-950 shadow"
                    >
                      <Plus className="size-3" aria-hidden="true" />
                    </button>
                    {!asset.isBuiltIn && (
                      <button
                        type="button"
                        onClick={() => onDeleteAsset(asset.id)}
                        aria-label={`Delete ${asset.originalName}`}
                        className="inline-flex items-center justify-center rounded-full bg-slate-950/85 p-1 text-slate-300 hover:text-rose-400"
                      >
                        <Trash2 className="size-3" aria-hidden="true" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
