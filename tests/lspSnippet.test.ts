import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Completion, autocompletion, hasNextSnippetField, nextSnippetField, snippet } from "@codemirror/autocomplete";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { lspSnippetPlain, lspSnippetToCm } from "../src/editor/shared/lspSnippet";

/** Insert an LSP snippet at 0 and walk its tab stops: [doc, stops as "text"@pos]. */
function expand(lsp: string, multi = false): { template: string; doc: string; stops: string[]; view: EditorView } {
  const template = lspSnippetToCm(lsp);
  const view = new EditorView({
    state: EditorState.create({
      extensions: [autocompletion(), ...(multi ? [EditorState.allowMultipleSelections.of(true)] : [])],
    }),
    parent: document.body,
  });
  snippet(template)(view, null as unknown as Completion, 0, 0);
  const doc = view.state.doc.toString();
  const at = () => view.state.selection.ranges.map((r) => JSON.stringify(view.state.sliceDoc(r.from, r.to)) + "@" + r.from).join("|");
  const stops = [at()];
  for (let i = 0; i < 6 && hasNextSnippetField(view.state); i++) {
    nextSnippetField(view);
    stops.push(at());
  }
  return { template, doc, stops, view };
}

test("X20 numbered order, final $0, choices, variables, nesting, escapes", () => {
  const cases: [string, string, string, string[]][] = [
    ["f(${2:b}, ${1:a}, ${3:a})$0", "f(${2:b}, ${1:a}, ${3:a})${0}", "f(b, a, a)", ['"a"@5', '"b"@2', '"a"@8', '""@10']],
    ["#{\n\t$1\n}", "#\\{\n\t${1}\n}", "#{\n  \n}", ['""@5']],
    ["\\\\begin{${1:env}}\n\t$0\n\\\\end{${1}}", "\\begin{${1:env}}\n\t${0}\n\\end{${1:env}}",
      "\\begin{env}\n  \n\\end{env}", ['"env"@7', '""@14']],
    ["${1|left,right|}(${2})", "${1:left}(${2})", "left()", ['"left"@0', '""@5']],
    ["${TM_SELECTED_TEXT:x} + $1", "x + ${1}", "x + ", ['""@4']],
    ["${1:outer ${2:inner}}", "${1:outer inner}", "outer inner", ['"outer inner"@0']],
    ["\\$5 costs $1", "$5 costs ${1}", "$5 costs ", ['""@9']],
  ];
  for (const [lsp, template, doc, stops] of cases) {
    const r = expand(lsp);
    assert.deepEqual({ template: r.template, doc: r.doc, stops: r.stops }, { template, doc, stops }, lsp);
    r.view.destroy();
  }
});

test("texlab snippets keep their backslashes and put the cursor inside", () => {
  // Recorded texlab 5.26 textEdit.newText values (insertTextFormat 2), inserted after "\\".
  const cases: [string, string, string[]][] = [
    ["($0\\)", "(\\)", ['""@1']],
    ["[$0\\]", "[\\]", ['""@1']],
    ["{$0\\\\}", "{\\}", ['""@1']],
    ["begin{$1}\n\t$0\n\\end{$1}", "begin{}\n  \n\\end{}", ['""@6|""@16', '""@10']],
  ];
  for (const [lsp, doc, stops] of cases) {
    const r = expand(lsp, true);
    assert.deepEqual({ doc: r.doc, stops: r.stops }, { doc, stops }, lsp);
    r.view.destroy();
  }
});

test("braces are escaped only where CM would misread them, so every tab stop lands (6.20.3)", () => {
  // 6.20.3's Snippet.parse misplaces fields after several \{ \} escapes on one line.
  const cases: [string, string, string, string[]][] = [
    ["\\\\frac{$1}{$2}$0", "\\frac{${1}}{${2}}${0}", "\\frac{}{}", ['""@6', '""@8', '""@9']],
    ["#let ${1:f}(x) = {x + {$2}}$0", "#let ${1:f}(x) = {x + {${2}}}${0}", "#let f(x) = {x + {}}", ['"f"@5', '""@18', '""@20']],
    ["\\\\left\\\\{ $1 \\\\right\\\\} $2", "\\left\\\\{ ${1} \\right\\\\} ${2}", "\\left\\{  \\right\\} ",
      ['""@8', '""@18']],
    ["#{$1} + ${2:x}{$3}", "#\\{${1}} + ${2:x}{${3}}", "#{} + x{}", ['""@2', '"x"@6', '""@8']],
    ["\\$${1}{a}", "$${1}\\{a}", "${a}", ['""@1']], // `$` + field + `{` must not become a field
    ["${1:a\\\\}}", "${1:a\\}\\}", "a\\}", ['"a\\\\"@0']], // a default ending in a backslash, then }
  ];
  for (const [lsp, template, doc, stops] of cases) {
    const r = expand(lsp);
    assert.deepEqual({ template: r.template, doc: r.doc, stops: r.stops }, { template, doc, stops }, lsp);
    r.view.destroy();
  }
});

test("X20b linked fields mirror each other only with allowMultipleSelections", () => {
  for (const [multi, ranges, after] of [
    [false, 1, "\\begin{itemize}\n  \n\\end{env}"],
    [true, 2, "\\begin{itemize}\n  \n\\end{itemize}"],
  ] as [boolean, number, string][]) {
    const template = lspSnippetToCm("\\\\begin{${1:env}}\n\t$0\n\\\\end{${1}}");
    const view = new EditorView({
      state: EditorState.create({ extensions: [autocompletion(), ...(multi ? [EditorState.allowMultipleSelections.of(true)] : [])] }),
      parent: document.body,
    });
    snippet(template)(view, null as unknown as Completion, 0, 0);
    assert.equal(view.state.selection.ranges.length, ranges);
    view.dispatch(view.state.replaceSelection("itemize"));
    assert.equal(view.state.doc.toString(), after);
    view.destroy();
  }
});

test("defaults CM cannot hold keep the tab stop but drop the text", () => {
  assert.equal(lspSnippetToCm("${1:a{b\\}c}"), "${1}");
  assert.equal(lspSnippetToCm("${1:a{b}c}"), "${1}c}"); // the first unescaped } ends the field
  assert.equal(lspSnippetToCm("${1:two\nlines}"), "${1}");
  assert.equal(lspSnippetToCm("${1/(.*)/$1/}x"), "${1}x");
  assert.equal(lspSnippetToCm("cost: $"), "cost: $");
});

test("lspSnippetPlain: literal text when there is no tab stop, else null", () => {
  // tinymist sends every item as a snippet; most have no tab stop.
  assert.equal(lspSnippetPlain("calc"), "calc");
  assert.equal(lspSnippetPlain("application-bernstein-polynomials"), "application-bernstein-polynomials");
  assert.equal(lspSnippetPlain("#{}"), "#{}");
  assert.equal(lspSnippetPlain("\\\\{a\\\\}"), "\\{a\\}");
  assert.equal(lspSnippetPlain("\\$x"), "$x");
  assert.equal(lspSnippetPlain("calc.pi$0"), null);
  assert.equal(lspSnippetPlain("frac(${1}, ${2})"), null);
  assert.equal(lspSnippetPlain("{$0\\\\}"), null);
  assert.equal(lspSnippetPlain("if ${1:1 < 2} {\n\t${2}\n}"), null);
});
