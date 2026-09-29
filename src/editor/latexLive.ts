import { Decoration } from "@codemirror/view";
import { LatexRefs, citeText, formulaRefs, refText } from "./latexRefs";
import { LatexConstruct, LatexMath, TextStyle, scanLatex } from "./latexScan";
import { prepareMath } from "./mathjaxProject";
import { LiveLanguage, TextWidget, renderConstruct } from "./shared/livePreview";

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
//   #4  a formula MathJax rejects (tikz-cd, \intertext, an undefined macro) keeps its source
//       with the dotted `lsp-lp-error` underline; the render hover shows the message.
//   #5  a heading's line gets `lsp-lp-h1`..`h6` (kept while revealed); `\section{`, a
//       `[short]` title and the closing `}` are hidden until the cursor touches either end.
//   #6  \textbf, \textit, \emph, \underline, \texttt, \textsc: a mark on the content, the
//       command and braces hidden until the construct is touched.
//   #7  \item: a bullet (• ◦ ▪ by depth), a number (1. / (a) / i. by depth, or the list's
//       enumerate short form or enumitem `label=`, `resume`, `series`), its own [label], or a
//       description's bold term; only touching the token reveals it, so typing after it keeps
//       the marker. A label with math or a reference stays in place (`\item[` and `]` hidden, a
//       term's text bold, its formulas rendered): touching `\item[` or `]` reveals them.
//   #8  the \begin and \end lines of lists and center collapse (a block replace without a
//       widget) until the cursor is on the line.
//   #9  \ref, \eqref, \pageref, \autoref, \cref, \Cref, \nameref: a chip with what the PDF prints
//       from the last compile's .aux (latexRefs: `1.2`, `(1.2)`, hyperref's `section 1.2`,
//       cleveref's `eqs. (1) and (2)`); `??` in the warning colour when a label is unknown. Its
//       tooltip is the source.
//   #10 \cite and natbib's and biblatex's relatives (\citep, \Citet, \citealp, \parencite,
//       \textcite, \autocite, \footcite, ...): a chip `[see Li et al. 2019, p. 3]` from the
//       project's .bib files; unknown keys show as keys, in the warning colour. Its tooltip names
//       each key's entry.
//   #11 \label outside math: a faint chip with the key.
// A construct with an error diagnostic on it stays source (the lint underline shows).
// Numbers: a request carries the formula already prepared for MathJax (prepareMath: `\label`
// -> `\tag{n}` from the root's last compile, a reference -> the chip's text), so a compile
// that renumbers labels re-renders only the formulas whose text changed; the renderer's epoch
// covers the definitions alone. TexRender tells the views to rebuild when the labels, the
// bibliography or the reference names change (through the renderer's subscribers).
// Everything else (the preamble and the files the root reads before \begin{document}, comments,
// verbatim, `\iffalse` blocks, \footnote, theorem boxes, figures, TikZ pictures (#14, P5) and
// unknown environments) stays source.

export interface LatexLiveEnv {
  /** The root's references, read at every build (TexRender's `refsOf`); a new object when they change. */
  refs(): LatexRefs;
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
  return {
    scan: scanLatex,
    decorate(c, ctx) {
      if (c.kind === "math") {
        renderConstruct(ctx, c, ctx.request("math", prepared(c), c.display, c.from));
        return;
      }
      const { doc } = ctx.state;
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
      if (c.kind === "envline") {
        const line = doc.lineAt(c.from);
        if (ctx.hasError(line.from, line.to) || ctx.touch(line.from, line.to)) return;
        ctx.replace(line.from, line.to, COLLAPSED);
        return;
      }
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
        widget = new TextWidget(chip.text, `lsp-lp-chip is-${c.kind}${chip.missing ? " is-missing" : ""}`, chip.title);
      }
      ctx.replace(c.from, c.to, Decoration.replace({ widget }));
    },
  };
}
