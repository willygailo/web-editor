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
  });
});
