import assert from "node:assert/strict";
import { test } from "node:test";
import { collectFrontmatter, type FrontmatterPart } from "../src/export/frontmatter";
import type { ExportPlan, PlanFile } from "../src/export/plan";
import { projectSignatures } from "../src/export/signatures";
import { parseTex, type TexNode } from "../src/export/texTree";
import { emptyDefinitions } from "../src/tex/macros";

// Explicit parser contracts make these source-relationship tests independent of a class census.
const metadata = new Map([
  ["author", "s o m"], ["affil", "s o m"], ["affiliation", "o m"], ["email", "o m"],
  ["address", "o m"], ["curraddr", "o m"], ["subjclass", "o m"], ["ccsdesc", "o m"],
  ...["abstract", "keywords", "subject", "dedicatory", "dedication", "equalcont", "authornote", "orcid", "correspondingauthor", "fnm", "sur", "spfx", "sfx", "orgdiv", "orgname", "orgaddress", "street", "city", "postcode", "state", "country", "inst", "IEEEauthorblockN", "IEEEauthorblockA"].map(name => [name, "m"]),
  ["and", ""],
  ["shorttitle", "m"], ["shortauthors", "m"],
  ["orcidID", "m"], ["titlerunning", "m"], ["authorrunning", "m"],
] as [string, string][]);

function fixture(cls: string, preamble: string, body: string, inputs: Record<string, string> = {}): ExportPlan {
  const base = projectSignatures(emptyDefinitions(), [], new Map());
  const sig = { ...base, macros: new Map([...base.macros, ...metadata]) };
  const source = `\\documentclass{${cls}}\n${preamble}\n\\begin{document}\n${body}\n\\end{document}`;
  const files = new Map<string, PlanFile>();
  for (const [key, src] of Object.entries({ "main.tex": source, ...inputs })) files.set(key, { key, abs: `/virtual/${key}`, src, nodes: parseTex(src, sig), lines: [0] });
  return {
    root: "/virtual/main.tex", rootDir: "/virtual", rootKey: "main.tex", job: "main", sig, files,
    visits: [{ key: "main.tex", occ: 0, parent: -1, parentLine: 0, inputDirs: ["/virtual"], bodyOnly: true }],
    inputTargets: new Map(), inputKeys: new Map(), sourceAliases: new Map(), fragments: [], copies: new Map(), environmentExpansions: new Map(),
    probe: { names: [], colors: [], envs: [] }, includeOnly: null, missing: new Map(),
  };
}

function nodesText(nodes: readonly TexNode[]): string {
  return nodes.map(node => node.t === "text" ? node.s : node.t === "space" || node.t === "par" ? " " : node.t === "group" || node.t === "env" ? nodesText(node.body) : node.t === "macro" ? node.args.map(arg => arg.body ? nodesText(arg.body) : "").join("") : "").join("").replace(/\s+/g, " ").trim();
}
const text = (part: FrontmatterPart | undefined) => part ? nodesText(part.nodes) : "";
const bodyNodes = (plan: ExportPlan) => {
  const node = plan.files.get(plan.rootKey)!.nodes.find(n => n.t === "env" && n.name === "document");
  return node?.t === "env" ? node.body : [];
};

