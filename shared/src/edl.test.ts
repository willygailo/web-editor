import { describe, expect, it } from "vitest";
import { computeTimelineLayout, getAspectDimensions } from "./edl.js";

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
});
