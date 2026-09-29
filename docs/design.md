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
  等 P5 的 PDF 裁剪）；TikZ 图（tikzpicture、tikzcd、pgfpicture、circuitikz）里的节点公式不扫描，悬停和实时
  预览都不管，也等 P5。没有 `\label` 的编号行不显示编号
  （MathJax 的 tags 是关的）。定义体里用到带 `@` 的内部命令的宏（本地宏包里常见）和 `m o` 这类
  `\newcommand` 表达不了的 xparse 参数说明，悬停时报“MathJax cannot read the project's \set: …”
  （等 P6 的真实 TeX 片段编译），不会退回 MathJax 自带的同名命令（braket 的 `\set` 会画出 `{M}[…]`）；
  `\makeatletter` 块里定义的命令仍然跳过。公式里的 `\ref` 一族（`\cref`、`\autoref`、`\pageref`、`\nameref`）
  和实时预览的标签一样换成文字（P3）。
  `\providecommand` 只看项目里前面有没有定义过同名命令，不看 MathJax 自带的命令。
- 实时预览的文本构造（P3）：标题的 `{title}`、强调命令的参数、`\item[..]` 的标签都必须在同一行里闭合；
  `\autoref`/`\cref` 的类型名只按 hyperref、cleveref 的英文默认名，加上项目里的 `\<type>autorefname`、
  `\crefname`/`\Crefname`、`\newtheorem` 标题和 cleveref 的 `capitalise`/`noabbrev` 算：babel 的其他语言名、
  `\creflabelformat`、cleveref 的 `nosort`/`nocompress`、hyperref 退回的 `\<type>name`（listings 之外）都不跟；
  中文文档也是英文名（ctex 和 elegantbook 都不定义，PDF 里就是这样）。引用标签总是 “作者 年份”，不跟
  biblatex/natbib 的数字样式；`\S`、`\term{..}` 这类命令保留源码。定义（`\newcommand` 等）一直跳到第一个
  大括号外的换行，同一行后面的内容也不装饰。`\iffalse` 只在行首时当注释跳过（`\let\ifx\iffalse` 是代码）；
  打到一半、还没有 `\fi` 的 `\iffalse` 一直跳到文末，和 TeX 一样。enumitem 的 `resume` 只跟列表的嵌套，
  不跟定理之类别的环境的分组（enumitem 在那里恢复不到）。

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
  - [x] 共享核心 `livePreview.ts`（`src/editor/shared/`，2026-09-29，无头部分；见下文“实时预览的共享核心”）：
        一个 StateField（光标碰到才显示源码，两端都算，只在有焦点时；鼠标按下和输入法组字时只映射；
        带错误诊断或渲染失败的构造不替换），显示公式展开后下方留渲染，`enterBlocks` 事务过滤器让
        上下方向键走进块（不绑任何键），渲染缓存和调度（视口优先，同步渲染在微任务里，异步一次一个，
        其余空闲时预取），部件高度变化后重新测量，`renderStats`；`.lsp-lp-*` 样式；渲染悬停不再出现在
        实时部件上（`replacedAt`）。测试 T-S1–T-S12（`tests/livePreview.test.ts`，两个仓库相同），
        浏览器冒烟 B1–B5（`scripts/browser-smoke.mjs`）。
  - [x] LaTeX 的实时数学和模式切换（2026-09-29，无头部分；见下文“LaTeX 的实时预览”）：`latexLive.ts`
        （构造 #1–#4：行内公式；显示公式独占整行时是块，在正文里是行内的显示部件；数学环境，`\label` 按上次
        编译的 `.aux` 变成 `\tag{n}`；MathJax 画不了的保留源码加虚线下划线）；`TexRender.rendererFor(root)`
        （同步，纪元是定义语句的哈希，`flush` 立刻放字形 CSS、弹出窗口也放一份）和第一次进入实时模式前的预载；
        `TexView` 的模式（视图状态、标题栏按钮、命令 “Toggle live preview”、设置 “Default editing mode”、
        超过 10,000 行拒绝、`HistoryCache` 按模式恢复）；隐藏命令 “Show render statistics”。测试 T-L5
        （`tests/latexLive.test.ts`）和模式切换（`tests/texView.test.ts`，Obsidian 替身 `tests/support/obsidian.ts`）。
  - [x] 共享核心的审查修复（2026-09-29，无头部分；见下文“实时预览的共享核心”的“审查修复”）：鼠标按着或组字时
        调度器不再在微任务里空转（编辑器会卡死）；`enterBlocks` 只改正行移动（Cmd-A、Cmd-ArrowUp/Down、
        Shift-Cmd-ArrowDown、Escape 不再被拉进块），行移动进入文末或文首的块时逐行经过；搜索面板的当前匹配
        会展开公式；紧挨着构造的错误不再让它保持源码；展开的块下方的预览不再显示别的块的渲染；扫描器抛错时
        保持源码；渲染落地后只重画等它的构造；行内替换只画视口附近的（密集文档的光标移动 1.2 ms → 0.3 ms）；
        标签在标题行里不再跟着变大变粗；`scripts/gen-perf-fixture.mjs` 生成 B5 用的长章节。
  - [ ] GUI 检查 L1–L9、L14–L16（scratch vault）。
