import { tableColumns, type RuleWeight, type TableColumn, type TableRule } from "../export/tables";
import { blockEnvKind } from "../tex/envRules";
import { texText } from "../tex/texText";
import type { LatexConstruct, TextStyle } from "./latexScan";

// A tabular as a simple table in the live editor (latexLive #23): the source of a tabular,
// tabular*, tabularx or longtable parsed into rows, cells and rules with their offsets (parseTabular), each
// cell's constructs turned into the parts a table request carries (cellParts, as the JSON of a
// TableSpec), and the request's node (tableNode). The column spec is export's (tableColumns:
// `|`, `@{}`, `!{}`, `>{}`, `<{}`, `*{n}{..}`; p, m, b and X are paragraph columns). Rows split
// at the body's own `\\` (its `[len]` skipped) and cells at its own `&`: not in a group, a
// formula or an inner environment, and not `\&`. A row starts with its rules (\hline, booktabs'
// rules, \cline and \cmidrule over their columns); \multicolumn spans with its own spec, and
// \multirow spans its rows (a negative count the rows above), taking the empty cells it covers.
// A longtable's \endfirsthead, \endhead, \endfoot and \endlastfoot end rows too: it shows its
// first head (else its head) once, its body, then its last foot (else its foot); a `\kill` row
// goes and a `\caption` row spans the table. A source the parse cannot follow (unbalanced braces
// or `$`, a tabular inside, an inner environment left open) or whose rows do not fit the columns
// (more cells than columns, a \multirow over a missing row or a cell with content) is null: it
// stays source. Pure but for tableNode's DOM.

/** A cell: its content's offsets in the parsed source, the columns and rows it spans and their spec. */
export interface TabularCell {
  from: number;
  to: number;
  /** Its first column (1-based); a \multirow above may cover the columns before it. */
  column: number;
  span: number;
  /** A \multicolumn's own spec. */
  col: TableColumn | null;
  /** A \multirow's rows (down from this cell's row) and vertical position. */
  rowSpan: number;
  vpos: "t" | "c" | "b";
  /** Its content is a `\caption`'s argument. */
  caption?: boolean;
}

export interface TabularRow {
  /** The rules between the previous row and this one. */
  above: TableRule[];
  cells: TabularCell[];
}

export interface TabularLayout {
  columns: TableColumn[];
  rows: TabularRow[];
  /** The rules after the last row. */
  below: TableRule[];
}

/** Rule commands between rows and their weights. */
const RULES = new Map<string, RuleWeight>([
  ["hline", "thin"], ["toprule", "heavy"], ["bottomrule", "heavy"], ["midrule", "light"], ["cline", "thin"], ["cmidrule", "light"], ["specialrule", "heavy"],
]);
/** Commands between rows that draw nothing here (their arguments go with them). */
const SPACING = new Set(["addlinespace", "morecmidrules", "noalign"]);

/** The index after the brace group opened at s[i], or -1 when it never closes. */
function groupEnd(s: string, i: number): number {
  for (let j = i + 1, depth = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "{") depth++;
    else if (c === "}" && depth-- === 0) return j + 1;
  }
  return -1;
}

/** The index after a `[..]` (or `(..)`) at s[i] past blanks, else i. */
function optEnd(s: string, i: number, open = "[", close = "]"): number {
  const k = skip(s, i);
  if (s[k] !== open) return i;
  const e = s.indexOf(close, k);
  return e < 0 ? i : e + 1;
}

const skip = (s: string, i: number): number => {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
};

/** A mandatory argument at s[i] past blanks: its content's offsets and the index after it, or null. */
function arg(s: string, i: number): { from: number; to: number; end: number } | null {
  const k = skip(s, i);
  if (s[k] !== "{") return null;
  const e = groupEnd(s, k);
  return e < 0 ? null : { from: k + 1, to: e - 1, end: e };
}

/** The end of the line comment starting at s[i]. */
const commentEnd = (s: string, i: number): number => {
  const e = s.indexOf("\n", i);
  return e < 0 ? s.length : e;
};

