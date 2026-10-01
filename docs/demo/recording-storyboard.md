# LaTeX Live 全功能演示录制脚本

审阅日期：2026-09-30。目标是一段约 11 分 20 秒的连续使用演示，另导出三个可单独观看的短片。录制应以真实 Obsidian UI 和实际生成文件为证据；本脚本不是已录制完成的收据。

执行更新：2026-10-01 已完成真实窗口录制，分别封装中文与英文字幕版。下文保留录制前的规划与只读准备记录；实际范围、时间、模型请求和验证状态以本机 `<demo-output>/evidence/publication-recordings.json` 及各片收据为准。输入由自动化驱动；实际答复由 Codex 审阅，未冒称用户本人确认。成功区间保留真实等待和原速，全部失败原片留存。

## 演示环境与内容

建议在现有 `courses` vault 内使用一个完全原创的演示文件夹，例如 `_latex-live-demo/`，只打开该文件夹的文档，收起个人文件列表和旧聊天。现有 YOLO 配置属于这个 vault 的插件实例；新建 demo vault 不会自动继承模型或凭据。可以为演示建立独立工作区布局，但不要复制 YOLO 的配置文件、导出设置或把整个插件 settings 对象序列化到新 vault。

建议文件：

- `main.tex`：小型中文 elegantbook，显式使用可用的中文字体方案。包括标题、列表、公式、定理、证明、引用、位图、PDF 图片、TikZ 和表格。
- `chapters/inequalities.tex`：真实的三个结论：平方非负；由 `(x-y)^2 >= 0` 得到 `2xy <= x^2+y^2`；将该界分别用于两对变量得到四变量界。证明中用字面 `\ref{...}` 建立两层引用链。
- `preamble.tex`、`refs.bib`、`figures/`：宏、原创合成文献和测试图片。不要借用用户课程或研究笔记。
- `scratch.tex`：按键、诊断和 AI 的演示区域，可以随时 Undo 回到原稿。
- `templates/{biology,physics,math,cs}/main.tex`：复用 `tests/fixtures/paper-templates` 的原创短稿。模板切换是打开各自项目，不能只替换一个 `documentclass` 字符串后假定模板兼容。

演示的数学文字应保持真实、简短。AI 提示可以要求“补全这个平方非负证明的最后一步”或“给这段原稿补充清楚的中文解释”；不要让模型编造 DOI、文献或未验证的数学结论。

## 开拍前的实际状态检查

录制负责人在录屏外确认以下状态，只保留不含秘密的成功/失败收据：

1. Obsidian 版本符合插件 `minAppVersion=1.13.7`；打开 `.tex` 确实进入 LaTeX Live 自定义编辑器。
2. TeX、texlab 可用，演示项目已有成功的 Full build，PDF、`.aux` 和引用号存在；latexmk 能完成参考文献。
3. 实时预览、公式 hover、cursor preview 的当前设置与预定镜头相符。cursor preview 默认关闭，需要负责人按演示计划配置后验证。
4. YOLO 的 `manifest.version` 是实际安装值；本机 `courses` 为 `1.6.9.7`，恰好属于 bridge 的 verified versions。LaTeX 的 `yoloTabCompletion` 默认 false，YOLO 自己还有 enable、最小上下文、模型和网络条件。
5. 只查看模型名称、开关和可用状态，不读取、复制或输出 `yolo/data.json`、完整 settings、API key 或原始请求调试信息。
6. 桌面原生点击、拖选、中文 IME、Save dialog、浏览器打开 HTML 和系统录屏权限均实际可用。不要用测试脚本通过来替代这一步。

代码允许读取 YOLO 插件实例的控制器接口，但其配置由该实例的 `app.vault` 和 `loadData()` 提供。没有经验证的“无凭据跨 vault 继承配置”接口。若新 vault 没有合法配置，使用原 vault 的原创演示区，或由用户在录制外自行配置；不要搬运凭据。

## 连续演示镜头表

