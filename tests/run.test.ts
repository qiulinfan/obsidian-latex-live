import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { isAbortError, runTex } from "../src/tex/run";

// runTex (src/tex/run.ts): every TeX tool the plugin spawns runs in its own process group.
const unix = process.platform === "win32" ? "process groups are POSIX-only here" : false;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

/** A fake TeX tool: a shell script in a temporary folder. */
function fakeTool(script: string): { dir: string; tool: string } {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-run-"));
  dirs.push(dir);
  const tool = join(dir, "xelatex");
  writeFileSync(tool, `#!/bin/sh\n${script}\n`);
  chmodSync(tool, 0o755);
  return { dir, tool };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(file: string): Promise<number> {
  for (let i = 0; i < 100; i++) {
    try {
      const pid = Number(readFileSync(file, "utf8"));
      if (pid) return pid;
    } catch {
      // not written yet
    }
    await sleep(20);
  }
  throw new Error(`${file} never appeared`);
}

test("runTex: output, exit code, and the log's growth", { skip: unix }, async () => {
  const { dir, tool } = fakeTool('echo "This is XeTeX (fake)"; echo oops >&2; exit 3');
  const r = await runTex(tool, [], { cwd: dir, env: process.env, log: join(dir, "main.log") });
  assert.match(r.output, /This is XeTeX \(fake\)/);
  assert.match(r.output, /oops/);
  assert.deepEqual({ code: r.code, stalled: r.stalled, timedOut: r.timedOut }, { code: 3, stalled: false, timedOut: false });
});

test("runTex: aborting kills the whole process group and rejects", { skip: unix, timeout: 10_000 }, async () => {
  // The engine starts a helper (like XeLaTeX's font tools) and waits for it.
  const { dir, tool } = fakeTool("sleep 60 &\necho $! > helper.pid\necho $$ > engine.pid\nwait");
  const controller = new AbortController();
  const run = runTex(tool, [], { cwd: dir, env: process.env, log: null, signal: controller.signal });
  const helper = await waitFor(join(dir, "helper.pid"));
  const engine = await waitFor(join(dir, "engine.pid"));
  const started = Date.now();
  controller.abort();
  await assert.rejects(run, (e) => isAbortError(e));
  assert.ok(Date.now() - started < 2000, "settles once the process closed");
  for (let i = 0; i < 20 && (alive(helper) || alive(engine)); i++) await sleep(50);
  assert.equal(alive(engine), false, "the engine was killed");
  assert.equal(alive(helper), false, "its helper died with the group");
});

test("runTex: an aborted signal starts nothing; the timeout stops a run", { skip: unix, timeout: 10_000 }, async () => {
  const { dir, tool } = fakeTool("echo started > started.txt\nsleep 60");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runTex(tool, [], { cwd: dir, env: process.env, log: null, signal: controller.signal }), (e) => isAbortError(e));
  await sleep(100);
  assert.throws(() => readFileSync(join(dir, "started.txt")), "the tool never ran");
  const r = await runTex(tool, [], { cwd: dir, env: process.env, log: null, timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.equal(r.stalled, false);
});
