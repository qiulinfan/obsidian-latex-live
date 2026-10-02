import { isFileInput } from "../export/plan";
import { argText, parseTex, type TexArg, type TexNode } from "../export/texTree";
import { normalizedText, type ProjectSnapshot } from "./projectIndex";

export interface ProjectMatch { path: string; from: number; to: number; line: number; column: number; context: string; text: string }
export interface SearchOptions { caseSensitive?: boolean; wholeWord?: boolean }
export interface TextEdit { from: number; to: number; insert: string }
export interface FileEdit { path: string; before: string; after: string; diskBefore: string; lineEnding: "\n" | "\r\n"; edits: readonly TextEdit[] }
export interface ProjectEditPlan { title: string; files: readonly FileEdit[]; count: number }
export interface LabelOccurrence extends ProjectMatch { key: string; kind: "definition" | "reference"; command: string; prefix?: string }
export interface LabelIndex { occurrences: readonly LabelOccurrence[]; unsafe: readonly ProjectMatch[] }

function matchLocator(path: string, source: string): (from: number, to: number) => ProjectMatch {
  const starts = [0];
  for (let i = source.indexOf("\n"); i >= 0; i = source.indexOf("\n", i + 1)) starts.push(i + 1);
  return (from, to) => {
    let low = 0, high = starts.length - 1;
    while (low < high) { const mid = (low + high + 1) >> 1; if (starts[mid] <= from) low = mid; else high = mid - 1; }
    const start = starts[low];
    const end = source.indexOf("\n", from);
    return { path, from, to, line: low + 1, column: from - start, context: source.slice(start, end < 0 ? source.length : end), text: source.slice(from, to) };
  };
}
export const matchAt = (path: string, source: string, from: number, to: number): ProjectMatch => matchLocator(path, source)(from, to);

/** Literal project search, grouped by path by the caller; no arbitrary regular expressions. */
export function searchProject(snapshot: ProjectSnapshot, query: string, options: SearchOptions = {}): ProjectMatch[] {
  if (!query) return [];
  const matches: ProjectMatch[] = [];
  const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), options.caseSensitive ? "gu" : "giu");
  for (const file of snapshot.files) {
    const locate = matchLocator(file.path, file.text);
    for (const match of file.text.matchAll(regex)) {
      const at = match.index!;
      const before = file.text.slice(Math.max(0, at - 2), at);
      const after = file.text.slice(at + match[0].length, at + match[0].length + 2);
      if (!options.wholeWord || (!/[\p{L}\p{N}_]$/u.test(before) && !/^[\p{L}\p{N}_]/u.test(after))) matches.push(locate(at, at + match[0].length));
    }
  }
  return matches;
}

export function createEditPlan(snapshot: ProjectSnapshot, title: string, changes: ReadonlyMap<string, readonly TextEdit[]>): ProjectEditPlan {
  const files: FileEdit[] = [];
  for (const [path, edits] of changes) {
    const file = snapshot.files.find(candidate => candidate.path === path);
    if (!file) throw new Error("An edit points outside this project snapshot.");
    const ordered = [...edits].sort((a, b) => a.from - b.from);
    let cursor = 0;
    let after = "";
    for (const edit of ordered) {
      if (!Number.isInteger(edit.from) || edit.from < cursor || edit.to < edit.from || edit.to > file.text.length) throw new Error("Invalid or overlapping edits.");
      after += file.text.slice(cursor, edit.from) + normalizedText(edit.insert);
      cursor = edit.to;
    }
    after += file.text.slice(cursor);
    if (after !== file.text) files.push({ path, before: file.text, after, diskBefore: file.diskText, lineEnding: file.lineEnding, edits: ordered });
  }
  return { title, files, count: files.reduce((sum, file) => sum + file.edits.length, 0) };
}

export function previewReplace(snapshot: ProjectSnapshot, query: string, replacement: string, options: SearchOptions = {}): ProjectEditPlan {
  if (!query) throw new Error("Enter text to search for first.");
  const changes = new Map<string, TextEdit[]>();
  for (const match of searchProject(snapshot, query, options)) {
    const edits = changes.get(match.path) ?? [];
    edits.push({ from: match.from, to: match.to, insert: replacement });
    changes.set(match.path, edits);
  }
  return createEditPlan(snapshot, "Replace in current LaTeX project", changes);
}

