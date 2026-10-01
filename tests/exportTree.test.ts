import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getParser } from "@unified-latex/unified-latex-util-parse";
import { projectSignatures } from "../src/export/signatures";
import { argText, expandEnvironment, given, parseTex, walkTex, type Signatures, type TexNode } from "../src/export/texTree";
import { projectDefinitions } from "../src/tex/macros";
import { theoremMap } from "../src/tex/theorems";

// The export's parser (src/export/texTree.ts, design 3.1): offsets, TeX's lexical rules, and a
// differential against unified-latex (a devDependency, never bundled) on every fixture project.

const FIXTURES = join(process.cwd(), "tests", "fixtures");
const BASE: Signatures = projectSignatures(
  { macros: new Map(), colors: new Set(), environments: new Set(), statements: [], unsupported: new Map(), packages: new Set(), files: [] },
  [],
  new Map(),
);
const sig = (macros: Record<string, string> = {}, envs: Record<string, string> = {}): Signatures => ({
  macros: new Map([...BASE.macros, ...Object.entries(macros)]),
  envs: new Map([...BASE.envs, ...Object.entries(envs)]),
});

/** The nodes' kinds and sources, one level deep. */
const shape = (src: string, nodes: TexNode[]) => nodes.map((n) => `${n.t === "macro" || n.t === "env" ? `${n.t}:${n.name}` : n.t}|${src.slice(n.from, n.to)}`);

/** Every node lies inside its parent and after its previous sibling; the top level covers `src`. */
function assertCovers(src: string, nodes: readonly TexNode[], from = 0, to = src.length, where = ""): void {
  let pos = from;
  for (const n of nodes) {
    assert.ok(n.from >= pos && n.to >= n.from && n.to <= to, `${where}: ${n.t} [${n.from}, ${n.to}) outside [${pos}, ${to})`);
    if (from === 0 && to === src.length) assert.equal(n.from, pos, `${where}: a gap before ${n.t} at ${n.from}`);
    pos = n.to;
    if (n.t === "group") assertCovers(src, n.body, n.from, n.to, where);
    if (n.t === "env") {
      assert.ok(n.bodyFrom >= n.from && n.bodyTo <= n.to && n.bodyFrom <= n.bodyTo, `${where}: env ${n.name} body`);
      assertCovers(src, n.body, n.bodyFrom, n.bodyTo, where);
    }
    if (n.t === "math") assert.ok(n.srcFrom >= n.from && n.srcTo <= n.to && n.srcFrom <= n.srcTo, `${where}: math source`);
    if (n.t === "macro" || n.t === "env" || n.t === "verb") {
      for (const a of n.args) {
        assert.ok(a.from >= n.from && a.to <= n.to, `${where}: ${n.t} argument outside its node`);
        if (a.body) assertCovers(src, a.body, a.from, a.to, where);
      }
    }
  }
  if (from === 0 && to === src.length) assert.equal(pos, to, `${where}: the nodes stop at ${pos} of ${to}`);
}

test("text, spaces, paragraphs and comments follow TeX's line rules", () => {
  const src = "Hello  world\nnext line\n\n  new par % note\n    joined%\n  on\n% c\n\nafter";
  const nodes = parseTex(src, sig());
  assertCovers(src, nodes);
  assert.deepEqual(shape(src, nodes), [
    "text|Hello",
    "space|  ",
    "text|world",
    "space|\n",
    "text|next",
    "space| ",
    "text|line",
    "par|\n\n  ",
    "text|new",
    "space| ",
    "text|par",
    "space| ",
    // The comment eats its line break and the next line's indentation ...
    "comment|% note\n    ",
    "text|joined",
    "comment|%\n  ",
    "text|on",
    "space|\n",
    "comment|% c\n",
    // ... and a blank line after one still ends the paragraph.
    "par|\n",
    "text|after",
  ]);
});

