import fs from "node:fs";
import type { MediaKind, SilenceRange } from "@cutflow/shared";
import { runProcess } from "./exec.js";

export interface ProbedMedia {
  durationSec: number;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio: boolean;
  beatMarkersSec: number[];
  energyPeaksSec: number[];
  silenceRanges: SilenceRange[];
}

function parseFrameRate(raw?: string): number | undefined {
  if (!raw || raw === "0/0") return undefined;
  if (raw.includes("/")) {
    const [numStr, denStr] = raw.split("/");
    const num = Number(numStr);
    const den = Number(denStr);
    if (Number.isFinite(num) && Number.isFinite(den) && den > 0) {
      return Number((num / den).toFixed(2));
    }
    return undefined;
  }
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Number(n.toFixed(2)) : undefined;
}

export async function checkFfmpegAvailable(): Promise<boolean> {
  try {
    const res = await runProcess("ffmpeg", ["-version"], { timeoutMs: 3000 });
    return res.code === 0;
  } catch {
    return false;
  }
}

export async function generateThumbnail(
  filePath: string,
  kind: MediaKind,
  outputPath: string,
  durationSec: number
): Promise<boolean> {
  if (kind === "audio") return false;
  const seekSec = kind === "video" ? Math.min(0.6, durationSec * 0.2).toFixed(2) : "0";
  const args =
    kind === "video"
      ? ["-y", "-ss", seekSec, "-i", filePath, "-vframes", "1", "-vf", "scale=480:-2", "-q:v", "4", outputPath]
      : ["-y", "-i", filePath, "-vframes", "1", "-vf", "scale=480:-2", "-q:v", "4", outputPath];

  const res = await runProcess("ffmpeg", args, { timeoutMs: 15_000 });
  return res.code === 0;
}

export async function createGeminiVideoProxy(
  filePath: string,
  outputPath: string,
  maxSeconds = 45
): Promise<boolean> {
  const args = [
    "-y",
    "-t",
    String(maxSeconds),
    "-i",
    filePath,
    "-vf",
    "scale='min(480,iw)':-2,fps=10",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-crf",
    "30",
    "-c:a",
    "aac",
    "-b:a",
    "64k",
    "-movflags",
    "+faststart",
    outputPath,
  ];
  const res = await runProcess("ffmpeg", args, { timeoutMs: 30_000 });
  return res.code === 0;
}

function parseSilenceRanges(stderr: string, maxDurationSec: number): SilenceRange[] {
  const ranges: SilenceRange[] = [];
  let currentStart: number | null = null;

  for (const line of stderr.split(/\r?\n/)) {
    const startMatch = /silence_start:\s*([0-9.]+)/.exec(line);
    if (startMatch) {
      currentStart = Number(startMatch[1]);
      continue;
    }
    const endMatch = /silence_end:\s*([0-9.]+)/.exec(line);
    if (endMatch) {
      const endSec = Math.min(maxDurationSec, Number(endMatch[1]));
      const startSec = currentStart ?? 0;
      if (endSec > startSec) {
        ranges.push({
          startSec: Number(startSec.toFixed(2)),
          endSec: Number(endSec.toFixed(2)),
        });
      }
      currentStart = null;
    }
  }

  if (currentStart !== null && maxDurationSec > currentStart) {
    ranges.push({
      startSec: Number(currentStart.toFixed(2)),
      endSec: Number(maxDurationSec.toFixed(2)),
    });
  }

  return ranges;
}

function detectEnergyPeaksFromPcm(pcm: Buffer, sampleRate = 8000): {
  energyPeaksSec: number[];
  beatMarkersSec: number[];
} {
  const samplesTotal = Math.floor(pcm.length / 2);
  const windowSamples = Math.floor(sampleRate * 0.1); // 100ms window
  if (samplesTotal < windowSamples) {
    return { energyPeaksSec: [], beatMarkersSec: [] };
  }

  const energies: number[] = [];
  for (let offset = 0; offset + windowSamples <= samplesTotal; offset += windowSamples) {
    let sumSq = 0;
    for (let i = 0; i < windowSamples; i++) {
      const sample = pcm.readInt16LE((offset + i) * 2) / 32768;
      sumSq += sample * sample;
    }
    energies.push(Math.sqrt(sumSq / windowSamples));
  }

  const mean = energies.reduce((a, b) => a + b, 0) / Math.max(1, energies.length);
  const threshold = Math.max(0.03, mean * 1.25);

  const peaks: number[] = [];
  let lastPeakTime = -1;
  for (let i = 1; i < energies.length - 1; i++) {
    const val = energies[i];
    if (val >= threshold && val >= energies[i - 1] && val >= energies[i + 1]) {
      const t = Number((i * 0.1).toFixed(2));
      if (t - lastPeakTime >= 0.45) {
        peaks.push(t);
        lastPeakTime = t;
      }
    }
  }

  return {
    energyPeaksSec: peaks,
    beatMarkersSec: peaks,
  };
}

