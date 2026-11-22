import { useCallback, useEffect, useRef, useState } from "react";
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
export const AUTOSAVE_STORAGE_KEY = "cutflow_autosave_project";

export interface EditorSelection {
  slotId: string | null;
  audioTrackId: string | null;
  overlayId: string | null;
  stickerId: string | null;
}

interface HistoryState {
  past: CutProject[];
  present: CutProject | null;
  future: CutProject[];
}

function finalizeProject(project: CutProject, prevTotalSec?: number): CutProject {
  const normalizedClips = project.clips.map((c, idx) =>
    idx === 0 ? { ...c, transitionIn: "cut" as const, transitionDurationSec: 0 } : c
  );
  const layout = computeTimelineLayout({ clips: normalizedClips });
  const totalSec = Math.max(0.5, layout.totalDurationSec);

  const rawTracks = getProjectAudioTracks(project).map((tr) => {
    const startSec = Number(
      Math.max(0, Math.min(Math.max(0, totalSec - 0.25), tr.timelineStartSec ?? 0)).toFixed(2)
    );
    const maxRem = Math.max(0.25, totalSec - startSec);
    if (tr.kind === "bgm" && startSec === 0) {
      const matchedPrev =
        tr.durationSec === undefined ||
        (prevTotalSec !== undefined && Math.abs(tr.durationSec - prevTotalSec) < 0.3) ||
        tr.durationSec > totalSec;
      return {
        ...tr,
        timelineStartSec: 0,
        durationSec: matchedPrev
          ? totalSec
          : Number(Math.max(0.4, Math.min(totalSec, tr.durationSec ?? totalSec)).toFixed(2)),
      };
    }
    const nextDur =
      tr.durationSec !== undefined
        ? Number(Math.max(0.2, Math.min(maxRem, tr.durationSec)).toFixed(2))
        : undefined;
    return {
      ...tr,
      timelineStartSec: startSec,
      durationSec: nextDur,
    };
  });

  const overlays = project.overlays.map((o) => {
    const startSec = Number(Math.max(0, Math.min(Math.max(0, totalSec - 0.35), o.startSec)).toFixed(2));
    const endSec = Number(Math.min(totalSec, Math.max(startSec + 0.35, o.endSec)).toFixed(2));
    return { ...o, startSec, endSec };
  });

  const stickers = (project.stickers || []).map((st) => {
    const startSec = Number(Math.max(0, Math.min(Math.max(0, totalSec - 0.35), st.startSec)).toFixed(2));
    const endSec = Number(Math.min(totalSec, Math.max(startSec + 0.35, st.endSec)).toFixed(2));
    return { ...st, startSec, endSec };
  });

  return {
    ...project,
    clips: normalizedClips,
    overlays,
    stickers,
    targetDurationSec: totalSec,
    audioTracks: rawTracks,
    audioTrack: rawTracks[0],
  };
}

