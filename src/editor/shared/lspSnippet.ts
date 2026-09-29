// Shared with obsidian-latex-live / obsidian-tinymist: keep byte-identical (canonical copy: obsidian-tinymist/src/editor/shared).
//
// LSP snippet syntax -> @codemirror/autocomplete snippet() template (6.20.3 semantics):
//   $n / ${n} / ${n:default}  -> ${n} / ${n:default}   (numbered order kept, same n = linked;
//                                                      linked fields need allowMultipleSelections)
//   $0 / ${0}                 -> ${0}                  (6.20.3: final stop, after all others)
//   ${n|a,b|}                 -> ${n:a}
//   $VAR / ${VAR:default}     -> default text (variables are not resolved)
//   \$ \} \\                  -> literal $ } \        (the LSP escapes)
//   literal { }               -> \{ \}   (CM also treats #{...} as a field: Typst code blocks)
// CM numbered field defaults cannot contain braces or line breaks; such a field keeps its
// tab stop but loses its default text. Nested fields are flattened into the outer default.

interface Cursor { s: string; i: number }

function parseAny(c: Cursor, stop: string | null): string {
  let out = "";
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (stop && ch === stop) return out;
    if (ch === "\\" && c.i + 1 < c.s.length && "$}\\".includes(c.s[c.i + 1])) {
      out += escapeText(c.s[c.i + 1]);
      c.i += 2;
    } else if (ch === "$") {
      out += parseDollar(c);
    } else {
      out += escapeText(ch);
      c.i++;
    }
  }
  return out;
}

function escapeText(t: string): string {
  return t.replace(/[{}]/g, (b) => "\\" + b);
}

function parseDollar(c: Cursor): string {
  const s = c.s;
  let m = /^\$(\d+)/.exec(s.slice(c.i));
  if (m) {
    c.i += m[0].length;
    return "${" + m[1] + "}";
  }
  m = /^\$([A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(c.i));
  if (m) {
    c.i += m[0].length;
    return ""; // unresolved variable
  }
  if (s[c.i + 1] !== "{") {
    c.i++;
    return "$";
  }
  const head = /^\$\{(\d+|[A-Za-z_][A-Za-z0-9_]*)/.exec(s.slice(c.i));
  if (!head) {
    c.i++;
    return "$";
  }
  c.i += head[0].length;
  const numbered = /^\d+$/.test(head[1]);
  const next = s[c.i];
  if (next === "}") {
    c.i++;
    return numbered ? "${" + head[1] + "}" : "";
  }
  if (next === "|" && numbered) {
    const end = s.indexOf("|}", c.i + 1);
    const first = (end < 0 ? "" : s.slice(c.i + 1, end)).split(/(?<!\\),/)[0].replace(/\\([,|$}\\])/g, "$1");
    c.i = end < 0 ? s.length : end + 2;
    return plainField(head[1], escapeText(first));
  }
  if (next === ":") {
    c.i++;
    const inner = parseAny(c, "}");
    c.i++; // closing brace
    if (!numbered) return inner;
    return plainField(head[1], stripFields(inner));
  }
  // ${VAR/regex/format/opts} and anything else: drop up to the closing brace
  const end = s.indexOf("}", c.i);
  c.i = end < 0 ? s.length : end + 1;
  return numbered ? "${" + head[1] + "}" : "";
}

// Nested fields are not supported by CM: keep only their text inside a default.
function stripFields(t: string): string {
  return t.replace(/\$\{\d+(?::((?:\\[{}]|[^{}])*))?\}/g, (_m, d: string | undefined) => d ?? "");
}

function plainField(n: string, def: string): string {
  if (!def || /[{}\r\n]/.test(def)) return "${" + n + "}"; // CM numbered defaults cannot hold these
  return "${" + n + ":" + def + "}";
}

/** Convert LSP snippet text (insertTextFormat 2) to a CM snippet() template. */
export function lspSnippetToCm(text: string): string {
  const tpl = parseAny({ s: text, i: 0 }, null);
  // Linked occurrences (`\\begin{${1:env}} ... \\end{${1}}`): CM only fills the
  // occurrence that carries the default, so copy it to the bare ones.
  const defaults = new Map<string, string>();
  for (const m of tpl.matchAll(/\$\{(\d+):([^{}]*)\}/g)) if (!defaults.has(m[1])) defaults.set(m[1], m[2]);
  return tpl.replace(/\$\{(\d+)\}/g, (all, n: string) => (defaults.has(n) ? "${" + n + ":" + defaults.get(n) + "}" : all));
}

// The field pattern of CM's Snippet.parse, applied per line.
const CM_FIELD = /[#$]\{(?:\d+(?::[^{}]*)?|(?:\\[{}]|[^{}])*)\}/;

/**
 * The literal text an LSP snippet inserts when it has no tab stop, or null when it has
 * one. Insert plain text directly (cursor after it): snippet() leaves the cursor before
 * the insertion when a template has no fields.
 */
export function lspSnippetPlain(text: string): string | null {
  const tpl = lspSnippetToCm(text);
  if (tpl.split(/\r\n?|\n/).some((line) => CM_FIELD.test(line))) return null;
  return tpl.replace(/\\([{}])/g, "$1");
}
