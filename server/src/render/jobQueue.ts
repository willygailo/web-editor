import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CutProject, MediaAsset, RenderJob } from "@cutflow/shared";
import { computeTimelineLayout } from "@cutflow/shared";
import type { ServerConfig } from "../config.js";
import { runProcess } from "../media/exec.js";
import { buildFfmpegRenderPlan } from "./ffmpegGraph.js";
import { generateAssSubtitles } from "./subtitles.js";

type Listener = (job: RenderJob) => void;

export class RenderJobQueue {
  private jobs = new Map<string, RenderJob>();
  private listeners = new Map<string, Set<Listener>>();

  constructor(private readonly config: ServerConfig) {}

  get(jobId: string): RenderJob | undefined {
    return this.jobs.get(jobId);
  }

  subscribe(jobId: string, fn: Listener): () => void {
    let set = this.listeners.get(jobId);
    if (!set) {
      set = new Set();
      this.listeners.set(jobId, set);
    }
    set.add(fn);
    const current = this.jobs.get(jobId);
    if (current) fn(current);
    return () => {
      set?.delete(fn);
    };
  }

  private emit(job: RenderJob): void {
    this.jobs.set(job.id, job);
    const set = this.listeners.get(job.id);
    if (set) {
      for (const fn of set) fn(job);
    }
  }

  enqueue(
    project: CutProject,
    quality: "720p" | "1080p",
    assetsById: Map<string, MediaAsset>,
    filePathsById: Map<string, string>
  ): RenderJob {
    const id = crypto.randomUUID();
    const job: RenderJob = {
      id,
      status: "queued",
      progress: 2,
      stage: "Preparing FFmpeg render graph...",
      createdAt: new Date().toISOString(),
    };
    this.emit(job);

    void this.executeJob(id, project, quality, assetsById, filePathsById);
    return job;
  }

  private async executeJob(
    jobId: string,
    project: CutProject,
    quality: "720p" | "1080p",
    assetsById: Map<string, MediaAsset>,
    filePathsById: Map<string, string>
  ): Promise<void> {
    const outputFilename = `cutflow-${jobId.slice(0, 8)}.mp4`;
    const outputPath = path.join(this.config.rendersDir, outputFilename);
    const assPath = path.join(this.config.rendersDir, `cutflow-${jobId.slice(0, 8)}.ass`);

    try {
      let activeAssPath: string | undefined;
      if (project.overlays.length > 0) {
        const assContent = generateAssSubtitles(project.overlays, project.aspectRatio, quality);
        fs.writeFileSync(assPath, assContent, "utf8");
        activeAssPath = assPath;
      }

      const plan = buildFfmpegRenderPlan({
        project,
        quality,
        assetsById,
        filePathsById,
        outputPath,
        assSubtitlePath: activeAssPath,
      });

      const layout = computeTimelineLayout(project);
      const totalMicros = Math.max(1_000_000, Math.round(layout.totalDurationSec * 1_000_000));

      this.emit({
        id: jobId,
        status: "rendering",
        progress: 8,
        stage: "Compositing cuts, transitions & audio...",
        createdAt: this.jobs.get(jobId)?.createdAt ?? new Date().toISOString(),
      });

      const stderrTail: string[] = [];
      const res = await runProcess("ffmpeg", plan.args, {
        timeoutMs: 300_000,
        onStdoutLine: (line) => {
          if (line.startsWith("out_time_us=")) {
            const us = Number(line.slice("out_time_us=".length));
            if (Number.isFinite(us) && us >= 0) {
              const pct = Math.min(97, Math.max(10, Math.round((us / totalMicros) * 90) + 8));
              const prev = this.jobs.get(jobId);
              if (prev && pct > prev.progress) {
                this.emit({
                  ...prev,
                  status: "rendering",
                  progress: pct,
                  stage: `Rendering MP4 (${pct}%)...`,
                });
              }
            }
          }
        },
        onStderrLine: (line) => {
          stderrTail.push(line);
          if (stderrTail.length > 25) stderrTail.shift();
        },
      });

      if (activeAssPath && fs.existsSync(activeAssPath)) {
        fs.unlinkSync(activeAssPath);
      }

      if (res.code !== 0 || !fs.existsSync(outputPath)) {
        throw new Error(
          `FFmpeg render failed (code ${res.code}): ${stderrTail.slice(-6).join(" | ")}`
        );
      }

      this.emit({
        id: jobId,
        status: "completed",
        progress: 100,
        stage: "MP4 ready to download",
        outputUrl: `/api/render/${jobId}/download`,
        createdAt: this.jobs.get(jobId)?.createdAt ?? new Date().toISOString(),
      });
    } catch (err) {
      if (fs.existsSync(assPath)) {
        fs.unlinkSync(assPath);
      }
      this.emit({
        id: jobId,
        status: "failed",
        progress: 0,
        stage: "Render failed",
        error: err instanceof Error ? err.message : String(err),
        createdAt: this.jobs.get(jobId)?.createdAt ?? new Date().toISOString(),
      });
    }
  }

  getOutputPath(jobId: string): string | undefined {
    const job = this.jobs.get(jobId);
    if (!job || job.status !== "completed") return undefined;
    const candidate = path.join(this.config.rendersDir, `cutflow-${jobId.slice(0, 8)}.mp4`);
    return fs.existsSync(candidate) ? candidate : undefined;
  }
}
