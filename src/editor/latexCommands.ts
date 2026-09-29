// Built-in LaTeX knowledge that texlab does not provide (TL-02, TL-03, UX-05, UX-06):
// argument snippets, which commands belong in math, a popularity prior for common
// commands, and common environments.
// Snippet notation: #1, #2 ... are tab stops in order, #0 is the final cursor position.

/** Argument snippets, written after the command name. */
export const COMMAND_ARGS: Record<string, string> = {
  frac: "{#1}{#2}#0",
  dfrac: "{#1}{#2}#0",
  tfrac: "{#1}{#2}#0",
  cfrac: "{#1}{#2}#0",
  binom: "{#1}{#2}#0",
  dbinom: "{#1}{#2}#0",
  tbinom: "{#1}{#2}#0",
  sqrt: "{#1}#0",
  overset: "{#1}{#2}#0",
  underset: "{#1}{#2}#0",
  stackrel: "{#1}{#2}#0",
  xrightarrow: "{#1}#0",
  xleftarrow: "{#1}#0",
  substack: "{#1}#0",
  pmod: "{#1}#0",
  text: "{#1}#0",
  textbf: "{#1}#0",
  textit: "{#1}#0",
  textrm: "{#1}#0",
  textsf: "{#1}#0",
  textsc: "{#1}#0",
  texttt: "{#1}#0",
  textup: "{#1}#0",
  emph: "{#1}#0",
  underline: "{#1}#0",
  mathbb: "{#1}#0",
  mathcal: "{#1}#0",
  mathrm: "{#1}#0",
  mathbf: "{#1}#0",
  mathfrak: "{#1}#0",
  mathsf: "{#1}#0",
  mathit: "{#1}#0",
  mathscr: "{#1}#0",
  mathtt: "{#1}#0",
  boldsymbol: "{#1}#0",
  bm: "{#1}#0",
  operatorname: "{#1}#0",
  hat: "{#1}#0",
  widehat: "{#1}#0",
  bar: "{#1}#0",
  tilde: "{#1}#0",
  widetilde: "{#1}#0",
  vec: "{#1}#0",
  dot: "{#1}#0",
  ddot: "{#1}#0",
  check: "{#1}#0",
  breve: "{#1}#0",
  overline: "{#1}#0",
  overbrace: "{#1}#0",
  underbrace: "{#1}#0",
  part: "{#1}#0",
  chapter: "{#1}#0",
  section: "{#1}#0",
  subsection: "{#1}#0",
  subsubsection: "{#1}#0",
  paragraph: "{#1}#0",
  subparagraph: "{#1}#0",
  label: "{#1}#0",
  ref: "{#1}#0",
  eqref: "{#1}#0",
  pageref: "{#1}#0",
  autoref: "{#1}#0",
  nameref: "{#1}#0",
  cref: "{#1}#0",
  Cref: "{#1}#0",
  cite: "{#1}#0",
  citep: "{#1}#0",
  citet: "{#1}#0",
  parencite: "{#1}#0",
  textcite: "{#1}#0",
  autocite: "{#1}#0",
  footnote: "{#1}#0",
  caption: "{#1}#0",
  title: "{#1}#0",
  author: "{#1}#0",
  url: "{#1}#0",
  href: "{#1}{#2}#0",
  textcolor: "{#1}{#2}#0",
  colorbox: "{#1}{#2}#0",
  color: "{#1}#0",
  usepackage: "{#1}#0",
  documentclass: "{#1}#0",
  input: "{#1}#0",
  include: "{#1}#0",
  includegraphics: "{#1}#0",
  bibliography: "{#1}#0",
  bibliographystyle: "{#1}#0",
  addbibresource: "{#1}#0",
  usetikzlibrary: "{#1}#0",
  begin: "{#1}#0",
  end: "{#1}#0",
};

/**
 * Variants offered next to the bare command (the bare \sum, \left stay available):
 * label -> snippet text (after the backslash).
 */
export const COMMAND_VARIANTS: [string, string, string][] = [
  // label, snippet, detail
  ["left(", "left( #1 \\right)#0", "\\left( … \\right)"],
  ["left[", "left[ #1 \\right]#0", "\\left[ … \\right]"],
  ["left\\{", "left\\{ #1 \\right\\}#0", "\\left\\{ … \\right\\}"],
  ["left|", "left| #1 \\right|#0", "\\left| … \\right|"],
  ["left\\|", "left\\| #1 \\right\\|#0", "\\left\\| … \\right\\|"],
  ["left\\langle", "left\\langle #1 \\right\\rangle#0", "\\left\\langle … \\right\\rangle"],
  ["sum_^", "sum_{#1}^{#2}#0", "\\sum_{…}^{…}"],
  ["prod_^", "prod_{#1}^{#2}#0", "\\prod_{…}^{…}"],
  ["int_^", "int_{#1}^{#2}#0", "\\int_{…}^{…}"],
  ["lim_", "lim_{#1 \\to #2}#0", "\\lim_{… \\to …}"],
];