export function useEditorStore() {
  const [history, setHistory] = useState<HistoryState>({
    past: [],
    present: null,
    future: [],
  });

  const [selection, setSelection] = useState<EditorSelection>({
    slotId: null,
    audioTrackId: null,
    overlayId: null,
    stickerId: null,
  });

  const presentRef = useRef<CutProject | null>(null);
  presentRef.current = history.present;
  const selectionRef = useRef<EditorSelection>(selection);
  selectionRef.current = selection;

  const gestureBaseRef = useRef<CutProject | null>(null);

  const commit = useCallback(
    (updater: (prev: CutProject) => CutProject, recordHistory = true) => {
      setHistory((h) => {
        if (!h.present) return h;
        const next = finalizeProject(updater(h.present), h.present.targetDurationSec);
        if (!recordHistory) {
          return { ...h, present: next };
        }
        return {
          past: [...h.past.slice(-(MAX_HISTORY - 1)), h.present],
          present: next,
          future: [],
        };
      });
    },
    []
  );

  const beginGesture = useCallback(() => {
    if (!gestureBaseRef.current && presentRef.current) {
      gestureBaseRef.current = presentRef.current;
    }
  }, []);

  const endGesture = useCallback(() => {
    const base = gestureBaseRef.current;
    gestureBaseRef.current = null;
    if (!base) return;
    setHistory((h) => {
      if (!h.present || h.present === base) return h;
      return {
        past: [...h.past.slice(-(MAX_HISTORY - 1)), base],
        present: h.present,
        future: [],
      };
    });
  }, []);

  const loadProject = useCallback((nextProject: CutProject, recordHistory = true) => {
    gestureBaseRef.current = null;
    const finalized = finalizeProject(nextProject);
    setHistory((h) => {
      if (h.present && recordHistory) {
        return {
          past: [...h.past.slice(-(MAX_HISTORY - 1)), h.present],
          present: finalized,
          future: [],
        };
      }
      return {
        past: h.past,
        present: finalized,
        future: [],
      };
    });
    setSelection({
      slotId: finalized.clips[0]?.id ?? null,
      audioTrackId: null,
      overlayId: null,
      stickerId: null,
    });
  }, []);

  const undo = useCallback(() => {
    gestureBaseRef.current = null;
    setHistory((h) => {
      if (h.past.length === 0 || !h.present) return h;
      const previous = h.past[h.past.length - 1];
      return {
        past: h.past.slice(0, -1),
        present: previous,
        future: [h.present, ...h.future.slice(0, MAX_HISTORY - 1)],
      };
    });
  }, []);

  const redo = useCallback(() => {
    gestureBaseRef.current = null;
    setHistory((h) => {
      if (h.future.length === 0) return h;
      const next = h.future[0];
      return {
        past: h.present ? [...h.past.slice(-(MAX_HISTORY - 1)), h.present] : h.past,
        present: next,
        future: h.future.slice(1),
      };
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
      const proj = presentRef.current;
      if (!proj) return;
      const layout = computeTimelineLayout(proj);
      const selectedId = selectionRef.current.slotId;
      const target =
        (selectedId ? layout.slots.find((s) => s.slot.id === selectedId) : undefined) ??
        layout.slots.find(
          (s) => timelineSec >= s.timelineStartSec && timelineSec <= s.timelineEndSec
        );

      if (!target) return;
      const offsetInSlot = timelineSec - target.timelineStartSec;
      if (offsetInSlot < 0.25 || target.rawDurationSec - offsetInSlot < 0.25) {
        return;
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

      const newId = `slot-${Date.now().toString(36)}`;
      const secondHalf: ClipSlot = target.slot.reversed
        ? {
            ...target.slot,
            id: newId,
            sourceEndSec: splitSourceTime,
            transitionIn: "cut",
            transitionDurationSec: 0,
          }
        : {
            ...target.slot,
            id: newId,
            sourceStartSec: splitSourceTime,
            transitionIn: "cut",
            transitionDurationSec: 0,
          };

      commit((prev) => {
        const nextClips = [...prev.clips];
        nextClips.splice(target.index, 1, firstHalf, secondHalf);
        return { ...prev, clips: nextClips };
      });
      selectSlot(newId);
    },
    [commit, selectSlot]
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
      const proj = presentRef.current;
      if (!proj || proj.clips.length <= 1) return;
      commit((prev) => ({
        ...prev,
        clips: prev.clips.filter((c) => c.id !== slotId),
      }));
      const remaining = proj.clips.find((c) => c.id !== slotId);
      selectSlot(remaining?.id ?? null);
    },
    [commit, selectSlot]
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

function computeDefaultStartOffset(asset: MediaAsset): number {
  const firstSilence = asset.silenceRanges[0];
  if (
    firstSilence &&
    firstSilence.startSec <= 0.15 &&
    firstSilence.endSec >= 1.2 &&
    firstSilence.endSec < asset.durationSec - 1
  ) {
    return Number(firstSilence.endSec.toFixed(2));
  }
  return 0;
}

function buildBgmTrack(asset: MediaAsset, totalDurSec: number): AudioTrack {
  return {
    id: `aud-${Date.now().toString(36)}`,
    kind: "bgm",
    assetId: asset.id,
    title: asset.originalName,
    timelineStartSec: 0,
    durationSec: Number(totalDurSec.toFixed(2)),
    startOffsetSec: computeDefaultStartOffset(asset),
    volume: 0.85,
    fadeInSec: 0.25,
    fadeOutSec: 0.7,
    beatMarkersSec: asset.beatMarkersSec,
  };
}

  const appendVisualAsset = useCallback(
    (asset: MediaAsset, pendingAudio?: MediaAsset) => {
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
      if (!presentRef.current) {
        const initialTracks =
          pendingAudio && pendingAudio.kind === "audio"
            ? [buildBgmTrack(pendingAudio, newSlot.sourceEndSec)]
            : [];
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
          audioTrack: initialTracks[0],
          audioTracks: initialTracks,
        });
      } else {
        commit((prev) => ({
          ...prev,
          clips: [...prev.clips, newSlot],
        }));
        selectSlot(newId);
      }
    },
    [loadProject, commit, selectSlot]
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
          startOffsetSec: kind === "bgm" ? computeDefaultStartOffset(asset) : 0,
          volume: kind === "bgm" ? 0.85 : 1.0,
          fadeInSec: kind === "bgm" ? 0.25 : 0.04,
          fadeOutSec: kind === "bgm" ? 0.7 : 0.1,
          beatMarkersSec: asset.beatMarkersSec,
        };

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
    (trackId: string, patch: Partial<AudioTrack>, recordHistory = true) => {
      commit((prev) => {
        const nextTracks = getProjectAudioTracks(prev).map((t) =>
          t.id === trackId ? { ...t, ...patch } : t
        );
        return { ...prev, audioTracks: nextTracks, audioTrack: nextTracks[0] };
      }, recordHistory);
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
      const proj = presentRef.current;
      if (!proj) return;
      const tracks = getProjectAudioTracks(proj);
      const beats = tracks[0]?.beatMarkersSec ?? [];
      if (beats.length < 2) return;

      commit((prev) => {
        let cursor = 0;
        const nextClips = prev.clips.map((slot, idx) => {
          const asset = assetsById.get(slot.assetId);
          const maxAssetDur = asset?.durationSec ?? slot.sourceEndSec;
          const speed = slot.speed || 1;
          const rawDur = Math.max(0.4, (slot.sourceEndSec - slot.sourceStartSec) / speed);

          const targetEnd = cursor + rawDur;
          const forwardBeats = beats.filter((b) => b >= cursor + 0.45);
          const pool = forwardBeats.length > 0 ? forwardBeats : beats;
          const nearestBeat = pool.reduce((best, b) =>
            Math.abs(b - targetEnd) < Math.abs(best - targetEnd) ? b : best
          );
          const snappedDur = Math.max(0.45, nearestBeat - cursor);
          const finalDur = idx === prev.clips.length - 1 ? rawDur : snappedDur;
          const nextEnd = Math.min(maxAssetDur, slot.sourceStartSec + finalDur * speed);
          cursor += (nextEnd - slot.sourceStartSec) / speed;
          return {
            ...slot,
            sourceEndSec: Number(Math.max(slot.sourceStartSec + 0.35, nextEnd).toFixed(2)),
          };
        });
        return { ...prev, clips: nextClips };
      });
    },
    [commit]
  );

  const updateOverlays = useCallback(
    (
      updater: TextOverlay[] | ((prev: TextOverlay[]) => TextOverlay[]),
      recordHistory = true
    ) => {
      commit(
        (prev) => ({
          ...prev,
          overlays: typeof updater === "function" ? updater(prev.overlays) : updater,
        }),
        recordHistory
      );
    },
    [commit]
  );

  const updateStickers = useCallback(
    (
      updater: StickerOverlay[] | ((prev: StickerOverlay[]) => StickerOverlay[]),
      recordHistory = true
    ) => {
      commit(
        (prev) => ({
          ...prev,
          stickers: typeof updater === "function" ? updater(prev.stickers || []) : updater,
        }),
        recordHistory
      );
    },
    [commit]
  );

  const deleteSelection = useCallback(() => {
    const sel = selectionRef.current;
    if (sel.overlayId) {
      updateOverlays((prev) => prev.filter((o) => o.id !== sel.overlayId));
      selectOverlay(null);
      return;
    }
    if (sel.stickerId) {
      updateStickers((prev) => prev.filter((s) => s.id !== sel.stickerId));
      selectSticker(null);
      return;
    }
    if (sel.audioTrackId) {
      deleteAudioTrack(sel.audioTrackId);
      return;
    }
    if (sel.slotId) {
      deleteSlot(sel.slotId);
    }
  }, [updateOverlays, selectOverlay, updateStickers, selectSticker, deleteAudioTrack, deleteSlot]);

  const clearProject = useCallback(() => {
    gestureBaseRef.current = null;
    setHistory({ past: [], present: null, future: [] });
    setSelection({
      slotId: null,
      audioTrackId: null,
      overlayId: null,
      stickerId: null,
    });
    try {
      localStorage.removeItem(AUTOSAVE_STORAGE_KEY);
    } catch {
      // ignore storage errors
    }
  }, []);

  useEffect(() => {
    if (!history.present) return;
    try {
      localStorage.setItem(AUTOSAVE_STORAGE_KEY, JSON.stringify(history.present));
    } catch {
      // ignore storage errors
    }
  }, [history.present]);

  return {
    project: history.present,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    selection,
    commit,
    beginGesture,
    endGesture,
    loadProject,
    clearProject,
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
    deleteSelection,
  };
}
