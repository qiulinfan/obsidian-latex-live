import { texText } from "./texText";

// The theorem-like environments of a project (design 4.5): live preview's boxes (#12) and the
// kind names of references. Pure: comment-free sources in document order, the root first (its
// \documentclass decides elegantbook's names, mode and colours). Checked against the installed
// elegantbook.cls (v4.6) and the PDFs pdfLaTeX and XeLaTeX print:
//   amsthm       `proof`: "Proof." ending in □; a [title] replaces the name. ctex (its classes, or
//                the package without scheme=plain) names it 证明.
//   \newtheorem{env}[shared]{Title}[within] numbers its heads, \newtheorem*{env}{Title} does not:
//                `Theorem 1.2 (Title)`, with amsthm's period (amsthm, the AMS classes, elegantbook's
//                simple mode).
//   elegantbook  the tcolorbox theorems theorem, definition, postulate, axiom, corollary, lemma and
//                proposition (argument spec `g o t\label g`: `\begin{theorem}{title}{label}` is
//                labelled `thm:label`, `[title]\label{k}` is `k`) and their starred forms (`g o`);
//                in `simple` mode they are amsthm theorems ([title] only). The heads example,
//                exercise and problem (numbered, `[title]` printed after the number), note, proof
//                (no end mark), solution, remark, assumption, conclusion, property, and
//                custom{Name}. Names from the class's language tables (lang=cn: 定理 ..., English
//                otherwise), colour roles as the class sets them (defstyle main, thmstyle second,
//                prostyle third; example, exercise, problem, solution main; proof, note, remark
//                second; assumption, conclusion, property, custom third), colours from its scheme
//                (`color=green|cyan|blue|gray|black`, blue by default).
//   \elegantnewtheorem{env}{Name}{style}{prefix}[shared]: a theorem of the given style; the prefix
//                defaults to the environment's name; [shared] counts on that theorem's counter.
//   Counters     which counter numbers an environment's heads when they print as
//                `\thechapter.\arabic{counter}` and each \chapter resets it (`counter`): elegantbook's
//                `tcb@cnt@<env>` (fancy) or `<env>` (simple) under thmcnt=chapter (its default),
//                `ELEGANT@samecnt` with usesamecnt, `exam`, `exer` and `prob`; `\newtheorem{env}{T}[chapter]`
//                and those sharing its counter. Checked against the .aux checkpoints XeLaTeX writes.
// A later definition of an environment replaces an earlier one.

export type TheoremRole = "main" | "second" | "third";

/**
 * The arguments of the \begin line: elegantbook's tcolorbox theorems `g o t\label g` ("tcb")
 * and their starred forms `g o` ("tcb*"), an optional title ("o"), a mandatory name ("m", custom).
 */
export type TheoremSpec = "tcb" | "tcb*" | "o" | "m" | "";

/**
 * Where the head prints the title: in parentheses after the number ("paren"), right after it
 * ("after": elegantbook's example), in place of the name ("replace": amsthm's proof), or as the
 * name itself ("name": custom).
 */
export type TheoremTitle = "paren" | "after" | "replace" | "name";

export interface TheoremDef {
  /** What the head prints before the number (`定理`, `Theorem`). */
  readonly name: string;
  /** A counter numbers the heads (the number comes from the head's .aux label). */
  readonly numbered: boolean;
  readonly spec: TheoremSpec;
  readonly title: TheoremTitle;
  /** After the head: amsthm's period. */
  readonly punct: string;
  /** elegantbook's label prefix (`thm`): `\begin{theorem}{T}{x}` is labelled `thm:x`. */
  readonly prefix: string | null;
  /** elegantbook's colour role and its colour under the document's scheme (`rgb(0, 166, 82)`). */
  readonly role: TheoremRole | null;
  readonly color: string | null;
  /** The mark the environment ends with (amsthm's proof: □). */
  readonly qed: string | null;
  /** `\<env>name` is defined (the class's language table, \elegantnewtheorem): \autoref falls back to it. */
  readonly nameMacro: boolean;
  /**
   * The counter that numbers the heads when they print `\thechapter.\arabic{counter}` and
   * \chapter resets it (see Counters); null otherwise. latexLive numbers a box without a label by
   * counting on it.
   */
  readonly counter: string | null;
  /** A \newtheorem of the project's sources: cleveref names the type by its title. */
  readonly user: boolean;
}

/** Environment name -> its definition. */
export type TheoremMap = ReadonlyMap<string, TheoremDef>;

type Rgb = readonly [number, number, number];

