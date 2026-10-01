import { groupEnd } from "../tex/texText";

/**
 * BibTeX publisher wrappers whose selected argument is the printed content. Indices are
 * zero-based. Use only while rendering a bibliography: a project's same-named text macro
 * keeps its own meaning elsewhere. Keep the argument's parsed nodes, rather than texText,
 * so accents, math, links and nested text formatting survive.
 * REVTeX's apsrev4-2/aipauth4-2 and AASTeX's aasjournalv7 emit these wrappers.
 */
export const BBL_WRAPPERS: Readonly<Record<string, number>> = {
  bibfield: 1,
  bibinfo: 1,
  "href@noop": 1,
  bibnamefont: 0,
  bibfnamefont: 0,
  citenamefont: 0,
  natexlab: 0,
  // ACM-Reference-Format.bst defaults to identity; explicit source overrides win in the emitter.
  showarticletitle: 0,
};

/** Publisher bibliography markers which print no text (not arbitrary unknown macros). */
export const BBL_SILENT: ReadonlySet<string> = new Set(["BibitemOpen", "EOS"]);

/** REVTeX's closing punctuation; BibitemShut dispatches to one of these by its argument. */
export const BBL_TEXT: Readonly<Record<string, string>> = { bibitemStop: "", bibitemNoStop: "." };

/** Wrappers which add punctuation around their richly rendered argument. */
export const BBL_QUOTES: Readonly<Record<string, readonly [open: string, close: string]>> = {
  enquote: ["“", "”"],
  translation: ["[", "]"],
};

/** The known REVTeX BibitemShut dispatches; null leaves an unknown mode reportable. */
export function bblShutText(mode: string): string | null {
  const command = `bibitem${mode.trim()}`;
  return Object.prototype.hasOwnProperty.call(BBL_TEXT, command) ? BBL_TEXT[command] : null;
}

/** The parser must consume marker/metadata arguments even when none of them prints. */
export const BBL_SIGNATURES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(Object.entries(BBL_WRAPPERS).map(([name, index]) => [name, Array(index + 1).fill("m").join(" ")])),
  ...Object.fromEntries([...BBL_SILENT, ...Object.keys(BBL_TEXT)].map((name) => [name, ""])),
  ...Object.fromEntries(Object.keys(BBL_QUOTES).map((name) => [name, "m"])),
  BibitemShut: "m",
};

// The bibliography and citation labels of the HTML export (design 3.6). Pure: the exporter reads
// the files, the emitter renders the TeX of field values (math, accents, `\emph`).
//   biblatex  the .bbl's entries in the order of its first data list (the sorting the numbers
//             follow), names with their parts (CJK authors have a family name only), lists and
//             fields; `formatEntry` prints an entry as biblatex's standard bibliography styles do
//             with English strings (standard.bbx: `In:`, `pp.`, `2nd ed.`, `Ed. by`, `URL: ..
//             (visited on 09/01/2026)`), checked against the synthetic book's PDF.
//   labels    numeric citations join their numbers with `, `; numeric-comp (and natbib's `sort`,
//             `compress`) sorts them and makes runs of three or more a range (`[1–3, 5]`, but
//             `[2, 3]`), as both packages do.
//   BibTeX    natbib's and LaTeX's labels are the .aux's `\bibcite{key}{..}` (natbib steps its own
//             counter with `\advance`, which the probe never sees): `{1}{2023}{{Doe and Example}}{{}}`
//             or `{1}` / `{Knu84}`.

export interface BblName {
  given: string;
  family: string;
  prefix: string;
  suffix: string;
}

/** A biblatex .bbl entry; values are TeX with biblatex's delimiter macros replaced by text. */
export interface BblEntry {
  key: string;
  type: string;
  /** Name lists by role (`author`, `editor`, `translator`). */
  names: Map<string, BblName[]>;
  /** Roles whose list ends in `and others` (`\true{moreauthor}`). */
  more: Set<string>;
  /** Literal lists (`publisher`, `location`, `institution`, `language`). */
  lists: Map<string, string[]>;
  /** Fields (`title`, `journaltitle`, `year`, `pages`) and verbatim fields (`url`, `doi`). */
  fields: Map<string, string>;
}

