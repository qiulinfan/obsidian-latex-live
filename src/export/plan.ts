import { readFileSync } from "fs";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "path";
import type { Definitions } from "../tex/macros";
import { literalTexPath, resolveFileReference, stripComments } from "../tex/project";
import type { TheoremMap } from "../tex/theorems";
import { colorNames, profileOf } from "./profiles";
import { projectSignatures, withCensus } from "./signatures";
import { argText, expandEnvironment, parseTex, walkTex, type Signatures, type TexNode } from "./texTree";

// The export's plan (design 3.2): the project's files parsed, the order in which TeX visits them
// after \begin{document} (the probe's records are positioned by visit), the constructs TeX must
// draw (fragments, S5), the instrumented copies the probe pass compiles, and its configuration.
// Pure: it reads the project's files and nothing else.
//   - Files are keyed by their path from the root's folder with forward slashes and extension
//     (`chapters/ch1.tex`), as `\input` names them and the probe's `\CurrentFilePathUsed` records.
//   - Visits: the root is visit 0; every `\input`/`\include`/`\subfile` in the body opens the next
//     one, recursively, in document order, a file read twice twice; `\includeonly` is honoured.
//   - Fragments: TikZ-family pictures, `\tikz` and tables HTML cannot draw (multirow, colortbl;
//     inline, `llxfrag`: an lrbox), displays holding a picture and environments the emitter does
//     not render (blocks, `llxblock`: no box, so numbering is unchanged). Inserts are inline: an instrumented copy has the original's lines, and bytes
//     outside the inserts are the original's.

/** Environments the emitter renders as HTML (the others are fragments). */
export const HTML_ENVS = new Set([
  "document", "itemize", "enumerate", "description", "problemset", "center", "flushleft",
  "flushright", "quote", "quotation", "verse", "abstract", "figure", "figure*", "table", "table*",
  "algorithm", "tabular", "tabular*", "minipage", "subequations", "proof", "multicols", "multicols*",
  "small", "footnotesize", "scriptsize", "large", "Large", "normalsize", "titlepage", "thebibliography",
  "wrapfigure", "wraptable", "subfigure", "subtable", "sidewaysfigure", "sidewaystable",
  "acks", "anonsuppress",
]);
/** What makes a tabular one HTML cannot draw (a fragment): spanning rows, colours, hhline, diagonal cells. */
const COMPLEX_TABLE = /\\(?:multirow|rowcolor|cellcolor|columncolor|rowcolors|hhline|diagbox)(?![A-Za-z])/;
/** Environments TeX draws as pictures (inline fragments). */
export const PICTURE_ENVS = new Set(["tikzpicture", "tikzcd", "pgfpicture", "circuitikz", "forest"]);
/** The standard environments the probe's census never needs to classify. */
const STANDARD_ENVS = new Set([...HTML_ENVS, ...PICTURE_ENVS, "thebibliography", "tabularx", "array", "longtable"]);
/** Names the probe reports (`\<name>name`), besides every theorem-like environment's. */
const PROBE_NAMES = [
  "contents", "listfigure", "listtable", "figure", "table", "bib", "ref", "index", "part", "chapter",
  "appendix", "abstract", "proof", "lstlisting", "algorithm",
];
const TITLE_NAMES = ["author", "institute", "date", "version"];
/** Colours the probe reports when defined: the elegant classes' structure, link and cover colours. */
const PROBE_COLORS = ["structurecolor", "main", "second", "third", "winered", "coverlinecolor", "ecolor", "geyecolor"];

export interface PlanFile {
  key: string;
  abs: string;
  src: string;
  nodes: TexNode[];
  /** Offsets where lines start (line n starts at lines[n - 1]). */
  lines: number[];
}

export interface PlanVisit {
  key: string;
  /** How many visits of the same file came before this one. */
  occ: number;
  /** The visit whose file read this one (-1 for the root) and the line it did so at. */
  parent: number;
  parentLine: number;
  /** Imported input search paths, in TeX's priority order (the root directory is last). */
  inputDirs: string[];
  /** `subfile` discards its documentclass/preamble and anything after end{document}. */
  bodyOnly: boolean;
}

