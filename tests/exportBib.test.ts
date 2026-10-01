// The HTML export's bibliography and citations (src/export/bibliography.ts and the emitter's
// citations, design 3.6, S3): biblatex .bbl entries (CJK authors, lists, verbatim URLs) printed
// as the synthetic book's PDF prints them, numeric-comp's ranges, postnotes, natbib's and LaTeX's
// `\bibcite` labels, footnote marks. The emitter runs on synthetic projects with handwritten
// probe logs and build files (no TeX; tests/exportFidelity.test.ts compares with real builds).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  citeNames,
  formatEntry,
  nameList,
  numericLabels,
  postnoteText,
  readBbl,
  readBibcites,
  type LabelPiece,
} from "../src/export/bibliography";
import { esc } from "../src/export/html";
import { emitDoc, removeExportTemps } from "./support/exportHost";

// A biblatex .bbl excerpt of the kind Biber writes (synthetic entries).
const BBL = String.raw`\refsection{0}
  \datalist[entry]{nty/global//global/global/global}
    \entry{chen}{article}{}{}
      \name{author}{3}{}{%
        {{hash=a1}{%
           family={Chen},
           familyi={C\bibinitperiod},
           given={Lin},
           giveni={L\bibinitperiod}}}%
        {{hash=a2}{%
           family={Example},
           given={Ellen}}}%
        {{hash=a3}{%
           family={Placeholder},
           given={Paul}}}%
      }
      \strng{namehash}{d0de}
      \field{journaltitle}{Transactions on Fictional Optimization}
      \field{title}{Stochastic Gradient Methods: A Made-up Survey}
      \field{volume}{7}
      \field{year}{2018}
      \field{pages}{33\bibrangedash 71}
      \range{pages}{39}
    \endentry
    \entry{li}{article}{}{}
      \name{author}{2}{}{%
        {{hash=b1}{%
           family={Li},
           given={Wei}}}%
        {{hash=b2}{%
           family={Doe},
           given={Jane}}}%
      }
      \field{journaltitle}{Journal of Example Mathematics}
      \field{number}{3}
      \field{title}{A Toy Proof of the $L^2$ Law}
      \field{volume}{12}
      \field{year}{2019}
      \field{pages}{101\bibrangedash 118}
      \verb{doi}
      \verb 10.0000/example.2019.003
      \endverb
    \endentry
    \entry{smith}{inproceedings}{}{}
      \name{author}{4}{}{%
        {{hash=c1}{%
           family={Smith},
           given={Alex}}}%
        {{hash=c2}{%
           family={Roe},
           given={Richard}}}%
        {{hash=c3}{%
           family={M{\"u}ller},
           given={Jan}}}%
        {{hash=c4}{%
           family={Kim},
           given={Sun}}}%
      }
      \field{booktitle}{Proceedings of the Imaginary Conference on Learning}
      \field{title}{Concentration Inequalities Made Synthetic}
      \field{year}{2021}
      \field{pages}{1\bibrangedash 12}
    \endentry
    \entry{web}{online}{}{}
      \name{author}{1}{}{%
        {{hash=d1}{%
           family={Team},
           given={Example}}}%
      }
      \field{title}{An Online Resource That Does Not Exist}
      \field{urlday}{1}
      \field{urlmonth}{9}
      \field{urlyear}{2026}
      \field{year}{2024}
      \verb{url}
      \verb https://example.com/notes
      \endverb
    \endentry
    \entry{zhang}{book}{}{}
      \name{author}{2}{}{%
        {{hash=e1}{%
           family={张三},
           familyi={张\bibinitperiod}}}%
        {{hash=e2}{%
           family={李四},
           familyi={李\bibinitperiod}}}%
      }
      \list{language}{1}{%
        {chinese}%
      }
      \list{location}{1}{%
        {北京}%
      }
      \list{publisher}{1}{%
        {示例出版社}%
      }
      \field{title}{概率论讲义（示例版）}
      \field{year}{2020}
    \endentry
    \entry{wang}{book}{}{}
      \name{author}{1}{}{%
        {{hash=f1}{%
           family={王五}}}%
      }
      \list{publisher}{1}{%
        {虚构大学出版社}%
      }
      \field{edition}{2}
      \field{title}{线性代数与几何：测试用教材}
      \field{year}{2022}
      \true{moreauthor}
    \endentry
  \enddatalist
\endrefsection
\endinput
`;

