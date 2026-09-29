# LaTeX Live 设计记录

目标：在 Obsidian 里直接编辑 `.tex`，靠本机已经装好的 TeX 发行版做轻量的实时编译和 PDF 预览。
插件不带编译器，只负责编辑器、编译调度、日志解析、预览和 SyncTeX 跳转，
结构上和 obsidian-tinymist 一样：`TextFileView` 编辑器加一个独立的预览叶子。

## 能不能实时：实测

本机环境：TeX Live 2026（MacTeX 在 `/Library/TeX/texbin`，Homebrew 版在 `/opt/homebrew/bin`），
Obsidian 1.13.7，Apple Silicon。

| 文档 | 方式 | 单次编译 |
| --- | --- | --- |
| 最小 article | pdfLaTeX | 0.18 s |
| 最小 article + fontspec | LuaLaTeX / XeLaTeX | 0.35 s / 0.35 s |
| 10 页数学作业风格 article（自带宏文件） | pdfLaTeX | 0.32 s |
| 同上 | pdfLaTeX + 预编译导言区 | 0.24 s |
| demo（tikz + hyperref，插件内） | 冷启动，两遍 | 0.99 s |
| 同上 | 编辑后增量，预编译导言区 | 0.30 s |
| 65 页中文书（elegantbook + ctex） | XeLaTeX | 1.36 s / 遍 |

表中文档都是临时生成的合成文档（生成脚本不入库），每项取 3 次中位数。

结论：pdfLaTeX 和常规篇幅的文档可以做到停止打字后约 0.8 s 看到新 PDF
（400 ms 防抖 + 约 0.3 s 编译 + 渲染）。慢的文档主要慢在导言区和字体：
导言区用格式缓存解决（仅 pdfLaTeX），字体问题见文末。

## 架构

```
TexView (CM6)  --防抖保存-->  vault modify 事件
                                   |
            依赖表(.fls) 命中的会话 v
LatexSession(root) -> Compiler: 串行队列，最多一个在跑、一个在等
                          |  pdflatex/xelatex/lualatex -recorder -synctex=1
                          |  -file-line-error -output-directory=$TMPDIR/...
                          v
                 CompileResult: PDF 字节 + 解析后的日志
                    |                          |
     LatexPreviewView (pdf.js)          TexView 行内诊断
     问题面板 / 双击反向跳转             光标 -> synctex view -> 预览高亮
```

- `src/tex/`：不依赖 Obsidian，可在 Node 下直接对真实 TeX 跑测试。
  - `project.ts`：主文件查找（`% !TEX root`、自身含 `\documentclass`、向上查找
    `\input/\include/\subfile/\import` 引用它的文档）；引擎选择（`% !TEX program`、
    设置、`latexmkrc` 的 `$pdf_mode`、导言区里的 fontspec/ctex/xeCJK/luatexja 等）。
  - `compiler.ts`：编译队列、导言区格式缓存、依赖收集、进程组清理。
  - `logParser.ts`：错误（精确到文件和行）、警告（按日志里的文件栈归属）、
    rerun / 需要 BibTeX 的提示、页数。
  - `synctex.ts`：`synctex view/edit` 的封装和输出解析。
- `src/session.ts`：每个主文件一个会话，由预览视图引用计数，最后一个预览关闭或切走时销毁并杀掉进程。
- `src/preview/pdfRenderer.ts`：用 Obsidian 自带的 pdf.js，按需渲染可见页；
  新 PDF 渲染完成后才替换旧画布，重新编译不闪烁、保持滚动位置；离屏页面的画布会回收。
- `src/lsp/`：texlab 客户端（不依赖 Obsidian）。`client.ts` 是 JSON-RPC 帧收发，
  `texlab.ts` 管进程生命周期、文档同步、配置应答和路径映射。
- `src/editor/`：
  - `texExtensions.ts`：编辑器的完整扩展列表（不依赖 Obsidian，测试直接用同一套）。
  - `latexCompletion.ts` + `latexCommands.ts`：texlab 之上的内置补全层。
  - `latexEnter.ts`：环境自动闭合、`\item` 续行，挂在按键仲裁的 Enter 钩子上。
  - `shared/`：和 obsidian-tinymist 逐字节相同的模块（按键仲裁、YOLO 桥、LSP 补全映射、
    编辑器工具、样式），规范副本在 obsidian-tinymist。

## 编译流程的几个决定

- **保存驱动**：编辑器防抖后保存文件，vault 的 modify 事件触发重编译。
  外部修改（VS Code、git、agent 改文件）走同一条路径。依赖来自 `-recorder` 的 `.fls`，
  所以改 `\input` 进来的章节、`.bib`、图片都会触发。
