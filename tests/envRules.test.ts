// The live editor's rules (src/tex/envRules.ts): the three rule kinds in the scanner, the layers
// (user settings over preamble detection over the defaults, a template profile over all) and
// detection's positive and negative cases; the settings JSON's validation.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Text } from "@codemirror/state";
import { MATH_ENVS } from "../src/editor/latexHighlight";
import { parseRulesJson } from "../src/editor/envRulesModal";
import { labelIn } from "../src/editor/labelJump";
import { formulas, scanLatex } from "../src/editor/latexScan";
import {
  DEFAULT_MATH_ENVS, DEFAULT_RULES, EMPTY_USER_RULES, NO_DETECTED, commandEnd, detectEnvRules, mergeEnvRules, parseUserRules, rulesKey,
} from "../src/tex/envRules";

const doc = (s: string) => Text.of(s.split("\n"));
const user = (u: Partial<typeof EMPTY_USER_RULES>) => ({ ...EMPTY_USER_RULES, ...u });

test("the default formula environments include the highlighter's", () => {
  assert.deepEqual(DEFAULT_MATH_ENVS.filter((e) => MATH_ENVS.has(e)), [...MATH_ENVS]);
});

test("formula alias: myeq renders as equation, keeps its \\label, and its error fallback is the written source", () => {
  const rules = mergeEnvRules(user({ formulas: { myeq: "equation" } }));
  const s = "\\begin{myeq}\n  a = b \\label{eq:a}\n\\end{myeq}";
  const [m] = formulas(doc(s), rules);
  assert.equal(m.env, "myeq");
  assert.equal(m.display, true);
  assert.match(m.src, /^\\begin\{equation\}[\s\S]*\\label\{eq:a\}[\s\S]*\\end\{equation\}$/);
  assert.equal(s.slice(m.from, m.to), s, "the construct covers the written environment");
  assert.deepEqual(formulas(doc(s)), [], "no formula without the rule");
});

test("wrapper: subequations' shell collapses as lines, its equations stay formulas", () => {
  const s = "\\begin{subequations}\\label{eq:sys}\n\\begin{equation}\n x \\label{eq:x}\n\\end{equation}\n\\end{subequations}";
  const all = scanLatex(doc(s));
  const lines = all.filter((c) => c.kind === "envline").map((c) => s.slice(c.from, c.to));
  assert.deepEqual(lines, ["\\begin{subequations}\\label{eq:sys}", "\\end{subequations}"]);
  assert.equal(formulas(doc(s)).length, 1);
  const off = mergeEnvRules(user({ wrappers: ["!subequations"] }));
  assert.equal(scanLatex(doc(s), off).filter((c) => c.kind === "envline").length, 0, "!subequations keeps it source");
});

test("hidden command: arity from the macros, the table, else the adjacent groups; block when alone on its lines", () => {
  const rules = mergeEnvRules(user({ hidden: ["DeckLayout", "mystery"] }), NO_DETECTED, (n) => (n === "DeckLayout" ? { args: 1, optional: false } : undefined));
  const s = "\\centering\n\\DeckLayout{two} text {kept}\nA \\vspace{1em} B \\mystery[o]{x}{y} C";
  const cmds = scanLatex(doc(s), rules).filter((c) => c.kind === "command").map((c) => [s.slice(c.from, c.to), c.kind === "command" && c.block]);
  assert.deepEqual(cmds, [
    ["\\centering", true],
    ["\\DeckLayout{two}", false],
    ["\\vspace{1em}", false],
    ["\\mystery[o]{x}{y}", false],
  ]);
  assert.equal(commandEnd("\\x{a}", 2, { args: 2, optional: false }), -1, "a missing argument: not hidden");
});

test("caption: its float and label, for Figure n / Table n", () => {
  const s = "\\begin{figure}\n\\caption{A plot}\\label{fig:a}\n\\end{figure}\n\\begin{table}\n\\caption[short]{Rows}\n\\label{tab:b}\n\\end{table}\n\\caption{loose}";
  const caps = scanLatex(doc(s)).flatMap((c) => (c.kind === "caption" ? [[c.float, s.slice(c.contentFrom, c.contentTo), c.label]] : []));
  assert.deepEqual(caps, [["figure", "A plot", "fig:a"], ["table", "Rows", "tab:b"], [null, "loose", null]]);
});

test("layers: user over detected over defaults; a template profile's environment over all", () => {
  const detected = detectEnvRules(["\\newenvironment{myeq}{\\begin{align}}{\\end{align}}\\newenvironment{box}{\\begin{center}}{\\end{center}}"]);
  assert.equal(mergeEnvRules(EMPTY_USER_RULES, detected).math.get("myeq"), "align");
  assert.equal(mergeEnvRules(user({ formulas: { myeq: "gather" } }), detected).math.get("myeq"), "gather", "user over detected");
  assert.equal(mergeEnvRules(user({ formulas: { myeq: "source" } }), detected).math.has("myeq"), false, "source");
  assert.equal(mergeEnvRules(user({ formulas: { center: "source" } })).wrappers.has("center"), false, "user over defaults");
  assert.equal(mergeEnvRules(EMPTY_USER_RULES, detected).wrappers.has("box"), true);
  assert.equal(mergeEnvRules(EMPTY_USER_RULES, detected, undefined, ["box", "myeq"]).wrappers.has("box"), false, "profile over detected");
  assert.equal(mergeEnvRules(user({ wrappers: ["box"] }), detected, undefined, ["box"]).wrappers.has("box"), false, "profile over user");
  assert.equal(mergeEnvRules(user({ hidden: ["!centering"] })).hidden.has("centering"), false);
  assert.equal(rulesKey(mergeEnvRules(EMPTY_USER_RULES)), rulesKey(DEFAULT_RULES));
});

