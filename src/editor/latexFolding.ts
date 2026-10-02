import { codeFolding, foldAll, foldCode, foldEffect, foldGutter, foldKeymap, foldService, foldedRanges, unfoldEffect } from "@codemirror/language";
import { RangeSet, RangeValue, StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, type Command } from "@codemirror/view";
import { projectSignatures } from "../export/signatures";
import { parseTex } from "../export/texTree";
import { emptyDefinitions } from "../tex/macros";
import { semanticFolds, type SemanticFold } from "../tex/outline";

// No TeX/LSP work here. A fold scan is separate from the edit transaction: existing ranges
// map cheaply through changes, then one idle rebuild (or a deliberate fold action) updates
// the structural index. Never parse the whole source from the gutter's per-line callback.
const SIG = projectSignatures(emptyDefinitions(), [], new Map());
const IDLE_MS = 400;
class FoldRange extends RangeValue {
  constructor(readonly fromDelta: number, readonly kind: SemanticFold["kind"], readonly name: string) { super(); }
  startSide = -1;
  endSide = 1;
}
interface FoldIndex {
  ranges: RangeSet<FoldRange>;
  /** Identity of the last source indexed. Changes never convert the doc to a string. */
  doc: Text | null;
  scans: number;
}
const setIndex = StateEffect.define<{ ranges: RangeSet<FoldRange>; doc: Text }>();

function scan(doc: Text): RangeSet<FoldRange> {
  const text = doc.toString();
  return RangeSet.of(semanticFolds(text, parseTex(text, SIG)).map((f) =>
    new FoldRange(f.from - f.anchor, f.kind, f.name).range(f.anchor, f.to)), true);
}

const foldIndex = StateField.define<FoldIndex>({
  create: () => ({ ranges: RangeSet.empty, doc: null, scans: 0 }),
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(setIndex) && effect.value.doc === tr.newDoc) {
      return { ...effect.value, scans: value.scans + 1 };
    }
    return tr.docChanged ? { ...value, ranges: value.ranges.map(tr.changes) } : value;
  },
});

/** Freshen the index only for an explicit command or gutter click. IME never gets folded. */
export function ensureLatexFoldIndex(view: EditorView): boolean {
  const index = view.state.field(foldIndex, false);
  if (!index || view.compositionStarted) return false;
  if (index.doc !== view.state.doc) view.dispatch({ effects: setIndex.of({ ranges: scan(view.state.doc), doc: view.state.doc }) });
  return true;
}

/** Diagnostic counters for the performance smoke; counts index rebuilds, not CM updates. */
export function latexFoldStats(state: EditorState): { scans: number; ranges: number; fresh: boolean } {
  const index = state.field(foldIndex, false);
  return { scans: index?.scans ?? 0, ranges: index?.ranges.size ?? 0, fresh: index?.doc === state.doc };
}

const source = foldService.of((state, lineFrom, lineTo) => {
  const index = state.field(foldIndex, false);
  if (!index) return null;
  let range: { from: number; to: number } | null = null;
  index.ranges.between(lineFrom, lineTo, (anchor, to, value) => {
    const from = anchor + value.fromDelta;
    if (anchor >= lineFrom && anchor <= lineTo && from <= state.doc.length && to > from && (!range || to > range.to)) range = { from, to };
  });
  return range;
});

const idleIndex = ViewPlugin.fromClass(class {
  timer: ReturnType<typeof setTimeout> | null = null;
  destroyed = false;
  constructor(readonly view: EditorView) { this.schedule(0); }
  update(update: { docChanged: boolean; view: EditorView }): void {
    if (update.docChanged) this.schedule(IDLE_MS);
  }
  schedule(delay: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.destroyed) return;
      if (this.view.compositionStarted) { this.schedule(IDLE_MS); return; }
      ensureLatexFoldIndex(this.view);
    }, delay);
  }
  destroy(): void { this.destroyed = true; if (this.timer !== null) clearTimeout(this.timer); }
});

const fresh = (command: Command): Command => (view) => ensureLatexFoldIndex(view) && command(view);
export const foldLatexSection = fresh(foldCode);
export const foldAllLatex = fresh(foldAll);

/** Mount after keyArbiter; the standard fold bindings claim none of its owned keys. */
export const latexFolding: Extension = [
  foldIndex, source, codeFolding(), idleIndex,
  foldGutter({
    foldingChanged: (update) => update.transactions.some((tr) => tr.effects.some((e) => e.is(setIndex))),
    domEventHandlers: {
      click: (view, line) => {
        if (!ensureLatexFoldIndex(view)) return true;
        let folded: { from: number; to: number } | null = null;
        foldedRanges(view.state).between(line.from, line.to, (from, to) => { folded = { from, to }; });
        if (folded) view.dispatch({ effects: unfoldEffect.of(folded) });
        else {
          const range = view.state.facet(foldService).map((service) => service(view.state, line.from, line.to)).find(Boolean);
          if (range) view.dispatch({ effects: foldEffect.of(range) });
        }
        return true;
      },
    },
  }),
  keymap.of(foldKeymap.map((binding) => ({ ...binding, run: binding.run ? fresh(binding.run) : undefined }))),
];
