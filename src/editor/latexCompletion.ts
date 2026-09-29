// LaTeX completion: texlab through the shared LSP source, plus a built-in layer for what
// texlab lacks (see docs/design.md):
//   - argument snippets (\frac{|}{}, \textbf{|}, user macros with [n] arguments) and
//     \begin/\end pairs for environments (TL-03, UX-05, UX-06);
//   - frequent commands, environments and project colors that texlab's 50-item page or
//     database misses are added before ranking (TL-02, TL-06);
//   - ranking: math commands first inside math, text commands first outside, commands
//     already used in the document, a popularity prior for common commands (UX-08);
//   - implicit requests only after `\` + a letter or inside argument braces such as
//     \ref{ \cite{ \begin{ \usepackage{ (D5), never in a `%` comment or verbatim, where
//     texlab has nothing and the built-in layer alone would turn Enter into a snippet;
//   - accepting `\ref` (etc.) opens the argument's list right away, as if `{` was typed;
//   - a citation query texlab cannot match (title or author words) asks for the whole
//     list, which the shared source filters on author and title (TL-05).
// No obsidian imports: tests run this against recorded and live texlab responses.
import { Completion, CompletionSource, snippet } from "@codemirror/autocomplete";
import { EditorState, Text } from "@codemirror/state";
import { Definitions, emptyDefinitions, mergeDefinitions, scanDefinitions } from "../tex/macros";
import {
  ARGUMENT_COMMANDS,
  COMMAND_ARGS,
  COMMAND_VARIANTS,
  DISPLAY_ENVIRONMENTS,
  ENVIRONMENTS,
  ENVIRONMENT_ARGS,
  GLYPHS,
  LIST_ENVIRONMENTS,
  MATH_COMMANDS,
  MATH_INNER_ENVIRONMENTS,
  POPULAR,
  TEXT_COMMANDS,
  snippetText,
} from "./latexCommands";
import { TokState, tokenizeLine } from "./latexHighlight";
import {
  InfoRenderer,
  LspCompletionBackend,
  LspCompletionContext,
  LspCompletionItem,
  LspCompletionList,
  LspCompletionOptions,
  LspPosition,
  LspRange,
  defaultGlyph,
  lspCompletionSource,
  lspPosToOffset,
  offsetToLspPos,
} from "./shared/lspCompletion";

export type ArgumentKind = (typeof ARGUMENT_COMMANDS)[string];

/** What the text before the cursor is, as far as completion cares. */
export type LatexContext =
  /** `\wor|d`: `from` is after the backslash, `to` the end of the word. */
  | { kind: "command"; word: string; from: number; to: number }
  /** Inside `\ref{…`: `query` is the text after `{` (or after the last `,`). */
  | { kind: "argument"; command: string; arg: ArgumentKind; query: string; from: number; to: number };

