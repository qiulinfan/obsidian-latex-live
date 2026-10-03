LaTeX Live 0.1.4 adds TeX file creation to the file explorer and fixes selection highlighting on the cursor's line.

- Right-click a folder and choose **New TeX file** (新建 TeX 文件 in Chinese). Enter a name to create an empty `.tex` file and open it in a new editor tab. The same action is available in the command palette. Names receive the `.tex` suffix automatically; existing files are preserved. IME confirmation, duplicate submissions, moved folders and opening failures are handled.
- Multiline selections now remain visibly highlighted on the active line. The opaque active-line background previously covered CodeMirror's selection layer. Nonempty selections make that background transparent, while an empty caret restores the normal active-line highlight. Selection geometry, source text and layer order are unchanged.

Validated with 849 passing tests, real Chrome pixel checks for forward/reverse selections, soft wrapping and dark mode, plus live editing and typography regressions.

Requires desktop Obsidian 1.13.7 or later and a separately installed TeX distribution. All features from 0.1.3 remain available, including LuaLaTeX HTML export and the Unicode-path inverse SyncTeX fix. texlab and YOLO remain optional.

The project's own code is MIT. Bundled DOMPurify uses its Apache-2.0 license option; upstream software and referenced materials retain their own licenses. See THIRD_PARTY_NOTICES.md for details.