export const LABEL_REFERENCE_COMMANDS = new Set(["ref", "eqref", "pageref", "autoref", "Autoref", "nameref", "Nameref", "cref", "Cref", "crefrange", "Crefrange", "cpageref", "Cpageref", "cpagerefrange", "Cpagerefrange", "vref", "Vref", "vpageref", "Vpageref", "hyperref", "getrefnumber", "getpagerefnumber", "labelcref", "labelcpageref", "namecref", "nameCref", "lcnamecref", "namecrefs", "nameCrefs", "lcnamecrefs"]);
const REFERENCE_CODE = new RegExp(`\\\\(?:label|${[...LABEL_REFERENCE_COMMANDS].join("|")})\\b`);
// Ordinary \label/\ref arguments are one key, including literal commas. Only the
// cleveref list commands split them. New names exclude commas to keep later list use safe.
const literalKey = (s: string) => !!s && !/[\\{}%#$&^~\s]/u.test(s);
const newLiteralKey = (s: string) => literalKey(s) && !s.includes(",");
const presentArgs = (node: TexNode & { t: "macro" }) => node.args.filter(arg => (arg.kind === "m" || arg.kind === "g" || (node.name === "hyperref" && arg.kind === "o")) && arg.to > arg.from);

/** AST traversal ignores comments/verbatim and scans raw math with the same signatures. */
export function indexProjectLabels(snapshot: ProjectSnapshot): LabelIndex {
  const occurrences: LabelOccurrence[] = [];
  const unsafe: ProjectMatch[] = [];
  const signatures = { ...snapshot.plan.sig, macros: new Map([...snapshot.plan.sig.macros, ...[...LABEL_REFERENCE_COMMANDS].map(command => [command, command === "hyperref" ? "o m" : /range$/.test(command) ? "s m m" : "s m"] as const)]) };
  for (const file of snapshot.files) {
    const locate = matchLocator(file.path, file.text);
    const add = (arg: TexArg, command: string, kind: LabelOccurrence["kind"], source: string, base: number, prefix?: string) => {
      const raw = argText(source, arg);
      const list = kind === "reference" && /^(?:[cC](?:page)?ref|labelc(?:page)?ref)$/.test(command);
      if (!list && !literalKey(raw)) { unsafe.push(locate(base + arg.from, base + arg.to)); return; }
      const start = arg.from + (/[{[]/.test(source[arg.from] ?? "") ? 1 : 0);
      let offset = 0;
      for (const part of list ? raw.split(",") : [raw]) {
        const key = list ? part.trim() : part;
        if (!literalKey(key)) { unsafe.push(locate(base + arg.from, base + arg.to)); return; }
        const from = base + start + offset + part.indexOf(key);
        occurrences.push({ ...locate(from, from + key.length), key: prefix ? `${prefix}:${key}` : key, kind, command, ...(prefix ? { prefix } : {}) });
        offset += part.length + 1;
      }
    };
    const walk = (nodes: readonly TexNode[], source: string, base = 0, depth = 0): void => {
      if (depth > 64) throw new Error("Reference indexing reached its nesting bound.");
      for (const node of nodes) {
        if (node.t === "comment" || node.t === "verb") continue;
        if (node.t === "macro") {
          if (node.code) {
            if (REFERENCE_CODE.test(source.slice(node.from, node.to))) unsafe.push(locate(base + node.from, base + node.to));
            continue;
          }
          if (node.name === "label" || LABEL_REFERENCE_COMMANDS.has(node.name)) {
            const args = presentArgs(node).filter(arg => node.name !== "hyperref" || arg.kind === "o");
            if (!args.length) unsafe.push(locate(base + node.from, base + node.to));
            for (const arg of args) add(arg, node.name, node.name === "label" ? "definition" : "reference", source, base);
            continue;
          }
          if (isFileInput(node) && /[\\#{}]/.test(argText(source, node.args.at(-1)))) unsafe.push(locate(base + node.from, base + node.to));
          for (const arg of node.args) if (arg.body) walk(arg.body, source, base, depth + 1);
        } else if (node.t === "env") {
          const def = snapshot.theorems.get(node.name);
          if (def?.spec === "tcb") {
            const last = node.args.at(-1);
            if (last?.kind === "g" && last.to > last.from) {
              const direct = node.args.some(arg => arg.kind === "t" && arg.to > arg.from);
              add(last, node.name, "definition", source, base, direct ? undefined : def.prefix ?? node.name);
            }
          }
          for (const arg of node.args) if (arg.body) walk(arg.body, source, base, depth + 1);
          walk(node.body, source, base, depth + 1);
        } else if (node.t === "group") walk(node.body, source, base, depth + 1);
        else if (node.t === "math") {
          const inner = source.slice(node.srcFrom, node.srcTo);
          walk(parseTex(inner, signatures), inner, base + node.srcFrom, depth + 1);
        }
      }
    };
    walk(parseTex(file.text, signatures), file.text);
  }
  return { occurrences, unsafe };
}

export function previewLabelRename(snapshot: ProjectSnapshot, oldKey: string, newKey: string): ProjectEditPlan {
  if (!literalKey(oldKey)) throw new Error("The existing label must be a literal key without spaces or TeX commands.");
  if (!newLiteralKey(newKey)) throw new Error("New label names must be literal keys without spaces, commas or TeX commands.");
  if (oldKey === newKey) throw new Error("Choose a different label name.");
  const index = indexProjectLabels(snapshot);
  if (snapshot.plan.missing.size || snapshot.warnings.length) throw new Error("Resolve unreadable, dynamic or incomplete project inputs before a safe label rename.");
  if (index.unsafe.length) throw new Error("This project contains dynamic/incomplete label references or reference-generating macros. Resolve them before a safe rename.");
  const definitions = index.occurrences.filter(item => item.kind === "definition" && item.key === oldKey);
  if (definitions.length !== 1) throw new Error(definitions.length ? "This label has duplicate definitions; rename is ambiguous." : "This label has no unique source definition.");
  if (snapshot.plan.visits.filter(visit => snapshot.plan.files.get(visit.key)?.abs === definitions[0].path).length > 1) throw new Error("This label's defining file is included repeatedly; its runtime definitions are ambiguous.");
  if (index.occurrences.some(item => item.kind === "definition" && item.key === newKey)) throw new Error("The new label already exists in this project.");
  const changes = new Map<string, TextEdit[]>();
  for (const item of index.occurrences.filter(item => item.key === oldKey)) {
    let insert = newKey;
    if (item.prefix) {
      if (!newKey.startsWith(`${item.prefix}:`)) throw new Error(`This theorem's native label must keep its ${item.prefix}: prefix.`);
      insert = newKey.slice(item.prefix.length + 1);
      if (!newLiteralKey(insert)) throw new Error("The native theorem label suffix must be nonempty and literal.");
    }
    const edits = changes.get(item.path) ?? [];
    edits.push({ from: item.from, to: item.to, insert });
    changes.set(item.path, edits);
  }
  return createEditPlan(snapshot, `Rename label ${oldKey} → ${newKey}`, changes);
}

/** Select the innermost matched environment at the cursor, and change just its two names. */
export function previewEnvironmentRename(snapshot: ProjectSnapshot, path: string, position: number, newName: string): ProjectEditPlan {
  if (!/^[A-Za-z][A-Za-z0-9*@_-]*$/.test(newName)) throw new Error("Enter a literal environment name.");
  const file = snapshot.files.find(candidate => candidate.path === path);
  if (!file) throw new Error("The active file is outside this project snapshot.");
  const pairs: { from: number; to: number; name: string; first: RegExpMatchArray; last: RegExpMatchArray }[] = [];
  const walk = (nodes: readonly TexNode[]) => {
    for (const node of nodes) {
      if (node.t === "env" || ((node.t === "math" || node.t === "verb") && node.env)) {
        const name = node.t === "env" ? node.name : node.env!;
        if (node.t !== "env" || node.closed) {
          const text = file.text.slice(node.from, node.to);
          const first = /^\\begin\s*\{([^}]+)\}/.exec(text);
          const last = /\\end\s*\{([^}]+)\}\s*$/.exec(text);
          if (first && last && first[1] === name && last[1] === name) pairs.push({ from: node.from, to: node.to, name, first, last });
        }
      }
      if (node.t === "env" || node.t === "group") walk(node.body);
    }
  };
  walk(parseTex(file.text, snapshot.plan.sig));
  const pair = pairs.filter(pair => pair.from <= position && position <= pair.to).sort((a, b) => (a.to - a.from) - (b.to - b.from))[0];
  if (!pair) throw new Error("Place the cursor inside a complete begin/end environment pair.");
  if (newName === pair.name) throw new Error("Choose a different environment name.");
  const firstFrom = pair.from + pair.first[0].indexOf("{") + 1;
  const lastFrom = pair.from + pair.last.index! + pair.last[0].indexOf("{") + 1;
  return createEditPlan(snapshot, `Rename environment ${pair.name} → ${newName}`, new Map([[path, [
    { from: firstFrom, to: firstFrom + pair.name.length, insert: newName },
    { from: lastFrom, to: lastFrom + pair.name.length, insert: newName },
  ]]]));
}

export interface EditState { text: string; diskText: string; writable: boolean; composing?: boolean; conflicting?: boolean }
export interface ProjectEditHost {
  /** One multi-file mutation at a time; reads/navigation may still run. */
  begin?(): void;
  end?(): void;
  read(path: string): Promise<EditState>;
  /** Compare BOTH disk and open buffers with expected immediately before mutation. */
  write(path: string, expected: EditState, text: string, lineEnding: FileEdit["lineEnding"]): Promise<EditState>;
}
export interface EditReceipt { plan: ProjectEditPlan; states: readonly { file: FileEdit; before: EditState; after: EditState }[] }

function checkState(state: EditState, before: string, disk: string, path: string): void {
  if (!state.writable) throw new Error(`The project operation cannot write outside the vault: ${path}`);
  if (state.composing) throw new Error("Finish IME composition before applying project edits.");
  if (state.conflicting) throw new Error("Two open panes have different text for the same file. Resolve them before applying edits.");
  if (normalizedText(state.text) !== before || state.diskText !== disk) throw new Error(`The preview is stale; refresh it before applying: ${path}`);
}

/** Full preflight, per-file CAS and conditional rollback. A receipt also supports explicit Undo. */
async function applyLockedProjectEdits(plan: ProjectEditPlan, host: ProjectEditHost): Promise<EditReceipt> {
  const initial = new Map<string, EditState>();
  for (const file of plan.files) {
    const state = await host.read(file.path);
    checkState(state, file.before, file.diskBefore, file.path);
    initial.set(file.path, state);
  }
  const states: { file: FileEdit; before: EditState; after: EditState }[] = [];
  try {
    for (const file of plan.files) {
      const before = await host.read(file.path);
      checkState(before, file.before, file.diskBefore, file.path);
      const after = await host.write(file.path, before, file.after, file.lineEnding);
      states.push({ file, before: initial.get(file.path)!, after });
    }
  } catch (error) {
    const failures: string[] = [];
    for (const { file, before, after } of [...states].reverse()) {
      try {
        const state = await host.read(file.path);
        checkState(state, normalizedText(after.text), after.diskText, file.path);
        await host.write(file.path, state, normalizedText(before.text), file.lineEnding);
      } catch { failures.push(file.path); }
    }
    if (failures.length) throw new Error(`Project edit stopped; newer edits prevented rollback for ${failures.join(", ")}. Recoverable original text is retained in the preview. ${String(error)}`);
    throw error;
  }
  return { plan, states };
}

export async function applyProjectEdits(plan: ProjectEditPlan, host: ProjectEditHost): Promise<EditReceipt> {
  host.begin?.();
  try { return await applyLockedProjectEdits(plan, host); }
  finally { host.end?.(); }
}

export async function undoProjectEdits(receipt: EditReceipt, host: ProjectEditHost): Promise<EditReceipt> {
  const files = receipt.states.map(({ file, before, after }) => ({ ...file, before: normalizedText(after.text), after: normalizedText(before.text), diskBefore: after.diskText, edits: [{ from: 0, to: normalizedText(after.text).length, insert: normalizedText(before.text) }] }));
  return applyProjectEdits({ title: `Undo ${receipt.plan.title}`, files, count: files.length }, host);
}
