// Shared with obsidian-latex-live / obsidian-tinymist: keep byte-identical (canonical copy: obsidian-tinymist/src/editor/shared).
//
// LSP snippet syntax -> @codemirror/autocomplete snippet() template (6.20.3 semantics):
//   $n / ${n} / ${n:default}  -> ${n} / ${n:default}   (numbered order kept, same n = linked;
//                                                      linked fields need allowMultipleSelections)
//   $0 / ${0}                 -> ${0}                  (6.20.3: final stop, after all others)
//   ${n|a,b|}                 -> ${n:a}
//   $VAR / ${VAR:default}     -> default text (variables are not resolved)
//   \$ \} \\                  -> literal $ } \        (the LSP escapes)
//   literal { }               -> raw, except `{` after `#` `$` `\` and `}` after `\`, which
//                                become \{ \} (CM reads `#{...}` / `${...}` as fields and
//                                `\{` / `\}` as escapes)
// Escapes are kept to that minimum because 6.20.3's Snippet.parse compares each escape's
// position against field positions that earlier escapes on the line already shifted:
// `\frac\{${1}\}\{${2}\}` puts field 2 after the closing brace. Three or more escapes right
// before a field on one line can still misplace it.
// CM numbered field defaults cannot contain braces or line breaks; such a field keeps its
// tab stop but loses its default text. Nested fields are flattened into the outer default.

/** Literal text, or a numbered tab stop with its default text. */
type Part = string | { n: string; def: string };

interface Cursor { s: string; i: number }

function parseAny(c: Cursor, stop: string | null): Part[] {
  const out: Part[] = [];
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (stop && ch === stop) return out;
    if (ch === "\\" && c.i + 1 < c.s.length && "$}\\".includes(c.s[c.i + 1])) {
      out.push(c.s[c.i + 1]);
      c.i += 2;
    } else if (ch === "$") {
      out.push(...parseDollar(c));
    } else {
      out.push(ch);
      c.i++;
    }
  }
  return out;
}

function parseDollar(c: Cursor): Part[] {
  const s = c.s;
  let m = /^\$(\d+)/.exec(s.slice(c.i));
  if (m) {
    c.i += m[0].length;
    return [{ n: m[1], def: "" }];
  }
  m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(c.i));
  if (m) {
    c.i += m[0].length;
    return []; // unresolved variable
  }
  const head = /^\$\{(\d+|[A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(c.i));
  if (!head) {
    c.i++;
    return ["$"];
  }
  c.i += head[0].length;
  const numbered = /^\d+$/.test(head[1]);
  const next = s[c.i];
  if (next === "}") {
    c.i++;
    return numbered ? [{ n: head[1], def: "" }] : [];
  }
  if (next === "|" && numbered) {
    const end = s.indexOf("|}", c.i + 1);
    const first = (end < 0 ? "" : s.slice(c.i + 1, end)).split(/(?<!\\),/)[0].replace(/\\([,|$}\\])/g, "$1");
    c.i = end < 0 ? s.length : end + 2;
    return [field(head[1], first)];
  }
  if (next === ":") {
    c.i++;
    const inner = parseAny(c, "}");
    c.i++; // closing brace
    // Nested fields are not supported by CM: keep only their text inside a default.
    return numbered ? [field(head[1], textOf(inner))] : inner;
  }
  // ${VAR/regex/format/opts} and anything else: drop up to the closing brace
  const end = s.indexOf("}", c.i);
  c.i = end < 0 ? s.length : end + 1;
  return numbered ? [{ n: head[1], def: "" }] : [];
}

const textOf = (parts: Part[]): string => parts.map((p) => (typeof p === "string" ? p : p.def)).join("");

// CM numbered defaults cannot hold braces or line breaks.
const field = (n: string, def: string): Part => ({ n, def: /[{}\r\n]/.test(def) ? "" : def });

/** The CM template for parsed parts, escaping only the braces CM would misread. */
function template(parts: Part[]): string {
  let out = "";
  let last = ""; // the last character CM sees once every field is replaced by its default
  for (const p of parts) {
    if (typeof p !== "string") {
      out += p.def ? "${" + p.n + ":" + p.def + "}" : "${" + p.n + "}";
      if (p.def) last = p.def[p.def.length - 1];
      continue;
    }
    for (const ch of p) {
      const escape = ch === "{" ? last === "#" || last === "$" || last === "\\" : ch === "}" && last === "\\";
      out += escape ? "\\" + ch : ch;
      last = ch;
    }
  }
  return out;
}

/** Convert LSP snippet text (insertTextFormat 2) to a CM snippet() template. */
export function lspSnippetToCm(text: string): string {
  const parts = parseAny({ s: text, i: 0 }, null);
  // Linked occurrences (`\\begin{${1:env}} ... \\end{${1}}`): CM only fills the
  // occurrence that carries the default, so copy it to the bare ones.
  const defaults = new Map<string, string>();
  for (const p of parts) if (typeof p !== "string" && p.def && !defaults.has(p.n)) defaults.set(p.n, p.def);
  return template(parts.map((p) => (typeof p !== "string" && !p.def && defaults.has(p.n) ? { n: p.n, def: defaults.get(p.n)! } : p)));
}

/**
 * The literal text an LSP snippet inserts when it has no tab stop, or null when it has
 * one. Insert plain text directly (cursor after it): snippet() leaves the cursor before
 * the insertion when a template has no fields.
 */
export function lspSnippetPlain(text: string): string | null {
  const parts = parseAny({ s: text, i: 0 }, null);
  return parts.every((p) => typeof p === "string") ? parts.join("") : null;
}