/**
 * The rows of the tabular `src` (`\begin{tabular}..\end{tabular}`, trailing text after the \end
 * ignored), or null when the parse cannot follow it.
 */
export function parseTabular(src: string): TabularLayout | null {
  const head = /^\\begin\s*\{(tabular\*?|tabularx|longtable)\}/.exec(src);
  if (!head) return null;
  const env = head[1];
  let i = head[0].length;
  if (env === "tabular*" || env === "tabularx") {
    const width = arg(src, i);
    if (!width) return null;
    i = width.end;
  }
  i = optEnd(src, i);
  const spec = arg(src, i);
  if (!spec) return null;
  const columns = tableColumns(src.slice(spec.from, spec.to));
  if (!columns.length) return null;
  const width = columns.length;

  const rows: TabularRow[] = [];
  let row: TabularRow = { above: [], cells: [] };
  let cellFrom = spec.end;
  /** The current row has nothing but its rules so far. */
  let fresh = true;
  let depth = 0;
  /** In a formula: its closing delimiter. */
  let math: string | null = null;
  const inner: string[] = [];
  const endCell = (to: number) => {
    row.cells.push(cell(src, cellFrom, to));
  };
  /** A longtable's parts so far, by the command that ended them. */
  const parts = new Map<string, Part>();
  /** Ends the part so far (its last row, unless it holds nothing but rules) under `name`. */
  const endPart = (name: string, at: number): Part | null => {
    if (fresh) {
      if (row.cells.length) return null;
    } else {
      endCell(at);
      rows.push(row);
    }
    const part = { rows: rows.splice(0), below: fresh ? row.above : [] };
    parts.set(name, part);
    row = { above: [], cells: [] };
    fresh = true;
    return part;
  };
  for (i = spec.end; i < src.length; ) {
    const c = src[i];
    if (c === "%") {
      i = commentEnd(src, i);
      continue;
    }
    if (c === "{") {
      depth++;
      i++;
      continue;
    }
    if (c === "}") {
      if (--depth < 0) return null;
      i++;
      continue;
    }
    if (c === "$") {
      const d = src[i + 1] === "$" ? "$$" : "$";
      if (math === null) math = d;
      else if (math === d) math = null;
      else if (math !== "$$" || d !== "$") return null;
      i += d.length;
      fresh = false;
      continue;
    }
    if (c !== "\\") {
      if (c === "&" && !depth && math === null && !inner.length) {
        endCell(i);
        cellFrom = i + 1;
      }
      if (!/\s/.test(c)) fresh = false;
      i++;
      continue;
    }
    const name = /^\\(?:[A-Za-z]+\*?|.)/s.exec(src.slice(i, i + 40))?.[0].slice(1) ?? "";
    const after = i + 1 + name.length;
    if (name === "(" || name === "[") {
      if (math === null) math = name === "(" ? "\\)" : "\\]";
      i = after;
      fresh = false;
      continue;
    }
    if (name === ")" || name === "]") {
      if (math === "\\" + name) math = null;
      i = after;
      continue;
    }
    if (name === "begin" || name === "end") {
      const e = arg(src, after);
      if (!e) return null;
      const which = src.slice(e.from, e.to).trim();
      if (name === "begin") {
        if (math === null && blockEnvKind(which) === "table") return null;
        if (math === null) inner.push(which);
      } else if (math === null) {
        if (!inner.length) {
          // The tabular's own \end: the last row, unless it holds nothing but rules.
          if (which !== env || depth || !endPart("", i)) return null;
          return grid(columns, joinParts(parts));
        }
        if (inner.pop() !== which) return null;
      }
      i = e.end;
      fresh = false;
      continue;
    }
    if (depth || math !== null || inner.length) {
      i = after;
      continue;
    }
    if (env === "longtable" && LONGTABLE_PARTS.includes(name)) {
      if (!endPart(name, i)) return null;
      i = cellFrom = after;
      continue;
    }
    if (name === "\\" || name === "tabularnewline" || (name === "kill" && env === "longtable")) {
      endCell(i);
      if (name !== "kill") rows.push(row);
      row = { above: name === "kill" ? row.above : [], cells: [] };
      fresh = true;
      i = after;
      if (name === "\\") {
        if (src[i] === "*") i++;
        i = optEnd(src, i);
      }
      cellFrom = i;
      continue;
    }
    const weight = RULES.get(name);
    if (fresh && (weight || SPACING.has(name))) {
      let j = after;
      let from = 1;
      let to = width;
      if (name === "cline" || name === "cmidrule") {
        if (name === "cmidrule") j = optEnd(src, optEnd(src, j), "(", ")");
        const range = arg(src, j);
        const m = range && /^\s*(\d+)\s*-\s*(\d+)\s*$/.exec(src.slice(range.from, range.to));
        if (!range || !m) return null;
        from = Number(m[1]);
        to = Number(m[2]);
        j = range.end;
      } else if (name === "specialrule") {
        for (let k = 0; k < 3; k++) j = arg(src, j)?.end ?? j;
      } else if (name === "noalign") {
        j = arg(src, j)?.end ?? j;
      } else j = optEnd(src, j);
      if (weight) {
        const twice = weight === "thin" && from === 1 && to === width && row.above.find((r) => r.weight === "thin" && r.from === 1 && r.to === width);
        if (twice) twice.weight = "double";
        else row.above.push({ weight, from, to });
      }
      i = cellFrom = j;
      continue;
    }
    fresh = false;
    i = after;
  }
  return null; // no \end
}