test("Springer declarations after begin document preserve author IDs, correspondence, abstract and notes", () => {
  const plan = fixture("sn-jnl", "", String.raw`
\title[Short]{First title\thanks{Obsolete support}}
\title{Cell growth\thanks{Title support}}
\author*[1,2]{\fnm{Ada} \sur{Botanist}}\email{ada@example.invalid}
\author[2]{\fnm{Ben} \sur{Biologist}}\email{ben@example.invalid}
\equalcont{Equal contribution}
\affil*[1]{\orgdiv{Biology}, \orgname{Synthetic University}}
\affil[2]{\orgdiv{Ecology}, \orgname{Synthetic Institute}}
\abstract{A synthetic abstract with $N(t)$.}
\keywords{cells, growth}
\maketitle
\author{Unrelated body declaration}
`);
  const front = collectFrontmatter(plan);
  assert.equal(front.className, "sn-jnl");
  assert.equal(front.paper, true);
  assert.equal(text(front.title), "Cell growth");
  assert.deepEqual(front.authors.map(author => text(author.name)), ["Ada Botanist", "Ben Biologist"]);
  assert.deepEqual(front.authors.map(author => author.affiliationIds), [["1", "2"], ["2"]]);
  assert.equal(front.authors[0].corresponding, true);
  assert.equal(front.authors[1].corresponding, undefined);
  assert.deepEqual(front.authors.map(author => author.emails.map(text)), [["ada@example.invalid"], ["ben@example.invalid"]]);
  assert.deepEqual(front.authors[1].notes.map(text), ["Equal contribution"]);
  assert.deepEqual(front.notes.map(text), ["Title support"], "notes from an overwritten title do not survive");
  assert.deepEqual(front.affiliations.map(affiliation => affiliation.id), ["1", "2"]);
  assert.equal(front.abstracts[0].nodes.some(node => node.t === "math"), true, "abstract math is retained as source nodes");
  assert.equal(front.title?.visit, 0);
  assert.equal(front.authors[0].emails[0].visit, 0);
  assert.equal(text(front.keywords[0]), "cells, growth");
  const authors = bodyNodes(plan).filter(node => node.t === "macro" && node.name === "author");
  assert.equal(front.consumed.has(authors[0]), true);
  assert.equal(front.consumed.has(authors[2]), false, "scope ends at maketitle");
  assert.ok(front.maketitle && !front.consumed.has(front.maketitle.node), "maketitle remains the emitter's trigger");
});

test("ACM repeated authors bind affiliation, email, ORCID and author notes to the preceding author", () => {
  const plan = fixture("acmart", String.raw`
\title{A synthetic retrieval study}
\author{Ada}\affiliation{\orgname{First Lab}}\email{ada@example.invalid}\authornote{First note}
\author{Ben}\affiliation{\orgname{Second Lab}}\email{ben@example.invalid}\orcid{0000-0000-0000-0001}
\correspondingauthor{Contact Ben}\ccsdesc[500]{Information systems: retrieval}
`, String.raw`\begin{abstract}Synthetic abstract.\end{abstract}\keywords{retrieval}\maketitle`);
  const front = collectFrontmatter(plan);
  assert.deepEqual(front.authors.map(author => author.affiliationIds), [["1"], ["2"]]);
  assert.deepEqual(front.authors[0].notes.map(text), ["First note"]);
  assert.equal(text(front.authors[1].orcid), "0000-0000-0000-0001");
  assert.equal(front.authors[1].corresponding, true);
  assert.deepEqual(front.authors[1].notes.map(text), ["Contact Ben"]);
  assert.equal(text(front.subjects[0]), "Information systems: retrieval");
  assert.equal(front.subjects[0].kind, "ccsdesc");
  assert.equal(front.subjects[0].qualifier, undefined, "ACM's priority weight is not a printed classification-scheme year");
  assert.equal(front.authors[0].name.visit, undefined, "preamble fields are not guessed to be root drawing visits");
  assert.equal(front.abstracts[0].visit, 0);
});

test("REVTeX shares consecutive affiliations with the current unassigned author group", () => {
  const front = collectFrontmatter(fixture("revtex4-2", String.raw`
\title{Synthetic physics}
\author{Ada}\author{Ben}\affiliation{Shared Lab}\affiliation{Shared Institute}
\author{Carol}\affiliation{Other Lab}\email{carol@example.invalid}
`, String.raw`\maketitle`));
  assert.deepEqual(front.authors.map(author => author.affiliationIds), [["1", "2"], ["1", "2"], ["3"]]);
  assert.deepEqual(front.affiliations.map(affiliation => text(affiliation.content)), ["Shared Lab", "Shared Institute", "Other Lab"]);
  assert.deepEqual(front.authors.map(author => author.emails.map(text)), [[], [], ["carol@example.invalid"]]);
});