const COMMAND_BEFORE = /\\((?:[A-Za-z@]+\*?)?)$/;
const ARGUMENT_BEFORE = /\\([A-Za-z]+)\*?\s*(?:\[[^\]\n]*\]\s*)*\{([^{}\n]*)$/;
const MULTI_VALUE = new Set<ArgumentKind>(["label", "cite", "package"]);

/** An odd run of backslashes before `i` escapes the character at `i`. */
function escaped(text: string, i: number): boolean {
  let n = 0;
  while (i - n - 1 >= 0 && text[i - n - 1] === "\\") n++;
  return n % 2 === 1;
}

export function latexContext(state: EditorState, pos: number): LatexContext | null {
  const line = state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const after = line.text.slice(pos - line.from);
  const cmd = COMMAND_BEFORE.exec(before);
  if (cmd && !escaped(before, cmd.index)) {
    const tail = /^[A-Za-z@]*/.exec(after)![0];
    return { kind: "command", word: cmd[1], from: pos - cmd[1].length, to: pos + tail.length };
  }
  const arg = ARGUMENT_BEFORE.exec(before);
  const kind = arg && !escaped(before, arg.index) ? ARGUMENT_COMMANDS[arg[1]] : undefined;
  if (!arg || !kind) return null;
  let query = arg[2];
  if (MULTI_VALUE.has(kind)) query = query.slice(query.lastIndexOf(",") + 1).trimStart();
  const tail = /^[^{},\s]*/.exec(after)![0];
  return { kind: "argument", command: arg[1], arg: kind, query, from: pos - query.length, to: pos + tail.length };
}

// ---- document analysis ------------------------------------------------------------------

interface Analysis {
  context: LatexContext | null;
  inMath: boolean;
  /** The cursor is in a `%` comment or a verbatim-like environment. */
  quiet: boolean;
  /** Command uses outside / inside math, by name. */
  textUses: Map<string, number>;
  mathUses: Map<string, number>;
  /** `\begin{name}` uses. */
  envUses: Map<string, number>;
  /** Environments with an `\end` after the cursor that no later `\begin` claims. */
  closedAfter: Set<string>;
  defs: Definitions;
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const DEFINING =
  /^(?:(?:re)?newcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|[egx]?def|let|(?:New|Renew|Provide|Declare)DocumentCommand)\*?$/;

function analyze(state: EditorState, pos: number, project: Definitions): Analysis {
  const doc = state.doc;
  const textUses = new Map<string, number>();
  const mathUses = new Map<string, number>();
  const s: TokState = { math: null, verbatim: null };
  const cursorLine = doc.lineAt(pos);
  let inMath = false;
  let quiet = false;
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n);
    if (n === cursorLine.number) {
      const probe = { ...s };
      const upTo = line.text.slice(0, pos - line.from);
      let last = "";
      tokenizeLine(upTo, 0, probe, (_from, to, cls) => {
        if (to === upTo.length) last = cls;
      });
      inMath = probe.math !== null;
      quiet = probe.verbatim !== null || last === "ll-comment";
    }
    let defining = false;
    tokenizeLine(line.text, 0, s, (from, to, cls) => {
      if (!cls.startsWith("ll-command") && cls !== "ll-section" && cls !== "ll-keyword") return;
      const name = line.text.slice(from + 1, to);
      // The name a definition introduces (`\newcommand{\supp}`) is not a use of it.
      if (defining) {
        defining = false;
        return;
      }
      defining = DEFINING.test(name);
      bump(cls.includes("ll-in-math") ? mathUses : textUses, name);
    });
    // Inline math never spans a paragraph break (as in the highlighter).
    if (!line.text.trim() && (s.math === "$" || s.math === "\\)")) s.math = null;
  }
  const text = doc.toString();
  const envUses = new Map<string, number>();
  for (const m of text.matchAll(/\\begin\s*\{([^{}\n]+)\}/g)) bump(envUses, m[1]);
  return {
    context: latexContext(state, pos),
    inMath,
    quiet,
    textUses,
    mathUses,
    envUses,
    closedAfter: closedAfter(doc, pos),
    defs: mergeDefinitions(project, scanDefinitions(text)),
  };
}

function closedAfter(doc: Text, pos: number): Set<string> {
  const depth = new Map<string, number>();
  const out = new Set<string>();
  const end = Math.min(doc.length, pos + 200_000);
  const text = doc.sliceString(pos, end).replace(/(^|[^\\])%.*$/gm, "$1");
  for (const m of text.matchAll(/\\(begin|end)\s*\{([^{}\n]+)\}/g)) {
    const d = depth.get(m[2]) ?? 0;
    if (m[1] === "begin") depth.set(m[2], d + 1);
    else if (d > 0) depth.set(m[2], d - 1);
    else out.add(m[2]);
  }
  return out;
}

// ---- options ------------------------------------------------------------------------------

export interface LatexCompletionEnv {
  /** Definitions from the project's files (macros with arguments, colors, environments). */
  definitions?: () => Definitions;
  renderInfo?: InfoRenderer;
  /** A .bib file: texlab's entry types and fields. */
  bib?: boolean;
}

