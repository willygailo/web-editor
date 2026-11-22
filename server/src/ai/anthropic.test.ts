import { describe, expect, it } from "vitest";
import type { MediaAsset } from "@cutflow/shared";
import { generateAnthropicCutProject } from "./anthropic.js";

const mockAssets = new Map<string, MediaAsset>([
  [
    "clip-1",
    {
      id: "clip-1",
      filename: "clip1.mp4",
      originalName: "Sunset Clip",
      kind: "video",
      mimeType: "video/mp4",
      url: "/api/media/clip-1/stream",
      durationSec: 5,
      hasAudio: false,
      beatMarkersSec: [],
      visualHighlightsSec: [],
      energyPeaksSec: [0.5, 2.5],
      silenceRanges: [],
      isBuiltIn: true,
    },
  ],
  [
    "beat-1",
    {
      id: "beat-1",
      filename: "beat.m4a",
      originalName: "Neon Drop",
      kind: "audio",
      mimeType: "audio/mp4",
      url: "/api/media/beat-1/stream",
      durationSec: 20,
      hasAudio: true,
      beatMarkersSec: [0, 0.5, 1.0, 1.5, 2.0],
      visualHighlightsSec: [],
      energyPeaksSec: [],
      silenceRanges: [],
      isBuiltIn: true,
    },
  ],
]);