/** Math commands with their glyph (shown in the popup, also used when texlab misses them). */
const SYMBOLS =
  "alpha:α beta:β gamma:γ delta:δ epsilon:ϵ varepsilon:ε zeta:ζ eta:η theta:θ vartheta:ϑ " +
  "iota:ι kappa:κ lambda:λ mu:μ nu:ν xi:ξ pi:π varpi:ϖ rho:ρ varrho:ϱ sigma:σ varsigma:ς " +
  "tau:τ upsilon:υ phi:ϕ varphi:φ chi:χ psi:ψ omega:ω Gamma:Γ Delta:Δ Theta:Θ Lambda:Λ " +
  "Xi:Ξ Pi:Π Sigma:Σ Upsilon:Υ Phi:Φ Psi:Ψ Omega:Ω " +
  "infty:∞ partial:∂ nabla:∇ sum:∑ prod:∏ coprod:∐ int:∫ iint:∬ oint:∮ " +
  "leq:≤ le:≤ geq:≥ ge:≥ neq:≠ ne:≠ approx:≈ equiv:≡ sim:∼ simeq:≃ cong:≅ propto:∝ " +
  "ll:≪ gg:≫ prec:≺ succ:≻ " +
  "in:∈ notin:∉ ni:∋ subset:⊂ subseteq:⊆ supset:⊃ supseteq:⊇ cup:∪ cap:∩ bigcup:⋃ " +
  "bigcap:⋂ setminus:∖ emptyset:∅ varnothing:∅ forall:∀ exists:∃ neg:¬ land:∧ lor:∨ " +
  "wedge:∧ vee:∨ to:→ rightarrow:→ leftarrow:← Rightarrow:⇒ Leftarrow:⇐ " +
  "Leftrightarrow:⇔ leftrightarrow:↔ implies:⟹ iff:⟺ mapsto:↦ longrightarrow:⟶ " +
  "uparrow:↑ downarrow:↓ times:× cdot:⋅ cdots:⋯ ldots:… dots:… vdots:⋮ ddots:⋱ pm:± " +
  "mp:∓ div:÷ circ:∘ star:⋆ ast:∗ oplus:⊕ otimes:⊗ bigoplus:⨁ bigotimes:⨂ mid:∣ " +
  "parallel:∥ perp:⊥ top:⊤ bot:⊥ ell:ℓ hbar:ℏ Re:ℜ Im:ℑ aleph:ℵ angle:∠ triangle:△ " +
  "langle:⟨ rangle:⟩ lceil:⌈ rceil:⌉ lfloor:⌊ rfloor:⌋ prime:′ sqrt:√";

/** Glyphs of SYMBOLS, by name. */
export const GLYPHS: Map<string, string> = new Map(
  SYMBOLS.split(" ").map((e) => e.split(":") as [string, string]),
);

/** Math-mode commands without a glyph. */
const MATH_WORDS =
  "frac dfrac tfrac cfrac binom dbinom tbinom sqrt overset underset stackrel xrightarrow " +
  "xleftarrow substack pmod bmod mathbb mathcal mathrm mathbf mathfrak mathsf mathit mathscr " +
  "mathtt boldsymbol bm operatorname hat widehat bar tilde widetilde vec dot ddot check breve " +
  "overline overbrace underbrace left right big Big bigg Bigg bigl bigr Bigl Bigr biggl biggr " +
  "text quad qquad displaystyle textstyle limits nolimits lim limsup liminf sup inf max min " +
  "log ln exp sin cos tan sec csc cot arcsin arccos arctan sinh cosh tanh det dim ker deg " +
  "gcd arg Pr hom not";

/** Commands that belong in math mode (demoted in text, boosted in math). */
export const MATH_COMMANDS: Set<string> = new Set([...GLYPHS.keys(), ...MATH_WORDS.split(" ")]);

