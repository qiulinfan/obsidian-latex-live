import { readFileSync, statSync } from "fs";
import { extname, isAbsolute, resolve } from "path";
import { stripComments } from "./project";
import { texText } from "./texText";

// Bibliographies for live preview's citation chips (design 4.5): which .bib files a project
// reads (`bibFiles`) and their entries as `Author Year` labels (`parseBib`, `citeLabel`).
// Free of the obsidian module, so Node tests run it.
//   Labels   the first author's last name (else the editor's), "A and B" for two, "A et al."
//            for three or more or `and others`; Chinese names read "张三、李四" and "张三等".
//            The year is the `year` field, else the year of the `date` field (`2019-03`).
//            Names follow BibTeX: `Last, First`, `First von Last` (the last word), braces
//            protect (`{Barnes and Noble}` is one name), accents are text (`M{\"u}ller`).
//   Syntax   `@type{key, field = value}` or with parentheses; values in braces, quotes, bare
//            numbers or @string names, joined with `#`; @comment and @preamble are skipped.
//            The first entry of a key wins (as BibTeX).

export interface BibEntry {
  readonly key: string;
  /** Entry type in lower case: article, book, online. */
  readonly type: string;
  /** Last names of the authors (else the editors), as text. */
  readonly names: readonly string[];
  /** The name list ends with `and others`. */
  readonly others: boolean;
  /** The year, or the year of the date field; "" without either. */
  readonly year: string;
  /** The title as text ("" without one). */
  readonly title: string;
  /** Complete resolved BibTeX fields, preserving TeX markup and full author names. */
  readonly fields?: Readonly<Record<string, string>>;
  /** The original entry, for inspecting fields without losing their authored form. */
  readonly source?: string;
  readonly offset?: number;
}

const MONTHS: Record<string, string> = {
  jan: "January",
  feb: "February",
  mar: "March",
  apr: "April",
  may: "May",
  jun: "June",
  jul: "July",
  aug: "August",
  sep: "September",
  oct: "October",
  nov: "November",
  dec: "December",
};