- [ ] P3 文本构造：标题、强调、列表、`\ref`/`\cite` 标签（aux、bib）。
  - [x] LaTeX 的文本构造 #5–#11（2026-09-29，无头部分；见下文“LaTeX 的实时预览：文本构造（P3）”）：
        `latexScan.ts` 的标题、强调、`\item`（标记按层级、enumerate 简写和 enumitem `label=`/`start=`）、列表和
        center 的 `\begin`/`\end` 行、引用、引用文献、`\label`，定义体不再扫描；`latexRefs.ts`（标签和公式里引用的
        文字，类型名来自锚点，elegantbook lang=cn 用中文名）；`src/tex/aux.ts` 的类型、`src/tex/bib.ts`
        （`bibFiles`、`parseBib`、`readBib`、`citeLabel`）；`TexRender.refsOf`（编译结果、打开视图、保存和编辑
        .bib 时重读，变了才通知视图）。测试 T-L6（`tests/aux.test.ts`，`tests/fixtures/aux/` 的静态 .aux 摘录）、
        T-L7（`tests/bib.test.ts`）、T-L8（`tests/latexLive.test.ts`），以及扫描器、TexRender、TexView 的新用例。
  - [x] 文本构造的审查修复（2026-09-29，无头部分；见下文“文本构造（P3）”的“审查修复”）：标签的文字就是 PDF
        印出来的（elegantbook 条目编号的颜色参数不再漏进 “structurecolor1.”；`\autoref` 用 hyperref 的名字，
        `\cref`/`\Cref` 按 .aux 里 cleveref 的类型分组、排序、区间、复数，跟 `capitalise`/`noabbrev`、
        `\crefname`、`\newtheorem`；不再给中文文档换中文名）；带公式或引用的 `\item[..]` 标签原地显示、公式渲染；
        TikZ 图不再装饰；根文档在 `\begin{document}` 前读入的文件（拆开的导言区）没有构造；enumitem 的
        `resume`/`resume*`/`series` 和列表里的 `\setcounter`；tcblisting、fancyvrb、filecontents 和行首
        `\iffalse` 块跳过；`\Citet`、`\citealp`、`\footcite` 等也是文献标签。
  - [ ] GUI 检查 L11（scratch vault）。
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
- **扫描**（`latexScan.ts`）：有 `\begin{document}` 时只看正文；跳过注释、`verbatim` 类环境（含 tcblisting、
  fancyvrb 的 `BVerbatim` 等、filecontents）、`\verb|…|` 类行内原文、行首 `\iffalse` 到它的 `\fi`（或 `\else`）、
  TikZ 图（等 P5）；
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

## 实时预览的共享核心（P2，2026-09-29）

`src/editor/shared/livePreview.ts`（和 obsidian-tinymist 共用）只管两种语言共同的规则；每种语言提供
`scan`（构造，纯函数，按 `Text` 记忆）和 `decorate`（每个构造长什么样），公式由 `renderConstruct` 按统一规则画。

- **一个 StateField**：块部件和替换换行只能来自状态（从 ViewPlugin 给，CodeMirror 直接抛错）。编辑、焦点变化、
  `refreshLive`、新的 lint 诊断、重新配置、鼠标抬起时全部重建；只移动选区时，只重画旧选区和新选区所在行上的
  构造（嵌套的构造连带），不在构造上的移动什么也不做。鼠标按下时（Obsidian 的冻结：拖动时版面不动）和输入法
  组字时（`input.type.compose`）只映射，`compositionend` 之后刷新。
