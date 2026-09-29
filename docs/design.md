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
    `\input/\include/\subfile/\import` 引用它的文档：先找直接引用的，再顺着它引用的文件往下找，
    所以 main → appendix → notation 这样嵌套的 notation.tex 也找到 main）；引擎选择（`% !TEX program`、
    设置、`latexmkrc` 的 `$pdf_mode`、导言区里的 fontspec/ctex/xeCJK/luatexja 等，
    以及自己加载 ctex 的文档类：ctexart/ctexbook/ctexrep/ctexbeamer，
    和中文的 elegantbook/elegantnote/elegantpaper，即 `lang=cn` 或 `cn`，elegantnote 默认中文；
    elegantbook 的 `chinese` 只是标题样式 `scheme=chinese`，不加载 ctex，pdfLaTeX 能编译）。
  - `compiler.ts`：编译队列、导言区格式缓存、依赖收集、进程组清理；完整构建前找一个能跑的 biber。
  - `watchdog.ts`：无进展看门狗（见下文“编译流程”）。
  - `logParser.ts`：错误（精确到文件和行）、警告（按日志里的文件栈归属）、
    rerun / 需要 BibTeX 的提示、页数。
  - `synctex.ts`：`synctex view/edit` 的封装和输出解析。
  - `macros.ts`：项目里的定义：补全用的宏参数个数、颜色、环境，以及喂给 MathJax 的定义语句
    （规范化，按文档顺序：`\input` 的文件、本地宏包的语句排在它们被读入的位置；一个文件里定义的
    `\nc` 这类别名在之后读入的文件里也认），和 MathJax 读不了的定义（`unsupported`）。
  - `aux.ts`：输出目录下所有 `.aux`（`\include` 的在 `chapters/*.aux`）里的 `\newlabel`：编号、页码、hyperref 锚点。
- `src/session.ts`：每个主文件一个会话，由预览视图引用计数，最后一个预览关闭或切走时销毁并杀掉进程。
- `src/preview/pdfRenderer.ts`：用 Obsidian 自带的 pdf.js，按需渲染可见页；
  新 PDF 渲染完成后才替换旧画布，重新编译不闪烁、保持滚动位置；离屏页面的画布会回收。
  `getDocument` 带上 Obsidian 自己的 PDF 查看器用的资源地址（`PDFJS_ASSETS`：`/lib/pdfjs/cmaps/` 等，
  在 app.js 的查看器配置里，文件在 obsidian.asar 的 `lib/pdfjs/` 下），否则 XeLaTeX 输出的中文不显示。
- `src/lsp/`：texlab 客户端（不依赖 Obsidian）。`client.ts` 是 JSON-RPC 帧收发，
  `texlab.ts` 管进程生命周期、文档同步、配置应答和路径映射。
- `src/editor/`：
  - `texExtensions.ts`：编辑器的完整扩展列表（不依赖 Obsidian，测试直接用同一套）。
  - `latexCompletion.ts` + `latexCommands.ts`：texlab 之上的内置补全层。
  - `latexEnter.ts`：环境自动闭合、`\item` 续行，挂在按键仲裁的 Enter 钩子上。
  - `latexScan.ts`：公式扫描（`$`、`\(`、`\[`、`$$`、数学环境），按文档（`Text`）缓存；`mathAt` 给悬停用。
    行内公式跳过文字参数（`\text{当 $x>0$ 时}` 里的 `$` 是嵌套公式，不是结尾）。
  - `mathjaxProject.ts`：`ProjectMath`，每个主文件一个私有 MathJax 实例（见下文“悬停渲染”）。
  - `texRender.ts`：每个主文件一个 `ProjectMath`，只在定义变化时重建（编号是渲染参数，编译后只重读编号）；
    渲染缓存；悬停渲染链。
    Obsidian 的 `loadMathJax`/`finishRenderMath` 由 `main.ts` 传进来，所以它和上面两个一样能直接测。
  - `shared/`：和 obsidian-tinymist 逐字节相同的模块（按键仲裁、YOLO 桥、LSP 补全映射、
    编辑器工具、样式），规范副本在 obsidian-tinymist。

## 编译流程的几个决定

