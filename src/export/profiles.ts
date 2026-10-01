import { elegantLang, stripComments } from "../tex/project";
import { texText } from "../tex/texText";
import { ELEGANT_NAMES, ELEGANT_SCHEMES, type TheoremDef, type TheoremMap } from "../tex/theorems";
import { attr, esc, type TitleBlock } from "./html";

// Class profiles of the HTML export (design 3.6, S4/S8): how a document class looks on the page.
// Numbers, names and colours come from TeX (the probe); a profile only decides the look, from
// what the installed classes print (elegantbook.cls v4.6, LaTeX's and amsthm's defaults):
//   elegantbook  headings, the contents' title, caption labels and list labels in structurecolor,
//                chapters centred (`第一章`, `附录 A` after \appendix, `Chapter 1` in English);
//                links winered, the contents' black. The fancy mode's tcolorbox theorems are boxes:
//                a 0.5pt frame in the role's colour (defstyle main, thmstyle second, prostyle
//                third), `role!5` inside, the title bold white on a tab of the role's colour
//                straddling the frame's top left, ♣/♡/♠ in the bottom right corner, the body in
//                \citshape (ctex's KaiTi under lang=cn, italic otherwise). The heads (example,
//                exercise, note, proof, ...) are run-in, bold in their role's colour; note and
//                exercise have their margin icons (☡, ✍), their bodies \citshape where the class
//                sets it, proof's \cfs (FangSong). The cover becomes a compact header: the cover's
//                coverlinecolor band, the title, the subtitle, the 作者：/组织：/时间：/版本： rows
//                (the probe's `\authorname` ...), \extrainfo. Listings in a structurecolor frame (its
//                \lstset's frame=single; no keyword colours), list labels coloured as enumitem's
//                labels are (the probe keeps their `\color`), itemize's balls in structurecolor.
//   standard     article, report, book, the AMS and ctex classes: headings in the text colour, a
//                book's `Chapter 1` on its own line above the title; theorems as amsthm's styles
//                (from the census: plain bold head and italic body, definition upright body, remark
//                italic head; the note `(title)` in the body's weight, the period bold) or LaTeX's
//                own \newtheorem (bold head and note, italic body, no period); proof `Proof.` in
//                italic with □ at the end; a centred title block.
//   elegantnote  coloured headings, caption labels, list labels and run-in theorem heads in
//                ecolor; theorem styles have no period, plain/definition use \citshape and
//                remark uses \cnormal (KaiTi in Chinese). The centred bold article title has
//                unlabelled author/institute and labelled version/update lines, no cover band.
//   elegantpaper centred bold article title, version/date lines, winered links and bold caption
//                labels; amsthm's styles except bold proof heads and the explicitly bold Chinese
//                remark/note/case names. ctex's Chinese heading scheme centres chapters/sections
//                and puts 第一章 on the title's line; scheme=plain keeps the base class's look.
// Both: captions `Figure 1:` (the label bold in the class colour for elegantbook), the text in the
// reader's system fonts (a Latin serif first, then the CJK serif stack Songti SC, Noto Serif CJK
// SC, Source Han Serif SC; CJK text never slanted, as xeCJK), light and dark through
// prefers-color-scheme. Colours: light mode shows TeX's values (elegantnote's pale text schemes
// are darkened just enough for 4.5 contrast on their page surface); in dark mode each colour text is
// drawn in is mixed with white until its contrast reaches 4.5 against the lightest surface it can
// sit on (a box's tint), a fill under white text is mixed with black until the white reaches 4.5,
// and a box's tint is 12 % of its colour over the dark background.
// Names without the probe (aux-only mode) come from ctex's table for Chinese documents, else
// LaTeX's. The census (the probe's `\meaning` of each environment) classifies environments the
// theorem map does not know: amsthm's or LaTeX's `\@thm` makes a theorem, anything else stays a
// TeX fragment.

export type ProfileName = "elegantbook" | "elegantnote" | "elegantpaper" | "ctex" | "standard";

export interface Profile {
  name: ProfileName;
  /** The page's language: `zh-CN` for ctex's classes and package and Chinese elegant classes, else `en`. */
  lang: string;
  /** An elegant class's language table (`cn`, `en`), or null. */
  elegant: "cn" | "en" | null;
  /** The body font of an elegant class's \citshape: KaiTi (ctex's \kaishu) or italic. */
  cit: "kai" | "it";
  /** ctex's Chinese heading/name scheme (scheme=plain keeps the underlying class's). */
  ctexChinese: boolean;
  /** elegantnote's selected colour and optional light page tint. */
  noteColor: string;
  noteMode: string;
}

/** The profile of a document (its root's source; `sources` comment-free, the root first). */
export function profileOf(rootSrc: string, sources: readonly string[]): Profile {
  const src = stripComments(rootSrc);
  const dc = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{\s*([^}\s]+)\s*\}/.exec(src);
  const cls = dc?.[2] ?? "";
  const lang = elegantLang(src);
  const ctexClass = /^ctex(?:art|rep|book|beamer)$/.test(cls);
  const ctexPackage = [src, ...sources].map(stripComments).flatMap((s) => [...s.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{[^}]*\bctex\b[^}]*\}/g)]).at(-1);
  const ctex = ctexClass || !!ctexPackage;
  const chinese = lang === "cn" || ctex;
  const elegant = /^elegant(?:book|note|paper)$/.test(cls) ? (lang === "cn" ? "cn" : "en") : null;
  const options = (dc?.[1] ?? "").split(",").map((o) => o.trim());
  const option = (key: string, bare: readonly string[], fallback: string) => options.reduce((value, o) => {
    const pair = o.split("=").map((s) => s.trim());
    return pair.length === 2 && pair[0] === key ? pair[1] : bare.includes(o) ? o : value;
  }, fallback);
  const ctexChinese = ctexClass ? option("scheme", [], "chinese") !== "plain" : !!ctexPackage && !/\bscheme\s*=\s*plain\b/.test(ctexPackage[1] ?? "");
  return {
    name: elegant ? cls as ProfileName : ctex ? "ctex" : "standard",
    lang: chinese ? "zh-CN" : "en", elegant, cit: elegant === "cn" ? "kai" : "it", ctexChinese,
    noteColor: option("color", ["green", "cyan", "blue", "sakura", "black", "brown"], "blue"),
    noteMode: option("mode", ["geye", "hazy", "sepia"], ""),
  };
}