test("AASTeX repeated authors keep affiliation relations and their optional ORCID source", () => {
  const plan = fixture("aastex701", String.raw`
\title{Synthetic stellar biology measurements}
\author[0000-0000-0000-0001]{Ada}\affiliation{First Observatory}\email{ada@example.invalid}
\author[0000-0000-0000-0002]{Ben}\affiliation{Second Observatory}
`, String.raw`\maketitle`);
  const front = collectFrontmatter(plan);
  assert.equal(front.paper, true);
  assert.deepEqual(front.authors.map(author => text(author.name)), ["Ada", "Ben"]);
  assert.deepEqual(front.authors.map(author => author.affiliationIds), [["1"], ["2"]]);
  assert.deepEqual(front.authors.map(author => text(author.orcid)), ["0000-0000-0000-0001", "0000-0000-0000-0002"]);
  assert.deepEqual(front.affiliations.map(affiliation => text(affiliation.content)), ["First Observatory", "Second Observatory"]);
  const orcid = front.authors[0].orcid!;
  assert.equal(orcid.file, plan.files.get(plan.rootKey));
  assert.equal(orcid.file.src.slice(orcid.from, orcid.to), "0000-0000-0000-0001");
  assert.equal(orcid.visit, undefined);
});

test("AMS and ACM author short names never become affiliation IDs", () => {
  for (const cls of ["amsart", "acmart"]) {
    const front = collectFrontmatter(fixture(cls, String.raw`\title{Synthetic manuscript}\author[A. Author]{Ada Author}`, String.raw`\maketitle`));
    assert.equal(text(front.authors[0].name), "Ada Author");
    assert.deepEqual(front.authors[0].affiliationIds, []);
    assert.equal(front.authors[0].orcid, undefined);
  }
});

test("AASTeX 7.0.1 stores its abstract and keywords until the first section implicitly emits the title", () => {
  const plan = fixture("aastex701", String.raw`\shorttitle{Short running title}\shortauthors{A. Author et al.}`, String.raw`
\title{Synthetic stellar manuscript}\author[0000-0000-0000-0001]{Ada}\affiliation{Observatory}
\begin{abstract}An original synthetic abstract with $E$.\end{abstract}
\keywords{stars, spectra}
\section{Dynamics}Ordinary body.\author{Later body command}
`);
  const front = collectFrontmatter(plan);
  const section = bodyNodes(plan).find(node => node.t === "macro" && node.name === "section")!;
  const abstract = bodyNodes(plan).find(node => node.t === "env" && node.name === "abstract")!;
  assert.equal(front.maketitle?.node, section);
  assert.equal(front.maketitle?.visit, 0);
  assert.equal(front.consumed.has(section), false, "the native title trigger is also a real section and must be emitted");
  assert.equal(front.consumed.has(abstract), true, "the stored abstract is rendered only in the title block");
  assert.equal(text(front.abstracts[0]), "An original synthetic abstract with .");
  assert.equal(text(front.keywords[0]), "stars, spectra", "keywords after the abstract remain frontmatter");
  assert.equal(text(front.shorttitle), "Short running title");
  assert.equal(text(front.shortauthors), "A. Author et al.");
  assert.deepEqual(front.authors.map(author => text(author.name)), ["Ada"]);
});

test("AASTeX 7.0.1 also emits title at its first section without an abstract", () => {
  const front = collectFrontmatter(fixture("aastex701", "", String.raw`\title{Synthetic note}\author{Ada}\section*{Introduction}Body.`));
  assert.ok(front.maketitle);
  assert.deepEqual(front.abstracts, []);
  assert.equal(text(front.title), "Synthetic note");
});

test("an unverified class and AASTeX without any actual title trigger never consume metadata", () => {
  for (const cls of ["article", "sn-jnl", "aastex631"]) {
    const front = collectFrontmatter(fixture(cls, String.raw`\title{Draft}\author{Ada}`, String.raw`\section{Body}Text.`));
    assert.equal(front.maketitle, null);
    assert.equal(front.consumed.size, 0);
  }
  const front = collectFrontmatter(fixture("aastex701", String.raw`\title{Draft}\author{Ada}`, "Text without a title trigger."));
  assert.equal(front.maketitle, null);
  assert.equal(front.consumed.size, 0);
});

