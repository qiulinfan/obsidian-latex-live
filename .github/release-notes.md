LaTeX Live 0.1.5 fixes the two blocking findings from the community review of 0.1.4.

- Clipboard table HTML now passes through the existing DOMPurify sanitizer before cells are read. Formatting text, entity decoding and merged-cell rejection are preserved; script and iframe content is discarded.
- PDF page and detached text-layer sizing now uses Obsidian's `setCssProps` API. The pdf.js scale and rounding variables are present before rendering, preserving text selection, copy and zoom geometry.
- Build and release workflows run the official static-style rule and SDL unsafe-HTML rule through `npm run lint:review`. This gate reproduces all five blocking findings in 0.1.4 and reports zero in the repaired source.
- The development-only Moment dependency is updated through an override to address GHSA-4p3w-j4w9-5jqw, without changing the Moment supplied by Obsidian at runtime.

Validated with 850 passing tests, 24 bibliography/table/prose browser checks and 11 native pdf.js reading checks, plus a production build and a dependency audit with zero vulnerabilities.

Requires desktop Obsidian 1.13.7 or later and a separately installed TeX distribution. Features from 0.1.4 remain available. Community advisory findings are separate from the release-blocking checks.

The project's own code is MIT. Bundled DOMPurify uses its Apache-2.0 license option; upstream software and referenced materials retain their own licenses. See THIRD_PARTY_NOTICES.md for details.