test("\\verb forms, \\lstinline and \\mintinline are raw text", () => {
  const src = "a \\verb|$x$ % {| b \\verb*+y+ \\lstinline[style=x]{f(a)} \\lstinline!z! \\mintinline{py}{p} \\verb|open\nnext";
  const nodes = parseTex(src, sig());
  assertCovers(src, nodes);
  const verbs = nodes.filter((n) => n.t === "verb");
  assert.deepEqual(
    verbs.map((v) => (v.t === "verb" ? [v.cmd, src.slice(v.textFrom, v.textTo)] : null)),
    [["verb", "$x$ % {"], ["verb", "y"], ["lstinline", "f(a)"], ["lstinline", "z"], ["mintinline", "p"], ["verb", "open"]],
  );
  const lst = verbs[2];
  assert.equal(lst.t === "verb" && argText(src, lst.args[0]), "style=x");
  // An unclosed \verb stops at its line's end; the next line is text again.
  assert.equal(nodes[nodes.length - 1].t, "text");
});

test("verbatim environments keep their text raw, options before it", () => {
  const src = [
    "\\begin{lstlisting}[language=Python,caption={排序 Sort}]",
    "x = 1  # $not math$ % not a comment",
    "\\end{itemize} {",
    "\\end{lstlisting}",
    "\\begin{minted}[linenos]{python}",
    "print(1)",
    "\\end{minted}\\begin{verbatim}v\\end{verbatim}",
  ].join("\n");
  const nodes = parseTex(src, sig());
  assertCovers(src, nodes);
  const [lst, , minted, verbatim] = nodes;
  assert.ok(lst.t === "verb" && minted.t === "verb" && verbatim.t === "verb");
  assert.equal(src.slice(lst.textFrom, lst.textTo), "\nx = 1  # $not math$ % not a comment\n\\end{itemize} {\n");
  assert.equal(argText(src, lst.args[0]), "language=Python,caption={排序 Sort}");
  assert.deepEqual(minted.args.map((a) => argText(src, a)), ["linenos", "python"]);
  assert.equal(src.slice(verbatim.textFrom, verbatim.textTo), "v");
});

test("\\iffalse first on its line skips nested conditionals as a comment", () => {
  const src = "a\n\\iffalse\n\\ifx\\a\\b $x$ \\fi \\ifdefined\\c y\\else z\\fi\n\\fi\nb \\let\\ifdraft\\iffalse c";
  const nodes = parseTex(src, sig());
  assertCovers(src, nodes);
  const comment = nodes.find((n) => n.t === "comment")!;
  assert.equal(src.slice(comment.from, comment.to), "\\iffalse\n\\ifx\\a\\b $x$ \\fi \\ifdefined\\c y\\else z\\fi\n\\fi");
  assert.ok(!nodes.some((n) => n.t === "math"), "the skipped formula is no math");
  // Not first on its line: an ordinary command (inside a \let definition here).
  assert.ok(nodes.some((n) => n.t === "macro" && n.name === "let" && n.code));
});

test("definitions are code: one node spanning the whole definition", () => {
  const defs = [
    "\\newcommand{\\E}[2][]{\\mathbb{E}_{#1}\\left[ #2 \\right]}",
    "\\newcommand*{\\iid}{\\stackrel{\\text{i.i.d.}}{\\sim}}",
    "\\renewcommand\\phi{\\varphi}",
    "\\def\\T{^{\\mathsf{T}}}",
    "\\def\\pair#1,#2.{(#1, #2)}",
    "\\let\\oldphi\\phi",
    "\\let\\a=\\b",
    "\\DeclareMathOperator*{\\argmin}{arg\\,min}",
    "\\DeclarePairedDelimiterX{\\inp}[2]{\\langle}{\\rangle}{#1, #2}",
    "\\NewDocumentCommand{\\set}{m o}{%\n  \\left\\{ #1 \\IfValueT{#2}{\\;\\middle|\\; #2} \\right\\}}",
    "\\newenvironment{keypoint}[1][Key point]\n  {\\par\\medskip\\noindent\\textbf{#1.}\\ \\itshape}\n  {\\par\\medskip}",
    "\\newtheorem{lemma}[theorem]{Lemma}[section]",
    "\\definecolor{main}{RGB}{0,166,82}",
  ];
  for (const d of defs) {
    const src = `${d} after`;
    const nodes = parseTex(src, sig());
    assertCovers(src, nodes);
    assert.equal(nodes[0].t, "macro", d);
    assert.equal(nodes[0].t === "macro" && nodes[0].code, true, d);
    assert.equal(src.slice(nodes[0].from, nodes[0].to), d);
  }
  // A definer the document renamed.
  const src = "\\nc{\\x}[1]{#1^2} after";
  const nodes = parseTex(src, { ...sig(), definers: new Map([["nc", "newcommand"]]) });
  assert.equal(src.slice(nodes[0].from, nodes[0].to), "\\nc{\\x}[1]{#1^2}");
});