/** biblatex's punctuation and name delimiters as the text they print. */
const BBL_MACROS: Record<string, string> = {
  bibrangedash: "–",
  bibdatedash: "–",
  bibrangessep: ", ",
  bibinitperiod: ".",
  bibinitdelim: " ",
  bibinithyphendelim: ".-",
  bibnamedelima: " ",
  bibnamedelimb: " ",
  bibnamedelimc: " ",
  bibnamedelimd: " ",
  bibnamedelimi: " ",
};
const BBL_MACRO = new RegExp(String.raw`\\(${Object.keys(BBL_MACROS).join("|")})(?![A-Za-z])\s*`, "g");
const clean = (tex: string): string => tex.replace(BBL_MACRO, (_m, name: string) => BBL_MACROS[name]);

/** The brace groups from s[i] on (white space and `%` line ends between them skipped): contents and end. */
function groups(s: string, i: number, count: number): { values: string[]; end: number } {
  const values: string[] = [];
  while (values.length < count) {
    while (i < s.length && /[\s%]/.test(s[i])) i++;
    if (s[i] !== "{") break;
    const end = groupEnd(s, i);
    values.push(s.slice(i + 1, end - 1));
    i = end;
  }
  return { values, end: i };
}

/** One name of a `\name` list: `{{hash=..}{% family={..}, given={..}, ..}}`. */
function readName(s: string): BblName {
  const parts: Record<string, string> = {};
  for (const m of s.matchAll(/(\w+)=\{/g)) parts[m[1]] = clean(s.slice(m.index! + m[0].length, groupEnd(s, m.index! + m[0].length - 1) - 1));
  return { given: parts.given ?? "", family: parts.family ?? "", prefix: parts.prefix ?? "", suffix: parts.suffix ?? "" };
}

/** The entries of a biblatex .bbl, in the order of its first entry data list; [] for a BibTeX .bbl. */
export function readBbl(text: string): BblEntry[] {
  const start = text.indexOf("\\datalist[entry]");
  if (start < 0) return [];
  const stop = text.indexOf("\\enddatalist", start);
  const list = text.slice(start, stop < 0 ? text.length : stop);
  const out: BblEntry[] = [];
  for (const m of list.matchAll(/\\entry\{([^{}]*)\}\{([^{}]*)\}/g)) {
    const from = m.index! + m[0].length;
    const to = list.indexOf("\\endentry", from);
    const body = list.slice(from, to < 0 ? list.length : to);
    const e: BblEntry = { key: m[1], type: m[2], names: new Map(), more: new Set(), lists: new Map(), fields: new Map() };
    for (const c of body.matchAll(/\\(name|list|field|verb|true)\{([^{}]*)\}/g)) {
      const at = c.index! + c[0].length;
      if (c[1] === "name" || c[1] === "list") {
        // \name{author}{2}{}{%  {{hash=..}{..}}%  .. }   \list{publisher}{1}{%  {name}%  }
        const count = c[1] === "name" ? 3 : 2;
        const inner = groups(body, at, count).values[count - 1] ?? "";
        const items: string[] = [];
        for (let i = 0; i < inner.length; i++) {
          if (inner[i] !== "{") continue;
          const end = groupEnd(inner, i);
          items.push(inner.slice(i + 1, end - 1));
          i = end - 1;
        }
        if (c[1] === "name") e.names.set(c[2], items.map(readName));
        else e.lists.set(c[2], items.map(clean));
      } else if (c[1] === "field") {
        const v = groups(body, at, 1).values[0];
        if (v !== undefined) e.fields.set(c[2], clean(v));
      } else if (c[1] === "verb") {
        // \verb{url}↵ \verb https://..↵ \endverb
        const end = body.indexOf("\\endverb", at);
        const lines = [...body.slice(at, end < 0 ? body.length : end).matchAll(/\\verb (.*)/g)].map((l) => l[1]);
        e.fields.set(c[2], lines.join("\n").trim());
      } else if (c[2].startsWith("more")) e.more.add(c[2].slice(4));
    }
    out.push(e);
  }
  return out;
}

/** A `\bibcite` label: natbib's number or label, year and short and full author lists (TeX). */
export interface BibCite {
  label: string;
  year: string;
  authors: string;
  full: string;
}

/** The `\bibcite{key}{..}` labels of .aux texts (natbib's four fields, or LaTeX's one). */
export function readBibcites(auxTexts: Iterable<string>): Map<string, BibCite> {
  const out = new Map<string, BibCite>();
  for (const text of auxTexts) {
    for (const m of text.matchAll(/\\bibcite\{([^{}]+)\}\{/g)) {
      const open = m.index! + m[0].length - 1;
      const value = text.slice(open + 1, groupEnd(text, open) - 1);
      const fields = value.trimStart().startsWith("{") ? groups(value, 0, 4).values : [value];
      const inner = (s: string | undefined) => (s ?? "").replace(/^\{([\s\S]*)\}$/, "$1");
      if (!out.has(m[1])) out.set(m[1], { label: fields[0] ?? "", year: fields[1] ?? "", authors: inner(fields[2]), full: inner(fields[3]) });
    }
  }
  return out;
}

/** One numeric label of a citation: the text and the key its entry has. */
export interface CiteNumber {
  key: string;
  prefix: string;
  number: string;
}

/** A citation's label list as pieces: a label (with its key) or a separator. */
export type LabelPiece = { key: string; text: string } | { sep: string };

/**
 * Numeric labels as biblatex's numeric styles and natbib print them: joined with `, `; with
 * `sort`, in numeric order; with `compress`, runs of three or more consecutive numbers of one
 * prefix as a range (`1–3`), a pair as it is (`2, 3`); a key cited twice once.
 */
export function numericLabels(labels: readonly CiteNumber[], o: { sort: boolean; compress: boolean }): LabelPiece[] {
  const seen = new Set<string>();
  let list = labels.filter((l) => !seen.has(l.key) && seen.add(l.key));
  const n = (l: CiteNumber) => (/^\d+$/.test(l.number) ? Number(l.number) : NaN);
  if (o.sort) list = [...list].sort((a, b) => a.prefix.localeCompare(b.prefix) || (n(a) - n(b) || 0));
  const out: LabelPiece[] = [];
  for (let i = 0; i < list.length; ) {
    let j = i + 1;
    if (o.compress) while (j < list.length && list[j].prefix === list[i].prefix && n(list[j]) === n(list[j - 1]) + 1) j++;
    if (out.length) out.push({ sep: ", " });
    const label = (l: CiteNumber) => ({ key: l.key, text: l.prefix + l.number });
    if (j - i >= 3) {
      out.push(label(list[i]), { sep: "–" }, label(list[j - 1]));
      i = j;
    } else {
      out.push(label(list[i]));
      i++;
    }
  }
  return out;
}

/** biblatex's page prefix for a postnote that is a page or a range (`p. 3`, `pp. 3–5`), else the note. */
export function postnoteText(note: string): string {
  const t = note.trim();
  const page = String.raw`(?:\d+|[ivxlcdm]+)`;
  if (new RegExp(`^${page}$`, "i").test(t)) return `p. ${t}`;
  const range = new RegExp(`^(${page})\\s*(?:--?|–|\\\\bibrangedash)\\s*(${page})$`, "i").exec(t);
  return range ? `pp. ${range[1]}–${range[2]}` : note;
}

/** A name as the bibliography prints it: `Given prefix Family, Suffix` (CJK names: the family alone). */
const fullName = (n: BblName, text: (tex: string) => string): string =>
  [n.given, n.prefix, n.family].filter(Boolean).map(text).join(" ") + (n.suffix ? `, ${text(n.suffix)}` : "");

/** A name list: `A and B`, `A, B, and C`; more than three names (maxnames 3) or `and others`: `A et al.`. */
export function nameList(names: readonly BblName[], more: boolean, one: (n: BblName) => string): string {
  if (!names.length) return "";
  if (names.length > 3) return `${one(names[0])} et al.`;
  const list = names.map(one);
  const joined = list.length <= 2 ? list.join(" and ") : `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
  return more ? `${joined} et al.` : joined;
}

/** The names a citation shows (`\textcite`, `\citeauthor`): family names (`Li and Doe`). */
export function citeNames(e: BblEntry, text: (tex: string) => string): string {
  const names = e.names.get("author") ?? e.names.get("editor") ?? [];
  return nameList(names, e.more.has("author"), (n) => [n.prefix, n.family].filter(Boolean).map(text).join(" "));
}

/** biblatex's language names (its lbx keys `langgerman`); others print as written. */
const LANGUAGES = /^lang([a-z]+)$/;

/** English ordinal edition (`2nd ed.`), or the field as written. */
function edition(text: string): string {
  if (!/^\d+$/.test(text)) return text;
  const n = Number(text);
  const suffix = n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] ?? "th";
  return `${n}${suffix} ed.`;
}

/** Entry types whose title biblatex quotes (the others are italic). */
const QUOTED = new Set(["article", "inbook", "incollection", "inproceedings", "patent", "thesis", "unpublished"]);
const THESIS: Record<string, string> = { phdthesis: "PhD thesis", mathesis: "MA thesis", mastersthesis: "MA thesis", techreport: "Tech. rep.", resreport: "Research rep." };

/**
 * An entry as biblatex's standard styles print it (see the file comment): units separated by `. `,
 * `html` rendering a TeX value, `link` an external link (its URL is not escaped yet).
 */
export function formatEntry(e: BblEntry, html: (tex: string) => string, link: (url: string, text: string) => string): string {
  const f = (name: string) => e.fields.get(name) ?? "";
  const list = (name: string) => (e.lists.get(name) ?? []).map(html).join(" and ");
  const units: string[] = [];
  const unit = (s: string) => s && units.push(s);
  const people = (role: string) => nameList(e.names.get(role) ?? [], e.more.has(role), (n) => fullName(n, html));
  const authors = people("author");
  const editors = people("editor");
  unit(authors || (editors ? `${editors}, ${(e.names.get("editor")?.length ?? 0) > 1 ? "eds." : "ed."}` : ""));
  const title = f("title") ? html(f("title")) + (f("subtitle") ? `. ${html(f("subtitle"))}` : "") : "";
  unit(title && (QUOTED.has(e.type) ? `“${title}”` : `<i>${title}</i>`));
  unit(
    (e.lists.get("language") ?? [])
      .filter((l) => l !== "langenglish" && l !== "english")
      .map((l) => {
        const known = LANGUAGES.exec(l)?.[1];
        return known ? known[0].toUpperCase() + known.slice(1) : html(l);
      })
      .join(" and "),
  );
  const year = f("year");
  const pages = f("pages") ? `${/[–-]/.test(f("pages")) ? "pp." : "p."} ${html(f("pages"))}` : "";
  const publisher = [list("location"), list("publisher") || list("institution") || list("organization")].filter(Boolean).join(": ");
  const tail = (...parts: string[]) => parts.filter(Boolean).join(", ");
  switch (e.type) {
    case "article": {
      const issue = [f("volume") && html(f("volume")) + (f("number") ? `.${html(f("number"))}` : ""), year && `(${html(year)})`].filter(Boolean).join(" ");
      unit(tail(`In: ${[f("journaltitle") && `<i>${html(f("journaltitle"))}</i>`, issue].filter(Boolean).join(" ")}`, pages));
      break;
    }
    case "inbook":
    case "incollection":
    case "inproceedings":
      unit(f("booktitle") && `In: <i>${html(f("booktitle"))}</i>`);
      if (authors && editors) unit(`Ed. by ${editors}`);
      unit(f("edition") && html(edition(f("edition"))));
      unit(tail(publisher, year && html(year), pages));
      break;
    case "thesis":
    case "report":
      unit([THESIS[f("type")] ?? (f("type") && html(f("type"))), f("number") && html(f("number"))].filter(Boolean).join(" "));
      unit(tail(publisher, year && html(year)));
      break;
    case "online":
      unit(f("version") && `Version ${html(f("version"))}`);
      unit(year && html(year));
      break;
    case "book":
    case "collection":
    case "manual":
      unit(f("edition") && html(edition(f("edition"))));
      unit(tail(publisher, year && html(year), pages));
      break;
    default:
      unit(f("howpublished") && html(f("howpublished")));
      unit(tail(publisher, year && html(year), pages));
  }
  unit(f("note") && html(f("note")));
  if (f("doi")) unit(`DOI: ${link(`https://doi.org/${f("doi")}`, f("doi"))}`);
  if (f("eprint")) unit(`${f("eprinttype") ? html(f("eprinttype")) : "eprint"}: ${html(f("eprint"))}`);
  if (f("url")) {
    const visited = f("urlyear") ? ` (visited on ${[f("urlmonth"), f("urlday")].map((x) => x.padStart(2, "0")).join("/")}/${f("urlyear")})` : "";
    unit(`URL: ${link(f("url"), f("url"))}${visited}`);
  }
  unit(f("addendum") && html(f("addendum")));
  // Units end with `. ` unless one already ends a sentence (`Why?`).
  return units.map((u) => (/[.?!](?:<\/[a-z]+>|”)*$/.test(u) ? u : `${u}.`)).join(" ");
}
