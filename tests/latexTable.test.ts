// The tabular parser of the live editor's tables (latexTable.ts, latexLive #23): column specs,
// row and cell splitting, rules, \multicolumn and \multirow, longtable's parts, the sources it gives up on, cell
// text and the table node.
import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@codemirror/state";
import { cellParts, cellText, parseTabular, tableNode, tableSpec, type TabularLayout } from "../src/editor/latexTable";
import { scanLatex } from "../src/editor/latexScan";

/** Each row's cells as their source text. */
const cells = (src: string, t: TabularLayout | null) => t?.rows.map((r) => r.cells.map((c) => src.slice(c.from, c.to)));

test("column specs: *{n}{..}, @{}, | and paragraph columns", () => {
  const src = "\\begin{tabular}{@{}|l*{2}{c}|p{3cm}@{\\quad}r||@{}}\na & b & c & d & e\n\\end{tabular}";
  const t = parseTabular(src)!;
  assert.deepEqual(t.columns.map((c) => c.align), ["l", "c", "c", "p", "r"]);
  assert.equal(t.columns[0].ruleLeft, 1);
  assert.equal(t.columns[2].ruleRight, 1);
  assert.equal(t.columns[3].width, "3cm");
  assert.equal(t.columns[4].ruleRight, 2);
  assert.deepEqual(cells(src, t), [["a", "b", "c", "d", "e"]]);
});

test("tabular* and tabularx skip their width; X is a paragraph column", () => {
  const star = "\\begin{tabular*}{\\textwidth}{l@{\\extracolsep{\\fill}}r}\nx & y\\\\\n\\end{tabular*}";
  assert.deepEqual(cells(star, parseTabular(star)), [["x", "y"]]);
  const x = "\\begin{tabularx}{0.8\\linewidth}[t]{lX}\nx & a long cell\n\\end{tabularx}";
  const t = parseTabular(x)!;
  assert.deepEqual(t.columns.map((c) => c.align), ["l", "p"]);
  assert.deepEqual(cells(x, t), [["x", "a long cell"]]);
});

test("rows and cells split at the body's own \\\\ and &", () => {
  const src = [
    "\\begin{tabular}{ll}",
    "\\DeckLabel{Supervisors:} & PD Dr. A\\\\[3pt]",
    "& Prof. B \\& C\\\\*",
    "{a & b} & $x & y$ % a & comment",
    "\\\\ $$p&q$$ & \\(r & s\\)",
    "\\end{tabular}",
  ].join("\n");
  assert.deepEqual(cells(src, parseTabular(src)), [
    ["\\DeckLabel{Supervisors:}", "PD Dr. A"],
    ["", "Prof. B \\& C"],
    ["{a & b}", "$x & y$ % a & comment"],
    ["$$p&q$$", "\\(r & s\\)"],
  ]);
});

test("an inner environment's & and \\\\ stay in its cell", () => {
  const src = "\\begin{tabular}{lp{4cm}}\na & \\begin{minipage}{3cm}x \\\\ y & z\\end{minipage}\\\\\n\\end{tabular}";
  assert.deepEqual(cells(src, parseTabular(src)), [["a", "\\begin{minipage}{3cm}x \\\\ y & z\\end{minipage}"]]);
});

test("rules: \\hline (twice: double), booktabs, \\cline and \\cmidrule over their columns", () => {
  const src = [
    "\\begin{tabular}{ccc}\\toprule",
    "a & b & c \\\\ \\midrule",
    "d & e & f \\\\ \\hline\\hline \\cline{2-3}",
    "g & h & i \\\\ \\cmidrule(lr){1-2}\\addlinespace[2pt]",
    "j & k & l \\\\",
    "\\bottomrule",
    "\\end{tabular}",
  ].join("\n");
  const t = parseTabular(src)!;
  assert.deepEqual(t.rows.map((r) => r.above), [
    [{ weight: "heavy", from: 1, to: 3 }],
    [{ weight: "light", from: 1, to: 3 }],
    [{ weight: "double", from: 1, to: 3 }, { weight: "thin", from: 2, to: 3 }],
    [{ weight: "light", from: 1, to: 2 }],
  ]);
  assert.deepEqual(t.below, [{ weight: "heavy", from: 1, to: 3 }]);
  assert.deepEqual(cells(src, t), [["a", "b", "c"], ["d", "e", "f"], ["g", "h", "i"], ["j", "k", "l"]]);
});

