import type { AuxLabel } from "../tex/aux";
import { BibEntry, citeLabel } from "../tex/bib";
import { texText } from "../tex/texText";

// What references and citations show (design 4.4 #9, #10), for live preview's chips and for the
// references inside formulas (prepareMath). Pure: no view, no Obsidian. The texts are what the
// PDF prints (measured on TeX Live 2026: hyperref 7, cleveref 0.21):
//   \ref -> `1.2`, \eqref -> `(1.2)`, \pageref -> the page, \nameref -> the title; `??` for an
//   unknown label.
//   \autoref -> hyperref's name for the anchor's type, then the number (`Equation 1.2`,
//   `section 1`, `item 1.`); the number alone for a type without a name (elegantbook's tcolorbox
//   theorems, an amsthm theorem with a counter of its own). The project's `\<type>autorefname`
//   definitions replace the English defaults.
//   \cref, \Cref -> cleveref's text for the label types of the .aux twins: grouped by type in the
//   order the types first appear, sorted, three or more consecutive numbers as a range, plural
//   names (`eqs. (1) to (3) and (5)`, `Section 1 and Theorem 2.1`, `section 1, theorem 1.1, and
//   fig. 1`), with the package options `capitalise` and `noabbrev`, `\crefname`/`\Crefname` and
//   \newtheorem titles from the sources; `??` before a number whose type has no name (cleveref's
//   warning), `??` for an unknown label.
//   \cite and its relatives -> `[see Li et al. 2019, p. 3]` (keys without an entry as keys).

/** A cleveref name: singular and plural (null when only a \newtheorem title gave the singular). */
export type CrefName = readonly [singular: string, plural: string | null];

/** How a project's \autoref and \cref name labels (refNames). */
export interface RefNames {
  /** hyperref's `\<type>autorefname` by anchor type (`section`, `AMS`); a type without one prints its number alone. */
  readonly autoref: ReadonlyMap<string, string>;
  /** cleveref's names by label type, as \cref and as \Cref print them. */
  readonly cref: ReadonlyMap<string, CrefName>;
  readonly Cref: ReadonlyMap<string, CrefName>;
}

/** What a root's documents refer to: its last compile's labels and its bibliography. */
export interface LatexRefs {
  /** Label key -> number field (prepareMath's tags); the same object while the numbers stay. */
  readonly numbers: ReadonlyMap<string, string>;
  /** Label key -> its .aux entry (number, page, title, anchor, cleveref type). */
  readonly labels: ReadonlyMap<string, AuxLabel>;
  /** Citation key -> its .bib entry. */
  readonly cites: ReadonlyMap<string, BibEntry>;
  /** The project's reference names (refNames of its sources). */
  readonly names: RefNames;
}

/** hyperref's English `\<type>autorefname`s (hyperref.sty's defaults). */
const AUTOREF_NAMES: Record<string, string> = {
  equation: "Equation",
  footnote: "footnote",
  item: "item",
  figure: "Figure",
  table: "Table",
  part: "Part",
  appendix: "Appendix",
  chapter: "chapter",
  section: "section",
  subsection: "subsection",
  subsubsection: "subsubsection",
  paragraph: "paragraph",
  subparagraph: "subparagraph",
  FancyVerbLine: "line",
  theorem: "Theorem",
  page: "page",
  // Not an autorefname: \autoref falls back to `\<type>name`, which listings defines.
  lstlisting: "Listing",
};
/** Anchor types whose name is another type's (`\AMSautorefname` is `\equationautorefname`). */
const AUTOREF_ALIASES: Record<string, string> = { AMS: "equation", Hfootnote: "footnote", Item: "item" };

