// A TeX fragment as the text it typesets, roughly: what live preview's chips and list labels
// show and how .bib names read (`M{\"u}ller` is Müller). Accents become combining marks
// (then NFC), named letters and a few symbols become their characters, ties and `\,` become
// spaces, `--`/`---` dashes; the arguments that typeset nothing go with their command (a
// colour, a length, a label: elegantbook's item number `{\color {structurecolor}1.}` is `1.`),
// any other command is dropped (its arguments stay as text), and braces and `$` go. Pure: no
// Obsidian, no CodeMirror.

/** Accent commands -> the combining mark they put on the next letter or group. */
const ACCENTS: Record<string, string> = {
  '"': "̈",
  "'": "́",
  "`": "̀",
  "^": "̂",
  "~": "̃",
  "=": "̄",
  ".": "̇",
  u: "̆",
  v: "̌",
  H: "̋",
  c: "̧",
  k: "̨",
  r: "̊",
};

/** Commands that stand for text. */
const SYMBOLS: Record<string, string> = {
  ss: "ß",
  o: "ø",
  O: "Ø",
  aa: "å",
  AA: "Å",
  ae: "æ",
  AE: "Æ",
  oe: "œ",
  OE: "Œ",
  l: "ł",
  L: "Ł",
  i: "ı",
  j: "ȷ",
  S: "§",
  P: "¶",
  TeX: "TeX",
  LaTeX: "LaTeX",
  ldots: "…",
  dots: "…",
  textbackslash: "\\",
  textendash: "–",
  textemdash: "—",
  textbullet: "•",
  textasteriskcentered: "∗",
  textperiodcentered: "·",
  checkmark: "✓",
  bullet: "•",
  circ: "∘",
  cdot: "·",
  ast: "∗",
  star: "⋆",
  diamond: "⋄",
  times: "×",
  pm: "±",
  to: "→",
  rightarrow: "→",
  Rightarrow: "⇒",
  quad: " ",
  qquad: " ",
};

/** Control symbols that typeset (or break into) space: `\ `, `\,`, `\\`. */
const SPACE_SYMBOLS = new Set([" ", ",", ";", ":", "!", "/", "\\", "\n", "\t"]);

/**
 * Commands whose first N mandatory arguments typeset nothing (a colour, a length, a key); their
 * star and optional arguments (`\color[rgb]{..}`, `\makebox[2em][l]{..}`) typeset nothing either.
 */
const SILENT_ARGS: Record<string, number> = {
  color: 1,
  textcolor: 1,
  colorbox: 1,
  fcolorbox: 2,
  pagecolor: 1,
  hspace: 1,
  vspace: 1,
  rule: 2,
  phantom: 1,
  hphantom: 1,
  vphantom: 1,
  label: 1,
  index: 1,
  setcounter: 2,
  addtocounter: 2,
  setlength: 2,
  makebox: 0,
  framebox: 0,
  parbox: 1,
  raisebox: 1,
};

/** The index after a SILENT_ARGS command's star, optional arguments and `count` mandatory ones from s[i]. */
function skipSilent(s: string, i: number, count: number): number {
  if (s[i] === "*") i++;
  for (let k = 0; ; ) {
    while (s[i] === " ") i++;
    const opt = optionalEnd(s, i);
    if (opt > i) {
      i = opt; // \raisebox{1ex}[0pt][0pt]{..}: optional arguments between and after
      continue;
    }
    if (k++ === count || i >= s.length) return i;
    // One argument: a group, a command (`\color\red`) or a character.
    i = s[i] === "{" ? groupEnd(s, i) : s[i] === "\\" ? i + (/^\\(?:[A-Za-z]+|.)/s.exec(s.slice(i, i + 40))?.[0].length ?? 1) : i + 1;
  }
}

/** The index after the brace group opened at s[i] (escapes skipped), or the end when it never closes. */
export function groupEnd(s: string, i: number): number {
  for (let j = i + 1, depth = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "{") depth++;
    else if (c === "}" && depth-- === 0) return j + 1;
  }
  return s.length;
}

/** The index after a `[..]` optional argument at s[i] (braces balanced), else i. */
function optionalEnd(s: string, i: number): number {
  if (s[i] !== "[") return i;
  for (let j = i + 1, depth = 0; j < s.length; j++) {
    const c = s[j];
    if (c === "\\") j++;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === "]" && depth <= 0) return j + 1;
  }
  return i;
}

/** The text `s` typesets (see the file comment). */
export function texText(s: string): string {
  let out = "";
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === "\\") {
      const m = /^(?:[A-Za-z]+|.)/s.exec(s.slice(i + 1, i + 40));
      const name = m?.[0] ?? "";
      i += 1 + name.length;
      if (Object.hasOwn(ACCENTS, name)) {
        // `\"u`, `\"{u}`, `\v s`: the mark goes on the next letter.
        while (s[i] === " ") i++;
        let base: string;
        if (s[i] === "{") {
          const e = s.indexOf("}", i);
          base = texText(s.slice(i + 1, e < 0 ? n : e));
          i = e < 0 ? n : e + 1;
        } else {
          base = s[i] === "\\" ? "" : (s[i] ?? "");
          if (base) i++;
          else {
            // `\'\i`: a dotless i under the accent.
            const inner = /^\\([A-Za-z]+)\s*/.exec(s.slice(i));
            if (inner) {
              const sym = Object.hasOwn(SYMBOLS, inner[1]) ? SYMBOLS[inner[1]] : "";
              base = sym === "ı" ? "i" : sym;
              i += inner[0].length;
            }
          }
        }
        out += (base.slice(0, 1) + ACCENTS[name] + base.slice(1)).normalize("NFC");
        continue;
      }
      if (Object.hasOwn(SYMBOLS, name)) {
        out += SYMBOLS[name];
        if (/^[A-Za-z]/.test(name)) while (s[i] === " ") i++;
      } else if (SPACE_SYMBOLS.has(name)) {
        out += " ";
      } else if (!/^[A-Za-z]/.test(name)) {
        out += name; // \&, \%, \$, \#, \_, \{, \}
      } else {
        while (s[i] === " ") i++; // a command word and the spaces it eats
        if (Object.hasOwn(SILENT_ARGS, name)) i = skipSilent(s, i, SILENT_ARGS[name]);
      }
      continue;
    }
    if (c === "~") out += " ";
    else if (c === "-" && s.startsWith("---", i)) {
      out += "—";
      i += 2;
    } else if (c === "-" && s[i + 1] === "-") {
      out += "–";
      i += 1;
    } else if (c === "`" && s[i + 1] === "`") {
      out += "“";
      i += 1;
    } else if (c === "'" && s[i + 1] === "'") {
      out += "”";
      i += 1;
    } else if (c !== "{" && c !== "}" && c !== "$") out += c;
    i++;
  }
  return out.replace(/\s+/g, " ").trim();
}