interface Meta {
  kind: "command" | "environment" | "other";
  name: string;
  glyph: boolean;
}

/**
 * One analysis per request: the backend, augment and rank of a request share it (same doc,
 * same position).
 */
function analyses(env: LatexCompletionEnv) {
  let last: { doc: Text; pos: number; a: Analysis } | null = null;
  return (state: EditorState, pos: number): Analysis => {
    if (last && last.doc === state.doc && last.pos === pos) return last.a;
    const a = analyze(state, pos, env.definitions?.() ?? emptyDefinitions());
    last = { doc: state.doc, pos, a };
    return a;
  };
}

const usageBoost = (n: number) => Math.min(30, Math.round(10 * Math.log2(1 + n)));
const POPULAR_RANK = new Map(POPULAR.map((name, i) => [name, i]));
const priorBoost = (name: string) => {
  const i = POPULAR_RANK.get(name);
  return i === undefined ? 0 : Math.max(1, 12 - Math.floor(i / 8));
};
const baseName = (label: string) => label.replace(/\*$/, "");

/** Argument template for a command: built-in, or from a user macro's [n]. */
function argsOf(name: string, defs: Definitions): string | null {
  const known = COMMAND_ARGS[baseName(name)];
  if (known) return known;
  const macro = defs.macros.get(name);
  if (!macro || macro.args === 0) return null;
  const n = macro.args - (macro.optional ? 1 : 0);
  if (n <= 0) return null;
  return Array.from({ length: n }, (_, i) => `{#${i + 1}}`).join("") + "#0";
}

/**
 * Apply for a template, through CodeMirror's snippet() directly: the template notation
 * (#1 ... #0) maps onto CM's fields without the LSP round trip, and only braces after a
 * literal backslash are escaped (@codemirror/autocomplete 6.20.3's Snippet.parse
 * misplaces a field after several `\{`/`\}` escapes on a line). `tail`: text after the
 * cursor that the completion replaces (the rest of the word, closeBrackets' `}`).
 */
