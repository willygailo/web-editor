import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CutProjectSchema, type MediaAsset } from "@cutflow/shared";
import { generateOfflineCutProject } from "./ai/offline.js";
import { runProcess } from "./media/exec.js";
import { MediaStore } from "./media/store.js";
import { sanitizeCutProject } from "./ai/sanitize.js";
import { probeMediaFile } from "./media/probe.js";
import { buildFfmpegRenderPlan, escapeFfmpegFilterPath } from "./render/ffmpegGraph.js";
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

    const filterComplexArg = plan.args[plan.args.indexOf("-filter_complex") + 1] ?? "";
    expect(plan.args.some((a) => a.endsWith("sticker-fire.png"))).toBe(true);
    expect(filterComplexArg).toContain("ass=filename=");
    expect(filterComplexArg).toContain(":fontsdir=");

    const renderRes = await runProcess("ffmpeg", plan.args, { timeoutMs: 60_000 });
    expect(renderRes.code, renderRes.stderr).toBe(0);
    const outProbe = await probeMediaFile(outPath, "video");
    expect(outProbe.width).toBe(720);
    expect(outProbe.height).toBe(1280);
    expect(outProbe.hasAudio).toBe(true);
  }, 60_000);

  it("preserves BGM offsets, SFX, and voiceovers on Remix and renders audible audio after skipping quiet intro", async () => {
    const imgPath = path.join(tempRoot, "cover-photo.jpg");
    const songPath = path.join(tempRoot, "quiet-intro.m4a");
    const sfxPath = path.join(tempRoot, "whoosh.wav");
    const outPath = path.join(tempRoot, "bgm-offset-output.mp4");

    const genImg = await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=navy:s=800x800:d=1",
      "-frames:v", "1", imgPath,
    ]);
    // First 2.0s silent, seconds 2.0..6.0 loud 440Hz sine
    const genSong = await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=6",
      "-af", "volume=enable='lt(t,2.0)':volume=0",
      "-c:a", "aac", songPath,
    ]);
    const genSfx = await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=880:duration=0.6",
      "-c:a", "pcm_s16le", sfxPath,
    ]);
    expect(genImg.code).toBe(0);
    expect(genSong.code).toBe(0);
    expect(genSfx.code).toBe(0);

    const assets: MediaAsset[] = [
      {
        id: "img-a",
        filename: "cover-photo.jpg",
        originalName: "Photo A",
        kind: "image",
        mimeType: "image/jpeg",
        url: "/api/media/img-a/stream",
        durationSec: 6,
        width: 800,
        height: 800,
        hasAudio: false,
        beatMarkersSec: [],
        energyPeaksSec: [],
        silenceRanges: [],
        isBuiltIn: false,
      },
      {
        id: "song-intro",
        filename: "quiet-intro.m4a",
        originalName: "My Song.m4a",
        kind: "audio",
        audioCategory: "bgm",
        mimeType: "audio/mp4",
        url: "/api/media/song-intro/stream",
        durationSec: 6,
        hasAudio: true,
        beatMarkersSec: [2.1, 2.6, 3.1],
        energyPeaksSec: [2.1, 2.6],
        silenceRanges: [{ startSec: 0, endSec: 2.0 }],
        isBuiltIn: false,
      },
      {
        id: "sfx-whoosh",
        filename: "whoosh.wav",
        originalName: "Whoosh",
        kind: "audio",
        audioCategory: "sfx",
        mimeType: "audio/wav",
        url: "/api/media/sfx-whoosh/stream",
        durationSec: 0.6,
        hasAudio: true,
        beatMarkersSec: [],
        energyPeaksSec: [],
        silenceRanges: [],
        isBuiltIn: true,
      },
    ];

    const assetsById = new Map(assets.map((a) => [a.id, a]));
    const filePathsById = new Map([
      ["img-a", imgPath],
      ["song-intro", songPath],
      ["sfx-whoosh", sfxPath],
    ]);

    const prevProject = CutProjectSchema.parse({
      id: "proj-remix",
      title: "Prev Edit",
      templateId: "hype-zoom",
      promptUsed: "initial",
      modeUsed: "offline",
      aspectRatio: "1:1",
      fps: 30,
      targetDurationSec: 3.5,
      clips: [
        {
          id: "slot-1",
          assetId: "img-a",
          sourceStartSec: 0,
          sourceEndSec: 3.5,
          speed: 1,
          motion: "zoom-in",
          transitionIn: "cut",
          transitionDurationSec: 0,
          filter: "none",
          muteOriginalAudio: true,
          volume: 0,
        },
      ],
      overlays: [],
      audioTracks: [
        {
          id: "aud-bgm-custom",
          kind: "bgm",
          assetId: "song-intro",
          title: "My Song.m4a",
          timelineStartSec: 0,
          durationSec: 3.5,
          startOffsetSec: 2.2,
          volume: 1.2,
          fadeInSec: 0.1,
          fadeOutSec: 0.2,
          beatMarkersSec: [2.1, 2.6],
        },
        {
          id: "aud-sfx-1",
          kind: "sfx",
          assetId: "sfx-whoosh",
          title: "Whoosh",
          timelineStartSec: 0.5,
          durationSec: 0.6,
          startOffsetSec: 0,
          volume: 1.0,
          fadeInSec: 0.02,
          fadeOutSec: 0.05,
          beatMarkersSec: [],
        },
      ],
    });

    const remixed = generateOfflineCutProject(
      {
        prompt: "Make it 4s faster",
        assetIds: ["img-a"],
        audioAssetId: "song-intro",
        mode: "offline",
        previousProject: prevProject,
      },
      assetsById
    );

    expect(remixed.project.audioTracks.length).toBe(2);
    expect(remixed.project.audioTracks[0]?.startOffsetSec).toBe(2.2);
    expect(remixed.project.audioTracks[0]?.volume).toBe(1.2);
    expect(remixed.project.audioTracks[1]?.kind).toBe("sfx");

    const plan = buildFfmpegRenderPlan({
      project: remixed.project,
      quality: "720p",
      assetsById,
      filePathsById,
      outputPath: outPath,
    });

    const renderRes = await runProcess("ffmpeg", plan.args, { timeoutMs: 60_000 });
    expect(renderRes.code, renderRes.stderr).toBe(0);

    const volRes = await runProcess("ffmpeg", [
      "-i", outPath, "-af", "volumedetect", "-vn", "-f", "null", "-",
    ]);
    const meanMatch = /mean_volume:\s*([-\d.]+)\s*dB/.exec(volRes.stderr);
    expect(meanMatch).not.toBeNull();
    expect(Number(meanMatch?.[1])).toBeGreaterThan(-25);

    const probe = await runProcess("ffprobe", [
      "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "default=nk=1:nw=1", outPath,
    ]);
    expect(probe.stdout.trim()).toBe("yuv420p");
  }, 60_000);
});