/** LaTeX's names (`\figurename` ...) by the probe's keys. */
const LATEX_NAMES: Readonly<Record<string, string>> = {
  contents: "Contents",
  listfigure: "List of Figures",
  listtable: "List of Tables",
  figure: "Figure",
  table: "Table",
  bib: "Bibliography",
  ref: "References",
  index: "Index",
  part: "Part",
  chapter: "Chapter",
  appendix: "Appendix",
  abstract: "Abstract",
  proof: "Proof",
  lstlisting: "Listing",
  algorithm: "Algorithm",
};
/** ctex-name-utf8.cfg; listings retains its package's English name. */
const CTEX_NAMES: Readonly<Record<string, string>> = {
  ...LATEX_NAMES,
  contents: "目录",
  listfigure: "插图",
  listtable: "表格",
  figure: "图",
  table: "表",
  bib: "参考文献",
  ref: "参考文献",
  index: "索引",
  appendix: "附录",
  abstract: "摘要",
  proof: "证明",
  algorithm: "算法",
};
/** elegantbook's cover labels (`\authorname` ...) and extra names by language. */
const ELEGANT_LABELS: Readonly<Record<"cn" | "en", Readonly<Record<string, string>>>> = {
  cn: { author: "作者：", institute: "组织：", date: "时间：", version: "版本：", contents: "目录", figure: "图", table: "表", bib: "参考文献", appendix: "附录" },
  en: { author: "Author: ", institute: "Institute: ", date: "Date: ", version: "Version: " },
};

/** A name the class prints (`figure` -> 图) when the probe gave none. */
export function fallbackName(p: Profile, key: string): string {
  if (p.name === "elegantnote" || p.name === "elegantpaper") {
    const own = ELEGANT_ARTICLE_NAMES[p.elegant!][key];
    if (own) return own;
    if (key === "date") return p.elegant === "cn" ? p.name === "elegantnote" ? "更新：" : "日期：" : p.name === "elegantnote" ? "Update: " : "Date: ";
  } else if (p.elegant) {
    const own = ELEGANT_LABELS[p.elegant][key] ?? ELEGANT_NAMES[p.elegant][key];
    if (own) return own;
  }
  return (p.ctexChinese ? CTEX_NAMES : LATEX_NAMES)[key] ?? "";
}

/** elegantnote 2.60 / elegantpaper 0.12: their amsthm titles differ from elegantbook's. */
const ELEGANT_ARTICLE_NAMES: Readonly<Record<"cn" | "en", Readonly<Record<string, string>>>> = {
  cn: { theorem: "定理", lemma: "引理", proposition: "命题", corollary: "推论", definition: "定义", conjecture: "猜想", example: "例", remark: "评论", note: "注", case: "案例", proof: "证明", contents: "目录", ref: "参考文献", bib: "参考文献", figure: "图", table: "表", abstract: "摘要", version: "版本：" },
  en: { theorem: "Theorem", lemma: "Lemma", proposition: "Proposition", corollary: "Corollary", definition: "Definition", conjecture: "Conjecture", example: "Example", remark: "Remark", note: "Note", case: "Case", proof: "Proof", bib: "Bibliography", version: "Version: " },
};

/**
 * A chapter's number as its heading prints it: elegantbook `第一章` (the contents' number under
 * lang=cn), `Chapter 1`, `附录 A`; a book's `Chapter 1`, `Appendix A` (a number that is no plain
 * number or letter, ctex's `第一章`, as it is).
 */
export function chapterLabel(p: Profile, number: string, appendix: boolean, name: (key: string) => string): string {
  const plain = /^[0-9A-Za-z]+$/.test(number);
  if (appendix && plain) return `${name("appendix")} ${number}`;
  if (p.elegant === "cn" || !plain) return number;
  return `${name("chapter")} ${number}`;
}

/** An itemize label: its character, and the class colour it is drawn in (elegantbook's structurecolor balls). */
export function bullet(p: Profile, depth: number): { text: string; color: string | null } {
  if (p.name === "elegantbook" || p.name === "elegantnote") return { text: "●", color: p.name === "elegantnote" ? "ecolor" : "structurecolor" };
  return { text: ["•", "–", "∗", "·"][(depth - 1) % 4], color: null };
}

// ---- theorems --------------------------------------------------------------------------------

/** How a theorem-like environment looks (see the file comment). */
export interface TheoremLook {
  /** A class's theorem style can override amsthm's default head punctuation. */
  punct?: string;
  /** elegantnote disables amsthm's \openbox; paper and the standard classes keep it. */
  qed?: string | null;
  /** elegantbook's tcolorbox: a title tab over a frame; else a run-in head. */
  box: boolean;
  /** The class colour of its frame or head (`main`, `second`, `third`), or null. */
  role: string | null;
  /** The head's style: bold (and upright), or italic (amsthm's remark style, proof). */
  head: "bold" | "italic";
  /** The note `(title)`: in the head's font (LaTeX, elegantbook), or the body's weight (amsthm). */
  note: "head" | "plain";
  /** The body's font: KaiTi, italic, FangSong, or the text's. */
  body: "kai" | "it" | "fs" | "";
  /** elegantbook's margin icon (note ☡, exercise ✍) and a box's corner mark (♣ ♡ ♠). */
  icon: string | null;
  mark: string | null;
}

/** elegantbook's run-in heads (`\newenvironment`s of the class), and those whose body is \citshape. */
const ELEGANT_HEADS = new Set(["example", "exercise", "problem", "solution", "note", "proof", "remark", "assumption", "conclusion", "property", "custom"]);
const CIT_HEADS = new Set(["note", "solution", "assumption", "conclusion", "property", "custom"]);
const MARKS: Record<string, string> = { main: "♣", second: "♡", third: "♠" };
/** The margin icons (U+FE0E: the text form, never an emoji). */
const ICONS: Record<string, string> = { note: "☡", exercise: "✍\uFE0E" };