/** elegantbook.cls's `\ifdefstring{\ELEGANT@color}{..}` schemes: main, second, third. */
export const ELEGANT_SCHEMES: Readonly<Record<string, readonly [Rgb, Rgb, Rgb]>> = {
  green: [[0, 120, 2], [230, 90, 7], [0, 160, 152]],
  cyan: [[59, 180, 5], [175, 153, 8], [244, 105, 102]],
  blue: [[0, 166, 82], [255, 134, 24], [0, 174, 247]],
  gray: [[150, 150, 150], [150, 150, 150], [150, 150, 150]],
  black: [[0, 0, 0], [0, 0, 0], [0, 0, 0]],
};

/** elegantbook's `\<env>name`s under lang=cn and lang=en. */
export const ELEGANT_NAMES: Readonly<Record<"cn" | "en", Readonly<Record<string, string>>>> = {
  cn: {
    definition: "定义",
    theorem: "定理",
    axiom: "公理",
    postulate: "公设",
    lemma: "引理",
    proposition: "命题",
    corollary: "推论",
    example: "例题",
    problem: "问题",
    exercise: "练习",
    remark: "注",
    assumption: "假设",
    conclusion: "结论",
    solution: "解",
    property: "性质",
    note: "笔记",
    proof: "证明",
  },
  en: {
    definition: "Definition",
    theorem: "Theorem",
    axiom: "Axiom",
    postulate: "Postulate",
    lemma: "Lemma",
    proposition: "Proposition",
    corollary: "Corollary",
    example: "Example",
    problem: "Problem",
    exercise: "Exercise",
    remark: "Remark",
    assumption: "Assumption",
    conclusion: "Conclusion",
    solution: "Solution",
    property: "Property",
    note: "Note",
    proof: "Proof",
  },
};

/** elegantbook's tcolorbox theorems: label prefix and style. */
const ELEGANT_BOXES: readonly (readonly [env: string, prefix: string, role: TheoremRole])[] = [
  ["theorem", "thm", "second"],
  ["definition", "def", "main"],
  ["postulate", "pos", "second"],
  ["axiom", "axi", "second"],
  ["corollary", "cor", "second"],
  ["lemma", "lem", "second"],
  ["proposition", "pro", "third"],
];

/** elegantbook's other heads: colour role, their counter (`\newcounter{exam}[chapter]`) or null, how a [title] prints. */
const ELEGANT_HEADS: readonly (readonly [env: string, role: TheoremRole, counter: string | null, title: TheoremTitle | null])[] = [
  ["example", "main", "exam", "after"],
  ["exercise", "main", "exer", "after"],
  ["problem", "main", "prob", "after"],
  ["solution", "main", null, null],
  ["note", "second", null, null],
  ["proof", "second", null, null],
  ["remark", "second", null, null],
  ["assumption", "third", null, null],
  ["conclusion", "third", null, null],
  ["property", "third", null, null],
  ["custom", "third", null, "name"],
];

const STYLE_ROLES: Record<string, TheoremRole> = { defstyle: "main", thmstyle: "second", prostyle: "third" };
const ROLES: readonly TheoremRole[] = ["main", "second", "third"];

const DOCUMENTCLASS = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{\s*([^}\s]+)\s*\}/;
const PACKAGES = /\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g;
/** A brace group (two levels of nesting inside), its content captured. */
const ARG = String.raw`\{((?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*)\}`;
/** `\newtheorem(*){env}[shared]{Title}[within]`: star, env, shared, title, within. */
const NEWTHEOREM = new RegExp(String.raw`\\newtheorem(\*?)\s*\{\s*([^{}\s]+)\s*\}\s*(?:\[\s*([^\]\s]*)\s*\]\s*)?${ARG}(?:\s*\[\s*([^\]\s]*)\s*\])?`, "g");
/** `\elegantnewtheorem{env}{Name}{style}{prefix}[shared]`. */
const ELEGANTNEWTHEOREM = new RegExp(
  String.raw`\\elegantnewtheorem\s*\{\s*([^{}\s]+)\s*\}\s*${ARG}\s*\{\s*([A-Za-z]*)\s*\}(?:\s*\{\s*([^{}\s]*)\s*\})?(?:\s*\[\s*([^\]\s]*)\s*\])?`,
  "g",
);

const rgb = ([r, g, b]: Rgb): string => `rgb(${r}, ${g}, ${b})`;

/** A `\documentclass` option list's keys and values (`lang=cn` -> lang: cn; `simple` -> simple: ""). */
function classOptions(options: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (options ?? "").split(",")) {
    const [key, value = ""] = part.split("=").map((s) => s.trim());
    if (key) out.set(key, value);
  }
  return out;
}

