import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Film,
  Mic,
  Music2,
  Plus,
  Sparkles,
  Square,
  Trash2,
  Upload,
  Zap,
} from "lucide-react";
import {
  getProjectAudioTracks,
  type AudioCategory,
  type AudioTrack,
  type CutProject,
  type MediaAsset,
} from "@cutflow/shared";

interface AudioDrawerProps {
  project: CutProject | null;
  assets: MediaAsset[];
  selectedAudioTrackId: string | null;
  currentTime: number;
  onSelectAudioTrack: (id: string | null) => void;
  onAddAudioTrack: (asset: MediaAsset, kind: AudioCategory, startSec: number) => void;
  onUpdateAudioTrack: (id: string, patch: Partial<AudioTrack>, recordHistory?: boolean) => void;
  onDeleteAudioTrack: (id: string) => void;
  onUploadAudio: (files: File[], autoAddKind?: AudioCategory) => Promise<void>;
  onExtractAudio: (videoAssetId: string) => Promise<void>;
  onSnapCutsToBeats: () => void;
  onBeginSlider?: () => void;
  onEndSlider?: () => void;
}

export function AudioDrawer({
  project,
  assets,
  selectedAudioTrackId,
  currentTime,
  onSelectAudioTrack,
  onAddAudioTrack,
  onUpdateAudioTrack,
  onDeleteAudioTrack,
  onUploadAudio,
  onExtractAudio,
  onSnapCutsToBeats,
  onBeginSlider,
  onEndSlider,
}: AudioDrawerProps) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const timerRef = useRef<number | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const [recordSec, setRecordSec] = useState(0);
  const [extractingId, setExtractingId] = useState<string | null>(null);
  const [recError, setRecError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  const audioAssets = assets.filter((a) => a.kind === "audio");
  const bgmAssets = audioAssets.filter((a) => a.audioCategory !== "sfx");
  const sfxAssets = audioAssets.filter((a) => a.audioCategory === "sfx");
  const videoWithAudio = assets.filter((a) => a.kind === "video" && a.hasAudio);

  const activeTracks = project ? getProjectAudioTracks(project) : [];
  const selectedTrack =
    activeTracks.find((t) => t.id === selectedAudioTrackId) ?? activeTracks[0];
  const selectedTrackAsset = selectedTrack
    ? assets.find((a) => a.id === selectedTrack.assetId)
    : undefined;
  const maxStartOffset = Math.max(
    0,
    Number((((selectedTrackAsset?.durationSec ?? 20) - 0.3)).toFixed(1))
  );

  const startVoiceover = async () => {
    setRecError(null);
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setRecError("Microphone recording is not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const candidateTypes = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ];
      const chosenMime =
        typeof MediaRecorder.isTypeSupported === "function"
          ? candidateTypes.find((t) => MediaRecorder.isTypeSupported(t)) ?? ""
          : "";

      const recorder = chosenMime
        ? new MediaRecorder(stream, { mimeType: chosenMime })
        : new MediaRecorder(stream);
      chunksRef.current = [];

      recorder.ondataavailable = (ev) => {
        if (ev.data.size > 0) chunksRef.current.push(ev.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((tr) => tr.stop());
        streamRef.current = null;
        if (timerRef.current) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
        const actualMime = recorder.mimeType || chosenMime || "audio/webm";
        const ext = actualMime.includes("mp4")
          ? "m4a"
          : actualMime.includes("ogg")
            ? "ogg"
            : "webm";
        const blob = new Blob(chunksRef.current, { type: actualMime });
        if (blob.size > 200) {
          const file = new File([blob], `voiceover-${Date.now()}.${ext}`, {
            type: actualMime,
          });
          await onUploadAudio([file], "voiceover");
        }
        setIsRecording(false);
        setRecordSec(0);
      };

      recorder.start();
      recorderRef.current = recorder;
      setIsRecording(true);
      setRecordSec(0);
      timerRef.current = window.setInterval(() => {
        setRecordSec((s) => Number((s + 0.1).toFixed(1)));
      }, 100);
    } catch {
      setRecError("Microphone permission denied or unavailable.");
    }
  };

  const stopVoiceover = () => {
    recorderRef.current?.stop();
  };

  return (
    <div className="flex flex-col gap-3 text-xs">
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*"
        className="hidden"
        onChange={(e) => {
          const files = e.target.files ? Array.from(e.target.files) : [];
          if (files.length > 0) void onUploadAudio(files, "bgm");
          e.target.value = "";
        }}
      />

      {/* Quick CapCut Audio Actions */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-cyan-500/15 px-2.5 py-2 font-semibold text-cyan-200 ring-1 ring-cyan-400/40 hover:bg-cyan-500/25"
        >
          <Upload className="size-4" aria-hidden="true" />
          <span>Add MP3 / Audio</span>
        </button>

        {isRecording ? (
          <button
            type="button"
            onClick={stopVoiceover}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-rose-500 px-2.5 py-2 font-bold text-white animate-pulse"
          >
            <Square className="size-3.5" aria-hidden="true" />
            <span>Stop ({recordSec.toFixed(1)}s)</span>
          </button>
        ) : (
          <button
            type="button"
            disabled={!project}
            onClick={() => void startVoiceover()}
            className="inline-flex items-center justify-center gap-1.5 rounded-xl bg-rose-500/15 px-2.5 py-2 font-semibold text-rose-200 ring-1 ring-rose-400/40 hover:bg-rose-500/25 disabled:opacity-45"
          >
            <Mic className="size-4" aria-hidden="true" />
            <span>Voiceover</span>
          </button>
        )}
      </div>

      {recError && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-2 text-[11px] text-rose-200">
          {recError}
        </div>
      )}

      {/* Selected Audio Track Inspector */}
      {project && selectedTrack && (
        <section className="flex flex-col gap-2 rounded-2xl border border-cyan-500/40 bg-[#090b10] p-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 truncate font-bold text-cyan-200">
              <AudioLines className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{selectedTrack.title || "Audio Track"}</span>
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] uppercase text-slate-300">
                {selectedTrack.kind}
              </span>
            </div>
            <button
              type="button"
              onClick={() => onDeleteAudioTrack(selectedTrack.id)}
              aria-label="Remove audio track"
              className="rounded-lg p-1 text-rose-300 hover:bg-rose-500/15"
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
            </button>
          </div>

          <label className="flex flex-col gap-0.5 text-[11px] text-slate-300">
            <span>Volume ({Math.round(selectedTrack.volume * 100)}%)</span>
            <input
              type="range"
              min={0}
              max={2}
              step={0.05}
              value={selectedTrack.volume}
              onPointerDown={onBeginSlider}
              onPointerUp={onEndSlider}
              onBlur={onEndSlider}
              onChange={(e) =>
                onUpdateAudioTrack(selectedTrack.id, { volume: Number(e.target.value) }, false)
              }
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-0.5 text-[11px] text-slate-300">
              <span>Song Start ({selectedTrack.startOffsetSec.toFixed(1)}s)</span>
              <input
                type="range"
                min={0}
                max={maxStartOffset}
                step={0.1}
                value={Math.min(maxStartOffset, selectedTrack.startOffsetSec)}
                onPointerDown={onBeginSlider}
                onPointerUp={onEndSlider}
                onBlur={onEndSlider}
                onChange={(e) =>
                  onUpdateAudioTrack(
                    selectedTrack.id,
                    { startOffsetSec: Number(e.target.value) },
                    false
                  )
                }
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] text-slate-300">
              <span>Timeline Start ({selectedTrack.timelineStartSec.toFixed(1)}s)</span>
              <input
                type="range"
                min={0}
                max={Math.max(0, project.targetDurationSec - 0.3)}
                step={0.1}
                value={selectedTrack.timelineStartSec}
                onPointerDown={onBeginSlider}
                onPointerUp={onEndSlider}
                onBlur={onEndSlider}
                onChange={(e) =>
                  onUpdateAudioTrack(
                    selectedTrack.id,
                    { timelineStartSec: Number(e.target.value) },
                    false
                  )
                }
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] text-slate-300">
              <span>
                Track Length (
                {(selectedTrack.durationSec ?? project.targetDurationSec).toFixed(1)}s)
              </span>
              <input
                type="range"
                min={0.3}
                max={Math.max(0.4, project.targetDurationSec - selectedTrack.timelineStartSec)}
                step={0.1}
                value={
                  selectedTrack.durationSec ??
                  Math.max(0.4, project.targetDurationSec - selectedTrack.timelineStartSec)
                }
                onPointerDown={onBeginSlider}
                onPointerUp={onEndSlider}
                onBlur={onEndSlider}
                onChange={(e) =>
                  onUpdateAudioTrack(
                    selectedTrack.id,
                    { durationSec: Number(e.target.value) },
                    false
                  )
                }
              />
            </label>
            <label className="flex flex-col gap-0.5 text-[11px] text-slate-300">
              <span>Fade In / Out ({selectedTrack.fadeInSec.toFixed(1)}s / {selectedTrack.fadeOutSec.toFixed(1)}s)</span>
              <div className="grid grid-cols-2 gap-1.5">
                <input
                  type="range"
                  aria-label="Fade in seconds"
                  min={0}
                  max={2}
                  step={0.1}
                  value={selectedTrack.fadeInSec}
                  onPointerDown={onBeginSlider}
                  onPointerUp={onEndSlider}
                  onBlur={onEndSlider}
                  onChange={(e) =>
                    onUpdateAudioTrack(
                      selectedTrack.id,
                      { fadeInSec: Number(e.target.value) },
                      false
                    )
                  }
                />
                <input
                  type="range"
                  aria-label="Fade out seconds"
                  min={0}
                  max={3}
                  step={0.1}
                  value={selectedTrack.fadeOutSec}
                  onPointerDown={onBeginSlider}
                  onPointerUp={onEndSlider}
                  onBlur={onEndSlider}
                  onChange={(e) =>
                    onUpdateAudioTrack(
                      selectedTrack.id,
                      { fadeOutSec: Number(e.target.value) },
                      false
                    )
                  }
                />
              </div>
            </label>
          </div>

          <div className="flex flex-wrap gap-1.5 pt-1">
            <button
              type="button"
              onClick={() => {
                const nextBeats = Array.from(
                  new Set([
                    ...selectedTrack.beatMarkersSec,
                    Number(currentTime.toFixed(2)),
                  ])
                ).sort((a, b) => a - b);
                onUpdateAudioTrack(selectedTrack.id, { beatMarkersSec: nextBeats });
              }}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-[#111520] px-2.5 py-1 text-[11px] font-semibold text-slate-200 hover:border-cyan-400"
            >
              <Plus className="size-3" aria-hidden="true" />
              Beat @ {currentTime.toFixed(1)}s
            </button>

            {selectedTrack.beatMarkersSec.length >= 2 && (
              <button
                type="button"
                onClick={onSnapCutsToBeats}
                className="inline-flex items-center gap-1 rounded-lg bg-amber-400/20 px-2.5 py-1 text-[11px] font-bold text-amber-200 hover:bg-amber-400/30"
              >
                <Sparkles className="size-3" aria-hidden="true" />
                Snap Cuts to Beats
              </button>
            )}
          </div>
        </section>
      )}

      {/* Active Timeline Audio Tracks List */}
      {activeTracks.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-semibold text-slate-400">
            On Timeline ({activeTracks.length})
          </span>
          {activeTracks.map((tr) => (
            <button
              key={tr.id}
              type="button"
              onClick={() => onSelectAudioTrack(tr.id)}
              className={`flex items-center justify-between rounded-xl border px-2.5 py-1.5 text-left ${
                selectedTrack?.id === tr.id
                  ? "border-cyan-400 bg-cyan-500/15 text-cyan-100"
                  : "border-slate-800 bg-[#090b10] text-slate-300"
              }`}
            >
              <span className="truncate font-medium">
                [{tr.kind.toUpperCase()}] {tr.title}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-slate-400">
                @{tr.timelineStartSec.toFixed(1)}s
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Music Library */}
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-slate-300">
          <Music2 className="size-3.5 text-rose-400" aria-hidden="true" />
          <span>Music Library</span>
        </div>
        <div className="flex flex-col gap-1.5">
          {bgmAssets.map((audio) => (
            <div
              key={audio.id}
              className="flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#090b10] px-2.5 py-1.5"
            >
              <div className="min-w-0">
                <div className="truncate font-medium text-slate-200">{audio.originalName}</div>
                <div className="text-[10px] text-slate-400">
                  {audio.beatMarkersSec.length} beats · {audio.durationSec.toFixed(1)}s
                </div>
              </div>
              <button
                type="button"
                disabled={!project}
                onClick={() => onAddAudioTrack(audio, "bgm", 0)}
                className="shrink-0 rounded-lg bg-rose-500/20 px-2.5 py-1 text-[11px] font-bold text-rose-200 hover:bg-rose-500/30 disabled:opacity-40"
              >
                Use BGM
              </button>
            </div>
          ))}
        </div>
      </div>

      {/* Sound Effects */}
      <div>
        <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-slate-300">
          <Zap className="size-3.5 text-amber-400" aria-hidden="true" />
          <span>Sound Effects (adds @ playhead {currentTime.toFixed(1)}s)</span>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {sfxAssets.map((sfx) => (
            <button
              key={sfx.id}
              type="button"
              disabled={!project}
              onClick={() => onAddAudioTrack(sfx, "sfx", currentTime)}
              className="inline-flex items-center gap-1 rounded-xl border border-slate-700 bg-[#090b10] px-2.5 py-1.5 text-[11px] font-medium text-slate-200 hover:border-amber-400 disabled:opacity-40"
            >
              <Plus className="size-3 text-amber-400" aria-hidden="true" />
              {sfx.originalName.replace(/^SFX:\s*/, "")}
            </button>
          ))}
        </div>
      </div>

      {/* Extract Audio from Video Clips */}
      {videoWithAudio.length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center gap-1.5 font-semibold text-slate-300">
            <Film className="size-3.5 text-cyan-400" aria-hidden="true" />
            <span>Extract Audio from Video</span>
          </div>
          <div className="flex flex-col gap-1.5">
            {videoWithAudio.map((vid) => (
              <div
                key={vid.id}
                className="flex items-center justify-between gap-2 rounded-xl border border-slate-800 bg-[#090b10] px-2.5 py-1.5"
              >
                <span className="truncate text-slate-300">{vid.originalName}</span>
                <button
                  type="button"
                  disabled={extractingId === vid.id}
                  onClick={async () => {
                    setExtractingId(vid.id);
                    try {
                      await onExtractAudio(vid.id);
                    } finally {
                      setExtractingId(null);
                    }
                  }}
                  className="shrink-0 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-2 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-50"
                >
                  {extractingId === vid.id ? "Extracting..." : "Extract"}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