| 时间 | 操作与准确入口 | 观众必须能看见的结果 | 讲述重点 |
| --- | --- | --- | --- |
| 00:00–00:40 | 展示完整原稿与右侧 PDF。简短滚动经过中文、数学、定理、图片和文献。 | 是真实 `.tex` 文档和实际 PDF，标题、页数与正文可辨识。 | 在 Obsidian 中编辑 LaTeX；编译使用本机 TeX。 |
| 00:40–01:30 | 点击编辑器的眼睛按钮，或命令 `LaTeX Live: Open preview`。调用 `Full build with latexmk (BibTeX/Biber, all passes)`。改一个数字或句子，停止输入。 | 编译状态转为完成；PDF 中对应内容更新。演示源码光标跟随和 PDF 双击反向跳转一次。 | 快速编译与完整构建各有用途；源码与 PDF 同步。 |
| 01:30–02:50 | 在 scratch 的数学区域输入 `\fra`，Tab 接受 `\frac` 模板；填写分子，Tab 到分母，Shift-Tab 返回。输入 `\alp` 再 Tab。用补全列表上下选择。输入 `\begin{align}` 后 Enter；列表中 Enter 新建 `\item`。 | 补全候选、参数选区、生成的环境结束行和缩进均看得见，源码得到真正修改。 | 少打重复结构；Tab 的候选接受和参数跳转由一个键仲裁器协调。 |
| 02:50–03:50 | 用标题栏书本/代码图标，或 `Toggle live preview` 切换实时模式。移动光标经过公式、标题、列表、定理框、引用和图片。 | 离开时呈现，进入时源码可编辑；定理正文仍可输入，框头和编号保持。拖选经过一个引用或公式。 | 阅读和编辑在同一份源码中完成，普通点击和拖选仍然有效。 |
| 03:50–04:35 | 在源码模式悬停含项目宏的公式。再打开 cursor preview，在一个会软换行的公式里继续输入。展示 MathJax 无法处理但已有编译 PDF 的块或 TikZ。 | hover 中有真实公式；cursor preview 随输入更新且不遮挡当前行；可用时显示 PDF crop/fragment，失败时给出明确消息。 | 项目宏隔离，hover、光标预览与最终 TeX PDF 各有用途。 |
| 04:35–05:30 | 悬停证明里的 `\ref{...}`，先在源码中，再在实时引用芯片上。将鼠标移进“证明引用关系”小窗，点击节点展开陈述与证明，按“显示引用”多看一层，最后“源文件”跳转。 | 箭头可辨识，节点可点击，弹窗留在屏内，陈述/证明真实显示；方向是证明的拥有者到被引用定理。 | 这是源码证明中的显式引用关系，不是自动验证的严格逻辑依赖。 |
| 05:30–06:15 | 临时输入一个未定义命令或缺失环境结束符，等输入停下；点击诊断并展示日志定位。修复，确认 PDF 恢复。`Cmd-F` 搜索一个被实时部件隐藏的引用；`Cmd-G` 到下一个结果。 | 错误下划线、问题行和日志能对应；修复后成功编译；搜索命中揭露源码。 | 编译失败仍可继续编辑，问题有具体位置。 |
| 06:15–07:00 | 输入 `\ref{` 再输入标签前缀，接受实际 texlab 候选；补全 `\cite{`、`\input{` 或图片路径。打开 `.bib` 展示 `@article` 和字段补全，改变合成文献作者/年份后 Full build。 | 候选来自实际项目，文件路径和 bib 字段被填入；PDF/引用芯片更新。 | 展示项目级补全和文献构建；不要把字段补全称为 DOI 自动抓取。 |
| 07:00–07:40 | 分屏打开同一项目的章节与主文件；一侧源码模式、一侧实时模式。切换文档后返回，Undo/Redo。用 Obsidian 原生菜单把其中一个窗格移到独立窗口。 | 两个视图各自保持模式；历史和滚动位置合理；独立窗口有公式字形。 | 多文件、多窗格和 popout 支持实际写作流程。 |
| 07:40–08:40 | 依次打开 biology、physics、math、cs 的原创稿。每项短停留：PLOS 手写标题；REVTeX 双栏、作者与图表；AMS 定理与学科分类；ACM/IEEE 作者、摘要和引用。 | 每种模板都有真实成功 PDF，不能只露出命令名称或 class 文件。可用已生成 HTML 作快速对照，但标明 HTML 是重排的阅读输出。 | 已实测多个领域和模板；不承诺任意宏包的所有排版都完全相同。 |
| 08:40–10:20 | 在足够长的 scratch 源码中调用 `LaTeX Live: Trigger AI completion (YOLO)`，等待真实 ghost text；Tab 接受一条，Undo；另一条用 Shift-Tab/Escape 拒绝。打开 `YOLO: 打开聊天（侧栏）` 或“在右侧分屏打开新对话”，从原创 `.tex` 的文件菜单“添加文件到聊天”。对已附的合成文档提一个明确问题，审阅答复后将需要的 TeX 片段手动放回 scratch 并编译。 | AI 候选确实先以 ghost 显示，再因 Tab 成为源码；聊天的上下文卡片与真实答复可见；最后 PDF 验证插入内容。 | 只有 Tab 接受 AI；Enter 是编辑行为。聊天讨论、候选接受和最终编译是不同步骤。 |
| 10:20–11:20 | 从章节调用 `Export to HTML`。实际 Save dialog 中保存到演示输出目录，等待完成，点 Report，再 Open in browser 与 Reveal in folder。浏览器滚动标题/作者、公式、定理、参考文献、代码着色、图片。 | 保存的是实际独立 HTML；报告说明警告/片段情况；浏览器文件与 Finder 文件名一致。 | 交付一份可阅读的 HTML。报告的零警告仍须结合内容检查。 |

