import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../..");

function loadDotEnv(): void {
  const envPath = path.join(REPO_ROOT, ".env");
  if (!fs.existsSync(envPath)) return;

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = val;
    }
  }
}

loadDotEnv();

export interface ServerConfig {
  port: number;
  host: string;
  storageDir: string;
  uploadsDir: string;
  proxiesDir: string;
  rendersDir: string;
  builtinsDir: string;
  assetsDbPath: string;
  geminiApiKey: string;
  geminiModel: string;
  anthropicApiKey: string;
  anthropicModel: string;
  anthropicWorkspaceId: string;
  maxUploadBytes: number;
}

export function getConfig(): ServerConfig {
  const rawStorage = process.env.STORAGE_DIR || "./data";
  const storageDir = path.isAbsolute(rawStorage)
    ? rawStorage
    : path.resolve(REPO_ROOT, rawStorage);

  const uploadsDir = path.join(storageDir, "uploads");
  const proxiesDir = path.join(storageDir, "proxies");
  const rendersDir = path.join(storageDir, "renders");
  const builtinsDir = path.join(storageDir, "builtins");

  for (const dir of [storageDir, uploadsDir, proxiesDir, rendersDir, builtinsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const maxUploadMb = Number(process.env.MAX_UPLOAD_MB || "500");

  return {
    port: Number(process.env.PORT || "3001"),
    host: process.env.HOST || "0.0.0.0",
    storageDir,
    uploadsDir,
    proxiesDir,
    rendersDir,
    builtinsDir,
    assetsDbPath: path.join(storageDir, "assets.json"),
    geminiApiKey: (process.env.GEMINI_API_KEY || "").trim(),
    geminiModel: (process.env.GEMINI_MODEL || "gemini-4-hydrogen").trim(),
    anthropicApiKey: (process.env.ANTHROPIC_API_KEY || "").trim(),
    anthropicModel: (process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5").trim(),
    anthropicWorkspaceId: (process.env.ANTHROPIC_WORKSPACE_ID || "").trim(),
    maxUploadBytes: Math.max(10, maxUploadMb) * 1024 * 1024,
  };
}
