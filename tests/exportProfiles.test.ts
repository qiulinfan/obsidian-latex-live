// The export's class profiles (src/export/profiles.ts, S4): detection, the names without the
// probe, chapter labels, colours (xcolor expressions, the dark variants' contrast, the page's
// colour variables), the census's theorems and each theorem style's look, and the markup the
// emitter writes with them for elegantbook's boxes and heads and for amsthm's and LaTeX's
// \newtheorem (emitDoc: handwritten probe records, no TeX).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { renderPage } from "../src/export/html";
import {
  BASE_COLORS,
  censusTheorems,
  chapterLabel,
  colorCss,
  colorNames,
  contrast,
  cssRgb,
  DARK_BG,
  darkFill,
  darkText,
  fallbackName,
  pageCss,
  parseColor,
  profileColors,
  profileOf,
  theoremLook,
  theoremStyle,
  titleHtml,
  xcolor,
  type Rgb,
} from "../src/export/profiles";
import { ELEGANT_SCHEMES, theoremMap } from "../src/tex/theorems";
import { emitDoc, removeExportTemps } from "./support/exportHost";

after(removeExportTemps);

const WHITE: Rgb = [255, 255, 255];
/** The lightest surface dark text sits on (a box's tint), as profiles.ts assumes. */
const SURFACE: Rgb = [48, 48, 52];

test("detection: elegantbook in Chinese and English, ctex, the standard classes", () => {
  const of = (src: string) => {
    const p = profileOf(src, [src]);
    return `${p.name} ${p.lang} ${p.elegant ?? "-"} ${p.cit}`;
  };
  assert.equal(of(String.raw`\documentclass[lang=cn,11pt,chinesefont=nofont]{elegantbook}`), "elegantbook zh-CN cn kai");
  assert.equal(of(String.raw`\documentclass[cn]{elegantbook}`), "elegantbook zh-CN cn kai");
  assert.equal(of(String.raw`\documentclass{elegantbook}`), "elegantbook en en it");
  assert.equal(of(String.raw`\documentclass{elegantnote}`), "elegantnote zh-CN cn kai");
  assert.equal(of(String.raw`\documentclass[en]{elegantnote}`), "elegantnote en en it");
  assert.equal(of(String.raw`\documentclass{elegantpaper}`), "elegantpaper en en it");
  assert.equal(of(String.raw`\documentclass[cn]{elegantpaper}`), "elegantpaper zh-CN cn kai");
  assert.equal(of(String.raw`\documentclass{ctexart}`), "ctex zh-CN - it");
  assert.equal(of(String.raw`\documentclass{article}\usepackage[UTF8]{ctex}`), "ctex zh-CN - it");
  assert.equal(of(String.raw`\documentclass[11pt]{amsart}`), "standard en - it");
  // A commented-out class line is no class.
  assert.equal(of("% \\documentclass{elegantbook}\n\\documentclass{book}"), "standard en - it");
});

test("names without the probe (ctex's, elegantbook's, LaTeX's) and chapter labels", () => {
  const cn = profileOf(String.raw`\documentclass[lang=cn]{elegantbook}`, []);
  const en = profileOf(String.raw`\documentclass{elegantbook}`, []);
  const ctex = profileOf(String.raw`\documentclass{ctexbook}`, []);
  const book = profileOf(String.raw`\documentclass{book}`, []);
  assert.deepEqual(["figure", "table", "contents", "bib", "proof", "theorem", "author"].map((k) => fallbackName(cn, k)), ["图", "表", "目录", "参考文献", "证明", "定理", "作者："]);
  assert.deepEqual(["figure", "contents", "theorem", "author"].map((k) => fallbackName(en, k)), ["Figure", "Contents", "Theorem", "Author: "]);
  assert.deepEqual(["figure", "table", "contents", "abstract", "appendix", "lstlisting"].map((k) => fallbackName(ctex, k)), ["图", "表", "目录", "摘要", "附录", "Listing"]);
  assert.deepEqual(["figure", "contents", "ref"].map((k) => fallbackName(book, k)), ["Figure", "Contents", "References"]);
  // A chapter's number as its heading prints it (the contents keep the .toc's number).
  const name = (p: typeof cn) => (k: string) => fallbackName(p, k);
  assert.equal(chapterLabel(cn, "第一章", false, name(cn)), "第一章");
  assert.equal(chapterLabel(cn, "A", true, name(cn)), "附录 A");
  assert.equal(chapterLabel(en, "2", false, name(en)), "Chapter 2");
  assert.equal(chapterLabel(book, "3", false, name(book)), "Chapter 3");
  assert.equal(chapterLabel(book, "B", true, name(book)), "Appendix B");
  assert.equal(chapterLabel(ctex, "第三章", false, name(ctex)), "第三章");
});

