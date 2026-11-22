import fs from "node:fs";
import path from "node:path";
import type { MediaAsset } from "@cutflow/shared";
import { runProcess } from "./exec.js";
import type { MediaStore } from "./store.js";
import { generateThumbnail, probeMediaFile } from "./probe.js";

interface BeatSpec {
  id: string;
  title: string;
  bpm: number;
  durationSec: number;
  baseHz: number;
  vibe: "hype" | "chill" | "flash";
}

const BUILTIN_BEATS: BeatSpec[] = [
  {
    id: "builtin-beat-hype-128",
    title: "Neon Drop (128 BPM Hype)",
    bpm: 128,
    durationSec: 20,
    baseHz: 55,
    vibe: "hype",
  },
  {
    id: "builtin-beat-chill-92",
    title: "Siargao Sunset (92 BPM Chill)",
    bpm: 92,
    durationSec: 24,
    baseHz: 110,
    vibe: "chill",
  },
  {
    id: "builtin-beat-flash-135",
    title: "Pulse Cut (135 BPM Montage)",
    bpm: 135,
    durationSec: 16,
    baseHz: 65.4,
    vibe: "flash",
  },
];

function computeBeatMarkers(bpm: number, durationSec: number): number[] {
  const step = 60 / bpm;
  const markers: number[] = [];
  for (let t = 0; t < durationSec - 0.1; t += step) {
    markers.push(Number(t.toFixed(3)));
  }
  return markers;
}

function buildWavBuffer(spec: BeatSpec): Buffer {
  const sampleRate = 44100;
  const totalSamples = Math.floor(spec.durationSec * sampleRate);
  const dataBytes = totalSamples * 2 * 2; // stereo 16-bit
  const buf = Buffer.alloc(44 + dataBytes);

  // RIFF header
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // stereo
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);

  const beatSec = 60 / spec.bpm;
  const chordRatios =
    spec.vibe === "chill"
      ? [1, 1.25, 1.5, 1.875]
      : [1, 1.189, 1.498, 1.782];

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sampleRate;
    const beatFloat = t / beatSec;
    const beatIndex = Math.floor(beatFloat);
    const beatPhase = (beatFloat - beatIndex) * beatSec;

    // Kick drum on every beat
    const kickEnv = Math.exp(-beatPhase * (spec.vibe === "chill" ? 14 : 20));
    const kickFreq = 130 * Math.exp(-beatPhase * 18) + 42;
    const kick = Math.sin(2 * Math.PI * kickFreq * beatPhase) * kickEnv * 0.55;

    // Snare/clap on beats 1 and 3 (offbeat in 4/4)
    const isSnareBeat = beatIndex % 2 === 1;
    const snareEnv = isSnareBeat ? Math.exp(-beatPhase * 28) : 0;
    const noise = ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 2 - 1;
    const snare = noise * snareEnv * (spec.vibe === "chill" ? 0.14 : 0.25);

    // Subtle 8th-note hi-hat
    const subPhase = ((t / (beatSec / 2)) % 1) * (beatSec / 2);
    const hatEnv = Math.exp(-subPhase * 55);
    const hat = noise * hatEnv * (spec.vibe === "flash" ? 0.16 : 0.08);

    // Musical bass/pad progression changing every 4 beats
    const barIdx = Math.floor(beatIndex / 4) % chordRatios.length;
    const noteHz = spec.baseHz * chordRatios[barIdx];
    const pad =
      Math.sin(2 * Math.PI * noteHz * t) * 0.2 +
      Math.sin(2 * Math.PI * noteHz * 2 * t) * 0.09 +
      Math.sin(2 * Math.PI * noteHz * 3 * t) * (spec.vibe === "chill" ? 0.04 : 0.08);

    const fadeOut =
      t > spec.durationSec - 0.6 ? Math.max(0, (spec.durationSec - t) / 0.6) : 1;

    const mixedL = Math.max(-0.95, Math.min(0.95, (kick + snare + hat + pad) * fadeOut));
    const mixedR = Math.max(
      -0.95,
      Math.min(0.95, (kick + snare * 0.9 + hat * 1.1 + pad * 0.95) * fadeOut)
    );

    buf.writeInt16LE(Math.round(mixedL * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(mixedR * 32767), 44 + i * 4 + 2);
  }

  return buf;
}