- **合并而不是取消**：编译进行中收到新请求只记一个待办，完成后再编一次。
  持续打字时预览按编译速度刷新，不会因为不停取消而永远看不到结果。
- **一遍 + 按需第二遍**：日志提示 rerun 时自动多跑一遍来稳定引用和目录，
  第一遍的 PDF 先推给预览。BibTeX/Biber 只在"完整构建"（latexmk）里跑，状态栏会提示。
- **导言区缓存**（pdfLaTeX）：用 mylatexformat 把 `\begin{document}` 之前的内容 dump 成格式文件，
  后台构建，不阻塞当前编译。缓存键是引擎和导言区文本的哈希，
  加上导言区读入的本项目文件（如 `qq_defs.tex`、本地 `.cls`）的 mtime。
  格式损坏时自动退回普通编译。
- **输出目录**放在 `$TMPDIR`，不往 vault 里写 aux/pdf；`\include` 需要的子目录会预先建好。

## 开发中踩到的坑

- 绝对路径的 `-fmt` 会让 pdfTeX 把 `-recorder` 的临时文件名拼成
  `<outdir>//abs/path...`，进程直接退出。改成按名字传格式、用 `TEXFORMATS` 指向输出目录。
- 上面这个问题一开始被旧日志掩盖了：进程没写日志，插件读到的是上一次的日志，
  于是报告"编译成功、0.01 s"。现在每次编译前删除旧日志，测试也检查日志头里确实加载了缓存格式。
- macOS 上 TeX 报告的是物理路径（`/private/var/...`），vault 用逻辑路径，
  依赖匹配、缓存失效和 SyncTeX 跳转都需要做映射（`logicalMapper`）。

## 已在 Obsidian 里验证（测试 vault，2026-09-28）

- [x] `.tex` 在自定义编辑器中打开，语法高亮正常。
- [x] 打开预览；章节文件的预览指向 `main.tex`；切换到另一个文档时预览跟着切换，旧进程被杀掉。
- [x] 在章节里打字，约 2 s 内预览更新；增量编译 0.30 s（缓存导言区）。
- [x] 错误：状态栏、问题面板（点击跳转）、编辑器行内标记；修复后清除。
- [x] PDF 双击反向跳转到源码行；"Show cursor position in preview" 正向定位并高亮。
- [x] 重载 Obsidian 后预览面板恢复；latexmk 完整构建；缩放和适应宽度。
- [x] 多文件项目：章节文件正确识别主文件和引擎（pdfLaTeX 与 XeLaTeX 各一个项目）。

## 编辑与补全

后端用 texlab 5.26（Homebrew，`/opt/homebrew/bin/texlab`），插件只负责把它的结果变成顺手的编辑体验。
下面的延迟数字来自合成项目上的模拟打字（每 120 ms 一个字符，每键增量同步加一次补全），以及本仓库测试里的真实 texlab。

**texlab 本身**

- 很快：模拟打字 145 次按键，补全 p50 3 ms、p99 6 ms；第一次命令补全要加载命令库，约 100 ms。
- 工作区用 vault 根目录，一个 vault 一个进程。它只沿着打开的文件向上找主文件、
  顺着 `\input` 读项目，不扫描整个 vault，空闲时 CPU 为 0。
  用章节目录做工作区会丢掉其他章节的 label。
- 已知缺陷和对应处理：
  - 命令紧贴文档末尾（没有结尾换行）时返回 0 个补全，而不少编辑器保存时不加结尾换行。
    插件发给 texlab 的文本缺结尾换行时补一个（测试里去掉这一步，EOF 用例就会失败）；
    位置都在补的字符之前，不用换算，结尾换行状态不变时照常增量同步。
  - 每次最多 50 项、同分按字母排、不分数学/文本模式，`\al` 在加载 algorithmicx 的项目里拿不到 alpha。
    内置层把前缀匹配、但不在这 50 项里的常用命令补进来，再按上下文重排。
  - 没有参数片段、选环境不插 `\end`。内置层补上 `\frac{|}{}`、`\textbf{|}`、
    用户宏按 `[n]` 生成参数、`\begin{name}` 配对 `\end{name}`（列表环境带第一个 `\item`）。
  - 引文只按 key 过滤；列表完整时插件按 filterText（作者、标题）本地过滤。
    列表弹出前就打完的 `\cite{Masked Au`（打字快于 100 ms/键时就是这样）texlab 返回 0 项，
    这时去掉查询词再要一次完整列表，接受时替换整个查询词。
  - `\definecolor` 定义的颜色不在列表里；内置层从项目文件里扫出来补上。
