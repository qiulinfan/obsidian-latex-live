import { scanDefinitions, type Definitions } from "../tex/macros";
import { stripComments } from "../tex/project";
import type { TheoremMap, TheoremSpec } from "../tex/theorems";
import { CITE_COMMANDS } from "../editor/latexHighlight";
import { BBL_SIGNATURES } from "./bibliography";
import { parseTex, walkTex, type EnvironmentDefinition, type Signatures, type Spec, type TexNode } from "./texTree";

// Argument specs for the export's parser (texTree.ts): the built-in commands and environments
// of LaTeX and the packages the synthetic projects and real course notes load, then the
// project's own (\newcommand, \NewDocumentCommand, \newenvironment, the theorem map), then what
// the probe's environment census says TeX defined (the class's own environments).

/**
 * Citation commands (live preview's, and the other biblatex and natbib ones the export prints):
 * `\cite*[pre][post]{keys}`.
 */
export const CITES = new Set([
  ...CITE_COMMANDS,
  "footcitetext", "supercite", "smartcite", "Smartcite", "citeauthor", "Citeauthor", "citeyear", "citeyearpar",
  "citetitle", "citenum",
]);

const TEXT = ["textbf", "textit", "emph", "texttt", "textsf", "textrm", "textsc", "textup", "textsl", "textmd", "textnormal", "textsuperscript", "textsubscript", "underline", "uline", "text", "mbox", "fbox", "hbox", "ensuremath"];
const SECTIONS = ["part", "chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"];
const ACCENTS = ["'", "`", "^", '"', "~", "=", ".", "u", "v", "H", "c", "k", "r", "d", "b", "t"];

const BUILTIN_MACROS: Record<string, Spec> = {
  ...Object.fromEntries(SECTIONS.map((c) => [c, "s o m"])),
  ...Object.fromEntries(TEXT.map((c) => [c, "m"])),
  ...Object.fromEntries(ACCENTS.map((c) => [c, "m"])),
  ...Object.fromEntries([...CITES].map((c) => [c, "s o o m"])),
  ...BBL_SIGNATURES,
  "\\": "s o",
  textcolor: "o m m",
  colorbox: "o m m",
  fcolorbox: "o m m m",
  color: "o m",
  makebox: "o o m",
  framebox: "o o m",
  raisebox: "m o o m",
  parbox: "o o o m m",
  footnote: "o m",
  footnotemark: "o",
  footnotetext: "o m",
  thanks: "m",
  marginpar: "o m",
  label: "m",
  ref: "s m",
  eqref: "m",
  pageref: "s m",
  autoref: "s m",
  Autoref: "s m",
  cref: "s m",
  Cref: "s m",
  crefrange: "s m m",
  Crefrange: "s m m",
  nameref: "s m",
  nocite: "m",
  url: "v",
  nolinkurl: "v",
  href: "o v m",
  includegraphics: "s o o m",
  includepdf: "o m",
  lstinputlisting: "o m",
  input: "m",
  include: "m",
  includeonly: "m",
  subfile: "m",
  subfileinclude: "m",
  import: "s m m",
  subimport: "s m m",
  inputfrom: "s m m",
  subinputfrom: "s m m",
  includefrom: "s m m",
  subincludefrom: "s m m",
  caption: "s o m",
  captionof: "s m o m",
  item: "o",
  bibitem: "o m",
  natexlab: "m",
  doi: "v",
  linebreak: "o",
  pagebreak: "o",
  nopagebreak: "o",
  vspace: "s m",
  hspace: "s m",
  setcounter: "m m",
  addtocounter: "m m",
  stepcounter: "m",
  refstepcounter: "m",
  setlength: "m m",
  addtolength: "m m",
  newcounter: "m o",
  addcontentsline: "m m m",
  markboth: "m m",
  markright: "m",
  pagestyle: "m",
  thispagestyle: "m",
  pagenumbering: "m",
  documentclass: "o m o",
  usepackage: "o m o",
  RequirePackage: "o m o",
  PassOptionsToPackage: "m m",
  PassOptionsToClass: "m m",
  usetikzlibrary: "m",
  addbibresource: "o m",
  bibliography: "m",
  bibliographystyle: "m",
  printbibliography: "o",
  hypersetup: "m",
  graphicspath: "m",
  geometry: "m",
  setlist: "o m",
  lstset: "m",
  lstdefinestyle: "m m",
  tcbset: "m",
  title: "o m",
  author: "s o m",
  affil: "s o m",
  affiliation: "o m",
  email: "o m",
  address: "o m",
  curraddr: "o m",
  abstract: "m",
  keywords: "m",
  subject: "m",
  subjclass: "o m",
  dedicatory: "m",
  dedication: "m",
  equalcont: "m",
  fnm: "m",
  sur: "m",
  spfx: "m",
  sfx: "m",
  orgdiv: "m",
  orgname: "m",
  orgaddress: "m",
  street: "m",
  city: "m",
  postcode: "m",
  state: "m",
  country: "m",
  institution: "m",
  inst: "m",
  IEEEauthorblockN: "m",
  IEEEauthorblockA: "m",
  corrauthor: "o m m",
  correspondingauthor: "m",
  authornote: "m",
  shorttitle: "m",
  shortauthors: "m",
  orcid: "m",
  orcidID: "m",
  titlerunning: "m",
  authorrunning: "m",
  department: "m",
  streetaddress: "m",
  ccsdesc: "o m",
  date: "m",
  subtitle: "m",
  institute: "m",
  version: "m",
  extrainfo: "m",
  cover: "m",
  logo: "m",
  multicolumn: "m m m",
  cline: "m",
  // booktabs' \cmidrule(trim){a-b}: its trim and range are read by tables.ts.
  cmidrule: "o",
  specialrule: "m m m",
  addlinespace: "o",
  multirow: "o m o m o m",
  subcaption: "s o m",
  resizebox: "s m m m",
  scalebox: "m o m",
  rotatebox: "o m m",
  tikz: "o",
  // algpseudocode's commands (their `algorithmic` environment is a TeX fragment for now).
  State: "",
  Statex: "",
  Procedure: "m m",
  Function: "m m",
  If: "m",
  ElsIf: "m",
  For: "m",
  ForAll: "m",
  While: "m",
  Until: "m",
  Call: "m m",
  Comment: "m",
};