describe("Anthropic Claude Sonnet 5.5 AI Director", () => {
  it("resolves workspace for sk-ant-usr keys and validates forced tool_use EDL output", async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];

    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      calls.push({ url, headers, body: init?.body as string | undefined });

      if (url.endsWith("/organizations/workspaces")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "wrkspc_test_123", name: "s1shell", archived_at: null }],
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }

      return new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "emit_cut_project",
              input: {
                title: "Siargao Hype",
                templateId: "hype-zoom",
                aiSummary: "Claude Sonnet 5.5 selected 2 high-energy cuts.",
                aspectRatio: "9:16",
                clips: [
                  {
                    assetId: "clip-1",
                    sourceStartSec: 0,
                    sourceEndSec: 1.5,
                    speed: 1,
                    motion: "punch-zoom",
                    transitionIn: "cut",
                    transitionDurationSec: 0,
                    filter: "vivid",
                    muteOriginalAudio: true,
                    volume: 0,
                  },
                  {
                    assetId: "clip-1",
                    sourceStartSec: 2.0,
                    sourceEndSec: 12.0, // deliberately out of bounds to test sanitizer
                    speed: 1,
                    motion: "zoom-in",
                    transitionIn: "flash-white",
                    transitionDurationSec: 0.25,
                    filter: "vivid",
                    muteOriginalAudio: true,
                    volume: 0,
                  },
                ],
                overlays: [
                  {
                    text: "SIARGAO DROP",
                    startSec: 0.1,
                    endSec: 2.2,
                    position: "center",
                    style: "bold-hook",
                  },
                ],
                audioAssetId: "beat-1",
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const result = await generateAnthropicCutProject({
      apiKey: "sk-ant-usr-mock-key",
      model: "claude-sonnet-5-5",
      request: {
        prompt: "Gawa ka ng hype 5s TikTok edit",
        assetIds: ["clip-1"],
        audioAssetId: "beat-1",
        mode: "claude",
        previousProject: {
          id: "prev-1",
          title: "Prev",
          templateId: "hype-zoom",
          promptUsed: "prev",
          modeUsed: "claude",
          aspectRatio: "9:16",
          fps: 30,
          targetDurationSec: 4,
          clips: [
            {
              id: "slot-1",
              assetId: "clip-1",
              sourceStartSec: 0,
              sourceEndSec: 2,
              speed: 1,
              motion: "none",
              transitionIn: "cut",
              transitionDurationSec: 0,
              filter: "none",
              muteOriginalAudio: true,
              volume: 0,
              reversed: false,
            },
          ],
          overlays: [],
          stickers: [
            {
              id: "stk-remix",
              stickerId: "fire",
              startSec: 0,
              endSec: 2,
              xNorm: 0.5,
              yNorm: 0.3,
              scale: 1,
              rotationDeg: 0,
            },
          ],
          audioTracks: [],
        },
      },
      assetsById: mockAssets,
      filePathsById: new Map(),
      fetchFn: mockFetch,
    });

    expect(calls[0].url).toContain("/organizations/workspaces");
    expect(calls[1].headers["anthropic-workspace-id"]).toBe("wrkspc_test_123");
    const sentBody = JSON.parse(calls[1].body ?? "{}") as { model: string };
    expect(sentBody.model).toBe("claude-sonnet-5-5");

    expect(result.project.modeUsed).toBe("claude");
    expect(result.project.clips[1].sourceEndSec).toBeLessThanOrEqual(5);
    expect(result.project.overlays[0]?.text).toBe("SIARGAO DROP");
    expect(result.project.stickers.length).toBe(1);
    expect(result.project.stickers[0]?.id).toBe("stk-remix");
  });

  it("supports platform presets, clamps overlays inside safe zones, merges SFX cues, and attaches social metadata", async () => {
    const assetsWithSfx = new Map(mockAssets);
    assetsWithSfx.set("builtin-sfx-whoosh", {
      id: "builtin-sfx-whoosh",
      filename: "whoosh.m4a",
      originalName: "Whoosh SFX",
      kind: "audio",
      audioCategory: "sfx",
      mimeType: "audio/mp4",
      url: "/api/media/builtin-sfx-whoosh/stream",
      durationSec: 0.6,
      hasAudio: true,
      beatMarkersSec: [],
      visualHighlightsSec: [],
      energyPeaksSec: [0.1],
      silenceRanges: [],
      isBuiltIn: true,
    });

    const mockFetch: typeof fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/organizations/workspaces")) {
        return new Response(
          JSON.stringify({ data: [{ id: "wrkspc_test_123", name: "default", archived_at: null }] }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          content: [
            {
              type: "tool_use",
              name: "emit_cut_project",
              input: {
                title: "TikTok Viral Pro",
                templateId: "tiktok-viral-hook",
                aiSummary: "Directed 3-act TikTok hook edit with whoosh SFX.",
                aspectRatio: "9:16",
                socialCaption: "Wait till the beat drops on this view!",
                hashtags: ["#tiktok", "#siargao", "#travel"],
                clips: [
                  {
                    assetId: "clip-1",
                    sourceStartSec: 0,
                    sourceEndSec: 1.4,
                    speed: 1,
                    motion: "punch-zoom",
                    transitionIn: "cut",
                    transitionDurationSec: 0,
                    filter: "vivid",
                    muteOriginalAudio: true,
                    volume: 0,
                    adjust: { contrast: 1.08, saturation: 1.1, warmth: 0.04, brightness: 0, vignette: 0.1 },
                  },
                  {
                    assetId: "clip-1",
                    sourceStartSec: 1.6,
                    sourceEndSec: 3.4,
                    speed: 1.1,
                    motion: "zoom-in",
                    transitionIn: "flash-white",
                    transitionDurationSec: 0.25,
                    filter: "vivid",
                    muteOriginalAudio: true,
                    volume: 0,
                  },
                ],
                overlays: [
                  {
                    text: "WAIT FOR IT",
                    startSec: 0,
                    endSec: 1.6,
                    position: "bottom",
                    style: "capcut-pop",
                    animation: "pop",
                    yNorm: 0.92,
                  },
                ],
                audioAssetId: "beat-1",
                sfxCues: [{ assetId: "builtin-sfx-whoosh", timelineStartSec: 1.25, volume: 0.7 }],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    };

    const result = await generateAnthropicCutProject({
      apiKey: "sk-ant-usr-mock-key",
      model: "claude-sonnet-5-5",
      request: {
        prompt: "Make a viral TikTok hook edit",
        assetIds: ["clip-1"],
        audioAssetId: "beat-1",
        platform: "tiktok",
        mode: "claude",
      },
      assetsById: assetsWithSfx,
      filePathsById: new Map(),
      fetchFn: mockFetch,
    });

    expect(result.project.platform).toBe("tiktok");
    expect(result.project.aspectRatio).toBe("9:16");
    expect(result.project.socialCaption).toBe("Wait till the beat drops on this view!");
    expect(result.project.hashtags).toEqual(["#tiktok", "#siargao", "#travel"]);
    expect(result.project.overlays[0]?.animation).toBe("pop");
    expect(result.project.overlays[0]?.yNorm).toBeLessThanOrEqual(0.72);
    expect(result.project.audioTracks.some((t) => t.kind === "sfx" && t.assetId === "builtin-sfx-whoosh")).toBe(
      true
    );
  });
});