- **保存驱动**：编辑器防抖后保存文件，vault 的 modify 事件触发重编译。
  外部修改（VS Code、git、agent 改文件）走同一条路径。依赖来自 `-recorder` 的 `.fls`，
  所以改 `\input` 进来的章节、图片都会触发；`.fls` 里没有的两类另外补上：
  只被导言区格式读过的本项目文件（用格式缓存时 `localnotes.sty` 这类本地宏包只出现在
  `main-preamble.fls` 里），和参考文献（`.bcf` 的 datasource、`.aux` 的 `\bibdata`；TeX 自己从不打开 `.bib`）。
  改 `.bib` 触发完整构建，因为只有 latexmk 会重跑 BibTeX/Biber。
- **无进展看门狗**：每个 TeX 进程（快速编译、导言区格式、latexmk）都有一个看门狗：
  日志和输出 30 s 没有增长、整个进程组（`ps` 按进程组求和）的 CPU 占用也低于 2% 时，杀掉进程组，
  结果里带一条错误。XeLaTeX 在 macOS 上时这条错误提示字体下载和
  `\PassOptionsToPackage{fontset=fandol}{ctex}`（见文末的环境问题）。在计算的慢编译（CPU 忙）不会被杀；
  读不到 CPU 时间（Windows）时不触发；电脑休眠或计时器被节流后重新计时。5 分钟的总超时仍然保留。