/** Text and preamble commands (demoted inside math). */
export const TEXT_COMMANDS: Set<string> = new Set(
  (
    "part chapter section subsection subsubsection paragraph subparagraph item usepackage " +
    "documentclass textbf textit textsc textsf textrm texttt textup emph footnote caption " +
    "includegraphics maketitle tableofcontents newpage clearpage noindent centering " +
    "bibliography bibliographystyle addbibresource cite citep citet parencite textcite " +
    "autocite input include makeatletter makeatother newcommand renewcommand title author " +
    "date url href hline vspace newline linebreak pagebreak smallskip medskip bigskip"
  ).split(" "),
);

/**
 * Commonly used commands, most frequent first. Gives a
 * small boost, capped so that a better textual match still wins.
 */
export const POPULAR: string[] = (
  "item end begin textbf frac mathbb in text subsection mu sum left right lambda infty " +
  "mathcal section pi leq quad alpha mid textit mathbf to boldsymbol sigma cdot top " +
  "usepackage le times int varepsilon ge geq paragraph texttt ldots cdots partial phi sqrt " +
  "emph label ref eqref lim sup mathrm hat bar tilde epsilon theta beta gamma delta omega " +
  "rho tau subseteq subset cup cap forall exists neq approx sim Rightarrow rightarrow " +
  "mapsto langle rangle nabla prod log exp max min inf mathfrak operatorname varphi psi"
).split(" ");

/** Common environments offered when texlab's page misses them; value: arguments. */
export const ENVIRONMENTS: Record<string, string> = {
  itemize: "",
  enumerate: "",
  description: "",
  equation: "",
  "equation*": "",
  align: "",
  "align*": "",
  gather: "",
  "gather*": "",
  multline: "",
  cases: "",
  matrix: "",
  pmatrix: "",
  bmatrix: "",
  Bmatrix: "",
  vmatrix: "",
  Vmatrix: "",
  aligned: "",
  split: "",
  array: "{#1}",
  tabular: "{#1}",
  figure: "",
  table: "",
  center: "",
  minipage: "{#1}",
  quote: "",
  verbatim: "",
  abstract: "",
};

/** Arguments for environments that texlab offers (not only the built-in ones above). */
export const ENVIRONMENT_ARGS: Record<string, string> = {
  array: "{#1}",
  tabular: "{#1}",
  "tabular*": "{#1}{#2}",
  tabularx: "{#1}{#2}",
  minipage: "{#1}",
  alignat: "{#1}",
  "alignat*": "{#1}",
  multicols: "{#1}",
  subfigure: "{#1}",
  wrapfigure: "{#1}{#2}",
};

export const LIST_ENVIRONMENTS: Set<string> = new Set(["itemize", "enumerate", "description"]);

/** Environments used inside math (cases, matrices, aligned ...). */
export const MATH_INNER_ENVIRONMENTS: Set<string> = new Set(
  "cases dcases rcases matrix pmatrix bmatrix Bmatrix vmatrix Vmatrix smallmatrix aligned alignedat gathered split array subarray".split(
    " ",
  ),
);

/** Display math environments (they cannot nest inside math). */
export const DISPLAY_ENVIRONMENTS: Set<string> = new Set(
  "equation equation* align align* gather gather* multline multline* flalign flalign* alignat alignat* eqnarray eqnarray* displaymath math".split(
    " ",
  ),
);

/**
 * Commands whose braces take a completion list (D5): typing right after their `{` asks
 * texlab at once. Value: the kind of argument.
 */
export const ARGUMENT_COMMANDS: Record<string, "env" | "label" | "cite" | "file" | "package" | "color"> = {
  begin: "env",
  end: "env",
  ref: "label",
  eqref: "label",
  pageref: "label",
  autoref: "label",
  nameref: "label",
  cref: "label",
  Cref: "label",
  crefrange: "label",
  labelcref: "label",
  vref: "label",
  cite: "cite",
  citep: "cite",
  citet: "cite",
  citealp: "cite",
  citeauthor: "cite",
  citeyear: "cite",
  parencite: "cite",
  textcite: "cite",
  autocite: "cite",
  footcite: "cite",
  nocite: "cite",
  usepackage: "package",
  RequirePackage: "package",
  documentclass: "package",
  usetikzlibrary: "package",
  input: "file",
  include: "file",
  subfile: "file",
  includegraphics: "file",
  includeonly: "file",
  bibliography: "file",
  addbibresource: "file",
  bibliographystyle: "file",
  textcolor: "color",
  color: "color",
  colorbox: "color",
  fcolorbox: "color",
  pagecolor: "color",
};

/** LSP snippet text for a template in the notation above. */
export function snippetText(template: string): string {
  return template.replace(/[\\$]/g, "\\$&").replace(/#(\d)/g, "$$$1");
}