test("traditional environments: balanced defaults, renewal, and begin/end argument substitution", () => {
  const declarations = [
    "\\newenvironment{point}[2][{\\textbf{Default}}]{\\par\\textbf{#1: #2}\\itshape}{\\par}",
    "\\newenvironment{renewed}{old}{ending}",
    "\\renewenvironment{renewed}[1]{\\begin{quote}#1}{\\end{quote}}",
    "\\begin{verbatim}\\newenvironment{fake}{wrong}{wrong}\\end{verbatim}",
    "\\verb|\\newenvironment{alsofake}{wrong}{wrong}|",
  ].join("\n");
  const signatures = projectSignatures(
    { macros: new Map(), colors: new Set(), environments: new Set(), statements: [], unsupported: new Map(), packages: new Set(), files: [] },
    [declarations], new Map(),
  );
  assert.equal(signatures.envs.get("point"), "o m");
  assert.equal(signatures.envs.get("renewed"), "m");
  assert.ok(!signatures.environmentDefs?.has("fake") && !signatures.environmentDefs?.has("alsofake"));
  const src = "\\begin{point}{Argument}Body #1.\\end{point}";
  const node = parseTex(src, signatures)[0];
  assert.ok(node.t === "env");
  assert.equal(expandEnvironment(src, node, signatures), "\\par\\textbf{{\\textbf{Default}}: Argument}\\itshape Body #1.\\par");
  const explicit = "\\begin{point}[Explicit]{Argument}Body.\\end{point}";
  const explicitNode = parseTex(explicit, signatures)[0];
  assert.ok(explicitNode.t === "env");
  assert.equal(expandEnvironment(explicit, explicitNode, signatures), "\\par\\textbf{Explicit: Argument}\\itshape Body.\\par");
  const renewed = "\\begin{renewed}{Heading}Body.\\end{renewed}";
  const renewedNode = parseTex(renewed, signatures)[0];
  assert.ok(renewedNode.t === "env");
  assert.equal(expandEnvironment(renewed, renewedNode, signatures), "\\begin{quote}HeadingBody.\\end{quote}");
});

test("math: delimiters, source offsets, % and escapes inside, paragraphs end inline math", () => {
  const src = "$a % $ not the end\n b$ and \\(c\\) and $$d$$ and \\[e\\] and \\$5 and $f\n\ng$ h";
  const nodes = parseTex(src, sig());
  assertCovers(src, nodes);
  const math = nodes.filter((n) => n.t === "math");
  assert.deepEqual(
    math.map((m) => (m.t === "math" ? [m.display, src.slice(m.srcFrom, m.srcTo)] : null)),
    [[false, "a % $ not the end\n b"], [false, "c"], [true, "d"], [true, "e"]],
  );
  // `\$` is a symbol; a `$` whose formula meets a blank line is text.
  assert.ok(nodes.some((n) => n.t === "macro" && n.name === "$"));
  assert.ok(nodes.some((n) => n.t === "text" && n.s.startsWith("$f")));
});

test("math: text arguments hold nested formulas; environments nest", () => {
  const src = "$f = \\text{当 $x$ 时} 1$ \\begin{equation}\\label{e}\n\\begin{cases} 1 & \\text{否则} \\end{cases}\\end{equation}";
  const nodes = parseTex(src, sig());
  assertCovers(src, nodes);
  const [inline, , display] = nodes;
  assert.ok(inline.t === "math" && display.t === "math");
  assert.equal(src.slice(inline.srcFrom, inline.srcTo), "f = \\text{当 $x$ 时} 1");
  assert.equal(display.env, "equation");
  assert.equal(src.slice(display.srcFrom, display.srcTo), "\\label{e}\n\\begin{cases} 1 & \\text{否则} \\end{cases}");
  assert.equal(display.to, src.length);
  const nested = parseTex("\\begin{align*}a\\begin{align*}b\\end{align*}c\\end{align*}x", sig());
  assert.equal(nested[0].t === "math" && nested[0].to, "\\begin{align*}a\\begin{align*}b\\end{align*}c\\end{align*}".length);
});

