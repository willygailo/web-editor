import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "./index.js";

const e2eStorage = fs.mkdtempSync(path.join(os.tmpdir(), "cutflow-e2e-"));
process.env.STORAGE_DIR = e2eStorage;

describe("End-to-End Fastify API (Sample Pack -> Auto-Edit -> FFmpeg MP4 Render)", () => {
  let appRef: Awaited<ReturnType<typeof buildApp>>["app"] | null = null;

  afterAll(async () => {
    if (appRef) await appRef.close();
    fs.rmSync(e2eStorage, { recursive: true, force: true });
  });

  it("executes full sample-pack -> auto-edit -> render -> MP4 download flow", async () => {
    const { app } = await buildApp();
    appRef = app;

    const healthRes = await app.inject({ method: "GET", url: "/api/health" });
    expect(healthRes.statusCode).toBe(200);
    const health = healthRes.json() as { ok: boolean; ffmpegAvailable: boolean; assetsCount: number };
    expect(health.ok).toBe(true);
    expect(health.ffmpegAvailable).toBe(true);
    expect(health.assetsCount).toBeGreaterThanOrEqual(3); // built-in beats

    const sampleRes = await app.inject({ method: "POST", url: "/api/media/sample-pack" });
    expect(sampleRes.statusCode).toBe(200);
    const sampleData = sampleRes.json() as { assets: Array<{ id: string }> };
    expect(sampleData.assets.length).toBe(3);

    const editRes = await app.inject({
      method: "POST",
      url: "/api/projects/auto-edit",
      payload: {
        prompt: 'Gawa ka ng hype 5s TikTok edit with smooth zoom "MANILA NIGHTS"',
        assetIds: sampleData.assets.map((a) => a.id),
        mode: "auto",
      },
    });
    expect(editRes.statusCode).toBe(200);
    const editData = editRes.json() as { project: { id: string; aspectRatio: string; clips: unknown[] } };
    expect(editData.project.aspectRatio).toBe("9:16");
    expect(editData.project.clips.length).toBeGreaterThanOrEqual(2);

    const renderRes = await app.inject({
      method: "POST",
      url: "/api/render",
      payload: {
        project: editData.project,
        quality: "720p",
      },
    });
    expect(renderRes.statusCode).toBe(200);
    const { job: initialJob } = renderRes.json() as { job: { id: string; status: string } };

    let finalStatus = initialJob.status;
    let outputUrl: string | undefined;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const pollRes = await app.inject({ method: "GET", url: `/api/render/${initialJob.id}` });
      const { job } = pollRes.json() as { job: { status: string; outputUrl?: string; error?: string } };
      finalStatus = job.status;
      outputUrl = job.outputUrl;
      if (job.status === "completed" || job.status === "failed") {
        expect(job.error).toBeUndefined();
        break;
      }
    }

    expect(finalStatus).toBe("completed");
    expect(outputUrl).toBeTruthy();

    const dlRes = await app.inject({ method: "GET", url: outputUrl! });
    expect(dlRes.statusCode).toBe(200);
    expect(dlRes.headers["content-type"]).toBe("video/mp4");
    expect(dlRes.rawPayload.length).toBeGreaterThan(5000);
    expect(dlRes.rawPayload.subarray(4, 8).toString("ascii")).toBe("ftyp");
  }, 60_000);
});