const ENTRY = /@\s*([A-Za-z]+)\s*([{(])/y;
const FIELD_NAME = /[^\s=,{}()"#]+/y;
const BARE_VALUE = /[^\s,#{}()"]+/y;

/** The entries of a .bib file's text by key. */
export function parseBib(text: string): Map<string, BibEntry> {
  const out = new Map<string, BibEntry>();
  const strings = new Map<string, string>();
  let i = 0;
  for (;;) {
    const at = text.indexOf("@", i);
    if (at < 0) break;
    ENTRY.lastIndex = at;
    const m = ENTRY.exec(text);
    if (!m) {
      i = at + 1;
      continue;
    }
    const type = m[1].toLowerCase();
    const close = m[2] === "{" ? "}" : ")";
    let j = ENTRY.lastIndex;
    if (type === "comment" || type === "preamble") {
      i = skipGroup(text, j, m[2], close);
      continue;
    }
    if (type === "string") {
      const r = fields(text, j, close, strings);
      for (const [k, v] of r.fields) strings.set(k, v);
      i = r.end;
      continue;
    }
    const comma = keyEnd(text, j, close);
    const key = text.slice(j, comma).trim();
    j = text[comma] === "," ? comma + 1 : comma;
    const r = fields(text, j, close, strings);
    i = Math.max(r.end, at + 1);
    // A key has no spaces or `=` (a keyless entry is skipped).
    if (!key || /[\s=]/.test(key) || out.has(key)) continue;
    out.set(key, { ...entry(key, type, r.fields), source: text.slice(at, i), offset: at });
  }
  return out;
}

/** "Li et al. 2019", "张三、李四 2020" (see the file comment). */
export function citeLabel(e: BibEntry): string {
  const [first, second] = e.names;
  let who: string;
  if (!first) who = e.title ? shorten(e.title) : e.key;
  else {
    const cjk = /\p{Script=Han}/u.test(first);
    if (e.names.length >= 3 || e.others) who = cjk ? `${first}等` : `${first} et al.`;
    else if (second) who = cjk ? `${first}、${second}` : `${first} and ${second}`;
    else who = first;
  }
  return e.year ? `${who} ${e.year}` : who;
}

/**
 * The .bib files the project's sources (`texts`) read: `\addbibresource{a.bib}` (and
 * `\addglobalbib`, `\addsectionbib`; remote resources skipped) and `\bibliography{a,b}` (and
 * `\nobibliography`), resolved against the root document's folder, in order, once each.
 */
export function bibFiles(texts: Iterable<string>, rootDir: string): string[] {
  const out: string[] = [];
  const add = (name: string, bibExt: boolean) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const file = bibExt && extname(trimmed) !== ".bib" ? `${trimmed}.bib` : trimmed;
    const abs = isAbsolute(file) ? file : resolve(rootDir, file);
    if (!out.includes(abs)) out.push(abs);
  };
  for (const text of texts) {
    const src = stripComments(text);
    const found: { at: number; name: string; bibExt: boolean }[] = [];
    for (const m of src.matchAll(/\\add(?:bibresource|globalbib|sectionbib)\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g)) {
      if (/location\s*=\s*remote/.test(m[1] ?? "")) continue;
      found.push({ at: m.index ?? 0, name: m[2], bibExt: !extname(m[2].trim()) });
    }
    for (const m of src.matchAll(/\\(?:no)?bibliography\s*\{([^}]+)\}/g)) {
      for (const name of m[1].split(",")) found.push({ at: m.index ?? 0, name, bibExt: true });
    }
    for (const f of found.sort((a, b) => a.at - b.at)) add(f.name, f.bibExt);
  }
  return out;
}

const EMPTY: ReadonlyMap<string, BibEntry> = new Map();
const cache = new Map<string, { mtime: number; buffer: string | null; entries: ReadonlyMap<string, BibEntry> }>();

/**
 * A .bib file's entries: from `buffer` (unsaved editor text) when given, else from disk,
 * parsed again only when its mtime changed. Empty when it cannot be read.
 */
export function readBib(path: string, buffer?: string): ReadonlyMap<string, BibEntry> {
  const hit = cache.get(path);
  if (buffer !== undefined) {
    if (hit?.buffer === buffer) return hit.entries;
    const entries = parseBib(buffer);
    cache.set(path, { mtime: -1, buffer, entries });
    return entries;
  }
  let mtime: number;
  let text: string;
  try {
    mtime = statSync(path).mtimeMs;
    if (hit && hit.buffer === null && hit.mtime === mtime) return hit.entries;
    text = readFileSync(path, "utf8");
  } catch {
    cache.delete(path);
    return EMPTY;
  }
  const entries = parseBib(text);
  cache.set(path, { mtime, buffer: null, entries });
  return entries;
}

// ---- parsing ---------------------------------------------------------------------------

function entry(key: string, type: string, f: ReadonlyMap<string, string>): BibEntry {
  const list = f.get("author") ?? f.get("editor") ?? "";
  const raw = splitTop(list, /\s+and\s+/iy).filter((n) => n.trim());
  const others = raw.length > 0 && raw[raw.length - 1].trim().toLowerCase() === "others";
  const names = (others ? raw.slice(0, -1) : raw).map(lastName).filter(Boolean);
  const year = texText(f.get("year") ?? "") || (/\d{4}/.exec(f.get("date") ?? "")?.[0] ?? "");
  return { key, type, names, others, year, title: texText(f.get("title") ?? ""), fields: Object.fromEntries(f) };
}

/** A name's last name as text: `Last, First` or `First von Last` (see the file comment). */
function lastName(name: string): string {
  const [head, ...rest] = splitTop(name, /\s*,\s*/y);
  let words = splitTop(head.trim(), /\s+/y).filter(Boolean);
  if (rest.length) {
    // `von Last, First`: the lower-case words in front are the von part.
    const upper = words.findIndex((w) => !/^[a-z]/.test(w));
    if (upper > 0) words = words.slice(upper);
    return texText(words.join(" "));
  }
  return texText(words[words.length - 1] ?? "");
}

/** Split `s` at `sep` (a sticky regex) outside braces. */
function splitTop(s: string, sep: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      sep.lastIndex = i;
      const m = sep.exec(s);
      if (m && m[0].length && i > start) {
        out.push(s.slice(start, i));
        start = i + m[0].length;
        i = start - 1;
      }
    }
  }
  out.push(s.slice(start));
  return out;
}