- **显示规则**：编辑器有焦点（或它的搜索面板开着：findNext 和替换让焦点留在面板里，当前匹配要看得见）、
  某个选区碰到构造（两端都算，`$x$|` 也算）时显示源码；失去焦点时全部渲染。
  块（独占整行）按行判断，展开后在最后一行下面留一份渲染（`is-below`）；新源码还在渲染或渲染失败时，
  下面这份保留上一次的渲染，标 `is-pending` / `is-error`。带错误诊断的构造（诊断和构造重叠，或者是空的、
  在构造里或边上；只在构造开头结束、或从结尾开始的不算）、渲染失败的构造都不替换（保留 lint 下划线，
  或加虚线下划线 `lsp-lp-error`，悬停显示报错）。重叠的替换，先加的留下。扫描器抛错时这段文本保持源码
  （只记一次日志），编辑器照常可用。
- **部件**：`RenderWidget` 克隆渲染器给的节点；CodeMirror 会把一个部件的 DOM 交给同类的下一个部件
  （块被替换的部件变成下方预览），所以 `updateDOM` 重设全部 class 和属性。新结果还在渲染或失败时，只接手
  自己的 DOM（同一个请求，或正在编辑的块下方的预览；CodeMirror 把旧部件一起交给 `updateDOM`），别的块
  的渲染不会出现在这里。块的高度量进按键的缓存，作 `estimatedHeight`（没量过时每行 40 px）。`TextWidget`
  给标签、项目符号、标题用，字号和粗细跟编辑器正文，不跟标题行。
- **只画视口附近的行内替换**：CodeMirror 每次更新都要逐个比较一个集合里所有的替换（点装饰的块从不共享），
  每行都有构造的 5,700 行文档里约 12,500 个，光标移动要 1.2 ms。所以不跨行的替换放在一个函数形式的
  `EditorView.decorations` 里，只给视口前后各 4,000 个字符和主选区所在的行（按字段值和视口缓存）；块替换和
  跨行的替换只能来自状态，留在静态集合里。原子范围、`replacedAt` 和 `enterBlocks` 读全部。
- **渲染缓存和调度**：每个渲染器一份缓存，超过 2000 个时先丢最早渲染的，但打开的视图正在用的永远不丢
  （构造比 2000 多的文档，否则会一直丢了又渲染）。视口里的先渲染：同步渲染器（MathJax）在微任务里，
  绘制之前，每次最多 8 ms，其余下一帧继续；异步渲染器（tinymist）每个渲染器同时只有一个请求。视口外的
  在空闲时每批 50 个预取，离视口近的先，滚动时部件已经在了。纪元（宏、导言区）变了就丢掉缓存，旧纪元的
  结果作废。每批一次 `refreshLive`（异步的每帧一次），带着落地的键，只重画等这些渲染的构造
  （`refreshLive.of(null)` 全部重建）；鼠标按着或正在组字时不刷新，松开或组字结束会重建。视口里已经渲染好、
  只是刷新被压着的键不算待渲染：否则调度器在微任务里空转，鼠标抬起和组字结束永远轮不到，编辑器卡死。
- **方向键**：实时预览不绑任何键，Tab/Enter/Escape/方向键仍然只归 keyArbiter。`cursorLineUp/Down` 会跳过
  被块部件盖住的行；`enterBlocks` 事务过滤器只改正行移动（userEvent 正好是 "select"，范围带目标列：
  cursorLineUp/Down、它们的 Shift 形式、PageUp/Down；选区个数不变）里“正好越过一段隐藏行”的一步：落在紧邻的
  可见行上，或者落在文末（文首）的块里（CodeMirror 这时把光标放到文档末尾或开头），就停到这段块的开头
  （向上时是结尾），块随即展开。Cmd-A、Cmd-ArrowUp/Down、Shift-Cmd-ArrowDown、Mod-Home/End、代码片段字段和
  Escape（多个光标变成一个）不带目标列或改了选区个数，都不改；中间有可见行的跳转（PageDown）、鼠标和搜索的
  选区也不改。jsdom 没有布局，CodeMirror 的上下移动在那里不带目标列，测试给 `moveVertically` 补上一个。
- **高度**：块部件在 CodeMirror 量过之后变了尺寸（MathJax 的字形 CSS 晚到、网页字体），ResizeObserver 经
  rAF 合并后改第一行的一个属性，CodeMirror 于是重新测量；否则比窗格短的文档里行号和行会错开。
- **鼠标抬起后**光标若在视口外就滚过去（Overleaf 的 scrollJumpAdjuster）。
- **接口**：`liveInput()`（焦点、鼠标、组字，一直挂着，在 compartment 之外），`livePreview({ language, renderer })`
  放进 `livePreviewCompartment`；`refreshLive`、`isLive`、`replacedAt`、`renderStats`（渲染次数、命中、等待数、
  渲染和重建耗时的 p50/p95，给隐藏命令 “Show render statistics”）；超过 `LIVE_MAX_LINES`（10,000 行）的文档不装饰。
  渲染悬停在实时部件上一律不出现（`renderHover` 直接查 `replacedAt`）。