- `build.auxDirectory` 指向当前文档的编译输出目录后，label 带上编号：
  `sec:intro -> Section 1 (Introduction)`、`eq:cdf -> Equation (1)`（2026-09-28 用 pdflatex 编译测试项目后验证）。
- 悬停设为 `hover.symbols = glyph`，数学符号直接显示 α；补全列表里的符号用单独一列显示字形。
- 诊断不显示：编译日志是唯一来源；格式化不接（本机 latexindent 缺 YAML::Tiny）。
- texlab 的 PATH 以插件解析到的 TeX bin 目录开头：Obsidian 自己的 PATH 里没有 TeX，
  机器上还有两套 TeX（MacTeX 和 Homebrew），这样 texlab 和编译器看到的是同一套。

**内置层的排序**（同一匹配等级内用 boost 调整，前缀匹配永远排在非前缀前面）

- 数学模式里（`$..$`、`\(..\)`、`\[..\]`、数学环境，沿用高亮器的状态机判断）数学命令和带字形的符号 +30，
  章节、`\item`、`\usepackage` 等文本命令 −30；文本模式里纯数学命令 −10。
- 当前文档里用过的命令按次数加分（数学里算数学中的用法；`\newcommand{\supp}` 这类定义处不算使用），
  常用的约 100 个命令有小的先验分。`\DeclareMathOperator` 定义的算子按数学命令排序。
- 完全匹配永远排第一（CodeMirror 的打分里完全匹配比前缀匹配高 100，boost 只有 ±99），
  所以正文里打 `\sec` 得到的是正割 `\sec`，要 `\section` 得多打一个字母或按下箭头。
- `\end{` 时 texlab 预选的最内层未闭合环境始终排第一。

**触发和按键**

