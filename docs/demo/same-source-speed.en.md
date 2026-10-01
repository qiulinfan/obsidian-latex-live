# Same source, real automatic compilation

Recorded on **2026-10-01**, using the public, original [one-page source](fixtures/speed-article.tex). The only measured edit changes the model's denominator from `x^2` to `x^3`. The same file was uploaded to a new Overleaf project and opened in the real Obsidian editor.

![Real same-source recordings at normal speed](../assets/showcase/same-source-overleaf.gif)

| Warm edit | LaTeX Live: observed edit → painted PDF | Local TeX compile | Overleaf: observed edit → updated PDF interval |
| --- | --- | --- | --- |
| 1 | 0.768 s | 0.274 s | 3.841–4.693 s |
| 2 | 0.893 s | 0.394 s | 3.419–3.776 s |
| 3 | 0.874 s | 0.370 s | 3.665–4.086 s |
| Median | **0.874 s** | **0.370 s** | **3.665–4.086 s** |

These are observed workflow times from three edits, not a universal speed ranking or an isolated TeX-engine benchmark. The GIF shows local take 1 and Overleaf take 2; its labels describe those takes. The full sample set is above and in the [machine-readable observations](same-source-speed.json).

## Conditions

- **Local:** the published LaTeX Live **0.1.1** build, with its three installed files checked against GitHub release SHA-256 digests; Obsidian 1.13.7; Apple M5, 32 GB RAM; pdfLaTeX / TeX Live 2026. Automatic compilation uses the default **400 ms** save delay and the plugin's cached preamble.
- **Overleaf:** an authenticated **Cloud Free** account; `main.tex`; pdfLaTeX / TeX Live **2026**; **Normal** compile mode; **Autocompile enabled**. The initial PDF and auxiliary files were already prepared.
- Before each measured edit, the original exponent and its PDF were restored. Both sides retained their normal warm caches. The cloud service's hardware, scheduler and complete package versions were not controlled.
- This fixture has one page and no bibliography, images or unusual macros. It does not measure cold builds, long projects, XeLaTeX or HTML export.

The uploaded source SHA-256 is `bc53d908d2a0545bac505e85fc103b1912e9be80271f54fb9145b9e204766ce8`. All three local before/after buffers match the expected original and one-character-edited hashes.

## What the clock observes

The local observer starts when committed editor text changes, then waits until a new PDF's page canvas replaces the previous generation. It samples at nominal 10 ms intervals and verifies the new exponent in the PDF text. The compile duration is recorded separately; the edit-to-PDF duration includes saving, debounce, compilation, PDF loading and painting.

Overleaf is operated through its actual Find/Replace UI. Read-only checks watch the visible source and PDF text layer; the captured pictures confirm the new exponent. The start is bounded by the UI action's before/after timestamps, and the endpoint by successive old/new PDF observations. Those observations have finite precision, so an interval is reported instead of an invented exact time. The first trial's observation interval is coarser than the other two. The two products' observation endpoints also differ slightly.

Obsidian was recorded with ScreenCaptureKit's selected-window capture. Overleaf was recorded with a real CDP screencast, retaining frame timestamps. The comparison uses same-frame toolbar, source and PDF crops within each column; added captions sit outside the application picture. Separate takes are aligned at the observed edit: the committed local edit and the midpoint of Overleaf's action interval. It preserves normal playback speed. Other showcase GIFs show the complete panes and navigation.

The recording task did not run encoding or tests while measuring. Raw captures and detailed local receipts stay outside Git; [public provenance](showcase-provenance.json) records excerpt ranges and hashes.

Overleaf's documented [automatic compilation](https://docs.overleaf.com/getting-started/recompiling-your-project) runs every few seconds and preserves helper files between builds. This comparison includes that user-visible workflow; it does not infer server TeX execution time from the total wait.

[中文](same-source-speed.md) · [Full product comparison](overleaf-comparison.en.md)
