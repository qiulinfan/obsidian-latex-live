import { execFile } from "child_process";
import { Engine } from "./project";

/** A run that shows no log growth and no CPU use for this long is stopped. */
export const STALL_MS = 30_000;
/** CPU share below which a run counts as idle (a stuck XeLaTeX used 0.4 %). */
const IDLE_CPU_SHARE = 0.02;

export interface StallProbe {
  /** Grows while the run visibly works: bytes of output and log so far. */
  progress(): Promise<number>;
  /** CPU seconds the run's processes used so far; null when unknown. */
  cpu(): Promise<number | null>;
}

/**
 * Call `onStall` once when, for `stallMs`, the progress marker stayed the
 * same and the run used (almost) no CPU. A slow run that computes, such as a
 * long TikZ loop, is never stopped; neither is any run whose CPU time cannot
 * be read. Returns a function that stops watching.
 */
export function watchStall(
  probe: StallProbe,
  onStall: () => void,
  stallMs = STALL_MS,
): () => void {
  const intervalMs = Math.min(5000, Math.max(20, stallMs / 4));
  // Runs start with an empty log and no CPU time.
  let ref = { progress: 0, cpu: 0, at: Date.now() };
  let lastTick = ref.at;
  let stopped = false;
  let sampling = false;
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    // A late tick means this process was suspended (the Mac slept) or its
    // timers were throttled: restart the clock instead of counting the gap.
    const tick = Date.now();
    const suspended = tick - lastTick > 3 * intervalMs;
    lastTick = tick;
    if (sampling || stopped) return;
    sampling = true;
    void Promise.all([probe.progress(), probe.cpu()])
      .then(([progress, cpu]) => {
        if (stopped || cpu === null) return;
        const now = Date.now();
        const busy =
          Math.abs(cpu - ref.cpu) > (IDLE_CPU_SHARE * (now - ref.at)) / 1000;
        if (progress !== ref.progress || busy || suspended) {
          ref = { progress, cpu, at: now };
        } else if (now - ref.at >= stallMs) {
          stop();
          onStall();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        sampling = false;
      });
  }, intervalMs);
  return stop;
}

/**
 * CPU seconds used by the live processes of a process group (a TeX run
 * spawned detached, with everything latexmk starts), from `ps`. Null on
 * Windows, when `ps` fails, or when the group has no processes left.
 */
export function groupCpuSeconds(pgid: number): Promise<number | null> {
  if (process.platform === "win32") return Promise.resolve(null);
  return new Promise((resolvePromise) => {
    execFile(
      "ps",
      ["-A", "-o", "pgid=,time="],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          resolvePromise(null);
          return;
        }
        let total: number | null = null;
        for (const line of stdout.split("\n")) {
          const [group, time] = line.trim().split(/\s+/);
          if (Number(group) !== pgid) continue;
          const secs = parseCpuTime(time ?? "");
          if (secs !== null) total = (total ?? 0) + secs;
        }
        resolvePromise(total);
      },
    );
  });
}

/** `ps` TIME: `[[dd-]hh:]mm:ss[.ss]` (macOS prints `mmm:ss.ss`). */
export function parseCpuTime(text: string): number | null {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(text);
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return (
    Number(days ?? 0) * 86400 +
    Number(hours ?? 0) * 3600 +
    Number(minutes) * 60 +
    Number(seconds)
  );
}

/** What the preview reports for a run the watchdog stopped. */
export function stallMessage(
  engine: Engine,
  stallMs = STALL_MS,
  platform: NodeJS.Platform = process.platform,
): string {
  const secs = Math.round(stallMs / 1000);
  if (engine === "xelatex" && platform === "darwin") {
    return (
      `XeLaTeX made no progress for ${secs} s and was stopped: it is probably ` +
      "waiting for macOS to download a font (ctex fontset). Add " +
      "\\PassOptionsToPackage{fontset=fandol}{ctex} before \\documentclass, " +
      "or install the fonts."
    );
  }
  return `The TeX run made no progress for ${secs} s and was stopped.`;
}