/** cleveref's English names as \Cref prints them. */
const CREF_NAMES: Record<string, [string, string]> = {
  equation: ["Equation", "Equations"],
  figure: ["Figure", "Figures"],
  table: ["Table", "Tables"],
  page: ["Page", "Pages"],
  part: ["Part", "Parts"],
  chapter: ["Chapter", "Chapters"],
  section: ["Section", "Sections"],
  appendix: ["Appendix", "Appendices"],
  enumi: ["Item", "Items"],
  footnote: ["Footnote", "Footnotes"],
  theorem: ["Theorem", "Theorems"],
  lemma: ["Lemma", "Lemmas"],
  corollary: ["Corollary", "Corollaries"],
  proposition: ["Proposition", "Propositions"],
  definition: ["Definition", "Definitions"],
  result: ["Result", "Results"],
  example: ["Example", "Examples"],
  remark: ["Remark", "Remarks"],
  note: ["Note", "Notes"],
  algorithm: ["Algorithm", "Algorithms"],
  listing: ["Listing", "Listings"],
  line: ["Line", "Lines"],
};
/** \cref's abbreviations (dropped by `noabbrev`). */
const CREF_ABBREVIATIONS: Record<string, [string, string]> = { equation: ["Eq.", "Eqs."], figure: ["Fig.", "Figs."] };
/** A type without names takes its parent's (cleveref's \@crefcopyformats at \begin{document}). */
const CREF_COPIES: readonly (readonly [parent: string, child: string])[] = [
  ["section", "subsection"],
  ["subsection", "subsubsection"],
  ["appendix", "subappendix"],
  ["subappendix", "subsubappendix"],
  ["figure", "subfigure"],
  ["table", "subtable"],
  ["equation", "subequation"],
  ["enumi", "enumii"],
  ["enumii", "enumiii"],
  ["enumiii", "enumiv"],
  ["enumiv", "enumv"],
];
/** cleveref prints these types' numbers in parentheses. */
const PARENTHESIZED = new Set(["equation", "subequation"]);

/** A brace group (two levels of nesting inside), its content captured. */
const ARG = String.raw`\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}`;
const CLEVEREF_OPTIONS =
  /\\(?:usepackage|RequirePackage)\s*\[([^\]]*)\]\s*\{[^}]*\bcleveref\b[^}]*\}|\\PassOptionsToPackage\s*\{([^}]*)\}\s*\{[^}]*\bcleveref\b[^}]*\}/g;
const CREFNAME = new RegExp(String.raw`\\(c|C)refname\s*\{\s*([^{}\s]+)\s*\}\s*${ARG}\s*${ARG}`, "g");
const NEWTHEOREM = new RegExp(String.raw`\\newtheorem\s*\{\s*([^{}\s]+)\s*\}\s*(?:\[[^\]]*\]\s*)?${ARG}`, "g");
const AUTOREFNAME = new RegExp(
  String.raw`\\((?:re)?newcommand|providecommand|DeclareRobustCommand|[gex]?def)\s*\*?\s*\{?\s*\\([A-Za-z@]+)autorefname\s*\}?\s*${ARG}`,
  "g",
);

const upperFirst = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
const lowerFirst = (s: string): string => s.charAt(0).toLowerCase() + s.slice(1);

/**
 * The reference names of a project from its sources (comment-free, in document order): hyperref's
 * defaults with the `\<type>autorefname` definitions; cleveref's English names with its package
 * options, the \newtheorem titles (cleveref names a theorem type by its title: singular only) and
 * `\crefname`/`\Crefname` (the one not given follows the other: capitalized for \Cref, lower case
 * for \cref unless `capitalise`), a type without names taking its parent's (`subsection`).
 */