/** Rows and the rules after them. */
interface Part {
  rows: TabularRow[];
  below: TableRule[];
}

/** The commands that end a longtable's head and foot parts. */
const LONGTABLE_PARTS = ["endfirsthead", "endhead", "endfoot", "endlastfoot"];

/** A longtable's parts as shown once: its first head (else head), body ("") and last foot (else foot). */
function joinParts(parts: ReadonlyMap<string, Part>): Part {
  const shown = [parts.get("endfirsthead") ?? parts.get("endhead"), parts.get(""), parts.get("endlastfoot") ?? parts.get("endfoot")];
  const out: Part = { rows: [], below: [] };
  for (const part of shown) {
    if (!part) continue;
    if (part.rows.length) {
      const [first, ...rest] = part.rows;
      out.rows.push({ above: [...out.below, ...first.above], cells: first.cells }, ...rest);
      out.below = [];
    }
    out.below.push(...part.below);
  }
  return out;
}

/**
 * The layout of `rows` over `columns`, or null when they do not fit: each cell's first column, a
 * `\caption` row over the whole table, a \multirow moved to its top row and the cells it covers
 * taken out (they must be empty).
 */
function grid(columns: TableColumn[], { rows, below }: Part): TabularLayout | null {
  const width = columns.length;
  for (const row of rows) {
    let at = 1;
    for (const c of row.cells) {
      c.column = at;
      at += c.span;
    }
    if (at - 1 > width) return null;
  }
  for (const row of rows) {
    const [only] = row.cells;
    if (row.cells.length === 1 && only.caption) Object.assign(only, { span: width, col: CAPTION_COLUMN });
  }
  for (let r = 0; r < rows.length; r++) {
    for (const c of rows[r].cells.slice()) {
      if (c.rowSpan === 1) continue;
      const top = c.rowSpan > 0 ? r : r + c.rowSpan + 1;
      const n = Math.abs(c.rowSpan);
      if (top < 0 || top + n > rows.length) return null;
      for (let k = top; k < top + n; k++) {
        if (k === r) continue;
        const covered = rows[k].cells.filter((o) => o.column < c.column + c.span && o.column + o.span > c.column);
        if (covered.some((o) => o.column < c.column || o.column + o.span > c.column + c.span || o.to > o.from)) return null;
        rows[k].cells = rows[k].cells.filter((o) => !covered.includes(o));
      }
      if (top !== r) {
        rows[r].cells = rows[r].cells.filter((o) => o !== c);
        rows[top].cells = [...rows[top].cells, c].sort((a, b) => a.column - b.column);
      }
      c.rowSpan = n;
    }
  }
  return { columns, rows, below };
}

