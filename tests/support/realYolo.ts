// Loads YOLO's REAL InlineSuggestionController (o0e) and TabCompletionController (w0e),
// plus the helpers handleEditorChange needs (defaults `hs`, triggers `$y`, `qgt`), from an
// installed main.js (read-only; data.json is never read) and wraps them in a plugin object
// with YOLO's plugin-level method shapes, checked against main.js. run() is replaced by
// its synchronous prefix (title read, cancel, clear, suggestion object, render) without
// the provider call; respond() delivers model text through YOLO's own
// updateCandidatesFromRawText / finishCandidateGeneration.
//
// The slice markers are YOLO 1.6.9.7's minified names. A YOLO update that moves them makes
// loadYolo() throw: re-derive the markers, then re-run `npm run test:yolo`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import * as cmState from "@codemirror/state";
import * as cmView from "@codemirror/view";
import type { RunCall, YoloDouble, YoloSettings } from "./fakeYolo";

type Obj = Record<string, any>; // YOLO's minified objects

function cut(src: string, start: string, end: string, endInclude: number): { text: string; at: number } {
  const a = src.indexOf(start);
  if (a < 0) throw new Error("YOLO marker not found: " + start.slice(0, 60));
  const b = src.indexOf(end, a);
  if (b < 0) throw new Error("YOLO end marker not found: " + end.slice(0, 60));
  return { text: src.slice(a, b + endInclude), at: a };
}