describe("Cross-Platform Compatibility (Windows / macOS / Linux)", () => {
  it("escapes Windows drive letters, brackets, commas, semicolons, and apostrophes in FFmpeg ass filter paths", () => {
    const winAss = "C:\\Users\\O'Connor [dev]\\cutflow,1\\renders\\sub;v1.ass";
    const winFonts = "C:\\Users\\O'Connor [dev]\\cutflow\\fonts";
    expect(escapeFfmpegFilterPath(winAss)).toBe(
      "'C\\:/Users/O'\\\\\\''Connor [dev]/cutflow,1/renders/sub;v1.ass'"
    );

    const imgAsset: MediaAsset = {
      id: "win-img",
      filename: "photo.png",
      originalName: "Photo",
      kind: "image",
      mimeType: "image/png",
      url: "/api/media/win-img/stream",
      durationSec: 5,
      width: 720,
      height: 1280,
      hasAudio: false,
      beatMarkersSec: [],
      energyPeaksSec: [],
      silenceRanges: [],
      isBuiltIn: false,
    };

    const plan = buildFfmpegRenderPlan({
      project: CutProjectSchema.parse({
        id: "p-win",
        title: "Win Plan",
        templateId: "hype-zoom",
        promptUsed: "win test",
        modeUsed: "template",
        aspectRatio: "9:16",
        fps: 30,
        targetDurationSec: 2,
        clips: [
          {
            id: "c1",
            assetId: "win-img",
            sourceStartSec: 0,
            sourceEndSec: 2,
            speed: 1,
            motion: "none",
            transitionIn: "cut",
            transitionDurationSec: 0,
            filter: "none",
            muteOriginalAudio: true,
            volume: 0,
          },
        ],
        overlays: [
          {
            id: "ov1",
            text: "HELLO WINDOWS",
            startSec: 0,
            endSec: 1.5,
            position: "center",
            style: "bold-hook",
            scale: 1,
            rotationDeg: 0,
            animation: "none",
          },
        ],
        stickers: [
          {
            id: "stk-win",
            stickerId: "sparkles",
            startSec: 0,
            endSec: 1.5,
            xNorm: 0.5,
            yNorm: 0.3,
            scale: 1,
            rotationDeg: 0,
          },
        ],
      }),
      quality: "720p",
      assetsById: new Map([[imgAsset.id, imgAsset]]),
      filePathsById: new Map([[imgAsset.id, "C:\\media\\photo.png"]]),
      outputPath: "C:\\renders\\out.mp4",
      assSubtitlePath: winAss,
      fontsDir: winFonts,
    });

    const fc = plan.args[plan.args.indexOf("-filter_complex") + 1] ?? "";
    expect(fc).toContain(`ass=filename=${escapeFfmpegFilterPath(winAss)}:fontsdir=${escapeFfmpegFilterPath(winFonts)}`);
    expect(plan.args.some((arg) => arg.endsWith("sticker-sparkles.png"))).toBe(true);
  });

  it("recovers portable MediaStore asset paths across moved or cross-OS storage directories", () => {
    const portableRoot = path.join(tempRoot, "portable-data");
    const uploadsDir = path.join(portableRoot, "uploads");
    const proxiesDir = path.join(portableRoot, "proxies");
    fs.mkdirSync(uploadsDir, { recursive: true });
    fs.mkdirSync(proxiesDir, { recursive: true });

    const targetVideo = path.join(uploadsDir, "clip-portable.mp4");
    const targetThumb = path.join(proxiesDir, "portable-1.jpg");
    fs.writeFileSync(targetVideo, "video-bytes");
    fs.writeFileSync(targetThumb, "thumb-bytes");

    const dbPath = path.join(portableRoot, "assets.json");
    fs.writeFileSync(
      dbPath,
      JSON.stringify([
        {
          asset: {
            id: "portable-1",
            filename: "clip-portable.mp4",
            originalName: "Portable Clip",
            kind: "video",
            mimeType: "video/mp4",
            url: "/api/media/portable-1/stream",
            thumbnailUrl: "/api/media/portable-1/thumb",
            durationSec: 4,
            hasAudio: true,
            beatMarkersSec: [],
            energyPeaksSec: [],
            silenceRanges: [],
            isBuiltIn: false,
          },
          filePath: "C:\\OldMachine\\web editor\\data\\uploads\\clip-portable.mp4",
          thumbPath: "C:\\OldMachine\\web editor\\data\\proxies\\portable-1.jpg",
        },
      ])
    );

    const store = new MediaStore(dbPath);
    const loaded = store.get("portable-1");
    expect(loaded).toBeDefined();
    expect(loaded?.filePath).toBe(targetVideo);
    expect(loaded?.thumbPath).toBe(targetThumb);
  });
});