/** A caption row's column: centred, no rules. */
const CAPTION_COLUMN: TableColumn = { align: "c", width: null, ruleLeft: 0, ruleRight: 0, noPadLeft: false, noPadRight: false };

/** The cell over [from, to] of `src`: its content trimmed, a \multicolumn's span and spec, a \multirow's rows and text. */
function cell(src: string, from: number, to: number): TabularCell {
  let span = 1;
  let col: TableColumn | null = null;
  let rowSpan = 1;
  let vpos: TabularCell["vpos"] = "c";
  const trim = (a: number, b: number): [number, number] => {
    while (a < b && /\s/.test(src[a])) a++;
    while (b > a && /\s/.test(src[b - 1])) b--;
    return [a, b];
  };
  [from, to] = trim(from, to);
  const multi = /^\\multicolumn\b/.exec(src.slice(from, to));
  if (multi) {
    const n = arg(src, from + multi[0].length);
    const spec = n && arg(src, n.end);
    const body = spec && arg(src, spec.end);
    if (body && body.end <= to && !src.slice(body.end, to).trim()) {
      span = Math.max(1, Number(src.slice(n.from, n.to).trim()) || 1);
      col = tableColumns(src.slice(spec.from, spec.to))[0] ?? null;
      [from, to] = trim(body.from, body.to);
    }
  }
  const row = /^\\multirow\b/.exec(src.slice(from, to));
  if (row) {
    // \multirow[vpos]{rows}[bigstruts]{width}[vmove]{text}
    const posEnd = optEnd(src, from + row[0].length);
    const pos = /^\[\s*([tcb])\s*\]$/.exec(src.slice(skip(src, from + row[0].length), posEnd))?.[1];
    const rows = arg(src, posEnd);
    const widthArg = rows && arg(src, optEnd(src, rows.end));
    const text = widthArg && arg(src, optEnd(src, widthArg.end));
    if (text && text.end <= to && !src.slice(text.end, to).trim()) {
      [from, to] = trim(text.from, text.to);
      const n = Math.trunc(Number(src.slice(rows.from, rows.to).trim()));
      if (Math.abs(n) > 1) rowSpan = n;
      if (pos) vpos = pos as TabularCell["vpos"];
    }
  }
  const caption = /^\\caption\b/.exec(src.slice(from, to));
  const text = caption && arg(src, optEnd(src, from + caption[0].length));
  if (text && text.end <= to) return { from: text.from, to: text.to, column: 0, span, col, rowSpan, vpos, caption: true };
  return { from, to, column: 0, span, col, rowSpan, vpos };
}

// ---- The request ---------------------------------------------------------------------------

/** What a cell shows: text, a formula, a styled run, a chip. */
export type TablePart =
  | { t: "text"; s: string }
  | { t: "math"; src: string; display: boolean }
  | { t: "style"; style: TextStyle; parts: TablePart[] }
  | { t: "chip"; text: string; cls: string; title: string };

export interface TableSpecCell {
  span: number;
  rowSpan: number;
  vpos: TabularCell["vpos"];
  /** The column's alignment (`p` a paragraph column: left, wrapping) and vertical rules. */
  align: "l" | "c" | "r" | "p";
  ruleLeft: number;
  ruleRight: number;
  /** A paragraph column's width as CSS, when it is a plain length. */
  width: string | null;
  /** Rules above and below over the cell's columns. */
  top: RuleWeight | null;
  bottom: RuleWeight | null;
  parts: TablePart[];
  /** The cell's source: what it shows when a part cannot render. */
  src: string;
}

/** A table request's source (as JSON). */
export interface TableSpec {
  rows: TableSpecCell[][];
  center: boolean;
}

const RULE_ORDER: RuleWeight[] = ["thin", "light", "heavy", "double"];

/** The heaviest of `rules` over columns from..to (1-based). */
function ruleOver(rules: readonly TableRule[], from: number, to: number): RuleWeight | null {
  let best: RuleWeight | null = null;
  for (const r of rules) if (r.from <= to && r.to >= from && (!best || RULE_ORDER.indexOf(r.weight) > RULE_ORDER.indexOf(best))) best = r.weight;
  return best;
}