const BUILTIN_ENVS: Record<string, Spec> = {
  figure: "o",
  "figure*": "o",
  table: "o",
  "table*": "o",
  algorithm: "o",
  algorithmic: "o",
  tabular: "o m",
  "tabular*": "m o m",
  tabularx: "m o m",
  array: "o m",
  longtable: "o m",
  minipage: "o o o m",
  itemize: "o",
  enumerate: "o",
  description: "o",
  thebibliography: "m",
  tikzpicture: "o",
  tikzcd: "o",
  circuitikz: "o",
  multicols: "m o",
  "multicols*": "m o",
  tcolorbox: "o",
  wrapfigure: "o m o m",
  wraptable: "o m o m",
  subfigure: "o o o m",
  subtable: "o o o m",
  sidewaysfigure: "o",
  sidewaystable: "o",
  proof: "o",
};

/** The spec of a theorem map entry (theorems.ts's TheoremSpec). */
const THEOREM_SPECS: Record<TheoremSpec, Spec> = { tcb: "g o t\\label g", "tcb*": "g o", o: "o", m: "m", "": "" };

/** `\newcommand{\x}[n][default]` as a spec: `o m` for an optional first argument, else `m`s. */
function commandSpec(args: number, optional: boolean): Spec {
  return [...(optional ? ["o"] : []), ...Array(Math.max(0, args - (optional ? 1 : 0))).fill("m")].join(" ");
}

/** An xparse spec as the parser reads it: the letters it knows, `m` for the other argument types. */
function xparseSpec(spec: string): Spec {
  const out: string[] = [];
  for (const m of spec.matchAll(/\s*(?:([+!>=]\{[^}]*\}|[+!])|(t\\[A-Za-z@]+|t\S|O\{[^}]*\}|[somg])|([a-zA-Z])(?:\{[^}]*\})*)/g)) {
    if (m[2]) out.push(m[2]);
    else if (m[3]) out.push("m");
  }
  return out.join(" ");
}

