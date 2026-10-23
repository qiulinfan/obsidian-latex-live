// LaTeX Suite's snippets in the .tex editor. LaTeX Suite (obsidian-latex-suite) expands its
// snippets in Markdown only: its math detection reads Obsidian's Markdown syntax tree. Here the
// snippets it has parsed (its `CMSettings`, read at every key) run with the mode from mathAt, and
// the expansion becomes a CodeMirror snippet, so its tab stops are keyArbiter's snippet fields.
//
// Follows LaTeX Suite 1.14's runSnippetCursor: mode, process, excluded scope, word boundary,
// whitespace trim in inline math, undoKey, recursion. Not supported: snippets with
// `includedMacros` or `context` (they read Suite's own syntax tree), `includedPaths`, trigger
// keys other than the configured space or Tab trigger.

import { snippet as cmSnippet } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { Extension, Prec, Text } from "@codemirror/state";
import { Command, EditorView } from "@codemirror/view";
import type { EnvRules } from "../tex/envRules";
import { envRulesFacet } from "./latexHighlight";
import { literalAt, mathAt } from "./latexScan";

/** LaTeX Suite's Mode: where the cursor is. */
export interface SuiteMode {
  text: boolean;
  inlineMath: boolean;
  blockMath: boolean;
  codeMath: boolean;
  codeBlock: boolean;
  code: boolean;
  textEnv: boolean;
  snippetlessEnv: boolean;
}

export interface SuiteMacro {
  readonly name: string;
  /** Argument indexes; Suite's default is [0]. */
  readonly arguments?: readonly number[];
}

export interface SuiteTabstop {
  index: number[];
  /** Offsets in `insert`. */
  from: number;
  to: number;
}

export interface SuiteResult {
  triggerPos: number;
  triggerEndPos?: number;
  replacement: { insert: string; tabstops: SuiteTabstop[] };
}

/** The fields of LaTeX Suite's Snippet class used here. */
export interface SuiteSnippet {
  readonly type: string;
  readonly options: {
    readonly automatic: boolean;
    readonly onWordBoundary: boolean;
    readonly undoKey?: boolean;
    snippetShouldRunInMode(mode: SuiteMode, ignoreSnippetlessEnv?: boolean): boolean;
  };
  readonly triggerKey?: string | null;
  readonly excludedEnvironments?: readonly string[];
  readonly excludedMacros?: readonly SuiteMacro[];
  readonly includedMacros?: readonly unknown[];
  readonly context?: readonly unknown[];
  process(ctx: {
    effectiveLine: string;
    range: { original: { from: number; to: number }; parsed: { from: number; to: number } };
    sel: { original: string; parsed: string };
    effectiveLineAfter: () => string;
    view: EditorView;
  }): SuiteResult | null;
}

/** What the editor needs from LaTeX Suite's settings (`CMSettings`). */
export interface SuiteConfig {
  readonly snippets: readonly SuiteSnippet[];
  /** `snippetsTrigger`: " " (or "Space") and "Tab" are supported. */
  readonly trigger: string;
  readonly wordDelimiters: string;
  readonly removeWhitespace: boolean;
  readonly suppressOnIME: boolean;
  readonly recursion: number;
  /** `mathlessMacros.all`: `\text{}` and the like ("text"), `\tag{}` and the like ("restricted"). */
  readonly textMacros: readonly (SuiteMacro & { readonly kind: "text" | "restricted" })[];
}

export type SuiteConfigSource = () => SuiteConfig | null;

/** Where `pos` is, in Suite's terms, and the enclosing math environment. */
export interface SuitePlace {
  mode: SuiteMode;
  env: string | null;
  /** Macro arguments around `pos` inside the formula, innermost first. */
  macros: { name: string; arg: number }[];
}

const NOWHERE: SuiteMode = {
  text: false, inlineMath: false, blockMath: false, codeMath: false,
  codeBlock: false, code: false, textEnv: false, snippetlessEnv: false,
};

export function suitePlace(doc: Text, pos: number, textMacros: SuiteConfig["textMacros"] = [], rules?: EnvRules): SuitePlace {
  if (literalAt(doc, pos)) return { mode: { ...NOWHERE }, env: null, macros: [] };
  const math = innerMath(doc, pos, rules);
  if (!math) return { mode: { ...NOWHERE, text: true }, env: null, macros: [] };
  const macros = macroStack(doc.sliceString(math.inner, pos));
  const kind = macros.length
    ? textMacros.find((m) => m.name === macros[0].name && (m.arguments ?? [0]).includes(macros[0].arg))?.kind
    : undefined;
  return {
    mode: {
      ...NOWHERE,
      inlineMath: !math.display,
      blockMath: math.display,
      textEnv: kind === "text",
      snippetlessEnv: kind === "restricted",
    },
    env: math.env,
    macros,
  };
}

