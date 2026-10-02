import { parseTex, type Signatures, type TexNode } from "../export/texTree";
import { projectSignatures } from "../export/signatures";
import { emptyDefinitions } from "./macros";
import { theoremMap } from "./theorems";

export interface ProseWord { text: string; from: number; to: number; }
const TEXT_ARGUMENTS = new Set(["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph", "textbf", "textit", "textrm", "textsf", "texttt", "textsc", "textnormal", "emph", "underline", "mbox", "footnote", "footnotetext", "caption", "title", "author", "thanks", "enquote"]);
const CODE_ENVS = new Set(["tikzpicture", "tikzcd", "pgfpicture", "circuitikz", "forest", "algorithmic", "algorithmicx", "thebibliography"]);
/** Source prose only; commands are not executed. No work happens on editor keystrokes. */
export function proseWords(src: string, signatures?: Signatures, nodes?: readonly TexNode[]): ProseWord[] {
  const sig = signatures ?? projectSignatures(emptyDefinitions(), [src], theoremMap([src]));
  const tree = nodes ?? parseTex(src, sig);
  const document = tree.find((n): n is TexNode & { t: "env" } => n.t === "env" && n.name === "document");
  const out: ProseWord[] = [];
  const text = (n: TexNode & { t: "text" }) => {
    for (const m of n.s.matchAll(/\p{Script=Han}|(?:(?!\p{Script=Han})[\p{L}\p{M}])+(?:['’-](?:(?!\p{Script=Han})[\p{L}\p{M}])+)*/gu)) {
      const from = n.from + m.index; out.push({ text: m[0], from, to: from + m[0].length });
    }
  };
  const visit = (children: readonly TexNode[]) => {
    for (const node of children) {
      if (node.t === "text") text(node);
      else if (node.t === "group") visit(node.body);
      else if (node.t === "env" && !CODE_ENVS.has(node.name)) visit(node.body);
      else if (node.t === "macro" && !node.code) {
        if (TEXT_ARGUMENTS.has(node.name)) {
          const body = node.args.filter(a => a.kind === "m" || a.kind === "g").at(-1)?.body;
          if (body) visit(body);
        } else if (node.name === "href") {
          const body = node.args.at(-1)?.body; if (body) visit(body);
        }
      }
    }
  };
  visit(document?.body ?? tree);
  return out;
}
export function countProse(words: readonly ProseWord[]): { words: number; hanCharacters: number } {
  const hanCharacters = words.filter(w => /^\p{Script=Han}$/u.test(w.text)).length;
  return { words: words.length - hanCharacters, hanCharacters };
}

/** Rectangular spreadsheet text, including quoted cells/newlines, without executing HTML. */
export function parseDelimitedTable(text: string): string[][] | null {
  if (text.length > 1_000_000) throw new Error("Table is too large (maximum 1 MB).");
  const delimiter = text.includes("\t") ? "\t" : ",";
  if (!text.trim()) return null;
  if (!text.includes(delimiter) && !/[\r\n]/.test(text)) return null;
  const rows: string[][] = [], row: string[] = [];
  let field = "", quoted = false, atStart = true;
  const cell = () => { row.push(field); field = ""; atStart = true; };
  const end = () => { cell(); rows.push(row.splice(0)); };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"' && atStart) { quoted = true; atStart = false; }
    else if (c === delimiter) cell();
    else if (c === "\r" || c === "\n") { if (c === "\r" && text[i + 1] === "\n") i++; end(); }
    else { field += c; atStart = false; }
  }
  if (quoted) throw new Error("Unclosed quoted table cell.");
  if (field || row.length) end();
  while (rows.length && rows.at(-1)!.every(c => !c)) rows.pop();
  if (!rows.length || !rows[0].length || rows.some(r => r.length !== rows[0].length)) return null;
  if (rows.length * rows[0].length > 2000) throw new Error("Table is too large (maximum 2,000 cells).");
  return rows;
}
export function tableLatex(rows: readonly (readonly string[])[], booktabs: boolean): string {
  if (!rows.length || !rows[0].length || rows.some(r => r.length !== rows[0].length)) throw new Error("A rectangular table is required.");
  const specials: Record<string, string> = { "\\": "\\textbackslash{}", "&": "\\&", "%": "\\%", "$": "\\$", "#": "\\#", "_": "\\_", "{": "\\{", "}": "\\}", "~": "\\textasciitilde{}", "^": "\\textasciicircum{}" };
  const escape = (s: string) => s.replace(/[\\&%$#_{}~^]/g, c => specials[c]).replace(/\r?\n/g, " ");
  const body = rows.map(r => `  ${r.map(escape).join(" & ")} \\\\`);
  if (booktabs && rows.length > 1) body.splice(1, 0, "  \\midrule");
  return `\\begin{tabular}{${"l".repeat(rows[0].length)}}\n${booktabs ? "  \\toprule\n" : ""}${body.join("\n")}\n${booktabs ? "  \\bottomrule\n" : ""}\\end{tabular}`;
}
