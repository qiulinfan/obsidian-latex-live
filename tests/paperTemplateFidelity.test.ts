// Cross-template semantic acceptance: original short manuscripts, unmodified installed classes,
// real latexmk/BibTeX -> probe -> MathJax/SVG -> HTML. Content assertions are independent of the
// report: a zero-warning export must still retain every declared author and abstract.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { emitExport, prepareExport } from "../src/export/exporter";
import { texTool } from "../src/tex/binaries";
import { texText } from "../src/tex/texText";
import { fixtureCopy, nodeExportHost, removeExportTemps, texBin } from "./support/exportHost";

after(removeExportTemps);

interface PaperCase {
  fixture: string;
  cls: string;
  title: string;
  authors: string[];
  affiliations: string[];
  emails: string[];
  abstract: string;
  keywords?: string[];
  subjects?: string[];
  notes?: string[];
  headings: Record<string, string>;
  labels: string[];
  refs: Record<string, "ref" | "eqref">;
  cites: string[];
  bibKeys: string[];
  /** PLOS has a handwritten flushleft heading, not a declared title API. */
  handwritten?: boolean;
}

const physics = {
  cls: "revtex4-2", title: "Synthetic two-column physics audit", authors: ["Ada Audit", "Ben Check"],
  affiliations: ["Department of Physics, Synthetic University", "Institute of Model Systems, Synthetic Laboratory"],
  emails: ["ada@example.invalid"],
  abstract: "A synthetic manuscript checks energy conservation, figure captions, cross references, and author metadata.",
  headings: { "sec:dynamics": "Dynamics" },
  labels: ["sec:dynamics", "eq:energy", "eq:x", "eq:v", "prop:one", "fig:one", "tab:one"],
  refs: { "eq:energy": "eqref", "fig:one": "ref", "tab:one": "ref", "prop:one": "ref" } as const,
  bibKeys: ["audit2024", "check2025"],
};
const cs = {
  cls: "acmart", title: "Synthetic computer science compatibility audit", authors: ["Ada Audit", "Ben Check"],
  affiliations: ["Synthetic University", "Synthetic Laboratory", "Synthetic City", "Synthetic Country"],
  emails: ["ada@example.invalid", "ben@example.invalid"],
  abstract: "An original synthetic manuscript checks template metadata, formulas, references, figures and tables.",
  keywords: ["synthetic", "compatibility", "estimator"],
  headings: { "sec:one": "Synthetic estimator", "sec:supplement": "Synthetic supplement" },
  labels: ["sec:one", "eq:one", "cl:one", "th:one", "fig:one", "tab:one", "sec:supplement"],
  refs: { "eq:one": "eqref", "fig:one": "ref", "tab:one": "ref", "cl:one": "ref", "sec:one": "ref" } as const,
  bibKeys: ["audit2024", "check2025"],
};
const biology = {
  title: "Synthetic cell-growth manuscript for template compatibility", authors: ["Ada Botanist", "Ben Biologist"],
  affiliations: ["Department of Biology", "Institute of Ecology", "Synthetic University", "Example City"],
  emails: ["ada@example.invalid"],
  abstract: "This synthetic study measures cell growth in two culture conditions. This is original test text and describes no real experiment.",
  headings: { "sec:intro": "Introduction", "sec:methods": "Methods" },
  labels: ["sec:intro", "sec:methods", "eq:growth", "fig:cells", "tab:counts"],
  refs: { "eq:growth": "eqref", "sec:methods": "ref", "fig:cells": "ref", "tab:counts": "ref" } as const,
  cites: ["[1]"], bibKeys: ["synthetic"],
};