/** The formula whose content holds `pos` (not its delimiters), with the start of that content. */
function innerMath(doc: Text, pos: number, rules?: EnvRules): { inner: number; display: boolean; env: string | null } | null {
  const m = mathAt(doc, pos, rules);
  if (m) {
    const [open, close] = m.env
      ? [`\\begin{${m.env}}`.length, `\\end{${m.env}}`.length]
      : [(m.to - m.from - m.src.length) / 2, (m.to - m.from - m.src.length) / 2];
    if (pos < m.from + open || pos > m.to - close) return null;
    return { inner: m.from + open, display: m.display, env: m.env };
  }
  // An empty formula, `$|$` right after `mk`: mathAt has nothing there.
  const around = doc.sliceString(Math.max(0, pos - 2), pos) + "|" + doc.sliceString(pos, pos + 2);
  if (/\$\$\|\$\$$/.test(around) || /\\\[\|\\\]/.test(around)) return { inner: pos, display: true, env: null };
  if (/(^|[^$\\])\$\|\$([^$]|$)/.test(around) || /\\\(\|\\\)/.test(around)) return { inner: pos, display: false, env: null };
  return null;
}

/** The macro arguments open at the end of `src` (formula content), innermost first. */
function macroStack(src: string): { name: string; arg: number }[] {
  const groups: ({ name: string; arg: number } | null)[] = [];
  let next: { name: string; arg: number } | null = null; // a `{` here opens this argument
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === "\\") {
      const name = /^[A-Za-z]+\*?/.exec(src.slice(i + 1))?.[0];
      next = name ? { name, arg: 0 } : null;
      i += name ? name.length : 1;
    } else if (c === "{") {
      groups.push(next);
      next = null;
    } else if (c === "}") {
      const g = groups.pop();
      next = g ? { name: g.name, arg: g.arg + 1 } : null;
    } else if (c === "%") {
      const nl = src.indexOf("\n", i);
      i = nl < 0 ? src.length : nl;
    } else if (!/\s/.test(c)) {
      next = null;
    }
  }
  return groups.filter((g): g is { name: string; arg: number } => g !== null).reverse();
}

function excluded(s: SuiteSnippet, place: SuitePlace): boolean {
  if (place.env && s.excludedEnvironments?.includes(place.env)) return true;
  const ex = s.excludedMacros;
  return !!ex?.length && place.macros.some((g) => ex.some((m) => m.name === g.name && (m.arguments ?? [0]).includes(g.arg)));
}

/**
 * Runs the first matching snippet at the main selection, as if `key` was typed (undefined: the
 * trigger key, or a recursive pass). Returns whether a snippet expanded.
 */
export function runSuiteSnippets(view: EditorView, cfg: SuiteConfig, snippets: readonly SuiteSnippet[], key?: string): boolean {
  let expanded = false;
  for (let i = 0; i <= cfg.recursion; i++) {
    if (!runOnce(view, cfg, snippets, i === 0 ? key : undefined)) break;
    expanded = true;
  }
  return expanded;
}

function runOnce(view: EditorView, cfg: SuiteConfig, snippets: readonly SuiteSnippet[], key: string | undefined): boolean {
  const state = view.state;
  if (state.selection.ranges.length > 1) return false;
  const { from, to } = state.selection.main;
  const k = key ?? "";
  const place = suitePlace(state.doc, from, cfg.textMacros, state.facet(envRulesFacet));
  const sel = state.sliceDoc(from, to);
  const effectiveLine = state.sliceDoc(0, to) + k;
  let after: string | null = null;
  const delimiters = cfg.wordDelimiters.replace("\\n", "\n");
  for (const s of snippets) {
    if (s.includedMacros?.length || s.context?.length) continue;
    if (!s.options.snippetShouldRunInMode(place.mode)) continue;
    if (s.type === "visual" && from === to) continue;
    const result = s.process({
      effectiveLine,
      range: { original: { from, to }, parsed: { from, to } },
      sel: { original: sel, parsed: sel },
      effectiveLineAfter: () => (after ??= state.sliceDoc(to)),
      view,
    });
    if (!result) continue;
    if (excluded(s, place)) continue;
    const start = result.triggerPos;
    const end = result.triggerEndPos ? result.triggerEndPos - k.length : to;
    if (s.options.onWordBoundary) {
      const prev = state.sliceDoc(start - 1, start);
      const nextChar = state.sliceDoc(to, to + 1);
      if (!delimiters.includes(prev) || !delimiters.includes(nextChar)) continue;
    }
    let { insert, tabstops } = result.replacement;
    if (place.mode.inlineMath && cfg.removeWhitespace) {
      insert = insert.trimEnd();
      tabstops = tabstops.map((t) => ({ index: t.index, from: Math.min(t.from, insert.length), to: Math.min(t.to, insert.length) }));
    }
    const undoKey = !!key && s.options.automatic && s.type !== "visual" && !!s.options.undoKey;
    expand(view, start, end, insert, tabstops, undoKey ? key : undefined);
    return true;
  }
  return false;
}

