import { describe, expect, it } from "vitest";
import { computeTimelineLayout, getAspectDimensions } from "./edl.js";
import {
  buildProjectFromTemplate,
  CUT_TEMPLATE_PRESETS,
  extractTemplateFromProject,
  getTemplatePresetById,
} from "./templates.js";

describe("computeTimelineLayout", () => {
  it("computes cumulative start/end timestamps with xfade overlap clamped safely", () => {
    const layout = computeTimelineLayout({
      clips: [
        {
          id: "c1",
          assetId: "a1",
          sourceStartSec: 0,
          sourceEndSec: 3,
          speed: 1,
          motion: "zoom-in",
          transitionIn: "crossfade",
          transitionDurationSec: 0.5,
          filter: "none",
          muteOriginalAudio: false,
          volume: 1,
        },
        {
          id: "c2",
          assetId: "a2",
          sourceStartSec: 0,
          sourceEndSec: 2,
          speed: 1,
          motion: "none",
          transitionIn: "crossfade",
          transitionDurationSec: 0.4,
          filter: "none",
          muteOriginalAudio: false,
          volume: 1,
        },
        {
          id: "c3",
          assetId: "a1",
          sourceStartSec: 1,
          sourceEndSec: 2,
          speed: 2,
          motion: "punch-zoom",
          transitionIn: "flash-white",
          transitionDurationSec: 0.6,
          filter: "vivid",
          muteOriginalAudio: false,
          volume: 1,
        },
      ],
    });

    // Slot 0 never has transitionIn
    expect(layout.slots[0].effectiveTransitionInSec).toBe(0);
    expect(layout.slots[0].timelineStartSec).toBe(0);
    expect(layout.slots[0].timelineEndSec).toBe(3);

    // Slot 1 overlaps by 0.4s (< 0.4 * min(3, 2) = 0.8)
    expect(layout.slots[1].effectiveTransitionInSec).toBe(0.4);
    expect(layout.slots[1].timelineStartSec).toBe(2.6);
    expect(layout.slots[1].timelineEndSec).toBe(4.6);

    // Slot 2 rawDuration is (2 - 1) / 2 = 0.5s, max transition = 0.5 * 0.4 = 0.2s
    expect(layout.slots[2].rawDurationSec).toBe(0.5);
    expect(layout.slots[2].effectiveTransitionInSec).toBe(0.2);
    expect(layout.slots[2].timelineStartSec).toBe(4.4);
    expect(layout.slots[2].timelineEndSec).toBe(4.9);
    expect(layout.totalDurationSec).toBe(4.9);
  });

  it("maps aspect ratios to exact target pixel dimensions", () => {
    expect(getAspectDimensions("9:16", "1080p")).toEqual({ width: 1080, height: 1920 });
    expect(getAspectDimensions("16:9", "720p")).toEqual({ width: 1280, height: 720 });
    expect(getAspectDimensions("1:1", "1080p")).toEqual({ width: 1080, height: 1080 });
  });

  it("extracts reusable custom templates with stickers/adjustments and rebuilds them cleanly", () => {
    const assetsById = new Map([
      [
        "clip-1",
        {
          id: "clip-1",
          filename: "clip1.mp4",
          originalName: "Clip 1",
          kind: "video" as const,
          mimeType: "video/mp4",
          url: "/api/media/clip-1/stream",
          durationSec: 4,
          hasAudio: false,
          beatMarkersSec: [],
          energyPeaksSec: [],
          silenceRanges: [],
          isBuiltIn: false,
        },
      ],
    ]);

    const preset = getTemplatePresetById("hype-zoom");
    const built = buildProjectFromTemplate({
      template: preset,
      slotAssetIds: ["clip-1"],
      assetsById,
      customTexts: ["MANILA DROP"],
      projectId: "proj-1",
    });

    expect(built.clips.length).toBe(preset.slots.length);
    expect(built.overlays[0]?.text).toBe("MANILA DROP");

    const customized = {
      ...built,
      clips: built.clips.map((c, idx) =>
        idx === 0
          ? {
              ...c,
              reversed: true,
              adjust: { brightness: 0.1, contrast: 0.12, saturation: 0.2, warmth: 0, vignette: 0.2 },
            }
          : c
      ),
      stickers: [
        {
          id: "stk-1",
          stickerId: "fire",
          startSec: 0,
          endSec: 2,
          xNorm: 0.5,
          yNorm: 0.3,
          scale: 1.2,
          rotationDeg: 0,
        },
      ],
    };

    const extracted = { ...extractTemplateFromProject(customized, "Custom Fire"), id: "custom-fire" };
    const resolved = getTemplatePresetById("custom-fire", [extracted, ...CUT_TEMPLATE_PRESETS]);
    expect(resolved.id).toBe("custom-fire");
    expect(resolved.stickers?.length).toBe(1);
    expect(resolved.slots[0]?.reversed).toBe(true);

    const rebuilt = buildProjectFromTemplate({
      template: resolved,
      slotAssetIds: ["clip-1"],
      assetsById,
      projectId: "proj-2",
    });
    expect(rebuilt.clips[0]?.reversed).toBe(true);
    expect(rebuilt.stickers.length).toBe(1);
    expect(rebuilt.clips[0]?.adjust?.brightness).toBe(0.1);
  });
});
