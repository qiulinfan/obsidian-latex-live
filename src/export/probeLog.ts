import { texText } from "../tex/texText";
import { drawingKey } from "./fragments";
import type { ListingSettings } from "./listings";

// The probe pass's `.llx` file (design 3.2) and the queues that hand its numbers to the emitter.
// One record per line, `llx<kind>{..}{..}` (no backslash: `\escapechar` is -1 while `.fd` files
// load), in the order TeX did things:
//   llxin{dir}{file}{parent line} / llxout{dir}{file}   file visits after \begin{document}
//   llxstep{counter}{value}{dir}{file}{line}            a \stepcounter: `\the<counter>`, for
//                                                        enumi..enumiv the item label; counter
//                                                        `llx@bib`: an entry a biblatex
//                                                        bibliography printed (value: its key)
//   llxtoc{level}{entry}{dir}{file}{line}                an \addcontentsline{toc}
//   llxname{name}{text} llxcolor{name}{model}{spec} llxenv{env}{meaning}
//   llxinfo{key}{value}                                  fontsize, tocdepth, secnumdepth;
//                                                        biblatex's citestyle and sortcites;
//                                                        natbib (`numbers,sort,compress`) and
//                                                        natbib-open/close/sep/aysep/cmt
//   llxcite{key}{labelnumber}{labelprefix}               biblatex, per cited or printed key
//   llxlisting{language}{dialect}{keywordstyle}{commentstyle}{stringstyle}{dir}{file}{line}
//                                                      effective settings, styles unexpanded
//   llxfrag{id}{ht}{dp}{wd}{visit} / llxblock{id}{visit}  explicit runtime drawing identity
//   llxopen{id} / llxclose{id}                           around a fragment: the steps between
//                                                        are in its drawing
// Records are positioned by visit, not by their file fields: right after a visit ends TeX still
// names the child file while `\inputlineno` is the parent's line.

export interface ProbeVisit {
  /** The file's key as TeX named it (`chapters/ch1.tex`); "" for the root. */
  key: string;
  parent: number;
  parentLine: number;
}

export interface ProbeStep {
  /** The counter, or "toc" for a contents entry. */
  counter: string;
  /** What TeX wrote: `\the<counter>` (an item's label), or the entry of a "toc" record. */
  value: string;
  /** The sectioning level of a "toc" record (`chapter`). */
  level?: string;
  /** The log visit and its line. */
  visit: number;
  line: number;
  /** The fragment TeX took it in (its drawing shows it), if any. */
  frag?: number;
  /** Runtime visit that opened the fragment (its steps may occur in an input inside it). */
  fragVisit?: number;
}

export interface ProbeFragment {
  id: number;
  visit: number;
  /** Height, depth and width in TeX points (null for a block). */
  box: { ht: number; dp: number; wd: number } | null;
}

export interface ProbeListing extends ListingSettings {
  visit: number;
  line: number;
  frag?: number;
}

export interface ProbeLog {
  /** `\<name>name` as it typesets (`figure` -> 图). */
  names: Map<string, string>;
  /** Colour name -> CSS colour (`rgb(60, 113, 183)`). */
  colors: Map<string, string>;
  /** The census: environment -> the `\meaning` of its begin macro. */
  envs: Map<string, string>;
  /** fontsize (pt), tocdepth, secnumdepth, citestyle, sortcites, natbib (see the file comment). */
  info: Map<string, string>;
  /** biblatex's label per cited key. */
  cites: Map<string, { number: string; prefix: string }>;
  /** Visits in order; visits[0] is the root. */
  visits: ProbeVisit[];
  steps: ProbeStep[];
  /** Fragment pages in page order. */
  fragments: ProbeFragment[];
  /** Every listings Init, in execution order, before it reads verbatim text or an external file. */
  listings: ProbeListing[];
  /** Lines that are no record (a truncated file). */
  unreadable: number;
}