/** Replaces from..to with the expansion; Suite's undoKey first types the key as its own step. */
function expand(view: EditorView, from: number, to: number, insert: string, tabstops: SuiteTabstop[], key?: string): void {
  if (key) {
    const at = view.state.selection.main.head;
    view.dispatch({
      changes: { from: at, insert: key },
      selection: { anchor: at + key.length },
      annotations: isolateHistory.of("full"),
      userEvent: "input.type",
    });
    to += key.length;
  } else {
    view.dispatch({ annotations: isolateHistory.of("full") });
  }
  cmSnippet(snippetTemplate(insert, tabstops))(view, null, from, to);
  view.dispatch({ annotations: isolateHistory.of("full") }); // the next keystroke starts a new undo step
}

/**
 * A CodeMirror snippet template for Suite's insert and tab stops. Tab stops are ordered as Suite
 * orders them (by index, equal ones linked) and numbered 1..n; the last is where the snippet ends.
 * Without tab stops the cursor goes after the insert. Overlapping tab stops are dropped.
 */
export function snippetTemplate(insert: string, tabstops: readonly SuiteTabstop[]): string {
  const keys = [...new Set(tabstops.map((t) => t.index.join(".")))].sort((a, b) => {
    const x = a.split(".").map(Number);
    const y = b.split(".").map(Number);
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
  const fields: { n: number; from: number; to: number }[] = [];
  for (const t of [...tabstops].sort((a, b) => a.from - b.from || a.to - b.to)) {
    const last = fields[fields.length - 1];
    if (last && (t.from < last.to || (t.from === last.from && t.to === last.to))) continue;
    fields.push({ n: keys.indexOf(t.index.join(".")) + 1, from: t.from, to: t.to });
  }
  let out = "";
  let at = 0;
  for (const f of fields) {
    out += escapeLiteral(insert.slice(at, f.from), insert[at - 1] ?? "");
    const name = insert.slice(f.from, f.to);
    out += /[{}]/.test(name) ? `\${${f.n}}${escapeLiteral(name, insert[f.from - 1] ?? "")}` : name ? `\${${f.n}:${name}}` : `\${${f.n}}`;
    at = f.to;
  }
  out += escapeLiteral(insert.slice(at), insert[at - 1] ?? "");
  return fields.length ? out : out + "${1}";
}

/**
 * Literal text in a template: a LaTeX `\{` keeps its backslash (Snippet.parse turns `\{` into
 * `{`), and a brace after `$` or `#` is escaped so it does not open a field.
 */
function escapeLiteral(text: string, before: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const prev = i ? text[i - 1] : before;
    if ((c === "{" || c === "}") && prev === "\\") out += "\\" + c;
    else if (c === "{" && (prev === "$" || prev === "#")) out += "\\{";
    else out += c;
  }
  return out;
}

const isSpace = (trigger: string) => trigger === " " || trigger === "Space";

/**
 * The input handler (Prec.high, before closeBrackets and mathInput): a typed character runs the
 * automatic snippets with it, and the space trigger runs the others.
 */
export function suiteSnippets(source: SuiteConfigSource): Extension {
  return Prec.high(
    EditorView.inputHandler.of((view, _from, _to, text) => {
      if (text.length !== 1 || view.state.selection.ranges.length > 1) return false;
      const cfg = source();
      if (!cfg || (cfg.suppressOnIME && view.composing)) return false;
      try {
        if (isSpace(cfg.trigger) && text === " " && runSuiteSnippets(view, cfg, triggered(cfg))) return true;
        return runSuiteSnippets(view, cfg, cfg.snippets.filter((s) => s.options.automatic), text);
      } catch (e) {
        console.error("LaTeX Live: LaTeX Suite snippet failed", e);
        return false;
      }
    }),
  );
}

/** The snippets a trigger key runs (Suite's runMaker): no own trigger key, not automatic. */
function triggered(cfg: SuiteConfig): SuiteSnippet[] {
  return cfg.snippets.filter((s) => !s.triggerKey && !s.options.automatic);
}

/** keyArbiter's tabFallback: with a Tab trigger, the snippets first. */
export function suiteTabFallback(source: SuiteConfigSource, fallback: Command): Command {
  return (view) => {
    const cfg = source();
    if (cfg && cfg.trigger === "Tab") {
      try {
        if (runSuiteSnippets(view, cfg, triggered(cfg))) return true;
      } catch (e) {
        console.error("LaTeX Live: LaTeX Suite snippet failed", e);
      }
    }
    return fallback(view);
  };
}