验证（2026-09-29）：

- `tests/livePreview.test.ts`（两个仓库相同，假语言、假渲染器，jsdom）：T-S1–T-S12，外加选区移动的局部重画
  和整体重建逐个比较（150 次随机移动，含嵌套的盒子）、构造多于缓存时不重复渲染、重叠替换、BlockWrapper、
  尺寸变化后的重新测量、`replacedAt` 和渲染悬停。golden 按键矩阵在打开实时预览时全部不变，新增光标紧挨着
  折叠的行内公式和块时 Tab、Enter、Escape 与源码模式相同，方向键停到块上。
- `scripts/browser-smoke.mjs`（无头 Chrome，这个仓库用 `mathjax@3.2.2` 和 Obsidian 的配置渲染）：B1 方向键逐行
  走过 `\[..\]`、`$$..$$`、align，块依次展开，Cmd-ArrowDown 到文末；B2 输入法 `c`…`ceshi` 组字时部件数不变，
  上屏 `测试` 后文本正确；B3 拖选时文档高度不变，松开后选区保留；B4 37 行的文档行号和行的偏差 0 px
  （去掉重新测量时最多 3 px；obsidian-tinymist 的替身渲染器晚 100 ms 长高，最多 136 px）；B5 5,700 行：
  挂载 4.7 ms、打字 p95 4.7 ms、光标移动 p50 0.5 ms（局部重画之前约 2.5 ms）、滚 20 屏帧 p90 16.7 ms。

审查修复（2026-09-29，两个仓库的共享核心和测试相同；不入库的复现脚本在 scratchpad）：

- 修了什么：鼠标按着（或组字）时，视口里的渲染已经落地但刷新被压着，空闲预取又开始了，调度器就在微任务里
  一直排自己（无头 Chrome 里页面 CPU 99%、鼠标抬起永远处理不到）；`enterBlocks` 把 Cmd-A、Cmd-ArrowUp/Down、
  Shift-Cmd-ArrowDown、Escape（两个光标）当成一行一行的移动拉进块里（全选只选到块前、Cmd-ArrowDown 停在块上）；
  ArrowDown 进入文末的块、ArrowUp 进入文首的块时直接跳到块的另一头；搜索面板里按 Enter 找到的匹配在渲染的公式
  里时看不见（焦点在面板里）；紧挨着公式结束的错误（`\foo$x$` 的未定义命令）让公式保持源码；一次改两个块、
  第一个变回源码时，第二个下方失败的预览显示第一个的渲染；扫描器抛错（极深的嵌套）会让每个事务都抛错；
  在展开的块里打字，渲染落地后整篇重建（现在只重画这个块）；行内替换多的文档光标移动超预算；标题行里的标签
  跟着变大变粗（Typst 的补充文字还带着 `*`）。
- 测试：`tests/livePreview.test.ts` 新增和改写的 10 个用例（按住鼠标时异步和同步渲染器各一次，同一轮微任务里
  排队的次数小于 100，旧代码超过上限 10,000；Select All、Mod-End/Home、Shift-Mod-End、Escape；文末和文首的块；
  搜索面板；相邻的错误；别的块的预览 DOM；抛错的扫描器；落地的渲染只重画一个块；只画视口附近），在旧代码上
  全部失败。全部测试：LaTeX Live 344 个通过，obsidian-tinymist 241 个通过（1 个跳过）。
- 无头 Chrome（`scripts/browser-smoke.mjs`，MathJax 3.2.2）：21/21 通过。B1 新增的 6 项在旧代码上都失败（文末的块
  `5 5 5 5`、文首的块 `1 1 1 1`、全选 `[0,50]`（全文 73）、Cmd-ArrowDown 停在第 2 行等），现在逐行 `2 3 4 5`、
  `4 3 2 1`，全选 `[0,73]`。B5 换成 `scripts/gen-perf-fixture.mjs` 生成的 5,700 行章节（每节的公式都不同）：挂载
  20–22 ms、打字 p95 3.4–3.7 ms、在展开的 equation 里打字到下方预览重画完 p50 2.8–3.1 ms、p95 4.5–5.0 ms（旧代码
  4.4–6.6 / 6.8–9.9 ms）、光标移动 p50 0.2 ms（旧代码 0.4–0.6 ms）、滚 20 屏帧 p90 16.7 ms；3000 行、公式都不在缓存
  里时按住鼠标滚轮，页面照常响应（旧代码卡死）。obsidian-tinymist 的 Typst 编辑器栈上每行都有构造的 5,700 行
  章节（约 12,500 个替换）：光标移动 p50 0.2–0.3 ms（旧代码 1.1–1.3 ms），打字 p95 9.4–10.9 ms（旧代码 7.5–9.9 ms，
  测量间波动；替换按行分开让一次重建多 0.5 ms，视图那边的比较少了）。

