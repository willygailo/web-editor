import fs from "node:fs";
import type { MediaAsset } from "@cutflow/shared";

interface StoredEntry {
  asset: MediaAsset;
  filePath: string;
  thumbPath?: string;
}

export class MediaStore {
  private entries = new Map<string, StoredEntry>();

  constructor(private readonly dbPath: string) {
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.dbPath)) return;
    try {
      const raw = fs.readFileSync(this.dbPath, "utf8");
      const items = JSON.parse(raw) as StoredEntry[];
      for (const entry of items) {
        if (entry?.asset?.id && fs.existsSync(entry.filePath)) {
          this.entries.set(entry.asset.id, entry);
        }
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
