import assert from "node:assert/strict";
import { after, test } from "node:test";
import { JSDOM } from "jsdom";
import { fallbackName, titleHtml } from "../src/export/profiles";
import { readProbeLog, StepQueue } from "../src/export/probeLog";
import { emitDoc, removeExportTemps } from "./support/exportHost";

after(removeExportTemps);
const page = (out: Awaited<ReturnType<typeof emitDoc>>) => new JSDOM((out.header ? titleHtml(out.profile, out.header, key => fallbackName(out.profile, key)) : "") + out.body);

test("frontmatter TOC consumption keeps a numbered section also named Abstract", () => {
  const log = readProbeLog([
    "llxtoc{section}{Abstract}{}{main.tex}{12}",
    "llxtoc{title}{Paper title}{}{main.tex}{20}",
    "llxtoc{author}{Ada Author}{}{main.tex}{20}",
    String.raw`llxtoc{section}{\numberline {1}Abstract}{}{main.tex}{21}`,
  ].join("\n"));
  const queue = new StepQueue(log, [{ key: "main.tex", occ: 0 }]);
  queue.takeFrontmatterToc({ visit: 0, from: 20, to: 20 }, true, "Abstract");
  const section = queue.take("toc", { visit: 0, from: 21, to: 21 });
  assert.equal(section?.value, String.raw`\numberline {1}Abstract`);
  assert.deepEqual(queue.orphans, []);
});

test("paper body front matter renders all authors, affiliations, contacts and abstract without leaking declarations into paragraphs", async () => {
  const out = await emitDoc({
    documentclass: "[reprint,aps]revtex4-2", preamble: "",
    body: String.raw`\title{Body-declared physics title}
\author{Ada Audit}
\affiliation{Department Alpha}
\email{ada@example.org}
\author{Ben Check}
\affiliation{Department Beta}
\email{ben@example.org}
\begin{abstract}
An abstract with $x+1$ and selectable text.
\end{abstract}
\maketitle
\section{Results}
Body text.`,
    llx: "llxtoc{abstract}{Abstract}{}{main.tex}{11}\nllxtoc{title}{Body-declared physics title}{}{main.tex}{14}\nllxtoc{section}{Results}{}{main.tex}{15}",
  });
  const doc = page(out).window.document;
  assert.equal(out.title, "Body-declared physics title");
  assert.equal(doc.querySelector("h1")!.textContent, out.title);
  assert.deepEqual(out.header!.paper!.authors.map(a => a.name), ["Ada Audit", "Ben Check"]);
  assert.deepEqual(out.header!.paper!.affiliations.map(a => a.html), ["Department Alpha", "Department Beta"]);
  assert.equal(doc.querySelectorAll('.llx-paper-author sup a[href^="#llx-aff-"]').length, 2);
  assert.equal(doc.querySelectorAll('a[href^="mailto:"]').length, 2);
  assert.equal(doc.querySelector(".llx-abstract mjx-container") !== null, true);
  assert.match(doc.querySelector(".llx-abstract")!.textContent!, /selectable text/);
  assert.doesNotMatch(out.body, /Ada Audit|Department Alpha|ada@example/);
  assert.equal(out.header!.date, "");
  assert.deepEqual(out.report.items, []);
});

test("Springer source name wrappers, starred author relationships and rich keywords retain their content", async () => {
  const out = await emitDoc({
    documentclass: "[pdflatex]sn-jnl", preamble: "",
    body: String.raw`\title[Short]{Biology title}
\author*[1]{\fnm{Ada} \sur{Audit}}\email{ada@example.org}
\author[1,2]{\fnm{Ben} \sur{Check}}
\affil[1]{\orgdiv{Molecular Unit}, \orgname{Institute Alpha}, \orgaddress{\city{Example City}, \country{Example Country}}}
\affil[2]{\orgname{Institute Beta}}
\abstract{A molecular abstract with \textbf{visible emphasis}.}
\keywords{biology; \textit{replication}}
\maketitle
\section*{Results}Body.`, llx: "llxinfo{title-date}{September 30, 2026}",
  });
  const doc = page(out).window.document;
  assert.equal(doc.querySelector("h1")!.textContent, "Biology title");
  assert.deepEqual(out.header!.paper!.authors.map(a => a.affiliations.map(r => r.label)), [["1"], ["1", "2"]]);
  assert.equal(out.header!.paper!.authors[0].corresponding, true);
  assert.match(doc.querySelector(".llx-paper-affiliation")!.textContent!, /Molecular Unit, Institute Alpha, Example City, Example Country/);
  assert.equal(doc.querySelector(".llx-abstract b")!.textContent, "visible emphasis");
  assert.equal(doc.querySelector(".llx-paper-keywords i")!.textContent, "replication");
  assert.equal(out.header!.date, "", "kernel date is not a Springer title field");
  assert.doesNotMatch(doc.body.textContent!, /\*\[1\]|September 30/);
  assert.deepEqual(out.report.items, []);
});