test("\\multicolumn spans with its own spec; \\multirow spans its rows and takes the empty cells it covers", () => {
  const src = "\\begin{tabular}{|l|c|r|}\n\\multicolumn{2}{|c|}{\\textbf{Head}} & \\multirow[t]{2}{*}[1ex]{tall} \\\\\nx & y & \\\\\n\\end{tabular}";
  const t = parseTabular(src)!;
  const [head] = t.rows;
  assert.equal(head.cells[0].span, 2);
  assert.equal(head.cells[0].col?.align, "c");
  assert.equal(head.cells[0].col?.ruleLeft, 1);
  assert.deepEqual(cells(src, t), [["\\textbf{Head}", "tall"], ["x", "y"]]);
  assert.deepEqual(head.cells.map((c) => [c.column, c.rowSpan, c.vpos]), [[1, 1, "c"], [3, 2, "t"]]);
  const spec = tableSpec(t, 0, (a, b) => src.slice(a, b), (a, b) => [{ t: "text", s: src.slice(a, b) }], false);
  assert.deepEqual(spec.rows[0].map((c) => [c.span, c.rowSpan, c.align, c.ruleLeft, c.ruleRight]), [[2, 1, "c", 1, 1], [1, 2, "r", 0, 1]]);
  assert.deepEqual(spec.rows[1].map((c) => [c.align, c.ruleLeft, c.ruleRight]), [["l", 1, 1], ["c", 0, 1]]);
});

test("a negative \\multirow spans the rows above it; the rule under a spanned cell is the one after its last row", () => {
  const src = [
    "\\begin{tabular}{lll}\\toprule",
    "& a & 1 \\\\ \\cmidrule{2-3}",
    "& b & 2 \\\\",
    "\\multirow{-3}{*}{G} & c & 3 \\\\ \\midrule",
    "H & d & 4 \\\\ \\bottomrule",
    "\\end{tabular}",
  ].join("\n");
  const t = parseTabular(src)!;
  assert.deepEqual(cells(src, t), [["G", "a", "1"], ["b", "2"], ["c", "3"], ["H", "d", "4"]]);
  const spec = tableSpec(t, 0, (a, b) => src.slice(a, b), (a, b) => [{ t: "text", s: src.slice(a, b) }], false);
  assert.deepEqual(spec.rows[0].map((c) => [c.rowSpan, c.top, c.bottom]), [[3, "heavy", "light"], [1, "heavy", "light"], [1, "heavy", "light"]]);
  assert.deepEqual(spec.rows[1].map((c) => [c.top, c.bottom]), [["light", null], ["light", null]]);
  const node = tableNode(JSON.stringify(spec), document, () => document.createElement("mjx-container"));
  const first = node.querySelector("td")!;
  assert.equal(first.rowSpan, 3);
  assert.match(first.className, /\bv-c\b/);
  assert.deepEqual([...node.querySelectorAll("tr")].map((tr) => tr.children.length), [3, 2, 2, 3]);
});

test("rows that do not fit the columns keep the source", () => {
  for (const src of [
    "\\begin{tabular}{ll}\na & b & c\n\\end{tabular}",
    "\\begin{tabular}{ll}\n\\multicolumn{2}{c}{a} & b\n\\end{tabular}",
    "\\begin{tabular}{ll}\n\\multirow{3}{*}{a} & b \\\\\n & c\n\\end{tabular}",
    "\\begin{tabular}{ll}\n\\multirow{2}{*}{a} & b \\\\\nx & c\n\\end{tabular}",
    "\\begin{tabular}{ll}\na & b \\\\\n\\multirow{-3}{*}{x} & c\n\\end{tabular}",
    "\\begin{tabular}{lll}\n\\multirow{2}{*}{a} & b & c \\\\\n\\multicolumn{2}{c}{} & d\n\\end{tabular}",
  ]) assert.equal(parseTabular(src), null, src);
});

test("a longtable shows its first head once, its body and its last foot; \\kill rows go, a \\caption row spans", () => {
  const src = [
    "\\begin{longtable}[c]{lr}",
    "\\caption{Results}\\label{tab:r}\\\\",
    "\\toprule A & B \\\\ \\midrule",
    "\\endfirsthead",
    "\\toprule A (cont.) & B \\\\ \\midrule",
    "\\endhead",
    "\\midrule \\multicolumn{2}{r}{continued} \\\\",
    "\\endfoot",
    "\\bottomrule",
    "\\endlastfoot",
    "wide entry & 000 \\kill",
    "x & 1 \\\\",
    "y & 2 \\\\",
    "\\end{longtable}",
  ].join("\n");
  const t = parseTabular(src)!;
  assert.deepEqual(cells(src, t), [["Results"], ["A", "B"], ["x", "1"], ["y", "2"]]);
  assert.deepEqual([t.rows[0].cells[0].span, t.rows[0].cells[0].col?.align], [2, "c"]);
  assert.deepEqual(t.rows[2].above.map((r) => r.weight), ["light"]);
  assert.deepEqual(t.below.map((r) => r.weight), ["heavy"]);
  const plain = "\\begin{longtable}{ll}\nA & B \\\\\n\\endhead\na & b\n\\end{longtable}";
  assert.deepEqual(cells(plain, parseTabular(plain)), [["A", "B"], ["a", "b"]]);
});

