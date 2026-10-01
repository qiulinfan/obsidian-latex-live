import type { AuxLabel } from "./aux";
import { theoremMap, type TheoremDef, type TheoremMap } from "./theorems";
import { texText } from "./texText";
import { isFileInput, lineAt, visitNodes, type ExportPlan, type PlanFile } from "../export/plan";
import { argText, given, parseTex, type TexNode } from "../export/texTree";

type Env = Extract<TexNode, { t: "env" }>;
type Macro = Extract<TexNode, { t: "macro" }>;

export interface TheoremSource {
  file: string;
  key: string;
  visit: number;
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
  line: number;
  nodes: readonly TexNode[];
  /** Owned contained proofs omitted by the statement renderer, including nested/input proofs. */
  excluded?: readonly TheoremSource[];
}
export interface TheoremProof extends TheoremSource { association: "title-ref" | "contained" | "following" }
export interface TheoremNode {
  id: string;
  env: string;
  name: string;
  title: string;
  labels: readonly string[];
  number?: string;
  statement: TheoremSource;
  proofs: readonly TheoremProof[];
}
export interface TheoremEdge { from: string; to: string; key: string; evidence: TheoremSource }
export interface TheoremGraphDiagnostic {
  kind: "duplicate-label" | "unresolved-ref" | "non-theorem-ref" | "unassociated-proof" | "ambiguous-proof" | "incomplete-environment" | "scan-limit";
  message: string;
  source: TheoremSource;
  key?: string;
  targets?: readonly string[];
}
export interface TheoremGraph {
  nodes: ReadonlyMap<string, TheoremNode>;
  byLabel: ReadonlyMap<string, readonly string[]>;
  edges: readonly TheoremEdge[];
  unresolved: readonly TheoremGraphDiagnostic[];
}

interface Context { file: PlanFile; visit: number }
interface MutableNode extends Omit<TheoremNode, "labels" | "proofs"> { labels: string[]; proofs: TheoremProof[] }
interface ProofRecord { source: TheoremSource; env: Env; context: Context; titleKeys: string[]; ancestors: string[]; following: string | null }
interface Scope { preceding: string | null }
const MAX_DEPTH = 64;
const MAX_MATH_DEPTH = 8;
const MAX_NODES = 200_000;
const SETUP = new Set(["par", "smallskip", "medskip", "bigskip", "vspace", "hspace", "noindent", "ignorespaces", "theoremstyle", "setcounter", "addtocounter", "setlength", "addtolength", "label"]);
const NONCOUNTER_TEXT_ENVS = new Set(["center", "flushleft", "flushright", "quote", "quotation", "verse", "small", "footnotesize", "large", "Large", "normalsize"]);
const LABEL_COUNTER_MACROS = new Set(["footnote", "footnotetext", "caption", "captionof", "subcaption"]);
const NON_THEOREM = new Set(["equation", "subequation", "figure", "table", "section", "subsection", "subsubsection", "chapter", "part", "paragraph", "subparagraph", "enumi", "enumii", "enumiii", "enumiv", "footnote", "page", "lstlisting", "algorithm"]);
const ELEGANT_NATIVE: Record<string, string> = { theorem: "Theorem", lemma: "Lemma", proposition: "Proposition", corollary: "Corollary", definition: "Definition", axiom: "Axiom", postulate: "Postulate" };
const LNCS_NATIVE: Record<string, string> = { theorem: "Theorem", lemma: "Lemma", proposition: "Proposition", corollary: "Corollary", definition: "Definition", claim: "Claim", case: "Case", conjecture: "Conjecture", example: "Example", exercise: "Exercise", note: "Note", problem: "Problem", property: "Property", question: "Question", solution: "Solution", remark: "Remark" };