- **Biber**：完整构建前在 TeX bin 目录里跑一次 `biber --version`（每个目录只查一次）。
  跑不起来时用其他候选目录里能跑的 biber（`latexmk -e '$biber = q{"…/biber" %O %S}'`）：
  本机 MacTeX 2026 的 universal biber 只打印 lipo 的用法、退出码 255，而 latexmk 按 PATH（bin 目录在最前）找 biber。
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
  接受 `\ref`、`\begin` 这类命令后直接弹出参数列表，和手打 `{` 一样算隐式弹出（CodeMirror 的
  `activateOnCompletion`），所以 `\re` Tab 之后直接回车也是换行。接受单值参数（`\ref` 一类的 label、`\begin`/`\end` 的环境名、
  `\input`/`\include`/`\subfile`/`\includegraphics`/`\addbibresource` 的文件、`\documentclass`、`\bibliographystyle`、
  颜色）后光标落在右括号之后，回车和 Tab 一样：越过 closeBrackets 的 `}`，这一行上没有东西闭合这个括号时补一个
  （后面还有 `}` 闭合它时光标不动）；片段里右括号后面紧跟下一个字段时跳到那个字段（`\re` Tab 的 `\ref{#1}#0`
  直接结束，`\textcolor{色}{|}` 进入第二个参数）。`\cite`、`\nocite`、`\usepackage`、`\bibliography` 这类逗号列表
  和目录留在括号里，接着打 `, key` 或 `/`。
  `\input{`/`\include{` 的文件去掉 `.tex`（texlab 5.26 把文件和目录都当 kind 1 发，按上下文判断，不看 kind；
  文件带扩展名，只有 `\include{` 的文件本来就不带，这时按根文档目录查文件系统区分文件和目录）。
  内置层用 texlab 的替换范围，但范围超出当前词时不用：`\frac{\|}{}` 里 texlab 把 `\}` 读成命令，范围盖住右括号
  （`$\|$` 里是 `\$`，盖住收尾的 `$`）。光标前只有一个 `\`、后面紧跟 `}` 或收尾的 `$`（光标在数学里）时
  （只有按 Ctrl-Space 才会请求），texlab 条目的范围也截到光标，选 `}` 得到 `\}` 而右括号保留；后面是别的符号、
  或者开启数学的 `$` 时照 texlab 的范围（`a\|,b` 选 `,` 把逗号变成 `\,`，`Cost \|$5$` 选 `$` 转义这个 `$`）。
  单独 `\` 的列表算不完整，下一个字母重新请求 texlab，不在这一个符号加常用命令里过滤。
  完整的列表只对请求时的查询和它的延续有效：退格退进这个查询（`\alp` 退三格再打 `bet`，Ctrl-Space 打开的
  列表也一样）会重新请求，不在 `alp` 的旧列表里过滤出 `\SetMathAlphabet`。
- 按键由共享的 `keyArbiter` 统一裁决：Tab 依次是补全弹窗 > YOLO 灰字 > 片段下一个字段 >
  弹窗将到时稍等 400 ms > 缩进（词中间只插空格，不整行缩进）。片段字段里补全还在加载时，Tab 只在这个词的弹窗
  已经出现过、或者正在打命令名（`\frac{\alp|}{}`）时才等：接受会改变文本就接受，列表里只有原词（`\alpha`）、
  什么都没匹配、400 ms 到了、或者列表来之前又打了字，就跳到下一个字段（打的字进下一个字段）；
  别的文字（`\frac{xy|}{}`）直接跳。Enter 只在接受会改变文本时才接受补全，
  完全匹配时换行；触发字符刚弹出的列表在还没输入、也没用方向键选过时也换行（`\ref{` 直接回车是换行，
  `\end{` 里 texlab 预选的环境名照样接受），永不接受 AI；然后是环境闭合、`\item` 续行（空 `\item` 回车退出列表，
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
- 编辑细节：`$` 配对（中文字后面也配对，`设$|$，则`，再按 `$` 越过右边的 `$`；这一行里数学还没闭合时
  中文字后的 `$` 是收尾，不配对，`$a \in 集|` 得到 `$a \in 集$|`；这条规则在共享的 `mathInput` 里，Typst 也一样；`(`、`[`、`{`、`\(`、`\[` 在中文标点前也配对）、选中文字按 `$` 包起来、
  空 `$|$` 里再按 `$` 变 `$$|$$`、`\(`/`\[` 自动补
  `\)`/`\]` 且不会多出 `]`；空的 `\(|\)` 按退格一起删掉；CRLF 文件保存时保持 CRLF，打开再切走不会改写文件；
  Mod-/ 注释、Mod-D 选下一个、Mod-B/Mod-I 包 `\textbf{}`/`\emph{}`、
  Mod-E 开关预览、Mod-F 搜索；外部修改按最小差异合并（光标、滚动、撤销历史都保留）；
  重新打开文件恢复撤销历史、光标和滚动位置；输入法组字期间不保存、不编译、不同步 texlab
  （Obsidian 自己的延时保存也在 `TexView.save` 里推迟到 compositionend 之后）。
- 编辑器里的编译错误不在正在打字的那一行闪：保存防抖（400 ms）后的编译会给打到一半的 `\fr` 报
  Undefined control sequence，这一行新出现的错误先压住，停手 1.5 s 或光标离开这一行才显示；
  别的行的错误立即显示，已经显示、下一次编译还报的错误保留，修好的错误立即消失
  （共享的 `typingDiagnostics`，只经 `showTexDiagnostics` 设置）。状态栏和问题面板照常显示全部。

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
- 只在 macOS 上测过；Windows 路径和进程树清理写了但没有验证。无进展看门狗在 Windows 上不生效（没有进程组 CPU 时间）。
- 悬停渲染只用 MathJax 3.2.2：tikz-cd、`\intertext`、`\llbracket`、`\oiint` 等画不出来（显示 MathJax 的报错和源码，
  等 P5 的 PDF 裁剪）；tikzpicture 里的 `$\t$` 这类 TikZ 变量同样报错。没有 `\label` 的编号行不显示编号
  （MathJax 的 tags 是关的）。定义体里用到带 `@` 的内部命令的宏（本地宏包里常见）和 `m o` 这类
  `\newcommand` 表达不了的 xparse 参数说明，悬停时报“MathJax cannot read the project's \set: …”
  （等 P6 的真实 TeX 片段编译），不会退回 MathJax 自带的同名命令（braket 的 `\set` 会画出 `{M}[…]`）；
  `\makeatletter` 块里定义的命令仍然跳过。公式里的 `\cref`、`\autoref`、`\pageref`、`\nameref` 还没有替换
  （P3 的标签连同类型名一起做）。
  `\providecommand` 只看项目里前面有没有定义过同名命令，不看 MathJax 自带的命令。

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

## 渲染预览与编辑模式

编辑器里的悬停渲染（鼠标下的公式或块）和实时预览编辑模式（构造原地渲染，光标进入时显示源码），
和 obsidian-tinymist 共用 `src/editor/shared/` 里的核心。分阶段做，每一阶段结束时都能构建、测试通过。

- [x] P0 前置（2026-09-29）：开发依赖的 CodeMirror 对齐 Obsidian 1.13.7 运行时（view 6.43.8、state 6.7.0，
      有了 `BlockWrapper` 的类型，测试跑在运行时同版本的 CodeMirror 上）；无进展看门狗；
      ctex/中文 elegant* 文档类选 XeLaTeX；pdf.js 的 cMap 等资源地址（中文字形）；
      完整构建用能跑的 biber；`.bib` 和只被导言区格式读过的文件进依赖。
- [ ] P1 悬停渲染（源码模式，2026-09-29）：项目宏的私有 MathJax 实例、数学扫描、悬停在 texlab 之前。
      无头部分已完成并测试；这一阶段以 scratch vault 里的 GUI 检查 H1–H4 结束，还没做。
  - [x] 共享的 `renderHover`（`src/editor/shared/renderHover.ts`）：渲染段排在 texlab 的悬停段之前
        （`Prec.high`），300 ms 悬停；鼠标停下 400 ms 后渲染还没完成就显示转圈；CodeMirror 重启悬停时
        同一次渲染只做一次；失败用 `hoverError` 显示；样式 `.lsp-render-hover` 在 `editor.css`。
        悬停框锚在公式里鼠标所在行的行首：锚在公式开头时，长 `align` 的第一行滚出视口后 CodeMirror
        会把整个悬停框藏起来（在 headless Chrome 里验证过）。渲染还没完成时鼠标离开编辑器，就不再显示。
  - [x] `macros.ts` 的定义语句和宏包（`statements`、`packages`、`files`）；`aux.ts` 读编号（P3 的交叉引用标签
        还要加上类型）。
  - [x] `ProjectMath`、`latexScan.ts`（数学部分）、`texRender.ts`；设置 “Render formulas on hover”（`hoverRender`，
        默认开，“Rendering” 一节）；公式里 texlab 的悬停不再出现。只有 MathJax 一条路：PDF 裁剪（P5）
        和真实 TeX 片段编译（P6）还没接上，MathJax 画不了的公式显示它的报错和源码。
  - [x] 审查修复（2026-09-29，见下文“悬停渲染”的验证）：MathJax 的两处内存泄漏（每建一个 TeX 输入、
        每渲染一次带文字的公式）；编号只重读不重建；split/aligned 里的 `\label`、带星号和 `\[ \]` 的编号；
        `\text{}` 里的 `\eqref`；公式里的定义不留下；MathJax 读不了的定义报错；渲染缓存；首次悬停就有字形 CSS；
        `\text{当 $x$ 时}` 的扫描；嵌套 `\input` 的主文件；跨文件的定义别名；elegantbook 的 `chinese` 选项。
- [ ] P2 共享实时预览核心、实时数学、模式切换。
- [ ] P3 文本构造：标题、强调、列表、`\ref`/`\cite` 标签（aux、bib）。
- [ ] P4 定理框（BlockWrapper）和图片。
- [ ] P5 从上次编译的 PDF 裁剪（SyncTeX + pdf.js）。
- [ ] P6 真实 TeX 片段编译兜底、光标处预览。
- [ ] P7 复杂环境（多文件、elegantbook 模板）上的完整验证和实测数字。

## 环境问题：XeLaTeX 找不到 TeX Live 自带的中文字体

macOS 上的 xelatex 通过 CoreText 按名字查找字体，而 CoreText 看不到 TeX Live 目录里的
Fandol 字体。文档（或 elegantbook 这类文档类）按名字设置 `FandolSong-Regular` 等字体时，
每一遍都会报 fontspec 错误、中文缺字，而且字体查找本身极慢：一个最小的 elegantbook + ctex
文档单遍要 24 s。把 Fandol 字体装进 `~/Library/Fonts` 后，同一个文档降到 1.2 s，错误消失。
这与插件无关；另一个做法是改用 `ctex` 的 `fontset=fandol`（按文件名加载）。

## 环境问题：XeLaTeX 卡在 macOS 的字体下载

macOS 27 上 ctex 的默认字体集要用到系统的可下载字体（STXihei、STFangsong 等）。字体没装时，
CoreText 发起下载请求后一直不返回，xelatex 停在 `TDownloadableFontManager::Download`，CPU 为 0，
一个 `lang=cn` 的 elegantbook 等了 5 分钟以上。插件的看门狗在约 30–35 s 时杀掉它并给出提示；
办法是在 `\documentclass` 前加 `\PassOptionsToPackage{fontset=fandol}{ctex}`，或者装好这些字体
（本机装好苹果的中文字体后，去掉这一行的同一本书单遍 1.47 s，用的是 `ctex-fontset-mac.def`）。

## P0 的验证（2026-09-29，合成测试项目的新拷贝，不入库）

- 去掉 `% !TEX program` 和 `latexmkrc` 的 elegantbook 书：引擎判为 XeLaTeX，经 `Compiler`
  快速编译 10 页（两遍 2.9 s），依赖里有 `refs.bib` 和各章。
- 同一本书用 `/Library/TeX/texbin`（biber 坏的那套）做完整构建：latexmk 改用 `/opt/homebrew/bin/biber`，
  Biber 2.21 跑通，11 页，0 个未定义的引用和文献。
- latex-article（pdfLaTeX，格式缓存）：用上缓存格式后依赖里有 `localnotes.sty` 和 `refs.bib`。
- 字体下载卡死现在复现不了（字体已装好），看门狗用假的 xelatex 测（`tests/watchdog.test.ts`：
  一个只输出一行然后带着子进程等待的脚本，整个进程组被杀、报告提示）。
- 中文 PDF：用 obsidian.asar 里的 pdf.js 5.3.34 在无头 Chrome 里渲染这本书，用插件的 `PDFJS_ASSETS`
  且按 Obsidian 的 `app://` 情形在主线程加载 cMap（`useWorkerFetch: false`）：封面和第 5 页的中文都画出来了，
  不带这些参数时一个中文字都没有。还需要在 Obsidian 里的预览面板上目测确认一次。

## 悬停渲染（P1，2026-09-29）

鼠标停在公式上 300 ms，编辑器里弹出它的渲染，排在 texlab 的悬停段之前；公式里 texlab 不再弹
（它只会重复一个字形图片）。设置 “Render formulas on hover” 可以关掉。

- **私有 MathJax 实例**（`ProjectMath`）：用 Obsidian 自带 MathJax（3.2.2）包里的类（`MathJax._`）另建一个 TeX
  输入和 MathDocument，输出共用 Obsidian 的 CHTML（`MathJax.startup.output`），文档选项沿用 Obsidian 的
  `MathJax.config.options`（不加右键菜单、不加辅助 MathML、安全协议相同）。原因：
  - 喂给全局 MathJax（`tex2chtml`）的 `\newcommand` 会留在之后所有 Markdown 笔记里，删不掉；
  - Obsidian 开着 `noerrors` 和 `noundefined`，失败只变成红字；私有实例去掉这两个包，失败抛出 `MathError`；
  - 每次渲染前 `tex.reset()`，同一个 `\label` 可以反复渲染。
  找不到 `MathJax._` 时（比如以后升级到 MathJax 4）退回公开的 `tex2chtml`，没有项目宏，控制台警告一次；
  定义永远不喂给全局实例。
- **定义语句**（`definitionStatements`）：从主文件、`\input`/`\include` 的文件、主文件目录下的本地 `.sty`/`.cls`
  和编辑器里未保存的文本收集，按文档顺序排列，一条语句一次 `convert`（一条失败不影响后面的）。规范化：
  `\newcommand*` 去掉星号（带星号 MathJax “成功”但什么也没定义）；`\DeclareRobustCommand` 和尚未定义过的
  `\providecommand` 变成 `\newcommand`；只有 `m` 参数（前面最多一个 `o` 或 `O{…}`）的 `\NewDocumentCommand`
  变成 `\newcommand`，其他跳过；`\DeclareMathOperator`、`\DeclarePairedDelimiter(X)`、`\def`（含分隔参数）、
  `\let`、`\newenvironment`、`\definecolor` 原样保留；跟随 `\newcommand{\nc}{\newcommand}` 这类别名；
  `\makeatletter` 块和提到带 `@` 命令的语句跳过。另加几个垫片：`\bm`、`\ensuremath`、`\mathbbm`、siunitx 的
  `\SI`/`\si`/`\num`。项目加载 physics 宏包时才打开 MathJax 的 physics（它会改掉 `\div`）。
- **编号**：只有 LaTeX 会编号的环境（不带星号的 equation、align、gather、multline、flalign、alignat、eqnarray）里，
  一行的第一个 `\label{k}` 在上次编译的 `.aux` 里有编号时变成这一行末尾的 `\tag{n}`（这一行没有自己的
  `\tag`/`\notag`/`\nonumber` 时）；equation 和 multline 整个算一行。行只按外层环境自己的 `\\` 分，
  所以 split/aligned/gathered 里的 `\label` 编号到外层这一行的末尾（MathJax 不许在它们里面 `\tag`，以前会报错），
  `\substack{i \\ j}` 不算换行。其余的 `\label` 一律去掉：行内公式、`\[ \]`、`$$`、displaymath 和带星号的环境
  LaTeX 不打编号（`.aux` 里仍有它们的 label，记的是前一个编号，以前会被画成编号）。公式里的 `\ref`/`\eqref`
  换成 `\textup{n}`/`\textup{(n)}`（不知道时是 `??`）：`\textup` 在 `\text{by \eqref{k}}`、`\tag{\ref{k}$'$}`
  这类文字参数里也能用，`\text` 不行（textmacros 报 “\text is only supported in math mode”）。
  编号是渲染参数，不进 MathJax 实例：打开编辑器时从输出目录读（以前编译过就有），每次编译完成后只重读编号。
- **重建和内存**：保存了项目读到的文件（300 ms 防抖），或编辑改动了定义所在的行（500 ms 防抖），重新收集定义；
  语句、physics 和读不了的定义都没变时不重建。重建在 jsdom 里 3–6 ms。MathJax 3.2.2 有两处只增不减：
  - tagformat 和 mathtools 给每个 TeX 输入注册一个标签类（`configTags-N`、`MathtoolsTags-N`，闭包引用这个输入）
    到全局的 TagsFactory，没有删除的办法，每建一个实例就永久留下约 70 KB。实例建好时它的标签对象已经建好，
    所以建完就把这些名字改指向 MathJax 的空标签类（`buildTex`），旧实例才能被回收；
  - textmacros 解析文字参数（`\text`、`\mbox`、`\tag` 的编号）用自己的一份解析选项，MathJax 从不清空，
    每渲染一次带文字的公式就留下这个公式的整棵 MathML（约 17 KB）；每次转换后清空它。
  以前每次改变编号的编译都重建一次（编号在实例里），再加上渲染泄漏，elegantbook 上 200 次改编号的编译
  （每次后悬停一次）堆涨 26 MB，现在 0.4 MB。
- **渲染缓存**：每个主文件缓存最近 200 个公式（显示/行内 + 源码 → 节点或 MathJax 的报错），给出克隆；
  实例或编号变化时清空。公式里的定义（`\def\x{..} \x`）只作用于这个公式：渲染后恢复 MathJax 的定义表。
- **读不了的定义**：xparse 参数说明不是“最多一个 `o`/`O{…}` 加若干 `m`”的，和定义体用到带 `@` 内部命令的，
  记在 `Definitions.unsupported`（按文档顺序，后面能读的同名定义会把它清掉）；用到它们的公式报错，
  而不是画成 MathJax 自带的同名命令。
- **扫描**（`latexScan.ts`）：有 `\begin{document}` 时只看正文；跳过注释、`verbatim` 类环境和 `\verb|…|` 类行内原文；
  每个公式都在段落（空行）处截止，打到一半的 `$`、`$$`、`\[`、`\begin{align}` 不会和很远的分隔符配对。
  行内公式跳过 `\text`/`\textrm`/…/`\mbox`/`\hbox`/`\fbox` 的参数：里面的 `$` 或 `\(` 开始嵌套公式
  （`$f = \text{当 $x>0$ 时} 1$` 是一个公式，以前被切成两半，各报一个括号错误）；参数在段落内不闭合时
  按普通数学读，所以打到一半的 `$\text{a $` 仍然配对。
- **样式**：MathJax 只在调用 `chtmlStylesheet()` 时把新字形的规则加进样式表，而 Obsidian 的 `finishRenderMath()`
  要等 100 ms 才调用它。所以新渲染后马上调用一次，Obsidian 还没放样式表时放进主窗口的 head
  （之后 `finishRenderMath()` 放的是同一个元素），第一次悬停就有字形 CSS，不会先画空框再跳动；
  `finishRenderMath()` 照常调用。弹出窗口里再放一份拷贝，规则数变了才更新：MathJax 用 `insertRule` 加新字形的规则，
  所以拷贝取自 `cssRules`，而不是克隆元素（克隆只有第一版的文本）。
- **测试**：开发依赖 `mathjax@3.2.2` 只给测试用，不打包。Obsidian 的 `lib/mathjax/tex-chtml-full.js` 就是
  npm 包的 `es5/tex-chtml-full.js` 后面接 `es5/ui/safe.js`（逐字节比对过），测试按 app.js 里的配置把它们载入 jsdom
  （`tests/support/mathjax.ts`）。合成的 elegantbook 项目在 `tests/fixtures/elegantbook/`（XeLaTeX 能编译，3 页）。

验证（2026-09-29，不入库的脚本在 scratchpad）：

- 语料：合成项目的每个公式都用它自己的定义过一遍 `ProjectMath`（编号来自之前的编译）。latex-elegantbook
  134/136，失败的只有 tikz-cd 和 `\intertext`；latex-article 45/47，失败的是 `\intertext` 和 tikzpicture 里的 `$\t$`；
  测试夹具 28/30（tikz-cd，和故意用到 `\bn@style` 的 `\sym`）。32 条和 21 条定义语句全部被 MathJax 接受。
  jsdom 里单个公式 p50 0.3–0.4 ms、p95 1.9–4 ms。
- 画面：无头 Chrome 里用 Obsidian 的 app.css（深色）、插件的 styles.css、asar 里的 MathJax 包和 Obsidian 的配置，
  挂真实的 `texEditorExtensions`，经 CodeMirror 自己的 mousemove 悬停：`\E[Q]{X}`（项目宏、可选参数）、
  带 `(1.2)`/`(1.3)` 编号的 align、`$\frac{a}{$` 的 “Missing close brace”、第 3 章的 `\ceil*` 和本章定义的 `\Lip`、
  tikz-cd 的 “Unknown environment 'tikzcd'”，都正确。还没在 Obsidian 里点过（H1–H4）。

审查修复后的验证（2026-09-29，合成项目的新拷贝，不入库的脚本在 scratchpad）：

- 三个项目都先用插件自己的 `Compiler` 编译（elegantbook XeLaTeX 10 页、latex-article pdfLaTeX 3 页、测试夹具
  XeLaTeX），再把每个 `.tex` 文件里的每个公式按 `findRoot` 给这个文件找的主文件经 `TexRender.hover` 渲染一遍，
  和修复前的代码对比：latex-elegantbook 从 118/136 到 134/136（嵌套的 `chapters/notation.tex` 以前自己当主文件，
  16 个公式全是未定义命令；剩下的是 tikz-cd 和 `\intertext`）；latex-article 45/47 到 43/47（intro 里两处 `\set{..}[..]`
  以前被 braket 的 `\set` 悄悄画错，现在明确报错）；测试夹具 28/30 不变（`\sym` 的报错换成说明原因的消息）。
- 在 elegantbook 的第 1 章 align 前插入一个带 `\label` 的 equation 再编译：悬停的编号从 (1.2)(1.3) 变成 (1.3)(1.4)，
  整个过程只建了一个 TeX 输入。
- `node --expose-gc`：200 次改编号的编译（每次后悬停一次）堆涨 0.37 MB（修复前 26 MB）；
  100 次改定义的重建 0.12 MB（修复前 1.26 MB）。