- 自动弹出：`\` 后至少一个字母，或者在 `\ref{`、`\cite{`、`\begin{`、`\usepackage{`、
  `\input{`、`\includegraphics{`、`\textcolor{` 等参数里；空格、单独的 `\`、`\\` 换行都不请求，
  `%` 注释和 verbatim 类环境里也不请求（texlab 在那里什么都不给，只剩内置层的话 Enter 会插入片段）。
  接受 `\ref`、`\begin` 这类命令后直接弹出参数列表；`\end{` 接受环境名后光标落在右括号之后。
  `\input{`/`\include{` 的文件去掉 `.tex`（texlab 5.26 把文件和目录都当 kind 1 发，按上下文判断，不看 kind）。
  内置层用 texlab 的替换范围，但范围超出当前词时不用：`\frac{\|}{}` 里 texlab 把 `\}` 读成命令，范围盖住右括号。
- 按键由共享的 `keyArbiter` 统一裁决：Tab 依次是补全弹窗 > YOLO 灰字 > 片段下一个字段 >
  弹窗将到时稍等 400 ms > 缩进（词中间只插空格，不整行缩进）；Enter 只在接受会改变文本时才接受补全，
  完全匹配时换行，永不接受 AI；然后是环境闭合、`\item` 续行（空 `\item` 回车退出列表，
  只有标签的 `\item[(a)]` 只换行，正文写在下一行）、`\[|\]` 展开。
  `\begin{ali|}` 里补全还在加载（快速打字时约 150 ms）就按 Enter，会像 Tab 一样最多等 400 ms，
  接受 `align` 并带上 `\end{align}`，而不是闭合一个不存在的 `ali` 环境；等待期间继续打字则丢弃这次 Enter。
  `\end{name|}` 里、以及环境已经闭合时 `\begin{name|}` 里的 Enter 越过右括号再换行，不把括号拆到下一行。
  新行缩进：`\begin{...}`（`document` 除外，它的正文不缩进）和行尾未闭合的 `{`、`[`、`(` 之后多缩进一级，
  `\end{...}` 开头的行和它的 `\begin` 对齐，其余沿用本行缩进。
- 内置层的片段直接用 CodeMirror 的 `snippet()` 模板插入，只转义字面反斜杠后的花括号：
  @codemirror/autocomplete 6.20.3 的模板解析在一行里有多个 `\{`/`\}` 转义时会把后面的字段位置算错
  （`\frac\{${1}\}\{${2}\}` 的第二个字段落在右括号后面）。共享的 LSP 片段转换现在也只在必要处转义，
  但同一行字段前连续三个以上转义时仍会算错。
- 编辑细节：`$` 配对（中文字后面也配对，`设$|$，则`，再按 `$` 越过右边的 `$`；`(`、`[`、`{`
  在中文标点前也配对）、选中文字按 `$` 包起来、空 `$|$` 里再按 `$` 变 `$$|$$`、`\(`/`\[` 自动补
  `\)`/`\]` 且不会多出 `]`；空的 `\(|\)` 按退格一起删掉；CRLF 文件保存时保持 CRLF，打开再切走不会改写文件；
  Mod-/ 注释、Mod-D 选下一个、Mod-B/Mod-I 包 `\textbf{}`/`\emph{}`、
  Mod-E 开关预览、Mod-F 搜索；外部修改按最小差异合并（光标、滚动、撤销历史都保留）；
  重新打开文件恢复撤销历史、光标和滚动位置；输入法组字期间不保存、不编译、不同步 texlab
  （Obsidian 自己的延时保存也在 `TexView.save` 里推迟到 compositionend 之后）。

**YOLO**：设置里的 “YOLO AI tab completion”（默认关）把 YOLO 的灰字补全接到 .tex 里：
YOLO 自己的按键映射被过滤掉，只保留渲染，触发走 YOLO 自己的防抖和开关；接受时插入原文（不做 Markdown 转义），
模型看到的标题带扩展名（`notes.tex`）。补全弹窗出现时灰字自动消失。
设置关着时 “Trigger AI completion (YOLO)” 命令不出现，设置说明里的桥状态显示 off；触发失败时弹出提示，说明桥的状态。
要让模型写 LaTeX 而不是 Markdown，需要在 YOLO 设置的 tabCompletionConstraints 里按标题扩展名区分
`.tex`/`.typ`（插件只读 YOLO，不改它的设置；提示词见 obsidian-tinymist 的 docs/yolo-bridge.md）。

## 已知限制

- 导言区缓存只支持 pdfLaTeX；主文件名含空格时不启用。
- 警告的文件归属靠解析日志里的括号嵌套，偶尔会归错文件；错误是精确的。
- 所有预览面板都跟随当前激活的 LaTeX 编辑器，暂时没有"固定"某个文档。
- 默认不开 `-shell-escape`（minted 等需要在设置里打开）。
- 只在 macOS 上测过；Windows 路径和进程树清理写了但没有验证。

## 下一步

- [ ] 大文档：编辑某一章时只编译这一章（`\includeonly` 或自动生成包含当前章节的临时主文件），
      这是几十页以上的书收益最大的一项。
- [ ] XeLaTeX/LuaLaTeX 的导言区缓存（字体无法 dump，需要在 fontspec 之前 `\endofdump`，要实验）。
- [ ] Markdown 里 ` ```latex ` / ` ```tikz ` 代码块用同一套编译器渲染（standalone → dvisvgm → SVG，按内容哈希缓存）。
- [x] 接入 texlab 做补全和悬停（2026-09-28，texlab 5.26；见上文“编辑与补全”）。
- [x] Tab/Enter 补全和按键仲裁、参数片段、环境配对、`\item` 续行、数学模式排序（2026-09-28）。
- [x] YOLO AI 灰字补全桥（默认关，2026-09-28）。
- [x] 编辑细节：`$` 和 `\(` `\[` 配对、Obsidian 热键透传、外部修改最小差异、撤销历史缓存、
      焦点和光标恢复、暗色光标、输入法组字期间不保存（2026-09-28）。
- [x] F12 跳转到定义（texlab definition，打开 vault 里的文件和行）。
- [ ] texlab 的折叠范围、文档大纲、label/命令重命名、inlay hint（label 编号）。
- [ ] 文档类和宏包选项、pgfplots 库的补全（texlab 都没有数据）；超过 50 条的 .bib 按作者/标题搜索需要插件自己建索引。
- [ ] “Change environment” 命令（texlab.changeEnvironment + workspace/applyEdit）。
- [ ] 可选的 TeXpresso 后端，做真正增量的预览。
- [ ] "把 PDF 导出到源文件旁边"命令；预览固定到某个文档。

## 环境问题：XeLaTeX 找不到 TeX Live 自带的中文字体

macOS 上的 xelatex 通过 CoreText 按名字查找字体，而 CoreText 看不到 TeX Live 目录里的
Fandol 字体。文档（或 elegantbook 这类文档类）按名字设置 `FandolSong-Regular` 等字体时，
每一遍都会报 fontspec 错误、中文缺字，而且字体查找本身极慢：一个最小的 elegantbook + ctex
文档单遍要 24 s。把 Fandol 字体装进 `~/Library/Fonts` 后，同一个文档降到 1.2 s，错误消失。
这与插件无关；另一个做法是改用 `ctex` 的 `fontset=fandol`（按文件名加载）。
