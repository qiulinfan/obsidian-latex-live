# Cross-template compatibility audit

## Scope and evidence

This audit began on 2026-09-30 to broaden the plugin beyond ElegantBook. Native PDF
compilation, semantic live editing, and reflowing HTML are separate capabilities.
The plugin always uses the installed TeX distribution; it does not replace a class,
font package, bibliography tool, or TeX engine.

The regression manuscripts are original synthetic text and images. Publisher
classes and styles were tested unchanged, with versions and SHA256 receipts in
`tests/fixtures/paper-templates/*-sources.json`. Published paper text was not copied.

| Field | Template | Version tested | Native calibration |
| --- | --- | --- | --- |
| Biology | PLOS | Template 3.8, Apr 2026; `plos2025.bst` | Original publisher sample: 5 pages, no errors |
| Biology/medicine | Springer Nature `sn-jnl` | Template 3.1, Dec 2024; class internal v0.1 | Original publisher sample: 12 pages, no errors |
| Physics | REVTeX, APS and AIP | 4.2f | Original APS sample: 7 pages, no errors |
| Astronomy/physics | AASTeX | 7.0.1 | Original sample: 8 pages, no errors |
| Mathematics | AMS `amsart` | 2.20.6; official template 1.1 | Original AMS template: 1 page, no errors; downloaded template matches installed bytes |
| Mathematics/theoretical CS | LNCS | 2.26 | Synthetic manuscript compiles; original documentation sample needs absent `llncsdoc.sty` and is not claimed as calibrated |
| Computer science | ACM `acmart`, sigconf and acmsmall author-year | Installed 2.16 and official release 2.20 | Original samples: 6 pages, no errors, on both versions |
| Computer science/engineering | IEEEtran conference | 1.8b | Original conference skeleton: 1 page, no errors |

Sources: [PLOS](https://journals.plos.org/plosone/s/latex),
[Springer Nature](https://www.springernature.com/gp/authors/campaigns/latex-author-support),
[REVTeX](https://journals.aps.org/revtex),
[AASTeX](https://journals.aas.org/aastex-package-for-manuscript-preparation/),
[AMS](https://ctan.org/pkg/amscls), [LNCS](https://ctan.org/pkg/llncs),
[ACM](https://ctan.org/pkg/acmart), [IEEEtran](https://ctan.org/pkg/ieeetran).
The AAS publisher page advertises 7.0.2; this audit covers 7.0.1, not that untested release.

## What the audit checks

`tests/paperTemplateFidelity.test.ts` verifies declared content independently of
warning counts: complete title, every author, affiliations, contacts, abstract,
keywords, subject classification, notes, section text, TeX label numbers, reference
links, citation text, bibliography entries, images and captions. A zero-warning
export that loses an author or abstract must fail.

The native samples establish that a failure is attributable to the plugin rather
than an invalid manuscript or unavailable toolchain. Additional regressions compare
AMS equation-label glyph coordinates with HTML left/right placement and compare
ACM anonymous/public output with PDF text and native ORCID link annotations.

Final semantic acceptance: 11/11 configurations, no warning or error; all final
citation strings were independently compared with native PDF text. Ten additional
native citation cases and two ACM visibility cases passed. `npm run build` and the
full test suite passed, 688/688 without skips, including the verified optional
ACM 2.20 assets prepared in local cache.

The browser audit covered the ten canonical paper fixtures and three existing
book/article/homework baselines at 1000/375 px in both themes. The first combined
run passed 338/352: two SVG jobs timed out, and twelve glyph checks misclassified
three zero-width `overline` extender carriers per CS fixture. The two jobs passed
isolated retest; the three affected CS pages passed 81/81 after a narrow painted
extender check. Real CSS-removal counterexamples still detect absent glyph rules.
Production mathematical rendering was unchanged. All originally failing conditions
have thus been rechecked; this is an aggregate result, not a claim that the first
combined run was clean.

## Changes made from real failures

- Source-backed paper front matter covers declarations in the preamble and in the
  document, preserves author/institution relationships and metadata, and respects
  AASTeX 7.0.1's native first-section title trigger. PLOS's handwritten title block
  stays readable source content; the parser does not invent declared author roles.
- Public macro signatures survive zero-argument publisher readers, including long
  setup bodies and star dispatch. Full effective public declarations are available
  to the parser; MathJax's existing filtered definitions and bounded error messages
  are unchanged.
- REVTeX/AAS/ACM bibliography wrappers retain their payload and rich formatting
  without printing implementation labels or markers. Explicit project overrides of
  ACM's article-title wrapper take precedence.
- Ordinary classes no longer expand an arbitrary `institutename` typesetter as a
  label. LNCS native theorem/proof semantics are recognized; unsupported styles
  remain native TeX fragments.
- Equation-label side is read from TeX. AMS defaults and explicit `reqno`, including
  inherited wrapper classes, follow the actual PDF.
- Citation command defaults and punctuation also come from TeX. ACM's actual
  `cite` alias and IEEE's active cite-package delimiters/dashes retain their
  publisher form, including author-year, textual, sorted/compressed and custom
  punctuation cases; the AIP default is tested separately.
- Publisher title/author/abstract TOC records are consumed only where the rendered
  front matter represents them. A numbered section named Abstract remains a section.
- ACM's native anonymous flag hides author metadata and excluded content. Comment
  environment end lines retain their original form for the native probe.

## Practical boundaries

The native PDF remains the authority for publisher print layout. HTML deliberately
uses one readable, reflowing column rather than reproducing page headers, double
columns, exact publisher fonts and caption punctuation. Complex tables, diagrams
and unsupported environments can be native SVG instead of editable HTML.

Live editing supplies semantic formulas, references, images and theorem blocks;
unrecognized syntax stays source. Citation chips currently provide bibliography
author/year summaries rather than reproducing every journal's numeric citation
style. That limitation is separate from PDF and HTML citation fidelity.

LuaLaTeX HTML export remains outside the first-release scope. A class that needs an
unavailable font, package or tool still needs that dependency installed by the user.
No claim is made about untested classes or options.

## Reproduction and redistribution

The installed TeX Live classes are test dependencies, not vendored engines.
Springer's class carries an additional distribution notice, so the unchanged
external class is downloaded into ignored cache rather than committed individually:

```sh
node scripts/fetch-paper-templates.mjs
npm test
```

The fetcher verifies pinned archive and member hashes and refuses a changed file.
`PAPER_TEMPLATE_SPRINGER_DIR` selects an already verified external asset directory.
The optional ACM 2.20 test uses `PAPER_TEMPLATE_ACM_CURRENT_DIR`, or the verified
`node_modules/.cache/paper-templates/acmart-current` cache. Its generated class must
remain with the original `acmart.dtx` and `acmart.ins`; no global TeX upgrade is made.
The source receipt records the official archive hash and generation procedure.

PLOS's open-licensed bibliography style retains its license header. The official
PLOS sample `.tex` is not committed because it has no independent file license;
the regression manuscript was written independently. PDFs, browser screenshots,
logs and downloaded class packages remain outside Git.