/** amsthm's style in a census meaning (`\th@plain` -> plain), `kernel` for LaTeX's own \newtheorem, null without one. */
export function theoremStyle(meaning: string | undefined): string | null {
  if (!meaning || !/\\@thm\b/.test(meaning)) return null;
  return /\\th@([A-Za-z@]+)/.exec(meaning)?.[1] ?? "kernel";
}

/** The look of `env` (its theorem map entry; `meaning`: the census's, which tells amsthm's style). */
export function theoremLook(p: Profile, env: string, def: TheoremDef, meaning: string | undefined): TheoremLook {
  const base = env.replace(/\*$/, "");
  const springer = springerParts(meaning);
  if (springer) return { box: false, role: null, head: springer.head, note: "head", body: springer.body, icon: null, mark: null };
  const style = theoremStyle(meaning) ?? (def.punct ? "plain" : "kernel");
  if (p.name === "elegantnote" && (def.title === "replace" || ["plain", "definition", "remark"].includes(style))) {
    return {
      box: false, role: "ecolor", head: "bold", note: "plain",
      body: def.title === "replace" ? "" : style === "remark" ? p.cit === "kai" ? "kai" : "" : p.cit,
      icon: null, mark: null, ...(def.title === "replace" ? { qed: null } : { punct: "" }),
    };
  }
  if (p.name === "elegantpaper" && (def.title === "replace" || (p.elegant === "cn" && ["remark", "note", "case"].includes(base)))) {
    return { box: false, role: null, head: "bold", note: "plain", body: "", icon: null, mark: null };
  }
  if (p.name === "elegantbook" && def.role) {
    // A tcolorbox (fancy mode), a head of the class, or an amsthm theorem of the simple mode
    // (defstyle/thmstyle/prostyle: the head bold in its colour, the body \citshape).
    const box = def.spec === "tcb" || def.spec === "tcb*";
    const head = !box && ELEGANT_HEADS.has(base);
    const body = !head || CIT_HEADS.has(base) ? p.cit : base === "proof" && p.elegant === "cn" ? "fs" : "";
    return { box, role: def.role, head: "bold", note: "head", body, icon: head ? (ICONS[base] ?? null) : null, mark: box ? MARKS[def.role] : null };
  }
  if (def.title === "replace") return { box: false, role: null, head: "italic", note: "head", body: "", icon: null, mark: null };
  if (style === "kernel") return { box: false, role: null, head: "bold", note: "head", body: "it", icon: null, mark: null };
  return {
    box: false,
    role: null,
    head: style === "remark" ? "italic" : "bold",
    note: "plain",
    body: style === "definition" || style === "remark" ? "" : "it",
    icon: null,
    mark: null,
  };
}

/** The groups of a `\@thm` meaning after its optional argument: [style, counter, title] (amsthm) or [counter, title]. */
function thmGroups(meaning: string, control = "@thm"): string[] {
  const at = new RegExp(String.raw`\\${control}\s*(?:\[[^\]]*\]\s*)?`).exec(meaning);
  if (!at) return [];
  const out: string[] = [];
  let i = at.index + at[0].length;
  while (meaning[i] === "{") {
    let depth = 0;
    let j = i;
    for (; j < meaning.length; j++) {
      if (meaning[j] === "{") depth++;
      else if (meaning[j] === "}" && --depth === 0) break;
    }
    if (j >= meaning.length) break;
    out.push(meaning.slice(i + 1, j));
    i = j + 1;
    while (meaning[i] === " ") i++;
  }
  return out;
}

/** Only the native Springer font contracts that the installed LNCS class actually uses. */
function springerParts(meaning: string | undefined): { numbered: boolean; groups: string[]; head: "bold" | "italic"; body: "it" | "" } | null {
  if (!meaning) return null;
  const control = /^(?:\\protected )?(?:\\long )?macro:->\\(@spthm|@Thm)\b/.exec(meaning)?.[1];
  if (!control) return null;
  const groups = thmGroups(meaning, control);
  const numbered = control === "@spthm";
  if (groups.length !== (numbered ? 4 : 3)) return null;
  const fonts = groups.slice(-2).map((s) => s.replace(/\s+/g, ""));
  const head = fonts[0] === "\\bfseries" ? "bold" : fonts[0] === "\\itshape" ? "italic" : null;
  const body = fonts[1] === "\\itshape" ? "it" : fonts[1] === "\\rmfamily" ? "" : null;
  return head !== null && body !== null ? { numbered, groups, head, body } : null;
}

/**
 * The census's theorems (design 3.2): environments the theorem map does not know whose begin
 * macro is amsthm's or LaTeX's `\@thm` (a \newtheorem of a class or package the plan cannot read),
 * with the title (`\<name>` titles through the probe's names), counter and numbering of the meaning.
 */
export function censusTheorems(envs: ReadonlyMap<string, string>, known: TheoremMap, names: ReadonlyMap<string, string>): Map<string, TheoremDef> {
  const out = new Map<string, TheoremDef>();
  for (const [env, meaning] of envs) {
    if (known.has(env)) continue;
    const springer = springerParts(meaning);
    if (springer) {
      const title = springer.groups[springer.numbered ? 1 : 0];
      const key = /^\\csname\s*([A-Za-z]+)name\s*\\endcsname$/.exec(title.trim())?.[1];
      if (/[\\$]/.test(title) && !key) continue; // unsupported class title stays a TeX fragment
      if (key && !names.has(key)) continue; // never fabricate a head whose actual name was not captured
      out.set(env, {
        name: key ? names.get(key) ?? env : texText(title), numbered: springer.numbered,
        spec: "o", title: "paren", punct: ".", prefix: null, role: null, color: null, qed: null,
        nameMacro: !!key, counter: springer.numbered ? springer.groups[0].trim() || null : null, user: false,
      });
      continue;
    }
    if (!/^(?:\\protected )?(?:\\long )?macro:->\\@thm\b/.test(meaning)) continue;
    const g = thmGroups(meaning);
    if (g.length < 2) continue;
    const [counter, title] = g.slice(-2);
    const macro = /^\\([A-Za-z]+)name\s*$/.exec(title.trim());
    const name = macro ? (names.get(env) ?? names.get(macro[1]) ?? env) : texText(title);
    const amsthm = g.length >= 3;
    out.set(env, {
      name,
      numbered: counter.trim() !== "",
      spec: "o",
      title: "paren",
      punct: amsthm ? "." : "",
      prefix: null,
      role: null,
      color: null,
      qed: null,
      nameMacro: false,
      counter: counter.trim() || null,
      user: false,
    });
  }
  return out;
}