function templateApply(template: string, tail: number): Completion["apply"] {
  const cm = template.replace(/\\([{}])/g, "\\\\$1").replace(/#(\d)/g, "${$1}");
  const run = snippet(cm);
  return (view, completion, from, to) => run(view, completion, from, Math.min(view.state.doc.length, to + tail));
}

const VARIANTS = new Map(COMMAND_VARIANTS.map(([label, template]) => [label, template]));
/** Options whose snippet leaves the cursor in an empty list argument (`\ref{|}`, `\begin{|}`). */
const opensArgument = new WeakSet<Completion>();

export function latexCompletionOptions(env: LatexCompletionEnv = {}, analysis = analyses(env)): LspCompletionOptions {
  const meta = new WeakMap<Completion, Meta>();
  const templates = new WeakMap<Completion, { template: string; tail: number }>();
  return {
    activate(ctx) {
      const before = ctx.state.sliceDoc(ctx.state.doc.lineAt(ctx.pos).from, ctx.pos);
      if (env.bib) return /^\s*@?[A-Za-z]+$/.test(before) || /\\[A-Za-z]+$/.test(before);
      const c = latexContext(ctx.state, ctx.pos);
      if (c === null || (c.kind === "command" && !c.word)) return false;
      // Comments and verbatim: texlab offers nothing there (`\end{verbatim}` still completes).
      return !analysis(ctx.state, ctx.pos).quiet || (c.kind === "argument" && c.command === "end");
    },

    validFor(ctx) {
      const c = latexContext(ctx.state, ctx.pos);
      if (c?.kind === "argument") return c.arg === "file" ? /^[^{}\\,/]*$/ : /^[^{}\\,]*$/;
      return /^[A-Za-z@]*\*?$/;
    },

    augment(item, option, edit, ctx) {
      const a = analysis(ctx.state, ctx.pos);
      const c = a.context;
      const name = item.label;
      const isEnv = item.kind === 13 || (c?.kind === "argument" && c.arg === "env");
      meta.set(option, {
        kind: c?.kind === "command" ? "command" : isEnv ? "environment" : "other",
        name,
        glyph: defaultGlyph(item) !== null,
      });
      if (item.preselect) option.boost = 99; // texlab: the innermost open environment after \end{
      const next = ctx.state.sliceDoc(edit.to, edit.to + 1);

      // A snippet from a template in latexCommands.ts notation (#1 ... #0).
      const useTemplate = (template: string) => {
        edit.text = snippetText(template);
        edit.snippet = true;
        templates.set(option, { template, tail: Math.max(0, edit.to - ctx.pos) });
        if (c?.kind === "command" && ARGUMENT_COMMANDS[baseName(name)] && template.startsWith(`${name}{#1}`)) {
          opensArgument.add(option);
        }
      };

      if (c?.kind === "argument") {
        if (c.arg === "env" && c.command === "begin" && isEnv) {
          // \begin{name} gets its \end{name}, unless the rest of the line says otherwise
          // or an unclaimed \end{name} follows (the environment is already closed).
          const brace = next === "}" ? 1 : 0;
          const rest = ctx.state.sliceDoc(edit.to + brace, ctx.state.doc.lineAt(edit.to).to);
          if (rest.trim() || a.closedAfter.has(name)) return;
          const args = ENVIRONMENT_ARGS[name] ?? "";
          const body = LIST_ENVIRONMENTS.has(name) ? "\t\\item #0" : "\t#0";
          edit.to += brace;
          useTemplate(`${name}}${args}\n${body}\n\\end{${name}}`);
        } else if (c.arg === "env" && c.command === "end" && next === "}" && !edit.snippet) {
          // The name completes the environment: land after closeBrackets' `}`.
          edit.to += 1;
          edit.text += "}";
        } else if (c.arg === "file" && !edit.snippet) {
          // texlab 5.26 sends files and folders as kind 1 (text): files by their extension.
          if (/\.[A-Za-z0-9]+$/.test(name)) option.type = "file";
          if (/^(input|include|subfile)$/.test(c.command)) edit.text = edit.text.replace(/\.tex$/, ""); // \input{name} without the extension (TL-06)
        }
        return;
      }
      if (c?.kind !== "command") return;
      if (next === "{" || next === "[") {
        // Arguments already there (renaming a command): insert the name only.
        if (name === "begin") Object.assign(edit, { text: name, snippet: false });
        return;
      }
      const variant = VARIANTS.get(name);
      if (variant) return useTemplate(variant);
      if (name === "begin" || name === "end") {
        // Instead of texlab's `begin` snippet (an empty pair): the name's list opens next,
        // and completing the name adds the \end.
        return useTemplate(`${name}{#1}#0`);
      }
      if (edit.snippet) return;
      const args = argsOf(name, a.defs);
      if (args) useTemplate(name + args);
    },

    rank(options, ctx) {
      const a = analysis(ctx.state, ctx.pos);
      for (const o of options) {
        const m = meta.get(o);
        if (!m || o.boost === 99) continue;
        let boost = o.boost ?? 0;
        if (m.kind === "command") {
          const base = baseName(m.name);
          const math = m.glyph || MATH_COMMANDS.has(base) || !!a.defs.macros.get(m.name)?.math;
          const text = TEXT_COMMANDS.has(base);
          if (a.inMath) boost += math ? 30 : text ? -30 : 0;
          else if (math && !text) boost -= 10;
          const inMath = a.mathUses.get(m.name) ?? 0;
          const inText = a.textUses.get(m.name) ?? 0;
          boost += usageBoost(a.inMath ? inMath + inText / 2 : inText + inMath / 2);
          boost += priorBoost(base);
          if (a.defs.macros.has(m.name)) boost += 8;
        } else if (m.kind === "environment") {
          boost += usageBoost(a.envUses.get(m.name) ?? 0);
          if (MATH_INNER_ENVIRONMENTS.has(m.name)) boost += a.inMath ? 30 : -10;
          else if (a.inMath && DISPLAY_ENVIRONMENTS.has(m.name)) boost -= 30;
        }
        o.boost = Math.max(-98, Math.min(98, boost));
      }
      for (const o of options) {
        const t = templates.get(o);
        if (t) o.apply = templateApply(t.template, t.tail);
      }
      return options;
    },

    renderInfo: env.renderInfo,
  };
}

// ---- backend: texlab plus built-in candidates ------------------------------------------------

/**
 * Wraps texlab (or null when it is unavailable) and adds built-in candidates that match
 * what was typed and are missing from texlab's answer, with texlab's own range.
 */
export function latexBackend(
  inner: LspCompletionBackend | null,
  env: LatexCompletionEnv = {},
  analysis = analyses(env),
): LspCompletionBackend {
  return {
    triggerCharacters: () => {
      const t = inner?.triggerCharacters() ?? [];
      return t.length ? t : ["\\", "{"];
    },
    resolve: inner?.resolve ? (item) => inner.resolve!(item) : undefined,
    async request(pos, context, state) {
      const ask = async (p: LspPosition, ctx: LspCompletionContext, s: EditorState) => {
        try {
          return asList(inner ? await inner.request(p, ctx, s) : null);
        } catch {
          return asList(null);
        }
      };
      let list = await ask(pos, context, state);
      if (env.bib) return list.items.length ? list : null;
      const a = analysis(state, lspPosToOffset(state.doc, pos));
      const c = a.context;
      if (!list.items.length && c?.kind === "argument" && c.arg === "cite" && c.query) {
        // texlab matches citations by key only: `\cite{Masked Au` typed before the list
        // opened gets nothing. Ask with the query removed and replace it on accept; the
        // shared source filters the list on each entry's filterText (key, title, authors).
        const bare = state.update({ changes: { from: c.from, to: c.to } }).state;
        list = await ask(offsetToLspPos(bare.doc, c.from), { triggerKind: 1 }, bare);
        const range = { start: offsetToLspPos(state.doc, c.from), end: offsetToLspPos(state.doc, c.to) };
        for (const item of list.items) {
          if (item.textEdit) item.textEdit = { range, newText: item.textEdit.newText };
        }
      }
      if (c?.kind === "command" && c.from === c.to) bareBackslash(list, state, c.to, a.inMath);
      addBuiltins(list, state, a);
      return list.items.length ? list : null;
    },
  };
}

/** A completion response as a list with a fresh items array. */
function asList(raw: unknown): LspCompletionList {
  const list: LspCompletionList = Array.isArray(raw)
    ? { items: raw as LspCompletionItem[] }
    : raw
      ? { ...(raw as LspCompletionList) }
      : { items: [] };
  list.items = [...(list.items ?? [])];
  return list;
}

/**
 * A bare `\` at the cursor, no letter on either side. Before a non-letter texlab reads a
 * control symbol and answers with that one item, its range covering the character. When that
 * character is a `}` or a `$` closing the surrounding group or math (`\frac{\|}{}`, `$\|$`;
 * `inMath`: the cursor is in math), keep the ranges off it: picking `}` gives `\}` and keeps
 * the brace. Other symbols, and a `$` that opens math, keep texlab's range (`a\|,b`: picking
 * `,` makes the comma `\,`; `Cost \|$5`: picking `$` escapes that dollar). The list is
 * incomplete either way (texlab's first page or that one symbol, plus only the popular
 * built-ins), so the next letter asks again instead of filtering this answer.
 */
function bareBackslash(list: LspCompletionList, state: EditorState, pos: number, inMath: boolean): void {
  const next = state.sliceDoc(pos, pos + 1);
  const closer = next === "}" || (next === "$" && inMath);
  for (const item of list.items) {
    const edit = item.textEdit;
    const range = edit ? ("range" in edit ? edit.range : edit.replace) : null;
    if (closer && edit && range && lspPosToOffset(state.doc, range.end) > pos) {
      item.textEdit = { range: { start: range.start, end: offsetToLspPos(state.doc, pos) }, newText: edit.newText };
    }
  }
  list.isIncomplete = true;
}

function addBuiltins(list: LspCompletionList, state: EditorState, a: Analysis): void {
  const c = a.context;
  if (!c) return;
  const have = new Set(list.items.map((i) => i.label));
  const first = list.items.find((i) => i.textEdit);
  const theirs = first?.textEdit ? ("range" in first.textEdit ? first.textEdit.range : first.textEdit.replace) : null;
  // texlab's range keeps the built-ins in line with its items, unless it reaches past the
  // word: at `\frac{\|}{}` texlab reads the control symbol `\}` and its range covers the `}`.
  const range: LspRange =
    theirs && lspPosToOffset(state.doc, theirs.end) <= c.to
      ? theirs
      : { start: offsetToLspPos(state.doc, c.from), end: offsetToLspPos(state.doc, c.to) };
  const typed = c.kind === "command" ? c.word : c.query;
  const word = typed.toLowerCase();
  const add = (label: string, kind: number, detail: string, text = label, snippet = false) => {
    if (have.has(label) || !label.toLowerCase().startsWith(word)) return;
    have.add(label);
    list.items.push({
      label,
      kind,
      detail,
      sortText: "~" + label,
      insertTextFormat: snippet ? 2 : 1,
      textEdit: { range, newText: text },
    });
  };
  // The document's own uses include the word being edited: never offer that one back.
  const current = state.sliceDoc(c.from, c.to);
  const used = (names: Iterable<string>) => [...names].filter((n) => n !== typed && n !== current);
  if (c.kind === "command") {
    const names = word
      ? [...POPULAR, ...Object.keys(COMMAND_ARGS), ...GLYPHS.keys(), ...a.defs.macros.keys(), ...used(a.mathUses.keys()), ...used(a.textUses.keys())]
      : POPULAR;
    for (const name of names) {
      const glyph = GLYPHS.get(name);
      add(name, 3, glyph ? `${glyph}, built-in` : a.defs.macros.has(name) ? "user-defined" : "built-in");
    }
    if (word) for (const [label, tpl, detail] of COMMAND_VARIANTS) add(label, 15, detail, snippetText(tpl), true);
  } else if (c.arg === "env" && c.command === "begin") {
    for (const name of [...Object.keys(ENVIRONMENTS), ...a.defs.environments, ...used(a.envUses.keys())]) {
      add(name, 13, a.defs.environments.has(name) ? "user-defined" : "built-in");
    }
  } else if (c.arg === "color") {
    for (const name of a.defs.colors) add(name, 16, "user-defined");
  }
}

/** The LaTeX CompletionSource: texlab (or null) + the built-in layer. */
export function latexCompletionSource(inner: LspCompletionBackend | null, env: LatexCompletionEnv = {}): CompletionSource {
  const analysis = analyses(env);
  return lspCompletionSource(latexBackend(inner, env, analysis), latexCompletionOptions(env, analysis));
}

/**
 * autocompletion's activateOnCompletion: accepting `\ref`, `\cite`, `\begin`, `\usepackage`...
 * (`\re` + Tab -> `\ref{|}`) opens the argument's list as if the `{` had been typed. An
 * implicit list, like the one `\ref{` typed by hand opens: Enter takes an entry only once
 * something is typed or the selection moved.
 */
export const opensArgumentList = (completion: Completion): boolean => opensArgument.has(completion);

/**
 * keyArbiter's completesWord: the cursor ends a command name (`\alp|`, not a bare `\` or
 * the `\\` line break), so a Tab in a snippet field waits for its list (`\frac{\alp|}{}`).
 */
export function typingCommand(state: EditorState): boolean {
  const c = latexContext(state, state.selection.main.head);
  return c?.kind === "command" && c.word !== "";
}
