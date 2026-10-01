import { argText, type TexNode } from "./texTree";

// tabular as an HTML table (design S6): the column spec (l, c, r; p/m/b{width} as top, middle and
// bottom aligned paragraph columns; `|` and `||` rules; `@{}` without padding; `*{n}{..}`
// repeated; `>{..}`/`<{..}` and `!{..}` ignored; siunitx's S centred), rows split at the body's own
// `\\` and cells at its own `&` (never inside a group or a formula), `\multicolumn{n}{spec}{..}`
// spanning, and the rules between rows: `\hline` (two of them double), `\cline{a-b}`, booktabs'
// `\toprule`/`\bottomrule` (heavy), `\midrule`/`\cmidrule(lr){a-b}` (light), `\specialrule`. The
// plan makes the tables HTML cannot draw TeX fragments (multirow, colortbl, hhline, diagbox), and
// tabularx/longtable are unknown environments, so fragments too.

export interface TableColumn {
  align: "l" | "c" | "r" | "p" | "m" | "b";
  /** A paragraph column's width (TeX length). */
  width: string | null;
  /** Vertical rules before and after the column (`|` 1, `||` 2). */
  ruleLeft: number;
  ruleRight: number;
  /** `@{..}` took the padding before or after the column away. */
  noPadLeft: boolean;
  noPadRight: boolean;
}

export type RuleWeight = "thin" | "light" | "heavy" | "double";

/** A rule between rows over columns `from`..`to` (1-based, inclusive). */
export interface TableRule {
  weight: RuleWeight;
  from: number;
  to: number;
}

export interface TableCell {
  nodes: TexNode[];
  /** Columns it spans (`\multicolumn`), and the spec it gives them. */
  span: number;
  spec: TableColumn | null;
}

export interface TableRow {
  cells: TableCell[];
  /** The rules between the previous row and this one. */
  above: TableRule[];
}

export interface TableLayout {
  columns: TableColumn[];
  rows: TableRow[];
  /** The rules after the last row. */
  below: TableRule[];
}

const column = (align: TableColumn["align"], width: string | null = null): TableColumn => ({
  align,
  width,
  ruleLeft: 0,
  ruleRight: 0,
  noPadLeft: false,
  noPadRight: false,
});

/** A column spec (`@{}l|c|p{3cm}*{2}{r}@{}`) as its columns. */
export function tableColumns(spec: string): TableColumn[] {
  const cols: TableColumn[] = [];
  let s = spec;
  let i = 0;
  let rulesBefore = 0;
  let noPadBefore = false;
  /** The next argument: a brace group's content, else one character. */
  const arg = (): string => {
    while (/\s/.test(s[i] ?? "")) i++;
    if (s[i] !== "{") return s[i++] ?? "";
    let depth = 0;
    const start = i;
    for (; i < s.length; i++) {
      if (s[i] === "\\") i++;
      else if (s[i] === "{") depth++;
      else if (s[i] === "}" && --depth === 0) break;
    }
    return s.slice(start + 1, i++);
  };
  const push = (c: TableColumn) => {
    c.ruleLeft = cols.length ? 0 : rulesBefore;
    c.noPadLeft = cols.length ? false : noPadBefore;
    cols.push(c);
  };
  while (i < s.length) {
    const c = s[i++];
    const last = cols[cols.length - 1];
    if (/\s/.test(c)) continue;
    if (c === "|") {
      if (last) last.ruleRight++;
      else rulesBefore++;
    } else if (c === "@" || c === "!") {
      arg();
      if (c === "@") {
        if (last) last.noPadRight = true;
        else noPadBefore = true;
      }
    } else if (c === ">" || c === "<") arg();
    else if (c === "*") {
      const n = Math.min(100, Number(arg().trim()) || 0);
      const body = arg();
      s = s.slice(0, i) + body.repeat(n) + s.slice(i);
    } else if (c === "l" || c === "c" || c === "r") push(column(c));
    else if (c === "p" || c === "m" || c === "b") push(column(c, arg().trim()));
    else if (c === "S") {
      if (s[i] === "[") i = Math.max(i, s.indexOf("]", i) + 1);
      push(column("c"));
    } else if (c === "X") push(column("p"));
    else if (/[A-Za-z]/.test(c)) push(column("l"));
  }
  return cols;
}

/** Rule commands between rows and their weights. */
const RULES = new Map<string, RuleWeight>([
  ["hline", "thin"], ["toprule", "heavy"], ["bottomrule", "heavy"], ["midrule", "light"], ["specialrule", "heavy"], ["cline", "thin"], ["cmidrule", "light"],
]);
/** Commands between rows that draw nothing HTML shows. */
const SPACING = new Set(["addlinespace", "morecmidrules", "noalign", "rule"]);

const blank = (n: TexNode) => n.t === "space" || n.t === "comment" || n.t === "par";

