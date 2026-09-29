// Shared with obsidian-latex-live / obsidian-tinymist: keep byte-identical (canonical copy: obsidian-tinymist/src/editor/shared).
//
// LSP textDocument/completion -> CodeMirror CompletionSource, used with tinymist and texlab.
//   - Every item is passed on (no truncation); CM renders at most 100 rows itself.
//   - validFor only for complete lists: an isIncomplete list is re-queried on every key.
//   - Each item's own textEdit range (or InsertReplaceEdit `replace`) is honoured, including
//     an end past the cursor (mid-word), and additionalTextEdits land in the same
//     transaction (tinymist postfix items).
//   - Snippets keep their numbering (lspSnippet.ts); a snippet without tab stops, like
//     plain text, leaves the cursor after the insertion.
//   - Server order survives through sortText (CM breaks score ties with it). Complete
//     lists whose items carry a filterText (texlab citations) are filtered on it here.
//   - Implicit requests follow the server's trigger characters plus an activation policy;
//     nothing is requested while an IME composition is open.
// Only type imports from "obsidian" are allowed here: tests bundle this without Obsidian.
import {
  Completion,
  CompletionContext,
  CompletionInfo,
  CompletionResult,
  CompletionSource,
  pickedCompletion,
  snippet,
} from "@codemirror/autocomplete";
import { EditorState, Text, Transaction, TransactionSpec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { lspSnippetPlain, lspSnippetToCm } from "./lspSnippet";

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspInsertReplaceEdit {
  newText: string;
  insert: LspRange;
  replace: LspRange;
}

export type LspMarkup = string | { kind?: string; value: string };

export interface LspCompletionItem {
  label: string;
  labelDetails?: { detail?: string; description?: string };
  kind?: number;
  tags?: number[];
  detail?: string;
  documentation?: LspMarkup;
  deprecated?: boolean;
  preselect?: boolean;
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number;
  textEdit?: LspTextEdit | LspInsertReplaceEdit;
  textEditText?: string;
  additionalTextEdits?: LspTextEdit[];
  commitCharacters?: string[];
  data?: unknown;
}

export interface LspCompletionList {
  isIncomplete?: boolean;
  itemDefaults?: {
    commitCharacters?: string[];
    editRange?: LspRange | { insert: LspRange; replace: LspRange };
    insertTextFormat?: number;
    data?: unknown;
  };
  items: LspCompletionItem[];
}

/** LSP CompletionContext: 1 Invoked, 2 TriggerCharacter, 3 TriggerForIncompleteCompletions. */
export interface LspCompletionContext {
  triggerKind: 1 | 2 | 3;
  triggerCharacter?: string;
}

export interface LspCompletionBackend {
  /**
   * textDocument/completion at `pos`; resolves to a CompletionList, an item array or null.
   * `state` is the document the position refers to (sync it first if sync is deferred).
   */
  request(pos: LspPosition, context: LspCompletionContext, state: EditorState): Promise<unknown>;
  /** completionItem/resolve; called lazily for the info panel of items that carry `data`. */
  resolve?(item: LspCompletionItem): Promise<unknown>;
  /** completionProvider.triggerCharacters from the initialize result. */
  triggerCharacters(): readonly string[];
}

/** The main edit of one candidate, in document offsets of the request state. */
export interface CompletionEdit {
  from: number;
  /** May lie past the cursor (the server replaces the rest of the word). */
  to: number;
  /** Inserted text; LSP snippet syntax when `snippet` is true. */
  text: string;
  snippet: boolean;
  /** additionalTextEdits, applied in the same transaction. */
  additional: { from: number; to: number; insert: string }[];
}

export interface ActivationInfo {
  /** The character before the cursor when it is one of the server's trigger characters. */
  trigger: string | null;
  /** Text matched by `wordPattern` right before the cursor ("" when none). */
  word: string;
}

export type InfoRenderer = (
  doc: { kind: "markdown" | "plaintext"; value: string },
  item: LspCompletionItem,
) => CompletionInfo | Promise<CompletionInfo>;

export interface LspCompletionOptions {
  /**
   * Whether typing (not an explicit request) should query the server. Default: after a
   * trigger character, or when the word before the cursor has `minWordLength` chars.
   * Explicit requests and re-queries of an incomplete list skip this check.
   */
  activate?(ctx: CompletionContext, info: ActivationInfo): boolean;
  /** Default activation threshold (2). */
  minWordLength?: number;
  /** Word before the cursor, anchored at the end (default ASCII identifier, `-` allowed). */
  wordPattern?: RegExp;
  /** validFor for complete lists; `from` is the result start. Default: identifier chars. */
  validFor?(ctx: CompletionContext, from: number): CompletionResult["validFor"];
  /**
   * Per-item hook: may change `option` (boost, detail, type, section...) and `edit` (text,
   * snippet, range). Return false to drop the item.
   */
  augment?(
    item: LspCompletionItem,
    option: Completion,
    edit: CompletionEdit,
    ctx: CompletionContext,
  ): boolean | void;
  /** Final pass over all options (reorder, re-boost, add built-in options). */
  rank?(options: Completion[], ctx: CompletionContext, from: number): Completion[];
  /** Symbol glyph for the glyph column; default: tinymist labelDetails / texlab detail. */
  glyph?(item: LspCompletionItem): string | null;
  /** Renders documentation for the info panel (e.g. Obsidian's MarkdownRenderer). */
  renderInfo?: InfoRenderer;
}

export function lspPosToOffset(doc: Text, pos: LspPosition): number {
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(Math.max(0, pos.line) + 1);
  return Math.min(line.from + Math.max(0, pos.character), line.to);
}

export function offsetToLspPos(doc: Text, offset: number): LspPosition {
  const line = doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

const KIND_TYPES: Record<number, string> = {
  1: "text",
  2: "method",
  3: "function",
  4: "function",
  5: "property",
  6: "variable",
  7: "class",
  8: "interface",
  9: "namespace",
  10: "property",
  11: "constant",
  12: "constant",
  13: "enum",
  14: "keyword",
  15: "snippet",
  16: "color",
  17: "file",
  18: "reference",
  19: "folder",
  20: "constant",
  21: "constant",
  22: "class",
  23: "event",
  24: "keyword",
  25: "type",
};

const DEFAULT_WORD = /[A-Za-z_][A-Za-z0-9_-]*$/;
const DEFAULT_VALID = /^[A-Za-z0-9_-]*$/;

/** A short non-ASCII symbol (a rendered glyph), not a word or a signature. */
function isGlyph(s: string): boolean {
  return [...s].length <= 3 && !/[A-Za-z0-9\s]/.test(s);
}

/**
 * Default glyph: tinymist puts the symbol in labelDetails.description ("α"), texlab in
 * front of detail ("α, built-in").
 */
export function defaultGlyph(item: LspCompletionItem): string | null {
  const desc = item.labelDetails?.description;
  if (desc && isGlyph(desc)) return desc;
  const m = item.detail ? /^(\S{1,4}), /u.exec(item.detail) : null;
  return m && isGlyph(m[1]) ? m[1] : null;
}

function markup(doc: LspMarkup | undefined): { kind: "markdown" | "plaintext"; value: string } | null {
  if (doc == null) return null;
  const value = typeof doc === "string" ? doc : doc.value;
  if (!value?.trim()) return null;
  const kind = typeof doc !== "string" && doc.kind === "markdown" ? "markdown" : "plaintext";
  // texlab writes VS Code image sizes into the URL: ![x](data:...|width=48,height=48)
  return { kind, value: value.replace(/\|width=\d+,height=\d+\)/g, ")") };
}

function plainInfo(doc: { value: string }): CompletionInfo {
  const dom = document.createElement("div");
  dom.className = "lsp-completion-info";
  dom.textContent = doc.value;
  return dom;
}

const glyphs = new WeakMap<Completion, string>();
const filterTexts = new WeakMap<Completion, string>();

/**
 * autocompletion({ addToOptions: [lspGlyphColumn] }): renders the symbol glyph of LSP
 * options next to the kind icon (editor.css hides the icon when a glyph is shown).
 */
export const lspGlyphColumn = {
  position: 21,
  render(completion: Completion): Node | null {
    const glyph = glyphs.get(completion);
    if (!glyph) return null;
    const span = document.createElement("span");
    span.className = "lsp-completion-glyph";
    span.textContent = glyph;
    return span;
  },
};

function editOf(
  item: LspCompletionItem,
  list: LspCompletionList | null,
  doc: Text,
  wordFrom: number,
  pos: number,
): CompletionEdit {
  const defaults = list?.itemDefaults;
  const te = item.textEdit;
  const dr = defaults?.editRange;
  const range = te
    ? "range" in te ? te.range : te.replace
    : dr ? ("replace" in dr ? dr.replace : dr) : null;
  const text = te ? te.newText : item.textEditText ?? item.insertText ?? item.label;
  const from = range ? Math.min(lspPosToOffset(doc, range.start), pos) : wordFrom;
  const to = range ? Math.max(lspPosToOffset(doc, range.end), from) : pos;
  return {
    from,
    to,
    text,
    snippet: (item.insertTextFormat ?? defaults?.insertTextFormat) === 2,
    additional: (item.additionalTextEdits ?? []).map((e) => ({
      from: lspPosToOffset(doc, e.range.start),
      to: lspPosToOffset(doc, e.range.end),
      insert: e.newText,
    })),
  };
}

/**
 * Apply function for edits CM cannot express as a string: ranges that do not start at
 * the result start or end past the cursor, additionalTextEdits, snippets with fields.
 * Uses only view.state/view.dispatch, so keyArbiter's smart-Enter dry run can probe it.
 */
function applyEdit(edit: CompletionEdit, requestFrom: number, requestPos: number) {
  return (view: EditorView, completion: Completion, from: number, to: number): void => {
    const state = view.state;
    // Offsets are from the request state. CM maps the result range since then: `shift`
    // covers edits before it, `typed` the characters typed at the cursor.
    const shift = from - requestFrom;
    const typed = to - requestPos - shift;
    const len = state.doc.length;
    const map = (p: number, atCursorMoves: boolean) => {
      const moved = p > requestPos || (atCursorMoves && p === requestPos);
      return Math.min(len, Math.max(0, p + shift + (moved ? typed : 0)));
    };
    const additional = edit.additional.map((a) => ({
      from: map(a.from, false),
      to: map(a.to, false),
      insert: a.insert,
    }));
    let start = map(edit.from, false);
    let end = map(edit.to, true);
    // The main range in the document after the additional edits (applied first).
    const mid = additional.length ? state.update({ changes: additional }) : null;
    if (mid) {
      start = mid.changes.mapPos(start, 1);
      end = Math.max(start, mid.changes.mapPos(end, start < end ? -1 : 1));
    }
    const plain = edit.snippet ? lspSnippetPlain(edit.text) : edit.text;
    const common = {
      scrollIntoView: true,
      annotations: [pickedCompletion.of(completion), Transaction.userEvent.of("input.complete")],
      sequential: true,
    };
    let main: TransactionSpec;
    if (plain != null) {
      main = {
        ...common,
        changes: { from: start, to: end, insert: plain },
        selection: { anchor: start + plain.length },
      };
    } else {
      // snippet() dispatches its own transaction; capture it to merge with the edits above.
      let tr: Transaction | null = null;
      snippet(lspSnippetToCm(edit.text))(
        { state: mid?.state ?? state, dispatch: (t) => (tr = t) },
        completion,
        start,
        end,
      );
      const t = tr as Transaction | null;
      if (!t) return;
      main = { ...common, changes: t.changes, selection: t.selection, effects: t.effects };
    }
    view.dispatch(mid ? state.update({ changes: additional }, main) : state.update(main));
  };
}

function itemKey(it: LspCompletionItem, edit: CompletionEdit): string {
  return [it.label, it.kind, edit.text, edit.from, edit.to].join("\u0000");
}

export function lspCompletionSource(
  backend: LspCompletionBackend,
  opts: LspCompletionOptions = {},
): CompletionSource {
  const wordPattern = opts.wordPattern ?? DEFAULT_WORD;
  const minWord = opts.minWordLength ?? 2;
  const glyphOf = opts.glyph ?? defaultGlyph;
  // Where the last incomplete list started, per view: typing on re-queries it (kind 3).
  const incomplete = new WeakMap<object, { from: number; prefix: string }>();
  const noView = {};

  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (ctx.view?.compositionStarted) return null;
    const key = ctx.view ?? noView;
    const prev = ctx.pos > 0 ? ctx.state.sliceDoc(ctx.pos - 1, ctx.pos) : "";
    const trigger = backend.triggerCharacters().includes(prev) ? prev : null;
    const wordMatch = ctx.matchBefore(wordPattern);
    const word = wordMatch?.text ?? "";
    // Typing on (or backspacing within) the word of an incomplete list re-queries it.
    const last = incomplete.get(key);
    incomplete.delete(key);
    const typedNow = last && ctx.pos >= last.from ? ctx.state.sliceDoc(last.from, ctx.pos) : null;
    const continues =
      !!last && typedNow !== null && !/\s/.test(typedNow) &&
      (typedNow.startsWith(last.prefix) || last.prefix.startsWith(typedNow));
    let context: LspCompletionContext;
    if (ctx.explicit) context = { triggerKind: 1 };
    else if (trigger) context = { triggerKind: 2, triggerCharacter: trigger };
    else if (continues) context = { triggerKind: 3 };
    else context = { triggerKind: 1 };
    if (!ctx.explicit && !continues) {
      const info = { trigger, word };
      const go = opts.activate ? opts.activate(ctx, info) : trigger !== null || word.length >= minWord;
      if (!go) return null;
    }

    let raw: unknown;
    try {
      raw = await backend.request(offsetToLspPos(ctx.state.doc, ctx.pos), context, ctx.state);
    } catch {
      return null;
    }
    if (ctx.aborted || raw == null) return null;
    const list = Array.isArray(raw) ? null : (raw as LspCompletionList);
    const items = (list ? list.items : (raw as LspCompletionItem[])) ?? [];
    if (!items.length) return null;

    const doc = ctx.state.doc;
    const wordFrom = wordMatch ? wordMatch.from : ctx.pos;
    const byKey = new Map<string, { item: LspCompletionItem; edit: CompletionEdit }>();
    for (const item of items) {
      if (!item.label) continue; // texlab's control-space entry
      const edit = editOf(item, list, doc, wordFrom, ctx.pos);
      const k = itemKey(item, edit);
      const seen = byKey.get(k);
      // tinymist sends some items twice (signature vs docs): keep one, merge the docs.
      if (seen) seen.item = { ...seen.item, documentation: seen.item.documentation ?? docsOf(item) };
      else byKey.set(k, { item, edit });
    }

    const built: { option: Completion; edit: CompletionEdit }[] = [];
    for (const { item, edit } of byKey.values()) {
      const glyph = glyphOf(item);
      const single = item.detail && !item.detail.includes("\n") ? item.detail : undefined;
      let detail = item.labelDetails?.description ?? item.labelDetails?.detail ?? single;
      if (glyph && detail === glyph) detail = undefined;
      else if (glyph && detail?.startsWith(glyph + ", ")) detail = detail.slice(glyph.length + 2);
      const deprecated = item.deprecated || item.tags?.includes(1);
      const option: Completion = {
        label: item.label,
        detail,
        // A second type word only adds an icon class (editor.css strikes the label through).
        type: (KIND_TYPES[item.kind ?? 1] ?? "text") + (deprecated ? " deprecated" : ""),
        sortText: item.sortText,
        boost: item.preselect ? 1 : undefined,
        commitCharacters: item.commitCharacters ?? list?.itemDefaults?.commitCharacters,
      };
      if (opts.augment?.(item, option, edit, ctx) === false) continue;
      option.info ??= infoFor(item, backend, opts.renderInfo);
      if (glyph) glyphs.set(option, glyph);
      if (item.filterText && item.filterText !== item.label) filterTexts.set(option, item.filterText);
      built.push({ option, edit });
    }
    if (!built.length) return null;

    const from = Math.min(...built.map((b) => b.edit.from));
    let options = built.map(({ option, edit }) => {
      const plain = edit.snippet ? lspSnippetPlain(edit.text) : edit.text;
      // CM's own string insert (multi-cursor aware) when nothing else is needed.
      const simple = plain != null && !edit.additional.length && edit.from === from && edit.to === ctx.pos;
      option.apply = simple ? plain : applyEdit(edit, from, ctx.pos);
      return option;
    });
    if (opts.rank) options = opts.rank(options, ctx, from);
    if (list?.isIncomplete) {
      incomplete.set(key, { from, prefix: ctx.state.sliceDoc(from, ctx.pos) });
      return { from, options };
    }
    if (options.some((o) => filterTexts.has(o))) {
      return filteredByText(options, from, ctx.state.sliceDoc(from, ctx.pos));
    }
    return { from, options, validFor: opts.validFor ? opts.validFor(ctx, from) : DEFAULT_VALID };
  };
}

