import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { ExportImages } from "../src/export/images";
import { planExport, visitNodes } from "../src/export/plan";
import { projectDefinitions } from "../src/tex/macros";
import { emitDoc, removeExportTemps } from "./support/exportHost";

after(removeExportTemps);

test("imported images, PDF pages and listings resolve per visit when one source is read in two contexts", async () => {
  const fixture = join(process.cwd(), "tests", "fixtures", "export-structure");
  const a = readFileSync(join(fixture, "parts one", "local image.png"));
  const b = readFileSync(join(fixture, "子目录", "图像.png"));
  const calls: string[] = [];
  const result = await emitDoc({
    preamble: "\\usepackage{import,graphicx,pdfpages,listings}",
    body: "\\import{a/}{../shared}\n\\import{b/}{../shared}",
    llx: "llxin{a/}{../shared.tex}{4}\nllxout{a/}{../shared.tex}\nllxin{b/}{../shared.tex}{5}\nllxout{b/}{../shared.tex}",
    files: {
      "shared.tex": "\\includegraphics{same.png}\n\\includepdf{same.pdf}\n\\lstinputlisting{same.txt}",
      "a/same.png": a, "b/same.png": b,
      "a/same.pdf": "%PDF-1.4 synthetic host stand-in", "b/same.pdf": "%PDF-1.4 synthetic host stand-in",
      "a/same.txt": "First imported <listing>.\r\n", "b/same.txt": "Second imported & listing.\n",
    },
    pdfImages: async (abs, want) => {
      calls.push(abs);
      assert.deepEqual(want(1), [1]);
      return [{ page: 1, png: abs.includes("/a/") ? a : b, width: 100, height: 120 }];
    },
  });
  const document = new JSDOM(result.body).window.document;
  assert.deepEqual([...document.querySelectorAll("img")].map((img) => img.src), [a, a, b, b].map((png) => `data:image/png;base64,${png.toString("base64")}`));
  assert.deepEqual([...document.querySelectorAll("pre")].map((pre) => pre.textContent?.trim()), ["First imported <listing>.", "Second imported & listing."]);
  assert.deepEqual(calls.map((path) => path.slice(result.dir.length + 1)), ["a/same.pdf", "b/same.pdf"]);
  assert.deepEqual(result.report.items, []);

  // The same request API serves the emitter, and none of its getters re-read deleted files.
  const root = join(result.dir, "main.tex");
  const plan = planExport(root, { defs: projectDefinitions(root), theorems: new Map() });
  const images = new ExportImages(result.dir, [], undefined);
  await images.load(plan, new AbortController().signal);
  const node = visitNodes(plan, 1).find((n) => n.t === "macro" && n.name === "includegraphics")!;
  const first = images.graphic("same.png", 1, `1@${node.from}`);
  assert.equal(typeof first, "object");
  assert.match(String(images.graphic("same.png")), /ambiguous without a source visit/);
  rmSync(join(result.dir, "a"), { recursive: true });
  assert.deepEqual(images.graphic("same.png", 1, `1@${node.from}`), first, "prepared images survive deletion of the original files");
  const listing = visitNodes(plan, 1).find((n) => n.t === "macro" && n.name === "lstinputlisting")!;
  assert.deepEqual(images.listingAt(`1@${listing.from}`), { text: "First imported <listing>.\n" });
});

test("graphicspath follows source order and import/group scope instead of leaking between contexts", async () => {
  const fixture = join(process.cwd(), "tests", "fixtures", "export-structure");
  const blue = readFileSync(join(fixture, "parts one", "local image.png"));
  const red = readFileSync(join(fixture, "子目录", "图像.png"));
  const result = await emitDoc({
    preamble: "\\usepackage{import,subfiles,graphicx}\\graphicspath{{root images/}}",
    body: "\\includegraphics{same.png}\n\\import{a/}{chapter}\n\\includegraphics{same.png}\n{\\graphicspath{{group images/}}\\includegraphics{same.png}}\n\\includegraphics{same.png}\n\\input{setpaths}\n\\includegraphics{same.png}",
    llx: "",
    files: {
      "a/chapter.tex": "\\graphicspath{{images/}}\\includegraphics{same.png}",
      "root images/same.png": blue, "a/images/same.png": red, "group images/same.png": red,
      "setpaths.tex": "\\graphicspath{{next images/}}", "next images/same.png": red,
    },
  });
  const document = new JSDOM(result.body).window.document;
  assert.deepEqual([...document.querySelectorAll("img")].map((img) => img.src), [blue, red, blue, red, blue, red].map((png) => `data:image/png;base64,${png.toString("base64")}`));
  assert.deepEqual(result.report.items, []);
});