test("detection: math shells, layout-only wrappers and commands; everything else is not guessed", () => {
  const d = detectEnvRules([
    [
      "\\newenvironment{eqn}{\\begin{equation}}{\\end{equation}}",
      "\\NewDocumentEnvironment{eqs}{}{\\begin{gather*}}{\\end{gather*}}",
      "\\newenvironment{mid}[1][]{\\begin{center}\\vspace{#1}}{\\end{center}}",
      "\\newenvironment{small}{\\begin{center}\\small}{\\end{center}}", // a font size typesets: not guessed
      "\\newcommand{\\gap}{\\vspace{2mm}\\noindent}",
      "\\newcommand\\push[1]{\\hspace{#1}}",
      // negatives
      "\\newenvironment{half}{\\begin{equation}}{\\end{align}}",
      "\\newenvironment{note}{\\begin{center}\\textbf{Note}}{\\end{center}}",
      "\\newenvironment{thm}{\\begin{theorem}}{\\end{theorem}}",
      "\\newcommand{\\R}{\\mathbb{R}}",
      "\\newcommand{\\DeckLayout}[1]{\\def\\decklayout{#1}}",
    ].join("\n"),
  ]);
  assert.deepEqual([...d.math], [["eqn", "equation"], ["eqs", "gather*"]]);
  assert.deepEqual([...d.wrappers], ["mid"]);
  assert.deepEqual([...d.hidden], [["gap", { args: 0, optional: false }], ["push", { args: 1, optional: false }]]);
  const later = detectEnvRules(["\\newcommand{\\gap}{\\vspace{1mm}}", "\\renewcommand{\\gap}{gap}"]);
  assert.equal(later.hidden.has("gap"), false, "a later definition wins");
});

test("detection: a register filled while typesetting stays source, also when its name reaches the assignment as an argument", () => {
  // cv_WIAS's pattern: empty \*Content macros that \collect fills, some through \researchEntry.
  const d = detectEnvRules([
    [
      "\\newcommand{\\collect}[2]{\\expandafter\\g@addto@macro\\expandafter#1\\expandafter{#2}}",
      "\\newcommand{\\@entry}[2]{\\collect{#1}{\\item #2}}",
      "\\newcommand{\\researchEntry}[1]{\\@entry{\\researchContent}{#1}}",
      "\\newcommand{\\educationEntry}[1]{\\collect{\\educationContent}{#1\\gap}}",
      "\\newcommand{\\pubEntry}[1]{\\noexpand\\collect{\\noexpand\\pubsContent}{#1}}",
      "\\newcommand{\\educationContent}{}",
      "\\newcommand{\\researchContent}{}",
      "\\newcommand{\\pubsContent}{}",
      "\\newcommand{\\awardsContent}{}",
      "\\newcommand{\\flag}{\\relax}",
      "\\newcommand{\\gap}{\\vspace{2mm}}",
      "\\newcommand{\\blank}{}",
    ].join("\n"),
    "\\appto\\awardsContent{Prize}\\let\\flag\\relax\\researchEntry{Postdoc}",
  ]);
  for (const name of ["educationContent", "researchContent", "pubsContent", "awardsContent", "flag"]) assert.equal(d.hidden.has(name), false, name);
  assert.ok(d.hidden.has("gap"), "passed as the collected content, not as the register");
  assert.ok(d.hidden.has("blank"), "never assigned");
});

test("detection: a command that discards an argument stays source", () => {
  const d = detectEnvRules([
    [
      "\\newcommand\\emptyarg[1]{}",
      "\\newcommand\\half[2]{\\hspace{#1}}",
      "\\newcommand\\opt[1][]{}",
      "\\newcommand\\push[2]{\\hspace{#1}\\vspace{#2}}",
    ].join("\n"),
  ]);
  assert.deepEqual([...d.hidden], [["push", { args: 2, optional: false }]]);
});

test("settings JSON: literal names, known alias targets, a wrapper is no alias; invalid JSON throws", () => {
  assert.deepEqual(parseRulesJson("formulas", '{ "myeq": "equation" }'), { myeq: "equation" });
  assert.deepEqual(parseRulesJson("hidden", '["centering", "DeckLayout"]'), ["centering", "DeckLayout"]);
  assert.deepEqual(parseRulesJson("wrappers", ""), []);
  assert.throws(() => parseRulesJson("formulas", "{ myeq: equation }"), /Invalid JSON/);
  assert.throws(() => parseRulesJson("formulas", '{ "myeq": "theorem" }'), /not a known formula environment/);
  assert.throws(() => parseRulesJson("hidden", '["\\\\centering"]'), /without its backslash/);
  assert.throws(() => parseRulesJson("wrappers", '["a{b"]'), /literal environment name/);
  assert.throws(() => parseRulesJson("hidden", '["x", "x"]'), /twice/);
  assert.throws(() => parseUserRules({ formulas: { myeq: "equation" }, wrappers: ["myeq"] }), /both a formula alias and a wrapper/);
});

test("jump target of a reference: the \\label outside comments", () => {
  const d = doc("% \\label{a}\ntext\n\\label{a} \\label{b}");
  assert.equal(labelIn(d, "a"), "% \\label{a}\ntext\n".length);
  assert.equal(labelIn(d, "c"), null);
});
