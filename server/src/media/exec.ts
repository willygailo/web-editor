import { spawn } from "node:child_process";

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
  stdoutBuffer: Buffer;
}

export function runProcess(
  bin: string,
  args: string[],
  options?: { timeoutMs?: number; onStdoutLine?: (line: string) => void; onStderrLine?: (line: string) => void }
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutRemainder = "";
    let stderrRemainder = "";
    let timer: NodeJS.Timeout | undefined;

    if (options?.timeoutMs) {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`${bin} timed out after ${options.timeoutMs}ms`));
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