describe("V3 Features (Audio Ducking, Custom Logo Sticker & Model Overrides)", () => {
  it("renders BGM with sidechain ducking under voiceover and composites uploaded PNG image stickers", async () => {
    const baseVid = path.join(tempRoot, "v3-base.mp4");
    const logoPng = path.join(tempRoot, "v3-logo.png");
    const bgmWav = path.join(tempRoot, "v3-bgm.wav");
    const voWav = path.join(tempRoot, "v3-vo.wav");
    const outPath = path.join(tempRoot, "v3-output.mp4");

    const r1 = await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=navy:s=720x1280:d=4:r=30",
      "-c:v", "libx264", "-preset", "ultrafast", baseVid,
    ]);
    const r2 = await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "color=c=orange@0.9:s=200x100:d=1",
      "-frames:v", "1", "-pix_fmt", "rgba", logoPng,
    ]);
    const r3 = await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=4,volume=6",
      "-c:a", "pcm_s16le", bgmWav,
    ]);
    const r4 = await runProcess("ffmpeg", [
      "-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=1.5,volume=6",
      "-c:a", "pcm_s16le", voWav,
    ]);
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    expect(r3.code).toBe(0);
    expect(r4.code).toBe(0);

    const assetsById = new Map<string, MediaAsset>([
      [
        "v3-vid",
        {
          id: "v3-vid",
          filename: "v3-base.mp4",
          originalName: "Base",
          kind: "video",
          mimeType: "video/mp4",
          url: "/api/media/v3-vid/stream",
          durationSec: 4,
          width: 720,
          height: 1280,
          fps: 30,
          hasAudio: false,
          beatMarkersSec: [],
          energyPeaksSec: [],
          silenceRanges: [],
          isBuiltIn: false,
        },
      ],
      [
        "v3-logo",
        {
          id: "v3-logo",
          filename: "v3-logo.png",
          originalName: "Brand Logo",
          kind: "image",
          mimeType: "image/png",
          url: "/api/media/v3-logo/stream",
          durationSec: 6,
          width: 200,
          height: 100,
          hasAudio: false,
          beatMarkersSec: [],
          energyPeaksSec: [],
          silenceRanges: [],
          isBuiltIn: false,
        },
      ],
      [
        "v3-bgm",
        {
          id: "v3-bgm",
          filename: "v3-bgm.wav",
          originalName: "BGM",
          kind: "audio",
          audioCategory: "bgm",
          mimeType: "audio/wav",
          url: "/api/media/v3-bgm/stream",
          durationSec: 4,
          hasAudio: true,
          beatMarkersSec: [],
          energyPeaksSec: [],
          silenceRanges: [],
          isBuiltIn: false,
        },
      ],
      [
        "v3-vo",
        {
          id: "v3-vo",
          filename: "v3-vo.wav",
          originalName: "Voiceover",
          kind: "audio",
          audioCategory: "voiceover",
          mimeType: "audio/wav",
          url: "/api/media/v3-vo/stream",
          durationSec: 1.5,
          hasAudio: true,
          beatMarkersSec: [],
          energyPeaksSec: [],
          silenceRanges: [],
          isBuiltIn: false,
        },
      ],
    ]);

    const filePathsById = new Map([
      ["v3-vid", baseVid],
      ["v3-logo", logoPng],
      ["v3-bgm", bgmWav],
      ["v3-vo", voWav],
    ]);

    const project = CutProjectSchema.parse({
      id: "proj-v3-render",
      title: "V3 Render Test",
      templateId: "hype-zoom",
      promptUsed: "v3",
      modeUsed: "template",
      aspectRatio: "9:16",
      fps: 30,
      targetDurationSec: 4,
      clips: [
        {
          id: "slot-1",
          assetId: "v3-vid",
          sourceStartSec: 0,
          sourceEndSec: 4,
          speed: 1,
          motion: "none",
          transitionIn: "cut",
          transitionDurationSec: 0,
          filter: "none",
          muteOriginalAudio: true,
          volume: 0,
        },
      ],
      overlays: [],
      stickers: [
        {
          id: "stk-logo",
          stickerId: "custom-image",
          assetId: "v3-logo",
          startSec: 0.2,
          endSec: 3.5,
          xNorm: 0.82,
          yNorm: 0.16,
          scale: 0.9,
          rotationDeg: 0,
        },
      ],
      audioTracks: [
        {
          id: "aud-bgm",
          kind: "bgm",
          assetId: "v3-bgm",
          timelineStartSec: 0,
          durationSec: 4,
          startOffsetSec: 0,
          volume: 0.9,
          fadeInSec: 0.1,
          fadeOutSec: 0.2,
          duckUnderVoice: true,
          beatMarkersSec: [],
        },
        {
          id: "aud-vo",
          kind: "voiceover",
          assetId: "v3-vo",
          timelineStartSec: 1.5,
          durationSec: 1.5,
          startOffsetSec: 0,
          volume: 1.0,
          fadeInSec: 0.05,
          fadeOutSec: 0.05,
          beatMarkersSec: [],
        },
      ],
    });

    const plan = buildFfmpegRenderPlan({
      project,
      quality: "720p",
      assetsById,
      filePathsById,
      outputPath: outPath,
    });

    const fc = plan.args[plan.args.indexOf("-filter_complex") + 1] ?? "";
    expect(plan.args).toContain(logoPng);
    expect(fc).toContain("sidechaincompress=");
    expect(fc).toContain("[voicemix]");

    const renderRes = await runProcess("ffmpeg", plan.args, { timeoutMs: 60_000 });
    expect(renderRes.code, renderRes.stderr).toBe(0);
    const outProbe = await probeMediaFile(outPath, "video");
    expect(outProbe.width).toBe(720);
    expect(outProbe.height).toBe(1280);
    expect(outProbe.hasAudio).toBe(true);

    // Sanitizer drops stale custom sticker assets while preserving valid ones & duckUnderVoice
    const sanitized = sanitizeCutProject(
      {
        ...project,
        stickers: [
          ...project.stickers,
          {
            id: "stk-missing",
            stickerId: "custom-image",
            assetId: "missing-img-id",
            startSec: 0,
            endSec: 2,
            xNorm: 0.5,
            yNorm: 0.5,
            scale: 1,
            rotationDeg: 0,
          },
        ],
      },
      assetsById
    );
    expect(sanitized.project.stickers.map((s) => s.id)).toEqual(["stk-logo"]);
    expect(sanitized.warnings.some((w) => w.includes("missing-img-id"))).toBe(true);
    expect(sanitized.project.audioTracks[0]?.duckUnderVoice).toBe(true);
  }, 60_000);
});