/** The index after the group closing at depth 0 (`open` just read), or the end of the text. */
function skipGroup(s: string, i: number, open: string, close: string): number {
  for (let depth = 1; i < s.length; i++) {
    if (s[i] === open) depth++;
    else if (s[i] === close && --depth === 0) return i + 1;
  }
  return s.length;
}

/** The end of an entry's key: its comma, or the entry's end. */
function keyEnd(s: string, i: number, close: string): number {
  for (; i < s.length; i++) if (s[i] === "," || s[i] === close) return i;
  return s.length;
}

const skipSpace = (s: string, i: number): number => {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
};

/** `name = value` pairs up to the entry's `close`; names in lower case. */
function fields(
  s: string,
  i: number,
  close: string,
  strings: ReadonlyMap<string, string>,
): { fields: Map<string, string>; end: number } {
  const out = new Map<string, string>();
  for (;;) {
    i = skipSpace(s, i);
    while (s[i] === ",") i = skipSpace(s, i + 1);
    if (i >= s.length) return { fields: out, end: i };
    if (s[i] === close) return { fields: out, end: i + 1 };
    FIELD_NAME.lastIndex = i;
    const m = FIELD_NAME.exec(s);
    i = skipSpace(s, m ? FIELD_NAME.lastIndex : i);
    if (!m || s[i] !== "=") {
      // Malformed: go on after the next comma (or stop at the entry's end).
      while (i < s.length && s[i] !== "," && s[i] !== close && s[i] !== "@") i++;
      if (s[i] === "@") return { fields: out, end: i };
      continue;
    }
    const v = value(s, i + 1, close, strings);
    if (!out.has(m[0].toLowerCase())) out.set(m[0].toLowerCase(), v.text);
    i = v.end;
  }
}

/** A field value (raw TeX: braces kept inside): parts in braces or quotes, numbers, @string names, joined with `#`. */
function value(s: string, i: number, close: string, strings: ReadonlyMap<string, string>): { text: string; end: number } {
  let text = "";
  for (;;) {
    i = skipSpace(s, i);
    const c = s[i];
    if (c === "{") {
      const e = skipGroup(s, i + 1, "{", "}");
      text += s.slice(i + 1, e - 1);
      i = e;
    } else if (c === '"') {
      let j = i + 1;
      for (let depth = 0; j < s.length; j++) {
        if (s[j] === "\\") j++;
        else if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
        else if (s[j] === '"' && depth <= 0) break;
      }
      text += s.slice(i + 1, j);
      i = j + 1;
    } else {
      BARE_VALUE.lastIndex = i;
      const m = BARE_VALUE.exec(s);
      if (!m) return { text, end: i };
      const word = m[0].toLowerCase();
      text += /^\d+$/.test(m[0]) ? m[0] : (strings.get(word) ?? (Object.hasOwn(MONTHS, word) ? MONTHS[word] : ""));
      i = BARE_VALUE.lastIndex;
    }
    i = skipSpace(s, i);
    if (s[i] !== "#") return { text, end: i };
    i++;
  }
}

const shorten = (s: string): string => (s.length > 40 ? `${s.slice(0, 39).trimEnd()}…` : s);