## LaTeX 的实时预览（P2，2026-09-29）

编辑器标题栏的书本图标（或命令 “Toggle live preview”，没有默认快捷键；Mod-E 仍然开关预览窗格）把一个
LaTeX 编辑器切到实时预览：公式原地渲染，光标碰到时显示源码。每个视图记住自己的模式（写在视图状态里，
重启后恢复；在同一个视图里打开别的文件时模式不变）；新视图的模式来自设置 “Default editing mode”（默认 Source）。

- **构造**（`latexLive.ts`，只有公式，P3 之后才有标题、引用等）：`$..$`、`\(..\)` 是行内部件；`\[..\]`、`$$..$$`
  和数学环境（equation、align、gather、multline、flalign、alignat、eqnarray、displaymath，带星号的也算）独占整行
  （首行之前、末行之后只有空白或注释）时是块部件，在正文里是行内的显示部件。行内公式单独占一行也不是块
  （扫描器的 `block` 以前对 `$x$` 独占一行的情况也是真）。导言区、注释、verbatim、`\verb` 不装饰；MathJax
  画不了的（tikz-cd、`\intertext`、读不了的宏）保留源码，加虚线下划线，悬停显示 MathJax 的报错。
- **编号**：请求里带的是 `prepareMath` 处理过的公式（`\label` 按根文档上次编译的 `.aux` 变成 `\tag{n}`，公式里的
  `\ref`/`\eqref` 变成编号），所以渲染器的纪元只是定义语句的哈希（`ProjectMath.epoch`）。编译完成后编号变了，
  `TexRender` 通知使用这个根文档的视图重建，只有文字变了的公式重新渲染；定义变了（保存或编辑定义行）换一个
  MathJax 实例、换纪元，全部重新渲染。同一个根文档的视图共用一个渲染器（`rendererFor(root)`）和它的缓存。
- **预载**：第一次进入实时模式前先载入 MathJax、渲染一次热身、`finishRenderMath`、等字体就绪（`preload`），
  这之前视图显示源码；之后切换是一次 compartment 重新配置，撤销历史、光标、滚动位置不变。
- **限制**：超过 10,000 行的文档不进实时模式（切换时提示；按默认设置打开时退回 Source）；`.sty`/`.cls` 没有构造。
  texlab 的悬停和渲染悬停都不出现在实时部件上。

验证（2026-09-29，不入库的脚本在 scratchpad）：

- 测试：T-L5（`tests/latexLive.test.ts`，真实的编辑器栈和 Obsidian 的 MathJax）：#1–#4、块和行内的判断、`\label` 变
  `\tag`、带星号不编号、展开后下方的渲染带编号、导言区和注释不装饰、编译错误所在行保留源码、编号变化只重画变了的
  公式、定义变化后重画、方向键经 keyArbiter 走进块；`tests/texView.test.ts`：默认模式、标题栏按钮和命令、视图状态
  恢复、同一视图换文件保持模式、10,000 行限制、`HistoryCache` 按模式恢复。
- 合成项目的新拷贝，先用插件自己的 `Compiler` 编译（elegantbook XeLaTeX 10 页、latex-article pdfLaTeX 3 页、测试夹具），
  再在 jsdom 里把每个 `.tex` 以实时模式挂到真实的编辑器栈上（`TexRender` 的渲染器）：latex-elegantbook 136 个公式
  134 个渲染（ch2 的 tikz-cd、ch3 的 `\intertext` 保留源码），带编号的环境 14/14 显示 `.aux` 里的编号；latex-article
  47 个中 43 个（`\set{..}[..]` 两处、tikzpicture 里的 `$\t$`、`\intertext`）；测试夹具 30 个中 28 个。多文件流程：
  在 ch1 开头插入带 `\label` 的 equation 并重新编译，5 个编号变化（新的 1.1，后面四个各加一），只重新渲染这 4 个公式，
  同时打开、共用渲染器的 ch2、ch3 等视图一个也不重画；在 macros.tex 里未保存地改 `\R` 的定义，500 ms 后所有打开的
  视图里的公式换成新定义（119 次渲染）。