const literalKey = (text: string): string | null => {
  const key = text.trim();
  return key && !/[\\#{}]/.test(key) ? key : null;
};
const lastArgument = (node: Macro) => [...node.args].reverse().find(arg => arg.kind === "m" && given(arg));

/** A source-only proof reference graph. No TeX execution, knowledge-store access, or filesystem reads. */
export function buildTheoremGraph(plan: ExportPlan, theorems: TheoremMap, labels?: ReadonlyMap<string, AuxLabel>): TheoremGraph {
  const nodes = new Map<string, MutableNode>();
  const byLabel = new Map<string, string[]>();
  const edges: TheoremEdge[] = [];
  const unresolved: TheoremGraphDiagnostic[] = [];
  const diagnosticKeys = new Set<string>();
  const proofs: ProofRecord[] = [];
  const proofKeys = new Set<string>();
  const edgeKeys = new Set<string>();
  const root = plan.files.get(plan.rootKey);
  const classNode = root?.nodes.find(n => n.t === "macro" && n.name === "documentclass");
  const className = root && classNode?.t === "macro" ? argText(root.src, classNode.args.find(arg => arg.kind === "m")).replace(/^.*[/\\]/, "").replace(/\.cls$/, "").toLowerCase() : "";
  const native = root && (className === "elegantbook" || className === "llncs") ? theoremMap([root.src]) : new Map<string, TheoremDef>();
  let scanned = 0;

  const source = (context: Context, node: TexNode, body?: readonly TexNode[]): TheoremSource => ({
    file: context.file.abs, key: context.file.key, visit: context.visit, from: node.from, to: node.to,
    bodyFrom: node.t === "env" ? node.bodyFrom : node.from,
    bodyTo: node.t === "env" ? node.bodyTo : node.to,
    line: lineAt(context.file, node.from), nodes: body ?? (node.t === "env" ? node.body : [node]),
  });
  const diagnostic = (kind: TheoremGraphDiagnostic["kind"], message: string, where: TheoremSource, key?: string, targets?: readonly string[]) => {
    const id = `${kind}|${where.key}@${where.from}|${key ?? ""}|${targets?.join("|") ?? ""}`;
    if (diagnosticKeys.has(id)) return;
    diagnosticKeys.add(id);
    unresolved.push({ kind, message, source: where, ...(key ? { key } : {}), ...(targets ? { targets } : {}) });
  };
  // IEEEtran's native optional header is usable only when the supplied plan parsed that
  // interface; otherwise treating its literal bracket text as proof body would invent edges.
  const proofEnv = (name: string) => (name === "proof" && theorems.get(name)?.numbered !== true) ||
    (className === "ieeetran" && name === "IEEEproof" && plan.sig.envs.get(name) === "o");
  const definition = (name: string): TheoremDef | null => {
    const known = theorems.get(name);
    if (known) return known;
    const base = name.replace(/\*$/, "");
    const verified = className === "elegantbook" ? ELEGANT_NATIVE[base] : className === "llncs" ? LNCS_NATIVE[base] : null;
    return verified ? native.get(name) ?? null : null;
  };
  const evidence = (context: Context, from: number, to: number): TheoremSource => ({
    file: context.file.abs, key: context.file.key, visit: context.visit, from, to, bodyFrom: from, bodyTo: to, line: lineAt(context.file, from), nodes: [],
  });

  /** Literal ref calls, including math bodies; declaration and verbatim nodes never execute. */
  const references = (body: readonly TexNode[], text: string, context: Context, base = 0, depth = 0, mathDepth = 0): { key: string; source: TheoremSource }[] => {
    const found: { key: string; source: TheoremSource }[] = [];
    if (depth >= MAX_DEPTH || mathDepth >= MAX_MATH_DEPTH) {
      if (body[0]) diagnostic("scan-limit", "Reference scan reached its nesting bound.", evidence(context, base + body[0].from, base + body.at(-1)!.to));
      return found;
    }
    for (const node of body) {
      if (++scanned > MAX_NODES) { diagnostic("scan-limit", "Source graph reached its scan bound.", evidence(context, base + node.from, base + node.to)); break; }
      if (node.t === "comment" || node.t === "verb" || (node.t === "macro" && node.code)) continue;
      if (isFileInput(node)) {
        const target = plan.inputTargets.get(`${context.visit}@${base + node.from}`);
        const visit = target !== undefined ? plan.visits[target] : null;
        const child = visit && plan.files.get(visit.key);
        if (target !== undefined && child) found.push(...references(visitNodes(plan, target), child.src, { file: child, visit: target }, 0, depth + 1, mathDepth));
        continue;
      }
      if (node.t === "macro" && node.name === "ref") {
        const raw = argText(text, lastArgument(node));
        const key = literalKey(raw);
        const where = evidence(context, base + node.from, base + node.to);
        if (key) found.push({ key, source: where });
        else diagnostic("unresolved-ref", "A dynamic or incomplete reference key is not indexed.", where, raw);
        continue;
      }
      if (node.t === "math") {
        const inner = text.slice(node.srcFrom, node.srcTo);
        found.push(...references(parseTex(inner, plan.sig), inner, context, base + node.srcFrom, depth + 1, mathDepth + 1));
      } else if (node.t === "env") {
        if (!proofEnv(node.name)) found.push(...references(node.body, text, context, base, depth + 1, mathDepth));
      } else if (node.t === "group") found.push(...references(node.body, text, context, base, depth + 1, mathDepth));
      else if (node.t === "macro") for (const arg of node.args) if (arg.body) found.push(...references(arg.body, text, context, base, depth + 1, mathDepth));
    }
    return found;
  };

  /** Statement-owned direct labels, never nested math/float/proof/theorem labels. */
  const statementLabels = (env: Env, def: TheoremDef, file: PlanFile): string[] => {
    const found: string[] = [];
    const add = (raw: string) => { const key = literalKey(raw); if (key && !NON_THEOREM.has(labels?.get(key)?.kind ?? "") && !found.includes(key)) found.push(key); };
    if (def.spec === "tcb") {
      const marker = env.args.find(arg => arg.kind === "t");
      const last = env.args.at(-1);
      if (last?.kind === "g" && given(last)) {
        const key = argText(file.src, last);
        add(marker && given(marker) ? key : `${def.prefix ?? env.name}:${key}`);
      }
    }
    return found;
  };
  const title = (env: Env, def: TheoremDef, file: PlanFile) => {
    const arg = def.spec === "tcb" || def.spec === "tcb*" ? env.args.find(a => (a.kind === "g" || a.kind === "o") && given(a)) : env.args.find(a => (def.spec === "o" ? a.kind === "o" : def.spec === "m" && a.kind === "m") && given(a));
    return arg ? argText(file.src, arg).trim() : "";
  };

  const walk = (body: readonly TexNode[], context: Context, scope: Scope, ancestors: readonly string[], depth: number, labelOwner: string | null = null): void => {
    if (depth >= MAX_DEPTH) { if (body[0]) diagnostic("scan-limit", "Source traversal reached its nesting bound.", source(context, body[0])); return; }
    for (const item of body) {
      if (++scanned > MAX_NODES) { diagnostic("scan-limit", "Source graph reached its scan bound.", source(context, item)); break; }
      if (item.t === "space" || item.t === "par" || item.t === "comment" || (item.t === "macro" && item.code)) continue;
      if (isFileInput(item)) {
        const target = plan.inputTargets.get(`${context.visit}@${item.from}`);
        const visit = target !== undefined ? plan.visits[target] : null;
        const child = visit && plan.files.get(visit.key);
        if (target !== undefined && child) walk(visitNodes(plan, target), { file: child, visit: target }, scope, ancestors, depth + 1, labelOwner);
        else {
          const excluded = plan.includeOnly !== null && /^(?:include|subfileinclude|(?:sub)?includefrom)$/.test(item.name) && !plan.inputKeys.has(`${context.visit}@${item.from}`);
          if (!excluded) scope.preceding = null;
        }
        continue;
      }
      if (item.t === "env") {
        if (!item.closed) {
          if (proofEnv(item.name) || definition(item.name)) diagnostic("incomplete-environment", "An unclosed environment is not indexed as a complete statement or proof.", source(context, item));
          scope.preceding = null;
          continue;
        }
        if (proofEnv(item.name)) {
          const optional = item.args.find(arg => arg.kind === "o" && given(arg));
          const titleKeys = optional?.body ? [...new Set(references(optional.body, context.file.src, context).map(ref => ref.key))] : [];
          const proofSource = source(context, item);
          const identity = `${context.file.key}@${item.from}|${context.visit}`;
          if (!proofKeys.has(identity)) { proofKeys.add(identity); proofs.push({ source: proofSource, env: item, context, titleKeys, ancestors: [...ancestors], following: scope.preceding }); }
          walk(item.body, context, { preceding: null }, ancestors, depth + 1);
          scope.preceding = null;
          continue;
        }
        const def = definition(item.name);
        if (def) {
          const id = `${context.file.key}@${item.from}`;
          let node = nodes.get(id);
          if (!node) { node = { id, env: item.name, name: def.name, title: title(item, def, context.file), labels: statementLabels(item, def, context.file), statement: source(context, item), proofs: [] }; nodes.set(id, node); }
          walk(item.body, context, { preceding: null }, [...ancestors, id], depth + 1, id);
          scope.preceding = id;
        } else { walk(item.body, context, { preceding: null }, ancestors, depth + 1, NONCOUNTER_TEXT_ENVS.has(item.name) ? labelOwner : null); scope.preceding = null; }
        continue;
      }
      if (item.t === "macro" && item.name === "label" && labelOwner) {
        const key = literalKey(argText(context.file.src, lastArgument(item)));
        const owner = nodes.get(labelOwner);
        if (key && owner && !NON_THEOREM.has(labels?.get(key)?.kind ?? "") && !owner.labels.includes(key)) owner.labels.push(key);
      }
      if (item.t === "macro" && SETUP.has(item.name)) continue;
      if (item.t === "group") walk(item.body, context, { preceding: null }, ancestors, depth + 1, labelOwner);
      else if (item.t === "macro") for (const arg of item.args) if (arg.body) walk(arg.body, context, { preceding: null }, ancestors, depth + 1, LABEL_COUNTER_MACROS.has(item.name) ? null : labelOwner);
      scope.preceding = null;
    }
  };
  if (root) walk(visitNodes(plan, 0), { file: root, visit: 0 }, { preceding: null }, [], 0);
  for (const node of nodes.values()) for (const key of node.labels) {
    const candidates = byLabel.get(key) ?? [];
    if (!candidates.includes(node.id)) candidates.push(node.id);
    byLabel.set(key, candidates);
  }
  for (const [key, candidates] of byLabel) if (candidates.length > 1) diagnostic("duplicate-label", "This label belongs to different source statements; no target is selected.", nodes.get(candidates[0])!.statement, key, candidates);
  for (const node of nodes.values()) {
    const key = node.labels.find(key => byLabel.get(key)?.length === 1 && labels?.has(key));
    if (key) node.number = texText(labels!.get(key)!.number) || labels!.get(key)!.number;
  }

  for (const proof of proofs) {
    let owner: string | null = null;
    let association: TheoremProof["association"] = "following";
    if (proof.titleKeys.length) {
      const candidates = proof.titleKeys.flatMap(key => byLabel.get(key) ?? []);
      const unique = [...new Set(candidates)];
      if (proof.titleKeys.length === 1 && candidates.length === 1) { owner = unique[0]; association = "title-ref"; }
      else { diagnostic("ambiguous-proof", "The proof title does not identify one unique source statement.", proof.source, proof.titleKeys.join(","), unique); continue; }
    } else if (proof.ancestors.length) { owner = proof.ancestors.at(-1)!; association = "contained"; }
    else owner = proof.following;
    const node = owner && nodes.get(owner);
    if (!node) { diagnostic("unassociated-proof", "This proof has no explicit, contained, or immediately preceding statement association.", proof.source); continue; }
    const duplicate = node.proofs.some(other => other.key === proof.source.key && other.from === proof.source.from);
    if (!duplicate) node.proofs.push({ ...proof.source, association });
    if (proof.ancestors.includes(node.id)) {
      const excluded = [...node.statement.excluded ?? []];
      if (!excluded.some(item => item.key === proof.source.key && item.visit === proof.source.visit && item.from === proof.source.from)) excluded.push(proof.source);
      node.statement.excluded = excluded;
      node.statement.nodes = node.statement.nodes.filter(item => !(proof.source.key === node.statement.key && proof.source.visit === node.statement.visit && item.from === proof.source.from && item.to === proof.source.to));
    }
    for (const ref of references(proof.env.body, proof.context.file.src, proof.context)) {
      const targets = byLabel.get(ref.key) ?? [];
      if (targets.length !== 1) {
        diagnostic(targets.length > 1 ? "duplicate-label" : NON_THEOREM.has(labels?.get(ref.key)?.kind ?? "") ? "non-theorem-ref" : "unresolved-ref", targets.length > 1 ? "A proof reference has multiple source targets." : "The proof reference has no unique indexed theorem target.", ref.source, ref.key, targets);
        continue;
      }
      const id = `${node.id}|${targets[0]}|${ref.key}|${ref.source.key}@${ref.source.from}`;
      if (!edgeKeys.has(id)) { edgeKeys.add(id); edges.push({ from: node.id, to: targets[0], key: ref.key, evidence: ref.source }); }
    }
  }
  return { nodes, byLabel, edges, unresolved };
}