export interface PlanFragment {
  id: number;
  /** inline: `llxfrag` (an lrbox, measured); block: `llxblock` (display material). */
  kind: "inline" | "block";
  key: string;
  from: number;
  to: number;
  /** What it is (`tikzpicture`, `\tikz`, `equation* with tikzcd`, `algorithmic`). */
  what: string;
}

export interface ProbeConfig {
  /** Only verified elegant classes expose these as labels rather than arbitrary typesetters. */
  titleLabels?: "elegantbook" | "elegantarticle";
  /** `\<name>name`s to report. */
  names: string[];
  /** Colours to report when defined. */
  colors: string[];
  /** Environments whose begin macro's `\meaning` to report (the census). */
  envs: string[];
}

export interface ExportPlan {
  root: string;
  rootDir: string;
  /** The root's key (its file name) and job name. */
  rootKey: string;
  job: string;
  sig: Signatures;
  /** Every parsed file (the root, its inputs in the preamble and the body), by key. */
  files: Map<string, PlanFile>;
  /** The body's visits in TeX's order; visits[0] is the root. */
  visits: PlanVisit[];
  /** Parent visit and macro offset -> the exact child visit, including repeated import contexts. */
  inputTargets: Map<string, number>;
  /** Parent visit and macro offset -> its resolved key, including missing/outside-project targets. */
  inputKeys: Map<string, string>;
  /** Exact absolute spellings used by visited inputs/imports, mapped to canonical in-project keys. */
  sourceAliases: Map<string, string>;
  fragments: PlanFragment[];
  /** Instrumented copies, by key: every file the body visits. */
  copies: Map<string, string>;
  /** Native HTML expansions of traditional environments, keyed by file and source offset. */
  environmentExpansions: Map<string, string>;
  probe: ProbeConfig;
  /** `\includeonly`'s names, or null. */
  includeOnly: string[] | null;
  /** Files the sources name that could not be read (key -> the naming file). */
  missing: Map<string, string>;
}