/** A tabular's rows, cells and rules (`src` is the file its nodes come from). */
export function tableLayout(src: string, spec: string, body: readonly TexNode[]): TableLayout {
  const columns = tableColumns(spec);
  const width = Math.max(1, columns.length);
  const rows: TableRow[] = [];
  let row: { cells: TexNode[][]; above: TableRule[] } = { cells: [[]], above: [] };
  const empty = () => row.cells.length === 1 && row.cells[0].every(blank);
  let skipTo = -1;
  for (const x of body) {
    if (x.to <= skipTo) continue;
    if (x.t === "macro" && (x.name === "\\" || x.name === "tabularnewline" || x.name === "cr")) {
      rows.push(cells(src, row));
      row = { cells: [[]], above: [] };
      continue;
    }
    if (x.t === "macro" && (RULES.has(x.name) || SPACING.has(x.name)) && empty()) {
      const weight = RULES.get(x.name);
      if (!weight) continue;
      let from = 1;
      let to = width;
      if (x.name === "cline" || x.name === "cmidrule") {
        // \cline{a-b}; \cmidrule[w](trim){a-b} (its trim and range follow the macro).
        const m = x.name === "cline" ? /^\s*(\d+)\s*-\s*(\d+)/.exec(argText(src, x.args[0])) : /^\s*(?:\[[^\]]*\])?\s*(?:\([^)]*\))?\s*\{\s*(\d+)\s*-\s*(\d+)\s*\}/.exec(src.slice(x.to));
        if (m) {
          from = Number(m[1]);
          to = Number(m[2]);
          if (x.name === "cmidrule") skipTo = x.to + m[0].length;
        }
      }
      const twice = weight === "thin" && row.above.find((r) => r.weight === "thin" && r.from === 1 && r.to === width && from === 1 && to === width);
      if (twice) twice.weight = "double";
      else row.above.push({ weight, from, to });
      continue;
    }
    if (x.t === "text" && x.s.includes("&")) {
      x.s.split("&").forEach((part, k) => {
        if (k > 0) row.cells.push([]);
        if (part) row.cells[row.cells.length - 1].push({ ...x, s: part });
      });
    } else row.cells[row.cells.length - 1].push(x);
  }
  if (!empty()) rows.push(cells(src, row));
  return { columns, rows, below: empty() ? row.above : [] };
}

/** A row's cells, `\multicolumn`s spanning. */
function cells(src: string, row: { cells: TexNode[][]; above: TableRule[] }): TableRow {
  return {
    above: row.above,
    cells: row.cells.map((nodes) => {
      const multi = nodes.find((x) => x.t === "macro" && x.name === "multicolumn");
      if (multi?.t !== "macro") return { nodes, span: 1, spec: null };
      const span = Math.max(1, Number(argText(src, multi.args[0]).trim()) || 1);
      return { nodes: multi.args[2]?.body ?? [], span, spec: tableColumns(argText(src, multi.args[1]))[0] ?? null };
    }),
  };
}

const RULE_ORDER: RuleWeight[] = ["thin", "light", "heavy", "double"];

/** The heaviest of `rules` over columns from..to. */
function ruleOver(rules: readonly TableRule[], from: number, to: number): RuleWeight | null {
  let best: RuleWeight | null = null;
  for (const r of rules) if (r.from <= to && r.to >= from && (!best || RULE_ORDER.indexOf(r.weight) > RULE_ORDER.indexOf(best))) best = r.weight;
  return best;
}

/**
 * The layout as an HTML table: `cell` renders a cell's nodes, `length` a paragraph column's width
 * as CSS (null when it cannot). Rows with nothing in them (a last `\\`) are left out.
 */
export function tableHtml(layout: TableLayout, cell: (nodes: TexNode[]) => string, length: (tex: string) => string | null): string {
  const { columns, rows, below } = layout;
  const widths = columns.map((c) => (c.width ? length(c.width) : null));
  const colgroup = widths.some(Boolean) ? `<colgroup>${widths.map((w) => (w ? `<col style="width:${w}">` : "<col>")).join("")}</colgroup>` : "";
  const shown = rows.filter((r) => r.cells.length > 1 || r.cells[0].nodes.some((x) => !blank(x)) || r.above.length);
  const html = shown.map((r, k) => {
    let col = 1;
    const tds = r.cells.map((c) => {
      const first = columns[col - 1] ?? column("l");
      const lastCol = columns[col + c.span - 2] ?? first;
      const spec = c.spec ?? first;
      const cls: string[] = [];
      cls.push(`llx-${spec.align === "l" || spec.align === "c" || spec.align === "r" ? spec.align : `p llx-v${spec.align}`}`);
      const left = c.spec ? c.spec.ruleLeft : col === 1 ? first.ruleLeft : 0;
      const right = c.spec ? c.spec.ruleRight : lastCol.ruleRight;
      if (left) cls.push(left > 1 ? "llx-vl2" : "llx-vl");
      if (right) cls.push(right > 1 ? "llx-vr2" : "llx-vr");
      if ((c.spec ?? first).noPadLeft) cls.push("llx-npl");
      if ((c.spec ?? lastCol).noPadRight) cls.push("llx-npr");
      const top = ruleOver(r.above, col, col + c.span - 1);
      if (top) cls.push(`llx-rt-${top}`);
      const bottom = k === shown.length - 1 ? ruleOver(below, col, col + c.span - 1) : null;
      if (bottom) cls.push(`llx-rb-${bottom}`);
      col += c.span;
      return `<td${c.span > 1 ? ` colspan="${c.span}"` : ""} class="${cls.join(" ")}">${cell(c.nodes)}</td>`;
    });
    return `<tr>${tds.join("")}</tr>`;
  });
  return `<table class="llx-tabular">${colgroup}<tbody>${html.join("")}</tbody></table>`;
}