const align = (c: TableColumn): TableSpecCell["align"] => (c.align === "l" || c.align === "c" || c.align === "r" ? c.align : "p");
const cssWidth = (w: string | null): string | null => (w && /^\s*\d*\.?\d+\s*(?:cm|mm|in|pt|em|ex)\s*$/.test(w) ? w.replace(/\s+/g, "") : null);

/**
 * The table's spec: `layout` parsed from the source at `base` of the document, `parts` a cell's
 * parts from its document offsets.
 */
export function tableSpec(layout: TabularLayout, base: number, text: (from: number, to: number) => string, parts: (from: number, to: number) => TablePart[], center: boolean): TableSpec {
  const { columns, rows, below } = layout;
  return {
    center,
    rows: rows.map((row, r) =>
      row.cells.map((cell) => {
        const first = cell.column;
        const at = first + cell.span;
        const next = rows[r + cell.rowSpan]?.above ?? below;
        const col = cell.col ?? columns[first - 1];
        const last = cell.col ? col : columns[at - 2];
        return {
          span: cell.span,
          rowSpan: cell.rowSpan,
          vpos: cell.vpos,
          align: align(col),
          ruleLeft: cell.col ? col.ruleLeft : first === 1 ? col.ruleLeft : 0,
          ruleRight: cell.col ? col.ruleRight : last.ruleRight,
          width: cell.span === 1 ? cssWidth(col.width) : null,
          top: ruleOver(row.above, first, at - 1),
          bottom: ruleOver(next, first, at - 1),
          parts: parts(base + cell.from, base + cell.to),
          src: text(base + cell.from, base + cell.to),
        };
      }),
    ),
  };
}

/**
 * The parts of [from, to]: the constructs in it (`all`, in document order, nested after their
 * parent) as `leaf` turns them (null: their source as text), a style's content and an overlay's
 * around what it hides as parts, hidden commands left out, the text between as cellText.
 */
export function cellParts(all: readonly LatexConstruct[], text: (from: number, to: number) => string, from: number, to: number, leaf: (c: LatexConstruct) => TablePart | null): TablePart[] {
  const out: TablePart[] = [];
  const push = (p: TablePart) => {
    const last = out[out.length - 1];
    if (p.t === "text" && last?.t === "text") last.s += p.s;
    else if (p.t !== "text" || p.s) out.push(p);
  };
  const plain = (a: number, b: number) => {
    if (b > a) push({ t: "text", s: cellText(text(a, b)) });
  };
  let at = from;
  for (const c of all) {
    if (c.from < at || c.to > to) continue;
    if (c.kind === "env" || c.kind === "center") continue;
    plain(at, c.from);
    if (c.kind === "style") push({ t: "style", style: c.style, parts: cellParts(all, text, c.contentFrom, c.contentTo, leaf) });
    else if (c.kind === "overlay") {
      for (let k = 0; k < c.hide.length - 1; k++) for (const p of cellParts(all, text, c.hide[k].to, c.hide[k + 1].from, leaf)) push(p);
    } else if (c.kind !== "command") {
      const p = leaf(c);
      push(p ?? { t: "text", s: text(c.from, c.to) });
    }
    at = c.to;
  }
  plain(at, to);
  const first = out[0];
  if (first?.t === "text") first.s = first.s.trimStart();
  const last = out[out.length - 1];
  if (last?.t === "text") last.s = last.s.trimEnd();
  return out.filter((p) => p.t !== "text" || p.s);
}

/**
 * Text as a cell shows it: comments go, `\&`, `\%`, ties, dashes and texText's symbols become
 * what they print, braces of a bare group go; any other command stays as written, with its
 * arguments (as live text keeps it).
 */