export async function ensureBuiltinAudioBeats(
  builtinsDir: string,
  store: MediaStore
): Promise<void> {
  for (const spec of BUILTIN_BEATS) {
    const m4aPath = path.join(builtinsDir, `${spec.id}.m4a`);
    if (!fs.existsSync(m4aPath)) {
      const wavPath = path.join(builtinsDir, `${spec.id}.wav`);
      fs.writeFileSync(wavPath, buildWavBuffer(spec));
      const res = await runProcess(
        "ffmpeg",
        ["-y", "-i", wavPath, "-c:a", "aac", "-b:a", "160k", m4aPath],
        { timeoutMs: 15_000 }
      );
      if (res.code === 0) {
        fs.unlinkSync(wavPath);
      }
    }

    const finalPath = fs.existsSync(m4aPath)
      ? m4aPath
      : path.join(builtinsDir, `${spec.id}.wav`);
    const beats = computeBeatMarkers(spec.bpm, spec.durationSec);

    const asset: MediaAsset = {
      id: spec.id,
      filename: path.basename(finalPath),
      originalName: spec.title,
      kind: "audio",
      audioCategory: "bgm",
      mimeType: finalPath.endsWith(".m4a") ? "audio/mp4" : "audio/wav",
      url: `/api/media/${spec.id}/stream`,
      durationSec: spec.durationSec,
      hasAudio: true,
      beatMarkersSec: beats,
      energyPeaksSec: beats,
      silenceRanges: [],
      isBuiltIn: true,
    };

    store.upsert(asset, finalPath);
  }

  await ensureBuiltinSfx(builtinsDir, store);
}

interface SfxSpec {
  id: string;
  title: string;
  durationSec: number;
  synth: (t: number, i: number, durationSec: number) => number;
}

const BUILTIN_SFX: SfxSpec[] = [
  {
    id: "builtin-sfx-whoosh",
    title: "SFX: Transition Whoosh",
    durationSec: 0.7,
    synth: (t, i, dur) => {
      const env = Math.sin((t / dur) * Math.PI);
      const noise = ((Math.sin(i * 12.9898) * 43758.5453) % 1) * 2 - 1;
      const sweep = Math.sin(2 * Math.PI * (180 + 500 * (t / dur)) * t) * 0.25;
      return (noise * 0.55 + sweep) * env;
    },
  },
  {
    id: "builtin-sfx-bass-drop",
    title: "SFX: Bass Boom Drop",
    durationSec: 1.1,
    synth: (t) => {
      const env = Math.exp(-t * 3.8);
      const freq = 140 * Math.exp(-t * 4.5) + 38;
      return Math.sin(2 * Math.PI * freq * t) * env * 0.85;
    },
  },
  {
    id: "builtin-sfx-pop",
    title: "SFX: CapCut Text Pop",
    durationSec: 0.25,
    synth: (t) => {
      const env = Math.exp(-t * 22);
      const freq = 520 + 620 * Math.exp(-t * 30);
      return Math.sin(2 * Math.PI * freq * t) * env * 0.75;
    },
  },
  {
    id: "builtin-sfx-riser",
    title: "SFX: Hype Riser",
    durationSec: 1.4,
    synth: (t, i, dur) => {
      const p = t / dur;
      const freq = 180 + 950 * p * p;
      const noise = ((Math.sin(i * 78.233) * 19341.12) % 1) * 2 - 1;
      return (Math.sin(2 * Math.PI * freq * t) * 0.45 + noise * 0.22) * Math.pow(p, 1.3);
    },
  },
  {
    id: "builtin-sfx-shutter",
    title: "SFX: Camera Shutter",
    durationSec: 0.3,
    synth: (t, i) => {
      const click1 = t < 0.06 ? Math.exp(-t * 70) : 0;
      const click2 = t > 0.1 ? Math.exp(-(t - 0.1) * 70) : 0;
      const noise = ((Math.sin(i * 45.123) * 91827.3) % 1) * 2 - 1;
      return noise * (click1 + click2) * 0.75;
    },
  },
];

function buildSfxWavBuffer(spec: SfxSpec): Buffer {
  const sampleRate = 44100;
  const totalSamples = Math.floor(spec.durationSec * sampleRate);
  const dataBytes = totalSamples * 4;
  const buf = Buffer.alloc(44 + dataBytes);

  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataBytes, 40);

  for (let i = 0; i < totalSamples; i++) {
    const val = Math.max(-0.95, Math.min(0.95, spec.synth(i / sampleRate, i, spec.durationSec)));
    const s = Math.round(val * 32767);
    buf.writeInt16LE(s, 44 + i * 4);
    buf.writeInt16LE(s, 44 + i * 4 + 2);
  }
  return buf;
}

