import type {
  AutoEditRequest,
  AutoEditResponse,
  CutTemplatePreset,
  HealthResponse,
  MediaAsset,
  RenderJob,
  RenderRequest,
  SaveTemplateRequest,
  TranscribeResponse,
  WaveformResponse,
} from "@cutflow/shared";

export async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch("/api/health");
  if (!res.ok) throw new Error("Failed to check server health");
  return res.json();
}

export async function fetchMedia(): Promise<MediaAsset[]> {
  const res = await fetch("/api/media");
  if (!res.ok) throw new Error("Failed to load media library");
  const data = (await res.json()) as { assets: MediaAsset[] };
  return data.assets;
}

export async function loadSamplePack(): Promise<MediaAsset[]> {
  const res = await fetch("/api/media/sample-pack", { method: "POST" });
  if (!res.ok) throw new Error("Failed to load demo clips");
  const data = (await res.json()) as { assets: MediaAsset[] };
  return data.assets;
}

export function uploadMediaFiles(
  files: File[],
  onProgress?: (pct: number) => void
): Promise<MediaAsset[]> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    for (const file of files) {
      form.append("files", file);
    }

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/media/upload");

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) {
        onProgress(Math.round((ev.loaded / ev.total) * 100));
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = JSON.parse(xhr.responseText) as { assets: MediaAsset[] };
        resolve(parsed.assets);
      } else {
        try {
          const err = JSON.parse(xhr.responseText) as { error?: string };
          reject(new Error(err.error || `Upload failed (${xhr.status})`));
        } catch {
          reject(new Error(`Upload failed (${xhr.status})`));
        }
      }
    };

    xhr.onerror = () => reject(new Error("Network error while uploading media."));
    xhr.send(form);
  });
}

export async function deleteMedia(id: string): Promise<void> {
  const res = await fetch(`/api/media/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Failed to delete media");
  }
}

export async function fetchWaveform(
  assetId: string,
  bins = 100
): Promise<WaveformResponse> {
  const res = await fetch(
    `/api/media/${encodeURIComponent(assetId)}/waveform?bins=${bins}`
  );
  if (!res.ok) throw new Error("Failed to load audio waveform");
  return res.json();
}

export async function extractAudioFromVideo(assetId: string): Promise<MediaAsset> {
  const res = await fetch(
    `/api/media/${encodeURIComponent(assetId)}/extract-audio`,
    { method: "POST" }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Failed to extract audio");
  }
  const data = (await res.json()) as { asset: MediaAsset };
  return data.asset;
}

export async function transcribeMedia(
  assetId: string,
  geminiKey?: string
): Promise<TranscribeResponse> {
  const headers: Record<string, string> = {};
  if (geminiKey?.trim()) {
    headers["x-gemini-api-key"] = geminiKey.trim();
  }
  const res = await fetch(
    `/api/media/${encodeURIComponent(assetId)}/transcribe`,
    { method: "POST", headers }
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Failed to generate captions");
  }
  return res.json();
}

export async function fetchTemplates(): Promise<CutTemplatePreset[]> {
  const res = await fetch("/api/templates");
  if (!res.ok) throw new Error("Failed to load templates");
  const data = (await res.json()) as { templates: CutTemplatePreset[] };
  return data.templates;
}

export async function saveCustomTemplate(
  req: SaveTemplateRequest
): Promise<CutTemplatePreset> {
  const res = await fetch("/api/templates", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Failed to save template");
  }
  const data = (await res.json()) as { template: CutTemplatePreset };
  return data.template;
}

export async function deleteCustomTemplate(id: string): Promise<void> {
  const res = await fetch(`/api/templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || "Failed to delete template");
  }
}

export interface UserAiKeys {
  anthropicApiKey?: string;
  anthropicWorkspaceId?: string;
  geminiApiKey?: string;
}

export async function runAutoEdit(
  req: AutoEditRequest,
  userKeys?: UserAiKeys
): Promise<AutoEditResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (userKeys?.anthropicApiKey?.trim()) {
    headers["x-anthropic-api-key"] = userKeys.anthropicApiKey.trim();
  }
  if (userKeys?.anthropicWorkspaceId?.trim()) {
    headers["x-anthropic-workspace-id"] = userKeys.anthropicWorkspaceId.trim();
  }
  if (userKeys?.geminiApiKey?.trim()) {
    headers["x-gemini-api-key"] = userKeys.geminiApiKey.trim();
  }

  const res = await fetch("/api/projects/auto-edit", {
    method: "POST",
    headers,
    body: JSON.stringify(req),
  });

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || "Auto-edit failed");
  }

  return res.json();
}

export async function startRender(req: RenderRequest): Promise<RenderJob> {
  const res = await fetch("/api/render", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(err.error || "Failed to start MP4 render");
  }
  const data = (await res.json()) as { job: RenderJob };
  return data.job;
}

export function subscribeRenderEvents(
  jobId: string,
  onUpdate: (job: RenderJob) => void,
  onError?: (err: Error) => void
): () => void {
  const es = new EventSource(`/api/render/${encodeURIComponent(jobId)}/events`);
  es.onmessage = (event) => {
    try {
      const job = JSON.parse(event.data) as RenderJob;
      onUpdate(job);
      if (job.status === "completed" || job.status === "failed") {
        es.close();
      }
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error("Invalid render event"));
    }
  };
  es.onerror = () => {
    es.close();
  };
  return () => es.close();
}
