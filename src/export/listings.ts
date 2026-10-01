import { attr, esc } from "./html";

/** The settings TeX's listings package actually selected for one listing. */
export interface ListingSettings {
  language: string;
  dialect: string;
  keywordstyle: string;
  commentstyle: string;
  stringstyle: string;
}

/** The part of Prism's token stream the exporter needs; no HTML or Prism hooks. */
export type CodeToken = string | { type: string; content: CodeToken | CodeToken[]; alias?: string | string[] };
export type CodeTokenizer = (text: string, language: string, dialect: string) => CodeToken[] | null;

export interface PrismLike {
  languages: Record<string, unknown>;
  tokenize(text: string, grammar: object): CodeToken[];
}

const LANGUAGE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  tex: ["latex", "tex"], latex: ["latex", "tex"],
  "c++": ["cpp", "c++"], cpp: ["cpp", "c++"],
  "c#": ["csharp", "cs", "c#"], csharp: ["csharp", "cs"],
  python: ["python", "py"], py: ["python", "py"],
  javascript: ["javascript", "js"], js: ["javascript", "js"],
  typescript: ["typescript", "ts"], ts: ["typescript", "ts"],
  html: ["markup", "html"], xml: ["markup", "xml"],
  shell: ["bash", "shell"], sh: ["bash", "sh"],
  "objective-c": ["objectivec", "objective-c"], objectivec: ["objectivec", "objective-c"],
  visualbasic: ["visual-basic", "vbnet"],
};

/** Adapt Obsidian's loadPrism() result. Only an already loaded, real grammar is used. */
export function prismTokenizer(prism: PrismLike): CodeTokenizer {
  return (text, language, _dialect) => {
    // listings can write either separate language/dialect fields or its `[LaTeX]TeX` spelling.
    const name = language.trim().replace(/^\[[^\]]*\]\s*/, "").toLowerCase();
    if (!name) return null;
    for (const key of Object.hasOwn(LANGUAGE_ALIASES, name) ? LANGUAGE_ALIASES[name] : [name]) {
      if (!Object.hasOwn(prism.languages, key)) continue;
      const grammar = prism.languages[key];
      if (grammar && typeof grammar === "object") return prism.tokenize(text, grammar);
    }
    return null;
  };
}

type Role = "keyword" | "comment" | "string";
interface TokenStyle { classes: string[]; color: string | null }

function roleOf(token: Exclude<CodeToken, string>): Role | null {
  const names = [token.type, ...(Array.isArray(token.alias) ? token.alias : token.alias ? [token.alias] : [])];
  if (names.includes("comment")) return "comment";
  if (names.includes("string")) return "string";
  return names.some((n) => ["keyword", "builtin", "boolean"].includes(n)) ? "keyword" : null;
}

/** A token tree must preserve every source character before it may decorate that source. */
function sourceOf(value: CodeToken | CodeToken[], depth = 0): string {
  if (depth > 64) throw new Error("token nesting is too deep");
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((t) => sourceOf(t, depth + 1)).join("");
  if (!value || typeof value !== "object" || typeof value.type !== "string") throw new Error("invalid token stream");
  return sourceOf(value.content, depth + 1);
}

/** The bounded, non-executing subset of TeX token styles used by the installed elegant classes. */
function styleOf(style: string, role: Role, resolveColor: (name: string) => string | null, issues: string[]): TokenStyle | null {
  let rest = style.trim();
  let bold = false, mono = false;
  let shape = "";
  let color: string | null = null;
  while (rest) {
    const space = /^\s+/.exec(rest);
    if (space) { rest = rest.slice(space[0].length); continue; }
    const cmd = /^\\(protect|bfseries|itshape|slshape|ttfamily|color)(?![A-Za-z@])\s*/.exec(rest);
    if (!cmd) {
      issues.push(`${role}style: unsupported TeX style ${style} (shown without that style)`);
      return null;
    }
    rest = rest.slice(cmd[0].length);
    if (cmd[1] === "bfseries") bold = true;
    else if (cmd[1] === "itshape" || cmd[1] === "slshape") shape = cmd[1] === "itshape" ? "it" : "sl";
    else if (cmd[1] === "ttfamily") mono = true;
    else if (cmd[1] === "color") {
      const arg = /^\{([^{}]*)\}/.exec(rest);
      if (!arg) {
        issues.push(`${role}style: unsupported TeX color in ${style} (shown without that style)`);
        return null;
      }
      color = arg[1].trim();
      rest = rest.slice(arg[0].length);
    }
  }
  const classes = [...(bold ? ["llx-code-bf"] : []), ...(shape ? [`llx-code-${shape}`] : []), ...(mono ? ["llx-code-tt"] : [])];
  if (color !== null) {
    const css = resolveColor(color);
    if (!css) {
      issues.push(`${role}style: color ${color || "(empty)"} is unavailable (shown without that style)`);
      return null;
    }
    color = css;
  }
  return { classes, color };
}

/** Escaped code contents (no pre/code wrapper); failures always retain the complete plain text. */
export function highlightListing(
  text: string,
  settings: ListingSettings,
  tokenizer: CodeTokenizer | null | undefined,
  resolveColor: (name: string) => string | null,
): { html: string; issues: string[] } {
  const issues: string[] = [];
  if (!settings.language.trim()) return { html: esc(text), issues };
  const language = `${settings.dialect ? `[${settings.dialect}]` : ""}${settings.language}`;
  if (!tokenizer) return { html: esc(text), issues: [`listings language ${language}: no syntax tokenizer (shown without syntax coloring)`] };
  try {
    const tokens = tokenizer(text, settings.language, settings.dialect);
    if (!tokens) return { html: esc(text), issues: [`listings language ${language}: no loaded grammar (shown without syntax coloring)`] };
    if (sourceOf(tokens) !== text) return { html: esc(text), issues: [`listings language ${language}: tokenizer changed the source text (shown without syntax coloring)`] };
    const styles = new Map<Role, TokenStyle | null>();
    const render = (value: CodeToken | CodeToken[]): string => {
      if (typeof value === "string") return esc(value);
      if (Array.isArray(value)) return value.map(render).join("");
      const inner = render(value.content);
      const role = roleOf(value);
      if (!role) return inner;
      if (!styles.has(role)) styles.set(role, styleOf(settings[`${role}style`], role, resolveColor, issues));
      const style = styles.get(role);
      if (!style) return inner;
      const css = style.color ? ` style="color:${attr(style.color)}"` : "";
      return `<span class="${["llx-code-token", `llx-code-${role}`, ...style.classes].join(" ")}"${css}>${inner}</span>`;
    };
    return { html: render(tokens), issues };
  } catch (e) {
    issues.push(`listings language ${language}: syntax coloring failed (${e instanceof Error ? e.message : String(e)}), shown as plain text`);
    return { html: esc(text), issues };
  }
}
