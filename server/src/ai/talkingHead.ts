import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AspectRatio,
  type ClipSlot,
  type CutProject,
  type MediaAsset,
  type TalkingHeadCutRequest,
  type TalkingHeadCutResponse,
} from "@cutflow/shared";
import { REPO_ROOT, type ServerConfig } from "../config.js";
import { runProcess } from "../media/exec.js";

interface CutSegment {
  start: number;
  end: number;
  text: string;
}

function resolveWhisperxPython(): string | null {
  const base = path.join(os.homedir(), ".cache", "video-editor", "whisperx-venv");
  const candidates =
    process.platform === "win32"
      ? [path.join(base, "Scripts", "python.exe"), path.join(base, "bin", "python")]
      : [path.join(base, "bin", "python"), path.join(base, "Scripts", "python.exe")];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function resolveSystemPython(): string {
  return process.platform === "win32" ? "python" : "python3";
}

function inferAspectRatio(asset: MediaAsset): AspectRatio {
  const w = asset.width ?? 1080;
  const h = asset.height ?? 1920;
  const ratio = w / Math.max(1, h);
  if (ratio < 0.72) return "9:16";
  if (ratio < 0.92) return "4:5";
  if (ratio <= 1.15) return "1:1";
  return "16:9";
}

function buildSilenceFallbackSegments(asset: MediaAsset): CutSegment[] {
  const dur = Math.max(0.4, asset.durationSec);
  const kept: CutSegment[] = [];
  let cursor = 0;
  const sorted = [...asset.silenceRanges].sort((a, b) => a.startSec - b.startSec);

  for (const s of sorted) {
    const segStart = Math.max(0, cursor);
    const segEnd = Math.min(dur, s.startSec + 0.12);
    if (segEnd - segStart >= 0.35) {
      kept.push({
        start: Number(segStart.toFixed(3)),
        end: Number(segEnd.toFixed(3)),
        text: `Segment ${kept.length + 1}`,
      });
    }
    cursor = Math.max(cursor, s.endSec - 0.08);
  }

  if (dur - cursor >= 0.35) {
    kept.push({
      start: Number(Math.max(0, cursor).toFixed(3)),
      end: Number(dur.toFixed(3)),
      text: `Segment ${kept.length + 1}`,
    });
  }

  if (kept.length === 0) {
    return [{ start: 0, end: Number(dur.toFixed(3)), text: asset.originalName }];
  }
  return kept;
}

export async function runTalkingHeadAutoCut(params: {
  request: TalkingHeadCutRequest;
  asset: MediaAsset;
  filePath: string;
  config: ServerConfig;
  userAnthropicKey?: string;
  userAnthropicModel?: string;
  userAnthropicWorkspaceId?: string;
}): Promise<TalkingHeadCutResponse> {
  const {
    request,
    asset,
    filePath,
    config,
    userAnthropicKey,
    userAnthropicModel,
    userAnthropicWorkspaceId,
  } = params;

  if (asset.kind !== "video") {
    throw new Error("Auto Talking-Head Cut requires a video clip.");
  }
  if (!asset.hasAudio) {
    throw new Error("Selected video clip has no audio track to transcribe and cut.");
  }
  if (!fs.existsSync(filePath)) {
    throw new Error("Source media file is missing on disk.");
  }

  const warnings: string[] = [];
  const cacheDir = path.join(config.storageDir, "transcripts");
  fs.mkdirSync(cacheDir, { recursive: true });

  const wordsJsonPath = path.join(cacheDir, `${asset.id}.words.json`);
  const wavPath = path.join(cacheDir, `${asset.id}_16k.wav`);
  const cutsJsonPath = path.join(cacheDir, `${asset.id}.cuts.json`);

  const transcribeScript = path.join(REPO_ROOT, "scripts", "transcribe.py");
  const chooseCutsScript = path.join(REPO_ROOT, "scripts", "choose_cuts.py");
  const whisperxPy = resolveWhisperxPython();

  let segments: CutSegment[] = [];
  let sourceUsed: "claude" | "offline" = "offline";

  if (whisperxPy && fs.existsSync(transcribeScript) && fs.existsSync(chooseCutsScript)) {
    const tArgs = [
      transcribeScript,
      filePath,
      "--out",
      wordsJsonPath,
      "--wav",
      wavPath,
    ];
    if (request.language?.trim()) {
      tArgs.push("--language", request.language.trim());
    }

    const tRes = await runProcess(whisperxPy, tArgs, {
      timeoutMs: 10 * 60_000,
    });

    if (tRes.code === 0 && fs.existsSync(wordsJsonPath)) {
      const apiKey = (userAnthropicKey || config.anthropicApiKey || "").trim();
      const model = (userAnthropicModel || config.anthropicModel || "claude-sonnet-5-5").trim();
      const workspaceId = (userAnthropicWorkspaceId || config.anthropicWorkspaceId || "").trim();

      const cRes = await runProcess(
        resolveSystemPython(),
        [
          chooseCutsScript,
          wordsJsonPath,
          "--raw",
          filePath,
          "--out",
          cutsJsonPath,
          "--mode",
          request.mode,
        ],
        {
          timeoutMs: 120_000,
          env: {
            ANTHROPIC_API_KEY: apiKey,
            ANTHROPIC_MODEL: model,
            ANTHROPIC_WORKSPACE_ID: workspaceId,
          },
        }
      );

      if (cRes.code === 0 && fs.existsSync(cutsJsonPath)) {
        const parsedCuts = JSON.parse(fs.readFileSync(cutsJsonPath, "utf8")) as {
          segments?: CutSegment[];
        };
        segments = (parsedCuts.segments ?? []).filter(
          (s) => Number.isFinite(s.start) && Number.isFinite(s.end) && s.end > s.start + 0.05
        );
        try {
          const summary = JSON.parse(cRes.stdout) as {
            source?: "claude" | "offline";
            warning?: string | null;
          };
          sourceUsed = summary.source === "claude" ? "claude" : "offline";
          if (summary.warning) warnings.push(summary.warning);
        } catch {
          // ignore non-JSON stdout noise
        }
      } else {
        warnings.push(
          `AI cut selector fallback (${cRes.stderr.trim() || "error"}); used FFmpeg silence-based jump-cuts.`
        );
      }
    } else {
      warnings.push(
        "WhisperX transcription did not produce words for this clip; used FFmpeg silence-based jump-cuts."
      );
    }
  } else {
    warnings.push(
      "WhisperX environment not found; used FFmpeg silence-based jump-cuts."
    );
  }

  if (segments.length === 0) {
    segments = buildSilenceFallbackSegments(asset);
    sourceUsed = "offline";
  }

  const fps = Math.min(60, Math.max(24, Math.round(asset.fps ?? 30)));
  const clips: ClipSlot[] = segments.map((seg, idx) => {
    const startSec = Number(Math.max(0, Math.min(asset.durationSec - 0.1, seg.start)).toFixed(3));
    const endSec = Number(
      Math.max(startSec + 0.1, Math.min(asset.durationSec, seg.end)).toFixed(3)
    );
    return {
      id: `th-${Date.now()}-${idx + 1}`,
      assetId: asset.id,
      sourceStartSec: startSec,
      sourceEndSec: endSec,
      speed: 1,
      motion: "none",
      transitionIn: "cut",
      transitionDurationSec: 0,
      filter: "none",
      muteOriginalAudio: false,
      volume: 1,
      reversed: false,
      label: seg.text ? seg.text.slice(0, 48) : `Take ${idx + 1}`,
    };
  });

  const editedDurationSec = Number(
    clips.reduce((acc, c) => acc + (c.sourceEndSec - c.sourceStartSec), 0).toFixed(3)
  );
  const originalDurationSec = Number(asset.durationSec.toFixed(3));
  const removedSec = Number(Math.max(0, originalDurationSec - editedDurationSec).toFixed(3));

  const project: CutProject = {
    id: `proj-th-${Date.now()}`,
    title: `${path.parse(asset.originalName).name} (Auto Cut)`.slice(0, 120),
    templateId: "talking-head-auto",
    promptUsed: "Auto Talking-Head Jump-Cut (WhisperX + AI)",
    aiSummary: `Kept ${clips.length} jump-cut segments (${editedDurationSec.toFixed(1)}s from ${originalDurationSec.toFixed(1)}s; trimmed ${removedSec.toFixed(1)}s of dead air/fillers).`,
    modeUsed: sourceUsed === "claude" ? "claude" : "offline",
    aspectRatio: inferAspectRatio(asset),
    fps,
    targetDurationSec: Number(Math.min(180, Math.max(0.4, editedDurationSec)).toFixed(2)),
    clips,
    overlays: [],
    stickers: [],
    audioTracks: [],
  };

  return {
    project,
    segmentsCount: clips.length,
    originalDurationSec,
    editedDurationSec,
    removedSec,
    source: sourceUsed,
    warnings,
  };
}