async function ensureBuiltinSfx(
  builtinsDir: string,
  store: MediaStore
): Promise<void> {
  for (const spec of BUILTIN_SFX) {
    const m4aPath = path.join(builtinsDir, `${spec.id}.m4a`);
    if (!fs.existsSync(m4aPath)) {
      const wavPath = path.join(builtinsDir, `${spec.id}.wav`);
      fs.writeFileSync(wavPath, buildSfxWavBuffer(spec));
      const res = await runProcess(
        "ffmpeg",
        ["-y", "-i", wavPath, "-c:a", "aac", "-b:a", "128k", m4aPath],
        { timeoutMs: 10_000 }
      );
      if (res.code === 0) fs.unlinkSync(wavPath);
    }
    const finalPath = fs.existsSync(m4aPath)
      ? m4aPath
      : path.join(builtinsDir, `${spec.id}.wav`);

    store.upsert(
      {
        id: spec.id,
        filename: path.basename(finalPath),
        originalName: spec.title,
        kind: "audio",
        audioCategory: "sfx",
        mimeType: finalPath.endsWith(".m4a") ? "audio/mp4" : "audio/wav",
        url: `/api/media/${spec.id}/stream`,
        durationSec: spec.durationSec,
        hasAudio: true,
        beatMarkersSec: [],
        energyPeaksSec: [0.05],
        silenceRanges: [],
        isBuiltIn: true,
      },
      finalPath
    );
  }
}

interface SampleClipSpec {
  id: string;
  filename: string;
  label: string;
  durationSec: number;
  vf: string;
  audioHz: number;
}

const SAMPLE_CLIPS: SampleClipSpec[] = [
  {
    id: "sample-clip-sunrise",
    filename: "sample-sunrise.mp4",
    label: "Golden Hour Coastline",
    durationSec: 5,
    vf: "geq=r='180+70*sin(2*PI*(X/W+T/3))':g='95+65*cos(2*PI*(Y/H-T/4))':b='60+50*sin(T*2)'",
    audioHz: 220,
  },
  {
    id: "sample-clip-neon",
    filename: "sample-neon-city.mp4",
    label: "Manila Neon Nightlife",
    durationSec: 5,
    vf: "geq=r='80+150*abs(sin(X/80+T*3))':g='35+90*abs(cos(Y/90-T*2))':b='160+90*sin(T*4)'",
    audioHz: 330,
  },
  {
    id: "sample-clip-studio",
    filename: "sample-product-glow.mp4",
    label: "Studio Highlight Shot",
    durationSec: 5,
    vf: "geq=r='40+140*exp(-pow((X-W/2-120*sin(T*2))/200,2))':g='120+100*cos(T*2)':b='130+110*sin(Y/120+T*2)'",
    audioHz: 440,
  },
];

export async function ensureSampleDemoClips(
  builtinsDir: string,
  proxiesDir: string,
  store: MediaStore
): Promise<MediaAsset[]> {
  const created: MediaAsset[] = [];

  for (const spec of SAMPLE_CLIPS) {
    const outPath = path.join(builtinsDir, spec.filename);
    if (!fs.existsSync(outPath)) {
      const res = await runProcess(
        "ffmpeg",
        [
          "-y",
          "-f",
          "lavfi",
          "-i",
          `color=c=black:s=720x1280:d=${spec.durationSec}:r=30`,
          "-f",
          "lavfi",
          "-i",
          `sine=frequency=${spec.audioHz}:duration=${spec.durationSec}`,
          "-vf",
          `${spec.vf},format=yuv420p`,
          "-af",
          `volume=0.12,tremolo=f=4:d=0.6`,
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-crf",
          "23",
          "-c:a",
          "aac",
          "-b:a",
          "96k",
          "-movflags",
          "+faststart",
          outPath,
        ],
        { timeoutMs: 25_000 }
      );
      if (res.code !== 0) {
        throw new Error(`Failed to synthesize sample clip ${spec.id}: ${res.stderr}`);
      }
    }

    const thumbPath = path.join(proxiesDir, `${spec.id}.jpg`);
    const probed = await probeMediaFile(outPath, "video");
    const hasThumb = fs.existsSync(thumbPath)
      ? true
      : await generateThumbnail(outPath, "video", thumbPath, probed.durationSec);

    const asset: MediaAsset = {
      id: spec.id,
      filename: spec.filename,
      originalName: spec.label,
      kind: "video",
      mimeType: "video/mp4",
      url: `/api/media/${spec.id}/stream`,
      thumbnailUrl: hasThumb ? `/api/media/${spec.id}/thumb` : undefined,
      durationSec: probed.durationSec,
      width: probed.width,
      height: probed.height,
      fps: probed.fps,
      hasAudio: probed.hasAudio,
      beatMarkersSec: probed.beatMarkersSec,
      energyPeaksSec: probed.energyPeaksSec,
      silenceRanges: probed.silenceRanges,
      isBuiltIn: true,
    };

    store.upsert(asset, outPath, hasThumb ? thumbPath : undefined);
    created.push(asset);
  }

  return created;
}