export function refNames(sources: readonly string[]): RefNames {
  let capitalise = false;
  let abbrev = true;
  const autoref = new Map(Object.entries(AUTOREF_NAMES));
  const redefined = new Set<string>();
  const own = { cref: new Map<string, CrefName>(), Cref: new Map<string, CrefName>() };
  const theorems = new Map<string, string>();
  for (const src of sources) {
    for (const m of src.matchAll(CLEVEREF_OPTIONS)) {
      const options = (m[1] ?? m[2]).split(",").map((o) => o.trim());
      if (options.includes("capitalise") || options.includes("capitalize")) capitalise = true;
      if (options.includes("noabbrev")) abbrev = false;
    }
    for (const m of src.matchAll(CREFNAME)) own[m[1] === "c" ? "cref" : "Cref"].set(m[2], [texText(m[3]), texText(m[4])]);
    for (const m of src.matchAll(NEWTHEOREM)) theorems.set(m[1], texText(m[2]));
    for (const m of src.matchAll(AUTOREFNAME)) {
      if (m[1] === "providecommand" && (autoref.has(m[2]) || redefined.has(m[2]))) continue;
      autoref.set(m[2], texText(m[3]));
      redefined.add(m[2]);
    }
  }
  for (const [alias, type] of Object.entries(AUTOREF_ALIASES)) {
    const name = autoref.get(type);
    if (!redefined.has(alias) && name !== undefined) autoref.set(alias, name);
  }

  // cleveref's preamble names: the defaults, then the theorem titles (their plural stays).
  const cref = new Map<string, CrefName>();
  const Cref = new Map<string, CrefName>();
  for (const [type, names] of Object.entries(CREF_NAMES)) {
    Cref.set(type, names);
    const [one, many] = abbrev && Object.hasOwn(CREF_ABBREVIATIONS, type) ? CREF_ABBREVIATIONS[type] : names;
    cref.set(type, capitalise ? [one, many] : [lowerFirst(one), lowerFirst(many)]);
  }
  for (const [env, title] of theorems) {
    cref.set(env, [capitalise ? upperFirst(title) : lowerFirst(title), cref.get(env)?.[1] ?? null]);
    Cref.set(env, [upperFirst(title), Cref.get(env)?.[1] ?? null]);
  }
  // The document's own names win; one variant given makes the other.
  for (const [type, [one, many]] of own.cref) {
    cref.set(type, [one, many]);
    if (!own.Cref.has(type)) Cref.set(type, [upperFirst(one), many === null ? null : upperFirst(many)]);
  }
  for (const [type, [one, many]] of own.Cref) {
    Cref.set(type, [one, many]);
    if (!own.cref.has(type)) cref.set(type, capitalise ? [one, many] : [lowerFirst(one), many === null ? null : lowerFirst(many)]);
  }
  for (const names of [cref, Cref]) for (const [parent, child] of CREF_COPIES) if (!names.has(child) && names.has(parent)) names.set(child, names.get(parent)!);
  return { autoref, cref, Cref };
}

/** Two projects name references alike. */
export function sameRefNames(a: RefNames, b: RefNames): boolean {
  const same = <T>(x: ReadonlyMap<string, T>, y: ReadonlyMap<string, T>) =>
    x.size === y.size && [...x].every(([k, v]) => y.has(k) && JSON.stringify(y.get(k)) === JSON.stringify(v));
  return same(a.autoref, b.autoref) && same(a.cref, b.cref) && same(a.Cref, b.Cref);
}

/** The names of a project whose sources name nothing: hyperref's and cleveref's defaults. */
export const DEFAULT_REF_NAMES: RefNames = refNames([]);

const MISSING = "??";

/** A label's number as typeset (`\tag{$\star$}` is ⋆, elegantbook's coloured item number `1.`). */
const num = (l: AuxLabel): string => texText(l.number) || l.number;

/** `a`, `a and b`, `a, b and c` (cleveref's conjunctions; `last` is `, and ` between groups). */
function conjoin(items: readonly string[], last: string): string {
  if (items.length <= 2) return items.join(" and ");
  return items.slice(0, -1).join(", ") + last + items[items.length - 1];
}

/** Labels in cleveref's order (by their sort keys, when every one has a key). */
function sorted(labels: readonly AuxLabel[]): AuxLabel[] {
  if (!labels.every((l) => l.order)) return [...labels];
  return [...labels].sort((a, b) => {
    const x = a.order!;
    const y = b.order!;
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
    return x.length - y.length;
  });
}

/** `b` directly follows `a`: the same enclosing counters, the next value. */
function follows(a: AuxLabel, b: AuxLabel): boolean {
  const x = a.order;
  const y = b.order;
  if (!x || !y || x.length !== y.length) return false;
  for (let i = 0; i < x.length - 1; i++) if (x[i] !== y[i]) return false;
  return y[y.length - 1] === x[x.length - 1] + 1;
}

