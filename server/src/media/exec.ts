import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  stdoutBuffer: Buffer;
}

function cleanEnvPath(value?: string): string {
  if (!value) return "";
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function findExecutableOnPath(commandName: string): string | null {
  const pathEnv = process.env.PATH || "";
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM")
          .split(";")
          .filter(Boolean)
      : [""];

  for (const dir of dirs) {
    for (const ext of exts) {
      const filename =
        process.platform === "win32" && !commandName.toLowerCase().endsWith(ext.toLowerCase())
          ? `${commandName}${ext.toLowerCase()}`
          : commandName;
      const candidate = path.join(dir, filename);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveMediaBinary(tool: "ffmpeg" | "ffprobe"): string {
  const envKey = tool === "ffmpeg" ? "FFMPEG_PATH" : "FFPROBE_PATH";
  const explicit = cleanEnvPath(process.env[envKey]);
  if (explicit) return explicit;

  if (tool === "ffprobe") {
    const ffmpegExplicit = cleanEnvPath(process.env.FFMPEG_PATH);
    if (ffmpegExplicit) {
      const ext = process.platform === "win32" ? ".exe" : "";
      const sibling = path.join(path.dirname(ffmpegExplicit), `ffprobe${ext}`);
      if (fs.existsSync(sibling)) return sibling;
    }
  }

  if (process.platform === "win32") {
    const onPath = findExecutableOnPath(tool);
    if (onPath) return onPath;

    const exe = `${tool}.exe`;
    const candidates = [
      process.env.LOCALAPPDATA
        ? path.join(process.env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", exe)
        : "",
      path.join("C:\\ffmpeg\\bin", exe),
      process.env.ProgramData
        ? path.join(process.env.ProgramData, "chocolatey", "bin", exe)
        : "",
      process.env.USERPROFILE
        ? path.join(process.env.USERPROFILE, "scoop", "shims", exe)
        : "",
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  return tool;
}

export function getFfmpegBin(): string {
  return resolveMediaBinary("ffmpeg");
}

export function getFfprobeBin(): string {
  return resolveMediaBinary("ffprobe");
}

export function runProcess(
  bin: string,
  args: string[],
  options?: { timeoutMs?: number; onStdoutLine?: (line: string) => void; onStderrLine?: (line: string) => void }
): Promise<ProcessResult> {
  const resolvedBin =
    bin === "ffmpeg" ? getFfmpegBin() : bin === "ffprobe" ? getFfprobeBin() : bin;

  return new Promise((resolve, reject) => {
    const child = spawn(resolvedBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutRemainder = "";
    let stderrRemainder = "";
    let timer: NodeJS.Timeout | undefined;

    if (options?.timeoutMs) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Process already exited
        }
        reject(new Error(`${resolvedBin} timed out after ${options.timeoutMs}ms`));
      }, options.timeoutMs);
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutChunks.push(chunk);
      if (options?.onStdoutLine) {
        stdoutRemainder += chunk.toString("utf8");
        const lines = stdoutRemainder.split(/\r?\n/);
        stdoutRemainder = lines.pop() ?? "";
        for (const line of lines) options.onStdoutLine(line);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk);
      if (options?.onStderrLine) {
        stderrRemainder += chunk.toString("utf8");
        const lines = stderrRemainder.split(/\r?\n/);
        stderrRemainder = lines.pop() ?? "";
        for (const line of lines) options.onStderrLine(line);
      }
    });

    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (options?.onStdoutLine && stdoutRemainder) options.onStdoutLine(stdoutRemainder);
      if (options?.onStderrLine && stderrRemainder) options.onStderrLine(stderrRemainder);
      const stdoutBuffer = Buffer.concat(stdoutChunks);
      resolve({
        code: code ?? -1,
        stdout: stdoutBuffer.toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        stdoutBuffer,
      });
    });
  });
}
