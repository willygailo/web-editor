import fs from "node:fs";
import path from "node:path";
import type { MediaAsset } from "@cutflow/shared";

interface StoredEntry {
  asset: MediaAsset;
  filePath: string;
  thumbPath?: string;
}

function crossPlatformBasename(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

function resolveStoredFilePath(
  storedPath: string | undefined,
  fallbackDirs: string[],
  fallbackFilename?: string
): string | undefined {
  if (!storedPath) return undefined;
  if (fs.existsSync(storedPath)) return storedPath;

  const names = [crossPlatformBasename(storedPath), fallbackFilename].filter(
    (name): name is string => Boolean(name)
  );
  for (const name of names) {
    for (const dir of fallbackDirs) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export class MediaStore {
  private entries = new Map<string, StoredEntry>();

  constructor(private readonly dbPath: string) {
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.dbPath)) return;
    const storageDir = path.dirname(this.dbPath);
    const mediaFallbackDirs = [
      path.join(storageDir, "uploads"),
      path.join(storageDir, "builtins"),
    ];
    const thumbFallbackDirs = [path.join(storageDir, "proxies")];

    try {
      const raw = fs.readFileSync(this.dbPath, "utf8");
      const items = JSON.parse(raw) as StoredEntry[];
      for (const entry of items) {
        if (!entry?.asset?.id) continue;
        const resolvedFile = resolveStoredFilePath(
          entry.filePath,
          mediaFallbackDirs,
          entry.asset.filename
        );
        if (!resolvedFile) continue;

        const resolvedThumb = resolveStoredFilePath(
          entry.thumbPath,
          thumbFallbackDirs,
          `${entry.asset.id}.jpg`
        );
        this.entries.set(entry.asset.id, {
          asset: entry.asset,
          filePath: resolvedFile,
          thumbPath: resolvedThumb,
        });
      }
    } catch {
      // Corrupt or empty db; start clean
    }
  }

  private save(): void {
    const data = Array.from(this.entries.values());
    fs.writeFileSync(this.dbPath, JSON.stringify(data, null, 2));
  }

  upsert(asset: MediaAsset, filePath: string, thumbPath?: string): void {
    this.entries.set(asset.id, { asset, filePath, thumbPath });
    this.save();
  }

  get(id: string): StoredEntry | undefined {
    return this.entries.get(id);
  }

  list(): MediaAsset[] {
    return Array.from(this.entries.values()).map((e) => e.asset);
  }

  remove(id: string): boolean {
    const existing = this.entries.get(id);
    if (!existing) return false;
    this.entries.delete(id);
    if (!existing.asset.isBuiltIn) {
      if (fs.existsSync(existing.filePath)) {
        fs.unlinkSync(existing.filePath);
      }
      if (existing.thumbPath && fs.existsSync(existing.thumbPath)) {
        fs.unlinkSync(existing.thumbPath);
      }
    }
    this.save();
    return true;
  }
}
