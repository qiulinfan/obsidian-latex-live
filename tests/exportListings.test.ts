// Code styling is a bounded adapter over Obsidian's Prism tokenizer. These token fixtures
// exercise the stream contract without adding another lexer or a runtime dependency.
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { test } from "node:test";
import { highlightListing, prismTokenizer, type CodeToken, type CodeTokenizer, type ListingSettings, type PrismLike } from "../src/export/listings";

const settings: ListingSettings = {
  language: "Python", dialect: "", keywordstyle: String.raw`\color{winered}`,
  commentstyle: String.raw`\color{gray}`, stringstyle: "",
};
const resolveColor = (name: string) => ["winered", "gray", "blue!70!black"].includes(name) ? `var(--llx-c-${name.replace(/!/g, "-")})` : null;

function dom(html: string): HTMLElement {
  return new JSDOM(`<code>${html}</code>`).window.document.querySelector("code")!;
}
const fixed = (tokens: CodeToken[]): CodeTokenizer => () => tokens;

test("the homework's Python roles: def/for/in/range/len/while/and share TeX's keyword color, comments use gray", () => {
  const source = "def insertion(a):\n    for i in range(1, len(a)):\n        # preserve order <&>\n        while i and a[i] < a[i - 1]:\n            i -= 1\n";
  const tokens: CodeToken[] = [
    { type: "keyword", content: "def" }, " insertion(a):\n    ",
    { type: "keyword", content: "for" }, " i ", { type: "keyword", content: "in" }, " ",
    { type: "builtin", content: "range" }, "(1, ", { type: "builtin", content: "len" }, "(a)):\n        ",
    { type: "comment", content: "# preserve order <&>" }, "\n        ",
    { type: "keyword", content: "while" }, " i ", { type: "keyword", content: "and" }, " a[i] < a[i - 1]:\n            i -= 1\n",
  ];
  const out = highlightListing(source, settings, fixed(tokens), resolveColor);
  assert.deepEqual(out.issues, []);
  const code = dom(out.html);
  assert.equal(code.textContent, source);
  assert.deepEqual([...code.querySelectorAll(".llx-code-keyword")].map((n) => [n.textContent, n.getAttribute("style")]), ["def", "for", "in", "range", "len", "while", "and"].map((word) => [word, "color:var(--llx-c-winered)"]));
  assert.equal(code.querySelector(".llx-code-comment")!.getAttribute("style"), "color:var(--llx-c-gray)");
});

test("nested token content and string aliases keep tabs, blank lines, Unicode and all HTML-significant characters", () => {
  const source = 'x = "<img onerror=alert(1)> & 中文"\n\n\ttrue\n';
  const tokens: CodeToken[] = [
    { type: "assignment", content: ["x = ", { type: "char", alias: ["quoted", "string"], content: ['"', { type: "punctuation", content: "<" }, 'img onerror=alert(1)> & 中文"'] }] },
    "\n\n\t", { type: "boolean", content: "true" }, "\n",
  ];
  const out = highlightListing(source, { ...settings, stringstyle: String.raw`\bfseries\ttfamily\protect\color{blue!70!black}` }, fixed(tokens), resolveColor);
  assert.deepEqual(out.issues, []);
  const code = dom(out.html);
  assert.equal(code.textContent, source);
  assert.equal(code.querySelectorAll("img,script").length, 0);
  assert.equal(code.querySelector(".llx-code-string")!.className, "llx-code-token llx-code-string llx-code-bf llx-code-tt");
  assert.equal(code.querySelector(".llx-code-string")!.getAttribute("style"), "color:var(--llx-c-blue-70-black)");
  assert.equal(code.querySelectorAll(".llx-code-token").length, 2, "unknown containers and punctuation receive no theme class");
});

test("font switches and color take their last TeX value; role styles do not leak into adjacent source", () => {
  const source = "if plain";
  const out = highlightListing(source, { ...settings, keywordstyle: String.raw`\itshape\bfseries\slshape\color{gray}\color{winered}` }, fixed([{ type: "token", alias: "keyword", content: "if" }, " plain"]), resolveColor);
  assert.deepEqual(out.issues, []);
  const code = dom(out.html);
  const token = code.querySelector("span")!;
  assert.ok(token.classList.contains("llx-code-bf"));
  assert.ok(token.classList.contains("llx-code-sl"));
  assert.ok(!token.classList.contains("llx-code-it"));
  assert.equal(token.getAttribute("style"), "color:var(--llx-c-winered)");
  assert.equal(code.lastChild!.nodeValue, " plain");
});