/** The brace groups of a record from s[at]: their contents (braces balanced, escapes kept). */
function groups(s: string, at: number): string[] {
  const out: string[] = [];
  let i = at;
  while (s[i] === "{") {
    let depth = 0;
    let j = i;
    for (; j < s.length; j++) {
      const c = s[j];
      if (c === "\\") j++;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    if (j >= s.length) break;
    out.push(s.slice(i + 1, j));
    i = j + 1;
  }
  return out;
}

/** An xcolor model and spec (`\extractcolorspecs`) as CSS; null for a model it cannot convert. */
export function cssColor(model: string, spec: string): string | null {
  const v = spec.split(",").map((x) => Number(x.trim()));
  if (v.some((x) => !Number.isFinite(x))) return model === "HTML" && /^[0-9A-Fa-f]{6}$/.test(spec.trim()) ? `#${spec.trim().toLowerCase()}` : null;
  const byte = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255);
  const rgb = (r: number, g: number, b: number) => `rgb(${byte(r)}, ${byte(g)}, ${byte(b)})`;
  switch (model) {
    case "rgb":
      return v.length === 3 ? rgb(v[0], v[1], v[2]) : null;
    case "RGB":
      return v.length === 3 ? rgb(v[0] / 255, v[1] / 255, v[2] / 255) : null;
    case "gray":
      return v.length === 1 ? rgb(v[0], v[0], v[0]) : null;
    case "cmyk":
      return v.length === 4 ? rgb((1 - v[0]) * (1 - v[3]), (1 - v[1]) * (1 - v[3]), (1 - v[2]) * (1 - v[3])) : null;
    case "cmy":
      return v.length === 3 ? rgb(1 - v[0], 1 - v[1], 1 - v[2]) : null;
    default:
      return null;
  }
}

/** The key of a file as its records name it: its directory and name, from the root's folder. */
function keyOf(dir: string, file: string): string {
  const path = (dir ? `${dir.replace(/\/+$/, "")}/${file}` : file).replace(/^(\.\/)+/, "");
  const parts: string[] = [];
  for (const p of path.split("/")) {
    if (p === "..") parts.pop();
    else if (p && p !== ".") parts.push(p);
  }
  return parts.join("/");
}

