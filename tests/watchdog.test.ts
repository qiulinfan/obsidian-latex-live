import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CompileResult, Compiler } from "../src/tex/compiler";
import { Engine } from "../src/tex/project";
import {
  parseCpuTime,
  stallMessage,
  StallProbe,
  watchStall,
} from "../src/tex/watchdog";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Watch a fake run for `ms`; returns when onStall fired (ms after start), or null. */
async function watchFor(
  probe: StallProbe,
  stallMs: number,
  ms: number,
): Promise<number | null> {
  const started = Date.now();
  let firedAt: number | null = null;
  const stop = watchStall(probe, () => (firedAt = Date.now() - started), stallMs);
  await sleep(ms);
  stop();
  return firedAt;
}

test("ps CPU times parse in the macOS and Linux formats", () => {
  assert.equal(parseCpuTime("0:01.05"), 1.05);
  assert.equal(parseCpuTime("603:27.07"), 603 * 60 + 27.07);
  assert.equal(parseCpuTime("00:00:03"), 3);
  assert.equal(parseCpuTime("1-02:03:04"), 86400 + 2 * 3600 + 3 * 60 + 4);
  assert.equal(parseCpuTime("TIME"), null);
  assert.equal(parseCpuTime(""), null);
});

test("watchdog: no progress and no CPU for the stall time fires once", async () => {
  let calls = 0;
  const probe: StallProbe = {
    progress: async () => 120,
    cpu: async () => 0.4,
  };
  const started = Date.now();
  let fired = 0;
  const stop = watchStall(probe, () => {
    calls++;
    fired = Date.now() - started;
  }, 200);
  await sleep(700);
  stop();
  assert.equal(calls, 1);
  // The first sample moves off the initial (empty) state; the stall counts from there.
  assert.ok(fired >= 200 && fired < 500, `fired after ${fired} ms`);
});

test("watchdog: a growing log or a busy CPU keeps the run alive", async () => {
  let bytes = 0;
  const growing = await watchFor(
    { progress: async () => (bytes += 10), cpu: async () => 0 },
    150,
    600,
  );
  assert.equal(growing, null);
  let cpu = 0;
  const t0 = Date.now();
  const busy = await watchFor(
    // A computing run: CPU time follows the wall clock.
    { progress: async () => 5, cpu: async () => (cpu = (Date.now() - t0) / 1000) },
    150,
    600,
  );
  assert.ok(cpu > 0);
  assert.equal(busy, null);
});

test("watchdog: time the process was suspended (sleep) does not count as a stall", async () => {
  const started = Date.now();
  let fired: number | null = null;
  const stop = watchStall(
    { progress: async () => 0, cpu: async () => 0 },
    () => (fired = Date.now() - started),
    200,
  );
  // Block the event loop past the stall time, as a sleeping Mac would.
  while (Date.now() - started < 400);
  await sleep(500);
  stop();
  assert.ok(fired !== null && fired >= 550, `fired after ${fired} ms`);
});

test("watchdog: unknown CPU time (Windows) never stops a run", async () => {
  const fired = await watchFor(
    { progress: async () => 0, cpu: async () => null },
    100,
    450,
  );
  assert.equal(fired, null);
});

test("stall message: the CoreText font hint only for XeLaTeX on macOS", () => {
  const mac = stallMessage("xelatex", 30_000, "darwin");
  assert.match(mac, /no progress for 30 s/);
  assert.match(mac, /\\PassOptionsToPackage\{fontset=fandol\}\{ctex\} before \\documentclass/);
  assert.match(mac, /install the fonts/);
  for (const [engine, platform] of [
    ["pdflatex", "darwin"],
    ["xelatex", "linux"],
  ] as [Engine, NodeJS.Platform][]) {
    const msg = stallMessage(engine, 30_000, platform);
    assert.equal(msg, "The TeX run made no progress for 30 s and was stopped.");
  }
});

// Fake engines: shell scripts named like the real ones in a temporary bin dir.
const unix = process.platform === "win32" ? "needs a POSIX shell and ps" : false;

function fakeTex(files: Record<string, string>, engine: string, script: string) {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-wd-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  const bin = mkdtempSync(join(tmpdir(), "latex-live-wd-bin-"));
  writeFileSync(join(bin, engine), `#!/bin/sh\n${script}\n`);
  chmodSync(join(bin, engine), 0o755);
  return { root: join(dir, "main.tex"), dir, bin };
}

function run(
  root: string,
  bin: string,
  engine: Engine,
  stallMs: number,
): Promise<{ result?: CompileResult; failure?: Error; ms: number }> {
  const outDir = mkdtempSync(join(tmpdir(), "latex-live-wd-out-"));
  const started = Date.now();
  return new Promise((resolve) => {
    const compiler = new Compiler(
      root,
      () => ({
        binDir: bin,
        engine,
        outDir,
        preambleCache: false,
        shellEscape: false,
        stallMs,
      }),
      {
        onStart: () => undefined,
        onResult: (result) => {
          compiler.dispose();
          resolve({ result, ms: Date.now() - started });
        },
        onFailure: (failure) => {
          compiler.dispose();
          resolve({ failure, ms: Date.now() - started });
        },
      },
    );
    compiler.request("fast");
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("a TeX run that hangs silently is killed with its process group and reported", { skip: unix, timeout: 20_000 }, async () => {
  // Like XeLaTeX blocked in CoreText's font download: a little output, then
  // nothing, at 0 % CPU. The helper process must die with it (process group).
  const { root, dir, bin } = fakeTex(
    { "main.tex": "\\documentclass[lang=cn]{elegantbook}\n" },
    "xelatex",
    'echo "This is XeTeX (fake)"\nsleep 60 &\necho $! > helper.pid\nwait',
  );
  const { failure, result, ms } = await run(root, bin, "xelatex", 600);
  assert.equal(failure, undefined, failure?.message);
  assert.ok(ms >= 600 && ms < 4000, `stopped after ${ms} ms`);
  // Reported like a compile error: the problem list shows the whole hint.
  assert.equal(result!.pdfWritten, false);
  assert.deepEqual(
    result!.log.diagnostics.filter((d) => d.severity === "error"),
    [{ severity: "error", file: null, line: null, message: stallMessage("xelatex", 600) }],
  );
  assert.match(result!.rawLog, /This is XeTeX \(fake\)/);
  const helper = Number(readFileSync(join(dir, "helper.pid"), "utf8"));
  for (let i = 0; i < 20 && alive(helper); i++) await sleep(50);
  assert.equal(alive(helper), false, "the whole process group was killed");
});

test("a run whose log keeps growing is not stopped, even at 0 % CPU", { skip: unix, timeout: 20_000 }, async () => {
  // No stdout at all: only the log in the output directory grows.
  const { root, bin } = fakeTex(
    { "main.tex": "\\documentclass{article}\n" },
    "pdflatex",
    [
      'for a in "$@"; do case "$a" in -output-directory=*) out="${a#-output-directory=}";; esac; done',
      "i=0",
      'while [ $i -lt 16 ]; do echo "line $i" >> "$out/main.log"; sleep 0.1; i=$((i+1)); done',
    ].join("\n"),
  );
  const { failure, result, ms } = await run(root, bin, "pdflatex", 400);
  assert.equal(failure, undefined, failure?.message);
  assert.ok(ms > 1000, `finished after ${ms} ms, longer than the stall time`);
  assert.match(result!.rawLog, /line 15/);
});
