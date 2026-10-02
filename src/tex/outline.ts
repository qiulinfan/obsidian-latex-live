import { isFileInput, lineAt, visitNodes, type ExportPlan } from "../export/plan";
import { argText, given, type TexNode } from "../export/texTree";
import { texText } from "./texText";

export const SECTION_LEVELS: Readonly<Record<string, number>> = {
  part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6,
};

/** A heading at its actual visit in the input flow (one source may be included twice). */
export interface OutlineHeading {
  id: string;
  title: string;
  command: string;
  level: number;
  starred: boolean;
  file: string;
  key: string;
  visit: number;
  from: number;
  to: number;
  line: number;
  column: number;
  children: OutlineHeading[];
}

export interface ProjectOutline {
  root: string;
  headings: OutlineHeading[];
  count: number;
  truncated: boolean;
}

/** Standard headings only: no execution of user macros or title arguments. */
export function headingOf(src: string, node: TexNode): { title: string; level: number; starred: boolean } | null {
  if (node.t !== "macro" || node.code || SECTION_LEVELS[node.name] === undefined) return null;
  const arg = node.args.find((a) => a.kind === "m" && given(a));
  if (!arg || src[arg.from] !== "{" || src[arg.to - 1] !== "}") return null;
  const title = texText(argText(src, arg)).replace(/\s+/g, " ").trim();
  return { title: title || "(Untitled)", level: SECTION_LEVELS[node.name], starred: given(node.args.find((a) => a.kind === "s")) };
}

/**
 * Read an already prepared project snapshot. Follow the planner's exact input targets at
 * their source positions, not its file list: a chapter in an input belongs under the most
 * recent root heading, and two imports of a source remain two outline entries.
 */
export function buildProjectOutline(plan: ExportPlan, limit = 5000): ProjectOutline {
  const result: ProjectOutline = { root: plan.root, headings: [], count: 0, truncated: false };
  const stack: OutlineHeading[] = [];
  const visiting = new Set<number>();
  const walkVisit = (visit: number) => {
    if (visiting.has(visit) || visiting.size >= 40 || result.truncated) return;
    const context = plan.visits[visit];
    const file = context && plan.files.get(context.key);
    if (!file) return;
    visiting.add(visit);
    const walk = (nodes: readonly TexNode[]) => {
      for (const node of nodes) {
        if (result.truncated) break;
        if (node.t === "comment" || node.t === "math" || node.t === "verb" || (node.t === "macro" && node.code)) continue;
        if (isFileInput(node)) {
          const child = plan.inputTargets.get(`${visit}@${node.from}`);
          if (child !== undefined) walkVisit(child);
          continue;
        }
        const heading = headingOf(file.src, node);
        if (heading && node.t === "macro") {
          if (result.count >= limit) { result.truncated = true; break; }
          const line = lineAt(file, node.from);
          const entry: OutlineHeading = {
            id: `${visit}@${node.from}`, ...heading, command: node.name, file: file.abs, key: file.key,
            visit, from: node.from, to: node.to, line, column: node.from - file.lines[line - 1], children: [],
          };
          while (stack.length && stack[stack.length - 1].level >= entry.level) stack.pop();
          (stack.length ? stack[stack.length - 1].children : result.headings).push(entry);
          stack.push(entry);
          result.count++;
          continue;
        }
        if (node.t === "group" || node.t === "env") walk(node.body);
        else if (node.t === "macro") for (const arg of node.args) if (arg.body) walk(arg.body);
      }
    };
    walk(visitNodes(plan, visit));
    visiting.delete(visit);
  };
  walkVisit(0);
  return result;
}

export interface SemanticFold {
  /** The source line on which the fold marker belongs. */
  anchor: number;
  from: number;
  to: number;
  kind: "section" | "environment" | "proof";
  name: string;
}

/** Offset exact semantic folds, used only by the editor's idle/manual index rebuild. */
export function semanticFolds(src: string, nodes: readonly TexNode[]): SemanticFold[] {
  const starts = [0];
  for (let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i + 1)) starts.push(i + 1);
  const lineIndex = (offset: number) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= offset) lo = mid; else hi = mid - 1; }
    return lo;
  };
  const lineEnd = (offset: number) => { const end = src.indexOf("\n", offset); return end < 0 ? src.length : end; };
  const headings: { node: TexNode; level: number; end: number }[] = [];
  const out: SemanticFold[] = [];
  const add = (anchor: number, headerEnd: number, bodyEnd: number, kind: SemanticFold["kind"], name: string) => {
    const from = lineEnd(headerEnd);
    const endLine = lineIndex(bodyEnd);
    const to = bodyEnd === src.length ? src.length : Math.max(0, starts[endLine] - 1);
    if (to > from && lineIndex(to) > lineIndex(from)) out.push({ anchor: starts[lineIndex(anchor)], from, to, kind, name });
  };
  const walk = (list: readonly TexNode[], boundary: number) => {
    for (const node of list) {
      if (node.t === "comment" || (node.t === "macro" && node.code)) continue;
      const heading = headingOf(src, node);
      if (heading) { headings.push({ node, level: heading.level, end: boundary }); continue; }
      if (node.t === "env") {
        if (node.closed) add(node.from, node.bodyFrom, node.bodyTo, node.name === "proof" ? "proof" : "environment", node.name);
        walk(node.body, node.bodyTo);
      } else if (node.t === "math" && node.env) {
        // Math environment bodies are intentionally opaque to the heading scanner.
        if (/\\end\s*\{/.test(src.slice(node.srcTo, node.to))) add(node.from, node.srcFrom, node.srcTo, "environment", node.env);
      } else if (node.t === "verb" && node.env) {
        if (/\\end\s*\{/.test(src.slice(node.textTo, node.to))) add(node.from, node.textFrom, node.textTo, "environment", node.env);
      } else if (node.t === "group") walk(node.body, boundary);
      else if (node.t === "macro") for (const arg of node.args) if (arg.body) walk(arg.body, boundary);
    }
  };
  walk(nodes, src.length);
  for (let i = 0; i < headings.length; i++) {
    const current = headings[i];
    let end = current.end;
    for (let j = i + 1; j < headings.length && headings[j].node.from < end; j++) {
      if (headings[j].level <= current.level) { end = headings[j].node.from; break; }
    }
    const node = current.node;
    add(node.from, Math.max(node.from, node.to - 1), end, "section", node.t === "macro" ? node.name : "section");
  }
  return out.sort((a, b) => a.anchor - b.anchor || b.to - a.to);
}