test("AMS author addresses, current address, dedication and lifted thanks keep their source ownership", () => {
  const plan = fixture("amsart", String.raw`
\title{Synthetic mathematics\thanks{Title grant}}
\author{Ada\thanks{Author grant}}\address{Original Lab}\curraddr{Current Lab}\thanks{Author closing note}
\author{Ben}\address{Second Lab}\subjclass[2020]{35A01, 65L10}\dedicatory{To our teachers}
`, String.raw`\maketitle`);
  const front = collectFrontmatter(plan);
  assert.deepEqual(front.authors.map(author => text(author.name)), ["Ada", "Ben"]);
  assert.deepEqual(front.authors[0].notes.map(text), ["Author grant", "Author closing note"]);
  assert.deepEqual(front.notes.map(text), ["Title grant"]);
  assert.deepEqual(front.authors.map(author => author.affiliationIds), [["1", "current-1"], ["2"]]);
  assert.equal(front.affiliations[1].current, true);
  assert.equal(text(front.dedication), "To our teachers");
  assert.equal(text(front.subjects[0]), "35A01, 65L10");
  assert.equal(front.subjects[0].kind, "subjclass");
  assert.equal(front.subjects[0].qualifier, "2020");
  const note = front.authors[0].notes[0];
  assert.equal(note.file.src.slice(note.from, note.to), "Author grant", "notes retain exact original offsets");
  assert.equal(front.title?.nodes.some(node => node.t === "macro" && node.name === "thanks"), false);
});

test("LNCS and-separated authors keep inst relationships while inline rich formatting survives extraction", () => {
  const front = collectFrontmatter(fixture("llncs", String.raw`
\title{Synthetic computing}
\author{Ada\inst{1,2}\and\textbf{Ben\inst{2}}\thanks{Author note}}
\institute{First Lab\and Second Lab\\\email{lab@example.invalid}}
`, String.raw`\maketitle`));
  assert.deepEqual(front.authors.map(author => text(author.name)), ["Ada", "Ben"]);
  assert.deepEqual(front.authors.map(author => author.affiliationIds), [["1", "2"], ["2"]]);
  assert.equal(front.authors[1].name.nodes.some(node => node.t === "macro" && node.name === "textbf"), true);
  assert.deepEqual(front.authors[1].notes.map(text), ["Author note"]);
  assert.deepEqual(front.affiliations.map(affiliation => affiliation.id), ["1", "2"]);
  assert.equal(front.affiliations[1].content.nodes.some(node => node.t === "macro" && node.name === "email"), true, "institution email remains a source node rather than an inferred author contact");
});

test("LNCS ORCID markers and running heads retain their own source roles", () => {
  const front = collectFrontmatter(fixture("llncs", String.raw`
\title{Full mathematical title}\titlerunning{Short running title}
\author{Ada\inst{1}\orcidID{0000-0000-0000-0001}\and Ben\inst{2}\orcidID{0000-0000-0000-0002}}
\authorrunning{A. Author et al.}\institute{First Lab\and Second Lab}
`, String.raw`\maketitle`));
  assert.equal(text(front.title), "Full mathematical title");
  assert.equal(text(front.titlerunning), "Short running title");
  assert.equal(text(front.authorrunning), "A. Author et al.");
  assert.deepEqual(front.authors.map(author => text(author.name)), ["Ada", "Ben"]);
  assert.deepEqual(front.authors.map(author => text(author.orcid)), ["0000-0000-0000-0001", "0000-0000-0000-0002"]);
  assert.deepEqual(front.authors.map(author => author.affiliationIds), [["1"], ["2"]]);
});

test("IEEE authorblock groups associate their own name blocks and affiliation blocks", () => {
  const front = collectFrontmatter(fixture("IEEEtran", String.raw`
\title{Synthetic engineering}
\author{\IEEEauthorblockN{Ada\thanks{Support note}}\IEEEauthorblockA{First Lab\\ada@example.invalid}
\and\IEEEauthorblockN{Ben}\IEEEauthorblockA{Second Lab\\\email{ben@example.invalid}}}
`, String.raw`\maketitle`));
  assert.deepEqual(front.authors.map(author => text(author.name)), ["Ada", "Ben"]);
  assert.deepEqual(front.authors.map(author => author.affiliationIds), [["1"], ["2"]]);
  assert.deepEqual(front.authors[0].notes.map(text), ["Support note"]);
  assert.match(text(front.affiliations[0].content), /ada@example\.invalid/);
  assert.equal(front.affiliations[1].content.nodes.some(node => node.t === "macro" && node.name === "email"), true);
});