- 无头 Chrome，Obsidian 的 app.css（深色）、插件的 styles.css、Obsidian 的 MathJax 包：elegantbook 三章实时模式下
  行号和行的偏差 0 px；ch1（98 行，6 个块）从第 1 行按 ArrowDown 到末行、再按 ArrowUp 回来，每一行都按顺序经过；
  3000 行的生成章节：挂载 6.4 ms（源码模式 2.8 ms）、在公式所在行打字 p95 4.4 ms（1.5 ms）、光标移动 p50 0.3 ms、
  滚 20 屏帧 p90 17.3 ms（16.9 ms）、全文 1750 个公式预取完 0.9 s、切到实时 5.1 ms、切回源码 3.1 ms。

## LaTeX 的实时预览：文本构造（P3，2026-09-29）

实时模式下除了公式，正文里的这些构造也原地显示（design 4.4 #5–#11），光标碰到时显示源码：

- **标题**：行首的 `\part` … `\subparagraph`（带星号也算），`{title}` 在同一行闭合。整行用 `lsp-lp-h1`…`h6` 的字号
  （展开时也保留）；`\section{`、可选的 `[short]` 和结尾的 `}` 隐藏，光标碰到命令或结尾大括号时才显示。
- **强调**：`\textbf`、`\textit`、`\emph`、`\underline`、`\texttt`、`\textsc`，参数在一行内闭合且非空。内容加样式，
  命令和大括号隐藏；光标碰到整个构造时显示源码，样式保留。可以嵌套（`\emph{x \textbf{y}}`、标题里的公式）。
- **列表**：itemize、enumerate、description 里的 `\item` 换成 LaTeX 排出来的标记：itemize 按层级 • ◦ ▪，enumerate
  按层级 1. / (a) / i. / A.，`\begin{enumerate}[(a)]` 这类 enumerate 宏包简写和 enumitem 的 `label=(\roman*)`、
  `start=3`（`nosep` 这类只有键的选项不当简写）、`resume`/`resume*`/`series=`/`resume=`（规则和 enumitem 一样：
  `resume` 接着同一层列表里或外面最后结束的同名列表，`resume*` 的列表结束时只存编号），列表里的
  `\setcounter`/`\addtocounter`/`\stepcounter{enumi..iv}`，`\item[x]` 显示 x 且不计数，description 的条目名加粗；
  标记里的颜色、`\hspace` 这类不排字的参数去掉（`label=\textcolor{blue}{\arabic*}.` 是 “1.”）。标签里有公式或引用时
  （`\item[$\sigma$-代数]`）不换成标记：只隐藏 `\item[` 和 `]`，标签原地显示（条目名加粗）、公式渲染，光标碰到
  `\item[` 或 `]` 时两边一起显示。只有光标
  碰到 `\item` 本身才显示源码，所以在它后面打字时标记不变；Enter 续行（`latexEnter`）后新条目立刻显示下一个编号。
  列表和 center 独占一行的 `\begin`/`\end` 行折叠（没有部件的块替换），光标在那一行时展开；上下方向键经
  `enterBlocks` 一行一行走进去。
- **引用**：`\ref`、`\eqref`、`\pageref`、`\autoref`、`\cref`、`\Cref`、`\nameref` 显示为标签，文字就是 PDF 印出来的：
  编号（`.aux` 里的编号字段经 `texText`：elegantbook 条目的 `{\color {structurecolor}1.}` 是 “1.”）、`(编号)`、页码、
  标题。`\autoref` 用 hyperref 按锚点类型给的名字（`Equation 1.2`、`section 1`、`item 1.`，项目里的
  `\<type>autorefname` 优先；hyperref 没有名字的类型只显示编号，比如 elegantbook 的 tcolorbox 定理
  `tcb@cnt@theorem`、自己计数的 amsthm 定理）。`\cref`/`\Cref` 按 `.aux` 里 cleveref 孪生标签的类型（`section`、
  `subequation`、`enumii`；没有 cleveref 时用锚点的计数器）：同类型的放一组，组按第一次出现的顺序，组内按编号
  排序，三个以上连续编号写成区间，多个时用复数，`and` 连接（`eqs. (1) to (3) and (5)`、`section 1, theorem 1.1,
  and fig. 1`）；名字来自 cleveref 的英文默认名、`capitalise`/`noabbrev` 选项、`\newtheorem` 的标题（只有单数）、
  `\crefname`/`\Crefname`（只给一个时另一个跟着变大小写），`subsection` 这类没有名字的类型用上一级的。cleveref
  叫不出名字的类型显示 `??1`（警告色，和 PDF 一样）。elegantbook `lang=cn` 时 PDF 里也是英文名（ctex 和 elegantbook
  都不定义），所以标签不再换成 `定理 1.1`、`式 (1.1)`。上次编译里没有的标签显示 `??`（警告色）。
  公式里的这些命令也换成同样的文字（`prepareMath` 的 `refs`，悬停和实时部件一致）。