test("unsupported styles and unavailable colors leave the complete code intact and explain the lost style", () => {
  const tokens: CodeToken[] = [{ type: "keyword", content: "if" }, " ", { type: "comment", content: "# end" }];
  const out = highlightListing("if # end", { ...settings, keywordstyle: String.raw`\bfseries\fontsize{12}{14}`, commentstyle: String.raw`\color{undefined}` }, fixed(tokens), resolveColor);
  assert.equal(dom(out.html).textContent, "if # end");
  assert.equal(dom(out.html).querySelectorAll("span").length, 0);
  assert.deepEqual(out.issues.map((i) => i.split(":")[0]), ["keywordstyle", "commentstyle"]);
  assert.match(out.issues[0], /unsupported TeX style/);
  assert.match(out.issues[1], /color undefined is unavailable/);
  const model = highlightListing("if", { ...settings, keywordstyle: String.raw`\color[rgb]{1,0,0}` }, fixed([{ type: "keyword", content: "if" }]), resolveColor);
  assert.equal(model.html, "if");
  assert.match(model.issues[0], /unsupported TeX color/);
  const group = highlightListing("if", { ...settings, keywordstyle: String.raw`{\bfseries}` }, fixed([{ type: "keyword", content: "if" }]), resolveColor);
  assert.equal(group.html, "if", "an immediately closed TeX group must not leak its font onto the following code");
  assert.match(group.issues[0], /unsupported TeX style/);
});

test("plain or unknown languages, tokenizer failures, malformed streams and changed source never lose text", () => {
  const source = "  <&>\n\t中文\n";
  let calls = 0;
  const unavailable: CodeTokenizer = () => { calls++; return null; };
  const plain = highlightListing(source, { ...settings, language: "" }, unavailable, resolveColor);
  assert.equal(dom(plain.html).textContent, source);
  assert.equal(calls, 0);
  assert.deepEqual(plain.issues, []);
  for (const tokenize of [undefined, unavailable, (() => { throw new Error("broken grammar"); }) as CodeTokenizer, fixed(["different text"]), (() => [null] as unknown as CodeToken[]) as CodeTokenizer]) {
    const out = highlightListing(source, settings, tokenize, resolveColor);
    assert.equal(dom(out.html).textContent, source);
    assert.equal(out.issues.length, 1);
    assert.equal(dom(out.html).querySelectorAll("span").length, 0);
  }
  assert.equal(highlightListing("\r\n", { ...settings, language: "" }, null, resolveColor).html, "\r\n", "raw line endings stay untouched");
});

test("cyclic or excessively deep token streams and failing color resolvers retain plain source", () => {
  const token: Exclude<CodeToken, string> = { type: "string", content: "x" };
  token.content = token;
  const cycle = highlightListing("x", settings, fixed([token]), resolveColor);
  assert.equal(cycle.html, "x");
  assert.match(cycle.issues[0], /nesting is too deep/);
  const resolver = highlightListing("if", settings, fixed([{ type: "keyword", content: "if" }]), () => { throw new Error("no color"); });
  assert.equal(resolver.html, "if");
  assert.match(resolver.issues[0], /no color/);
});

test("the Prism adapter selects only actual loaded grammars and calls tokenize without highlighting or hooks", () => {
  const grammars = { latex: {}, cpp: {}, csharp: {}, python: {}, markup: {}, bash: {} };
  const calls: { text: string; grammar: object }[] = [];
  const prism: PrismLike & { highlight(): never; hooks: { run(): never } } = {
    languages: grammars,
    tokenize(text, grammar) { calls.push({ text, grammar }); return [text]; },
    highlight() { throw new Error("highlight must not run"); },
    hooks: { run() { throw new Error("hooks must not run"); } },
  };
  const tokenize = prismTokenizer(prism);
  for (const [name, dialect, key] of [["[LaTeX]TeX", "", "latex"], ["tex", "latex", "latex"], ["C++", "ANSI", "cpp"], ["C#", "", "csharp"], ["Python", "", "python"], ["XML", "", "markup"], ["sh", "", "bash"]] as const) {
    assert.deepEqual(tokenize("<&>", name, dialect), ["<&>"]);
    assert.equal(calls.at(-1)!.grammar, grammars[key]);
  }
  assert.equal(tokenize("x", "unknown", ""), null);
  assert.equal(tokenize("x", "", ""), null);
  assert.equal(tokenize("x", "__proto__", ""), null);
  const fallback = prismTokenizer({ languages: { py: {} }, tokenize: (text) => [text] });
  assert.deepEqual(fallback("x", "Python", ""), ["x"], "an actually loaded alias is sufficient");
  const notGrammar = prismTokenizer({ languages: { extend: () => undefined }, tokenize: () => { throw new Error("not a grammar"); } });
  assert.equal(notGrammar("x", "extend", ""), null);
});