test("elegant article names and title rows; ctex scheme=plain preserves the base class", () => {
  const note = profileOf(String.raw`\documentclass{elegantnote}`, []);
  const paper = profileOf(String.raw`\documentclass[cn]{elegantpaper}`, []);
  const plain = profileOf(String.raw`\documentclass[scheme=plain]{ctexbook}`, []);
  const keys = ["example", "remark", "note", "case", "version", "date", "figure", "abstract"];
  assert.deepEqual(keys.map((k) => fallbackName(note, k)), ["例", "评论", "注", "案例", "版本：", "更新：", "图", "摘要"]);
  assert.deepEqual(keys.map((k) => fallbackName(paper, k)), ["例", "评论", "注", "案例", "版本：", "日期：", "图", "摘要"]);
  assert.deepEqual(["contents", "figure", "proof", "abstract"].map((k) => fallbackName(plain, k)), ["Contents", "Figure", "Proof", "Abstract"]);
  assert.equal(plain.lang, "zh-CN");
  const p = profileOf(String.raw`\documentclass{article}\usepackage[scheme=plain]{ctex}`, []);
  assert.equal(p.ctexChinese, false);
  assert.equal(fallbackName(p, "figure"), "Figure");
  const t = { title: "笔记", subtitle: "", author: "甲", institute: "学院", date: "2026", version: "0.1", extrainfo: "" };
  assert.equal(titleHtml(note, t, (k) => fallbackName(note, k)), '<header class="llx-title"><h1>笔记</h1><p>甲</p><p>学院</p><p class="llx-title-detail llx-kai">版本：0.1</p><p class="llx-title-detail llx-kai">更新：2026</p></header>\n');
  assert.match(titleHtml(paper, t, (k) => fallbackName(paper, k)), /日期：2026/);
  const english = profileOf(String.raw`\documentclass{elegantpaper}`, []);
  assert.match(titleHtml(english, t, (k) => fallbackName(english, k).trimEnd()), /Version: 0\.1/);
  assert.match(titleHtml(english, t, (k) => fallbackName(english, k).trimEnd()), /Date: 2026/);
  const css = pageCss(english, new Map());
  assert.match(css, /\.llx-abstract \{ font-family: system-ui, sans-serif; \}/);
  assert.match(css, /:lang\(zh\) \.llx-abstract \{ font-family: var\(--llx-latin\), var\(--llx-kai\); \}/);
  assert.match(css, /\.llx-abstract > p\.llx-abstract-title \{ font-family: var\(--llx-latin\), var\(--llx-cjk\); \}/);
  assert.doesNotMatch(pageCss(note, new Map()), /border-top: 8px/);
  assert.match(pageCss(profileOf(String.raw`\documentclass{ctexbook}`, []), new Map()), /\.llx-chapter > \.llx-num \{ display: inline;/);
  assert.doesNotMatch(pageCss(plain, new Map()), /\.llx-chapter > \.llx-num \{ display: inline;/);
});

test("elegantnote's actual schemes, reading modes, amsthm styles and paper proof", () => {
  const note = profileOf(String.raw`\documentclass[green,mode=sepia]{elegantnote}`, []);
  const colors = profileColors(note, new Map(), new Map());
  assert.deepEqual(Object.fromEntries(colors), { ecolor: [0, 120, 2], geyecolor: [250, 237, 225] });
  assert.deepEqual(profileColors(note, new Map([["ecolor", "rgb(2, 3, 4)"]]), new Map()).get("ecolor"), [2, 3, 4]);
  assert.match(pageCss(note, colors), /--bg: var\(--llx-c-geyecolor\)/);
  const css = colorCss(note, colors);
  assert.match(css, /--llx-c-geyecolor: rgb\(250, 237, 225\)/);
  assert.match(css.split("@media")[1], /--llx-c-geyecolor: rgb\(27, 27, 29\)/);
  const envs = new Map([["theorem", String.raw`macro:->\@thm {\th@plain }{theorem}{定理}`], ["note", String.raw`macro:->\@thm {\th@remark }{}{\normalfont\bfseries 注}`]]);
  const known = theoremMap([String.raw`\documentclass{elegantnote}\usepackage{amsthm}`]);
  const census = censusTheorems(envs, known, new Map());
  assert.equal(census.get("note")!.name, "注");
  assert.deepEqual(theoremLook(note, "theorem", census.get("theorem")!, envs.get("theorem")), { box: false, role: "ecolor", head: "bold", note: "plain", body: "kai", icon: null, mark: null, punct: "" });
  assert.equal(theoremLook(note, "note", census.get("note")!, envs.get("note")).body, "kai");
  const paper = profileOf(String.raw`\documentclass[cn]{elegantpaper}`, []);
  assert.equal(theoremLook(paper, "proof", known.get("proof")!, undefined).head, "bold");
  assert.equal(theoremLook(paper, "note", census.get("note")!, envs.get("note")).head, "bold");
  // Class schemes, including pale sakura, remain identifiable but their text is readable on
  // the class's white or tinted surface. The probe colours themselves remain unchanged.
  for (const mode of ["", "geye", "hazy", "sepia"]) for (const color of ["green", "cyan", "blue", "sakura", "black", "brown"]) {
    const p = profileOf(`\\documentclass[color=${color},mode=${mode}]{elegantnote}`, []);
    const colors = profileColors(p, new Map(), new Map());
    const [light, dark] = colorCss(p, colors).split("@media");
    const read = (css: string) => parseColor(/--llx-c-ecolor: (rgb\([^)]*\))/.exec(css)![1])!;
    assert.ok(contrast(read(light), colors.get("geyecolor") ?? WHITE) >= 4.5, `${color} ${mode} light`);
    assert.ok(contrast(read(dark), SURFACE) >= 4.5, `${color} ${mode} dark`);
  }
});

test("colours: xcolor's expressions, the dark variants reach 4.5:1, fills under white text, the page's variables", () => {
  const known = (n: string) => BASE_COLORS[n] ?? null;
  assert.deepEqual(xcolor("blue!70!black", known), [0, 0, 179]);
  assert.deepEqual(xcolor("red!30", known), [255, 179, 179]);
  assert.deepEqual(xcolor("-red", known), [0, 255, 255]);
  assert.deepEqual(xcolor("red!50!blue!50!white", known), [191, 128, 191]);
  assert.equal(xcolor("rgb:red,1;blue,2", known), null);
  assert.equal(xcolor("nosuch!20", known), null);
  assert.deepEqual(colorNames("-blue!70!black"), ["blue", "black"]);
  assert.deepEqual(colorNames("mygreen!60"), ["mygreen"]);
  assert.deepEqual(parseColor("rgb(0, 166, 82)"), [0, 166, 82]);
  assert.deepEqual(parseColor("#3c71b7"), [60, 113, 183]);
  // Every scheme colour of elegantbook, its link colour and xcolor's base names: text reaches 4.5
  // on the dark surfaces, white text on a fill reaches 4.5; a colour that already does stays.
  const all: Rgb[] = [...Object.values(ELEGANT_SCHEMES).flat(), [60, 113, 183], [128, 0, 0], ...Object.values(BASE_COLORS)];
  for (const c of all) {
    assert.ok(contrast(darkText(c), SURFACE) >= 4.5, `${cssRgb(c)} -> ${cssRgb(darkText(c))}`);
    assert.ok(contrast(darkText(c), DARK_BG) >= 4.5);
    assert.ok(contrast(WHITE, darkFill(c)) >= 4.5, `fill ${cssRgb(c)} -> ${cssRgb(darkFill(c))}`);
  }
  assert.deepEqual(darkText([255, 134, 24]), [255, 134, 24]);
  // elegantbook's colours: the probe's first, else the scheme theorems.ts read (green here).
  const src = String.raw`\documentclass[lang=cn,color=green]{elegantbook}`;
  const p = profileOf(src, [src]);
  const colors = profileColors(p, new Map([["structurecolor", "rgb(1, 2, 3)"]]), theoremMap([src]));
  assert.deepEqual(Object.fromEntries(colors), {
    structurecolor: [1, 2, 3],
    main: [...ELEGANT_SCHEMES.green[0]],
    second: [...ELEGANT_SCHEMES.green[1]],
    third: [...ELEGANT_SCHEMES.green[2]],
    winered: [128, 0, 0],
    coverlinecolor: [...ELEGANT_SCHEMES.green[1]],
  });
  const css = colorCss(p, colors);
  const [light, dark] = css.split("@media (prefers-color-scheme: dark)");
  assert.match(light, /--llx-c-main: rgb\(0, 120, 2\); --llx-f-main: rgb\(0, 120, 2\); --llx-t-main: rgb\(242, 248, 242\);/);
  assert.match(dark, new RegExp(`--llx-c-main: ${cssRgb(darkText([0, 120, 2])).replace(/[()]/g, "\\$&")};`));
  assert.match(dark, /--llx-t-main: rgb\(24, 38, 26\);/);
  assert.equal(profileColors(profileOf(String.raw`\documentclass{article}`, []), new Map(), new Map()).size, 0);
  assert.equal(colorCss(profileOf(String.raw`\documentclass{article}`, []), new Map()), "");
});

test("the census: amsthm's and LaTeX's \\newtheorem, a title through the probe's names; the looks", () => {
  const envs = new Map([
    ["thm", String.raw`macro:->\@thm {\let \thm@swap \@gobble \th@plain }{thm}{Theorem}`],
    ["defn", String.raw`macro:->\@thm {\let \thm@swap \@gobble \th@definition }{defn}{Definition}`],
    ["rem", String.raw`macro:->\@thm {\th@remark }{}{Remark}`],
    ["conj", String.raw`macro:->\@thm {conj}{Conjecture}`],
    ["lem", String.raw`macro:->\@thm {\let \thm@swap \@gobble \th@plain }{thm}{\lemmaname }`],
    ["keypoint", String.raw`macro:->\@protected@testopt \keypoint \\keypoint {Key point}`],
    ["known", String.raw`macro:->\@thm {known}{Known}`],
  ]);
  const known = theoremMap([String.raw`\newtheorem{known}{Known}`]);
  const census = censusTheorems(envs, known, new Map([["lemma", "Lemma"]]));
  assert.deepEqual(
    [...census].map(([env, d]) => `${env}: ${d.name} ${d.counter ?? "-"} ${d.numbered} "${d.punct}" ${d.spec}`),
    ["thm: Theorem thm true \".\" o", "defn: Definition defn true \".\" o", "rem: Remark - false \".\" o", "conj: Conjecture conj true \"\" o", "lem: Lemma thm true \".\" o"],
  );
  assert.deepEqual([...envs.values()].map(theoremStyle), ["plain", "definition", "remark", "kernel", "plain", null, "kernel"]);
  const std = profileOf(String.raw`\documentclass{article}`, []);
  const look = (env: string) => {
    const l = theoremLook(std, env, census.get(env)!, envs.get(env));
    return `${l.head} ${l.note} ${l.body || "-"}`;
  };
  assert.deepEqual(["thm", "defn", "rem", "conj"].map(look), ["bold plain it", "bold plain -", "italic plain -", "bold head it"]);
  // elegantbook: boxes (fancy), heads with icons and \citshape, simple mode's coloured amsthm heads.
  const cn = String.raw`\documentclass[lang=cn]{elegantbook}`;
  const fancy = theoremMap([cn]);
  const p = profileOf(cn, [cn]);
  const eb = (env: string, map = fancy, prof = p) => {
    const l = theoremLook(prof, env, map.get(env)!, undefined);
    return `${l.box ? "box" : "head"} ${l.role} ${l.body || "-"} ${l.icon ?? "-"} ${l.mark ?? "-"}`;
  };
  assert.deepEqual(
    ["definition", "theorem*", "proposition", "note", "exercise", "proof", "example", "remark"].map((e) => eb(e)),
    ["box main kai - ♣", "box second kai - ♡", "box third kai - ♠", "head second kai ☡ -", "head main - ✍\uFE0E -", "head second fs - -", "head main - - -", "head second - - -"],
  );
  const simple = String.raw`\documentclass[lang=en,simple]{elegantbook}`;
  assert.equal(eb("theorem", theoremMap([simple]), profileOf(simple, [simple])), "head second it - -");
});

test("elegantbook's boxes and heads, chapter labels, run-in paragraphs, list labels and colours as the page shows them", async () => {
  const body = [
    String.raw`\chapter{概率}`,
    String.raw`\section{定义}`,
    String.raw`\begin{definition}{概率空间}{ps}`,
    String.raw`三元组。`,
    String.raw`\end{definition}`,
    String.raw`\begin{theorem}[全期望]\label{thm:te}`,
    String.raw`若可积，则成立。`,
    String.raw`\end{theorem}`,
    String.raw`\begin{note}`,
    String.raw`笔记内容。`,
    String.raw`\end{note}`,
    String.raw`\begin{proof}`,
    String.raw`显然。`,
    String.raw`\end{proof}`,
    String.raw`\begin{example}[抛硬币]`,
    String.raw`例子。`,
    String.raw`\end{example}`,
    String.raw`\begin{itemize}\item 一\end{itemize}`,
    String.raw`\begin{enumerate}\item 二\end{enumerate}`,
    String.raw`\appendix`,
    String.raw`\chapter{记号}`,
    String.raw`\paragraph{注意}这里。`,
    String.raw`\textcolor{blue!70!black}{蓝}\textcolor{second}{橙}\textcolor{nosuch}{无}`,
  ].join("\n");
  // Lines 4.. of main.tex.
  const llx = [
    "llxinfo{fontsize}{10}",
    "llxname{definition}{定义}",
    "llxname{theorem}{定理}",
    "llxname{note}{笔记}",
    "llxname{proof}{证明}",
    "llxname{example}{例题}",
    "llxname{appendix}{附录}",
    "llxcolor{structurecolor}{rgb}{0.23529,0.44315,0.71765}",
    "llxcolor{main}{rgb}{0,0.65099,0.32158}",
    "llxcolor{second}{rgb}{1,0.5255,0.09413}",
    "llxcolor{third}{rgb}{0,0.68234,0.96863}",
    "llxcolor{blue}{rgb}{0,0,1}",
    "llxcolor{black}{rgb}{0,0,0}",
    String.raw`llxtoc{chapter}{\numberline {第一章}概率}{}{main.tex}{4}`,
    String.raw`llxtoc{section}{\numberline {1.1}定义}{}{main.tex}{5}`,
    "llxstep{tcb@cnt@definition}{1.1}{}{main.tex}{6}",
    "llxstep{tcb@cnt@definition}{1.1}{}{main.tex}{6}",
    "llxstep{tcb@cnt@theorem}{1.1}{}{main.tex}{9}",
    "llxstep{exam}{1.1}{}{main.tex}{18}",
    String.raw`llxstep{enumi}{{\protect \color  {structurecolor}1.}}{}{main.tex}{22}`,
    String.raw`llxtoc{chapter}{\numberline {A}记号}{}{main.tex}{24}`,
    String.raw`llxtoc{paragraph}{注意}{}{main.tex}{25}`,
  ].join("\n");
  const out = await emitDoc({ documentclass: "[lang=cn]elegantbook", preamble: "", body, llx });
  const html = out.body;
  assert.match(html, /^<h2 class="llx-chapter" id="llx-h1"><span class="llx-num">第一章<\/span>概率<\/h2><h3 class="llx-section" id="llx-h2"><span class="llx-num">1\.1<\/span>定义<\/h3>/);
  const blocks = html.split(/(?=<div class="llx-(?:box|thm|proof)[ "])|(?=<ul)|(?=<ol)|(?=<h2)/).slice(1);
  assert.deepEqual(blocks.slice(0, 5), [
    '<div class="llx-box llx-thm llx-definition is-main" id="def:ps"><div class="llx-box-title">定义 1.1 (概率空间)</div><div class="llx-box-body llx-kai"><p>三元组。</p></div><span class="llx-box-mark" aria-hidden="true">♣</span></div>',
    '<div class="llx-box llx-thm llx-theorem is-second" id="thm:te"><div class="llx-box-title">定理 1.1 (全期望)</div><div class="llx-box-body llx-kai"><p>若可积，则成立。</p></div><span class="llx-box-mark" aria-hidden="true">♡</span></div>',
    '<div class="llx-thm llx-note is-second llx-kai"><span class="llx-thm-icon" aria-hidden="true">☡</span><p class="llx-cont"><span class="llx-thm-head">笔记</span> 笔记内容。</p></div>',
    '<div class="llx-proof is-second llx-fs"><p class="llx-cont"><span class="llx-thm-head">证明</span> 显然。</p></div>',
    '<div class="llx-thm llx-example is-main"><p class="llx-cont"><span class="llx-thm-head">例题 1.1 抛硬币</span> 例子。</p></div>',
  ]);
  assert.match(html, /<li><span class="llx-label"><span class="llx-bullet" style="color:var\(--llx-c-structurecolor\)">●<\/span><\/span><p>一<\/p><\/li>/);
  assert.match(html, /<li><span class="llx-label"><span style="color:var\(--llx-c-structurecolor\)">1\.<\/span><\/span><p>二<\/p><\/li>/);
  // After \appendix a chapter prints `附录 A`; its contents entry keeps the .toc's `A`.
  assert.match(html, /<h2 class="llx-chapter" id="llx-h3"><span class="llx-num">附录 A<\/span>记号<\/h2>/);
  assert.deepEqual(out.headings.map((h) => `${h.number}|${h.title}`), ["第一章|概率", "1.1|定义", "A|记号", "null|注意"]);
  // \paragraph runs into its paragraph.
  assert.match(html, /<p class="llx-cont"><b class="llx-runin llx-paragraph" id="llx-h4">注意<\/b> 这里。/);
  // Colours: variables the page defines (an expression mixed from the probe's names), an unknown one plain.
  assert.match(html, /<span style="color:var\(--llx-c-blue-70-black\)">蓝<\/span><span style="color:var\(--llx-c-second\)">橙<\/span>无/);
  assert.deepEqual(out.colors.get("blue!70!black"), [0, 0, 179]);
  assert.deepEqual(out.report.items.map((i) => i.message), ["colour nosuch: not defined for the export (shown in the text colour)"]);
  // The page: its variables light and dark, the tab fills darkened for white text.
  const css = pageCss(out.profile, out.colors);
  assert.match(css, /--llx-c-blue-70-black: rgb\(0, 0, 179\);/);
  const dark = css.slice(css.lastIndexOf("@media (prefers-color-scheme: dark)"));
  for (const m of dark.matchAll(/--llx-c-[\w-]+: rgb\((\d+), (\d+), (\d+)\)/g)) assert.ok(contrast([+m[1], +m[2], +m[3]], SURFACE) >= 4.5, m[0]);
  for (const m of dark.matchAll(/--llx-f-[\w-]+: rgb\((\d+), (\d+), (\d+)\)/g)) assert.ok(contrast(WHITE, [+m[1], +m[2], +m[3]]) >= 4.5, m[0]);
});