- **文献**：`\cite`、`\citep`、`\citet`、`\parencite`、`\textcite`、`\autocite`，natbib 和 biblatex 的大写形式
  （`\Citet`、`\Citep`、`\Parencite`…）和 `\citealt`、`\citealp`、`\footcite`（带前后注）显示为
  `[see Li et al. 2019, p. 3]`：第一作者的姓，两位作者 “A and B”，三位以上或 `and others` 用 “et al.”；
  中文作者 “张三、李四”“王五等”；年份来自 `year`，否则取 `date` 的年份。.bib 里没有的键原样显示（警告色）；
  标签的提示框写出每个键的作者、年份和标题。
- **`\label`**（公式外）：淡色的键名标签。
- 导言区、注释、verbatim（含 tcblisting、fancyvrb、filecontents）、行首 `\iffalse` 到 `\fi` 的块、定义（`\newcommand`
  等，宏文件没有 `\begin{document}` 也不会被装饰）、`\footnote` 命令本身、定理框和图表环境（P4）、TikZ 图（P5）不装饰；
  根文档在 `\begin{document}` 之前 `\input` 的文件（`preambleFiles`：拆出去的 `setup.tex` 里的 `\hypersetup`、`\tcbset`、
  `\setlist`、`\title{$L^2$}`）整个没有构造，和 `.sty`/`.cls`/`.bib` 一样；带错误诊断的构造保留源码。

**数据从哪来**（`TexRender.refsOf(root)`，不需要 MathJax）：构建目录下 `**/*.aux` 的 `\newlabel`（`\include` 的
`chapters/*.aux` 也读，elegantbook 的 `{title}{label}` 隐式标签只有 .aux 里有）；项目源文件里 `\addbibresource`/
`\bibliography` 指向的 .bib（按修改时间缓存，编辑器里未保存的内容优先）；项目源文件里的引用名（`refNames`：
cleveref 的选项、`\crefname`/`\Crefname`、`\newtheorem`、`\<type>autorefname`）。
每次编译结果后重读标签；打开这个根文档的文件时（别处编译过）、保存项目文件或 .bib（300 ms）、编辑 .bib 或书目/
`\documentclass`/cleveref/`\crefname`/`\newtheorem`/`autorefname` 行（500 ms）时全部重读。内容没变就不换对象、不通知；变了才让用这个根文档渲染器的视图重建
（编号不变时 `numbers` 保持同一个对象，公式不重新渲染）。

验证（2026-09-29，不入库的脚本在 scratchpad）：

- 测试：T-L6（`tests/aux.test.ts`：elegantbook 的 `chapters/*.aux` 和 tcolorbox 锚点、cleveref 文章的
  `@cref` 类型、AMS 标签、Item、脚注、附录）；T-L7（`tests/bib.test.ts`：et al.、大括号保护、重音、中文名、
  `von`、`date`、@string、引号、`#`、括号形式、重复键、坏条目、`bibFiles`、缓存）；T-L8（`tests/latexLive.test.ts`：
  #5–#11 的显示和展开规则、中英文类型名、编译结果/保存 .bib/打开视图后标签更新、错误诊断、方向键和 Enter）；
  扫描器（层级、简写、enumitem、定义体跳过）、TexRender（refs 的读取时机、悬停里的 `\autoref`）、TexView
  （打开视图重读、.bib 没有构造）的新用例。全部 336 个测试通过；`npm run check`、`npm run build` 通过。
- 合成项目的新拷贝，用插件的 `Compiler` 编译两遍后在 jsdom 里把每个 `.tex` 以实时模式挂到真实编辑器栈上
  （`TexRender` 的 refs 和渲染器）：latex-elegantbook（42 个标签、6 条文献、中文名）、latex-article（pdfLaTeX、
  cleveref、natbib，18 个标签、3 条文献）、测试夹具，所有文件 0 个 `??`、0 个未知文献键；macros.tex 没有构造。
  多文件流程：在 ch1 开头插入 `\begin{theorem}{新定理}{new-first}` 并重新编译，附录视图里的 `\ref{thm:total-exp}`
  从 1.1 变成 1.2（ch3 视图不变，`thm:new-first` 是 1.1）；ch2 引用 .bib 里还没有的 `new2025` 时标签是警告色，
  保存 .bib 后 322 ms 变成 `[孙八等 2025, 第 3 页]`；未保存地改 .bib 的作者，520 ms 后 ch1 的标签变成
  `[张三 2020, 第 2 章]`。
