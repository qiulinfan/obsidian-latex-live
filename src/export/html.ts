// Page assembly for the HTML export (design 3.6): one self-contained file, no JavaScript. The look
// (the stylesheet, light and dark, the title block) is the class profile's (profiles.ts); this
// module only escapes and assembles.

/** Text for HTML content. */
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Text for an attribute value (always double-quoted). */
export function attr(s: string): string {
  return esc(s).replace(/"/g, "&quot;");
}

/** A fragment link to an id (`#eq:indicator`): characters a URL fragment cannot hold, encoded. */
export function hrefId(id: string): string {
  return "#" + encodeURI(id).replace(/#/g, "%23");
}

export interface TocEntry {
  /** TeX's level: -1 part, 0 chapter, 1 section, 2 subsection, ... */
  level: number;
  number: string | null;
  /** The title as HTML. */
  title: string;
  id: string;
}

export interface TitleBlock {
  /** Each as HTML; empty when the document does not set it. */
  title: string;
  subtitle: string;
  author: string;
  institute: string;
  date: string;
  /** elegantbook's \version and \extrainfo. */
  version: string;
  extrainfo: string;
  /** Paper-specific relationships and front matter; all content is rendered source HTML. */
  paper?: {
    authors: { name: string; affiliations: { label: string; id: string | null }[]; emails: string[]; notes: string[]; orcid?: string; corresponding?: boolean }[];
    affiliations: { label: string; id: string; html: string; current?: boolean }[];
    abstracts: string[];
    keywords: string[];
    subjects: { label: string; html: string }[];
    dedication: string;
    notes: string[];
  };
}

/** A footnote: its id, the id of its mark in the text ("" when the text has none), the mark and its text. */
export interface Footnote {
  id: string;
  ref: string;
  mark: string;
  html: string;
}

export interface Page {
  /** `zh-CN` for ctex and Chinese elegant documents, else `en`. */
  lang: string;
  /** The `<title>`: the document's title as text. */
  title: string;
  /** The profile's stylesheet (profiles.ts pageCss: the layout, the look, the colour variables). */
  css: string;
  /** The title block's markup (profiles.ts titleHtml), or "". */
  header: string;
  /** The contents: its heading, and the entries within tocdepth. */
  toc: { title: string; entries: TocEntry[] } | null;
  /** The body; the contents go where `TOC_MARK` stands (`\tableofcontents`). */
  body: string;
  footnotes: Footnote[];
  /** The math's stylesheet (math.ts: its glyph and font rules, the fonts inline). */
  mathCss: string;
}

/** Where `\tableofcontents` stood in the body. */
export const TOC_MARK = "<!--llx:toc-->";

/** The whole HTML document. */
export function renderPage(p: Page): string {
  // The contents' top level (chapters in a book, sections in an article) is set bold, as LaTeX does.
  const top = Math.min(...(p.toc?.entries.map((e) => e.level) ?? [0]));
  const toc = p.toc
    ? `<nav class="llx-toc"><h2>${esc(p.toc.title)}</h2><ul>${p.toc.entries
        .map((e) => `<li class="llx-toc-${Math.max(0, e.level)}${e.level === top ? " llx-toc-top" : ""}"><a href="${attr(hrefId(e.id))}">${e.number ? `<span class="llx-num">${esc(e.number)}</span>` : ""}${e.title}</a></li>`)
        .join("")}</ul></nav>\n`
    : "";
  const body = p.body.includes(TOC_MARK) ? p.body.replace(TOC_MARK, () => toc) : p.body;
  const notes = p.footnotes.length
    ? `<ol class="llx-footnotes">${p.footnotes
        .map((f) => {
          // The back link ends the note's last paragraph.
          const back = f.ref ? ` <a href="${attr(hrefId(f.ref))}">↩</a>` : "";
          const html = back && f.html.endsWith("</p>") ? `${f.html.slice(0, -4)}${back}</p>` : f.html + back;
          return `<li id="${attr(f.id)}"><span class="llx-label">${esc(f.mark)}</span>${html}</li>`;
        })
        .join("")}</ol>\n`
    : "";
  return `<!doctype html>
<html lang="${attr(p.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="LaTeX Live">
<title>${esc(p.title)}</title>
<style>
${p.css}${p.mathCss}
</style>
</head>
<body>
<main>
${p.header}${body}
${notes}</main>
</body>
</html>
`;
}