test("\\\\[2pt] takes its optional argument; \\\\* its star", () => {
  const src = "a\\\\[2pt] b\\\\*\n[3pt]c\\\\ d";
  const nodes = parseTex(src, sig());
  assertCovers(src, nodes);
  const breaks = nodes.filter((n) => n.t === "macro" && n.name === "\\");
  assert.deepEqual(
    breaks.map((b) => (b.t === "macro" ? [given(b.args[0]), argText(src, b.args[1])] : null)),
    [[false, "2pt"], [true, "3pt"], [false, ""]],
  );
});

test("a stray \\end is a macro; an unclosed \\begin runs to the end of what encloses it", () => {
  const src = "x \\end{foo} \\begin{a}\\begin{b} y \\end{a} z \\begin{itemize}\\item q";
  const nodes = parseTex(src, sig());
  assertCovers(src, nodes);
  assert.equal(shape(src, nodes)[2], "macro:end|\\end{foo}");
  const a = nodes.find((n) => n.t === "env" && n.name === "a")!;
  assert.ok(a.t === "env" && a.closed);
  const b = a.body[0];
  assert.ok(b.t === "env" && b.name === "b" && !b.closed, "b ends where a's \\end starts");
  assert.equal(b.to, src.indexOf("\\end{a}"));
  const list = nodes[nodes.length - 1];
  assert.ok(list.t === "env" && list.name === "itemize" && !list.closed && list.to === src.length);
  // Inside a group, an \end of an environment outside it is stray.
  const g = parseTex("\\begin{a}{\\end{a}}\\end{a}", sig());
  assert.ok(g[0].t === "env" && g[0].closed && g[0].body[0].t === "group");
});

test("elegantbook theorems: {title}{label} and [title]\\label{k} (g o t\\label g)", () => {
  const s = sig({}, { theorem: "g o t\\label g", lemma: "g o t\\label g" });
  const src = "\\begin{theorem}{全期望公式 Law}{total-exp}\nbody\\end{theorem}\\begin{lemma}[下降引理]\\label{lem:descent}\nx\\end{lemma}";
  const [thm, lem] = parseTex(src, s);
  assert.ok(thm.t === "env" && lem.t === "env");
  assert.deepEqual(thm.args.map((a) => [a.kind, given(a), argText(src, a)]), [["g", true, "全期望公式 Law"], ["o", false, ""], ["t", false, ""], ["g", true, "total-exp"]]);
  assert.deepEqual(lem.args.map((a) => [a.kind, given(a), argText(src, a)]), [["g", false, ""], ["o", true, "下降引理"], ["t", true, "\\label"], ["g", true, "lem:descent"]]);
  assert.equal(src.slice(thm.bodyFrom, thm.bodyTo), "\nbody");
});

test("arguments: one line break may separate them, a blank line may not; bare tokens", () => {
  const src = "\\section*[short]\n{Title}\\textbf x\\emph\\foo \\chapter\n\n{Next}";
  const nodes = parseTex(src, sig());
  assertCovers(src, nodes);
  const [sec, bf, emph] = nodes;
  assert.ok(sec.t === "macro" && bf.t === "macro" && emph.t === "macro");
  assert.deepEqual(sec.args.map((a) => argText(src, a)), ["*", "short", "Title"]);
  assert.equal(argText(src, bf.args[0]), "x");
  assert.equal(argText(src, emph.args[0]), "\\foo");
  const chapter = nodes.find((n) => n.t === "macro" && n.name === "chapter")!;
  assert.ok(chapter.t === "macro" && !given(chapter.args[2]), "a blank line ends the search");
});

test("arguments spanning lines: \\footnote over a paragraph break, \\caption with math", () => {
  const src = "a\\footnote{one\n\ntwo $x$}\\caption[s]{向量 $y$ 的投影}";
  const nodes = parseTex(src, sig());
  assertCovers(src, nodes);
  const fn = nodes[1];
  assert.ok(fn.t === "macro" && fn.args[1].body);
  assert.deepEqual(fn.args[1].body!.map((n) => n.t), ["text", "par", "text", "space", "math"]);
  const cap = nodes[2];
  assert.ok(cap.t === "macro" && cap.args[2].body?.some((n) => n.t === "math"));
});