export async function analyzeAudioTrack(
  filePath: string,
  durationSec: number
): Promise<{
  silenceRanges: SilenceRange[];
  energyPeaksSec: number[];
  beatMarkersSec: number[];
}> {
  try {
    const [silenceRes, pcmRes] = await Promise.all([
      runProcess(
        "ffmpeg",
        ["-i", filePath, "-af", "silencedetect=n=-32dB:d=0.35", "-f", "null", "-"],
        { timeoutMs: 15_000 }
      ),
      runProcess(
        "ffmpeg",
        ["-i", filePath, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"],
        { timeoutMs: 15_000 }
      ),
    ]);

    const silenceRanges = parseSilenceRanges(silenceRes.stderr, durationSec);
    const { energyPeaksSec, beatMarkersSec } =
      pcmRes.code === 0
        ? detectEnergyPeaksFromPcm(pcmRes.stdoutBuffer, 8000)
        : { energyPeaksSec: [], beatMarkersSec: [] };

    return { silenceRanges, energyPeaksSec, beatMarkersSec };
  } catch {
    return { silenceRanges: [], energyPeaksSec: [], beatMarkersSec: [] };
  }
}

export async function probeMediaFile(
  filePath: string,
  kind: MediaKind
): Promise<ProbedMedia> {
  const res = await runProcess(
    "ffprobe",
    [
      "-v",
      "quiet",
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      filePath,
    ],
    { timeoutMs: 10_000 }
  );

  if (res.code !== 0) {
    throw new Error(`ffprobe failed for ${filePath}: ${res.stderr}`);
  }

  const parsed = JSON.parse(res.stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      avg_frame_rate?: string;
      r_frame_rate?: string;
      duration?: string;
    }>;
  };

  const videoStream = parsed.streams?.find((s) => s.codec_type === "video");
  const audioStream = parsed.streams?.find((s) => s.codec_type === "audio");

  const rawDuration = Number(
    parsed.format?.duration ?? videoStream?.duration ?? (kind === "image" ? 5 : 3)
  );
  const durationSec =
    kind === "image"
      ? 6
      : Number(
          (Number.isFinite(rawDuration) && rawDuration > 0.2 ? rawDuration : 3).toFixed(2)
        );

  const hasAudio = kind !== "image" && Boolean(audioStream);

  let silenceRanges: SilenceRange[] = [];
  let energyPeaksSec: number[] = [];
  let beatMarkersSec: number[] = [];

  if (hasAudio) {
    const audioAnalysis = await analyzeAudioTrack(filePath, durationSec);
    silenceRanges = audioAnalysis.silenceRanges;
    energyPeaksSec = audioAnalysis.energyPeaksSec;
    beatMarkersSec = audioAnalysis.beatMarkersSec;
  }

  return {
    durationSec,
    width: videoStream?.width,
    height: videoStream?.height,
    fps: parseFrameRate(videoStream?.avg_frame_rate || videoStream?.r_frame_rate),
    hasAudio,
    beatMarkersSec,
    energyPeaksSec,
    silenceRanges,
  };
}

export async function extractWaveformPeaks(
  filePath: string,
  cachePath: string,
  bins = 120
): Promise<number[]> {
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, "utf8")) as number[];
      if (Array.isArray(cached) && cached.length > 0) return cached;
    } catch {
      // regenerate
    }
  }

  const res = await runProcess(
    "ffmpeg",
    ["-i", filePath, "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"],
    { timeoutMs: 15_000 }
  );

  if (res.code !== 0 || res.stdoutBuffer.length < 4) {
    return Array.from({ length: bins }, () => 0.2);
  }

  const pcm = res.stdoutBuffer;
  const totalSamples = Math.floor(pcm.length / 2);
  const bucketSize = Math.max(1, Math.floor(totalSamples / bins));
  const rawPeaks: number[] = [];

  for (let b = 0; b < bins; b++) {
    const start = b * bucketSize;
    const end = Math.min(totalSamples, start + bucketSize);
    if (start >= totalSamples) {
      rawPeaks.push(0.08);
      continue;
    }
    let maxAbs = 0;
    for (let i = start; i < end; i++) {
      const val = Math.abs(pcm.readInt16LE(i * 2)) / 32768;
      if (val > maxAbs) maxAbs = val;
    }
    rawPeaks.push(maxAbs);
  }

  const globalMax = Math.max(0.05, ...rawPeaks);
  const normalized = rawPeaks.map((v) =>
    Number(Math.max(0.06, Math.min(1, v / globalMax)).toFixed(3))
  );

  try {
    fs.writeFileSync(cachePath, JSON.stringify(normalized));
  } catch {
    // ignore cache write issues
  }

  return normalized;
}

export async function extractAudioFromVideo(
  videoPath: string,
  outAudioPath: string
): Promise<boolean> {
  const res = await runProcess(
    "ffmpeg",
    ["-y", "-i", videoPath, "-vn", "-c:a", "aac", "-b:a", "160k", outAudioPath],
    { timeoutMs: 30_000 }
  );
  return res.code === 0 && fs.existsSync(outAudioPath);
}
