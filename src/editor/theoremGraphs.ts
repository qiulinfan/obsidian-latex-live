import { readFileSync } from "fs";
import { dirname } from "path";
import { emitSourceSlice, validateSourceSlice, type EmitInput } from "../export/emit";
import { ExportImages, type PdfImages } from "../export/images";
import { isFileInput, planExport, visitNodes, type ExportPlan } from "../export/plan";
import { colorId, cssRgb, darkText, profileOf } from "../export/profiles";
import { ReportBuilder } from "../export/report";
import type { TexNode } from "../export/texTree";
import { readAuxCheckpoints, readAuxLabels } from "../tex/aux";
import { bibFiles, readBib, type BibEntry } from "../tex/bib";
import { projectDefinitions, type Definitions } from "../tex/macros";
import { stripComments } from "../tex/project";
import { abortError } from "../tex/run";
import { buildTheoremGraph, type TheoremGraph, type TheoremNode, type TheoremSource } from "../tex/theoremGraph";
import { theoremMap } from "../tex/theorems";
import { refNames, type LatexRefs } from "./latexRefs";

interface Snapshot {
  root: string;
  revision: number;
  plan: ExportPlan;
  defs: Definitions;
  refs: LatexRefs;
  graph: TheoremGraph;
  cards: Map<string, HTMLElement>;
}

export interface TheoremGraphsHost {
  /** Committed editor text only, including unsaved changes. */
  buffers(): ReadonlyMap<string, string>;
  outDirFor(root: string): string;
  prepareMath(): Promise<unknown>;
  math(root: string, src: string, display: boolean, doc: Document, defs: Definitions, refs: LatexRefs): string;
  pdfImages?: PdfImages;
}

/** Local project snapshots; reading a graph or expanding a card never runs TeX. */
export class TheoremGraphs {
  private revision = 0;
  private disposed = false;
  private roots = new Map<string, Snapshot>();
  private origins = new WeakMap<TheoremNode, Snapshot>();
  private listeners = new Set<() => void>();

  constructor(private readonly host: TheoremGraphsHost) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  invalidate(): void {
    this.revision++;
    this.roots.clear();
    for (const listener of [...this.listeners]) listener();
  }

  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.listeners.clear();
  }

  async load(root: string, key: string, signal: AbortSignal): Promise<{ graph: TheoremGraph; selectedId: string | null; key: string } | null> {
    this.check(signal);
    // Give the pointer/composition event a chance to finish before scanning a cold project.
    await new Promise<void>((done) => setTimeout(done, 0));
    this.check(signal);
    let snapshot = this.roots.get(root);
    if (!snapshot) {
      const buffers = this.host.buffers();
      const read = (file: string) => buffers.get(file) ?? readFileSync(file, "utf8");
      const defs = projectDefinitions(root, buffers);
      const texts = defs.files.map((file) => { try { return stripComments(read(file)); } catch { return ""; } });
      const theorems = theoremMap(texts);
      const plan = planExport(root, { defs, theorems, read });
      const outDir = this.host.outDirFor(root);
      const labels = readAuxLabels(outDir);
      const cites = new Map<string, BibEntry>();
      for (const bib of bibFiles(texts, dirname(root))) for (const [key, entry] of readBib(bib, buffers.get(bib))) if (!cites.has(key)) cites.set(key, entry);
      const refs: LatexRefs = {
        labels,
        numbers: new Map([...labels].map(([label, value]) => [label, value.number])),
        cites,
        checkpoints: readAuxCheckpoints(outDir),
        theorems,
        names: refNames(texts, theorems),
      };
      const graph = buildTheoremGraph(plan, theorems, labels);
      snapshot = { root, revision: this.revision, plan, defs, refs, graph, cards: new Map() };
      this.roots.set(root, snapshot);
      // Bound retained closed-project snapshots. Active popups keep their own snapshot.
      if (this.roots.size > 8) this.roots.delete(this.roots.keys().next().value!);
      for (const node of graph.nodes.values()) this.origins.set(node, snapshot);
    }
    this.check(signal, snapshot);
    const ids = snapshot.graph.byLabel.get(key);
    if (!ids?.length) return null;
    return { graph: snapshot.graph, selectedId: ids.length === 1 ? ids[0] : null, key };
  }

  async content(node: TheoremNode, doc: Document, signal: AbortSignal): Promise<HTMLElement> {
    const snapshot = this.origins.get(node);
    if (!snapshot) throw new Error("This theorem's source snapshot is no longer available.");
    this.check(signal, snapshot);
    const cached = snapshot.cards.get(node.id);
    if (cached) return cloneCard(cached, doc);
    const sources = [node.statement, ...node.proofs];
    for (const source of sources) validateSourceSlice(snapshot.plan, source);
    await this.host.prepareMath();
    this.check(signal, snapshot);
    const images = new ExportImages(dirname(snapshot.root), [], this.host.pdfImages);
    await images.load(snapshot.plan, signal, imageSites(snapshot.plan, sources));
    this.check(signal, snapshot);
    const input: EmitInput = {
      plan: snapshot.plan, defs: snapshot.defs, refs: snapshot.refs, theorems: snapshot.refs.theorems,
      profile: profileOf(snapshot.plan.files.get(snapshot.plan.rootKey)!.src, [...snapshot.plan.files.values()].map((file) => stripComments(file.src))),
      log: null, queue: null, bib: { entries: new Map(), bbl: null, bibcites: new Map() }, fragments: new Map(), images,
      math: { render: (src, display) => this.host.math(snapshot.root, src, display, doc, snapshot.defs, snapshot.refs) },
      report: new ReportBuilder(), idle: () => new Promise((done) => setTimeout(done, 0)), signal,
    };
    const card = doc.createElement("div");
    card.className = "ll-theorem-graph-content";
    for (let index = 0; index < sources.length; index++) {
      const source = sources[index];
      const section = doc.createElement("section");
      const heading = doc.createElement("h4");
      heading.textContent = index === 0 ? "陈述" : node.proofs.length > 1 ? `证明 ${index}` : "证明";
      section.appendChild(heading);
      const rendered = await emitSourceSlice(input, { key: source.key, visit: source.visit, nodes: source.nodes, excluded: source.excluded });
      this.check(signal, snapshot);
      const body = doc.createElement("div");
      body.innerHTML = rendered.body;
      section.appendChild(body);
      for (const [name, color] of rendered.colors) card.style.setProperty(`--llx-c-${colorId(name)}`, cssRgb(doc.body.classList.contains("theme-dark") ? darkText(color) : color));
      for (const footnote of rendered.footnotes) {
        const note = doc.createElement("div");
        note.className = "ll-theorem-footnote";
        note.appendChild(doc.createTextNode(`${footnote.mark} `));
        const text = doc.createElement("span");
        text.innerHTML = footnote.html;
        note.appendChild(text);
        section.appendChild(note);
      }
      if (rendered.items.length) {
        const note = doc.createElement("p");
        note.className = "ll-theorem-render-note";
        note.textContent = "部分内容保留为 LaTeX 源码；可打开源文件查看。";
        note.title = rendered.items.map((item) => item.message).join("\n").slice(0, 1000);
        section.appendChild(note);
      }
      card.appendChild(section);
    }
    if (!node.proofs.length) {
      const missing = doc.createElement("p");
      missing.className = "ll-theorem-render-note";
      missing.textContent = "未找到明确关联的证明。";
      card.appendChild(missing);
    }
    // References inside a card navigate within the graph. Other fragment links must not
    // scroll Obsidian's document or collide with labels from another open popup.
    for (const link of card.querySelectorAll<HTMLAnchorElement>("a[href^='#']")) {
      const key = link.dataset.llTexRef;
      if (key && snapshot.graph.byLabel.get(key)?.length === 1) link.dataset.llTheoremKey = key;
      else link.removeAttribute("href");
    }
    // The graph resolves source labels itself; keep drawing IDs and their internal references.
    for (const element of card.querySelectorAll("[data-ll-tex-label]")) element.removeAttribute("id");
    snapshot.cards.set(node.id, card);
    if (snapshot.cards.size > 32) snapshot.cards.delete(snapshot.cards.keys().next().value!);
    return cloneCard(card, doc);
  }

  private check(signal: AbortSignal, snapshot?: Snapshot): void {
    if (this.disposed || signal.aborted || (snapshot && snapshot.revision !== this.revision)) throw abortError("The theorem preview was closed or its source changed.");
  }
}