/** Traditional environment declarations, read only from actual definition nodes (not verbatim). */
function environmentDefinitions(src: string): Map<string, EnvironmentDefinition> {
  const out = new Map<string, EnvironmentDefinition>();
  const empty = { macros: new Map(), envs: new Map() };
  const group = (text: string, at: number, open: string): { text: string; end: number } | null => {
    while (/\s/.test(text[at] ?? "") && at < text.length) at++;
    if (text[at] !== open) return null;
    const close = open === "{" ? "}" : "]";
    let braces = 0;
    for (let i = at + 1; i < text.length; i++) {
      if (text[i] === "\\") { i++; continue; }
      if (text[i] === "{") braces++;
      else if (text[i] === "}" && braces) braces--;
      else if (text[i] === close && !braces) return { text: text.slice(at + 1, i), end: i + 1 };
    }
    return null;
  };
  const declarations: TexNode[] = [];
  walkTex(parseTex(src, empty), (node) => {
    if (node.t === "macro" && node.code && /^(?:re)?newenvironment$/.test(node.name)) declarations.push(node);
  });
  for (const node of declarations) {
    if (node.t !== "macro") continue;
    const text = src.slice(node.from, node.to);
    let at = node.name.length + 1;
    if (text[at] === "*") at++;
    const name = group(text, at, "{");
    if (!name) continue;
    at = name.end;
    const count = group(text, at, "[");
    const args = count ? Number(count.text.trim()) : 0;
    if (!Number.isInteger(args) || args < 0 || args > 9) continue;
    if (count) at = count.end;
    const optional = count && args > 0 ? group(text, at, "[") : null;
    if (optional) at = optional.end;
    const begin = group(text, at, "{");
    if (!begin) continue;
    const end = group(text, begin.end, "{");
    if (end) out.set(name.text.trim(), { args, ...(optional ? { optional: optional.text } : {}), begin: begin.text, end: end.text });
  }
  return out;
}

/**
 * The parser's signatures for a project: the built-ins, then (later ones win) the macros of
 * `defs` (\newcommand's `[n][default]`, \def's parameters), the \NewDocumentCommand and
 * \newenvironment specs of the comment-free `sources`, and the theorem map's environments.
 */
