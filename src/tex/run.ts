import { ChildProcess, spawn } from "child_process";
import { promises as fsp } from "fs";
import { groupCpuSeconds, STALL_MS, watchStall } from "./watchdog";

/** A TeX run that is still going after this long is stopped (default). */
export const RUN_TIMEOUT_MS = 5 * 60_000;
const OUTPUT_TAIL = 64 * 1024;

export interface TexRunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** The file whose growth shows progress (the job's log), or null for the output alone. */
  log: string | null;
  /** Stop a run with no log or output growth and under 2 % CPU for this long (default 30 s). */
  stallMs?: number;
  /** Stop a run still going after this long (default 5 min). */
  timeoutMs?: number;
  /** Aborting kills the run's process group; the promise then rejects (isAbortError). */
  signal?: AbortSignal;
}

export interface TexRunResult {
  /** The last 64 KB of what the run printed (stdout and stderr). */
  output: string;
  /** The stall watchdog stopped the run. */
  stalled: boolean;
  /** The timeout stopped the run. */
  timedOut: boolean;
  /** The exit code; null when a signal ended the run. */
  code: number | null;
}

/**
 * Run a TeX tool in its own process group (latexmk's engines and biber, XeLaTeX's helpers die
 * with it). The stall watchdog kills a run whose `log` and output stop growing while it uses no
 * CPU (XeLaTeX waiting for a macOS font download never returns) instead of waiting for the
 * timeout. Resolves when the process has closed; rejects when it cannot start or when `signal`
 * aborts, after the group was killed and the process closed.
 */
export function runTex(cmd: string, args: string[], o: TexRunOptions): Promise<TexRunResult> {
  return new Promise((resolvePromise, reject) => {
    if (o.signal?.aborted) {
      reject(abortError());
      return;
    }
    const child = spawn(cmd, args, {
      cwd: o.cwd,
      env: o.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let output = "";
    let outputBytes = 0;
    const collect = (chunk: Buffer) => {
      outputBytes += chunk.length;
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, o.timeoutMs ?? RUN_TIMEOUT_MS);
    let stalled = false;
    const log = o.log;
    const stopWatch = watchStall(
      {
        progress: () =>
          log
            ? fsp.stat(log).then(
                (st) => outputBytes + st.size,
                () => outputBytes,
              )
            : Promise.resolve(outputBytes),
        cpu: () => (child.pid ? groupCpuSeconds(child.pid) : Promise.resolve(null)),
      },
      () => {
        stalled = true;
        killTree(child);
      },
      o.stallMs ?? STALL_MS,
    );
    const abort = () => killTree(child);
    o.signal?.addEventListener("abort", abort);
    const end = () => {
      clearTimeout(timer);
      stopWatch();
      o.signal?.removeEventListener("abort", abort);
    };
    child.on("error", (err) => {
      end();
      reject(err);
    });
    child.on("close", (code) => {
      end();
      if (o.signal?.aborted) reject(abortError());
      else resolvePromise({ output, stalled, timedOut, code });
    });
  });
}

/** The error an aborted run rejects with. */
export function abortError(message = "The TeX run was cancelled."): Error {
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** Kill a spawned TeX tool and its children (latexmk runs the engine). */
export function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }
}