test("amsthm's styles and LaTeX's \\newtheorem from the census; the compact title blocks", async () => {
  const preamble = String.raw`\usepackage{amsthm}\theoremstyle{definition}\newtheorem{definition}{Definition}[section]\theoremstyle{plain}\newtheorem{theorem}[definition]{Theorem}\theoremstyle{remark}\newtheorem*{remark}{Remark}\title{T}\author{A \and B}\date{D}`;
  const body = [
    String.raw`\maketitle`,
    String.raw`\section{Intro}`,
    String.raw`\begin{definition}[Linear]`,
    String.raw`A def.`,
    String.raw`\end{definition}`,
    String.raw`\begin{theorem}`,
    String.raw`A thm.`,
    String.raw`\end{theorem}`,
    String.raw`\begin{remark}`,
    String.raw`A remark.`,
    String.raw`\end{remark}`,
    String.raw`\begin{proof}[Proof of it]`,
    String.raw`Done.`,
    String.raw`\end{proof}`,
    String.raw`\begin{conj}[Open]`,
    String.raw`Maybe.`,
    String.raw`\end{conj}`,
  ].join("\n");
  const llx = [
    "llxinfo{fontsize}{10}",
    String.raw`llxenv{definition}{macro:->\@thm {\let \thm@swap \@gobble \th@definition }{definition}{Definition}}`,
    String.raw`llxenv{theorem}{macro:->\@thm {\let \thm@swap \@gobble \th@plain }{definition}{Theorem}}`,
    String.raw`llxenv{remark}{macro:->\@thm {\th@remark }{}{Remark}}`,
    String.raw`llxenv{conj}{macro:->\@thm {conj}{Conjecture}}`,
    String.raw`llxtoc{section}{\numberline {1}Intro}{}{main.tex}{5}`,
    "llxstep{definition}{1.1}{}{main.tex}{6}",
    "llxstep{definition}{1.2}{}{main.tex}{9}",
    "llxstep{conj}{1}{}{main.tex}{18}",
  ].join("\n");
  const out = await emitDoc({ preamble, body, llx });
  const blocks = out.body.split(/(?=<div class="llx-(?:thm|proof)[ "])/).slice(1);
  assert.deepEqual(blocks, [
    '<div class="llx-thm llx-definition"><p class="llx-cont"><span class="llx-thm-head">Definition 1.1 <span class="llx-thm-note">(Linear)</span>.</span> A def.</p></div>',
    '<div class="llx-thm llx-theorem llx-it"><p class="llx-cont"><span class="llx-thm-head">Theorem 1.2.</span> A thm.</p></div>',
    '<div class="llx-thm llx-remark is-head-it"><p class="llx-cont"><span class="llx-thm-head">Remark.</span> A remark.</p></div>',
    '<div class="llx-proof is-head-it"><p class="llx-cont"><span class="llx-thm-head">Proof of it.</span> Done.<span class="llx-qed">□</span></p></div>',
    // A \newtheorem the sources do not show (a class's): the census makes it a theorem, not a TeX fragment.
    '<div class="llx-thm llx-conj llx-it"><p class="llx-cont"><span class="llx-thm-head">Conjecture 1 (Open)</span> Maybe.</p></div>',
  ]);
  assert.deepEqual(out.numbers.map((n) => `${n.counter} ${n.value}`), ["definition 1.1", "definition 1.2", "conj 1"]);
  assert.deepEqual(out.report.items.map((i) => [i.severity, i.kind, i.line]), [["info", "unknown-env", 18]]);
  // The title blocks: centred lines for the standard classes, elegantbook's labelled rows.
  assert.equal(titleHtml(out.profile, out.header!, (k) => k), '<header class="llx-title"><h1>T</h1><p>A, B</p><p>D</p></header>\n');
  const eb = profileOf(String.raw`\documentclass[lang=cn]{elegantbook}`, []);
  const t = { title: "书", subtitle: "副", author: "作者甲", institute: "", date: "2026", version: "0.1", extrainfo: "说明" };
  assert.equal(
    titleHtml(eb, t, (k) => fallbackName(eb, k)),
    '<header class="llx-title"><h1>书</h1><p class="llx-subtitle">副</p><dl class="llx-title-meta"><div><dt>作者：</dt><dd>作者甲</dd></div><div><dt>时间：</dt><dd>2026</dd></div><div><dt>版本：</dt><dd>0.1</dd></div></dl><p class="llx-extrainfo">说明</p></header>\n',
  );
  // The page: the contents' top level bold, a footnote's back link in its last paragraph.
  const page = renderPage({
    lang: "en",
    title: "T",
    css: "",
    header: "",
    toc: { title: "Contents", entries: [{ level: 1, number: "1", title: "Intro", id: "a" }, { level: 2, number: "1.1", title: "Sub", id: "b" }] },
    body: "<!--llx:toc-->",
    footnotes: [{ id: "f1", ref: "r1", mark: "1", html: "<p>Note.</p>" }],
    mathCss: "",
  });
  assert.match(page, /<li class="llx-toc-1 llx-toc-top"><a href="#a"><span class="llx-num">1<\/span>Intro<\/a><\/li><li class="llx-toc-2"><a href="#b">/);
  assert.match(page, /<li id="f1"><span class="llx-label">1<\/span><p>Note\. <a href="#r1">↩<\/a><\/p><\/li>/);
});