test("preamble imports follow only the already loaded graph and keep nested source provenance", () => {
  const plan = fixture("sn-jnl", String.raw`\title{Earlier title}\import{headers/}{front}`, String.raw`\maketitle`, {
    "headers/front.tex": String.raw`\input{authors}\title{Imported title}`,
    "headers/authors.tex": String.raw`\author[1]{Ada}\affil[1]{Imported Lab}`,
    "authors.tex": String.raw`\author{Wrong root fallback}`,
  });
  const front = collectFrontmatter(plan);
  assert.equal(text(front.title), "Imported title");
  assert.equal(front.title?.file.key, "headers/front.tex");
  assert.equal(front.title?.visit, undefined);
  assert.equal(front.authors[0].name.file.key, "headers/authors.tex");
  assert.deepEqual(front.authors.map(author => text(author.name)), ["Ada"]);
});

test("known body input visit is retained and the first maketitle inside it freezes later root declarations", () => {
  const plan = fixture("sn-jnl", String.raw`\title{Earlier title}`, String.raw`\input{metadata}\author{Later body author}`, {
    "metadata.tex": String.raw`\title{Body input title}\author[1]{Ada}\affil[1]{Body Lab}\maketitle`,
  });
  const input = bodyNodes(plan).find(node => node.t === "macro" && node.name === "input")!;
  plan.visits.push({ key: "metadata.tex", occ: 0, parent: 0, parentLine: 1, inputDirs: ["/virtual"], bodyOnly: false });
  plan.inputTargets.set(`0@${input.from}`, 1);
  const front = collectFrontmatter(plan);
  assert.equal(front.title?.file.key, "metadata.tex");
  assert.equal(front.title?.visit, 1);
  assert.equal(front.maketitle?.file.key, "metadata.tex");
  assert.deepEqual(front.authors.map(author => text(author.name)), ["Ada"]);
  assert.equal(front.consumed.has(bodyNodes(plan).at(-1)!), false);
});

test("includeonly-excluded body files cannot contribute metadata or an earlier maketitle", () => {
  const front = collectFrontmatter(fixture("amsart", String.raw`\title{Root title}`, String.raw`\include{excluded}\author{Ada}\maketitle`, {
    "excluded.tex": String.raw`\title{Excluded title}\author{Ghost}\maketitle`,
  }));
  assert.equal(text(front.title), "Root title");
  assert.equal(front.maketitle?.file.key, "main.tex");
  assert.deepEqual(front.authors.map(author => text(author.name)), ["Ada"]);
});

test("definitions and verbatim do not execute metadata, and a handwritten PLOS header remains body content", () => {
  const plan = fixture("article", String.raw`\newcommand{\fake}{\title{Fake}\author{Ghost}\maketitle}`, String.raw`
\verb|\maketitle|
\begin{flushleft}{\Large\textbf{Handwritten biology title}} Ada, First Lab.\end{flushleft}
\section*{Abstract}Ordinary abstract text.
`);
  const front = collectFrontmatter(plan);
  assert.equal(front.maketitle, null);
  assert.equal(front.title, undefined);
  assert.deepEqual(front.authors, []);
  assert.equal(front.consumed.size, 0);
});

test("generic/elegant parts are last-wins and retain their legacy inline thanks nodes", () => {
  const front = collectFrontmatter(fixture("elegantbook", String.raw`
\title{Old}\title{New\thanks{Title footnote}}\author{Old author}\author{Ada\thanks{Author footnote}}
\institute{School}\date{}\version{1.0}\extrainfo{Extra}
`, String.raw`\maketitle\title{Body title}`));
  assert.equal(front.paper, false);
  assert.equal(text(front.title), "NewTitle footnote");
  assert.equal(front.title?.nodes.some(node => node.t === "macro" && node.name === "thanks"), true);
  assert.equal(front.author?.nodes.some(node => node.t === "macro" && node.name === "thanks"), true);
  assert.deepEqual(front.authors.map(author => text(author.name)), ["Ada"]);
  assert.ok(front.date, "an explicitly empty date remains distinct from an omitted date");
  assert.equal(text(front.date), "");
  assert.equal(text(front.institute), "School");
  assert.equal(text(front.version), "1.0");
  assert.equal(text(front.extrainfo), "Extra");
});

test("metadata without a formal maketitle is never consumed", () => {
  const front = collectFrontmatter(fixture("sn-jnl", String.raw`\title{Draft}\author[1]{Ada}`, "Draft body."));
  assert.equal(text(front.title), "Draft");
  assert.equal(front.maketitle, null);
  assert.equal(front.consumed.size, 0);
});