// ---- colours ---------------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
/** The page's dark background. */
export const DARK_BG: Rgb = [27, 27, 29];
/** The lightest surface text sits on in dark mode (a box's tint): dark text colours reach 4.5 against it. */
const DARK_SURFACE: Rgb = [48, 48, 52];
/** xcolor's base colours (`\definecolor`'d by xcolor itself; the probe reports them when used). */
export const BASE_COLORS: Readonly<Record<string, Rgb>> = {
  red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], cyan: [0, 255, 255], magenta: [255, 0, 255], yellow: [255, 255, 0],
  black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], darkgray: [64, 64, 64], lightgray: [191, 191, 191],
  brown: [191, 128, 64], lime: [191, 255, 0], olive: [128, 128, 0], orange: [255, 128, 0], pink: [255, 191, 191],
  purple: [191, 0, 64], teal: [0, 128, 128], violet: [128, 0, 128],
};

/** `rgb(r, g, b)` or `#rrggbb` (what the probe and theorems.ts write). */
export function parseColor(css: string): Rgb | null {
  const m = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(css.trim());
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = /^#([0-9a-f]{6})$/i.exec(css.trim());
  return h ? [0, 2, 4].map((i) => parseInt(h[1].slice(i, i + 2), 16)) as unknown as Rgb : null;
}

export const cssRgb = (c: Rgb): string => `rgb(${c.map((x) => Math.round(x)).join(", ")})`;

/** `t` of `a` and the rest of `b` (xcolor's `a!t*100!b`, CSS color-mix in sRGB). */
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] * t + b[i] * (1 - t)) as unknown as Rgb;