// Plugin-level methods this double re-implements; each must still look like this in main.js.
const PLUGIN_SHAPES: [string, RegExp][] = [
  ["handleTabCompletionEditorChange delegates to handleEditorChange",
    /handleTabCompletionEditorChange\((\w+)\)\{this\.getTabCompletionController\(\)\.handleEditorChange\(\1\)\}/],
  ["getEditorView resolves editor.cm",
    /getEditorView\((\w+)\)\{if\(!\1\)return null;if\(this\.isEditorWithCodeMirror\(\1\)\)\{let\{cm:(\w+)\}=\1;if\(\2 instanceof [\w$]+\.EditorView\)return \2\}/],
  ["isEditorWithCodeMirror checks .cm instanceof EditorView",
    /isEditorWithCodeMirror\((\w+)\)\{return typeof \1!="object"\|\|\1===null\|\|!\("cm"in \1\)\?!1:\1\.cm instanceof [\w$]+\.EditorView\}/],
  ["getActiveFileTitle is a dep of the tab controller",
    /getActiveFileTitle:\(\)=>this\.app\.workspace\.getActiveFile\(\)\?\.basename/],
];

export interface RealYolo {
  file: string;
  sha256_16: string;
  /** YOLO's own accept-path Markdown escaper (e0e). */
  escapeForMarkdown(text: string, opts: Obj): string;
  make(opts: { settings: YoloSettings; version?: string; title?: string }): YoloDouble;
}

export function loadYolo(file: string): RealYolo {
  const src = readFileSync(file, "utf8");
  for (const [what, re] of PLUGIN_SHAPES) if (!re.test(src)) throw new Error(`YOLO main.js changed: ${what}`);
  const hs = cut(src, "hs={multipleCandidatesEnabled:", ",KA=6e4", 0);
  const trig = cut(src, '$y=[{id:"sentence-end-comma"', "],qgt=", 1);
  const qgt = cut(src, "qgt=t=>{let e=Math.round(t*4/5)", "},$6n=", 1);
  cut(src, 'Bz="{{tab_completion_constraints}}"', '"', 0);
  const split = cut(src, "WJo=5,L0n=", ",QJo=", 0);
  const s1 = cut(src, 'var QRn=require("@codemirror/state"),r0e=require("@codemirror/view")', '}};u();var a0n=require("@codemirror/state")', 2);
  const s2 = cut(src, "w0e=class{constructor(e){this.deps=e;", "return o.setCursor(c),!0}};", "return o.setCursor(c),!0}}".length);
  const req = (m: string) => {
    if (m === "@codemirror/state") return cmState;
    if (m === "@codemirror/view") return cmView;
    throw new Error("unexpected require " + m);
  };
  const body =
    `var ${hs.text}; var ${trig.text}; var ${qgt.text}; var Bz="{{tab_completion_constraints}}"; var ${split.text};\n` +
    `${s1.text};\nvar ${s2.text};\n` +
    "return { InlineSuggestionController: o0e, TabCompletionController: w0e, escapeForMarkdown: e0e };";
  const mod = new Function("require", "u", body)(req, () => {}) as Obj;

  const make = ({ settings, version = "1.6.9.7", title = "yolo-basename" }: { settings: YoloSettings; version?: string; title?: string }) => {
    const runCalls: RunCall[] = [];
    const activeAbortControllers = new Set<AbortController>();
    const getEditorView = (e: unknown) => {
      const cm = (e as { cm?: unknown } | null)?.cm;
      return cm instanceof cmView.EditorView ? cm : null;
    };
    const double = { settings, runCalls, activeAbortControllers, isContinuationInProgress: false } as YoloDouble;
    const inline: Obj = new mod.InlineSuggestionController({
      getEditorView,
      getTabCompletionController: () => tab,
    });
    const tab: Obj = new mod.TabCompletionController({
      getSettings: () => double.settings,
      setSettings: () => {},
      getEditorView,
      getActiveMarkdownView: () => null,
      getActiveConversationOverrides: () => ({}),
      resolveContinuationParams: () => ({}),
      getActiveFileTitle: () => title,
      setTabCompletionDisplay: (v: unknown, d: unknown) => inline.setTabCompletionDisplay(v, d),
      setInlineSuggestionGhost: (v: unknown, d: unknown) => inline.setInlineSuggestionGhost(v, d),
      showTabLoadingDots: (v: unknown, d: unknown) => inline.showTabLoadingDots(v, d),
      hideTabLoadingDots: (v: unknown) => inline.hideTabLoadingDots(v),
      getSwitchSuggestionHint: () => "↑↓ 切换建议",
      clearInlineSuggestion: () => inline.clearInlineSuggestion(),
      setActiveInlineSuggestion: (s: unknown) => inline.setActiveInlineSuggestion(s),
      addAbortController: (c: AbortController) => activeAbortControllers.add(c),
      removeAbortController: (c: AbortController) => activeAbortControllers.delete(c),
      isContinuationInProgress: () => double.isContinuationInProgress,
    });
    // The synchronous prefix of w0e.run, minus the provider call.
    tab.run = function (e: { getSelection(): string }, head: number, replaceFrom?: number | null) {
      const view = this.deps.getEditorView(e) as cmView.EditorView | null;
      if (!double.settings.continuationOptions.enableTabCompletion || double.isContinuationInProgress) return Promise.resolve();
      if (!view || view.state.selection.main.head !== head || e.getSelection()?.length) return Promise.resolve();
      const t = this.deps.getActiveFileTitle();
      const from = replaceFrom === undefined ? this.getTriggerMatch(view, head)?.replaceFromOffset ?? null : replaceFrom;
      runCalls.push({ title: t, head, replaceFromOffset: from });
      this.cancelRequest();
      this.deps.clearInlineSuggestion();
      this.tabCompletionPending = null;
      const s = {
        editor: e, view, cursorOffset: head, replaceFromOffset: from, selectedIndex: 0, hasUserNavigated: false,
        multipleCandidates: true,
        candidates: [{ text: "", status: "generating" }, { text: "", status: "pending" }, { text: "", status: "pending" }],
      };
      this.tabCompletionSuggestion = s;
      this.renderSuggestion(s);
      const abort = new AbortController();
      this.tabCompletionAbortController = abort;
      this.deps.addAbortController(abort);
      return Promise.resolve();
    };
    Object.assign(double, {
      tab,
      inline,
      respond(raw: string, { finish = true } = {}) {
        const s = tab.tabCompletionSuggestion;
        if (!s) return false;
        tab.updateCandidatesFromRawText(s, raw);
        if (finish) tab.finishCandidateGeneration(s, false);
        return true;
      },
      plugin: {
        manifest: { id: "yolo", version },
        getInlineSuggestionController: () => inline,
        getTabCompletionController: () => tab,
        getEditorView,
        handleTabCompletionEditorChange: (e: unknown) => tab.handleEditorChange(e),
      },
    });
    return double;
  };

  return {
    file,
    sha256_16: createHash("sha256").update(src).digest("hex").slice(0, 16),
    escapeForMarkdown: mod.escapeForMarkdown,
    make,
  };
}
