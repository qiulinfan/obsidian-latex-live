// TeX fragments (design 3.3, D4): the constructs only TeX can draw (TikZ, tikz-cd, environments
// the emitter does not know, formulas MathJax rejects) are pages of the probe pass's DVI, each a
// `preview` snippet the plan wrapped in `llxfrag` (inline: an lrbox) or `llxblock` (display
// material). dvisvgm turns them into SVG:
//   dvisvgm --page=1- --exact-bbox --currentcolor --font-format=woff2 --output=frag/f%p.svg <dvi>
// Every snippet starts with a marker the probe writes (`\special{dvisvgm:raw <g class="llx-ref"
// data-id=".." data-visit=".." data-y="{?y}"/>}`), so a page names its drawing (a package shipping out a page of
// its own shifts nothing), and an inline one gives its baseline in SVG coordinates (the viewBox's
// origin differs per engine: pdfLaTeX y=0, XeLaTeX y=-64.03 on the same box). Post-processing
// (string transforms, `prepareFragment`):
//   - the XML declaration, comments and the markers go; black becomes `currentColor` (dvisvgm's
//     `--currentcolor` covers glyphs, pgf writes its own `fill='#000'`), so dark pages keep it legible;
//   - ids, `href`/`url(#..)` targets, dvisvgm's `f<n>` font classes and `@font-face` families get the
//     prefix `llx<visit>-<id>-`: each drawing embeds its own font subsets (`cmmi10` in two fragments with
//     different glyphs), and an inline SVG's <style> applies to the whole HTML page;
//   - an image a picture includes (graphicx's dvisvgm driver: pdfLaTeX) is a file name relative to
//     the project, embedded through `embed` as a data URI (XeTeX's picture specials dvisvgm drops);
//   - sanitized, since raw specials can write anything: only SVG elements dvisvgm writes are kept
//     (`<script>` and `<foreignObject>` go with their content, links become groups), `on*`
//     attributes and `javascript:` or external references go;
//   - in a dark theme, colours too dark to see on the page's background (contrast under 3:1, WCAG's
//     for graphics: `blue!70!black`) are mixed with white, as the page's headings are;
//   - text in the Kangxi radical blocks becomes the unified ideograph: dvisvgm names a glyph by a
//     code point the font maps to it, and Fandol maps 非 and the radical ⾮ to one glyph, so `非空`
//     came out as `⾮空`. Those characters then draw in the reader's CJK font, as the page's text does;
//   - sized in em of the document's font size (`llxinfo{fontsize}`), so a fragment scales with the
//     text around it; an inline one sits `depth` below the baseline (ink bottom minus the marker's y).

/** SVG elements dvisvgm writes (fonts, paths, pgf's graphics); any other tag is dropped. */
const SVG_TAGS = new Set([
  "svg", "g", "path", "text", "tspan", "style", "defs", "use", "image", "rect", "circle", "ellipse", "line",
  "polyline", "polygon", "clipPath", "mask", "pattern", "linearGradient", "radialGradient", "stop", "symbol",
  "title", "desc", "font", "font-face", "glyph", "missing-glyph",
]);

/** TeX points per big point (SVG user units are bp). */
const PT_PER_BP = 72.27 / 72;

const round = (x: number) => Number(x.toFixed(4));

/** The relative luminance (WCAG) of a hex colour; null for anything else. */
function luminance(hex: string): number | null {
  const h = hex.length === 4 ? hex.slice(1).split("").map((c) => c + c).join("") : hex.slice(1);
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const lin = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}

/** The dark page's background luminance (html.ts's `--bg`, #1b1b1d). */
const DARK_BG = 0.0113;