/** What \cref or \Cref prints for `found` (undefined: an unknown label); `warned` when cleveref has no name for a type. */
function crefText(names: ReadonlyMap<string, CrefName>, found: readonly (AuxLabel | undefined)[]): { text: string; warned: boolean } {
  // Groups by type in the order the types first appear; an unknown label is a group of its own.
  const groups: (AuxLabel[] | null)[] = [];
  const byKind = new Map<string, AuxLabel[]>();
  for (const l of found) {
    if (!l) {
      groups.push(null);
      continue;
    }
    let group = byKind.get(l.kind);
    if (!group) {
      byKind.set(l.kind, (group = []));
      groups.push(group);
    }
    group.push(l);
  }
  let warned = false;
  const texts = groups.map((group) => {
    if (!group) return MISSING;
    const kind = group[0].kind;
    const label = (l: AuxLabel) => (PARENTHESIZED.has(kind) ? `(${num(l)})` : num(l));
    const labels = sorted(group);
    const name = names.get(kind);
    const word = name && (labels.length === 1 ? name[0] : name[1]);
    if (word === undefined || word === null) {
      warned = true;
      return labels.map((l) => MISSING + label(l)).join("");
    }
    // Runs of consecutive numbers; three or more become a range.
    const items: string[] = [];
    for (let i = 0; i < labels.length; ) {
      let j = i + 1;
      while (j < labels.length && follows(labels[j - 1], labels[j])) j++;
      if (j - i >= 3) items.push(`${label(labels[i])} to ${label(labels[j - 1])}`);
      else for (let k = i; k < j; k++) items.push(label(labels[k]));
      i = j;
    }
    const list = conjoin(items, " and ");
    return word ? `${word} ${list}` : list;
  });
  return { text: conjoin(texts, ", and "), warned };
}

/** What a reference command (without its star) typesets for `keys`; `missing` when a label is unknown (or \cref has no name for it). */
export function refText(command: string, keys: readonly string[], refs: LatexRefs): { text: string; missing: boolean } {
  const found = keys.map((k) => refs.labels.get(k));
  let missing = found.some((l) => !l);
  const each = (f: (l: AuxLabel) => string) => found.map((l) => (l ? f(l) : MISSING)).join(", ");
  let text: string;
  switch (command) {
    case "eqref":
      text = found.map((l) => `(${l ? num(l) : MISSING})`).join(", ");
      break;
    case "pageref":
      text = each((l) => l.page || MISSING);
      break;
    case "nameref":
      text = each((l) => texText(l.title) || num(l));
      break;
    case "autoref":
      text = each((l) => {
        const name = refs.names.autoref.get(l.anchor.split(".", 1)[0]);
        return name ? `${name} ${num(l)}` : num(l);
      });
      break;
    case "cref":
    case "Cref": {
      const cleveref = crefText(command === "cref" ? refs.names.cref : refs.names.Cref, found);
      text = cleveref.text;
      missing ||= cleveref.warned;
      break;
    }
    default:
      text = each(num);
  }
  return { text, missing };
}

/**
 * What a citation shows: `[pre A 2020; B 2021, post]`; `missing` when a key has no entry;
 * `title` names each key's entry (the chip's tooltip).
 */
export function citeText(
  keys: readonly string[],
  prenote: string | null,
  postnote: string | null,
  refs: LatexRefs,
): { text: string; missing: boolean; title: string } {
  const entries = keys.map((k) => refs.cites.get(k));
  let text = keys.map((k, i) => (entries[i] ? citeLabel(entries[i]) : k)).join("; ");
  if (prenote) text = `${texText(prenote)} ${text}`;
  if (postnote) text += `, ${texText(postnote)}`;
  const title = keys
    .map((k, i) => {
      const e = entries[i];
      return e ? `${k}: ${citeLabel(e)}${e.title ? `. ${e.title}` : ""}` : `${k}: not in the bibliography`;
    })
    .join("\n");
  return { text: `[${text}]`, missing: entries.some((e) => !e), title };
}

/** References inside formulas read as the chips do (prepareMath's `refs`). */
export const formulaRefs =
  (refs: LatexRefs) =>
  (command: string, keys: readonly string[]): string =>
    refText(command, keys, refs).text;