/** Field TeX as plain text (the emitter renders it as HTML). */
const plain = (tex: string) => esc(tex.replace(/[{}]/g, "").replace(/\\"u/g, "ü"));
const link = (url: string, text: string) => `<a href="${url}">${esc(text)}</a>`;
const textOf = (html: string) => html.replace(/<[^>]+>/g, "");

test("readBbl: entries in data-list order, names with their parts, lists, fields and verbatim fields", () => {
  const entries = readBbl(BBL);
  assert.deepEqual(entries.map((e) => `${e.key}:${e.type}`), ["chen:article", "li:article", "smith:inproceedings", "web:online", "zhang:book", "wang:book"]);
  const [chen, li, , web, zhang, wang] = entries;
  assert.deepEqual(chen.names.get("author")?.[0], { given: "Lin", family: "Chen", prefix: "", suffix: "" });
  assert.equal(chen.fields.get("pages"), "33–71");
  assert.equal(li.fields.get("doi"), "10.0000/example.2019.003");
  assert.equal(web.fields.get("url"), "https://example.com/notes");
  assert.deepEqual(zhang.names.get("author"), [
    { given: "", family: "张三", prefix: "", suffix: "" },
    { given: "", family: "李四", prefix: "", suffix: "" },
  ]);
  assert.deepEqual([zhang.lists.get("location"), zhang.lists.get("publisher"), zhang.lists.get("language")], [["北京"], ["示例出版社"], ["chinese"]]);
  assert.deepEqual([...wang.more], ["author"]);
  assert.deepEqual(readBbl("\\begin{thebibliography}{1}\\bibitem{a} A.\\end{thebibliography}"), []);
});

test("formatEntry: biblatex's standard styles as the synthetic book's PDF prints them", () => {
  const e = new Map(readBbl(BBL).map((x) => [x.key, x]));
  const f = (key: string) => textOf(formatEntry(e.get(key)!, plain, link));
  // The book's PDF (gs txtwrite of its bibliography), entry by entry.
  assert.equal(f("chen"), "Lin Chen, Ellen Example, and Paul Placeholder. “Stochastic Gradient Methods: A Made-up Survey”. In: Transactions on Fictional Optimization 7 (2018), pp. 33–71.");
  assert.equal(f("li"), "Wei Li and Jane Doe. “A Toy Proof of the $L^2$ Law”. In: Journal of Example Mathematics 12.3 (2019), pp. 101–118. DOI: 10.0000/example.2019.003.");
  assert.equal(f("smith"), "Alex Smith et al. “Concentration Inequalities Made Synthetic”. In: Proceedings of the Imaginary Conference on Learning. 2021, pp. 1–12.");
  assert.equal(f("web"), "Example Team. An Online Resource That Does Not Exist. 2024. URL: https://example.com/notes (visited on 09/01/2026).");
  assert.equal(f("zhang"), "张三 and 李四. 概率论讲义（示例版）. chinese. 北京: 示例出版社, 2020.");
  assert.equal(f("wang"), "王五 et al. 线性代数与几何：测试用教材. 2nd ed. 虚构大学出版社, 2022.");
  // Journal and book titles italic, article titles quoted, DOI and URL linked.
  const html = formatEntry(e.get("li")!, plain, link);
  assert.match(html, /“A Toy Proof of the \$L\^2\$ Law”\. In: <i>Journal of Example Mathematics<\/i> 12\.3/);
  assert.match(html, /DOI: <a href="https:\/\/doi\.org\/10\.0000\/example\.2019\.003">/);
  assert.match(formatEntry(e.get("zhang")!, plain, link), /<i>概率论讲义（示例版）<\/i>/);
  // Citation names: family names (`\textcite`), accents through the renderer.
  assert.equal(citeNames(e.get("li")!, plain), "Li and Doe");
  assert.equal(citeNames(e.get("zhang")!, plain), "张三 and 李四");
  assert.equal(citeNames(e.get("smith")!, plain), "Smith et al.");
  const three = e.get("smith")!.names.get("author")!.slice(0, 3);
  assert.equal(nameList(three, false, (n) => plain(n.family)), "Smith, Roe, and Müller");
});

test("numeric labels: numeric-comp's ranges of three or more, pairs as they are, prefixes, one per key", () => {
  const n = (...xs: (number | string)[]) => xs.map((x) => (typeof x === "number" ? { key: `k${x}`, prefix: "", number: String(x) } : { key: x, prefix: x[0], number: x.slice(1) }));
  const text = (p: LabelPiece[]) => p.map((x) => ("sep" in x ? x.sep : x.text)).join("");
  const comp = { sort: true, compress: true };
  assert.equal(text(numericLabels(n(5, 1, 3, 2), comp)), "1–3, 5");
  assert.equal(text(numericLabels(n(3, 2), comp)), "2, 3");
  assert.equal(text(numericLabels(n(3, 2), { sort: false, compress: false })), "3, 2");
  assert.equal(text(numericLabels(n(1, 2, 3), { sort: false, compress: false })), "1, 2, 3");
  assert.equal(text(numericLabels(n("A1", "A2", "A3", "B4"), comp)), "A1–A3, B4");
  assert.equal(text(numericLabels([...n(2), ...n(2), ...n(1)], comp)), "1, 2");
  // Range ends keep their keys (links).
  assert.deepEqual(numericLabels(n(1, 2, 3), comp).filter((p) => "key" in p).map((p) => (p as { key: string }).key), ["k1", "k3"]);
  assert.equal(postnoteText("12"), "p. 12");
  assert.equal(postnoteText("12--15"), "pp. 12–15");
  assert.equal(postnoteText("xii"), "p. xii");
  assert.equal(postnoteText("第 2 章"), "第 2 章");
  assert.equal(postnoteText("Sec.~3"), "Sec.~3");
});

test("readBibcites: natbib's four fields, LaTeX's label", () => {
  const cites = readBibcites([
    String.raw`\bibcite{doe}{{1}{2023}{{Doe and Example}}{{}}}
\bibcite{knuth}{Knu84}
\bibcite{two}{2}`,
  ]);
  assert.deepEqual(cites.get("doe"), { label: "1", year: "2023", authors: "Doe and Example", full: "" });
  assert.deepEqual(cites.get("knuth"), { label: "Knu84", year: "", authors: "", full: "" });
  assert.equal(cites.get("two")?.label, "2");
});

// ---- the emitter on synthetic projects ---------------------------------------------------------

after(removeExportTemps);


/** The citations' texts, in order. */
const cites = (html: string) => [...html.matchAll(/<span class="llx-cite[^"]*">([\s\S]*?)<\/span>(?!<\/a>)/g)].map((m) => textOf(m[1]).replace(/&amp;/g, "&"));

test("biblatex: numeric-comp labels from the probe, pre- and postnotes, \\textcite, the printed entries, footnote marks", async () => {
  // Lines 4.. of main.tex (the body starts on line 4).
  const body = String.raw`Text \cite[第 2 章]{zhang} and \cite{li,smith} and \cite{chen,li,smith,wang}.
\textcite{li} shows it; \cite[see][12]{wang}; \parencite[12--15]{zhang}; \cite{web}.
Note\footnote[7]{Seven.} and a mark\footnotemark{} here.\footnotetext{Later.}
\printbibliography[title=参考文献]`;
  const llx = [
    "llxinfo{citestyle}{numeric-comp}",
    "llxinfo{sortcites}{1}",
    ...["chen:1", "li:2", "smith:3", "web:4", "zhang:5", "wang:6"].map((x) => `llxcite{${x.split(":")[0]}}{${x.split(":")[1]}}{}`),
    "llxstep{footnote}{1}{}{main.tex}{6}",
    ...["chen", "li", "smith", "web", "zhang", "wang"].map((k) => `llxstep{llx@bib}{${k}}{}{main.tex}{7}`),
  ].join("\n");
  const out = await emitDoc({ preamble: "\\usepackage{biblatex}", body, llx, bbl: BBL });
  assert.deepEqual(cites(out.body), ["[5, 第 2 章]", "[2, 3]", "[1–3, 6]", "Li and Doe [2]", "[see 6, p. 12]", "[5, pp. 12–15]", "[4]"]);
  assert.match(out.body, /\[<a class="llx-cite-link" href="#llx-bib-zhang">5<\/a>, 第 2 章\]/);
  // The bibliography: the entries the probe saw printed, with their numbers and anchors.
  const items = [...out.body.matchAll(/<li id="llx-bib-(\w+)"><span class="llx-label">\[(\d+)\]<\/span>/g)].map((m) => `${m[1]}:${m[2]}`);
  assert.deepEqual(items, ["chen:1", "li:2", "smith:3", "web:4", "zhang:5", "wang:6"]);
  assert.match(out.body, /<h2 class="llx-section" id="[^"]*">参考文献<\/h2>/);
  // Footnotes: `[7]` given (no step), \footnotemark's step, \footnotetext's text under that mark.
  assert.deepEqual(out.footnotes.map((f) => [f.mark, textOf(f.html)]), [["7", "Seven."], ["1", "Later."]]);
  assert.deepEqual(out.numbers, [{ counter: "footnote", value: "1", shown: true }]);
  assert.deepEqual(out.report.items.filter((i) => i.severity !== "info"), []);
});

test("natbib (numbers, sort&compress) and BibTeX's thebibliography: \\bibcite labels", async () => {
  const aux = String.raw`\bibcite{doe}{{1}{2023}{{Doe and Example}}{{}}}
\bibcite{lee}{{2}{2024}{{Lee}}{{}}}
\bibcite{roe}{{3}{2022}{{Roe and Placeholder}}{{Roe, Placeholder, and Other}}}`;
  const bbl = String.raw`\begin{thebibliography}{3}
\providecommand{\natexlab}[1]{#1}
\bibitem[Doe and Example(2023)]{doe}
Jane Doe and Ellen Example.
\newblock Masked reconstruction in a toy linear model.
\newblock \emph{Journal of Synthetic Learning}, 4:\penalty0 1--20, 2023.
\bibitem[Lee(2024{\natexlab{a}})]{lee}
Sam Lee.
\newblock A note that does not exist, 2024{\natexlab{a}}.
\bibitem[Roe et~al.(2022)]{roe}
Richard Roe and Paul Placeholder.
\newblock Two views.
\end{thebibliography}
`;
  const body = String.raw`\citep{doe} \citep[Sec.~3]{doe}; \Citet{roe} \citep{roe,lee}; \citet*{roe}; \citealp{roe,doe,lee}; \citeauthor{doe}.
\bibliography{refs}`;
  const numbers = ["llxinfo{natbib}{numbers,sort,compress}", "llxinfo{natbib-open}{[}", "llxinfo{natbib-close}{]}", "llxinfo{natbib-sep}{,}", "llxinfo{natbib-aysep}{,}", "llxinfo{natbib-cmt}{, }"].join("\n");
  const out = await emitDoc({ preamble: "\\usepackage[numbers,sort&compress]{natbib}", body, llx: numbers, aux, bbl });
  // `~` is a no-break space.
  assert.deepEqual(cites(out.body), ["[1]", "[1, Sec.\u00a03]", "Roe and Placeholder [3]", "[2, 3]", "Roe, Placeholder, and Other [3]", "1–3", "Doe and Example"]);
  const items = [...out.body.matchAll(/<li id="llx-bib-(\w+)"><span class="llx-label">\[(\d+)\]<\/span>([\s\S]*?)<\/li>/g)].map((m) => [m[1], m[2], textOf(m[3]).replace(/\s+/g, " ").trim()]);
  assert.deepEqual(items, [
    ["doe", "1", "Jane Doe and Ellen Example. Masked reconstruction in a toy linear model. Journal of Synthetic Learning, 4:1–20, 2023."],
    ["lee", "2", "Sam Lee. A note that does not exist, 2024a."],
    ["roe", "3", "Richard Roe and Paul Placeholder. Two views."],
  ]);
  assert.match(out.body, /Journal of Synthetic Learning<\/em>, 4:1–20, 2023\./);
  assert.match(out.body, /<h2 class="llx-section" id="[^"]*">References<\/h2>/);
  // Author-year: `(Doe and Example, 2023; Lee, 2024)`, `Roe and Placeholder (2022)`, no labels.
  const ay = ["llxinfo{natbib}{authoryear}", "llxinfo{natbib-open}{(}", "llxinfo{natbib-close}{)}", "llxinfo{natbib-sep}{;}", "llxinfo{natbib-aysep}{,}", "llxinfo{natbib-cmt}{, }"].join("\n");
  const out2 = await emitDoc({ preamble: "\\usepackage{natbib}", body: String.raw`\citep{doe,lee} and \citet[p.~2]{roe}.` + "\n\\bibliography{refs}", llx: ay, aux, bbl });
  assert.deepEqual(cites(out2.body), ["(Doe and Example, 2023; Lee, 2024)", "Roe and Placeholder (2022, p.\u00a02)"]);
  assert.match(out2.body, /<ol class="llx-list llx-bib llx-bib-ay"><li id="llx-bib-doe"><p>Jane Doe/);
  // LaTeX without natbib: the \bibcite label as it is.
  const out3 = await emitDoc({ preamble: "", body: String.raw`\cite[p.~5]{knuth,doe}`, llx: "llxinfo{fontsize}{10}", aux: String.raw`\bibcite{knuth}{Knu84}\bibcite{doe}{1}` });
  assert.deepEqual(cites(out3.body), ["[Knu84, 1, p.\u00a05]"]);
  // Links without a bibliography on the page are plain text (report item).
  assert.doesNotMatch(out3.body, /llx-cite-link/);
  assert.ok(out3.report.items.some((i) => i.kind === "cite" && /no bibliography entry/.test(i.message)));
});

test("other biblatex styles fall back to live preview's labels, with a report item", async () => {
  const bib = "@article{li, author = {Li, Wei and Doe, Jane}, title = {T}, year = {2019}}";
  const out = await emitDoc({ preamble: "", body: String.raw`\cite[p.~3]{li}`, llx: "llxinfo{citestyle}{authoryear}\nllxcite{li}{}{}", bib });
  assert.deepEqual(cites(out.body), ["[Li and Doe 2019, p. 3]"]);
  assert.ok(out.report.items.some((i) => i.kind === "cite" && /authoryear/.test(i.message)));
});
