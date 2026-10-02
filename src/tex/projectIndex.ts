import { readFileSync, realpathSync } from "fs";
import { relative, resolve, sep } from "path";
import { isFileInput, lineAt, planExport, type ExportPlan, type PlanFile } from "../export/plan";
import { argText, parseTex, walkTex, type TexNode } from "../export/texTree";
import { projectDefinitions } from "./macros";
import { resolveFileReference, stripComments } from "./project";
import { theoremMap, type TheoremMap } from "./theorems";

export interface ProjectFile {
  path: string;
  /** LF source offsets, identical to CodeMirror and the source plan. */
  text: string;
  /** Original disk copy, including CRLF; retained for stale-preview checks. */
  diskText: string;
  lineEnding: "\n" | "\r\n";
}

export interface ProjectSnapshot {
  root: string;
  files: readonly ProjectFile[];
  plan: ExportPlan;
  theorems: TheoremMap;
  /** Unreadable or dynamic source inputs make global rename unsafe. */
  warnings: readonly string[];
}

export const normalizedText = (text: string): string => text.replace(/\r\n?/g, "\n");

/** An explicit command takes one committed snapshot; typing never runs a project scan. */
export async function readProjectSnapshot(root: string, buffers: ReadonlyMap<string, string>): Promise<ProjectSnapshot> {
  await new Promise<void>((done) => setTimeout(done, 0));
  const canonicalBuffers = new Map([...buffers].map(([path, text]) => [resolve(path), normalizedText(text)]));
  const disks = new Map<string, string>();
  const read = (path: string): string => {
    const abs = resolve(path);
    if (!disks.has(abs)) disks.set(abs, readFileSync(abs, "utf8"));
    return canonicalBuffers.get(abs) ?? disks.get(abs)!;
  };
  const defs = projectDefinitions(root, canonicalBuffers);
  const theorems = theoremMap(defs.files.map(path => { try { return stripComments(read(path)); } catch { return ""; } }));
  const plan = planExport(root, { defs, theorems, read });
  const parsedFiles = new Map(plan.files);
  // Export's sandbox is rootDir, whereas a writing project can input ../shared.tex inside
  // the vault. Build source-only visits with the same AST/signatures/search-path rules.
  // This augmented plan is used only by project tools, never by export instrumentation.
  const used = new Set<string>();
  const warnings: string[] = [];
  const physical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const byPhysical = new Map<string, PlanFile>();
  for (const [path, text] of canonicalBuffers) {
    const actual = physical(path);
    if (!canonicalBuffers.has(actual)) canonicalBuffers.set(actual, text);
  }
  const load = (path: string): PlanFile | null => {
    const actual = physical(path);
    const existing = byPhysical.get(actual);
    if (existing) return existing;
    if (byPhysical.size >= 512) { warnings.push("Project input traversal reached 512 source files."); return null; }
    try {
      const abs = resolve(path);
      const text = canonicalBuffers.get(abs) ?? canonicalBuffers.get(actual) ?? read(abs);
      if (!disks.has(abs)) disks.set(abs, readFileSync(abs, "utf8"));
      const key = relative(plan.rootDir, abs).split(sep).join("/");
      const src = normalizedText(text);
      const parsed = parsedFiles.get(key);
      const lines = parsed?.src === src ? parsed.lines : [0];
      if (parsed?.src !== src) for (let at = src.indexOf("\n"); at >= 0; at = src.indexOf("\n", at + 1)) lines.push(at + 1);
      const file = { key, abs, src, nodes: parsed?.src === src ? parsed.nodes : parseTex(src, plan.sig), lines };
      plan.files.set(key, file); byPhysical.set(actual, file); used.add(abs);
      plan.sourceAliases.set(abs, key); plan.sourceAliases.set(actual, key);
      return file;
    } catch { warnings.push(`Cannot read project input: ${path}`); return null; }
  };
  plan.files.clear(); plan.sourceAliases.clear(); plan.visits.length = 0; plan.inputTargets.clear(); plan.inputKeys.clear(); plan.missing.clear();
  const rootFile = load(root);
  if (!rootFile) throw new Error(`Cannot read project root: ${root}`);
  const document = rootFile.nodes.find(node => node.t === "env" && node.name === "document");
  const rootPreamble = document ? rootFile.nodes.filter(node => node.to <= document.from) : [];
  const hiddenInputs = (file: PlanFile, node: TexNode) => {
    if (node.t === "macro" && node.code && /\\(?:input|include|subfile|subfileinclude|(?:sub)?(?:import|inputfrom|includefrom))(?![A-Za-z])/.test(file.src.slice(node.from, node.to))) warnings.push(`A macro generates project inputs at ${file.abs}:${lineAt(file, node.from)}`);
  };
  const resolveInput = (file: PlanFile, node: TexNode & { t: "macro" }, dirs: readonly string[]) => {
    const name = argText(file.src, node.args.at(-1));
    const directory = /^(?:sub)?(?:import|includefrom|inputfrom)$/.test(node.name) ? argText(file.src, node.args.at(-2)) : null;
    const ref = resolveFileReference(plan.rootDir, node.name, name, directory, dirs, path => {
      try { read(path); return true; } catch { return canonicalBuffers.has(resolve(path)); }
    });
    if (!ref) { warnings.push(`Dynamic or incomplete input at ${file.abs}:${lineAt(file, node.from)}`); return null; }
    return { ref, name };
  };
  const contexts = new Set<string>();
  const preamble = (file: PlanFile, nodes: readonly TexNode[], dirs: readonly string[], depth: number): void => {
    const context = `${physical(file.abs)}|${dirs.join("|")}`;
    if (contexts.has(context)) return;
    contexts.add(context);
    if (depth >= 32) { warnings.push("Project preamble traversal reached its nesting bound."); return; }
    walkTex(nodes, node => {
      hiddenInputs(file, node);
      if (node.t === "verb" || node.t === "math" || (node.t === "macro" && node.code)) return false;
      if (!isFileInput(node)) return;
      const target = resolveInput(file, node, dirs);
      const child = target && load(target.ref.path);
      if (child && target) preamble(child, child.nodes, target.ref.inputDirs, depth + 1);
    });
  };
  preamble(rootFile, rootPreamble, [plan.rootDir], 0);
  const counts = new Map<string, number>();
  const visit = (file: PlanFile, dirs: string[], bodyOnly: boolean, parent: number, parentLine: number, ancestors: ReadonlySet<string>): void => {
    if (plan.visits.length >= 4096 || ancestors.size >= 32) { warnings.push("Project visit traversal reached its safety bound."); return; }
    const context = `${physical(file.abs)}|${dirs.join("|")}`;
    if (ancestors.has(context)) { warnings.push(`Cyclic project input: ${file.abs}`); return; }
    const index = plan.visits.length;
    const occ = counts.get(file.key) ?? 0; counts.set(file.key, occ + 1);
    plan.visits.push({ key: file.key, occ, parent, parentLine, inputDirs: dirs, bodyOnly });
    const doc = bodyOnly && file.nodes.find(node => node.t === "env" && node.name === "document");
    const body = doc && doc.t === "env" ? doc.body : file.nodes;
    walkTex(body, node => {
      hiddenInputs(file, node);
      if (node.t === "verb" || node.t === "math" || (node.t === "macro" && node.code)) return false;
      if (!isFileInput(node)) return;
      const target = resolveInput(file, node, dirs);
      if (!target) return;
      const inclusion = /^(?:include|subfileinclude|(?:sub)?includefrom)$/.test(node.name);
      const key = relative(plan.rootDir, target.ref.path).split(sep).join("/");
      if (inclusion && plan.includeOnly && !plan.includeOnly.includes(target.name) && !plan.includeOnly.includes(key.replace(/\.tex$/, ""))) return;
      const child = load(target.ref.path);
      if (!child) return;
      plan.inputKeys.set(`${index}@${node.from}`, child.key);
      const childVisit = plan.visits.length;
      visit(child, target.ref.inputDirs, target.ref.bodyOnly, index, lineAt(file, node.from), new Set([...ancestors, context]));
      if (plan.visits.length > childVisit) plan.inputTargets.set(`${index}@${node.from}`, childVisit);
    });
  };
  visit(rootFile, [plan.rootDir], true, -1, 0, new Set());
  const files = [...plan.files.values()].filter(file => used.has(file.abs)).map(file => {
    const diskText = disks.get(file.abs) ?? readFileSync(file.abs, "utf8");
    return { path: file.abs, text: normalizedText(file.src), diskText, lineEnding: (/^[^\n]*\r\n/.test(diskText) ? "\r\n" : "\n") as "\n" | "\r\n" };
  });
  return { root: resolve(root), files, plan, theorems, warnings };
}

export function projectBodyFiles(snapshot: ProjectSnapshot): readonly ProjectFile[] {
  const byPath = new Map(snapshot.files.map(file => [file.path, file]));
  return [...new Set(snapshot.plan.visits.map(visit => snapshot.plan.files.get(visit.key)!.abs))].flatMap(path => {
    const file = byPath.get(path);
    return file ? [file] : [];
  });
}