function luminance(c: Rgb): number {
  const [r, g, b] = c.map((x) => {
    const s = x / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG's contrast ratio. */
export function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

/** `c` mixed with `toward` in steps of 2 % until `ok`; the first that is. */
function shift(c: Rgb, toward: Rgb, ok: (x: Rgb) => boolean): Rgb {
  for (let i = 0; i <= 50; i++) {
    const x = mix(toward, c, i / 50).map(Math.round) as unknown as Rgb;
    if (ok(x)) return x;
  }
  return toward;
}

/** A colour text is drawn in, for the dark background (contrast >= 4.5 on any surface there). */
export const darkText = (c: Rgb): Rgb => shift(c, WHITE, (x) => contrast(x, DARK_SURFACE) >= 4.5);
/** A fill under white text, for the dark background (the white's contrast >= 4.5). */
export const darkFill = (c: Rgb): Rgb => shift(c, BLACK, (x) => contrast(WHITE, x) >= 4.5);

/**
 * An xcolor expression (`red`, `red!30`, `blue!70!black`, `-red`, chains `a!p!b!q!c`) as RGB, its
 * names looked up with `known`; null for what it cannot read (other models, `rgb:..`, wheel).
 */
export function xcolor(expr: string, known: (name: string) => Rgb | null): Rgb | null {
  let e = expr.replace(/\s+/g, "");
  let complement = false;
  while (e.startsWith("-")) {
    complement = !complement;
    e = e.slice(1);
  }
  const parts = e.split("!");
  let c = known(parts[0]);
  for (let i = 1; c && i < parts.length; i += 2) {
    const p = Number(parts[i]);
    const other = i + 1 < parts.length ? known(parts[i + 1]) : WHITE;
    if (!Number.isFinite(p) || p < 0 || p > 100 || !other) return null;
    c = mix(c, other, p / 100);
  }
  if (!c) return null;
  return complement ? (c.map((x) => 255 - x) as unknown as Rgb) : (c.map(Math.round) as unknown as Rgb);
}

/** The base names of an xcolor expression (the colours the probe must report). */
export function colorNames(expr: string): string[] {
  return expr
    .replace(/\s+/g, "")
    .replace(/^-+/, "")
    .split("!")
    .filter((part, i) => i % 2 === 0 && /^[A-Za-z][\w.-]*$/.test(part));
}

/** A colour's CSS variable suffix (`blue!70!black` -> `blue-70-black`). */
export const colorId = (name: string): string => name.replace(/[^A-Za-z0-9_-]/g, "-");

/**
 * The class colours a profile always defines (elegantbook: structurecolor, main, second, third,
 * winered, coverlinecolor), the probe's values first, else the class's own (theorems.ts's scheme).
 */
export function profileColors(p: Profile, probe: ReadonlyMap<string, string>, theorems: TheoremMap): Map<string, Rgb> {
  const out = new Map<string, Rgb>();
  if (!p.elegant) return out;
  if (p.name === "elegantpaper") {
    out.set("winered", parseColor(probe.get("winered") ?? "") ?? [128, 0, 0]);
    return out;
  }
  if (p.name === "elegantnote") {
    out.set("ecolor", parseColor(probe.get("ecolor") ?? "") ?? NOTE_COLORS[p.noteColor] ?? NOTE_COLORS.blue);
    if (NOTE_BACKGROUNDS[p.noteMode]) out.set("geyecolor", parseColor(probe.get("geyecolor") ?? "") ?? NOTE_BACKGROUNDS[p.noteMode]);
    return out;
  }
  // The scheme's colours as theorems.ts read them from \documentclass (blue by default).
  const scheme = new Map<string, Rgb>();
  for (const def of theorems.values()) if (def.role && def.color) scheme.set(def.role, parseColor(def.color)!);
  const [main, second, third] = ELEGANT_SCHEMES.blue;
  const prior: Record<string, Rgb> = {
    structurecolor: [60, 113, 183],
    main: scheme.get("main") ?? main,
    second: scheme.get("second") ?? second,
    third: scheme.get("third") ?? third,
    winered: [128, 0, 0],
  };
  prior.coverlinecolor = prior.second;
  for (const [name, c] of Object.entries(prior)) out.set(name, (probe.has(name) ? parseColor(probe.get(name)!) : null) ?? c);
  return out;
}

/** Installed elegantnote.cls's six schemes and three optional reading surfaces. */
const NOTE_COLORS: Readonly<Record<string, Rgb>> = {
  green: [0, 120, 2], cyan: [31, 186, 190], blue: [1, 126, 218], sakura: [255, 183, 197], black: [0, 0, 0], brown: [109, 62, 18],
};
const NOTE_BACKGROUNDS: Readonly<Record<string, Rgb>> = {
  geye: [199, 237, 204], hazy: [251, 250, 248], sepia: [250, 237, 225],
};

/** The colours elegantbook's boxes fill with (their title tabs and tints). */
const ROLES = ["main", "second", "third"];

/**
 * The colour variables of a page, light and dark (see the file comment): `--llx-c-<id>` for text
 * and frames, and for elegantbook's roles `--llx-f-<id>` (the title tab) and `--llx-t-<id>` (the tint).
 */
export function colorCss(p: Profile, colors: ReadonlyMap<string, Rgb>): string {
  const light: string[] = [];
  const dark: string[] = [];
  for (const [name, c] of colors) {
    const id = colorId(name);
    const surface = colors.get("geyecolor") ?? WHITE;
    const lightColor = p.name === "elegantnote" && name === "ecolor" ? shift(c, BLACK, (x) => contrast(x, surface) >= 4.5) : c;
    light.push(`--llx-c-${id}: ${cssRgb(lightColor)};`);
    // A page background remains a surface; it is never adapted as text. Light mode keeps
    // TeX's reading tint, while the dark page uses the same tested dark surface as other classes.
    dark.push(`--llx-c-${id}: ${cssRgb(name === "geyecolor" && p.name === "elegantnote" ? DARK_BG : darkText(c))};`);
    if (p.elegant && ROLES.includes(name)) {
      light.push(`--llx-f-${id}: ${cssRgb(c)}; --llx-t-${id}: ${cssRgb(mix(c, WHITE, 0.05))};`);
      dark.push(`--llx-f-${id}: ${cssRgb(darkFill(c))}; --llx-t-${id}: ${cssRgb(mix(c, DARK_BG, 0.12))};`);
    }
  }
  if (!light.length) return "";
  return `:root { ${light.join(" ")} }\n@media (prefers-color-scheme: dark) { :root { ${dark.join(" ")} } }\n`;
}

// ---- the title block -------------------------------------------------------------------------

/** The page's title block (\maketitle) as the profile shows it; `name` gives the probe's labels. */
function titleCore(p: Profile, t: TitleBlock, name: (key: string) => string): string {
  if (p.name === "elegantnote" || p.name === "elegantpaper") {
    const lines = [t.subtitle, t.author, t.institute].filter(Boolean).map((x) => `<p>${x}</p>`).join("");
    const meta = (["version", "date"] as const).filter((k) => t[k]).map((k) => {
      const label = name(k);
      // The probe normalizes name whitespace; restore the separator after an ASCII colon.
      return `<p class="llx-title-detail llx-${p.cit}">${esc(label)}${/:$/.test(label) ? " " : ""}${t[k]}</p>`;
    }).join("");
    return `<header class="llx-title">${t.title ? `<h1>${t.title}</h1>` : ""}${lines}${meta}${t.extrainfo ? `<p>${t.extrainfo}</p>` : ""}</header>\n`;
  }
  if (p.name === "elegantbook") {
    const rows = (["author", "institute", "date", "version"] as const)
      .filter((k) => t[k])
      .map((k) => `<div><dt>${esc(name(k))}</dt><dd>${t[k]}</dd></div>`)
      .join("");
    return (
      `<header class="llx-title">${t.title ? `<h1>${t.title}</h1>` : ""}${t.subtitle ? `<p class="llx-subtitle">${t.subtitle}</p>` : ""}` +
      `${rows ? `<dl class="llx-title-meta">${rows}</dl>` : ""}${t.extrainfo ? `<p class="llx-extrainfo">${t.extrainfo}</p>` : ""}</header>\n`
    );
  }
  const lines = [t.subtitle, t.author, t.institute, t.date].filter(Boolean).map((x) => `<p>${x}</p>`).join("");
  return `<header class="llx-title">${t.title ? `<h1>${t.title}</h1>` : ""}${lines}</header>\n`;
}

/** Keep author/institution relationships in the compact, reflowing paper header. */
export function titleHtml(p: Profile, t: TitleBlock, name: (key: string) => string): string {
  const paper = t.paper;
  if (!paper) return titleCore(p, t, name);
  const authors = paper.authors.map(a => {
    const marks = a.affiliations.map(ref => ref.id ? `<a href="#${attr(ref.id)}">${esc(ref.label)}</a>` : esc(ref.label));
    if (a.corresponding) marks.push("*");
    return `<span class="llx-paper-author">${a.name}${marks.length ? `<sup>${marks.join(",")}</sup>` : ""}</span>`;
  }).join(", ");
  const core = titleCore(p, { ...t, author: authors || t.author, institute: paper.affiliations.length ? "" : t.institute }, name);
  const affiliations = paper.affiliations.map(a => `<p id="${attr(a.id)}" class="llx-paper-affiliation"><sup>${esc(a.label)}</sup> ${a.current ? "Current address: " : ""}${a.html}</p>`).join("");
  const contacts = paper.authors.map(a => {
    const values = [...a.emails, ...(a.orcid ? [`ORCID: ${a.orcid}`] : [])];
    return values.length ? `<p class="llx-paper-contact"><span>${a.name}:</span> ${values.join("; ")}</p>` : "";
  }).join("");
  const notes = [...paper.notes, ...paper.authors.flatMap(a => a.notes.map(note => `${a.name}: ${note}`))].map(note => `<p class="llx-paper-note">${note}</p>`).join("");
  const abstracts = paper.abstracts.map(html => `<section class="llx-abstract"><h2>${esc(name("abstract") || "Abstract")}</h2>${html}</section>`).join("");
  const keywords = paper.keywords.map(html => `<p class="llx-paper-keywords"><strong>${p.lang === "zh-CN" ? "关键词" : "Keywords"}:</strong> ${html}</p>`).join("");
  const subjects = paper.subjects.map(s => `<p class="llx-paper-subject"><strong>${esc(s.label)}:</strong> ${s.html}</p>`).join("");
  return core + `<div class="llx-paper-meta">${affiliations}${contacts}${notes}${paper.dedication ? `<p class="llx-paper-dedication">${paper.dedication}</p>` : ""}</div>` + abstracts + keywords + subjects;
}

// ---- the stylesheet --------------------------------------------------------------------------

/** Layout shared by the profiles: the page, math, lists, floats, tables, footnotes, fragments. */
const BASE_CSS = String.raw`
:root { color-scheme: light dark; --text: #1d1d1f; --muted: #6b6b70; --bg: #ffffff; --rule: #d8d8dc; --code-bg: #f4f4f6;
  --llx-cjk: "Songti SC", "Noto Serif CJK SC", "Noto Serif SC", "Source Han Serif SC", "Source Han Serif CN", SimSun, serif;
  --llx-kai: "Kaiti SC", STKaiti, KaiTi, "AR PL UKai CN", "Noto Serif CJK SC", serif;
  --llx-fangsong: STFangsong, FangSong, "Fangsong SC", "Noto Serif CJK SC", serif;
  --llx-mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --llx-link: rgb(26, 86, 160); --llx-heading: var(--text); }
@media (prefers-color-scheme: dark) {
  :root { --text: #e6e6e8; --muted: #a0a0a8; --bg: #1b1b1d; --rule: #3a3a3f; --code-bg: #26262a; --llx-link: rgb(138, 180, 240); }
}
html { background: var(--bg); }
body { margin: 0; background: var(--bg); color: var(--text); font-size: 17px; line-height: 1.75;
  font-family: var(--llx-latin), var(--llx-cjk); font-synthesis-style: none; }
main { max-width: 46rem; margin: 0 auto; padding: 1.5rem 16px 4rem; overflow-wrap: break-word; }
.llx-paper-meta { margin: 1rem 0 2rem; font-size: .9em; line-height: 1.5; }
.llx-paper-meta p { margin: .35rem 0; }
.llx-paper-author sup { margin-left: .15em; }
.llx-paper-affiliation sup { margin-right: .2em; }
.llx-paper-contact, .llx-paper-note { overflow-wrap: anywhere; }
.llx-paper-keywords, .llx-paper-subject { font-size: .92em; }
h1, h2, h3, h4, h5, h6 { color: var(--llx-heading); font-weight: 700; line-height: 1.35; }
h2 { font-size: 1.5rem; margin: 2.5rem 0 1rem; } h3 { font-size: 1.3rem; margin: 2rem 0 .75rem; }
h4 { font-size: 1.12rem; margin: 1.5rem 0 .5rem; } h5, h6 { font-size: 1rem; margin: 1.25rem 0 .5rem; }
.llx-num { margin-right: .6em; }
b.llx-runin { font-weight: 700; margin-right: .6em; }
:lang(zh) :is(em, i, .llx-it) { font-family: var(--llx-latin), var(--llx-kai); }
.llx-kai { font-family: var(--llx-latin), var(--llx-kai); }
.llx-fs { font-family: var(--llx-latin), var(--llx-fangsong); }
.llx-it { font-style: italic; } .llx-it em, .llx-it i { font-style: normal; }
nav.llx-toc ul { list-style: none; padding-left: 0; }
nav.llx-toc li { margin: .15rem 0; }
nav.llx-toc a { color: inherit; text-decoration: none; }
nav.llx-toc .llx-toc-top { font-weight: 700; margin-top: .55rem; }
nav.llx-toc .llx-toc-1 { padding-left: 1.5em; } nav.llx-toc .llx-toc-2 { padding-left: 3em; } nav.llx-toc .llx-toc-3 { padding-left: 4.5em; }
nav.llx-toc .llx-toc-top.llx-toc-1 { padding-left: 0; } nav.llx-toc .llx-toc-top.llx-toc-2 { padding-left: 0; }
p { margin: .5em 0; text-indent: 2em; }
p.llx-cont, li p, dd p, .llx-thm p, .llx-box p, figcaption p, .llx-footnotes p, header p { text-indent: 0; }
a { color: var(--llx-link); text-decoration: none; } a:hover { text-decoration: underline; }
code, pre { font-family: var(--llx-mono), var(--llx-cjk); font-size: .88em; }
.llx-code-token.llx-code-bf { font-weight: 700; }
.llx-code-token.llx-code-it { font-style: italic; }
.llx-code-token.llx-code-sl { font-style: oblique; }
.llx-code-token.llx-code-tt { font-family: var(--llx-mono), var(--llx-cjk); }
pre { background: var(--code-bg); padding: .75em 1em; overflow-x: auto; line-height: 1.5; border-radius: 4px; text-align: left; }
.llx-display { margin: .75em 0; overflow-x: auto; overflow-y: hidden; }
.llx-display > mjx-container[jax="CHTML"][display="true"] { margin: 0; }
p:has(mjx-container) { overflow-x: auto; overflow-y: hidden; }
p.llx-intertext { margin: .25em 0; }
.llx-math-error { color: #c62828; white-space: pre-wrap; }
.llx-list { list-style: none; padding-left: 2.2em; }
.llx-list > li { position: relative; }
.llx-label { position: absolute; left: -2.2em; width: 1.9em; text-align: right; }
.llx-bullet { font-size: .7em; vertical-align: .15em; }
.llx-list > li > p:first-of-type { margin-top: 0; }
.llx-bib { padding-left: 2.8em; } .llx-bib > li { margin: .3em 0; } .llx-bib .llx-label { left: -2.8em; width: 2.4em; }
.llx-bib-ay { padding-left: 1.5em; text-indent: -1.5em; }
a.llx-cite-link, a.llx-fn-link, a.llx-ref { text-decoration: none; }
dl dt { font-weight: 700; float: left; clear: left; margin-right: .6em; } dl dd { margin-left: 2em; }
dl dd > p:first-child { margin-top: 0; } dl::after { content: ""; display: block; clear: both; }
.llx-abstract { margin: 1.5em 2em; font-size: .94em; }
.llx-abstract > .llx-abstract-title { text-align: center; font-weight: 700; margin-bottom: .25em; }
.llx-thm, .llx-proof { margin: 1em 0; position: relative; }
.llx-thm-head { font-weight: 700; font-style: normal; font-family: var(--llx-latin), var(--llx-cjk); }
.llx-thm-note { font-weight: 400; }
.is-head-it > p > .llx-thm-head { font-weight: 400; font-style: italic; }
.llx-qed { float: right; margin-left: 1em; }
figure { margin: 1.25em 0; text-align: center; }
figure p, .llx-center p, .llx-minipage p { text-indent: 0; }
figcaption, p.llx-caption { font-size: .95em; } p.llx-caption { text-align: center; }
.llx-caption-label { margin-right: .5em; }
.llx-caption-label:not(.is-sub)::after { content: ":"; }
figure.llx-algorithm { text-align: left; border-top: 2px solid; border-bottom: 2px solid; padding: .15em 0 .3em; }
figure.llx-algorithm > figcaption { text-align: left; border-bottom: 1px solid; padding-bottom: .15em; margin-bottom: .4em; }
figure.llx-algorithm .llx-caption-label { font-weight: 700; color: inherit; } figure.llx-algorithm .llx-caption-label::after { content: none; }
.llx-minipage, figure.llx-subfloat { display: inline-block; margin: .25em .5%; }
.llx-img { max-width: 100%; height: auto; }
.llx-pdfpages { margin: 1.25em 0; text-align: center; }
.llx-pdfpages .llx-img { display: block; margin: .75em auto; border: 1px solid var(--rule); background: #fff; }
svg.llx-frag { max-width: 100%; height: auto; overflow: visible; }
.llx-frag-block { margin: .75em 0; overflow-x: auto; text-align: left; }
.llx-frag-block.is-display { text-align: center; }
.llx-frag-block > svg.llx-frag { vertical-align: top; }
table.llx-tabular { margin: 0 auto; border-collapse: collapse; line-height: 1.45; }
figure > table.llx-tabular, .llx-center > table.llx-tabular { max-width: 100%; }
table.llx-tabular td { padding: .15em .55em; text-align: left; vertical-align: baseline; }
table.llx-tabular td.llx-c { text-align: center; } table.llx-tabular td.llx-r { text-align: right; }
table.llx-tabular td.llx-vp { vertical-align: top; } table.llx-tabular td.llx-vm { vertical-align: middle; } table.llx-tabular td.llx-vb { vertical-align: bottom; }
td.llx-npl { padding-left: 0; } td.llx-npr { padding-right: 0; }
td.llx-vl { border-left: 1px solid; } td.llx-vr { border-right: 1px solid; } td.llx-vl2 { border-left: 3px double; } td.llx-vr2 { border-right: 3px double; }
td.llx-rt-thin, td.llx-rt-light { border-top: 1px solid; } td.llx-rt-heavy { border-top: 2px solid; } td.llx-rt-double { border-top: 3px double; }
td.llx-rb-thin, td.llx-rb-light { border-bottom: 1px solid; } td.llx-rb-heavy { border-bottom: 2px solid; } td.llx-rb-double { border-bottom: 3px double; }
.llx-source { white-space: pre-wrap; text-align: left; }
.llx-missing, .is-missing { color: #c62828; }
@media (prefers-color-scheme: dark) { .llx-missing, .is-missing, .llx-math-error { color: #ff8a80; } }
.llx-sf { font-family: system-ui, sans-serif; } .llx-sc { font-variant: small-caps; }
.llx-colorbox { color: #1d1d1f; padding: 0 .15em; }
.llx-footnotes { border-top: 1px solid var(--rule); margin-top: 3rem; padding-left: 2.2em; font-size: .92em; list-style: none; }
.llx-footnotes > li { position: relative; } .llx-footnotes p { margin: .2em 0; }
.llx-bf { font-weight: 700; } .llx-tt { font-family: var(--llx-mono); }
.llx-fbox { border: 1px solid currentColor; padding: 0 .2em; }
`;

/** elegantbook (see the file comment). */
const ELEGANT_CSS = String.raw`
:root { --llx-latin: "TeX Gyre Termes", "Times New Roman", Times, "Liberation Serif"; --llx-heading: var(--llx-c-structurecolor); --llx-link: var(--llx-c-winered); }
@media (prefers-color-scheme: dark) { :root { --llx-link: var(--llx-c-winered); } }
h2.llx-chapter, nav.llx-toc > h2 { text-align: center; font-size: 1.7rem; margin: 3rem 0 1.5rem; }
h3.llx-problemset { text-align: center; }
header.llx-title { border-top: 8px solid var(--llx-c-coverlinecolor); padding: 1.75rem .5rem 1rem; margin-bottom: 2rem; }
header.llx-title h1 { color: var(--text); font-size: 2rem; margin: 0 0 .5rem; }
.llx-subtitle { font-weight: 700; font-size: 1.2rem; color: var(--muted); margin: 0 0 1rem; }
.llx-title-meta { color: var(--muted); margin: 0; }
.llx-title-meta > div { display: flex; gap: .25em; }
.llx-title-meta dt { font-weight: 400; font-family: var(--llx-latin), var(--llx-kai); }
.llx-title-meta dd { margin: 0; }
.llx-extrainfo { text-align: center; font-family: var(--llx-latin), var(--llx-kai); margin-top: 1.5rem; }
.llx-caption-label { font-weight: 700; color: var(--llx-c-structurecolor); }
.is-main { --llx-role: var(--llx-c-main); --llx-role-fill: var(--llx-f-main); --llx-role-tint: var(--llx-t-main); }
.is-second { --llx-role: var(--llx-c-second); --llx-role-fill: var(--llx-f-second); --llx-role-tint: var(--llx-t-second); }
.is-third { --llx-role: var(--llx-c-third); --llx-role-fill: var(--llx-f-third); --llx-role-tint: var(--llx-t-third); }
.llx-box { position: relative; margin: 1.75em 0 1em; padding: 0 .9em 1em; border: .5pt solid var(--llx-role); border-radius: 3px; background: var(--llx-role-tint); }
.llx-box-title { display: block; width: fit-content; max-width: calc(100% - 1.2em); margin: -.8em 0 .15em .3em; padding: .05em .6em; background: var(--llx-role-fill); color: #fff; font-weight: 700; line-height: 1.5; font-style: normal; font-family: var(--llx-latin), var(--llx-cjk); }
.llx-box-body > :first-child { margin-top: .2em; } .llx-box-body > :last-child { margin-bottom: .2em; }
.llx-box-mark { position: absolute; right: .3em; bottom: .15em; color: var(--llx-role); line-height: 1; font-size: .95em; }
.llx-thm-head { color: var(--llx-role, inherit); }
.llx-list > li > p, dl dd > p { margin: .1em 0; }
pre.llx-lst { background: none; border: 1px solid var(--llx-c-structurecolor); border-radius: 0; }
.llx-thm-icon { position: absolute; left: -1.5em; top: .2em; color: rgb(255, 26, 26); font-size: .9em; }
@media (prefers-color-scheme: dark) { .llx-thm-icon { color: rgb(255, 128, 128); } }
`;

/** The standard classes (see the file comment). */
const STANDARD_CSS = String.raw`
:root { --llx-latin: "Latin Modern Roman", "CMU Serif", "Times New Roman", Times, "Liberation Serif"; }
.llx-num { margin-right: 1em; }
h2.llx-chapter { font-size: 1.9rem; margin: 3rem 0 1.5rem; }
h2.llx-chapter > .llx-num { display: block; font-size: 1.15rem; margin: 0 0 .5rem; }
header.llx-title { text-align: center; margin: 1.5rem 0 2rem; }
header.llx-title h1 { font-size: 1.75rem; font-weight: 400; margin: 0 0 1rem; }
header.llx-title p { font-size: 1.1rem; margin: .35rem 0; }
`;

/** The article members of ElegantLaTeX have centred article titles, with no cover band. */
const ELEGANT_ARTICLE_CSS = String.raw`
:root { --llx-latin: "TeX Gyre Termes", "Times New Roman", Times, "Liberation Serif"; }
header.llx-title h1 { font-weight: 700; }
header.llx-title p.llx-title-detail { font-size: .92em; }
.llx-caption-label { font-weight: 700; }
`;

const NOTE_CSS = String.raw`
:root { --llx-heading: var(--llx-c-ecolor); --llx-link: var(--llx-c-ecolor); }
header.llx-title, header.llx-title h1 { color: var(--llx-c-ecolor); }
.is-ecolor { --llx-role: var(--llx-c-ecolor); }
.llx-thm-head, .llx-caption-label { color: var(--llx-role, var(--llx-c-ecolor)); }
p { margin: .7em 0; }
`;
const PAPER_CSS = String.raw`
:root { --llx-link: var(--llx-c-winered); }
.llx-abstract { font-family: system-ui, sans-serif; }
:lang(zh) .llx-abstract { font-family: var(--llx-latin), var(--llx-kai); }
.llx-abstract > p.llx-abstract-title { font-family: var(--llx-latin), var(--llx-cjk); }
`;
const CTEX_CSS = String.raw`
.llx-chapter, .llx-section, .llx-part { text-align: center; }
.llx-chapter > .llx-num { display: inline; font-size: inherit; margin-right: 1em; }
`;

/** The page's stylesheet: the shared layout, the profile's look and the colour variables of `colors`. */
export function pageCss(p: Profile, colors: ReadonlyMap<string, Rgb>): string {
  const own = p.name === "elegantbook" ? ELEGANT_CSS
    : p.name === "elegantnote" ? STANDARD_CSS + ELEGANT_ARTICLE_CSS + NOTE_CSS + (colors.has("geyecolor") ? ":root { --bg: var(--llx-c-geyecolor); }\n" : "")
      : p.name === "elegantpaper" ? STANDARD_CSS + ELEGANT_ARTICLE_CSS + PAPER_CSS
        : STANDARD_CSS + (p.ctexChinese ? CTEX_CSS : "");
  return `${BASE_CSS}${own}${colorCss(p, colors)}`;
}

/** The markup of a theorem-like environment (the emitter supplies the parts, `flow` renders the body with a lead). */
export function theoremHtml(
  look: TheoremLook,
  o: { cls: string; id: string | null; head: string; note: string; punct: string; qed: string | null; flow: (lead: string) => string },
): string {
  const role = look.role ? ` is-${attr(look.role)}` : "";
  const body = look.body ? ` llx-${look.body}` : "";
  const id = o.id ? ` id="${attr(o.id)}"` : "";
  if (look.box) {
    const title = `${o.head}${o.note ? ` ${o.note}` : ""}`;
    const mark = look.mark ? `<span class="llx-box-mark" aria-hidden="true">${look.mark}</span>` : "";
    return `<div class="llx-box ${o.cls}${role}"${id}><div class="llx-box-title">${title}</div><div class="llx-box-body${body}">${o.flow("")}</div>${mark}</div>`;
  }
  const note = o.note ? (look.note === "plain" ? ` <span class="llx-thm-note">${o.note}</span>` : ` ${o.note}`) : "";
  const lead = `<span class="llx-thm-head">${o.head}${note}${o.punct}</span> `;
  const icon = look.icon ? `<span class="llx-thm-icon" aria-hidden="true">${look.icon}</span>` : "";
  let inner = o.flow(lead);
  if (o.qed) {
    // The end mark closes the last paragraph (amsthm's □ at the right of the last line).
    const qed = `<span class="llx-qed">${esc(o.qed)}</span>`;
    inner = inner.endsWith("</p>") ? `${inner.slice(0, -4)}${qed}</p>` : `${inner}<p class="llx-cont">${qed}</p>`;
  }
  const head = look.head === "italic" ? " is-head-it" : "";
  return `<div class="${o.cls}${role}${head}${body}"${id}>${icon}${inner}</div>`;
}
