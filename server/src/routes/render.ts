import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import { RenderRequestSchema } from "@cutflow/shared";
import { sanitizeCutProject } from "../ai/sanitize.js";
import type { MediaStore } from "../media/store.js";
import type { RenderJobQueue } from "../render/jobQueue.js";

export function registerRenderRoutes(
  app: FastifyInstance,
  store: MediaStore,
  queue: RenderJobQueue
): void {
  app.post("/api/render", async (request, reply) => {
    const parsed = RenderRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid render payload",
        details: parsed.error.flatten(),
      });
    }

    const assetsById = new Map(store.list().map((a) => [a.id, a]));
    const filePathsById = new Map<string, string>();
    for (const asset of assetsById.values()) {
      const entry = store.get(asset.id);
      if (entry) filePathsById.set(asset.id, entry.filePath);
    }

    const sanitized = sanitizeCutProject(parsed.data.project, assetsById);
    const job = queue.enqueue(
      sanitized.project,
      parsed.data.quality,
      assetsById,
      filePathsById
    );
    return { job };
  });

  app.get<{ Params: { id: string } }>("/api/render/:id", async (request, reply) => {
    const job = queue.get(request.params.id);
    if (!job) return reply.status(404).send({ error: "Render job not found" });
    return { job };
  });

  app.get<{ Params: { id: string } }>("/api/render/:id/events", async (request, reply) => {
    const job = queue.get(request.params.id);
    if (!job) return reply.status(404).send({ error: "Render job not found" });

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const unsub = queue.subscribe(request.params.id, (updated) => {
      reply.raw.write(`data: ${JSON.stringify(updated)}\n\n`);
      if (updated.status === "completed" || updated.status === "failed") {
        unsub();
        reply.raw.end();
      }
    });

    request.raw.on("close", () => {
      unsub();
    });
  });

  app.get<{ Params: { id: string } }>("/api/render/:id/download", async (request, reply) => {
    const outputPath = queue.getOutputPath(request.params.id);
    if (!outputPath || !fs.existsSync(outputPath)) {
      return reply.status(404).send({ error: "Rendered MP4 not ready or not found" });
    }

    const stat = fs.statSync(outputPath);
    reply.header("Content-Type", "video/mp4");
    reply.header("Content-Length", String(stat.size));
    reply.header(
      "Content-Disposition",
      `attachment; filename="cutflow-${request.params.id.slice(0, 8)}.mp4"`
    );
    return reply.send(fs.createReadStream(outputPath));
  });
}
