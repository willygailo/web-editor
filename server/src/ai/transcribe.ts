import { GoogleGenAI } from "@google/genai";
import type { MediaAsset, TextOverlay } from "@cutflow/shared";
import { runProcess } from "../media/exec.js";

const CAPTIONS_SCHEMA = {
  type: "object",
  properties: {
    captions: {
      type: "array",
      maxItems: 40,
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          startSec: { type: "number" },
          endSec: { type: "number" },
        },
        required: ["text", "startSec", "endSec"],
      },
    },
  },
  required: ["captions"],
};

function buildOfflineSpeechPlaceholders(asset: MediaAsset): TextOverlay[] {
  const dur = Math.max(1, asset.durationSec);
  const windows: Array<{ startSec: number; endSec: number }> = [];
  let cursor = 0;

  for (const silence of asset.silenceRanges) {
    if (silence.startSec - cursor >= 0.6) {
      windows.push({ startSec: cursor, endSec: silence.startSec });
    }
    cursor = Math.max(cursor, silence.endSec);
  }
  if (dur - cursor >= 0.6) {
    windows.push({ startSec: cursor, endSec: dur });
  }
  if (windows.length === 0) {
    windows.push({ startSec: 0, endSec: Math.min(dur, 3.0) });
  }

  return windows.slice(0, 12).map((w, idx) => ({
    id: `cap-${Date.now()}-${idx + 1}`,
    text: `Caption ${idx + 1} (tap to edit)`,
    startSec: Number(w.startSec.toFixed(2)),
    endSec: Number(Math.min(dur, Math.max(w.startSec + 0.6, w.endSec)).toFixed(2)),
    position: "bottom" as const,
    style: "capcut-pop" as const,
    scale: 1,
    rotationDeg: 0,
    animation: "pop" as const,
  }));
}

export async function generateAutoCaptions(params: {
  asset: MediaAsset;
  filePath: string;
  geminiApiKey?: string;
  model?: string;
}): Promise<{ overlays: TextOverlay[]; source: "gemini" | "offline" }> {
  const { asset, filePath, geminiApiKey, model } = params;
  const key = geminiApiKey?.trim();
  const activeModel = model?.trim() || "gemini-4-hydrogen";

  if (!key || !asset.hasAudio) {
    return { overlays: buildOfflineSpeechPlaceholders(asset), source: "offline" };
  }

  try {
    // Extract compact 16kHz mono MP3 audio directly to stdout buffer
    const audioRes = await runProcess(
      "ffmpeg",
      ["-y", "-t", "60", "-i", filePath, "-vn", "-ac", "1", "-ar", "16000", "-f", "mp3", "pipe:1"],
      { timeoutMs: 20_000 }
    );

    if (audioRes.code !== 0 || audioRes.stdoutBuffer.length < 100) {
      return { overlays: buildOfflineSpeechPlaceholders(asset), source: "offline" };
    }

    const client = new GoogleGenAI({ apiKey: key });
    const interaction = await client.interactions.create({
      model: activeModel,
      system_instruction:
        "Transcribe spoken audio into concise short CapCut-style subtitle chunks (2-6 words per caption) with accurate startSec and endSec timestamps.",
      input: [
        {
          type: "audio",
          data: audioRes.stdoutBuffer.toString("base64"),
          mime_type: "audio/mp3",
        },
        {
          type: "text",
          text: `Transcribe speech in this ${asset.durationSec.toFixed(1)}s clip into timed captions.`,
        },
      ] as never,
      response_format: {
        type: "text",
        mime_type: "application/json",
        schema: CAPTIONS_SCHEMA,
      },
      store: false,
    });

    const raw = interaction.output_text;
    if (!raw) throw new Error("Empty transcription output");

    const parsed = JSON.parse(raw) as {
      captions?: Array<{ text: string; startSec: number; endSec: number }>;
    };
    const overlays: TextOverlay[] = (parsed.captions || [])
      .filter((c) => c.text?.trim())
      .map((c, idx) => ({
        id: `cap-${Date.now()}-${idx + 1}`,
        text: c.text.trim().slice(0, 120),
        startSec: Number(Math.max(0, c.startSec).toFixed(2)),
        endSec: Number(
          Math.min(asset.durationSec, Math.max(c.startSec + 0.4, c.endSec)).toFixed(2)
        ),
        position: "bottom" as const,
        style: "capcut-pop" as const,
        scale: 1,
        rotationDeg: 0,
        animation: "pop" as const,
      }));

    if (overlays.length === 0) {
      return { overlays: buildOfflineSpeechPlaceholders(asset), source: "offline" };
    }

    return { overlays, source: "gemini" };
  } catch {
    return { overlays: buildOfflineSpeechPlaceholders(asset), source: "offline" };
  }
}