test("brace groups scope font switches; \\item and lists", () => {
  const src = "{\\bfseries bold {\\itshape both}} \\begin{description}\\item[弱大数定律] a \\item b\\end{description}";
  const nodes = parseTex(src, sig());
  assertCovers(src, nodes);
  const g = nodes[0];
  assert.ok(g.t === "group" && g.body[0].t === "macro" && g.body[0].name === "bfseries");
  const list = nodes[2];
  assert.ok(list.t === "env");
  const items = list.body.filter((n) => n.t === "macro" && n.name === "item");
  assert.deepEqual(items.map((i) => (i.t === "macro" ? argText(src, i.args[0]) : "")), ["弱大数定律", ""]);
});

test("user macros read their signature; \\url and \\href targets are raw", () => {
  const s = sig({ KL: "o m m", zhen: "m m" });
  const src = "\\KL[\\text{fwd}]{P}{Q} \\zhen{中}{en} \\url{https://x.org/a%20b_c#d} \\href{http://y/%7E}{链接 text}";
  const nodes = parseTex(src, s);
  assertCovers(src, nodes);
  const [kl, , zhen, , url, , href] = nodes;
  assert.ok(kl.t === "macro" && zhen.t === "macro" && url.t === "macro" && href.t === "macro");
  assert.deepEqual(kl.args.map((a) => argText(src, a)), ["\\text{fwd}", "P", "Q"]);
  assert.deepEqual(zhen.args.map((a) => argText(src, a)), ["中", "en"]);
  assert.equal(argText(src, url.args[0]), "https://x.org/a%20b_c#d");
  assert.equal(url.args[0].body, null);
  assert.deepEqual(href.args.slice(1).map((a) => argText(src, a)), ["http://y/%7E", "链接 text"]);
  assert.equal(href.to, src.length);
});

test("accents, control symbols and tabular cells", () => {
  const src = "\\'e \\\"{u} \\& \\% \\begin{tabular}{@{}ll@{}} a & b \\\\ \\hline c & d\\end{tabular}";
  const nodes = parseTex(src, sig());
  assertCovers(src, nodes);
  assert.deepEqual(
    nodes.filter((n) => n.t === "macro").map((n) => (n.t === "macro" ? `${n.name}(${n.args.map((a) => argText(src, a)).join(",")})` : "")),
    ["'(e)", '"(u)', "&()", "%()"],
  );
  const tab = nodes[nodes.length - 1];
  assert.ok(tab.t === "env" && argText(src, tab.args[1]) === "@{}ll@{}");
  assert.ok(tab.body.some((n) => n.t === "text" && n.s === "&"));
});

test("walkTex visits arguments and bodies in source order", () => {
  const src = "\\section{A $x$}\\begin{itemize}\\item[\\textbf{t}] {g}\\end{itemize}";
  const seen: string[] = [];
  walkTex(parseTex(src, sig()), (n) => {
    seen.push(n.t === "macro" || n.t === "env" ? n.name : n.t);
  });
  assert.deepEqual(seen, ["section", "text", "space", "math", "itemize", "item", "textbf", "text", "space", "group", "text"]);
});

// ---- the fixture projects and the unified-latex differential ----------------------------------

function texFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) texFiles(p, out);
    else if (/\.(tex|sty)$/.test(e.name)) out.push(p);
  }
  return out;
}

const PROJECTS = ["export-book", "export-article", "export-homework", "elegantbook", "texproj"];

function projectOf(name: string): { root: string; sig: Signatures; files: string[] } {
  const root = join(FIXTURES, name, "main.tex");
  const defs = projectDefinitions(root);
  const sources = defs.files.map((f) => readFileSync(f, "utf8"));
  return { root, sig: projectSignatures(defs, sources, theoremMap(sources)), files: texFiles(join(FIXTURES, name)) };
}

test("every fixture file parses into nodes that cover it exactly", () => {
  for (const name of PROJECTS) {
    const p = projectOf(name);
    for (const f of p.files) assertCovers(readFileSync(f, "utf8"), parseTex(readFileSync(f, "utf8"), p.sig), 0, undefined, f);
  }
});

