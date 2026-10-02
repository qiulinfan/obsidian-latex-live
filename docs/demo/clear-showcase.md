# Clear showcase recordings / 清晰演示录屏

Recorded in real Obsidian on **2026-10-01, America/Detroit**. The three opening demos are available separately with English and Chinese captions in the READMEs. Each also has a full-resolution MP4 link.

| Demo | What the real recording shows | English / 中文 |
| --- | --- | --- |
| ElegantBook live editing | Rendered mathematics and theorem boxes; native exponent edit; local source reveal; full live/source mode switch | [GIF](../assets/showcase/elegantbook-clear.gif) · [MP4](../assets/showcase/elegantbook-clear.mp4) / [GIF](../assets/showcase/elegantbook-clear-zh.gif) · [MP4](../assets/showcase/elegantbook-clear-zh.mp4) |
| Compilation and navigation | Actual edit → replacement PDF canvas; source → PDF highlight; trusted native PDF double-click → matching source line | [GIF](../assets/showcase/speed-navigation-clear.gif) · [MP4](../assets/showcase/speed-navigation-clear.mp4) / [GIF](../assets/showcase/speed-navigation-clear-zh.gif) · [MP4](../assets/showcase/speed-navigation-clear-zh.mp4) |
| YOLO + Mercury Edit 2 | Real ghost-text response; native Tab acceptance; native Undo | [GIF](../assets/showcase/mercury-edit2-writing.gif) · [MP4](../assets/showcase/mercury-edit2-writing.mp4) / [GIF](../assets/showcase/mercury-edit2-writing-zh.gif) · [MP4](../assets/showcase/mercury-edit2-writing-zh.mp4) |

The public demo vault runs Obsidian 1.13.7, published LaTeX Live 0.1.1, Background 0.2.1 and [YOLO](https://github.com/Lapis0x0/obsidian-yolo) 1.6.9.7 configured with the user's existing Mercury FIM transport adapter and Mercury Edit 2. LaTeX Live consumes the suggestions through YOLO's editor interface. Its [original manuscript](fixtures/elegantbook-showcase/main.tex) uses the installed ElegantBook class and ordinary `\include` chapter files. The saved fixtures contain the final state; the evidence retains the exact before/after buffers for the measured edit and AI completion.

## Image and timing fidelity

ScreenCaptureKit records the selected public demo window at **2880 × 1690, 30 fps**, without audio or the rest of the desktop. The user's existing font and zoom remain unchanged; the PDF pane occupies **55%** of the split. The UI is captured as displayed.

GIFs use one proportional downsample to **1440 × 845**, lossless RGB FFV1 editing intermediates and a caption rail drawn at the final output size. Final GIFs are **1440 × 941 at 20 fps**, with the normal 256-color GIF palette limit. MP4s preserve **all native UI pixels**, adding only a matching-density caption rail: **2880 × 1882 at 30 fps**, H.264 CRF16. No UI text is enlarged or recreated.

All clips play at normal speed. Cuts remove pauses between independent scenes, including time spent reviewing a model suggestion. Each measured request/compile interval is continuous within its excerpt. The full mode switch uses the real TexView action through the application API; exponent edits, AI acceptance/undo and inverse PDF navigation use native keyboard/pointer input. Source positioning and forward navigation also use the actual application APIs.

## Observed actions

| Action | Observation | Boundary |
| --- | --- | --- |
| ElegantBook exponent `4 → 5` | **1022 ms** from committed source edit to a replacement PDF canvas; TeX run **522 ms**, no errors | Two pages, pdfLaTeX, warm preamble, default 400 ms delay |
| PDF double-click | Native trusted event; independently resolved source line **22**, actual line **22** | Matching point in the compiled chapter PDF |
| Mercury Edit 2 | First observed suggestion **497 ms**, actual text `converges to $s+t$` | One selected short continuation after the manual completion command, unchanged 32-token budget; not a model benchmark |
| Tab / Undo | Tab inserts that actual response; native Undo restores the original buffer | Both actions are visible in the same recording; valid TeX and zero compile errors before and after |

These recordings do **not** replace the separate [one-page, same-source Overleaf comparison](same-source-speed.en.md). That comparison retains its own conditions and all three observed samples.

[Machine-readable action evidence](clear-showcase-evidence.json) · [Excerpt ranges, source hashes and final file hashes](showcase-provenance.json).

## 中文说明

本次保留用户认可的字号和缩放，右侧 PDF 占 **55%**。录屏来自真实 Obsidian 窗口，原始分辨率为 **2880 × 1690、30 fps**；GIF 只做一次等比缩小，编辑中间文件使用无损 RGB，字幕直接按最终尺寸绘制。高清 MP4 保留原生界面的全部像素，不放大或重画文字。

前三项依次展示 ElegantBook 实时编辑、实际编译和双向跳转、YOLO 的 Mercury Edit 2 补全。两种字幕分别导出。片段均为正常速度，剪辑只省略场景间的停顿；1.02 秒的修改到 PDF，以及约 0.50 秒的补全等待都保留完整。

演示沿用用户在 YOLO 侧配置的 Mercury FIM 请求适配。补全是实际请求中选取的一次简短数学结论，32-token 配置未改变；原始尝试保留在 Git 外。手动触发真实补全后，按约 10 ms 的只读采样首次观察到建议的时间为 497 ms，录屏保留了实际 ghost text。原生 Tab 接受 `converges to $s+t$`，原生撤销在同一段录屏里还原原稿，前后 TeX 均可正常编译。它展示辅助写作流程，不代表所有请求的速度和完成率。

本次两页 ElegantBook 与此前一页同稿 Overleaf 对比使用不同材料，计时分别记录。模板稿为原创公开演示，Miku 壁纸由用户提供并授权在录屏中展示，原作品的权利独立于本项目的 MIT 许可证。API 密钥、私人 vault、聊天记录和原始录屏均未进入 Git。

[同稿对比的全部样本与条件](same-source-speed.md) · [中文 README](../../README_zh-CN.md) · [English README](../../README.md)