/** Dark-theme rules for the colours of `body` that have under 3:1 contrast on the dark background. */
function darkRules(body: string): string {
  const rules = new Set<string>();
  for (const m of body.matchAll(/\b(fill|stroke)=(['"])(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})\2/g)) {
    const l = luminance(m[3]);
    if (l !== null && (l + 0.05) / (DARK_BG + 0.05) < 3) rules.add(`svg.llx-frag [${m[1]}="${m[3]}"] { ${m[1]}: color-mix(in oklab, ${m[3]} 45%, white); }`);
  }
  return rules.size ? `<style>@media (prefers-color-scheme: dark) { ${[...rules].join(" ")} }</style>` : "";
}

/** A marker's attribute, from the marker tag. */
const markerAttr = (tag: string, name: string): string | null => new RegExp(`\\b${name}=(['"])([^'"]*)\\1`).exec(tag)?.[2] ?? null;

/** The markers (`<g class='llx-ref' .../>`) of a page. */
const MARKER = /<g\s+class=(['"])llx-ref\1[^>]*?\/>/g;

/** The fragment a page's marker names; null for a page no fragment made. */
export function pageFragment(svg: string): number | null {
  for (const m of svg.matchAll(MARKER)) {
    const id = markerAttr(m[0], "data-id");
    if (id !== null && /^\d+$/.test(id)) return Number(id);
  }
  return null;
}

/** A drawing is one static construct during one runtime file visit, named by its marker. */
export const drawingKey = (visit: number, id: number): string => `${visit}:${id}`;

export function pageDrawing(svg: string): { id: number; visit: number } | null {
  for (const m of svg.matchAll(MARKER)) {
    const id = markerAttr(m[0], "data-id");
    const visit = markerAttr(m[0], "data-visit");
    if (id !== null && visit !== null && /^\d+$/.test(id) && /^\d+$/.test(visit)) return { id: Number(id), visit: Number(visit) };
  }
  return null;
}

/** An attribute value with its character references decoded (for the `javascript:` check). */
const decoded = (v: string) =>
  v.replace(/&#x([0-9a-f]+);?/gi, (_m, h: string) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);?/g, (_m, d: string) => String.fromCodePoint(Number(d)));

/** A tag's attributes without event handlers, script URLs and references outside the SVG (`href='#x'` and data images stay). */
function safeAttributes(attrs: string): string {
  return attrs.replace(/\s+([A-Za-z_:][\w:.-]*)\s*=\s*(?:'([^']*)'|"([^"]*)"|([^\s'">]+))/g, (whole, name: string, a?: string, b?: string, c?: string) => {
    const value = decoded(a ?? b ?? c ?? "").trim();
    const lower = name.toLowerCase();
    if (lower.startsWith("on")) return "";
    if (lower === "style") return ` style="${safeCss(value).replace(/"/g, "'")}"`;
    if (/^\s*(?:javascript|vbscript):/i.test(value.replace(/[\s\u0000-\u001f]+/g, ""))) return "";
    if ((lower === "href" || lower === "xlink:href") && !/^(?:#|data:image\/(?:png|jpeg|gif);)/i.test(value)) return "";
    return whole;
  });
}

/**
 * A well-formed tag (attribute values quoted or bare; a quoted one may hold `>`), else a `<` that
 * starts no such tag (escaped, so the HTML parser never reads a tag the filter did not see).
 */
const TAG = /<(\/?)([A-Za-z][\w:-]*)((?:\s+[^\s=>/'"]+(?:\s*=\s*(?:'[^']*'|"[^"]*"|[^\s'">=]+))?)*)\s*(\/?)>|<(?=[/A-Za-z!?])/g;

/** Markup (comments and CDATA wrappers already gone) with only SVG dvisvgm writes: see the file comment. */
export function sanitizeSvg(svg: string): string {
  return svg
    .replace(/<(script|foreignObject)\b[^>]*\/>/gi, "")
    .replace(/<(script|foreignObject)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(TAG, (_m, close: string | undefined, tag: string | undefined, attrs: string | undefined, self: string | undefined) => {
      if (tag === undefined) return "&lt;";
      if (tag === "a") return close ? "</g>" : `<g${safeAttributes(attrs!.replace(/\s(?:xlink:)?href\s*=\s*(?:'[^']*'|"[^"]*"|[^\s'">=]+)/g, ""))}${self}>`;
      if (!SVG_TAGS.has(tag)) return "";
      return close ? `</${tag}>` : `<${tag}${safeAttributes(attrs!)}${self}>`;
    })
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g, (_m, open: string, css: string, end: string) => open + safeCss(css) + end);
}

/** A stylesheet without imports or references to anything but data and fragments. */
function safeCss(css: string): string {
  return css
    .replace(/@import[^;]*;?/gi, "")
    .replace(/expression\s*\(/gi, "(")
    .replace(/url\(\s*(['"]?)(?!data:|#)[^)]*\)/gi, "none");
}

/**
 * A dvisvgm page as inline SVG for the page (see the file comment): prefixed with `llx<id>-`,
 * sanitized, black as currentColor, sized in em of `fontPt` (the document's font size in TeX
 * points); an inline fragment (its marker has a baseline) is lowered by its depth. Null when the
 * page is no SVG dvisvgm wrote (no root element or viewBox). `embed` turns an image's file name
 * into a data URI (null: the image is left out).
 */
export function prepareFragment(svg: string, id: number | string, fontPt: number, embed?: (file: string) => string | null): string | null {
  const root = /<svg\b[^>]*>/.exec(svg);
  const box = root ? /\bviewBox=(['"])([^'"]*)\1/.exec(root[0])?.[2].trim().split(/[\s,]+/).map(Number) : null;
  if (!root || !box || box.length !== 4 || box.some((x) => !Number.isFinite(x))) return null;
  const [x, y, w, h] = box;
  let baseline: number | null = null;
  for (const m of svg.matchAll(MARKER)) {
    const v = markerAttr(m[0], "data-y");
    if (v !== null && Number.isFinite(parseFloat(v))) baseline = parseFloat(v);
  }
  const end = svg.lastIndexOf("</svg>");
  const prefix = `llx${id}-`;
  const inner = svg
    .slice(root.index + root[0].length, end < 0 ? svg.length : end)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[|\]\]>/g, "")
    .replace(MARKER, "")
    .replace(/(<image\b[^>]*?\b(?:xlink:)?href=)(['"])([^'"]+)\2/g, (whole, open: string, q: string, file: string) => {
      if (/^(?:data:|#)/.test(file)) return whole;
      const uri = embed?.(file);
      return uri ? `${open}${q}${uri}${q}` : whole;
    });
  const body = sanitizeSvg(inner)
    // Ids and what refers to them.
    .replace(/\bid=(['"])([^'"]+)\1/g, (_m, q: string, v: string) => `id=${q}${prefix}${v}${q}`)
    .replace(/\b((?:xlink:)?href)=(['"])#([^'"]+)\2/g, (_m, a: string, q: string, v: string) => `${a}=${q}#${prefix}${v}${q}`)
    .replace(/url\(\s*#([^)\s]+)\s*\)/g, (_m, v: string) => `url(#${prefix}${v})`)
    // dvisvgm's font classes, in the markup and the stylesheet, and the font families.
    .replace(/\bclass=(['"])([^'"]*)\1/g, (_m, q: string, v: string) => `class=${q}${v.split(/\s+/).filter(Boolean).map((c) => prefix + c).join(" ")}${q}`)
    .replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/g, (_m, open: string, css: string, close: string) => {
      const scoped = css
        .replace(/\.([A-Za-z][\w-]*)(?=[^{}]*\{)/g, (_x, cls: string) => `.${prefix}${cls}`)
        .replace(/font-family\s*:\s*(['"]?)([^;'"}]+)\1/g, (_x, q: string, fam: string) => `font-family:${q}${prefix}${fam.trim()}${q}`);
      return open + scoped + close;
    })
    // Radicals in text (never in attributes or the stylesheet) as the ideographs they stand for.
    .replace(/>([^<]*[\u2e80-\u2fdf][^<]*)</g, (_m, t: string) => `>${t.replace(/[\u2e80-\u2fdf]/g, (c) => c.normalize("NFKC"))}<`)
    // Black (glyphs are currentColor through dvisvgm; pgf's own colour settings are not).
    .replace(/\b(fill|stroke)=(['"])(?:#000|#000000|black|rgb\(0,\s*0,\s*0\))\2/gi, (_m, a: string, q: string) => `${a}=${q}currentColor${q}`)
    .trim();
  const em = fontPt / PT_PER_BP;
  const attrs = [
    `class="llx-frag"`,
    `viewBox="${[x, y, w, h].map(round).join(" ")}"`,
    `width="${round(w / em)}em"`,
    `height="${round(h / em)}em"`,
  ];
  if (baseline !== null) attrs.push(`style="vertical-align:${round(-(y + h - baseline) / em)}em"`);
  return `<svg ${attrs.join(" ")}>${darkRules(body)}${body}</svg>`;
}
