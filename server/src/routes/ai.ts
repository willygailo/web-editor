import type { FastifyInstance } from "fastify";
import { AutoEditRequestSchema, SaveTemplateRequestSchema } from "@cutflow/shared";
import type { ServerConfig } from "../config.js";
import type { MediaStore } from "../media/store.js";
import type { TemplatesStore } from "../media/templatesStore.js";
import { runAutoEditDirector } from "../ai/director.js";

export function registerAiRoutes(
  app: FastifyInstance,
  config: ServerConfig,
  store: MediaStore,
  templatesStore: TemplatesStore
): void {
  app.get("/api/templates", async () => {
    return { templates: templatesStore.listAll() };
  });

  app.post("/api/templates", async (request, reply) => {
    const parsed = SaveTemplateRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid template payload",
        details: parsed.error.flatten(),
      });
    }
    const saved = templatesStore.saveCustom(parsed.data);
    return { template: saved };
  });

  app.delete<{ Params: { id: string } }>("/api/templates/:id", async (request, reply) => {
    const ok = templatesStore.removeCustom(request.params.id);
    if (!ok) {
      return reply.status(404).send({ error: "Custom template not found" });
    }
    return { ok: true };
  });

  app.post("/api/projects/auto-edit", async (request, reply) => {
    const parsed = AutoEditRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid auto-edit payload",
        details: parsed.error.flatten(),
      });
    }

    const assetsById = new Map(store.list().map((a) => [a.id, a]));
    const filePathsById = new Map<string, string>();
    for (const asset of assetsById.values()) {
      const entry = store.get(asset.id);
      if (entry) filePathsById.set(asset.id, entry.filePath);
    }

    const geminiHeader = request.headers["x-gemini-api-key"];
    const anthropicHeader = request.headers["x-anthropic-api-key"];
    const workspaceHeader = request.headers["x-anthropic-workspace-id"];

    try {
      const result = await runAutoEditDirector({
        request: parsed.data,
        userGeminiKey: typeof geminiHeader === "string" ? geminiHeader : undefined,
        userAnthropicKey: typeof anthropicHeader === "string" ? anthropicHeader : undefined,
        userAnthropicWorkspaceId:
          typeof workspaceHeader === "string" ? workspaceHeader : undefined,
        config,
        assetsById,
        filePathsById,
      });
      return result;
    } catch (err) {
      return reply.status(400).send({
        error: err instanceof Error ? err.message : "Auto-edit failed",
      });
    }
  });
}