test("AMS source addresses, current address, thanks and classification schema survive the paper header", async () => {
  const out = await emitDoc({ documentclass: "amsart", preamble: "", body: String.raw`\title{Mathematics title}
\author[A. Audit]{Ada Audit}
\address{Institute Alpha}
\curraddr{Current Institute}
\email{ada@example.org}
\thanks{First named grant.}
\author[B. Check]{Ben Check}\address{Institute Beta}\thanks{Second named grant.}
\subjclass[2020]{Primary 68T07; Secondary 60B20}
\keywords{concentration; kernels}
\dedicatory{Dedicated to reproducible research.}
\begin{abstract}A bounded mathematical abstract.\end{abstract}
\maketitle
\section*{Results}Body.`, llx: "" });
  const doc = page(out).window.document;
  for (const expected of ["Ada Audit", "Ben Check", "Current Institute", "First named grant.", "Second named grant.", "Primary 68T07", "kernels", "Dedicated to reproducible research."]) assert.ok(doc.body.textContent!.includes(expected), expected);
  assert.match(doc.querySelector(".llx-paper-subject")!.textContent!, /2020 Mathematics Subject Classification/);
  assert.equal(out.header!.paper!.authors.flatMap(a => a.affiliations).some(ref => /Audit|Check/.test(ref.label)), false, "short names are not institution numbers");
  assert.deepEqual(out.report.items, []);
});

test("AASTeX first section produces the implicit title after collecting abstract and keywords", async () => {
  const out = await emitDoc({ documentclass: "aastex701", preamble: "", body: String.raw`\shorttitle{Running title}\shortauthors{Audit et al.}
\title{Astronomy title}
\author[0000-0000-0000-0001]{Ada Audit}\affiliation{Observatory Alpha}
\author{Ben Check}\affiliation{Observatory Beta}
\begin{abstract}An astronomical abstract.\end{abstract}
\keywords{stars; dynamics}
\section*{Observations}
Body.`, llx: "" });
  const doc = page(out).window.document;
  assert.equal(doc.querySelector("h1")!.textContent, "Astronomy title");
  assert.equal(doc.querySelectorAll(".llx-paper-author").length, 2);
  assert.match(doc.querySelector(".llx-paper-contact")!.textContent!, /ORCID.*0000-0000-0000-0001/);
  assert.equal(doc.querySelector(".llx-abstract p")!.textContent, "An astronomical abstract.");
  assert.match(doc.querySelector(".llx-paper-keywords")!.textContent!, /stars; dynamics/);
  assert.equal(doc.querySelector("h2:not(.llx-abstract h2)")!.textContent, "Observations");
  assert.deepEqual(out.report.items, []);
});

test("the native ACM anonymous flag suppresses author identities and anonymous-only environment contents", async () => {
  const source = {
    documentclass: "[sigconf,anonymous]acmart",
    preamble: String.raw`\title{Anonymous computing title}
\author{PRIVATE_AUTHOR}\affiliation{PRIVATE_INSTITUTE}\email{private@example.org}\orcid{PRIVATE_ORCID}\authornote{PRIVATE_NOTE}
\begin{abstract}A public abstract.\end{abstract}\keywords{public keyword}`,
    body: String.raw`\maketitle
\section*{Public results}Public body.
\begin{acks}
PRIVATE_ACKNOWLEDGMENTS
\end{acks}
\begin{anonsuppress}
PRIVATE_SUPPRESSED_CONTENT
\end{anonsuppress}`,
    llx: "llxinfo{title-anonymous}{true}",
  };
  const out = await emitDoc(source);
  const doc = page(out).window.document;
  assert.equal(doc.querySelector("h1")!.textContent, "Anonymous computing title");
  assert.match(doc.body.textContent!, /public abstract/);
  assert.doesNotMatch(doc.body.textContent!, /PRIVATE_|private@example/);
  assert.deepEqual(out.header!.paper!.authors, []);
  assert.deepEqual(out.header!.paper!.affiliations, []);
  assert.deepEqual(out.report.items, []);
});
