import type { Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { CropKind } from "../preview/blockCrop";
import { blockEnvKind, type EnvRules } from "../tex/envRules";
import type { TheoremDef, TheoremMap } from "../tex/theorems";
import { texText } from "../tex/texText";
import { LatexRefs, citeText, formulaRefs, refText } from "./latexRefs";
import { LatexArg, LatexBanner, LatexConstruct, LatexEnv, LatexMath, LatexTitlePage, TextStyle, blocksAround, hasConstructs, scanLatex } from "./latexScan";
import { TablePart, cellParts, parseTabular, tableSpec } from "./latexTable";
import { prepareMath } from "./mathjaxProject";
import { LiveContext, LiveLanguage, RenderWidget, TextWidget, renderConstruct } from "./shared/livePreview";

// LaTeX's live preview (design 4.4): what each construct of latexScan looks like in place. Pure
// (no view, no Obsidian), so tests run it on the real editor stack. The shared core
// (livePreview.ts) owns reveal, widgets, scheduling and keys; formulas go through its
// `renderConstruct`.
//   #1  `$..$`, `\(..\)`: an inline widget, source while touched.
//   #2  `\[..\]`, `$$..$$`: a block widget over its lines when it owns them (latexScan's
//       `block`), else an inline display widget in the running text. A revealed block keeps
//       its rendering below the source.
//   #3  math environments (equation, align, gather, multline, flalign, alignat, eqnarray,
//       displaymath, starred too): the whole environment goes to MathJax, as #2.
//   #4  a formula MathJax rejects (tikz-cd, \intertext, an undefined macro): a block formula
//       whose text the last compile saw shows its PDF crop (see #14); otherwise, and in running
//       text, it keeps its source with the dotted `lsp-lp-error` underline (the render hover
//       shows the message).
//   #5  a heading's line gets `lsp-lp-h1`..`h6` (kept while revealed); `\section{`, a
//       `[short]` title and the closing `}` are hidden until the cursor touches either end.
//   #6  \textbf, \textit, \emph, \underline, \texttt, \textsc: a mark on the content, the
//       command and braces hidden until the construct is touched.
//   #7  \item: a bullet (• ◦ ▪ by depth), a number (1. / (a) / i. by depth, or the list's
//       enumerate short form or enumitem `label=`, `resume`, `series`), its own [label], or a
//       description's bold term; only touching the token reveals it, so typing after it keeps
//       the marker. A label with math or a reference stays in place (`\item[` and `]` hidden, a
//       term's text bold, its formulas rendered): touching `\item[` or `]` reveals them.
//   #8  the \begin (with its arguments) and \end lines of the wrapper environments (env.rules:
//       lists, center, figure, table, subequations, minipage, ... and the user's) collapse (a block
//       replace without a widget) until the cursor is on them; the content renders as usual.
//   #15 the hidden commands (env.rules: \centering, \vspace{..}, ... and the user's) hide with
//       their arguments until the cursor touches them; one alone on its lines collapses them.
//   #16 \caption{..} in a figure or table: `Figure n: ` / `Table n: ` for `\caption{` (its number
//       from the caption's label in the .aux), the content in place; without a number only the
//       command and braces hide. Touching either end reveals them.
//   #9  \ref, \eqref, \pageref, \autoref, \cref, \Cref, \nameref: a chip with what the PDF prints
//       from the last compile's .aux (latexRefs: `1.2`, `(1.2)`, hyperref's `section 1.2`,
//       cleveref's `eqs. (1) and (2)`); `??` in the warning colour when a label is unknown. Its
//       tooltip is the source.
//   #10 \cite and natbib's and biblatex's relatives (\citep, \Citet, \citealp, \parencite,
//       \textcite, \autocite, \footcite, ...): a chip `[see Li et al. 2019, p. 3]` from the
//       project's .bib files; unknown keys show as keys, in the warning colour. Its tooltip names
//       each key's entry.
//   #11 \label outside math: a faint chip with the key.
//   #12 a theorem-like environment of the project's theorem map (refs.theorems: amsthm's proof,
//       \newtheorem, elegantbook's boxes and heads, \elegantnewtheorem) whose \begin and \end
//       are alone on their lines: a BlockWrapper box over its lines (`lsp-lp-box`, the colour
//       role `is-main|second|third` and elegantbook's scheme colour in `--lp-box-color`). The
//       \begin line shows the head as the PDF prints it (`定理 1.1 (全期望公式)`, `Theorem 2
//       (Cauchy).`, `例题 1.1 抛硬币`, `Proof.`; the number from the head's label in the .aux:
//       elegantbook's `{title}{label}` is `thm:label`, else a \label right after the arguments or
//       first on the next line; without one, see boxNumber); a title with math or a reference
//       stays in place between the head's parts, its constructs rendered, and arguments the
//       environment does not take stay as text (`\begin{proof}[x]` under elegantbook). The \end
//       line collapses; amsthm's proof shows its □ there (right-aligned). Each of the two lines
//       shows its source while the cursor is on it; the body is ordinary text, so editing it
//       keeps the box; boxes nest.
//   #13 \includegraphics alone on its line: a block image widget (env.image resolves the file:
//       the root's folder, \graphicspath, graphicx's extensions; a PDF's first page); the source
//       while the cursor is on the line, the image staying below it. A file that is not found
//       keeps the source with the dotted error underline (its tooltip says why); a path with a
//       macro in it, or a bare name found nowhere (TeX may find it in its tree), stays source
//       without it.
//   #14 a TikZ picture (envRules' BLOCK_ENVS: tikzpicture, tikzcd, pgfpicture, circuitikz) whose
//       \begin and \end are alone on their lines: a block widget with its crop from the last
//       compile's PDF (env.crop: blockCrop.ts, while a preview holds the root's session and the
//       block's text is the one compiled), in a paper card; the source while the cursor is on
//       its lines, with no preview below (the crop would be stale). A new result's crop replaces
//       the last one when it lands (the old one stays meanwhile); changed or without a crop, it
//       is source. Nothing inside a tcolorbox (elegantbook's theorems) is cropped: SyncTeX
//       places what pgf moved ~20 pt off (cropKindOf). Tables are never cropped (#23).
//   #17 the lines after \centering and in a center environment are centered (a line class; papers
//       too); they stay text.
//   Beamer (env.rules.beamer; docs/beamer.md):
//   #18 a frame whose \begin and \end are alone on their lines: a card over its lines (a
//       BlockWrapper, as #12). Its \begin line is the title bar: `\begin{frame}`, `[options]` and
//       the braces hide, the title and subtitle stay in place (their formulas rendered); a
//       \frametitle or \framesubtitle line is styled the same, its command and braces hidden. The
//       frame's PDF page (env.framePage: the .nav) sits in the bar's corner; a click shows it
//       in the preview (env.showPage). The \end line collapses. Each line shows its source while
//       the cursor is on it; the body is text.
//   #19 a banner command's call (a \newcommand whose body is a frame: \sectionframe): a banner
//       card, its arguments in place and the markup between them hidden; its page as #18.
//   #20 \titlepage (\maketitle) alone on its line: one line `▸ Title page`, as #22 folds a
//       picture; source while the cursor is on its line (a click on the line puts it there).
//   #21 overlays: the `<..>` of \item and \only, \onslide, \uncover, \visible, \alt hides with
//       their braces (the content stays); \pause is a hidden command (#15).
//   #22 a TikZ picture is not cropped unless env.beamerCrops(): it folds to one line
//       `▸ TikZ (n lines)` until the cursor enters it (a click on the line puts it there). With
//       it, it crops as in a paper, from its position record (blockCrop's Positions; SyncTeX
//       places a frame as a whole page, and answers only where the records do not).
//   #23 a table (BLOCK_ENVS: tabular, tabular*, tabularx, longtable), in papers and in beamer,
//       whose \begin and \end are alone on their lines (the \begin line may go on with \toprule
//       or \hline, the \end line with a wrapper's \end or a shell's `}`): a table widget over its
//       lines (latexTable: columns, rows, rules, \multicolumn and \multirow spans, a longtable's
//       head once), its cells' formulas, styles and chips as in the running text and
//       their other text as it prints (an unknown command as written); a cell with a formula
//       MathJax rejects shows its source. Inside a center environment it is centered. The source
//       while the cursor is on its lines, with nothing below; one the parse cannot follow
//       (unbalanced braces, a tabular inside, rows that do not fit the columns) stays source. A
//       \resizebox, \scalebox or \rotatebox around it is a shell (latexScan's tableShell): its
//       lines collapse like a wrapper's, and the table shows at its normal size.
// A construct with an error diagnostic on it stays source (the lint underline shows).
// Numbers: a request carries the formula already prepared for MathJax (prepareMath: `\label`
// -> `\tag{n}` from the root's last compile, a reference -> the chip's text), so a compile
// that renumbers labels re-renders only the formulas whose text changed; the renderer's epoch
// covers the definitions alone, and image and crop requests are epoch-free (a definitions change
// never draws a PDF page or a crop again). TexRender tells the views to rebuild when the labels,
// the bibliography or the reference names change (through the renderer's subscribers).
// Everything else (the preamble and the files the root reads before \begin{document}, comments,
// verbatim, `\iffalse` blocks, \footnote and unknown environments) stays source.

export interface LatexLiveEnv {
  /** The formula, wrapper and hidden-command rules (TexRender's `rulesOf`); the built-in defaults without. */
  rules?: EnvRules;
  /** The root's references, read at every build (TexRender's `refsOf`); a new object when they change. */
  refs(): LatexRefs;
  /** Editor-only profile overrides, independent of the native reference/TeX definitions. */
  visualization?(): import("./templateVisualization").TemplateVisualization;
  /**
   * The document's \include name (`chapters/ch4`, project's `includeName`): its checkpoint in the
   * .aux numbers the boxes without a label (boxNumber). Without one they show no number.
   */
  file?: string;
  /**
   * The file an `\includegraphics{path}` shows (TexRender's `imageOf`): a render request's source,
   * why it cannot show (an error mark), or null (source, unmarked: the plugin cannot tell). Without
   * a resolver images stay source.
   */
  image?(path: string): { src: string } | { error: string } | null;
  /**
   * The PDF crop of the block [from, to] of `doc` (#4, #14; TexRender's `cropOf`) when the last
   * compile saw its text: a request's source and the source that drew the block before (shown
   * until the new crop lands), or null. Without a resolver there are no crops.
   */
  crop?(doc: Text, from: number, to: number, kind: CropKind): { src: string; previous: string | null } | null;
  /** Beamer: the PDF pages of the frame starting at `pos` of `doc` (#18, #19: the .nav), or null. */
  framePage?(doc: Text, pos: number): { first: number; last: number } | null;
  /** Beamer: show PDF page `page` in the root's open preview (nothing without one). */
  showPage?(page: number): void;
  /** Beamer: crop TikZ pictures as in a paper (the "Crop TikZ in beamer" setting). */
  beamerCrops?(): boolean;
}

/** LaTeX-only metadata for reference inspection; normal widget editing/drag events stay CM's. */
class ReferenceWidget extends TextWidget {
  constructor(text: string, cls: string, title: string, readonly command: string, readonly key: string, readonly from: number, readonly to: number) {
    super(text, cls, title);
  }
  eq(other: TextWidget): boolean {
    return other instanceof ReferenceWidget && super.eq(other) && other.command === this.command && other.key === this.key && other.from === this.from && other.to === this.to;
  }
  updateDOM(dom: HTMLElement): boolean {
    super.updateDOM(dom);
    dom.dataset.llRefCommand = this.command;
    dom.dataset.llRefKey = this.key;
    dom.dataset.llRefFrom = String(this.from);
    dom.dataset.llRefTo = String(this.to);
    return true;
  }
}

/** A tcolorbox (elegantbook's theorems): pgf moves what is inside, so SyncTeX misplaces it. */
const movesContent = (env: string, theorems: TheoremMap): boolean => {
  const spec = theorems.get(env)?.spec;
  return env === "tcolorbox" || spec === "tcb" || spec === "tcb*";
};

/**
 * How the block [from, to] of `doc` crops from the PDF (blockCrop's CropKind: `env` null is a
 * formula), or null: an environment that has no crop, or anything inside a tcolorbox.
 */
export function cropKindOf(doc: Text, block: { from: number; to: number }, env: string | null, theorems: TheoremMap): CropKind | null {
  if (blocksAround(doc, block.from, block.to).some((b) => movesContent(b.env, theorems))) return null;
  if (env === null) return "math";
  if (blockEnvKind(env) === "picture") return "picture";
  if (movesContent(env, theorems)) return "box";
  if (/^(?:figure|table)\*?$/.test(env)) return "float";
  return theorems.has(env) ? "block" : null;
}

/** Prepared sources remembered per refs; past this many the memo starts over. */
const MEMO_SIZE = 4000;

const HIDDEN = Decoration.replace({});
/** A \begin/\end line out of sight: a block replace without a widget. */
const COLLAPSED = Decoration.replace({ block: true });
const STYLE_MARKS: Record<TextStyle, Decoration> = {
  strong: Decoration.mark({ class: "lsp-lp-strong" }),
  em: Decoration.mark({ class: "lsp-lp-em" }),
  u: Decoration.mark({ class: "lsp-lp-u" }),
  tt: Decoration.mark({ class: "lsp-lp-tt" }),
  sc: Decoration.mark({ class: "lsp-lp-sc" }),
};
const HEADING_LINES = [1, 2, 3, 4, 5, 6].map((level) => Decoration.line({ class: `lsp-lp-h${level}` }));
const BOX_TITLE = "lsp-lp-box-title";
const TITLE_MARK = Decoration.mark({ class: BOX_TITLE });
/** The \end line of a proof ending in its mark, which sits at the right. */
const QED_LINE = Decoration.line({ class: "ll-qed-line" });
const CENTER_LINE = Decoration.line({ class: "lsp-lp-center" });
const FRAME_HEAD_LINE = Decoration.line({ class: "ll-frame-head" });
const FRAME_TITLE_LINE = Decoration.line({ class: "ll-frame-head is-frametitle" });
const FRAME_SUBTITLE_LINE = Decoration.line({ class: "ll-frame-head is-framesubtitle" });
const FRAME_TITLE = Decoration.mark({ class: "ll-frame-title" });
const FRAME_SUBTITLE = Decoration.mark({ class: "ll-frame-subtitle" });

/** LaTeX's constructs for livePreview (the renderer: texRender's `rendererFor(root)`). */
export function latexLiveLanguage(env: LatexLiveEnv): LiveLanguage<LatexConstruct> {
  // prepareMath tokenizes the formula: a document's thousand formulas at every keystroke's
  // rebuild add up, and most of them never change.
  let refs: LatexRefs | null = null;
  const memo = new Map<string, string>();
  const prepared = (m: LatexMath): string => {
    const now = env.refs();
    if (now !== refs || memo.size > MEMO_SIZE) {
      refs = now;
      memo.clear();
    }
    const key = (m.display ? "D" : "I") + m.src;
    let src = memo.get(key);
    if (src === undefined) memo.set(key, (src = prepareMath(m.src, now.numbers, m.display, formulaRefs(now))));
    return src;
  };
  /** A table's cell part for a construct in it (#23): a formula, a chip, or null (its source). */
  const leaf = (c: LatexConstruct, doc: Text): TablePart | null => {
    if (c.kind === "math") return { t: "math", src: prepared(c), display: c.display };
    if (c.kind === "label") return { t: "chip", text: c.key, cls: "lsp-lp-chip is-label", title: doc.sliceString(c.from, c.to) };
    if (c.kind !== "ref" && c.kind !== "cite") return null;
    const chip = c.kind === "ref" ? { ...refText(c.command, c.keys, env.refs()), title: doc.sliceString(c.from, c.to) } : citeText(c.keys, c.prenote, c.postnote, env.refs());
    return { t: "chip", text: chip.text, cls: `lsp-lp-chip is-${c.kind}${chip.missing ? " is-missing" : ""}`, title: chip.title };
  };
  /**
   * #23: a tabular as a table widget over its lines (a block, revealed over them as a crop is),
   * its cells' constructs rendered as in the running text; one the parse cannot follow stays source.
   */
  const decorateTable = (c: LatexEnv, ctx: LiveContext): void => {
    const { doc } = ctx.state;
    const layout = parseTabular(doc.sliceString(c.from, c.to));
    if (!layout) return;
    const all = scanLatex(doc, env.rules);
    const inside = all.filter((k) => k.from > c.from && k.to <= c.to);
    const center = all.some((k) => k.kind === "center" && k.from <= c.from && k.to >= c.from);
    const text = (from: number, to: number) => doc.sliceString(from, to);
    const spec = tableSpec(layout, c.from, text, (from, to) => cellParts(inside, text, from, to, (k) => leaf(k, doc)), center);
    renderConstruct(ctx, { from: c.from, to: c.to, block: true }, ctx.request("table", JSON.stringify(spec), true, c.from), { below: false });
  };
  return {
    scan: (doc) => scanLatex(doc, env.rules),
    // A theorem box tests the selection on its \begin and \end lines only (decorateBox): a move
    // inside a long one leaves it be. Every environment but a table or picture (which reveals over
    // its lines) says so, since the scan this is memoized with cannot see which ones the theorem map boxes.
    // A centered run's line class never depends on the selection.
    reveals: (c) => (c.kind === "env" && !blockEnvKind(c.env) ? [[c.from, c.beginTo], [c.endFrom, c.endFrom]] : c.kind === "center" ? [] : null),
    decorate(c, ctx) {
      const { doc } = ctx.state;
      if ("env" in c && c.env && env.visualization?.().source.has(c.env)) return;
      if (c.kind === "math") {
        const req = ctx.request("math", prepared(c), c.display, c.from);
        // #4: a block formula MathJax rejected shows its crop, when there is one.
        const failed = c.block && env.crop ? ctx.peek(req) : undefined;
        const kind = failed && !failed.ok ? cropKindOf(doc, c, null, env.refs().theorems) : null;
        const crop = kind && env.crop!(doc, c.from, c.to, kind);
        if (crop) decorateCrop(ctx, c, crop, () => renderConstruct(ctx, c, req));
        else renderConstruct(ctx, c, req);
        return;
      }
      if (c.kind === "heading") {
        const line = doc.lineAt(c.from);
        ctx.mark(line.from, line.from, HEADING_LINES[c.level - 1]);
        if (!doc.sliceString(c.titleFrom, c.titleTo).trim() || ctx.hasError(c.from, c.to)) return;
        if (ctx.touch(c.from, c.titleFrom) || ctx.touch(c.titleTo, c.to)) return;
        ctx.replace(c.from, c.titleFrom, HIDDEN);
        ctx.replace(c.titleTo, c.to, HIDDEN);
        return;
      }
      if (c.kind === "style") {
        ctx.mark(c.contentFrom, c.contentTo, STYLE_MARKS[c.style]);
        if (ctx.hasError(c.from, c.to) || ctx.touch(c.from, c.to)) return;
        ctx.replace(c.from, c.contentFrom, HIDDEN);
        ctx.replace(c.contentTo, c.to, HIDDEN);
        return;
      }
      if (c.kind === "item" && c.labelFrom !== undefined && c.labelTo !== undefined) {
        // A label with math or a reference, in place: bold for a term (not its formulas, as in LaTeX).
        if (c.term) ctx.mark(c.labelFrom, c.labelTo, STYLE_MARKS.strong);
        if (ctx.hasError(c.from, c.to) || ctx.touch(c.from, c.labelFrom) || ctx.touch(c.labelTo, c.to)) return;
        ctx.replace(c.from, c.labelFrom, HIDDEN);
        ctx.replace(c.labelTo, c.to, HIDDEN);
        return;
      }
      if (c.kind === "center") {
        for (let l = doc.lineAt(c.from).number, last = doc.lineAt(c.to).number; l <= last; l++) ctx.mark(doc.line(l).from, doc.line(l).from, CENTER_LINE);
        return;
      }
      if (c.kind === "frametitle") {
        const line = doc.lineAt(c.from);
        ctx.mark(line.from, line.from, c.sub ? FRAME_SUBTITLE_LINE : FRAME_TITLE_LINE);
        if (ctx.hasError(c.from, c.to) || ctx.touch(c.from, c.to)) return;
        ctx.replace(c.from, c.contentFrom, HIDDEN);
        ctx.replace(c.contentTo, c.to, HIDDEN);
        return;
      }
      if (c.kind === "overlay") {
        if (ctx.hasError(c.from, c.to) || ctx.touch(c.from, c.to)) return;
        for (const h of c.hide) ctx.replace(h.from, h.to, HIDDEN);
        return;
      }
      if (c.kind === "banner") {
        decorateBanner(c, ctx, env);
        return;
      }
      if (c.kind === "titlepage") {
        decorateTitlePage(c, ctx);
        return;
      }
      if (c.kind === "env") {
        const refs = env.refs();
        const def = (env.visualization?.().theorems ?? refs.theorems).get(c.env);
        const beamer = !!env.rules?.beamer;
        if (beamer && c.env === "frame") decorateFrame(c, ctx, env);
        else if (def) decorateBox(c, def, ctx, refs, env.file);
        else if (blockEnvKind(c.env) === "table") decorateTable(c, ctx);
        else if (blockEnvKind(c.env) === "picture") {
          if (beamer && !env.beamerCrops?.()) foldPicture(c, ctx);
          else {
            const kind = env.crop ? cropKindOf(doc, c, c.env, refs.theorems) : null;
            const crop = kind && env.crop!(doc, c.from, c.to, kind);
            if (crop) decorateCrop(ctx, c, crop);
          }
        }
        return;
      }
      if (c.kind === "image") {
        const found = env.image?.(c.path);
        if (!found) return;
        if ("src" in found) renderConstruct(ctx, c, ctx.request("image", found.src, true, c.from, true));
        else ctx.mark(c.from, c.to, Decoration.mark({ class: "lsp-lp-error", attributes: { title: found.error } }));
        return;
      }
      if (c.kind === "envline" || (c.kind === "command" && c.block)) {
        const from = doc.lineAt(c.from).from;
        const to = doc.lineAt(c.to).to;
        if (ctx.hasError(from, to) || ctx.touch(from, to)) return;
        ctx.replace(from, to, COLLAPSED);
        return;
      }
      if (c.kind === "caption") {
        if (ctx.hasError(c.from, c.to) || ctx.touch(c.from, c.contentFrom) || ctx.touch(c.contentTo, c.to)) return;
        const aux = c.float && c.label ? env.refs().labels.get(c.label) : undefined;
        const number = aux && (!aux.kind || aux.kind === c.float) ? texText(aux.number) || aux.number : "";
        const head = number ? `${c.float === "figure" ? "Figure" : "Table"} ${number}: ` : "";
        ctx.replace(c.from, c.contentFrom, head ? Decoration.replace({ widget: new TextWidget(head, "ll-caption-head", doc.sliceString(c.from, c.contentFrom)) }) : HIDDEN);
        ctx.replace(c.contentTo, c.to, HIDDEN);
        return;
      }
      if (c.kind === "command") {
        if (ctx.hasError(c.from, c.to) || ctx.touch(c.from, c.to)) return;
        ctx.replace(c.from, c.to, HIDDEN);
        return;
      }
      if (c.kind !== "item" && c.kind !== "label" && c.kind !== "ref" && c.kind !== "cite") return;
      if (ctx.hasError(c.from, c.to) || ctx.touch(c.from, c.to)) return;
      let widget: TextWidget;
      if (c.kind === "item") {
        widget = new TextWidget(c.marker, c.term ? "lsp-lp-bullet is-term" : "lsp-lp-bullet");
      } else if (c.kind === "label") {
        widget = new TextWidget(c.key, "lsp-lp-chip is-label", doc.sliceString(c.from, c.to));
      } else {
        const chip =
          c.kind === "ref"
            ? { ...refText(c.command, c.keys, env.refs()), title: doc.sliceString(c.from, c.to) }
            : citeText(c.keys, c.prenote, c.postnote, env.refs());
        const cls = `lsp-lp-chip is-${c.kind}${chip.missing ? " is-missing" : ""}`;
        // A reference chip names its command and first key: the theorem graph and labelJump read them.
        widget = c.kind === "ref"
          ? new ReferenceWidget(chip.text, cls, chip.title, c.command, c.keys[0], c.from, c.to)
          : new TextWidget(chip.text, cls, chip.title);
      }
      ctx.replace(c.from, c.to, Decoration.replace({ widget }));
    },
  };
}

/**
 * A PDF crop over the block's lines (#4, #14): no preview below while revealed (it would be
 * stale). While a new result's crop is pending, the block keeps the crop drawn before; a crop
 * that failed leaves the block to `fallback` (source).
 */
function decorateCrop(ctx: LiveContext, c: { from: number; to: number }, crop: { src: string; previous: string | null }, fallback?: () => void): void {
  const req = ctx.request("crop", crop.src, true, c.from, true);
  const r = ctx.peek(req);
  if (r && !r.ok) {
    fallback?.();
    return;
  }
  const { doc } = ctx.state;
  const from = doc.lineAt(c.from).from;
  const to = doc.lineAt(c.to).to;
  if (!r && crop.previous && !ctx.touch(from, to) && !ctx.hasError(c.from, c.to)) {
    const old = ctx.request("crop", crop.previous, true, c.from, true);
    const shown = ctx.peek(old);
    if (shown?.ok) {
      ctx.result(req); // queued: it replaces the old crop when it lands
      ctx.replace(from, to, Decoration.replace({ widget: new RenderWidget(old, shown, "block"), block: true }));
      return;
    }
  }
  renderConstruct(ctx, { from: c.from, to: c.to, block: true }, req, { below: false });
}

/**
 * The number a theorem box's head prints (the hover's fragment too): its label's .aux entry
 * (`number` as the .aux has it, `counter` its hyperref anchor's), else the box's place among
 * those counting on its chapter counter (TheoremDef.counter) in an \include'd `file`, when that
 * file's checkpoint confirms it: the file has one \chapter, every such box follows it, the scan
 * finds as many as the checkpoint counted (a box whose \begin or \end shares its line, or one in
 * a macro, fails this), and every labelled one has its place's .aux number; `chapter.n` then,
 * with the chapter hyperref's anchor names (`A.1` in an appendix). Null otherwise: an \input'd
 * or single-file document, a changed file, thmcnt=section, a counter shared differently.
 */
export function boxNumber(doc: Text, c: LatexEnv, def: TheoremDef, refs: LatexRefs, file?: string): { number: string; counter: string | null } | null {
  if (!def.numbered) return null;
  const key = boxArgs(c, def, doc).label;
  const aux = key ? refs.labels.get(key) : undefined;
  if (aux) return { number: aux.number, counter: aux.anchor ? aux.anchor.split(".", 1)[0] : null };
  const n = def.counter && file !== undefined ? countedNumbers(doc, refs, file).get(c.from) : undefined;
  return n ? { number: n, counter: def.counter } : null;
}

/** countedNumbers per document: for which refs and file, and the numbers by box position. */
const counted = new WeakMap<Text, { refs: LatexRefs; file: string; numbers: ReadonlyMap<number, string> }>();

/** The numbers of a document's boxes counted on chapter counters (see boxNumber), by position. */
function countedNumbers(doc: Text, refs: LatexRefs, file: string): ReadonlyMap<number, string> {
  const hit = counted.get(doc);
  if (hit && hit.refs === refs && hit.file === file) return hit.numbers;
  const numbers = new Map<number, string>();
  counted.set(doc, { refs, file, numbers });
  const checkpoint = refs.checkpoints.get(file);
  if (!checkpoint?.chapter) return numbers;
  const all = scanLatex(doc);
  const chapters = all.filter((h) => h.kind === "heading" && /^\\chapter\s*[[{]/.test(doc.sliceString(h.from, h.titleFrom)));
  if (chapters.length !== 1) return numbers;
  const boxes = new Map<string, { c: LatexEnv; def: TheoremDef }[]>();
  for (const c of all) {
    const def = c.kind === "env" ? refs.theorems.get(c.env) : undefined;
    if (c.kind !== "env" || !def?.numbered || !def.counter) continue;
    let list = boxes.get(def.counter);
    if (!list) boxes.set(def.counter, (list = []));
    list.push({ c, def });
  }
  for (const [counter, list] of boxes) {
    const at = (i: number) => `${checkpoint.chapter}.${i + 1}`;
    if (list.length !== checkpoint.counters.get(counter) || list[0].c.from < chapters[0].from) continue;
    const labelled = list.map(({ c, def }) => {
      const key = boxArgs(c, def, doc).label;
      return key ? refs.labels.get(key) : undefined;
    });
    if (labelled.some((aux, i) => aux && (texText(aux.number) || aux.number) !== at(i))) continue;
    list.forEach(({ c }, i) => numbers.set(c.from, at(i)));
  }
  return numbers;
}

/**
 * What a theorem's \begin line gives: the title argument, the key of the label that numbers it,
 * and how many of its arguments the environment takes (the others are text the PDF prints:
 * `\begin{proof}[x]` under elegantbook, whose proof takes none).
 */
function boxArgs(c: LatexEnv, def: TheoremDef, doc: Text): { title: LatexArg | null; label: string | null; taken: number } {
  const { args } = c;
  if (def.spec === "tcb" || def.spec === "tcb*") {
    // tcolorbox's `g o t\label g`: {title} or [title], then \label{k} or {label} (`prefix:label`).
    let k = 0;
    const g = args[k] && !args[k].optional ? args[k++] : null;
    const o = args[k]?.optional ? args[k++] : null;
    const last = def.spec === "tcb" && args[k] && !args[k].optional ? args[k++] : null;
    const key = last ? doc.sliceString(last.from, last.to).trim() : "";
    return { title: g ?? o, label: def.spec === "tcb*" ? null : key ? (def.prefix ? `${def.prefix}:${key}` : key) : c.label, taken: k };
  }
  const first = def.spec && args[0] && args[0].optional === (def.spec === "o") ? args[0] : null;
  return { title: first, label: c.label, taken: first ? 1 : 0 };
}

/**
 * A theorem-like environment (#12): the box over its lines, the head on its \begin line (a chip,
 * or the title in place between the head's parts), the \end line collapsed (a proof's mark).
 */
function decorateBox(c: LatexEnv, def: TheoremDef, ctx: LiveContext, refs: LatexRefs, file: string | undefined): void {
  const { doc } = ctx.state;
  const begin = doc.lineAt(c.from);
  const headLast = doc.lineAt(c.beginTo);
  const end = doc.lineAt(c.endFrom);
  const attributes: Record<string, string> = { class: def.role ? `lsp-lp-box is-${def.role}` : "lsp-lp-box" };
  if (def.elegantHead && (c.env === "proof" || c.env === "example")) attributes.class += " ll-corner-frame";
  if (def.color) attributes.style = `--lp-box-color: ${def.color}`;
  ctx.wrap(begin.from, end.to, { tagName: "div", attributes });

  if (!ctx.touchLines(begin.from, headLast.to) && !ctx.hasError(begin.from, headLast.to)) {
    const { title, taken } = boxArgs(c, def, doc);
    const numbered = boxNumber(doc, c, def, refs, file);
    const number = numbered ? texText(numbered.number) || numbered.number : "";
    const titleSrc = title ? doc.sliceString(title.from, title.to) : "";
    const inPlace = !!title && hasConstructs(titleSrc);
    const text = inPlace ? "\u0000" : texText(titleSrc);
    const name = def.title === "name" ? text : def.name;
    const head = number ? `${name} ${number}` : name;
    let full: string;
    if (!text) full = head + def.punct;
    else if (def.title === "paren") full = `${head} (${text})${def.punct}`;
    else if (def.title === "after") full = `${head} ${text}`;
    else if (def.title === "replace") full = text + def.punct;
    else full = head;
    const chip = (s: string) => (s ? Decoration.replace({ widget: new TextWidget(s, BOX_TITLE) }) : HIDDEN);
    // Arguments the environment does not take stay in place as text; the rest of the line (a
    // \label, a comment) hides with the head.
    const rest = c.args[taken];
    const headEnd = rest ? rest.from - 1 : headLast.to;
    if (rest) {
      const textEnd = c.args[c.args.length - 1].to + 1;
      if (textEnd < headLast.to) ctx.replace(textEnd, headLast.to, HIDDEN);
    }
    if (inPlace && title) {
      // `定理 1.1 (` title `)`: the title's formulas and references render in place.
      const [before, after] = full.split("\u0000");
      ctx.replace(c.from, title.from, chip(before));
      ctx.replace(title.to, headEnd, chip(after));
      ctx.mark(title.from, title.to, TITLE_MARK);
    } else {
      ctx.replace(c.from, headEnd, chip(full));
    }
  }

  if (!ctx.touchLines(end.from, end.from) && !ctx.hasError(end.from, end.to)) {
    if (def.qed) {
      ctx.mark(end.from, end.from, QED_LINE);
      ctx.replace(end.from, end.to, Decoration.replace({ widget: new TextWidget(def.qed, "lsp-lp-qed") }));
    } else {
      ctx.replace(end.from, end.to, COLLAPSED);
    }
  }
}

/** A widget that runs `action` on a click and keeps the click from CodeMirror (no cursor move). */
class ActionWidget extends WidgetType {
  constructor(
    readonly key: string,
    readonly draw: (dom: HTMLElement) => void,
    readonly action: (() => void) | undefined,
    readonly block: boolean,
    readonly cls: string,
    readonly title?: string,
  ) {
    super();
  }

  eq(other: ActionWidget): boolean {
    return other.key === this.key && other.cls === this.cls && other.block === this.block && other.title === this.title;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = view.dom.ownerDocument.createElement(this.block ? "div" : "span");
    dom.className = this.cls;
    if (this.title) dom.title = this.title;
    this.draw(dom);
    dom.addEventListener("mousedown", (e) => {
      if ((e as MouseEvent).button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      this.action?.();
    });
    return dom;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

/** A frame's PDF page in the corner of its first line (#18, #19), when the .nav has it. */
function pageCorner(ctx: LiveContext, env: LatexLiveEnv, pos: number, at: number): void {
  const pages = env.framePage?.(ctx.state.doc, pos);
  if (!pages) return;
  const text = pages.first === pages.last ? `${pages.first}` : `${pages.first}–${pages.last}`;
  const show = env.showPage;
  const widget = new ActionWidget(`page:${text}`, (dom) => (dom.textContent = text), show && (() => show(pages.first)), false, "ll-frame-page", `PDF page ${text}`);
  ctx.point(at, Decoration.widget({ widget, side: 1 }));
}

/**
 * A beamer frame (#18): the card over its lines, the title bar on its \begin line (the title
 * and subtitle in place), the page in its corner, the \end line collapsed.
 */
function decorateFrame(c: LatexEnv, ctx: LiveContext, env: LatexLiveEnv): void {
  const { doc } = ctx.state;
  const begin = doc.lineAt(c.from);
  const headLast = doc.lineAt(c.beginTo);
  const end = doc.lineAt(c.endFrom);
  ctx.wrap(begin.from, end.to, { tagName: "div", attributes: { class: "lsp-lp-box ll-frame" } });
  ctx.mark(begin.from, begin.from, FRAME_HEAD_LINE);
  const titles = c.args.filter((a) => !a.optional);
  if (!ctx.touchLines(begin.from, headLast.to) && !ctx.hasError(begin.from, headLast.to)) {
    // `\begin{frame}[t]{` title `}{` subtitle `}`: everything but the two hides.
    let at = c.from;
    titles.slice(0, 2).forEach((a, k) => {
      ctx.replace(at, a.from, HIDDEN);
      ctx.mark(a.from, a.to, k ? FRAME_SUBTITLE : FRAME_TITLE);
      at = a.to;
    });
    if (at < headLast.to) ctx.replace(at, headLast.to, HIDDEN);
  }
  pageCorner(ctx, env, c.from, headLast.to);
  if (!ctx.touchLines(end.from, end.from) && !ctx.hasError(end.from, end.to)) ctx.replace(end.from, end.to, COLLAPSED);
}

/** A banner command's call (#19): a banner card, its arguments in place, the markup hidden. */
function decorateBanner(c: LatexBanner, ctx: LiveContext, env: LatexLiveEnv): void {
  const { doc } = ctx.state;
  const first = doc.lineAt(c.from);
  const last = doc.lineAt(c.to);
  ctx.wrap(first.from, last.to, { tagName: "div", attributes: { class: "lsp-lp-box ll-banner" } });
  const shown = c.args.filter((a) => !a.optional);
  if (!ctx.touch(c.from, c.to) && !ctx.hasError(c.from, c.to)) {
    let at = c.from;
    shown.forEach((a, k) => {
      ctx.replace(at, a.from, k ? Decoration.replace({ widget: new TextWidget("", "ll-banner-break") }) : HIDDEN);
      ctx.mark(a.from, a.to, Decoration.mark({ class: `ll-banner-arg is-arg${k + 1}` }));
      at = a.to;
    });
    if (at < c.to) ctx.replace(at, c.to, HIDDEN);
  }
  pageCorner(ctx, env, c.from, last.to);
}

/** \titlepage alone on its line (#20): one line until the cursor is on it. */
function decorateTitlePage(c: LatexTitlePage, ctx: LiveContext): void {
  if (!c.block) return;
  const line = ctx.state.doc.lineAt(c.from);
  if (ctx.touchLines(line.from, line.to) || ctx.hasError(line.from, line.to)) return;
  const widget = new TextWidget("▸ Title page", "ll-titlepage", line.text.trim());
  ctx.replace(line.from, line.to, Decoration.replace({ widget, block: true }));
}

/** A TikZ picture in beamer without crops (#22): one line until the cursor enters it. */
function foldPicture(c: LatexEnv, ctx: LiveContext): void {
  const { doc } = ctx.state;
  const first = doc.lineAt(c.from);
  const last = doc.lineAt(c.to);
  if (ctx.touchLines(first.from, last.to) || ctx.hasError(first.from, last.to)) return;
  const n = last.number - first.number + 1;
  const widget = new TextWidget(`▸ TikZ (${n} lines)`, "ll-tikz-fold", doc.sliceString(first.from, Math.min(first.to, first.from + 200)));
  ctx.replace(first.from, last.to, Decoration.replace({ widget, block: true }));
}