const cases: PaperCase[] = [
  { fixture: "revtex-aps", ...physics, cites: ["[1]", "Check [2]"] },
  { fixture: "revtex-aip", ...physics, cites: ["Audit and Check (2024)", "Check (2025)"] },
  { fixture: "aastex", ...physics, cls: "aastex701", emails: ["ada@example.invalid", "ben@example.invalid"], cites: ["A. Audit & B. Check (2024)", "B. Check (2025)"] },
  { fixture: "acmart-sigconf", ...cs, cites: ["[1, 2]"] },
  { fixture: "acmart-small", ...cs, cites: ["[Audit and Check 2024; Check 2025]"] },
  { fixture: "ieee-conference", ...cs, cls: "IEEEtran", affiliations: ["Department of Computing", "Synthetic University", "Systems Institute", "Synthetic Laboratory"], labels: cs.labels.filter(key => key !== "th:one"), cites: ["[1], [2]"] },
  { fixture: "plos", ...biology, cls: "article", handwritten: true },
  { fixture: "springer", ...biology, cls: "sn-jnl", emails: ["ada@example.invalid", "ben@example.invalid"], keywords: ["cell growth", "template compatibility", "synthetic data"], labels: [...biology.labels, "thm:positive"] },
  {
    fixture: "amsart", cls: "amsart", title: "Synthetic AMS compatibility audit", authors: ["Alpha Author", "Beta Author"],
    affiliations: ["Department Alpha, Synthetic Institute One", "Current Department Alpha, Synthetic Institute One", "Department Beta, Synthetic Institute Two"],
    emails: ["alpha@example.invalid", "beta@example.invalid"],
    abstract: "We prove a synthetic bound for a two-vertex graph. This abstract is original audit text.",
    keywords: ["bounded graph", "spectral inequality"], subjects: ["2020 Mathematics Subject Classification", "Primary 05C50", "Secondary 15A18"],
    notes: ["Synthetic support statement for Alpha.", "Synthetic support statement for Beta.", "Dedicated to synthetic examples"],
    headings: { "sec:bound": "The bound", "sec:appendix": "Additional identity" },
    labels: ["sec:bound", "def:graph", "thm:energy", "eq:energy", "eq:expand", "lem:zero", "fig:image", "tab:values", "sec:appendix", "eq:appendix"],
    refs: { "eq:energy": "eqref", "thm:energy": "ref", "lem:zero": "ref", "fig:image": "ref", "tab:values": "ref" },
    cites: ["[1]"], bibKeys: ["synthetic"],
  },
  {
    fixture: "llncs", cls: "llncs", title: "Synthetic LNCS mathematical audit", authors: ["Alpha Author", "Beta Author"],
    affiliations: ["Synthetic Institute One", "Synthetic Institute Two"], emails: ["alpha@example.invalid", "beta@example.invalid"],
    abstract: "An original synthetic mathematical audit.", keywords: ["bounded graph", "energy inequality"],
    headings: { "sec:bound": "The bound", "sec:appendix": "Additional identity" },
    labels: ["sec:bound", "def:graph", "thm:energy", "eq:energy", "fig:image", "tab:values", "sec:appendix", "eq:appendix"],
    refs: { "eq:energy": "eqref", "thm:energy": "ref", "fig:image": "ref", "tab:values": "ref" },
    cites: ["[1]"], bibKeys: ["synthetic"],
  },
];

const springerDir = process.env.PAPER_TEMPLATE_SPRINGER_DIR ?? join(process.cwd(), "node_modules/.cache/paper-templates/springer");
const currentAcmDir = process.env.PAPER_TEMPLATE_ACM_CURRENT_DIR ?? join(process.cwd(), "node_modules/.cache/paper-templates/acmart-current");
const artifactDir = process.env.PAPER_TEMPLATE_AUDIT_OUT;
const compact = (value: string) => value.replace(/\s+/g, "").trim();
function text(element: Element | null): string {
  if (!element) return "";
  const clone = element.cloneNode(true) as Element;
  for (const br of clone.querySelectorAll("br")) br.replaceWith(clone.ownerDocument.createTextNode(" "));
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim();
}

