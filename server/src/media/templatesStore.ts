import crypto from "node:crypto";
import fs from "node:fs";
import {
  CUT_TEMPLATE_PRESETS,
  CutTemplatePresetSchema,
  type CutTemplatePreset,
  type SaveTemplateRequest,
} from "@cutflow/shared";

export class TemplatesStore {
  private custom = new Map<string, CutTemplatePreset>();

  constructor(private readonly dbPath: string) {
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.dbPath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.dbPath, "utf8")) as unknown[];
      for (const item of raw) {
        const parsed = CutTemplatePresetSchema.safeParse(item);
        if (parsed.success) {
          this.custom.set(parsed.data.id, { ...parsed.data, isCustom: true });
        }
      }
    } catch {
      // ignore invalid templates file
    }
  }

  private persist(): void {
    fs.writeFileSync(
      this.dbPath,
      JSON.stringify(Array.from(this.custom.values()), null, 2)
    );
  }

  listAll(): CutTemplatePreset[] {
    return [...Array.from(this.custom.values()), ...CUT_TEMPLATE_PRESETS];
  }

  saveCustom(input: SaveTemplateRequest): CutTemplatePreset {
    const id = input.id?.trim() || `custom-${crypto.randomUUID().slice(0, 8)}`;
    const tpl = CutTemplatePresetSchema.parse({
      ...input,
      id,
      isCustom: true,
    });
    this.custom.set(id, tpl);
    this.persist();
    return tpl;
  }

  removeCustom(id: string): boolean {
    if (!this.custom.has(id)) return false;
    this.custom.delete(id);
    this.persist();
    return true;
  }
}
