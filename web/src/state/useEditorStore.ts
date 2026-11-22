import { useCallback, useState } from "react";
import {
  computeTimelineLayout,
  getProjectAudioTracks,
  type AudioCategory,
  type AudioTrack,
  type ClipSlot,
  type CutProject,
  type MediaAsset,
  type StickerOverlay,
  type TextOverlay,
} from "@cutflow/shared";

const MAX_HISTORY = 45;

export interface EditorSelection {
  slotId: string | null;
  audioTrackId: string | null;
  overlayId: string | null;
  stickerId: string | null;
}

function finalizeProject(project: CutProject): CutProject {
  const normalizedClips = project.clips.map((c, idx) =>
    idx === 0
      ? { ...c, transitionIn: "cut" as const, transitionDurationSec: 0 }
      : c
  );
  const layout = computeTimelineLayout({ clips: normalizedClips });
  const tracks = getProjectAudioTracks(project);
  return {
    ...project,
    clips: normalizedClips,
    targetDurationSec: layout.totalDurationSec,
    audioTracks: tracks,
    audioTrack: tracks[0],
  };
}

export function useEditorStore() {
  const [past, setPast] = useState<CutProject[]>([]);
  const [project, setProjectState] = useState<CutProject | null>(null);
  const [future, setFuture] = useState<CutProject[]>([]);

  const [selection, setSelection] = useState<EditorSelection>({
    slotId: null,
    audioTrackId: null,
    overlayId: null,
    stickerId: null,
  });

  const commit = useCallback(
    (updater: (prev: CutProject) => CutProject, recordHistory = true) => {
      setProjectState((prev) => {
        if (!prev) return prev;
        const next = finalizeProject(updater(prev));
        if (recordHistory) {
          setPast((p) => [...p.slice(-(MAX_HISTORY - 1)), prev]);
          setFuture([]);
        }
        return next;
      });
    },
    []
  );

  const loadProject = useCallback((nextProject: CutProject, recordHistory = true) => {
    const finalized = finalizeProject(nextProject);
    setProjectState((prev) => {
      if (prev && recordHistory) {
        setPast((p) => [...p.slice(-(MAX_HISTORY - 1)), prev]);
        setFuture([]);
      }
      return finalized;
    });
    setSelection({
      slotId: finalized.clips[0]?.id ?? null,
      audioTrackId: null,
      overlayId: null,
      stickerId: null,
    });
  }, []);

  const undo = useCallback(() => {
    setPast((p) => {
      if (p.length === 0) return p;
      const previous = p[p.length - 1];
      setProjectState((curr) => {
        if (curr) setFuture((f) => [curr, ...f.slice(0, MAX_HISTORY - 1)]);
        return previous;
      });
      return p.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((f) => {
      if (f.length === 0) return f;
      const next = f[0];
      setProjectState((curr) => {
        if (curr) setPast((p) => [...p.slice(-(MAX_HISTORY - 1)), curr]);
        return next;
      });
      return f.slice(1);
    });
  }, []);

  const selectSlot = useCallback((slotId: string | null) => {
    setSelection({ slotId, audioTrackId: null, overlayId: null, stickerId: null });
  }, []);

  const selectAudioTrack = useCallback((audioTrackId: string | null) => {
    setSelection({ slotId: null, audioTrackId, overlayId: null, stickerId: null });
  }, []);

  const selectOverlay = useCallback((overlayId: string | null) => {
    setSelection({ slotId: null, audioTrackId: null, overlayId, stickerId: null });
  }, []);

  const selectSticker = useCallback((stickerId: string | null) => {
    setSelection({ slotId: null, audioTrackId: null, overlayId: null, stickerId });
  }, []);

  const updateSlot = useCallback(
    (slotId: string, patch: Partial<ClipSlot>, recordHistory = true) => {
      commit(
        (prev) => ({
          ...prev,
          clips: prev.clips.map((c) => (c.id === slotId ? { ...c, ...patch } : c)),
        }),
        recordHistory
      );
    },
    [commit]
  );

  const splitAtPlayhead = useCallback(
    (timelineSec: number) => {
      if (!project) return;
      const layout = computeTimelineLayout(project);
      const target =
        (selection.slotId
          ? layout.slots.find((s) => s.slot.id === selection.slotId)
          : undefined) ??
        layout.slots.find(
          (s) => timelineSec >= s.timelineStartSec && timelineSec <= s.timelineEndSec
        );

      if (!target) return;
      const offsetInSlot = timelineSec - target.timelineStartSec;
      if (offsetInSlot < 0.25 || target.rawDurationSec - offsetInSlot < 0.25) {
        return; // too close to edge to split cleanly
      }

      const speed = target.slot.speed || 1;
      const splitSourceTime = target.slot.reversed
        ? Number((target.slot.sourceEndSec - offsetInSlot * speed).toFixed(2))
        : Number((target.slot.sourceStartSec + offsetInSlot * speed).toFixed(2));

      if (
        splitSourceTime <= target.slot.sourceStartSec + 0.15 ||
        splitSourceTime >= target.slot.sourceEndSec - 0.15
      ) {
        return;
      }

      const firstHalf: ClipSlot = target.slot.reversed
        ? { ...target.slot, sourceStartSec: splitSourceTime }
        : { ...target.slot, sourceEndSec: splitSourceTime };

      const secondHalf: ClipSlot = target.slot.reversed
        ? {
            ...target.slot,
            id: `slot-${Date.now().toString(36)}`,
            sourceEndSec: splitSourceTime,
            transitionIn: "cut",
            transitionDurationSec: 0,
          }
        : {
            ...target.slot,
            id: `slot-${Date.now().toString(36)}`,
            sourceStartSec: splitSourceTime,
            transitionIn: "cut",
            transitionDurationSec: 0,
          };

      commit((prev) => {
        const nextClips = [...prev.clips];
        nextClips.splice(target.index, 1, firstHalf, secondHalf);
        return { ...prev, clips: nextClips };
      });
      selectSlot(secondHalf.id);
    },
    [project, selection.slotId, commit, selectSlot]
  );

  const duplicateSlot = useCallback(
    (slotId: string) => {
      const cloneId = `slot-${Date.now().toString(36)}`;
      commit((prev) => {
        const idx = prev.clips.findIndex((c) => c.id === slotId);
        if (idx === -1) return prev;
        const copy: ClipSlot = {
          ...prev.clips[idx],
          id: cloneId,
          transitionIn: "cut",
          transitionDurationSec: 0,
        };
        const next = [...prev.clips];
        next.splice(idx + 1, 0, copy);
        return { ...prev, clips: next };
      });
      selectSlot(cloneId);
    },
    [commit, selectSlot]
  );

  const deleteSlot = useCallback(
    (slotId: string) => {
      if (!project || project.clips.length <= 1) return;
      commit((prev) => ({
        ...prev,
        clips: prev.clips.filter((c) => c.id !== slotId),
      }));
      const remaining = project.clips.find((c) => c.id !== slotId);
      selectSlot(remaining?.id ?? null);
    },
    [project, commit, selectSlot]
  );

  const moveSlot = useCallback(
    (slotId: string, dir: -1 | 1) => {
      commit((prev) => {
        const idx = prev.clips.findIndex((c) => c.id === slotId);
        const target = idx + dir;
        if (idx === -1 || target < 0 || target >= prev.clips.length) return prev;
        const copy = [...prev.clips];
        const [item] = copy.splice(idx, 1);
        copy.splice(target, 0, item);
        return { ...prev, clips: copy };
      });
    },
    [commit]
  );

  const replaceSlotAsset = useCallback(
    (slotId: string, asset: MediaAsset) => {
      commit((prev) => ({
        ...prev,
        clips: prev.clips.map((c) => {
          if (c.id !== slotId) return c;
          const desiredSpan = Math.max(0.4, c.sourceEndSec - c.sourceStartSec);
          const boundedEnd = Math.min(asset.durationSec, desiredSpan);
          return {
            ...c,
            assetId: asset.id,
            sourceStartSec: 0,
            sourceEndSec: Number(Math.max(0.4, boundedEnd).toFixed(2)),
            reversed: false,
            label: asset.originalName,
          };
        }),
      }));
    },
    [commit]
  );

  const appendVisualAsset = useCallback(
    (asset: MediaAsset) => {
      const newId = `slot-${Date.now().toString(36)}`;
      const newSlot: ClipSlot = {
        id: newId,
        assetId: asset.id,
        sourceStartSec: 0,
        sourceEndSec: Number(Math.min(asset.durationSec, 3.0).toFixed(2)),
        speed: 1,
        motion: "zoom-in",
        transitionIn: "crossfade",
        transitionDurationSec: 0.25,
        filter: "none",
        muteOriginalAudio: false,
        volume: 1,
        reversed: false,
        label: asset.originalName,
      };
      if (!project) {
        loadProject({
          id: crypto.randomUUID(),
          title: asset.originalName,
          templateId: "custom",
          promptUsed: "",
          modeUsed: "template",
          aspectRatio:
            asset.width && asset.height && asset.width > asset.height ? "16:9" : "9:16",
          fps: 30,
          targetDurationSec: newSlot.sourceEndSec,
          clips: [newSlot],
          overlays: [],
          stickers: [],
          audioTracks: [],
        });
      } else {
        commit((prev) => ({
          ...prev,
          clips: [...prev.clips, newSlot],
        }));
        selectSlot(newId);
      }
    },
    [project, loadProject, commit, selectSlot]
  );

  const addAudioTrack = useCallback(
    (asset: MediaAsset, kind: AudioCategory, timelineStartSec = 0) => {
      const id = `aud-${Date.now().toString(36)}`;
      commit((prev) => {
        const existing = getProjectAudioTracks(prev);
        const total = computeTimelineLayout(prev).totalDurationSec;
        const start = kind === "bgm" ? 0 : Math.max(0, Math.min(total - 0.3, timelineStartSec));
        const dur =
          kind === "bgm"
            ? total
            : Math.min(asset.durationSec, Math.max(0.3, total - start));

        const nextTrack: AudioTrack = {
          id,
          kind,
          assetId: asset.id,
          title: asset.originalName,
          timelineStartSec: Number(start.toFixed(2)),
          durationSec: Number(dur.toFixed(2)),
          startOffsetSec: 0,
          volume: kind === "bgm" ? 0.85 : 1.0,
          fadeInSec: kind === "bgm" ? 0.25 : 0.04,
          fadeOutSec: kind === "bgm" ? 0.7 : 0.1,
          beatMarkersSec: asset.beatMarkersSec,
        };

        // Replace main BGM if adding a new BGM; stack SFX & voiceovers!
        const nextTracks =
          kind === "bgm"
            ? [nextTrack, ...existing.filter((t) => t.kind !== "bgm")]
            : [...existing, nextTrack];

        return {
          ...prev,
          audioTracks: nextTracks,
          audioTrack: nextTracks[0],
        };
      });
      selectAudioTrack(id);
    },
    [commit, selectAudioTrack]
  );

  const updateAudioTrack = useCallback(
    (trackId: string, patch: Partial<AudioTrack>) => {
      commit((prev) => {
        const nextTracks = getProjectAudioTracks(prev).map((t) =>
          t.id === trackId ? { ...t, ...patch } : t
        );
        return { ...prev, audioTracks: nextTracks, audioTrack: nextTracks[0] };
      });
    },
    [commit]
  );

  const deleteAudioTrack = useCallback(
    (trackId: string) => {
      commit((prev) => {
        const nextTracks = getProjectAudioTracks(prev).filter((t) => t.id !== trackId);
        return { ...prev, audioTracks: nextTracks, audioTrack: nextTracks[0] };
      });
      setSelection((s) => ({ ...s, audioTrackId: null }));
    },
    [commit]
  );

  const snapCutsToBeats = useCallback(
    (assetsById: Map<string, MediaAsset>) => {
      if (!project) return;
      const tracks = getProjectAudioTracks(project);
      const beats = tracks[0]?.beatMarkersSec ?? [];
      if (beats.length < 2) return;

      commit((prev) => {
        let cursor = 0;
        const nextClips = prev.clips.map((slot, idx) => {
          const asset = assetsById.get(slot.assetId);
          const maxAssetDur = asset?.durationSec ?? slot.sourceEndSec;
          const rawDur = Math.max(0.4, (slot.sourceEndSec - slot.sourceStartSec) / (slot.speed || 1));

          const targetEnd = cursor + rawDur;
          const nearestBeat = beats.reduce((best, b) =>
            Math.abs(b - targetEnd) < Math.abs(best - targetEnd) ? b : best
          );
          const snappedDur = Math.max(0.5, nearestBeat - cursor);
          const finalDur = idx === prev.clips.length - 1 ? rawDur : snappedDur;
          const nextEnd = Math.min(
            maxAssetDur,
            slot.sourceStartSec + finalDur * (slot.speed || 1)
          );
          cursor += (nextEnd - slot.sourceStartSec) / (slot.speed || 1);
          return {
            ...slot,
            sourceEndSec: Number(Math.max(slot.sourceStartSec + 0.35, nextEnd).toFixed(2)),
          };
        });
        return { ...prev, clips: nextClips };
      });
    },
    [project, commit]
  );

  const updateOverlays = useCallback(
    (overlays: TextOverlay[], recordHistory = true) => {
      commit((prev) => ({ ...prev, overlays }), recordHistory);
    },
    [commit]
  );

  const updateStickers = useCallback(
    (stickers: StickerOverlay[], recordHistory = true) => {
      commit((prev) => ({ ...prev, stickers }), recordHistory);
    },
    [commit]
  );

  return {
    project,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    selection,
    commit,
    loadProject,
    undo,
    redo,
    selectSlot,
    selectAudioTrack,
    selectOverlay,
    selectSticker,
    updateSlot,
    splitAtPlayhead,
    duplicateSlot,
    deleteSlot,
    moveSlot,
    replaceSlotAsset,
    appendVisualAsset,
    addAudioTrack,
    updateAudioTrack,
    deleteAudioTrack,
    snapCutsToBeats,
    updateOverlays,
    updateStickers,
  };
}
