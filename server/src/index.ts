import fs from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { getConfig, REPO_ROOT } from "./config.js";
import { ensureBuiltinAudioBeats } from "./media/audioSynth.js";
import { checkFfmpegAvailable } from "./media/probe.js";
import { MediaStore } from "./media/store.js";
import { RenderJobQueue } from "./render/jobQueue.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerMediaRoutes } from "./routes/media.js";
import { registerRenderRoutes } from "./routes/render.js";

export async function buildApp() {
  const config = getConfig();
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    limits: {
      fileSize: config.maxUploadBytes,
      files: 12,
    },
  });

  const store = new MediaStore(config.assetsDbPath);
  const queue = new RenderJobQueue(config);

  const ffmpegAvailable = await checkFfmpegAvailable();
  if (ffmpegAvailable) {
    await ensureBuiltinAudioBeats(config.builtinsDir, store);
  }

  app.get("/api/health", async () => {
    return {
      ok: true,
      ffmpegAvailable,
      anthropicConfigured: Boolean(config.anthropicApiKey),
      anthropicModel: config.anthropicModel,
      geminiConfigured: Boolean(config.geminiApiKey),
      geminiModel: config.geminiModel,
      assetsCount: store.list().length,
    };
  });

  registerMediaRoutes(app, config, store);
  registerAiRoutes(app, config, store);
  registerRenderRoutes(app, store, queue);

  const webDistDir = path.join(REPO_ROOT, "web", "dist");
  if (fs.existsSync(webDistDir)) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/",
      wildcard: false,
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.status(404).send({ error: "API route not found" });
      }
      return reply.sendFile("index.html");
    });
  }

  return { app, config, store, queue };
}

const isEntrypoint = Boolean(
  process.argv[1] &&
    (path.resolve(process.argv[1]).endsWith(path.join("src", "index.ts")) ||
      path.resolve(process.argv[1]).endsWith(path.join("dist", "index.js")))
);

if (isEntrypoint) {
  const { app, config } = await buildApp();
  await app.listen({ port: config.port, host: config.host });
}