export function projectSignatures(defs: Definitions, sources: readonly string[], theorems: TheoremMap): Signatures {
  const macros = new Map(Object.entries(BUILTIN_MACROS));
  const envs = new Map(Object.entries(BUILTIN_ENVS));
  const definers = new Map<string, string>();
  const environmentDefs = new Map<string, EnvironmentDefinition>();
  // A class may implement a public command as a zero-parameter wrapper whose internal
  // reader consumes its arguments: sn-jnl's section -> @startsection, or caption -> @dblarg.
  // The scanner correctly sees no # parameters in the wrapper, but that is not the public
  // call's arity. Keep a known signature only with this evidence; real user redefinitions
  // (including a zero-argument constant) and commands with explicit parameters still win.
  const lastStatements = new Map<string, string>();
  for (const statement of defs.statements) {
    const declared = /^\\(?:(?:re)?newcommand\{\\([A-Za-z@]+)\}|def\\([A-Za-z@]+)(?![A-Za-z@]))/.exec(statement);
    if (declared) lastStatements.set(declared[1] ?? declared[2], statement);
  }
  for (const [name, statement] of defs.unsupported) lastStatements.set(name, statement);
  // Producer declarations retain complete bodies and the actual provide/override order;
  // unsupported strings above are display messages and may end after only 80 characters.
  for (const [name, statement] of defs.declarations ?? []) lastStatements.set(name, statement);
  for (const [name, scanned] of defs.macros) {
    // The coarse arity map merges a whole file when the project walker enters it. A class
    // can therefore overwrite an arity the root redefines later. Statements retain execution
    // order at each input/package site; parse the last actual definition when it is recorded.
    const statement = lastStatements.get(name);
    const m = statement ? scanDefinitions(statement).macros.get(name) ?? scanned : scanned;
    const reader = /^\\(?:(?:re)?newcommand\{\\[A-Za-z@]+\}|def\\[A-Za-z@]+)\{\s*\\@(?:startsection|ifstar|ifnextchar|dblarg|protected@testopt|testopt)\b/.test(statement ?? "");
    // AASTeX's first section performs title/setup work before delegating to @startsection.
    // Only a known section command forwarding to the same named reader gets this allowance.
    const headingReader = SECTIONS.includes(name) && new RegExp(`\\\\@startsection\\s*\\{\\s*${name}\\s*\\}`).test(statement ?? "");
    // AASTeX's author reader ends in this verified ORCID/no-ORCID lookahead, after optional
    // counter setup. A different futurelet handler is not evidence for the public signature.
    const authorReader = name === "author" && /\\futurelet\s*\\next\s*\\lookforbracket\s*\}$/.test(statement ?? "");
    // sn-jnl advances a counter before its star dispatch; both branches consume [ids]{text}.
    const indexedStarReader = (name === "author" && /\\@ifstar\s*\\@@corrauthor\s*\\@@author\s*\}$/.test(statement ?? "")) ||
      (name === "affil" && /\\@ifstar\s*\\@@coraddress\s*\\@@address\s*\}$/.test(statement ?? ""));
    if (!(m.args === 0 && !m.optional && (reader || headingReader || authorReader || indexedStarReader) && macros.has(name))) macros.set(name, commandSpec(m.args, m.optional));
  }
  for (const raw of sources) {
    const src = stripComments(raw);
    for (const m of src.matchAll(/\\(?:New|Renew|Provide|Declare)DocumentCommand\s*\{?\s*\\([A-Za-z@]+)\s*\}?\s*\{([^{}]*)\}/g)) {
      macros.set(m[1], xparseSpec(m[2]));
    }
    for (const [name, def] of environmentDefinitions(src)) {
      envs.set(name, commandSpec(def.args, def.optional !== undefined));
      environmentDefs.set(name, def);
    }
    for (const m of src.matchAll(/\\(?:New|Renew|Provide|Declare)DocumentEnvironment\s*\{([^}]+)\}\s*\{([^{}]*)\}/g)) {
      envs.set(m[1].trim(), xparseSpec(m[2]));
    }
    // Definers the document renamed: `\newcommand{\nc}{\newcommand}`, `\let\nc\newcommand`.
    for (const m of src.matchAll(
      /\\(?:(?:re)?newcommand\*?\s*\{?\s*\\([A-Za-z]+)\s*\}?\s*\{\s*\\((?:re)?newcommand|providecommand)\s*\}|let\s*\\([A-Za-z]+)\s*=?\s*\\((?:re)?newcommand))/g,
    )) {
      definers.set(m[1] ?? m[3], m[2] ?? m[4]);
      macros.delete(m[1] ?? m[3]);
    }
  }
  for (const [env, d] of theorems) envs.set(env, THEOREM_SPECS[d.spec]);
  return { macros, envs, definers, environmentDefs };
}

/**
 * The spec of an environment from the probe's census (`\meaning` of its begin macro): an xparse
 * environment's argument spec (elegantbook's `g o t\label g`), a `\newenvironment` with an
 * optional argument (`\@protected@testopt`), or the number of `#` parameters; null when the
 * meaning says nothing (a primitive, `\relax`, a macro without parameters).
 */
export function censusSpec(meaning: string): Spec | null {
  const m = /^(?:\\(?:long|protected|outer) )*macro:(.*?)->([\s\S]*)$/.exec(meaning.trim());
  if (!m) return null;
  const body = m[2].trim();
  const xparse = /^\\__cmd_start_env:nnnnn \{([^{}]*)\}/.exec(body);
  if (xparse) return xparseSpec(xparse[1]);
  // `\newenvironment{x}[n][default]`: the optional argument, then n - 1 mandatory ones (the count
  // lives in the inner macro; one optional is what the census can tell).
  if (/^\\@protected@testopt\b/.test(body)) return "o";
  // LaTeX/amsthm's @thm and LNCS's @spthm/@Thm read an optional note. Recognize their
  // actual begin-macro reader, not an unfamiliar environment's name or styling.
  if (/^\\(?:@thm|@spthm|@Thm)\b/.test(body)) return "o";
  return commandSpec((m[1].match(/#\d/g) ?? []).length, false);
}

/** `sig` with the census's environments (those it could read) over the project's. */
export function withCensus<T extends Signatures>(sig: T, census: ReadonlyMap<string, string>): T {
  const envs = new Map(sig.envs);
  for (const [env, meaning] of census) {
    const spec = censusSpec(meaning);
    if (spec !== null && !sig.envs.has(env)) envs.set(env, spec);
  }
  return { ...sig, envs };
}
