import { readFile } from "fs/promises";
import { dirname } from "path";
import { parseBib, type BibEntry } from "../tex/bib";
import { argText, walkTex } from "../export/texTree";
import { resolve } from "path";
import { readProjectSnapshot } from "../tex/projectIndex";
import { texText } from "../tex/texText";
import type { ChangeSet, Text } from "@codemirror/state";

export interface IndexedCitation { file: string; entry: BibEntry; search: string; }
export const bibSearchText = (e: BibEntry): string =>
  `${e.key} ${e.title} ${e.year} ${texText(e.fields?.author ?? e.fields?.editor ?? e.names.join(" "))}`.normalize("NFKC").toLocaleLowerCase();
export function searchCitations(entries: readonly IndexedCitation[], query: string): IndexedCitation[] {
  const words = query.normalize("NFKC").toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  return entries.filter(e => words.every(w => e.search.includes(w)));
}
interface DeclarationInfo { fingerprint: string; ranges: { from: number; to: number }[]; }
const DECLARATION = /\\(?:addbibresource|addglobalbib|addsectionbib|bibliography|nobibliography|input|include|subfileinclude|subfile|(?:sub)?(?:import|inputfrom|includefrom))\b/g;
/** Balanced declaration ranges include multi-line paths and incomplete arguments. */
function declarations(s: string): DeclarationInfo {
  const ranges: { from: number; to: number }[] = [];
  for (const m of s.matchAll(DECLARATION)) {
    let at = m.index + m[0].length;
    if (s[at] === "*") at++;
    const groups = /(?:import|inputfrom|includefrom)$/.test(m[0]) ? 2 : 1;
    let mandatory = 0;
    while (mandatory < groups) {
      while (/\s/.test(s[at] ?? "") || s[at] === "%") {
        if (s[at] === "%") { const end = s.indexOf("\n", at); at = end < 0 ? s.length : end; }
        else at++;
      }
      const open = s[at], close = open === "[" ? "]" : "}";
      if (open !== "[" && open !== "{") { at = s.length; break; }
      let depth = 1; at++;
      while (at < s.length && depth) {
        if (s[at] === "\\") { at += 2; continue; }
        if (s[at] === "%") { const end = s.indexOf("\n", at); at = end < 0 ? s.length : end; continue; }
        if (s[at] === open) depth++;
        if (s[at] === close) depth--;
        at++;
      }
      if (open === "{") mandatory++;
    }
    ranges.push({ from: m.index, to: Math.min(s.length, at) });
  }
  return { ranges, fingerprint: ranges.map(r => s.slice(r.from, r.to)).join("\u0000") };
}

/** Lazy whole-project bibliography index. Typing only invalidates declarations or .bib edits. */
export class Bibliographies {
  private roots = new Map<string, Promise<readonly IndexedCitation[]>>();
  private sources = new Map<string, DeclarationInfo>();
  private loading = 0;
  constructor(private buffers: () => ReadonlyMap<string, string>) {}
  invalidate(): void { this.roots.clear(); }
  async fileModified(file: string): Promise<void> {
    if (file.endsWith(".bib")) { this.invalidate(); return; }
    const before = this.sources.get(file);
    if (before === undefined) return;
    try {
      const after = declarations(this.buffers().get(file) ?? await readFile(file, "utf8"));
      if (after.fingerprint !== before.fingerprint) { this.sources.set(file, after); this.invalidate(); }
    } catch { this.invalidate(); }
  }
  edited(file: string, changes: ChangeSet, before: Text, after: Text): void {
    if (file.endsWith(".bib")) { this.invalidate(); return; }
    const info = this.sources.get(file);
    if (this.loading) this.invalidate();
    changes.iterChangedRanges((a, b, c, d) => {
      // Existing declaration ranges cover multiline arguments. A small lexical window
      // catches a newly typed declaration without reading a soft-wrapped megabyte line.
      const old = before.sliceString(Math.max(0, a - 64), Math.min(before.length, b + 64));
      const fresh = after.sliceString(Math.max(0, c - 64), Math.min(after.length, d + 64));
      if (info?.ranges.some(r => a <= r.to && b >= r.from) || declarations(old).fingerprint !== declarations(fresh).fingerprint) this.invalidate();
    });
    if (info) info.ranges = info.ranges.map(r => ({ from: changes.mapPos(r.from, -1), to: changes.mapPos(r.to, 1) }));
  }
  load(root: string): Promise<readonly IndexedCitation[]> {
    const hit = this.roots.get(root);
    if (hit) return hit;
    this.loading++;
    const pending = this.read(root).finally(() => { this.loading--; });
    this.roots.set(root, pending);
    if (this.roots.size > 8) this.roots.delete(this.roots.keys().next().value!);
    void pending.catch(() => { if (this.roots.get(root) === pending) this.roots.delete(root); });
    return pending;
  }
  private async read(root: string): Promise<readonly IndexedCitation[]> {
    const buffers = this.buffers();
    const snapshot = root.endsWith(".bib") ? null : await readProjectSnapshot(root, buffers);
    const project = snapshot?.files ?? [];
    for (const file of project) this.sources.set(file.path, declarations(file.text));
    // Bound source metadata independently of the eight cached roots.
    while (this.sources.size > 4096) this.sources.delete(this.sources.keys().next().value!);
    const files = new Set<string>(root.endsWith(".bib") ? [root] : []);
    if (snapshot) for (const file of snapshot.plan.files.values()) {
      const visits = snapshot.plan.visits.filter(v => v.key === file.key);
      const document = file.nodes.find(n => n.t === "env" && n.name === "document");
      const nodes = file.abs !== root && visits.length && visits.every(v => v.bodyOnly) && document?.t === "env" ? document.body : document ? file.nodes.filter(n => n.from < document.to) : file.nodes;
      walkTex(nodes, node => {
        if (node.t === "math" || node.t === "verb" || (node.t === "macro" && node.code)) return false;
        if (node.t !== "macro" || !/^(?:addbibresource|addglobalbib|addsectionbib|bibliography|nobibliography)$/.test(node.name)) return;
        const options = node.args.find(a => a.kind === "o");
        if (options && /location\s*=\s*remote/.test(argText(file.src, options))) return;
        const arg = node.args.find(a => a.kind === "m" || a.kind === "g");
        const raw = argText(file.src, arg).trim();
        if (!raw || /[\\#{}]/.test(raw)) throw new Error(`Bibliography path must be literal: ${file.abs}`);
        for (const name of /bibliography$/.test(node.name) ? raw.split(",") : [raw]) {
          const path = name.trim().replace(/^"(.*)"$/, "$1");
          files.add(resolve(dirname(root), path.endsWith(".bib") ? path : path + ".bib"));
        }
      });
    }
    const entries: IndexedCitation[] = [];
    for (const file of files) {
      const text = buffers.get(file) ?? await readFile(file, "utf8");
      for (const entry of parseBib(text).values()) entries.push({ file, entry, search: bibSearchText(entry) });
      // Yield between libraries so navigation/typing does not wait on multiple parses.
      await new Promise<void>(done => setTimeout(done, 0));
    }
    return entries;
  }
}