- 无头 Chrome（Obsidian 的 app.css 深色、插件 styles.css、Obsidian 的 MathJax），两个项目的 10 个文件：行号和行的
  偏差都是 0 px；elegantbook ch1（98 行，列表、description、折叠行）、附录（20 行）、文章 results（62 行，
  `enumerate[label=(\roman*)]`）按 ArrowDown 到末行再按 ArrowUp 回来，每一行都按顺序经过。性能：
  3000 行生成章节（250 个标题、250 个 `\eqref` 标签）实时模式挂载 7.2 ms、打字 p95 4.7 ms、光标 p50 0.3 ms、
  滚动帧 p90 16.9 ms、切换 4.6 ms；elegantbook 各章重复成 3000 行（618 个标签、108 个列表标记、72 个折叠行）
  挂载 7.1 ms、在 `\item` 行打字 p95 7.2 ms、光标 p50 0.3 ms、滚动 p90 16.8 ms；5,700 行（1175 个标签）挂载 9.2 ms、
  打字 p95 6.3 ms、光标 p50 0.5 ms、滚动 p90 17.3 ms、切到实时 6.1 ms。共享核心的浏览器冒烟 B1–B5 13/13。

审查修复（2026-09-29，无头部分；不入库的复现和比对脚本在 scratchpad）：

- 标签文字和 PDF 对照：两个合成项目的新拷贝各加一段探针（elegantbook 第 3 章加小节、两层 enumerate 条目、脚注和
  24 个 `\ref`/`\autoref`/`\pageref`/`\eqref`/`\nameref`；latex-article 附录加同样的探针和 32 个 `\cref`/`\Cref`/`\autoref`/…），
  用插件的 `Compiler` 编译（XeLaTeX、pdfLaTeX），Ghostscript 取出 PDF 里每个引用印出的文字，和实时模式下的标签比：
  修复前 elegantbook 16 个、latex-article 17 个不一致（`structurecolor1.`、`定理 1.1` 对 PDF 的 `1.1`、
  `theorem 2.1` 对 `Theorem 2.1`、`figure 1, 2` 对 `Figures 1 and 2`、`appendix A` 对 `Section A`），现在引用全部一致
  （`\nameref` 的中文标题 Ghostscript 取不出来，标签是对的；文献标签按设计是 “作者 年份”）。
- `tests/latexRefs.test.ts`：合成探针 `tests/fixtures/aux/cleveref/probe.tex` 在四种导言区（默认、`capitalise,noabbrev`、
  `capitalize`、`noabbrev` 加 `\crefname`/`\Crefname`/`\<type>autorefname`）下 pdfLaTeX 印出的 45 × 4 个引用文字，
  标签全部相同（分组、排序、区间、复数、`, and`、类型名、没有名字的类型只印编号）。
- enumitem：`resume`、`resume*`（带和不带 `start=`）、`series=`/`resume=`/`resume*=`/只写系列名、嵌套列表的 `resume`、
  `\setcounter`/`\addtocounter`/`\stepcounter` 五组，扫描器给的标记和 pdfLaTeX 排出的 22 个编号逐个相同。
- TikZ：elegantbook 的 `figures/tikz-projection.tex` 从 7 个构造（calc 坐标 `($(O)!(Y)!(X)$)` 被画成公式、6 个节点公式）
  变成 0 个；latex-article `results.tex` 的 tikzpicture 里从 4 个（3 个公式，含带虚线下划线的 `$\t$`，和一个 `\eqref`）
  变成 0 个。公式语料因此变成 latex-elegantbook 127/129、latex-article 41/44（剩下的仍是 tikz-cd、`\intertext`、
  `\set{..}[..]`）。
- 拆开的导言区：`preambleFiles` 在 elegantbook 上只认出 `macros.tex`，latex-article 没有；合成的 `setup/preamble.tex`
  和它再 `\input` 的 `setup/boxes.tex` 在实时模式下没有部件和样式（修复前 3 处），章节照常渲染（`tests/texView.test.ts`）。
- 测试：新增的 15 个用例（`tests/latexRefs.test.ts` 4 个，扫描器 6 个，高亮 2 个，T-L8 的原地 `\item` 标签，
  `preambleFiles`，TexView 的导言区文件）在修复前的代码上都失败；全部 359 个测试通过，`npm run check`、
  `npm run build`、`test:yolo`（18/18）通过。GUI 检查仍然待做。