/** Events both parsers report: environments, formulas, verbatim, and macros with their argument counts. */
type Events = { at: number; key: string }[];
const MATH_ENV = /^(?:equation|align|gather|multline|flalign|alignat|eqnarray|displaymath|math)\*?$/;

function ours(src: string, nodes: readonly TexNode[], known: ReadonlyMap<string, string>, out: Events = []): Events {
  for (const n of nodes) {
    if (n.t === "env") {
      out.push({ at: n.from, key: `env ${n.name}` });
      for (const a of n.args) if (a.body) ours(src, a.body, known, out);
      ours(src, n.body, known, out);
    } else if (n.t === "math") out.push({ at: n.from, key: `math${n.display ? "D" : "I"} ${n.env ?? ""} ${n.to}` });
    else if (n.t === "verb") out.push({ at: n.from, key: "verb" });
    else if (n.t === "macro" && !n.code) {
      if (known.has(n.name)) out.push({ at: n.from, key: `\\${n.name}(${n.args.filter((a) => a.kind !== "s" && a.kind !== "t" && given(a)).length})` });
      for (const a of n.args) if (a.body) ours(src, a.body, known, out);
    } else if (n.t === "group") ours(src, n.body, known, out);
  }
  return out;
}

// unified-latex's AST, loosely typed (its types package is not a dependency of the plugin).
interface Ulx {
  type: string;
  content?: string | Ulx[];
  env?: string | { content: string };
  args?: { openMark: string; content: Ulx[] }[];
  position?: { start: { offset: number }; end: { offset: number } };
}

function theirs(nodes: Ulx[] | undefined, known: ReadonlyMap<string, string>, out: Events = []): Events {
  for (const n of nodes ?? []) {
    const at = n.position?.start.offset ?? -1;
    const end = n.position?.end.offset ?? -1;
    if (n.type === "environment" || n.type === "mathenv") {
      const name = typeof n.env === "string" ? n.env : (n.env?.content ?? "");
      if (n.type === "mathenv" || MATH_ENV.test(name)) out.push({ at, key: `mathD ${name} ${end}` });
      else if (/^(?:verbatim|lstlisting|minted|comment)$/.test(name)) out.push({ at, key: "verb" });
      else {
        out.push({ at, key: `env ${name}` });
        for (const a of n.args ?? []) theirs(a.content, known, out);
        theirs(n.content as Ulx[], known, out);
      }
    } else if (n.type === "verbatim" || n.type === "verb") out.push({ at, key: "verb" });
    else if (n.type === "inlinemath") out.push({ at, key: `mathI  ${end}` });
    else if (n.type === "displaymath") out.push({ at, key: `mathD  ${end}` });
    else if (n.type === "macro") {
      const name = n.content as string;
      if (known.has(name)) {
        const spec = known.get(name)!.match(/t\\[A-Za-z@]+|t\S|O\{[^}]*\}|[somgv]/g) ?? [];
        const count = (n.args ?? []).filter((a, i) => spec[i] !== "s" && !spec[i]?.startsWith("t") && (a.openMark !== "" || a.content.length)).length;
        out.push({ at, key: `\\${name}(${count})` });
      }
      for (const a of n.args ?? []) theirs(a.content, known, out);
    } else if (n.type === "group") theirs(n.content as Ulx[], known, out);
  }
  return out;
}