AI 镜头可以真实等待后剪掉冗长的停顿，但不能剪成“无请求、预置答案”的实时 AI 演示。若用了受控预置候选来证明按键兼容，片头和字幕明确标注“预置候选兼容性演示”，另保留是否完成真实推理的收据。

## 按键与扩展兼容近景

另录一个 60–90 秒的近景，依次展示以下状态。每次只保留一个清楚的变化，不用快速连按制造难以辨认的画面。

| 状态 | 操作 | 正确结果 |
| --- | --- | --- |
| 补全列表和 ghost 同时有条件出现 | 输入命令前缀，Tab | 列表优先；不可接受被遮住的 AI 候选。 |
| 可见 ghost，列表已关闭 | Tab | AI 原始 TeX 文本插入，光标移到末尾；不会为 Markdown 转义 `<x>`。 |
| 可见 ghost | Enter | 换行或 LaTeX Enter 行为，不接受 AI。 |
| 可见 ghost | Shift-Tab 或 Escape | 拒绝候选；内容不被插入。 |
| 有多个真实候选 | ArrowUp/ArrowDown | 切换候选；只有实际返回多条时才展示这一项。 |
| snippet 参数中 | Tab/Shift-Tab | 在参数间切换；若正在输入命令且有补全，命令补全先完成。 |
| 刚打开但未触碰的参数候选列表，例如 `\ref{` | Enter | 换行，不把默认第一个标签偷偷插入。 |
| AI 请求或候选显示时 | Backspace | 正常删除；不会被 AI 快捷键吞掉。 |
| 中文拼音正在组合 | 持续输入、稍候、最后选字 | 中途不触发保存/编译；候选/图窗不抢输入，提交后正常更新。 |

日常加速快捷键可在另一段近景展示：`Cmd-/` 注释，`Cmd-D` 下一个相同选区，`Cmd-B` 包裹 `\textbf{...}`，`Cmd-I` 包裹 `\emph{...}`，`Cmd-F` 搜索，`Cmd-G`/`Cmd-Shift-G` 下一个/上一个搜索命中，`Cmd-Alt-F` 替换，`Cmd-Enter` 空行，F12 到定义。`Cmd-E` 是 PDF 预览动作，不是实时模式切换。命令调色板入口使用 `Cmd-P`；本文没有替用户添加新的热键。

## 三个短片导出

