// Where a jump lands (locateClick, wordOf) and the line flash (flashLine).
import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { FLASH_MS, flashLine, locateClick, revealFlash, wordOf } from "../src/editor/reveal";

const doc = Text.of([
  "\\section{Intro}",
  "",
  "The first sentence of a paragraph",
  "continues with a distinctive word here,",
  "and the paragraph ends.",
  "",
  "A distinctive word in another paragraph.",
  "数学公式与中文段落。",
]);

test("wordOf keeps the longest letter run of a PDF selection, ligatures unfolded", () => {
  assert.equal(wordOf(" distinctive, "), "distinctive");
  assert.equal(wordOf("ﬁrst"), "first");
  assert.equal(wordOf("a"), null);
  assert.equal(wordOf("—"), null);
  assert.equal(wordOf("中"), "中");
});

const only = (word: string) => ({ word, before: "", after: "" });

test("locateClick distinguishes repeated Chinese words inside one source token", () => {
  const text = "这里讨论连续函数和连续映射以及连续变化。";
  const chinese = Text.of([text]);
  assert.deepEqual(locateClick(chinese, 1, {
    word: "连续", before: "这里讨论连续函数和", after: "映射以及连续变化。",
  }), { line: 1, column: text.indexOf("连续映射") });
  assert.deepEqual(locateClick(chinese, 1, {
    word: "连续", before: "连续函数和连续映射以及", after: "变化。",
  }), { line: 1, column: text.indexOf("连续变化") });
});

test("locateClick: SyncTeX's line first, then nearest lines within the paragraph", () => {
  assert.deepEqual(locateClick(doc, 4, only("distinctive")), { line: 4, column: 17 });
  // SyncTeX often names the paragraph's last line; the word is two lines up.
  assert.deepEqual(locateClick(doc, 5, only("first")), { line: 3, column: 4 });
  // Never across a blank line into another paragraph.
  assert.equal(locateClick(doc, 7, only("sentence")), null);
  assert.deepEqual(locateClick(doc, 7, only("distinctive")), { line: 7, column: 2 });
});

test("locateClick prefers a whole word anywhere over part of a word", () => {
  // SyncTeX's line 4 has no "the"; line 5 has it as a whole word (line 3's "The" differs in case).
  assert.deepEqual(locateClick(doc, 4, only("the")), { line: 5, column: 4 });
  // A word hyphenated across PDF lines matches as a part.
  assert.deepEqual(locateClick(doc, 4, only("distinc")), { line: 4, column: 17 });
  assert.deepEqual(locateClick(doc, 8, only("中文")), { line: 8, column: 5 });
});

test("locateClick: the PDF words around the click pick the occurrence, far from SyncTeX's line", () => {
  const para = Text.of([
    "We prove the estimate for the linear problem first.",
    "Then the \\emph{nonlinear} problem follows from a fixed point",
    "argument, % the problem of uniqueness is left open",
    "and the problem of existence reduces to the estimate.",
    "",
    "Next paragraph.",
  ]);
  // SyncTeX names the paragraph's last line; the clicked "problem" follows "nonlinear".
  const click = { word: "problem", before: "first. Then the nonlinear", after: "follows from a fixed point" };
  assert.deepEqual(locateClick(para, 4, click), { line: 2, column: 26 });
  // The other occurrences by their own context; the comment's "problem" never matches.
  assert.deepEqual(locateClick(para, 4, { word: "problem", before: "point argument, and the", after: "of existence" }), { line: 4, column: 8 });
  assert.deepEqual(locateClick(para, 1, { word: "problem", before: "estimate for the linear", after: "first. Then" }), { line: 1, column: 37 });
  // Ligatures and case in the PDF context; macro names in the source are not words.
  assert.deepEqual(locateClick(para, 4, { word: "nonlinear", before: "ﬁrst. Then THE", after: "problem" }), { line: 2, column: 15 });
  assert.equal(locateClick(para, 2, only("emph")), null);
});

test("locateClick: from a beamer \\end{frame}, the whole frame, blank lines included", () => {
  const frames = Text.of([
    "\\begin{frame}{First}",
    "  Earlier frame text",
    "\\end{frame}",
    "",
    "\\begin{frame}{Overview}",
    "  \\begin{itemize}",
    "    \\item Photocurrent rises",
    "  \\end{itemize}",
    "",
    "  Parameterizing the model",
    "",
    "\\end{frame}",
  ]);
  // SyncTeX names line 12 for every word of the frame.
  assert.deepEqual(locateClick(frames, 12, only("Photocurrent")), { line: 7, column: 10 });
  assert.deepEqual(locateClick(frames, 12, only("Parameterizing")), { line: 10, column: 2 });
  assert.deepEqual(locateClick(frames, 12, only("Overview")), { line: 5, column: 14 });
  // Never into the frame before.
  assert.equal(locateClick(frames, 12, only("Earlier")), null);
});

test("flashLine marks the target line, then clears it", async () => {
  const view = new EditorView({ state: EditorState.create({ doc: doc.toString(), extensions: revealFlash }), parent: document.body });
  try {
    flashLine(view, doc.line(4).from + 3);
    const flashed = [...view.contentDOM.querySelectorAll(".ll-reveal-flash")];
    assert.equal(flashed.length, 1);
    assert.equal(flashed[0].textContent, doc.line(4).text);
    await new Promise((r) => setTimeout(r, FLASH_MS + 50));
    assert.equal(view.contentDOM.querySelectorAll(".ll-reveal-flash").length, 0);
  } finally {
    view.destroy();
  }
});
