// T-L2: ProjectMath, the private MathJax instance (design 4.1), on Obsidian's own MathJax
// bundle and config (tests/support/mathjax.ts) with the synthetic elegantbook fixture.
import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { MathError, MathJaxLike, ProjectMath, inputEpoch, prepareMath } from "../src/editor/mathjaxProject";
import { projectDefinitions } from "../src/tex/macros";
import { obsidianMathJax } from "./support/mathjax";

const BOOK = resolve("tests/fixtures/elegantbook");

/** MathJax glyph classes of a rendering (`mjx-c211D` is the double-struck R). */
const glyphs = (el: Element): string[] => [...el.querySelectorAll("mjx-c")].map((c) => c.className.split(" ")[0]);

/** The characters a rendering draws (CHTML draws glyphs from CSS, so textContent is empty). */
const chars = (el: Element): string => glyphs(el).map((c) => String.fromCodePoint(parseInt(c.slice(5), 16))).join("");

/** Obsidian's global renderer leaves an undefined macro as red text (noundefined). */
const globallyUndefined = (mj: { tex2mml(s: string): string }, src: string) => /mathcolor="red"/.test(mj.tex2mml(src));

async function book(extra: { physics?: boolean } = {}) {
  const { window, MathJax } = await obsidianMathJax();
  const defs = projectDefinitions(join(BOOK, "main.tex"));
  const math = ProjectMath.create(MathJax, window.document, {
    statements: defs.statements,
    physics: extra.physics ?? false,
    unsupported: defs.unsupported,
  });
  return { window, MathJax, math };
}

test("ProjectMath: the fixture's macros render, every statement accepted", async () => {
  const { math } = await book();
  assert.equal(math.isolated, true);
  assert.deepEqual(
    math.failed.map((f) => f.message),
    ["No MathJax equivalent", "No MathJax equivalent"],
    "only the definitions MathJax cannot read (\\sym, \\set)",
  );
  for (const src of [
    "\\E[Q]{X} + \\E{X}",
    "\\norm{x} = \\sqrt{\\inner{x}{x}}",
    "\\loss = \\loss[w]",
    "\\Z \\subset \\Q \\subset \\R",
    "\\half \\abs{x} \\dd[2]{x}",
    "\\Var(X) + \\argmin_x f",
    "\\ceil*{\\frac{a}{b}} \\braces{x}",
    "\\eps + \\pair a,b.",
    "\\oldphi \\ne \\phi",
    "\\begin{mat} 1 & 0 \\\\ 0 & 1 \\end{mat}",
    "\\textcolor{accent}{x} + \\Prob(A)",
    "\\Tr(A) + \\KL{P}{Q} + \\Lip",
    "\\bm{x} + \\SI{3}{m}",
    "\\text{当 } x \\to 0",
  ]) {
    const node = math.render(src, false);
    assert.equal(node.nodeName, "MJX-CONTAINER", src);
    assert.equal(node.querySelector("[data-mjx-error]"), null, src);
  }
  const R = math.render("\\R", false);
  assert.deepEqual(glyphs(R), ["mjx-c211D"], "\\providecommand{\\R} left the first \\R alone");
  assert.equal(R.querySelector("mjx-assistive-mml"), null, "Obsidian's options: no assistive MathML");
  assert.deepEqual(glyphs(math.render("\\oldphi\\phi", false)), ["mjx-c1D719", "mjx-c1D711"], "\\let before \\renewcommand");
  assert.deepEqual(glyphs(math.render("\\N", false)), ["mjx-c2115", "mjx-c30"], "main.tex's \\renewcommand{\\N} wins");
});

test("ProjectMath: isolated from Obsidian's global MathJax and from other projects", async () => {
  const { window, MathJax, math } = await book();
  assert.ok(globallyUndefined(MathJax, "\\R"), "project macros never reach Markdown notes");
  assert.ok(globallyUndefined(MathJax, "\\Lip"));
  const other = ProjectMath.create(MathJax, window.document, { statements: ["\\newcommand{\\R}{\\mathrm{R}}"], physics: false });
  assert.deepEqual(glyphs(other.render("\\R", false)), ["mjx-c52"]);
  assert.throws(() => other.render("\\Lip", false), /Undefined control sequence \\Lip/);
  assert.deepEqual(glyphs(math.render("\\R", false)), ["mjx-c211D"], "the first project keeps its \\R");
});