1. **加速书写，90 秒**：补全和 snippet 35 秒；环境与列表 Enter 20 秒；路径/ref/cite 补全 15 秒；搜索/包裹/Undo 20 秒。结果是完整可编译的实际源码。
2. **阅读证明，60 秒**：实时模式 15 秒；宏公式 hover 10 秒；证明引用小窗 25 秒；源文件跳转和 PDF 对照 10 秒。
3. **AI 辅助，90 秒**：文件上下文卡片 15 秒；真实询问/答复 25 秒；ghost 候选、Tab 接受和拒绝 30 秒；编译验证 20 秒。可保留“只有候选，尚未接受”与“已接受/编译成功”的状态字幕。

## YOLO 实际入口与边界

已安装 YOLO 的公共代码确认以下命令 ID 和中文名称：

- `yolo:open-new-chat`：打开聊天（侧栏）。
- `yolo:open-chat-split`：在右侧分屏打开新对话。
- `yolo:open-chat-tab`：在新标签页打开新对话。
- `yolo:open-chat-window`：在新窗口打开新对话。
- `yolo:add-selection-to-chat`：添加选中内容到聊天。
- `yolo:trigger-quick-ask`：触发 Quick Ask。
- `yolo:trigger-tab-completion`：触发 Tab 补全。
- `yolo:accept-inline-suggestion`：接受补全。

后四项使用 Obsidian `editorCallback`，不能从存在命令推断 TexView 原生可用。LaTeX 有自己的 `latex-live:trigger-ai-completion`；它通过 `YoloEditorShim.cm` 对接 YOLO 的实际 CodeMirror 控制器。bridge 把文件名连同 `.tex` 扩展名提供给模型，移除 YOLO 自己的高优先级键映射，交给共享 keyArbiter 协调候选/ghost/snippet。

“添加文件到聊天”来自 YOLO 的 `file-menu`，上游入口接受任意 TFile，比假定自定义编辑器的 selection 命令可用更稳；但仍需实际看到 `.tex` 上下文内容被附上，不能只以文件菜单存在作为内容支持的证明。

YOLO 文档修改审阅链的 `getDiffReviewController()` 与 `openApplyReview()` 明确寻找 MarkdownView；fallback 打开目标文件后再次尝试 Markdown 审阅。直接在 LaTeX 自定义视图里展示同样的自动修改审阅，没有现成实证。聊天可以讨论 `.tex`；把回复片段手动放回源码并编译，是可诚实录制的路线。不要把这一段配成“聊天已自动修改整份 LaTeX 文档”。

本插件没有检索 DOI 并自动填 BibTeX 的入口，也没有 Markdown 内 LaTeX 代码块预览功能。任意 Obsidian 第三方编辑扩展、所有 YOLO agent/tools 工作流、iPad 和 HTML LuaLaTeX 导出不属于本次已证明功能。可以演示当前的已有能力，不把这些写进全功能字幕。

## 证据与交付包

本次只读准备没有执行 AI 推理，没有改变设置，没有修改用户文档；仅查阅 YOLO 的 `manifest.json` 和公共 `main.js`，未读取配置文件。

可供负责人引用的既有收据：

- `YOLO_MAIN=<installed yolo/main.js> node scripts/yolo-contract.mjs`：本次对实际 YOLO 1.6.9.7 控制器代码 **18/18** 通过，日志 `/tmp/latex-live-demo-yolo-contract.log`。它使用受控测试，不代表真实服务请求成功。
- 证明引用小窗：独立 UI unit **10/10**；真实 Chrome pointer/click/drag/IME/layout **32/32**。脚本 `scripts/theorem-graph-smoke.mjs`，截图在系统临时目录的 `latex-live-theorem-graph-smoke/`。
- 多模板来源、许可与版本：`tests/fixtures/paper-templates/*-sources.json`；纸模板验收包含实际 build/prepare/emit 和 PDF 引用文本对照。演示前以当前一次测试与生成文件为准。

最终录制包应包含连续视频、三个短片、使用的原创演示源码、真实 PDF/HTML、简短功能时间索引，以及不含秘密的验证摘要。摘要分别记录录屏完成、实际 AI 请求成功、候选接受、编译成功、HTML 保存与打开；不能把这些状态合并成一个笼统的“全部完成”。