let cardSerial = 0;
/** Every displayed clone gets independent internal drawing/MathJax IDs. */
function cloneCard(card: HTMLElement, doc: Document): HTMLElement {
  const clone = doc.importNode(card, true) as HTMLElement;
  const prefix = `ll-theorem-card-${++cardSerial}-`;
  const ids = new Map<string, string>();
  for (const element of clone.querySelectorAll<HTMLElement>("[id]")) { const old = element.id; element.id = prefix + old; ids.set(old, element.id); }
  const urls = (value: string) => value.replace(/url\(\s*(["']?)#([^\s)"']+)\1\s*\)/g, (all, quote: string, id: string) => ids.has(id) ? `url(${quote}#${ids.get(id)}${quote})` : all);
  for (const element of clone.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      let value = attribute.value;
      if (["href", "xlink:href"].includes(attribute.name) && value.startsWith("#") && ids.has(value.slice(1))) value = `#${ids.get(value.slice(1))}`;
      else if (["aria-labelledby", "aria-describedby"].includes(attribute.name)) value = value.split(/\s+/).map(id => ids.get(id) ?? id).join(" ");
      else value = urls(value);
      if (value !== attribute.value) element.setAttribute(attribute.name, value);
    }
    if (element.tagName.toLowerCase() === "style" && element.textContent) element.textContent = urls(element.textContent);
  }
  return clone;
}

/** Exact input-visit image sites reachable from the selected statement and proofs. */
function imageSites(plan: ExportPlan, sources: readonly TheoremSource[]): Set<string> {
  const sites = new Set<string>();
  const visited = new Set<number>();
  const walk = (nodes: readonly TexNode[], visit: number, excluded: ReadonlySet<string>, depth = 0) => {
    if (depth > 64) return;
    for (const node of nodes) {
      if (excluded.has(`${visit}|${node.from}|${node.to}`)) continue;
      if (node.t === "env" || node.t === "group") walk(node.body, visit, excluded, depth + 1);
      else if (node.t === "macro" && !node.code) {
        if (isFileInput(node)) {
          const child = plan.inputTargets.get(`${visit}@${node.from}`);
          if (child !== undefined && !visited.has(child)) { visited.add(child); walk(visitNodes(plan, child), child, excluded, depth + 1); }
        } else {
          if (["includegraphics", "includepdf", "lstinputlisting"].includes(node.name)) sites.add(`${visit}@${node.from}`);
          for (const arg of node.args) if (arg.body) walk(arg.body, visit, excluded, depth + 1);
        }
      }
    }
  };
  for (const source of sources) { visited.clear(); walk(source.nodes, source.visit, new Set((source.excluded ?? []).map(item => `${item.visit}|${item.from}|${item.to}`))); }
  return sites;
}
