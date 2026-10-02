import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type LatexLivePlugin from "../src/main";
import { LatexSession, type CompiledPdf, type SessionEvent } from "../src/session";
import { resolveTexBinDir, texTool } from "../src/tex/binaries";
import type { CompileResult } from "../src/tex/compiler";

const binDir = process.env.TEXBIN ?? resolveTexBinDir("");
const skip = !binDir ? "no TeX installation found"
  : !existsSync(texTool(binDir, "lualatex")) ? "no lualatex" : false;

async function until(predicate: () => boolean, timeout = 45_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    assert.ok(Date.now() - started < timeout, "Lua session settled before its deadline");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const document = (revision: string) => [
  "\\documentclass{article}", "\\begin{document}",
  `\\pdfextension info{ /LLRevision (${revision}) }`,
  `Native Lua session revision ${revision}.`, "\\end{document}", "",
].join("\n");

test("Lua session retains its delivered PDF and source snapshot through a fatal edit, then replaces both after repair", {
  skip, timeout: 90_000,
}, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "latex-live-lua-session-"));
  const root = join(dir, "main.tex");
  const events: SessionEvent[] = [];
  const delivered: { result: CompileResult | null; pdf: Uint8Array | null; compiled: CompiledPdf | null }[] = [];
  const plugin = {
    settings: { engine: "lualatex", preambleCache: true, shellEscape: false },
    texBinDir: () => binDir,
    openTexFiles: () => [root],
    sessionChanged: (session: LatexSession, event: SessionEvent) => {
      events.push(event);
      if (event === "result") delivered.push({ result: session.last, pdf: session.lastPdf, compiled: session.compiled });
    },
  } as unknown as LatexLivePlugin;
  const session = new LatexSession(plugin, root);
  t.after(async () => {
    session.dispose();
    await until(() => !session.compiler.compiling, 5000);
    rmSync(session.outDir, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });
  const compile = async () => {
    await until(() => !session.compiler.compiling);
    const before = delivered.length;
    session.request();
    await until(() => !session.compiler.compiling && (delivered.length > before || session.failure !== null));
    assert.equal(session.failure, null);
    assert.ok(session.last);
    return session.last;
  };

  const initialSource = document("initial");
  writeFileSync(root, initialSource);
  const initial = await compile();
  assert.equal(initial.engine, "lualatex", "the user's explicit Lua engine reaches the real compiler");
  assert.equal(initial.pdfWritten, true, initial.rawLog);
  assert.ok(initial.pdfData);
  assert.deepEqual(initial.log.diagnostics.filter((d) => d.severity === "error"), []);
  const initialPdf = session.lastPdf;
  const initialCompiled = session.compiled;
  assert.strictEqual(initialPdf, initial.pdfData);
  assert.ok(initialCompiled);
  assert.strictEqual(initialCompiled.pdf, initialPdf);
  assert.equal(initialCompiled.source(root), initialSource);
  assert.match(Buffer.from(initialPdf!).toString("latin1"), /\/LLRevision\s*\(initial\)/);

  writeFileSync(root, "\\documentclass{article}\n\\begin{document}\n\\input{missing-session-input}\n\\end{document}\n");
  const failed = await compile();
  assert.equal(failed.pdfWritten, false, failed.rawLog);
  assert.equal(failed.pdfData, null);
  assert.ok(failed.log.diagnostics.some((d) => d.severity === "error"), failed.rawLog);
  assert.strictEqual(session.lastPdf, initialPdf, "a fatal edit keeps the delivered PDF object");
  assert.strictEqual(session.compiled, initialCompiled, "a failed source is never attached to the preceding PDF");
  assert.strictEqual(delivered.at(-1)!.pdf, initialPdf, "views are notified with the retained PDF");
  assert.strictEqual(delivered.at(-1)!.compiled, initialCompiled);
  assert.equal(session.compiled!.source(root), initialSource);

  const repairedSource = document("repaired");
  writeFileSync(root, repairedSource);
  const repaired = await compile();
  assert.equal(repaired.pdfWritten, true, repaired.rawLog);
  assert.ok(repaired.pdfData);
  assert.deepEqual(repaired.log.diagnostics.filter((d) => d.severity === "error"), []);
  assert.strictEqual(session.lastPdf, repaired.pdfData);
  assert.notStrictEqual(session.lastPdf, initialPdf);
  assert.notDeepEqual(session.lastPdf, initialPdf);
  assert.notStrictEqual(session.compiled, initialCompiled);
  assert.ok(session.compiled!.seq > initialCompiled.seq);
  assert.strictEqual(session.compiled!.pdf, repaired.pdfData);
  assert.equal(session.compiled!.source(root), repairedSource);
  assert.match(Buffer.from(session.lastPdf!).toString("latin1"), /\/LLRevision\s*\(repaired\)/);
  assert.strictEqual(delivered.at(-1)!.pdf, repaired.pdfData);
  assert.ok(events.includes("start") && events.includes("result"));
});