function skipFor(c: PaperCase, current = false): false | string {
  if (!texBin) return "no TeX installation";
  if (current) return currentAcmDir && existsSync(join(currentAcmDir, "acmart.cls")) ? false : "optional current acmart: set PAPER_TEMPLATE_ACM_CURRENT_DIR to verified original cls + dtx directory";
  if (c.fixture === "springer") return existsSync(join(springerDir, "sn-jnl.cls")) && existsSync(join(springerDir, "sn-vancouver-num.bst")) ? false : "original Springer assets absent: set PAPER_TEMPLATE_SPRINGER_DIR";
  const found = spawnSync(texTool(texBin, "kpsewhich"), [`${c.cls}.cls`], { encoding: "utf8" });
  return found.status === 0 && found.stdout.trim() ? false : `${c.cls} is not installed`;
}

async function verify(c: PaperCase, current = false): Promise<void> {
  const name = current ? "acmart-current-2.20" : c.fixture;
  const { dir, root } = fixtureCopy(`paper-templates/${c.fixture}`);
  if (c.fixture === "springer") {
    for (const file of ["sn-jnl.cls", "sn-vancouver-num.bst"]) cpSync(join(springerDir, file), join(dir, file));
  }
  if (current) {
    assert.ok(existsSync(join(currentAcmDir!, "acmart.dtx")), "current generated cls must remain paired with its source");
    for (const file of ["acmart.cls", "acmart.dtx", "acmart.ins", "ACM-Reference-Format.bst"]) {
      if (existsSync(join(currentAcmDir!, file))) cpSync(join(currentAcmDir!, file), join(dir, file));
    }
    assert.match(readFileSync(join(dir, "acmart.cls"), "utf8"), /2026\/08\/16 v2\.20/);
  }
  const host = nodeExportHost(root, { engine: "pdflatex" });
  const signal = new AbortController().signal;
  const { prepared, math } = await prepareExport(root, host, () => {}, signal);
  const { html, report } = await emitExport(prepared, math, host, () => {}, signal);
  const document = new JSDOM(html).window.document;
  const main = document.querySelector("main")!;
  const header = main.querySelector("header.llx-title");
  let boundary = document.getElementById(Object.keys(c.headings)[0]);
  while (boundary && boundary.parentElement !== main) boundary = boundary.parentElement;
  const frontNodes: Element[] = [];
  for (const node of main.children) { if (node === boundary) break; frontNodes.push(node); }
  const frontText = frontNodes.map(text).join(" ");
  const result = {
    template: name, report,
    title: text(main.querySelector("h1")), header: text(header), frontText,
    authors: [...main.querySelectorAll(".llx-paper-author")].map(text),
    affiliations: [...main.querySelectorAll(".llx-paper-affiliation")].map(text),
    abstracts: [...main.querySelectorAll(".llx-abstract")].map(text),
    keywords: [...main.querySelectorAll(".llx-paper-keywords")].map(text),
    subjects: [...main.querySelectorAll(".llx-paper-subject")].map(text),
    citations: [...main.querySelectorAll(".llx-cite")].map(text),
    headings: [...main.querySelectorAll(".llx-section")].map(text),
    refs: [...main.querySelectorAll("a.llx-ref")].map(a => ({ href: a.getAttribute("href"), text: text(a) })),
    labels: [...prepared.refs.labels].map(([key, value]) => ({ key, number: texText(value.number) })),
    allText: text(main),
  };
  // Save before assertions, so a failure is reviewable rather than just a test stack.
  if (artifactDir) {
    const out = join(artifactDir, name); mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
    writeFileSync(join(out, "expected.json"), JSON.stringify(c, null, 2));
    writeFileSync(join(out, "export.html"), html);
    cpSync(host.buildDir, join(out, "build"), { recursive: true });
    cpSync(host.workDir, join(out, "probe"), { recursive: true });
  }
  assert.equal(host.builds, 1);
  const diagnosticErrors = readFileSync(join(host.buildDir, "main.log"), "utf8");
  assert.doesNotMatch(diagnosticErrors, /^!|^.*\.tex:\d+: (?:LaTeX Error|Undefined control sequence)/m);
  if (c.handwritten) {
    assert.equal(header, null, "handwritten PLOS layout must not be guessed into structured title metadata");
    assert.ok(text(main).includes(c.title));
    assert.ok([...main.querySelectorAll("sup")].some(sup => text(sup) === "1,*"));
  } else {
    assert.equal(text(main.querySelector("h1")), c.title);
    assert.ok(header);
    assert.equal(result.authors.length, c.authors.length);
    const names = [...main.querySelectorAll(".llx-paper-author")].map(author => {
      const clone = author.cloneNode(true) as Element;
      for (const sup of clone.querySelectorAll("sup")) sup.remove();
      return text(clone);
    });
    assert.deepEqual(names, c.authors, "institution and ORCID markers must not become part of an author name");
  }
  const front = frontText;
  for (const value of [...c.authors, ...c.affiliations, ...c.emails, ...(c.subjects ?? []), ...(c.notes ?? [])]) {
    assert.ok(compact(front).includes(compact(value)), `${name}: missing front matter ${value}`);
  }
  assert.ok(compact(text(main)).includes(compact(c.abstract)), `${name}: abstract content was lost`);
  for (const value of c.keywords ?? []) {
    const keywordText = result.keywords.join(" ") || frontText;
    assert.ok(compact(keywordText).includes(compact(value)), `${name}: missing keyword ${value}`);
  }
  if (c.cls === "IEEEtran") assert.ok(compact(frontText).includes("synthetic,compatibility,estimator"), "IEEE keyword line must survive independently of repeated words elsewhere");
  if (c.cls === "acmart") {
    for (const affiliation of main.querySelectorAll(".llx-paper-affiliation")) {
      assert.match(text(affiliation), /Synthetic (?:University|Laboratory)[,;]?\s+Synthetic City[,;]?\s+Synthetic Country/, "ACM organization, city and country require word boundaries");
    }
  }
  for (const anchor of main.querySelectorAll(".llx-paper-author sup a[href]")) {
    assert.ok(document.getElementById(anchor.getAttribute("href")!.slice(1)), "author's institution link must resolve");
  }
  for (const [key, title] of Object.entries(c.headings)) {
    assert.ok(text(document.getElementById(key)).includes(title), `${name}: missing heading ${title}`);
  }
  for (const key of c.labels) {
    assert.ok(prepared.refs.labels.has(key), `${name}: TeX did not produce label ${key}`);
    assert.ok(document.getElementById(key), `${name}: HTML anchor missing for ${key}`);
  }
  for (const [key, command] of Object.entries(c.refs)) {
    const expected = texText(prepared.refs.labels.get(key)!.number);
    const link = [...main.querySelectorAll("a.llx-ref")].find(a => a.getAttribute("href") === `#${key}`);
    assert.ok(link, `${name}: reference to ${key} was lost`);
    assert.equal(text(link), command === "eqref" ? `(${expected})` : expected);
  }
  for (const number of report.numbers.filter(n => n.shown && n.label)) {
    const label = prepared.refs.labels.get(number.label!);
    assert.ok(label, `${name}: numbered construct has no TeX label ${number.label}`);
    assert.equal(number.value, texText(label.number));
  }
  assert.deepEqual(result.citations, c.cites);
  for (const key of c.bibKeys) assert.ok(document.getElementById(`llx-bib-${key}`), `${name}: bibliography entry ${key} was lost`);
  const bibliography = text(main.querySelector(".llx-bib"));
  assert.doesNotMatch(bibliography, /\b(?:author|title|journal|volume|pages|year|NoStop|BibitemOpen)\b|@noop|bib(?:field|info|namefont|fnamefont)/);
  assert.equal(report.counts.images, 1);
  assert.equal(report.counts.captions, 2);
  assert.ok((report.counts.math ?? 0) > 0);
  assert.deepEqual(report.items.filter(i => i.severity !== "info"), [], JSON.stringify(report.items));
}

for (const c of cases) test(`paper-template fidelity: ${c.fixture}, complete declared content and TeX numbers`, { skip: skipFor(c), timeout: 120_000 }, () => verify(c));
test("paper-template fidelity: current acmart 2.20 with paired original source", { skip: skipFor(cases[3], true), timeout: 120_000 }, () => verify(cases[3], true));