test("ProjectMath: labels become tags from the .aux numbers and render twice", async () => {
  const labels = new Map([["eq:var-def", "1.2"]]);
  const { math } = await book();
  const src = "\\begin{align} a &= b \\label{eq:var-def} \\\\ c &= d \\label{eq:unknown} \\end{align}";
  for (let i = 0; i < 2; i++) {
    const node = math.render(src, true, labels);
    assert.equal(node.querySelector("[data-mjx-error]"), null);
    assert.ok(chars(node).endsWith("(1.2)"), chars(node));
  }
  assert.ok(!chars(math.render(src, true)).includes("("), "labels are a render argument");
  assert.match(chars(math.render("\\text{by } \\eqref{eq:var-def}", false, labels)), /\(1\.2\)$/);
});

test("ProjectMath: a label inside split/aligned/gathered tags its row; unnumbered displays get none", async () => {
  const labels = new Map([["eq:a", "1.2"], ["eq:b", "1.3"]]);
  const { math } = await book();
  const tagged = (src: string, want: string[]) => {
    const text = chars(math.render(src, true, labels));
    assert.deepEqual(text.match(/\(1\.\d\)/g) ?? [], want, `${src} -> ${text}`);
  };
  // MathJax rejects \tag inside these; LaTeX numbers the equation around them.
  for (const env of ["split", "aligned", "gathered", "alignedat}{1"]) {
    tagged(`\\begin{equation}\\begin{${env}} a &= b \\label{eq:a} \\\\ c &= d \\end{${env.split("}")[0]}}\\end{equation}`, ["(1.2)"]);
  }
  tagged("\\begin{align} x &= \\begin{aligned} 1 \\label{eq:a} \\\\ 2 \\end{aligned} \\\\ y &= 3 \\label{eq:b} \\end{align}", ["(1.2)", "(1.3)"]);
  tagged("\\begin{align} a &= \\sum_{\\substack{i \\\\ j}} x \\label{eq:a} \\\\ b \\end{align}", ["(1.2)"]);
  tagged("\\begin{multline} a \\\\ b \\label{eq:a} \\\\ c \\end{multline}", ["(1.2)"]);
  tagged("\\begin{equation} a \\label{eq:a} \\label{eq:b} \\end{equation}", ["(1.2)"]);
  // LaTeX writes these labels to the .aux with the previous number but prints none.
  for (const src of [
    "\\begin{equation*} a \\label{eq:a} \\end{equation*}",
    "\\begin{gather*} a \\label{eq:a} \\end{gather*}",
    " a \\label{eq:a} ",
    "\\begin{split} a &= b \\label{eq:a} \\\\ c \\end{split}",
  ]) {
    tagged(src, []);
  }
});

test("ProjectMath: references inside text-mode arguments render (\\textup)", async () => {
  const labels = new Map([["eq:a", "1.2"]]);
  const { math } = await book();
  for (const src of [
    "a = b \\quad \\text{by \\eqref{eq:a}}",
    "\\text{see Theorem \\ref{thm:x}}",
    "\\mbox{by \\eqref{eq:a}}",
    "a \\overset{\\eqref{eq:a}}{=} b",
  ]) {
    assert.equal(math.render(src, false, labels).nodeName, "MJX-CONTAINER", src);
  }
  assert.ok(chars(math.render("a = b \\tag{\\ref{eq:a}$'$}", true, labels)).includes("1.2"));
  assert.match(chars(math.render("\\text{by \\eqref{eq:a}}", false, labels)), /\(1\.2\)$/);
});

test("ProjectMath: a definition inside a formula applies to that formula only", async () => {
  const { math } = await book();
  assert.deepEqual(glyphs(math.render("\\def\\foo{x} \\foo", false)), ["mjx-c1D465"]);
  assert.throws(() => math.render("\\foo", false), /Undefined control sequence \\foo/);
  assert.deepEqual(glyphs(math.render("\\renewcommand{\\R}{y} \\R", false)), ["mjx-c1D466"]);
  assert.deepEqual(glyphs(math.render("\\R", false)), ["mjx-c211D"], "the project's \\R again");
  assert.throws(() => math.render("\\newenvironment{bx}{[}{]} \\newcommand{\\bar}{", false), /Missing close brace/);
  assert.throws(() => math.render("\\begin{bx} a \\end{bx}", false), /Unknown environment 'bx'/);
  assert.match(math.render("\\definecolor{tmp}{RGB}{1,2,3} \\color{tmp}{x}", false).outerHTML, /rgb\(1, 2, 3\)/);
  assert.doesNotMatch(math.render("\\color{tmp}{x}", false).outerHTML, /rgb\(1, 2, 3\)/);
});