/** The theorem-like environments the sources define (see the file comment). */
export function theoremMap(sources: readonly string[]): TheoremMap {
  const out = new Map<string, TheoremDef>();
  let cls: RegExpExecArray | null = null;
  const packages = new Map<string, string>();
  for (const src of sources) {
    cls ??= DOCUMENTCLASS.exec(src);
    for (const m of src.matchAll(PACKAGES)) for (const name of m[2].split(",")) packages.set(name.trim(), m[1] ?? "");
  }
  const className = cls?.[2] ?? "";
  const options = classOptions(cls?.[1]);
  const elegant = className === "elegantbook";
  // elegantbook: `lang=cn` or a bare `cn`, `mode=simple` or a bare `simple`, `color=..` or a bare scheme name.
  const pick = (key: string, values: readonly string[], fallback: string) =>
    options.get(key) || values.find((v) => options.has(v)) || fallback;
  const lang = pick("lang", ["cn", "en", "it", "fr", "nl", "hu", "de", "mn", "pt", "jp"], "en") === "cn" ? "cn" : "en";
  const tcb = elegant && pick("mode", ["fancy", "simple"], "fancy") !== "simple";
  const scheme = ELEGANT_SCHEMES[pick("color", Object.keys(ELEGANT_SCHEMES), "blue")] ?? null;
  // elegantbook numbers its theorems within `thmcnt` (chapter, or a bare `section`), on one shared
  // counter with `usesamecnt`.
  const byChapter = pick("thmcnt", ["chapter", "section"], "chapter") === "chapter";
  const sameCounter = options.has("usesamecnt") && options.get("usesamecnt") !== "false";
  // elegantbook's simple mode loads amsthm, but its heads (and the theorem style it leaves
  // current) print no period.
  const amsthm = packages.has("amsthm") || /^ams(?:art|book|proc)$/.test(className) || (elegant && !tcb);
  const period = amsthm && !elegant ? "." : "";
  const ctex = /^ctex(?:art|rep|book|beamer)$/.test(className) || (packages.has("ctex") && !/scheme\s*=\s*plain/.test(packages.get("ctex")!));
  const colour = (role: TheoremRole | null): string | null => (role && scheme ? rgb(scheme[ROLES.indexOf(role)]) : null);
  const base = { title: "paren" as const, punct: "", prefix: null, role: null, color: null, qed: null, nameMacro: false, user: false, counter: null };
  /** The counter of a `[shared]` environment (none: an unknown one, or a plain counter). */
  const counterOf = (shared: string): string | null => out.get(shared)?.counter ?? null;

  if (amsthm || ctex) {
    out.set("proof", { ...base, name: ctex ? "证明" : "Proof", numbered: false, spec: "o", title: "replace", punct: period, qed: amsthm ? "□" : null });
  }
  /** elegantbook's theorems (built in or \elegantnewtheorem'd): tcolorboxes, or amsthm ones in simple mode. */
  const elegantTheorem = (env: string, name: string, prefix: string, role: TheoremRole | null, shared = "") => {
    const common = { ...base, name, role, color: colour(role), nameMacro: true };
    // tcolorbox's `auto counter` (or `use counter from`), amsthm's \newtheorem{env}[shared]{..}[chapter].
    const counter = !byChapter ? null : sameCounter ? "ELEGANT@samecnt" : shared ? counterOf(shared) : tcb ? `tcb@cnt@${env}` : env;
    out.set(env, { ...common, numbered: true, spec: tcb ? "tcb" : "o", prefix: tcb ? prefix : null, counter });
    out.set(`${env}*`, { ...common, numbered: false, spec: tcb ? "tcb*" : "o" });
  };
  if (elegant) {
    const names = ELEGANT_NAMES[lang];
    for (const [env, prefix, role] of ELEGANT_BOXES) elegantTheorem(env, names[env], prefix, role);
    for (const [env, role, counter, title] of ELEGANT_HEADS) {
      out.set(env, {
        ...base,
        name: names[env] ?? "",
        numbered: counter !== null,
        counter,
        spec: title === "name" ? "m" : title ? "o" : "",
        title: title ?? "paren",
        role,
        color: colour(role),
        nameMacro: env !== "custom",
      });
    }
  }
  for (const src of sources) {
    for (const m of src.matchAll(NEWTHEOREM)) {
      const [, star, env, shared, title, within] = m;
      const counter = star ? null : shared ? counterOf(shared) : within === "chapter" ? env : null;
      out.set(env, { ...base, name: texText(title), numbered: !star, spec: "o", punct: period, user: true, counter });
    }
    if (!elegant) continue;
    for (const m of src.matchAll(ELEGANTNEWTHEOREM)) elegantTheorem(m[1], texText(m[2]), m[4] || m[1], STYLE_ROLES[m[3]] ?? null, m[5]);
  }
  return out;
}

/** Two maps define the same environments alike. */
export function sameTheorems(a: TheoremMap, b: TheoremMap): boolean {
  if (a.size !== b.size) return false;
  for (const [env, d] of a) {
    const e = b.get(env);
    if (!e || JSON.stringify(e) !== JSON.stringify(d)) return false;
  }
  return true;
}