test("the parse gives up: unbalanced braces or $, a tabular inside, an open environment, no \\end", () => {
  for (const src of [
    "\\begin{tabular}{ll}\na & {b\n\\end{tabular}",
    "\\begin{tabular}{ll}\na & b}\n\\end{tabular}",
    "\\begin{tabular}{ll}\na & $b\n\\end{tabular}",
    "\\begin{tabular}{ll}\na & \\begin{tabular}{l}x\\end{tabular}\n\\end{tabular}",
    "\\begin{tabular}{ll}\na & \\begin{minipage}{1cm}x\n\\end{tabular}",
    "\\begin{tabular}{ll}\na & b\n",
    "\\begin{tabular}{}\na\n\\end{tabular}",
    "\\begin{tabular}\na\n\\end{tabular}",
  ]) assert.equal(parseTabular(src), null, src);
});

test("cell text: escapes, symbols and dashes print; unknown commands stay as written", () => {
  assert.equal(cellText("A \\& B~--~C \\% \\ldots{} 1---2"), "A & B – C % … 1—2");
  assert.equal(cellText("M{\\\"u}ller \\\"o \\DeckLabel{Supervisors:}\\quad x % note"), "Müller ö \\DeckLabel{Supervisors:} x ");
  assert.equal(cellText("{\\small x}"), "\\small x");
});

test("cell parts: formulas, styles, chips, hidden commands and the source of the rest", () => {
  const src = "\\begin{tabular}{ll}\n\\textbf{Rate $k$} & see \\ref{eq:a}\\vspace{2pt} \\\\\n\\item x & y\n\\end{tabular}";
  const doc = Text.of(src.split("\n"));
  const all = scanLatex(doc);
  const t = parseTabular(src)!;
  const text = (a: number, b: number) => doc.sliceString(a, b);
  const leaf = (c: (typeof all)[number]) => (c.kind === "math" ? { t: "math" as const, src: c.src, display: c.display } : c.kind === "ref" ? { t: "chip" as const, text: "1", cls: "lsp-lp-chip is-ref", title: "" } : null);
  const parts = t.rows.map((r) => r.cells.map((c) => cellParts(all, text, c.from, c.to, leaf)));
  assert.deepEqual(parts[0], [
    [{ t: "style", style: "strong", parts: [{ t: "text", s: "Rate " }, { t: "math", src: "k", display: false }] }],
    [{ t: "text", s: "see " }, { t: "chip", text: "1", cls: "lsp-lp-chip is-ref", title: "" }],
  ]);
  assert.deepEqual(parts[1][0], [{ t: "text", s: "\\item x" }]);
});

test("the node: rules and alignment as classes; a cell whose formula throws shows its source", () => {
  const src = "\\begin{tabular}{|lc}\\hline\na & $\\bad$ \\\\\\hline\n\\multicolumn{2}{r}{z}\n\\end{tabular}";
  const t = parseTabular(src)!;
  const spec = tableSpec(t, 0, (a, b) => src.slice(a, b), (a, b) => {
    const s = src.slice(a, b);
    return s.startsWith("$") ? [{ t: "math", src: s.slice(1, -1), display: false }] : [{ t: "text", s }];
  }, true);
  const node = tableNode(JSON.stringify(spec), document, (m) => {
    if (m === "\\bad") throw new Error("Undefined control sequence \\bad");
    return document.createElement("mjx-container");
  });
  assert.equal(node.className, "ll-table is-center");
  const tds = [...node.querySelectorAll("td")];
  assert.deepEqual(tds.map((td) => td.className), ["is-l top-thin bottom-thin left-1", "is-c top-thin bottom-thin is-source", "is-r top-thin"]);
  assert.deepEqual(tds.map((td) => td.textContent), ["a", "$\\bad$", "z"]);
  assert.equal(tds[2].colSpan, 2);
});
