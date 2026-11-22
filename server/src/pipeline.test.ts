import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CutProjectSchema, type MediaAsset } from "@cutflow/shared";
import { generateOfflineCutProject } from "./ai/offline.js";
import { runProcess } from "./media/exec.js";
import { probeMediaFile } from "./media/probe.js";
import { buildFfmpegRenderPlan } from "./render/ffmpegGraph.js";
import { generateAssSubtitles } from "./render/subtitles.js";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cutflow test "));

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("Offline AI Director & FFmpeg Render Pipeline", () => {
  it("parses Taglish prompt, generates beat-synced EDL, and renders valid MP4 with ASS overlays", async () => {
    const clip1Path = path.join(tempRoot, "clip1.mp4");
    const clip2Path = path.join(tempRoot, "clip2.mp4");
    const musicPath = path.join(tempRoot, "music.wav");
    const assPath = path.join(tempRoot, "overlays file.ass");
    const outPath = path.join(tempRoot, "final output.mp4");

    // Generate two synthetic test clips and a short audio track
    const gen1 = await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=crimson:s=720x1280:d=3:r=30",
      "-f", "lavfi", "-i", "sine=frequency=220:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", clip1Path,
    ]);
    const gen2 = await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=teal:s=1280x720:d=3:r=30",
      "-f", "lavfi", "-i", "sine=frequency=330:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", clip2Path,
    ]);
    const genAudio = await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=10",
      "-c:a", "pcm_s16le", musicPath,
    ]);
    expect(gen1.code).toBe(0);
    expect(gen2.code).toBe(0);
    expect(genAudio.code).toBe(0);

    const p1 = await probeMediaFile(clip1Path, "video");
    const p2 = await probeMediaFile(clip2Path, "video");

    const assets: MediaAsset[] = [
      {
        id: "v1",
        filename: "clip1.mp4",
        originalName: "Clip 1",
        kind: "video",
        mimeType: "video/mp4",
        url: "/api/media/v1/stream",
        durationSec: p1.durationSec,
        width: p1.width,
        height: p1.height,
        fps: p1.fps,
        hasAudio: true,
        beatMarkersSec: [],
        energyPeaksSec: [0.5, 1.8],
        silenceRanges: [],
        isBuiltIn: false,
      },
      {
        id: "v2",
        filename: "clip2.mp4",
        originalName: "Clip 2",
        kind: "video",
        mimeType: "video/mp4",
        url: "/api/media/v2/stream",
        durationSec: p2.durationSec,
        width: p2.width,
        height: p2.height,
        fps: p2.fps,
        hasAudio: true,
        beatMarkersSec: [],
        energyPeaksSec: [0.4, 2.0],
        silenceRanges: [],
        isBuiltIn: false,
      },
      {
        id: "m1",
        filename: "music.wav",
        originalName: "Hype Beat",
        kind: "audio",
        mimeType: "audio/wav",
        url: "/api/media/m1/stream",
        durationSec: 10,
        hasAudio: true,
        beatMarkersSec: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5],
        energyPeaksSec: [0, 0.5, 1, 1.5, 2],
        silenceRanges: [],
        isBuiltIn: true,
      },
    ];

    const assetsById = new Map(assets.map((a) => [a.id, a]));
    const filePathsById = new Map<string, string>([
      ["v1", clip1Path],
      ["v2", clip2Path],
      ["m1", musicPath],
    ]);

    const { project } = generateOfflineCutProject(
      {
        prompt: 'Gawa ka ng hype 5s TikTok edit with smooth zoom "SIARGAO"',
        assetIds: ["v1", "v2"],
        audioAssetId: "m1",
        mode: "offline",
      },
      assetsById
    );

    expect(project.aspectRatio).toBe("9:16");
    expect(project.clips.length).toBeGreaterThanOrEqual(2);
    expect(project.overlays[0]?.text).toBe("SIARGAO");

    const ass = generateAssSubtitles(project.overlays, project.aspectRatio, "720p");
    fs.writeFileSync(assPath, ass, "utf8");

    const plan = buildFfmpegRenderPlan({
      project,
      quality: "720p",
      assetsById,
      filePathsById,
      outputPath: outPath,
      assSubtitlePath: assPath,
    });

    const renderRes = await runProcess("ffmpeg", plan.args, { timeoutMs: 60_000 });
    expect(renderRes.code, renderRes.stderr).toBe(0);
    expect(fs.existsSync(outPath)).toBe(true);

    const finalProbe = await probeMediaFile(outPath, "video");
    expect(finalProbe.width).toBe(720);
    expect(finalProbe.height).toBe(1280);
    expect(finalProbe.hasAudio).toBe(true);
    expect(finalProbe.durationSec).toBeGreaterThan(3.5);
    expect(finalProbe.durationSec).toBeLessThan(7.0);
  }, 60_000);

  it("handles mixed image + video + cut + crossfade + unmuted clip audio cleanly", async () => {
    const imgPath = path.join(tempRoot, "photo.png");
    const vidPath = path.join(tempRoot, "clip3.mp4");
    const outPath = path.join(tempRoot, "mixed-output.mp4");

    const genImg = await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=royalblue:s=1080x1080:d=1",
      "-frames:v", "1", imgPath,
    ]);
    const genVid = await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=gold:s=1280x720:d=2:r=30",
      "-f", "lavfi", "-i", "sine=frequency=520:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", vidPath,
    ]);
    expect(genImg.code).toBe(0);
    expect(genVid.code).toBe(0);

    const assets: MediaAsset[] = [
      {
        id: "img1",
        filename: "photo.png",
        originalName: "Photo",
        kind: "image",
        mimeType: "image/png",
        url: "/api/media/img1/stream",
        durationSec: 6,
        width: 1080,
        height: 1080,
        hasAudio: false,
        beatMarkersSec: [],
        energyPeaksSec: [],
        silenceRanges: [],
        isBuiltIn: false,
      },
      {
        id: "vid3",
        filename: "clip3.mp4",
        originalName: "Video 3",
        kind: "video",
        mimeType: "video/mp4",
        url: "/api/media/vid3/stream",
        durationSec: 2,
        width: 1280,
        height: 720,
        fps: 30,
        hasAudio: true,
        beatMarkersSec: [],
        energyPeaksSec: [],
        silenceRanges: [],
        isBuiltIn: false,
      },
    ];

    const assetsById = new Map(assets.map((a) => [a.id, a]));
    const filePathsById = new Map([
      ["img1", imgPath],
      ["vid3", vidPath],
    ]);

    const plan = buildFfmpegRenderPlan({
      project: CutProjectSchema.parse({
        id: "p-mixed",
        title: "Mixed Test",
        templateId: "chill-vlog",
        promptUsed: "mixed",
        modeUsed: "offline",
        aspectRatio: "1:1",
        fps: 30,
        targetDurationSec: 4,
        clips: [
          {
            id: "s1",
            assetId: "img1",
            sourceStartSec: 0,
            sourceEndSec: 1.5,
            speed: 1,
            motion: "pan-right",
            transitionIn: "cut",
            transitionDurationSec: 0,
            filter: "warm-film",
            muteOriginalAudio: true,
            volume: 0,
          },
          {
            id: "s2",
            assetId: "vid3",
            sourceStartSec: 0,
            sourceEndSec: 1.5,
            speed: 1,
            motion: "none",
            transitionIn: "cut",
            transitionDurationSec: 0,
            filter: "cinematic",
            muteOriginalAudio: false,
            volume: 1,
          },
          {
            id: "s3",
            assetId: "vid3",
            sourceStartSec: 0.2,
            sourceEndSec: 1.6,
            speed: 1.2,
            motion: "zoom-out",
            transitionIn: "crossfade",
            transitionDurationSec: 0.35,
            filter: "bw-contrast",
            muteOriginalAudio: false,
            volume: 0.8,
          },
        ],
        overlays: [],
      }),
      quality: "720p",
      assetsById,
      filePathsById,
      outputPath: outPath,
    });

    const renderRes = await runProcess("ffmpeg", plan.args, { timeoutMs: 60_000 });
    expect(renderRes.code, renderRes.stderr).toBe(0);
    const outProbe = await probeMediaFile(outPath, "video");
    expect(outProbe.width).toBe(720);
    expect(outProbe.height).toBe(720);
    expect(outProbe.hasAudio).toBe(true);
  }, 60_000);

  it("renders CapCut V2 features: reversed clip, color adjust, transform, stickers, positioned text, and multi-track audio", async () => {
    const vidPath = path.join(tempRoot, "v2-clip.mp4");
    const bgmPath = path.join(tempRoot, "v2-bgm.wav");
    const sfxPath = path.join(tempRoot, "v2-sfx.wav");
    const assPath = path.join(tempRoot, "v2-subs.ass");
    const outPath = path.join(tempRoot, "v2-output.mp4");
    const builtinsDir = path.join(tempRoot, "builtins");

    await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "testsrc2=s=720x1280:d=3:r=30",
      "-f", "lavfi", "-i", "sine=frequency=300:duration=3",
      "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", vidPath,
    ]);
    await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=4",
      "-c:a", "pcm_s16le", bgmPath,
    ]);
    await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=0.6",
      "-c:a", "pcm_s16le", sfxPath,
    ]);

    const assetsById = new Map<string, MediaAsset>([
      [
        "v-src",
        {
          id: "v-src",
          filename: "v2-clip.mp4",
          originalName: "V2 Clip",
          kind: "video",
          mimeType: "video/mp4",
          url: "/api/media/v-src/stream",
          durationSec: 3,
          width: 720,
          height: 1280,
          fps: 30,
          hasAudio: true,
          beatMarkersSec: [],
          energyPeaksSec: [],
          silenceRanges: [],
          isBuiltIn: false,
        },
      ],
      [
        "bgm-src",
        {
          id: "bgm-src",
          filename: "v2-bgm.wav",
          originalName: "BGM",
          kind: "audio",
          audioCategory: "bgm",
          mimeType: "audio/wav",
          url: "/api/media/bgm-src/stream",
          durationSec: 4,
          hasAudio: true,
          beatMarkersSec: [0, 0.5, 1, 1.5],
          energyPeaksSec: [],
          silenceRanges: [],
          isBuiltIn: true,
        },
      ],
      [
        "sfx-src",
        {
          id: "sfx-src",
          filename: "v2-sfx.wav",
          originalName: "Whoosh",
          kind: "audio",
          audioCategory: "sfx",
          mimeType: "audio/wav",
          url: "/api/media/sfx-src/stream",
          durationSec: 0.6,
          hasAudio: true,
          beatMarkersSec: [],
          energyPeaksSec: [],
          silenceRanges: [],
          isBuiltIn: true,
        },
      ],
    ]);

    const filePathsById = new Map([
      ["v-src", vidPath],
      ["bgm-src", bgmPath],
      ["sfx-src", sfxPath],
    ]);

    const project = CutProjectSchema.parse({
      id: "p-v2",
      title: "V2 Render",
      templateId: "hype-zoom",
      promptUsed: "v2 test",
      modeUsed: "template",
      aspectRatio: "9:16",
      fps: 30,
      targetDurationSec: 3,
      clips: [
        {
          id: "slot-1",
          assetId: "v-src",
          sourceStartSec: 0,
          sourceEndSec: 1.5,
          speed: 1,
          motion: "zoom-in",
          transitionIn: "cut",
          transitionDurationSec: 0,
          filter: "vivid",
          muteOriginalAudio: true,
          volume: 0,
          reversed: true,
          adjust: { brightness: 0.05, contrast: 0.1, saturation: 0.2, warmth: 0.08, vignette: 0.4 },
          transform: { scale: 1.1, offsetX: 0.05, offsetY: -0.05, rotationDeg: 4 },
        },
        {
          id: "slot-2",
          assetId: "v-src",
          sourceStartSec: 1.0,
          sourceEndSec: 2.5,
          speed: 1,
          motion: "punch-zoom",
          transitionIn: "flash-white",
          transitionDurationSec: 0.25,
          filter: "none",
          muteOriginalAudio: false,
          volume: 0.5,
          reversed: false,
        },
      ],
      overlays: [
        {
          id: "txt-1",
          text: "CUSTOM POS",
          startSec: 0.1,
          endSec: 2.2,
          position: "center",
          style: "capcut-pop",
          xNorm: 0.48,
          yNorm: 0.3,
          scale: 1.15,
          rotationDeg: -6,
          color: "#FFFFFF",
          bgColor: "#FF4D6D",
          animation: "pop",
        },
      ],
      stickers: [
        {
          id: "stk-1",
          stickerId: "fire",
          startSec: 0.2,
          endSec: 2.0,
          xNorm: 0.78,
          yNorm: 0.24,
          scale: 1.1,
          rotationDeg: 10,
        },
        {
          id: "stk-out-of-range",
          stickerId: "sparkles",
          startSec: 12.0,
          endSec: 18.0,
          xNorm: 0.2,
          yNorm: 0.2,
          scale: 1.0,
          rotationDeg: 0,
        },
      ],
      audioTracks: [
        {
          id: "aud-1",
          kind: "bgm",
          assetId: "bgm-src",
          timelineStartSec: 0,
          durationSec: 2.75,
          startOffsetSec: 0,
          volume: 0.8,
          fadeInSec: 0.2,
          fadeOutSec: 0.4,
          beatMarkersSec: [0, 0.5, 1.0],
        },
        {
          id: "aud-2",
          kind: "sfx",
          assetId: "sfx-src",
          timelineStartSec: 1.1,
          durationSec: 0.6,
          startOffsetSec: 0,
          volume: 1.0,
          fadeInSec: 0.05,
          fadeOutSec: 0.1,
          beatMarkersSec: [],
        },
      ],
    });

    fs.writeFileSync(assPath, generateAssSubtitles(project.overlays, "9:16", "720p"), "utf8");
    const plan = buildFfmpegRenderPlan({
      project,
      quality: "720p",
      assetsById,
      filePathsById,
      outputPath: outPath,
      assSubtitlePath: assPath,
      builtinsDir,
    });

    const renderRes = await runProcess("ffmpeg", plan.args, { timeoutMs: 60_000 });
    expect(renderRes.code, renderRes.stderr).toBe(0);
    const outProbe = await probeMediaFile(outPath, "video");
    expect(outProbe.width).toBe(720);
    expect(outProbe.height).toBe(1280);
    expect(outProbe.hasAudio).toBe(true);
  }, 60_000);
});