test("ProjectMath: a macro whose definition MathJax cannot read fails instead of MathJax's own", async () => {
  const { window, MathJax, math } = await book();
  // macros.tex: \NewDocumentCommand{\set}{m o}; braket's \set would draw `{M}[..]`.
  assert.throws(() => math.render("\\set{M}[\\tr M = 1]", false), (e: unknown) => e instanceof MathError && /\\set: \\NewDocumentCommand\{\\set\}\{m o\}/.test(e.message));
  // booknotes.sty: \newcommand{\sym}[1]{\bn@style{#1}}
  assert.throws(() => math.render("\\sym{S}", false), /MathJax cannot read the project's \\sym: \\newcommand\{\\sym\}/);
  assert.equal(math.render("A \\setminus B", false).nodeName, "MJX-CONTAINER", "a name that starts the same");
  const plain = ProjectMath.create(MathJax, window.document, { statements: [], physics: false });
  assert.equal(plain.render("\\set{M}", false).nodeName, "MJX-CONTAINER", "braket's \\set without the project");
  const symbol = ProjectMath.create(MathJax, window.document, { statements: [], physics: false, unsupported: new Map([["|", "\\NewDocumentCommand{\\|}{s}"]]) });
  assert.throws(() => symbol.render("\\|x\\|", false), /project's \\\|/);
  assert.equal(symbol.render("a | b", false).nodeName, "MJX-CONTAINER");
});

test("ProjectMath: failures throw MathError with MathJax's message", async () => {
  const { math } = await book();
  assert.throws(() => math.render("\\foobar{x}", false), (e: unknown) => e instanceof MathError && /Undefined control sequence \\foobar/.test(e.message));
  assert.throws(() => math.render("\\frac{a}{", false), /Missing close brace/);
  assert.throws(() => math.render("\\begin{tikzcd} A \\arrow[r] & B \\end{tikzcd}", true), /Unknown environment 'tikzcd'/);
  assert.throws(() => math.render("\\begin{align} a \\intertext{and} b \\end{align}", true), /intertext/);
  assert.equal(math.render("x^2", false).nodeName, "MJX-CONTAINER", "usable after a failure");
});

test("ProjectMath: physics only on request; one bad statement does not stop the rest", async () => {
  const { window, MathJax } = await obsidianMathJax();
  const make = (physics: boolean, statements: string[] = []) => ProjectMath.create(MathJax, window.document, { statements, physics });
  assert.deepEqual(glyphs(make(false).render("a \\div b", false)), ["mjx-c1D44E", "mjx-cF7", "mjx-c1D44F"]);
  assert.ok(glyphs(make(true).render("a \\div b", false)).includes("mjx-c1D6C1"), "physics' \\div is a divergence");
  assert.throws(() => make(false).render("\\dv{f}{x}", false));
  assert.equal(make(true).render("\\dv{f}{x}", false).nodeName, "MJX-CONTAINER");
  const m = make(false, ["\\newcommand{\\A}{a}", "\\usepackage{x}", "\\newcommand{\\B}{b}"]);
  assert.deepEqual(m.failed.map((f) => f.statement), ["\\usepackage{x}"]);
  assert.match(m.failed[0].message, /usepackage/);
  assert.equal(m.render("\\A + \\B", false).nodeName, "MJX-CONTAINER");
});

test("ProjectMath: without MathJax internals the public renderer is used, without project macros", async () => {
  const { window, MathJax } = await obsidianMathJax();
  const bare = Object.create(MathJax, { _: { value: undefined } }) as MathJaxLike;
  const warn = console.warn;
  const warnings: unknown[] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a);
  let math: ProjectMath;
  try {
    math = ProjectMath.create(bare, window.document, { statements: ["\\newcommand{\\LEAK}{1}"], physics: false });
    ProjectMath.create(bare, window.document, { statements: [], physics: false });
  } finally {
    console.warn = warn;
  }
  assert.equal(math.isolated, false);
  assert.equal(warnings.length, 1, "one warning");
  assert.ok(globallyUndefined(MathJax, "\\LEAK"), "definitions are never fed to the global instance");
  assert.throws(() => math.render("\\newcommand{\\LEAKED}{1} \\LEAKED", false), /needs MathJax's internals/);
  assert.ok(globallyUndefined(MathJax, "\\LEAKED"), "not even from a formula");
  assert.equal(math.render("x^2", false).nodeName, "MJX-CONTAINER");
  assert.throws(() => math.render("\\frac{a}{", false), /Missing close brace/);
  const labels = new Map([["k", "3"]]);
  const eq = "\\begin{equation} a \\label{k} \\end{equation}";
  for (let i = 0; i < 2; i++) assert.ok(chars(math.render(eq, true, labels)).endsWith("(3)"), "a label renders twice");
});

test("prepareMath and inputEpoch", () => {
  const labels = new Map([["a", "1.1"]]);
  const align = (body: string) => `\\begin{align}${body}\\end{align}`;
  assert.equal(prepareMath(align("x \\label{a} \\\\ y \\label{b}"), labels), align("x  \\tag{1.1}\\\\ y "));
  assert.equal(prepareMath(align("x \\label{a}"), labels, false), align("x "), "no tags in inline math");
  assert.equal(prepareMath("x \\label{a}", labels), "x ", "none in \\[ \\] either");
  assert.equal(prepareMath("\\ref{a}, \\eqref{ a }, \\ref{b}", labels), "\\textup{1.1}, \\textup{(1.1)}, \\textup{??}");
  assert.equal(prepareMath(align("a \\nonumber \\notag"), labels), align("a \\nonumber \\notag"));
  assert.equal(prepareMath(align("w \\tag{$\\star$}\\label{a}"), labels), align("w \\tag{$\\star$}"), "a row's own \\tag wins");
  assert.equal(prepareMath(align("a \\notag \\label{a} \\\\ b \\label{a}"), labels), align("a \\notag  \\\\ b \\tag{1.1}"));
  assert.equal(
    prepareMath("\\begin{equation}\\begin{split} a \\label{a} \\\\ b \\end{split}\\end{equation}", labels),
    "\\begin{equation}\\begin{split} a  \\\\ b \\end{split}\\tag{1.1}\\end{equation}",
    "out of the inner environment, at the row's end",
  );
  assert.equal(prepareMath(align("5\\% \\label{a} % \\\\ {\n"), labels), align("5\\%  % \\\\ {\n\\tag{1.1}"), "comments and \\%");
  const input = { statements: ["\\newcommand{\\R}{x}"], physics: false };
  assert.equal(inputEpoch(input), inputEpoch({ ...input, statements: ["\\newcommand{\\R}{x}"] }));
  assert.notEqual(inputEpoch(input), inputEpoch({ ...input, physics: true }));
  assert.notEqual(inputEpoch(input), inputEpoch({ ...input, statements: ["\\newcommand{\\R}{y}"] }));
  assert.notEqual(inputEpoch(input), inputEpoch({ ...input, unsupported: new Map([["set", "\\NewDocumentCommand{\\set}{m o}"]]) }));
});

test("ProjectMath: text-mode parses leave nothing behind (textmacros' own parse options are cleared)", async () => {
  const { math } = await book();
  type Opts = { nodeLists: Record<string, unknown[]> };
  const jax = (math as unknown as { jax: { tex: { parseOptions: { packageData: Map<string, { parseOptions: Opts }> } } } }).jax;
  const text = jax.tex.parseOptions.packageData.get("textmacros")!.parseOptions;
  assert.deepEqual(Object.keys(text.nodeLists), [], "after the statements");
  math.render("\\begin{equation} x = \\text{当 } y \\mbox{b $z$} \\label{k} \\end{equation}", true, new Map([["k", "2"]]));
  assert.throws(() => math.render("\\text{a} \\frac{", false));
  assert.deepEqual(Object.keys(text.nodeLists), [], "each would keep its formula's MathML (about 17 KB a render)");
});

test("ProjectMath: rebuilds release MathJax's per-input tags classes", async () => {
  const { window, MathJax } = await obsidianMathJax();
  const factory = (MathJax._ as { input: { tex: { Tags: { TagsFactory: { add(n: string, c: unknown): void; create(n: string): object } } } } })
    .input.tex.Tags.TagsFactory;
  const add = factory.add;
  const none = factory.create("none").constructor;
  const registered = new Map<string, unknown>();
  factory.add = (n, c) => {
    registered.set(n, c);
    add(n, c);
  };
  try {
    for (let i = 0; i < 3; i++) {
      const math = ProjectMath.create(MathJax, window.document, { statements: ["\\newcommand{\\A}{a}"], physics: false });
      const tagged = math.render("\\begin{equation} x \\coloneqq y \\label{k} \\end{equation}", true, new Map([["k", "7"]]));
      assert.ok(chars(tagged).endsWith("(7)"), "tags and mathtools still work");
    }
  } finally {
    factory.add = add;
  }
  const perInput = [...registered].filter(([n]) => /^(?:configTags|MathtoolsTags)-\d+$/.test(n));
  assert.ok(perInput.length >= 3, "each TeX input registers its own");
  assert.ok(perInput.every(([, c]) => c === none), "and each is pointed at the no-tags class, so the input can be freed");
  assert.ok(registered.has("ams"), "MathJax's own classes are left alone");
  assert.notEqual(registered.get("ams"), none);
});