/** 1-based line of `offset` in a file. */
export function lineAt(file: PlanFile, offset: number): number {
  let lo = 0;
  let hi = file.lines.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (file.lines[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function lineStarts(src: string): number[] {
  const out = [0];
  for (let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i + 1)) out.push(i + 1);
  return out;
}

/** The key of a file as `\input{name}` names it from the root's folder (`.tex` added when it has no extension). */
export function inputKey(rootDir: string, name: string): string | null {
  const trimmed = literalTexPath(name);
  if (!trimmed || /[\\#]/.test(trimmed)) return null;
  const withExt = extname(trimmed) ? trimmed : `${trimmed}.tex`;
  const abs = isAbsolute(withExt) ? withExt : resolve(rootDir, withExt);
  const rel = relative(rootDir, abs);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep).join("/");
}

/** The file macros that read another file in TeX's flow. */
const INPUTS = new Set(["input", "include", "subfile", "subfileinclude", "import", "subimport", "inputfrom", "subinputfrom", "includefrom", "subincludefrom"]);
const IMPORTS = new Set(["import", "subimport", "inputfrom", "subinputfrom", "includefrom", "subincludefrom"]);
type FileInputName = "input" | "include" | "subfile" | "subfileinclude" | "import" | "subimport" | "inputfrom" | "subinputfrom" | "includefrom" | "subincludefrom";
export const isFileInput = (node: TexNode): node is TexNode & { t: "macro"; name: FileInputName } => node.t === "macro" && INPUTS.has(node.name);

/** The body TeX visits in this invocation (`subfile` and the root discard the preamble). */
export function visitNodes(plan: ExportPlan, index: number): readonly TexNode[] {
  const visit = plan.visits[index];
  const file = visit && plan.files.get(visit.key);
  if (!file) return [];
  const doc = visit.bodyOnly ? file.nodes.find((n) => n.t === "env" && n.name === "document") : null;
  return doc?.t === "env" ? doc.body : file.nodes;
}

/** The name a file macro reads, or null. */
function inputName(src: string, node: TexNode): string | null {
  if (!isFileInput(node)) return null;
  const arg = node.args[node.args.length - 1];
  return arg ? argText(src, arg) : null;
}

export interface PlanOptions {
  defs: Definitions;
  theorems: TheoremMap;
  /** A formula MathJax renders (S2: the others become fragments); every one by default. */
  mathOk?(tex: string, display: boolean): boolean;
  /** File contents to use instead of the disk's (tests), by absolute path. */
  read?(abs: string): string;
}

/** Plan the export of `root` (see the file comment). */
export function planExport(root: string, o: PlanOptions): ExportPlan {
  const rootDir = dirname(root);
  const read = o.read ?? ((abs: string) => readFileSync(abs, "utf8"));
  const sources = o.defs.files.map((f) => {
    try {
      return stripComments(read(f));
    } catch {
      return "";
    }
  });
  let sig = projectSignatures(o.defs, sources, o.theorems);
  const files = new Map<string, PlanFile>();
  const missing = new Map<string, string>();
  const load = (key: string, from: string, reportMissing = true): PlanFile | null => {
    let f = files.get(key);
    if (f) return f;
    const abs = resolve(rootDir, key);
    let src: string;
    try {
      src = read(abs).replace(/\r\n/g, "\n");
    } catch {
      if (reportMissing) missing.set(key, from);
      return null;
    }
    f = { key, abs, src, nodes: parseTex(src, sig), lines: lineStarts(src) };
    files.set(key, f);
    return f;
  };
  const rootKey = basename(root);
  const rootFile = load(rootKey, rootKey);
  if (!rootFile) throw new Error(`Cannot read ${root}`);
  let doc = rootFile.nodes.find((n) => n.t === "env" && n.name === "document");

  // import.sty's input@path takes priority over the working directory; subimport and subfile
  // extend the current import directory, while import/inputfrom start again at the root.
  const resolveInput = (file: PlanFile, node: TexNode & { t: "macro" }, inputDirs: readonly string[]) => {
    const name = literalTexPath(inputName(file.src, node) ?? "");
    const directory = IMPORTS.has(node.name) ? argText(file.src, node.args[node.args.length - 2]) : null;
    const ref = resolveFileReference(rootDir, node.name, name, directory, inputDirs, (path) => {
      const key = inputKey(rootDir, path);
      return !!(key && load(key, file.key, false));
    });
    if (!ref) return null;
    const key = relative(rootDir, ref.path).split(sep).join("/");
    const child = files.get(key) ?? null;
    // The source boundary stays inside the project; preserve external/missing keys for reports.
    if (!child && key) missing.set(key, file.key);
    return { key, child, dirs: ref.inputDirs, bodyOnly: ref.bodyOnly, name };
  };

  // The preamble: \includeonly, and the files it reads (their definitions shape the parse).
  let includeOnly: string[] | null = null;
  const documentStart = doc?.from;
  const preamble = documentStart !== undefined ? rootFile.nodes.filter((n) => n.to <= documentStart) : [];
  const preambleSeen = new Set<string>();
  const readPreamble = (file: PlanFile, nodes: readonly TexNode[], dirs: readonly string[], depth: number) => {
    const context = `${file.key}|${dirs.join("|")}`;
    if (preambleSeen.has(context) || depth >= 32) return;
    preambleSeen.add(context);
    walkTex(nodes, (n) => {
      if (n.t === "math" || n.t === "verb" || n.t === "comment") return false;
      if (n.t === "macro" && n.name === "includeonly") {
        includeOnly = argText(file.src, n.args[0]).split(",").map((s) => s.trim()).filter(Boolean);
      }
      if (isFileInput(n)) {
        const target = resolveInput(file, n, dirs);
        if (target?.child) readPreamble(target.child, target.child.nodes, target.dirs, depth + 1);
      }
    });
  };
  readPreamble(rootFile, preamble, [rootDir], 0);

  // The body's visits, in TeX's order.
  const visits: PlanVisit[] = [{ key: rootKey, occ: 0, parent: -1, parentLine: 0, inputDirs: [rootDir], bodyOnly: true }];
  const inputTargets = new Map<string, number>();
  const inputKeys = new Map<string, string>();
  const sourceAliases = new Map<string, string>([[rootFile.abs, rootKey]]);
  const spellingDirs = new Map<number, string[]>([[0, [rootDir]]]);
  const seen = new Map<string, number>([[rootKey, 1]]);
  const visited = new Set<string>([rootKey]);
  const visit = (file: PlanFile, nodes: readonly TexNode[], index: number, depth: number) => {
    walkTex(nodes, (n) => {
      if (n.t === "math" || n.t === "verb" || n.t === "comment") return false;
      if (!isFileInput(n)) return;
      const target = resolveInput(file, n, visits[index].inputDirs);
      if (!target) return;
      const { key, child, dirs, bodyOnly, name } = target;
      const inclusion = n.name === "include" || n.name === "subfileinclude" || n.name.endsWith("includefrom");
      if (inclusion && includeOnly && !(includeOnly as string[]).includes(name) && !(includeOnly as string[]).includes(key.replace(/\.tex$/, ""))) return;
      inputKeys.set(`${index}@${n.from}`, key);
      if (depth >= 32) return;
      if (!child || !key) return;
      const occ = seen.get(key) ?? 0;
      seen.set(key, occ + 1);
      visited.add(key);
      const next = visits.length;
      inputTargets.set(`${index}@${n.from}`, next);
      // TeX retains dot components in import@path. Preserve each actually used spelling for
      // the probe's exact source alias table; filesystem resolution and keys stay canonical.
      const parentDirs = visits[index].inputDirs;
      const rawDirs = spellingDirs.get(index) ?? parentDirs;
      const withExt = extname(name) ? name : `${name}.tex`;
      const append = (base: string, tail: string) => `${base.replace(/\/+$/, "")}/${tail}`;
      let spelling: string;
      let importedDir: string | null = null;
      if (IMPORTS.has(n.name)) {
        const dir = literalTexPath(argText(file.src, n.args[n.args.length - 2]));
        importedDir = isAbsolute(dir) ? dir : append(n.name.startsWith("sub") ? rawDirs[0] : rootDir, dir);
        spelling = append(importedDir, withExt);
      } else if (bodyOnly) {
        spelling = isAbsolute(withExt) ? withExt : append(rawDirs[0], withExt);
        importedDir = dirname(spelling);
      } else {
        const candidate = parentDirs.findIndex((dir) => inputKey(rootDir, resolve(dir, withExt)) === key);
        spelling = isAbsolute(withExt) ? withExt : append(rawDirs[Math.max(0, candidate)], withExt);
      }
      if (inputKey(rootDir, spelling) === key) sourceAliases.set(spelling, key);
      spellingDirs.set(next, dirs.map((dir, i) => {
        if (i === 0 && importedDir !== null) return importedDir;
        const previous = parentDirs.indexOf(dir);
        return previous >= 0 ? rawDirs[previous] : dir;
      }));
      visits.push({ key, occ, parent: index, parentLine: lineAt(file, n.from), inputDirs: dirs, bodyOnly });
      const document = bodyOnly ? child.nodes.find((n) => n.t === "env" && n.name === "document") : null;
      visit(child, document?.t === "env" ? document.body : child.nodes, next, depth + 1);
    });
  };
  if (doc?.t === "env") visit(rootFile, doc.body, 0, 0);

  // Nested imports can introduce definitions projectDefinitions' root-only paths never saw.
  // Enrich signatures from the files actually discovered, then parse every source at its offsets.
  sig = projectSignatures(o.defs, [...sources, ...[...files.values()].map((f) => f.src)], o.theorems);
  for (const file of files.values()) file.nodes = parseTex(file.src, sig);
  doc = rootFile.nodes.find((n) => n.t === "env" && n.name === "document");

  // Fragments and the instrumented copies of the files the body visits.
  const fragments: PlanFragment[] = [];
  const copies = new Map<string, string>();
  const environmentExpansions = new Map<string, string>();
  const usedEnvs = new Set<string>();
  const usedColors = new Set<string>();
  const mathOk = o.mathOk ?? (() => true);
  /** Expand only constructs the native emitter can draw; TeX-only bodies keep their fragment. */
  const nativeExpansion = (text: string, stack: readonly string[]): string | null => {
    const replacements: { from: number; to: number; text: string }[] = [];
    let safe = true;
    walkTex(parseTex(text, sig), (n) => {
      if (!safe) return false;
      if (n.t === "env") {
        const definition = sig.environmentDefs?.get(n.name);
        if (definition && !o.theorems.has(n.name)) {
          if (stack.includes(n.name) || stack.length >= 8) { safe = false; return false; }
          const expanded = expandEnvironment(text, n, sig);
          const native = expanded === null ? null : nativeExpansion(expanded, [...stack, n.name]);
          if (native === null) safe = false;
          else replacements.push({ from: n.from, to: n.to, text: native });
          return false;
        }
        if (!HTML_ENVS.has(n.name) && !o.theorems.has(n.name)) { safe = false; return false; }
        if ((n.name === "tabular" || n.name === "tabular*") && COMPLEX_TABLE.test(text.slice(n.bodyFrom, n.bodyTo))) safe = false;
      } else if (n.t === "math") {
        const tex = text.slice(n.env ? n.from : n.srcFrom, n.env ? n.to : n.srcTo);
        if (!mathOk(tex, n.display) || /\\begin\s*\{(?:tikzcd|tikzpicture)\}/.test(tex)) safe = false;
        return false;
      } else if (n.t === "macro") {
        if (n.code || isFileInput(n) || /^(?:tikz|includegraphics|includepdf|lstinputlisting|[egx]?def|let|csname|expandafter|if\w*|else|fi|[hv]box|special|directlua|write|input)$/.test(n.name)) safe = false;
      }
    });
    if (!safe) return null;
    for (const r of replacements.sort((a, b) => b.from - a.from)) text = text.slice(0, r.from) + r.text + text.slice(r.to);
    return text;
  };
  for (const key of visited) {
    const file = files.get(key)!;
    const ownVisits = visits.filter((v) => v.key === key);
    const document = ownVisits.every((v) => v.bodyOnly) ? file.nodes.find((n) => n.t === "env" && n.name === "document") : null;
    const nodes = document?.t === "env" ? document.body : file.nodes;
    const inserts: { at: number; text: string }[] = [];
    const add = (kind: PlanFragment["kind"], from: number, to: number, what: string) => {
      const id = fragments.length;
      fragments.push({ id, kind, key, from, to, what });
      const env = kind === "inline" ? "llxfrag" : "llxblock";
      inserts.push({ at: from, text: `\\begin{${env}}{${id}}` }, { at: to, text: `\\end{${env}}` });
    };
    const scan = (list: readonly TexNode[]) => {
      for (let i = 0; i < list.length; i++) {
        const n = list[i];
        if (n.t === "env") {
          usedEnvs.add(n.name);
          if (PICTURE_ENVS.has(n.name)) add("inline", n.from, n.to, n.name);
          else if ((n.name === "tabular" || n.name === "tabular*") && COMPLEX_TABLE.test(file.src.slice(n.bodyFrom, n.bodyTo))) add("inline", n.from, n.to, `${n.name} with spanning rows or colours`);
          else if (!HTML_ENVS.has(n.name) && !o.theorems.has(n.name)) {
            const expanded = expandEnvironment(file.src, n, sig);
            const native = expanded === null ? null : nativeExpansion(expanded, [n.name]);
            if (native === null) add("block", n.from, n.to, n.name);
            else {
              environmentExpansions.set(`${key}@${n.from}`, native);
              walkTex(parseTex(native, sig), (x) => {
                if (x.t === "env") usedEnvs.add(x.name);
                if (x.t === "macro" && (x.name === "textcolor" || x.name === "color" || x.name === "colorbox")) {
                  for (const name of colorNames(argText(native, x.args[1]))) usedColors.add(name);
                }
              });
            }
          }
          else {
            for (const a of n.args) if (a.body) scan(a.body);
            scan(n.body);
          }
        } else if (n.t === "math") {
          const inner = file.src.slice(n.srcFrom, n.srcTo);
          const picture = /\\begin\s*\{(tikzcd|tikzpicture)\}/.exec(inner);
          const tex = file.src.slice(n.env ? n.from : n.srcFrom, n.env ? n.to : n.srcTo);
          if (picture) add(n.display ? "block" : "inline", n.from, n.to, `${n.env ?? (n.display ? "display" : "inline")} math with ${picture[1]}`);
          else if (!mathOk(tex, n.display)) add(n.display ? "block" : "inline", n.from, n.to, `${n.display ? "display" : "inline"} math MathJax rejects`);
        } else if (n.t === "macro") {
          if (n.name === "tikz") {
            // `\tikz[..] {..}` or `\tikz[..] path;`: up to its group, else its semicolon.
            let j = i + 1;
            while (list[j]?.t === "space") j++;
            const next = list[j];
            const semi = file.src.indexOf(";", n.to);
            const end = next?.t === "group" ? next.to : semi >= 0 && !/\n[ \t]*\n/.test(file.src.slice(n.to, semi)) ? semi + 1 : n.to;
            add("inline", n.from, end, "\\tikz");
            while (i + 1 < list.length && list[i + 1].to <= end) i++;
            continue;
          }
          if ((n.name === "textcolor" || n.name === "color" || n.name === "colorbox") && n.args.length) {
            // An expression's (`blue!70!black`) names: the emitter mixes the probe's values.
            for (const name of colorNames(argText(file.src, n.args[1]))) usedColors.add(name);
          }
          if (!n.code) for (const a of n.args) if (a.body) scan(a.body);
        } else if (n.t === "group") scan(n.body);
      }
    };
    scan(nodes);
    let text = file.src;
    for (const ins of inserts.sort((a, b) => b.at - a.at)) text = text.slice(0, ins.at) + ins.text + text.slice(ins.at);
    copies.set(key, text);
  }

  const profile = profileOf(files.get(rootKey)!.src, []);
  const titleLabels = profile.name === "elegantbook" ? "elegantbook" : profile.name === "elegantnote" || profile.name === "elegantpaper" ? "elegantarticle" : undefined;
  const titleNames = titleLabels === "elegantbook" ? TITLE_NAMES : [];
  const names = [...new Set([...PROBE_NAMES, ...titleNames, ...o.theorems.keys()].map((e) => e.replace(/\*$/, "")))].filter((n) => !TITLE_NAMES.includes(n) || titleNames.includes(n));
  const colors = [...new Set([...PROBE_COLORS, ...o.defs.colors, ...usedColors])];
  // A class can redefine a normally standard theorem, notably LNCS's non-amsthm proof.
  const envs = [...usedEnvs].filter((e) => (!STANDARD_ENVS.has(e) || o.theorems.has(e)) && /^[A-Za-z@*]+$/.test(e));
  return {
    root,
    rootDir,
    rootKey,
    job: basename(root, extname(root)),
    sig,
    files,
    visits,
    inputTargets,
    inputKeys,
    sourceAliases,
    fragments,
    copies,
    environmentExpansions,
    probe: { names, colors: colors.filter((c) => /^[A-Za-z][\w.-]*$/.test(c)), envs, ...(titleLabels ? { titleLabels } : {}) },
    includeOnly,
    missing,
  };
}

/** The plan's files parsed again with the census's environment specs (design 3.2), same keys and lines. */
export function reparse(plan: ExportPlan, census: ReadonlyMap<string, string>): ExportPlan {
  const sig = withCensus(plan.sig, census);
  const files = new Map<string, PlanFile>();
  for (const [key, f] of plan.files) files.set(key, { ...f, nodes: parseTex(f.src, sig) });
  return { ...plan, sig, files };
}
