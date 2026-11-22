import { useRef, useState } from "react";
import { Check, Film, Music2, Sparkles, Trash2, Upload } from "lucide-react";
import type { MediaAsset } from "@cutflow/shared";

interface MediaBinProps {
  assets: MediaAsset[];
  selectedVisualIds: string[];
  selectedAudioId?: string;
  onToggleVisual: (id: string) => void;
  onSelectAudio: (id?: string) => void;
  onUploadFiles: (files: File[]) => void;
  onLoadSamplePack: () => void;
  onDeleteAsset: (id: string) => void;
  uploadProgress: number | null;
  isLoadingSample: boolean;
}

export function MediaBin({
  assets,
  selectedVisualIds,
  selectedAudioId,
  onToggleVisual,
  onSelectAudio,
  onUploadFiles,
  onLoadSamplePack,
  onDeleteAsset,
  uploadProgress,
  isLoadingSample,
}: MediaBinProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const visualAssets = assets.filter((a) => a.kind !== "audio");
  const audioAssets = assets.filter((a) => a.kind === "audio");

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
            <span>Upload Videos / Photos</span>
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
              <span>Uploading & analyzing beats...</span>
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
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-300">
          <span className="inline-flex items-center gap-1.5">
            <Film className="size-3.5 text-cyan-400" aria-hidden="true" />
            Visual Clips ({selectedVisualIds.length}/{visualAssets.length} selected)
          </span>
        </div>

        {visualAssets.length === 0 ? (
          <p className="rounded-xl bg-[#090b10] p-3 text-xs text-slate-400">
            No clips yet. Tap <strong>Upload Videos / Photos</strong> or{" "}
            <strong>Demo Clips</strong> to start.
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

                  {!asset.isBuiltIn && (
                    <button
                      type="button"
                      onClick={() => onDeleteAsset(asset.id)}
                      aria-label={`Delete ${asset.originalName}`}
                      className="absolute top-1.5 right-1.5 inline-flex items-center justify-center rounded-full bg-slate-950/80 p-1 text-slate-300 hover:text-rose-400"
                    >
                      <Trash2 className="size-3.5" aria-hidden="true" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between text-xs font-semibold text-slate-300">
          <span className="inline-flex items-center gap-1.5">
            <Music2 className="size-3.5 text-rose-400" aria-hidden="true" />
            Beat / BGM Track
          </span>
          {selectedAudioId && (
            <button
              type="button"
              onClick={() => onSelectAudio(undefined)}
              className="text-[11px] font-medium text-slate-400 hover:text-slate-200"
            >
              No BGM
            </button>
          )}
        </div>
        <div className="flex flex-col gap-1.5">
          {audioAssets.map((audio) => {
            const active = selectedAudioId === audio.id;
            return (
              <button
                key={audio.id}
                type="button"
                onClick={() => onSelectAudio(active ? undefined : audio.id)}
                className={`flex items-center justify-between gap-2 rounded-xl border px-3 py-2 text-left text-xs transition ${
                  active
                    ? "border-rose-400/70 bg-rose-500/15 text-rose-100"
                    : "border-slate-800 bg-[#090b10] text-slate-300 hover:border-slate-700"
                }`}
              >
                <span className="truncate font-medium">{audio.originalName}</span>
                <span className="shrink-0 text-[11px] text-slate-400">
                  {audio.beatMarkersSec.length} beats · {audio.durationSec.toFixed(0)}s
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