test("differential: the same environments, formulas, verbatim and arguments as unified-latex", () => {
  let same = 0;
  let total = 0;
  const unexplained: string[] = [];
  for (const name of PROJECTS) {
    const p = projectOf(name);
    // Commands whose arguments both parsers read the same way (unified-latex knows no `g`, `t`
    // or raw `v` arguments; its own catalog decides the rest).
    const known = new Map([...p.sig.macros].filter(([, spec]) => /^[som ]*$/.test(spec) && spec.trim()));
    const ulx = getParser({
      macros: Object.fromEntries([...known].map(([k, v]) => [k, { signature: v }])),
      environments: Object.fromEntries([...p.sig.envs].filter(([, v]) => /^[som ]*$/.test(v) && v.trim()).map(([k, v]) => [k, { signature: v }])),
    });
    for (const f of p.files) {
      const src = readFileSync(f, "utf8");
      const mine = parseTex(src, p.sig);
      const a = ours(src, mine, known);
      const b = theirs(ulx.parse(src).content as unknown as Ulx[], known);
      const A = new Set(a.map((e) => `${e.at} ${e.key}`));
      const B = new Set(b.map((e) => `${e.at} ${e.key}`));
      same += a.filter((e) => B.has(`${e.at} ${e.key}`)).length;
      total += Math.max(a.length, b.length);
      // Intended differences: what unified-latex reads inside a definition (code here, as in the
      // editor's scanner), elegantbook's `g` and `t\label` arguments, which unified-latex cannot
      // read, and listings' \lstinline, which it reads as a command.
      const code: [number, number][] = [];
      walkTex(mine, (n) => {
        if (n.t === "macro" && n.code) code.push([n.from, n.to]);
      });
      const gEnv = (e: { at: number }) => mine.some(function inG(n: TexNode): boolean {
        return n.t === "env" && ((n.args.some((x) => (x.kind === "g" || x.kind === "t") && given(x) && x.from <= e.at && e.at < x.to)) || n.body.some(inG));
      });
      const inline = new Set<number>();
      walkTex(mine, (n) => {
        if (n.t === "verb" && (n.cmd === "lstinline" || n.cmd === "mintinline")) inline.add(n.from);
      });
      for (const e of b) {
        if (A.has(`${e.at} ${e.key}`) || code.some(([x, y]) => e.at >= x && e.at < y) || gEnv(e)) continue;
        unexplained.push(`${f.slice(FIXTURES.length + 1)} @${e.at} only unified-latex: ${e.key}`);
      }
      for (const e of a) {
        if (B.has(`${e.at} ${e.key}`) || gEnv(e) || inline.has(e.at)) continue;
        unexplained.push(`${f.slice(FIXTURES.length + 1)} @${e.at} only ours: ${e.key}`);
      }
    }
  }
  assert.deepEqual(unexplained, []);
  assert.ok(total > 500 && same / total > 0.9, `${same}/${total} events agree`);
});

test("a 5,700-line chapter parses in well under a frame budget per 100 lines", () => {
  const lines: string[] = ["\\chapter{Long}"];
  for (let i = 1; lines.length < 5700; i++) {
    lines.push(
      `\\section{Part ${i}}`,
      `Let $x_{${i}} \\in \\mathbb{R}^{n}$ and \\(\\varepsilon = 2^{-${i}}\\), see~\\eqref{eq:${i}}.`,
      `\\begin{equation}\\label{eq:${i}}`,
      `  S_{${i}} = \\sum_{k=1}^{${i}} \\frac{1}{k^2}`,
      "\\end{equation}",
      "\\begin{itemize}\\item one \\textbf{two} \\item three\\end{itemize}",
      "",
    );
  }
  const src = lines.join("\n");
  const started = performance.now();
  const nodes = parseTex(src, sig());
  const ms = performance.now() - started;
  assertCovers(src, nodes);
  assert.ok(ms < 250, `${ms.toFixed(1)} ms`);
});

test("unified-latex is a devDependency only: the plugin's bundle never includes it", () => {
  // esbuild with the plugin's own externals (esbuild.config.mjs), as `npm run build` bundles main.js.
  const script = `
    const esbuild = require("esbuild");
    const builtins = require("node:module").builtinModules.flatMap((m) => [m, "node:" + m]);
    esbuild.build({ entryPoints: ["src/main.ts"], bundle: true, write: false, metafile: true, format: "cjs",
      platform: "node", target: "es2022", logLevel: "silent",
      external: ["obsidian", "electron", "@codemirror/*", "@lezer/*", ...builtins] })
      .then((r) => console.log(JSON.stringify(Object.keys(r.metafile.inputs))));`;
  const inputs = JSON.parse(execFileSync(process.execPath, ["-e", script], { encoding: "utf8" })) as string[];
  assert.ok(inputs.includes("src/export/texTree.ts"), "the export is bundled");
  assert.deepEqual(inputs.filter((f) => /unified-latex|pegjs/.test(f)), []);
});