export function cellText(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === "%") {
      i = commentEnd(s, i);
      continue;
    }
    if (c === "\\") {
      const name = /^\\(?:[A-Za-z]+|.)/s.exec(s.slice(i, i + 40))?.[0] ?? "\\";
      const word = /^\\[A-Za-z]/.test(name);
      let j = i + name.length;
      if (ACCENT.test(name)) {
        // `\"u`, `\"{u}`, `\v s`: texText puts the mark on the next letter.
        j = skip(s, j);
        j = s[j] === "{" ? (groupEnd(s, j) < 0 ? s.length : groupEnd(s, j)) : j + 1;
        out += texText(s.slice(i, j));
        i = j;
        continue;
      }
      const shown = SPACES.has(name) ? " " : texText(name);
      if (shown || !word) {
        out += shown;
        i = j;
        if (word) while (s[i] === " ") i++;
        continue;
      }
      // An unknown command: as written, with its arguments.
      for (;;) {
        const k = skip(s, j);
        if (s[k] === "{") {
          const e = groupEnd(s, k);
          j = e < 0 ? s.length : e;
        } else if (s[k] === "[" && s.indexOf("]", k) > 0) j = s.indexOf("]", k) + 1;
        else break;
      }
      out += s.slice(i, j);
      i = j;
      continue;
    }
    if (c === "~") out += " ";
    else if (s.startsWith("---", i)) {
      out += "—";
      i += 3;
      continue;
    } else if (s.startsWith("--", i)) {
      out += "–";
      i += 2;
      continue;
    } else if (c !== "{" && c !== "}") out += c;
    i++;
  }
  return out.replace(/\s+/g, " ");
}

/** Accents (texText's): the mark goes on the next letter or group. */
const ACCENT = /^\\(?:["'`^~=.]|[uvHckr])$/;
/** What typesets as a space (texText trims it away). */
const SPACES = new Set(["\\ ", "\\,", "\\;", "\\:", "\\\n", "\\\t", "\\quad", "\\qquad", "\\enspace", "\\thinspace"]);

// ---- The node ------------------------------------------------------------------------------

const STYLE_CLASS: Record<TextStyle, string> = { strong: "lsp-lp-strong", em: "lsp-lp-em", u: "lsp-lp-u", tt: "lsp-lp-tt", sc: "lsp-lp-sc" };

/**
 * The table of a spec (`src`: its JSON) in `doc`: `math` renders a formula (it may throw: the
 * cell then shows its source).
 */
export function tableNode(src: string, doc: Document, math: (src: string, display: boolean) => Element): HTMLElement {
  const spec = JSON.parse(src) as TableSpec;
  const table = doc.createElement("table");
  table.className = spec.center ? "ll-table is-center" : "ll-table";
  const body = table.appendChild(doc.createElement("tbody"));
  const fill = (into: Element, parts: readonly TablePart[]) => {
    for (const p of parts) {
      if (p.t === "text") into.appendChild(doc.createTextNode(p.s));
      else if (p.t === "math") into.appendChild(math(p.src, p.display).cloneNode(true));
      else if (p.t === "style") {
        const span = into.appendChild(doc.createElement("span"));
        span.className = STYLE_CLASS[p.style];
        fill(span, p.parts);
      } else {
        const span = into.appendChild(doc.createElement("span"));
        span.className = p.cls;
        span.textContent = p.text;
        if (p.title) span.title = p.title;
      }
    }
  };
  for (const row of spec.rows) {
    const tr = body.appendChild(doc.createElement("tr"));
    for (const c of row) {
      const td = tr.appendChild(doc.createElement("td"));
      if (c.span > 1) td.colSpan = c.span;
      if (c.rowSpan > 1) td.rowSpan = c.rowSpan;
      td.className = [`is-${c.align}`, c.rowSpan > 1 && c.vpos !== "t" && `v-${c.vpos}`, c.top && `top-${c.top}`, c.bottom && `bottom-${c.bottom}`, c.ruleLeft && `left-${Math.min(2, c.ruleLeft)}`, c.ruleRight && `right-${Math.min(2, c.ruleRight)}`].filter(Boolean).join(" ");
      if (c.width) td.style.width = c.width;
      try {
        fill(td, c.parts);
      } catch {
        td.replaceChildren(doc.createTextNode(c.src));
        td.classList.add("is-source");
      }
    }
  }
  return table;
}