/** Read a probe log (see the file comment). */
export function readProbeLog(text: string): ProbeLog {
  const log: ProbeLog = {
    names: new Map(),
    colors: new Map(),
    envs: new Map(),
    info: new Map(),
    cites: new Map(),
    visits: [{ key: "", parent: -1, parentLine: 0 }],
    steps: [],
    fragments: [],
    listings: [],
    unreadable: 0,
  };
  const stack = [0];
  const open: { id: number; visit: number }[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const m = /^llx([a-z]+)\{/.exec(line);
    if (!m) {
      log.unreadable++;
      continue;
    }
    const kind = m[1];
    const g = groups(line, m[0].length - 1);
    const top = stack[stack.length - 1];
    switch (kind) {
      case "in":
        log.visits.push({ key: keyOf(g[0] ?? "", g[1] ?? ""), parent: top, parentLine: Number(g[2]) || 0 });
        stack.push(log.visits.length - 1);
        break;
      case "out":
        if (stack.length > 1) stack.pop();
        break;
      case "step":
      case "toc":
        if (g.length < 5) {
          log.unreadable++;
          break;
        }
        log.steps.push({
          counter: kind === "toc" ? "toc" : g[0],
          value: g[1],
          ...(kind === "toc" ? { level: g[0] } : {}),
          visit: top,
          line: Number(g[4]) || 0,
          ...(open.length ? { frag: open[open.length - 1].id, fragVisit: open[open.length - 1].visit } : {}),
        });
        break;
      case "open":
        open.push({ id: Number(g[0]), visit: top });
        break;
      case "close":
        open.pop();
        break;
      case "name":
        log.names.set(g[0], texText(g[1] ?? ""));
        break;
      case "color": {
        const css = cssColor(g[1] ?? "", g[2] ?? "");
        if (css) log.colors.set(g[0], css);
        break;
      }
      case "env":
        // The meaning may hold unbalanced braces: everything after the name up to the last `}`.
        log.envs.set(g[0], line.slice(m[0].length + g[0].length + 2, line.lastIndexOf("}")));
        break;
      case "info":
        log.info.set(g[0], g[1] ?? "");
        break;
      case "cite":
        if (!log.cites.has(g[0])) log.cites.set(g[0], { number: g[1] ?? "", prefix: g[2] ?? "" });
        break;
      case "listing":
        if (g.length < 8) { log.unreadable++; break; }
        log.listings.push({ language: g[0], dialect: g[1], keywordstyle: g[2], commentstyle: g[3], stringstyle: g[4], visit: top, line: Number(g[7]) || 0, ...(open.length ? { frag: open[open.length - 1].id } : {}) });
        break;
      case "frag": {
        const pt = (s: string | undefined) => parseFloat(s ?? "") || 0;
        log.fragments.push({ id: Number(g[0]), visit: g[4] === undefined ? top : Number(g[4]), box: { ht: pt(g[1]), dp: pt(g[2]), wd: pt(g[3]) } });
        break;
      }
      case "block":
        log.fragments.push({ id: Number(g[0]), visit: g[1] === undefined ? top : Number(g[1]), box: null });
        break;
      default:
        log.unreadable++;
    }
  }
  return log;
}

/** A contents entry's number (`\numberline{第一章}`) and title as they typeset. */
export function tocEntry(entry: string): { number: string | null; title: string } {
  const m = /\\numberline\s*\{/.exec(entry);
  if (!m) return { number: null, title: texText(entry) };
  const open = m.index + m[0].length - 1;
  const [num] = groups(entry, open);
  const rest = entry.slice(open + (num?.length ?? 0) + 2);
  return { number: texText(num ?? ""), title: texText(rest) };
}

/** A construct's lines in one visit of the plan (PlanVisit index), inclusive. */
export interface Span {
  visit: number;
  from: number;
  to: number;
}

/** A step the emitter did not take (report item "numbering"). */
export interface StepProblem {
  counter: string;
  value: string;
  /** The log visit's key and the line. */
  key: string;
  line: number;
}

/**
 * The probe's steps per counter, handed to the constructs that print them (design 3.2, resync):
 * records of one counter with the same value at the same position merge (tcolorbox steps its
 * counter twice per box; subequations its parent twice); `take` drops the head records positioned
 * before the span (orphans), takes the head when it lies inside the span, and else gives null
 * (the emitter falls back to the .aux number or `?`). A position compares by the chain of visits
 * leading to it: a record in a file a construct's lines read lies inside that construct. Steps TeX
 * took inside a fragment are dropped by its id and opening file visit (`llxopen`/`llxclose`), never by lines: a
 * caption on the line of an inline picture keeps its step.
 */
export class StepQueue {
  readonly orphans: StepProblem[] = [];
  private queues = new Map<string, { steps: ProbeStep[]; next: number }>();
  /** Log visit -> its chain: [line in the root, child ordinal, line in the child, ...]. */
  private chains: number[][] = [];
  /** Plan visit index -> log visit index (by file key and occurrence). */
  private planToLog: number[] = [];
  private listings = new Map<number, { records: ProbeListing[]; next: number }>();

  constructor(
    private log: ProbeLog,
    planVisits: readonly { key: string; occ: number }[],
  ) {
    for (const record of log.listings) if (record.frag === undefined) {
      let queue = this.listings.get(record.visit);
      if (!queue) this.listings.set(record.visit, (queue = { records: [], next: 0 }));
      queue.records.push(record);
    }
    const children = new Map<number, number>();
    const occ = new Map<string, number>();
    const byKey = new Map<string, number>();
    log.visits.forEach((v, i) => {
      if (i === 0) {
        this.chains.push([]);
        return;
      }
      const ordinal = children.get(v.parent) ?? 0;
      children.set(v.parent, ordinal + 1);
      this.chains.push([...this.chains[v.parent], v.parentLine, ordinal]);
      const n = occ.get(v.key) ?? 0;
      occ.set(v.key, n + 1);
      byKey.set(`${v.key}#${n}`, i);
    });
    this.planToLog = planVisits.map((v, i) => (i === 0 ? 0 : (byKey.get(`${v.key}#${v.occ}`) ?? -1)));
    for (const s of log.steps) {
      let q = this.queues.get(s.counter);
      if (!q) this.queues.set(s.counter, (q = { steps: [], next: 0 }));
      const last = q.steps[q.steps.length - 1];
      if (last && last.value === s.value && last.visit === s.visit && last.line === s.line && last.level === s.level) continue;
      q.steps.push(s);
    }
  }

  /** The plan visit was seen by the probe. */
  knows(visit: number): boolean {
    return (this.planToLog[visit] ?? -1) >= 0;
  }

  /** The explicit drawing marker for a construct in a plan visit; null when that visit was unseen. */
  fragmentKey(id: number, visit: number): string | null {
    const logVisit = this.planToLog[visit] ?? -1;
    return logVisit < 0 ? null : drawingKey(logVisit, id);
  }

  /** Consume effective settings in this source span; same-line listings keep execution order. */
  takeListing(span: Span): ProbeListing | null {
    const logVisit = this.planToLog[span.visit] ?? -1;
    if (logVisit < 0) return null;
    const queue = this.listings.get(logVisit);
    if (!queue) return null;
    while (queue.next < queue.records.length) {
      const listing = queue.records[queue.next];
      if (listing.line < span.from) { queue.next++; continue; }
      if (listing.line > span.to) return null;
      queue.next++;
      return listing;
    }
    return null;
  }

  /** Title/abstract TOC records belong to rendered front matter, not numbered sections. */
  takeFrontmatterToc(span: Span, before = false, abstractName?: string): void {
    const q = this.queues.get("toc");
    const visit = this.planToLog[span.visit] ?? -1;
    if (!q || visit < 0) return;
    const start = [...this.chains[visit], span.from];
    const end = [...this.chains[visit], span.to];
    while (q.next < q.steps.length) {
      const step = q.steps[q.next];
      const at = [...this.chains[step.visit], step.line];
      const entry = step.level === "section" && abstractName ? tocEntry(step.value) : null;
      const abstract = entry !== null && !entry.number && texText(entry.title).trim() === texText(abstractName!).trim();
      if ((!before && compare(at, start) < 0) || compare(at, end) > 0 || (!(["title", "author", "abstract"].includes(step.level ?? "")) && !abstract)) return;
      q.next++;
    }
  }

  /** The head step of `counter` inside `span`, consumed; earlier ones are dropped as orphans. */
  take(counter: string, span: Span): ProbeStep | null {
    const q = this.queues.get(counter);
    const logVisit = this.planToLog[span.visit] ?? -1;
    if (!q || logVisit < 0) return null;
    const start = [...this.chains[logVisit], span.from];
    const end = [...this.chains[logVisit], span.to];
    while (q.next < q.steps.length) {
      const s = q.steps[q.next];
      const at = [...this.chains[s.visit], s.line];
      if (compare(at, start) < 0) {
        this.orphan(s);
        q.next++;
        continue;
      }
      if (compare(at, end) > 0) return null;
      q.next++;
      return s;
    }
    return null;
  }

  /** Drop steps inside fragment `id` opened by this plan visit, including its nested inputs. */
  drop(id: number, visit = 0): ProbeStep[] {
    const logVisit = this.planToLog[visit] ?? -1;
    if (logVisit < 0) return [];
    const dropped: ProbeStep[] = [];
    for (const q of this.queues.values()) {
      const kept = q.steps.slice(q.next).filter((s) => {
        const belongs = s.frag === id && s.fragVisit === logVisit;
        if (belongs) dropped.push(s);
        return !belongs;
      });
      q.steps = [...q.steps.slice(0, q.next), ...kept];
    }
    const order = new Map(this.log.steps.map((s, i) => [s, i]));
    return dropped.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }

  private orphan(s: ProbeStep): void {
    this.orphans.push({ counter: s.counter, value: s.value, key: this.log.visits[s.visit]?.key ?? "", line: s.line });
  }
}

/**
 * Compare a record's chain with a span bound's: only as deep as the bound (a record in a file the
 * bound's line read is at that line); a record at a shorter chain that is a prefix counts as before.
 */
function compare(at: readonly number[], bound: readonly number[]): number {
  for (let i = 0; i < bound.length; i++) {
    if (i >= at.length) return -1;
    if (at[i] !== bound[i]) return at[i] < bound[i] ? -1 : 1;
  }
  return 0;
}