/**
 * A complete list whose items carry their own filterText (texlab citations: key, entry
 * type, title, authors) is filtered here: CM's matcher only sees the label, and it matches
 * a one-character query only at the label start, so `\cite{M` could never reach "Masked".
 * Every query word must occur in the filterText; label-prefix matches come first. Typing
 * `,` `{` `}` or `\` ends the local filtering and queries the server again.
 */
function filteredByText(all: readonly Completion[], from: number, query: string): CompletionResult | null {
  const q = query.toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const hits = all.filter((o) => {
    const text = (filterTexts.get(o) ?? o.label).toLowerCase();
    return words.every((w) => text.includes(w));
  });
  const prefix = new Set(hits.filter((o) => o.label.toLowerCase().startsWith(q)));
  const options = [...prefix, ...hits.filter((o) => !prefix.has(o))];
  if (!options.length) return null;
  return {
    from,
    options,
    filter: false,
    update: (_current, start, to, ctx) => {
      const text = ctx.state.sliceDoc(start, to);
      return /[{},\\\n]/.test(text) ? null : filteredByText(all, start, text);
    },
  };
}

/** Documentation of an item; tinymist sends multi-line docs in `detail`. */
function docsOf(item: LspCompletionItem): LspMarkup | undefined {
  if (item.documentation != null) return item.documentation;
  return item.detail?.includes("\n") ? { kind: "markdown", value: item.detail } : undefined;
}

function infoFor(
  item: LspCompletionItem,
  backend: LspCompletionBackend,
  render: InfoRenderer | undefined,
): Completion["info"] {
  const local = markup(docsOf(item));
  const canResolve = !!backend.resolve && item.data !== undefined && !item.documentation;
  if (!local && !canResolve) return undefined;
  return async () => {
    let doc = local;
    let full = item;
    if (canResolve) {
      try {
        full = { ...item, ...((await backend.resolve!(item)) as LspCompletionItem | null) };
        doc = markup(full.documentation) ?? doc;
      } catch {
        // keep what the list had
      }
    }
    if (!doc) return null;
    return render ? render(doc, full) : plainInfo(doc);
  };
}
