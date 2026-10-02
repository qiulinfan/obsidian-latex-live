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
  - `fragment.ts`：悬停的真实 TeX 片段编译（P6）：用根文档的引擎和导言区（pdfLaTeX 用编译留下的导言区格式）在
    构建目录的 `snippets/` 里编译一个 preview 环境，按内容哈希缓存，每个主文件一个队列。
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
- 悬停渲染先用 MathJax 3.2.2；tikz-cd、`\intertext`、`\llbracket`、`\oiint` 这类它画不出来的，预览开着、公式和上次编译时
  一样时是 PDF 裁剪（见下面 P5 一条），否则是真实 TeX 的片段编译（P6，见下文；关掉设置时显示 MathJax 的报错和源码）。
  TikZ 图（tikzpicture、tikzcd、pgfpicture、circuitikz）里的节点公式不扫描，整个图是一个裁剪。没有 `\label` 的编号行不显示编号
  （MathJax 的 tags 是关的；片段编译也一样，用带星号的环境加 `\tag`）。定义体里用到带 `@` 的内部命令的宏（本地宏包里常见）和
  `m o` 这类 `\newcommand` 表达不了的 xparse 参数说明，MathJax 报“MathJax cannot read the project's \set: …”，然后由片段编译
  画出来，不会退回 MathJax 自带的同名命令（braket 的 `\set` 会画出 `{M}[…]`）；
  `\makeatletter` 块里定义的命令仍然跳过。公式里的 `\ref` 一族（`\cref`、`\autoref`、`\pageref`、`\nameref`）
  和实时预览的标签一样换成文字（P3）。
  `\providecommand` 只看项目里前面有没有定义过同名命令，不看 MathJax 自带的命令。
- 实时预览的文本构造（P3）：标题的 `{title}`、强调命令的参数、`\item[..]` 的标签都必须在同一行里闭合；
  `\autoref`/`\cref` 的类型名只按 hyperref、cleveref 的英文默认名，加上项目里的 `\<type>autorefname`、
  `\crefname`/`\Crefname`、`\newtheorem` 标题和 cleveref 的 `capitalise`/`noabbrev` 算：babel 的其他语言名、
  `\creflabelformat`、cleveref 的 `nosort`/`nocompress`、hyperref 退回的 `\<type>name`（listings 和定理表里有名字的
  环境之外）都不跟；
  中文文档也是英文名（ctex 和 elegantbook 都不定义，PDF 里就是这样）。引用标签总是 “作者 年份”，不跟
  biblatex/natbib 的数字样式；`\S`、`\term{..}` 这类命令保留源码。定义（`\newcommand` 等）一直跳到第一个
  大括号外的换行，同一行后面的内容也不装饰。`\iffalse` 只在行首时当注释跳过（`\let\ifx\iffalse` 是代码）；
  打到一半、还没有 `\fi` 的 `\iffalse` 一直跳到文末，和 TeX 一样。enumitem 的 `resume` 只跟列表的嵌套，
  不跟定理之类别的环境的分组（enumitem 在那里恢复不到）。
- 实时预览的定理框和图片（P4）：定理框的 `\begin`（参数和紧跟的 `\label` 可以在同一行）和 `\end` 必须各自独占一行、
  在 200 行内闭合；编号来自 .aux 里这个框的标签（elegantbook 的 `{title}{label}`，或 `\begin` 行上、下一行开头的
  `\label`）；没有标签的框只在 `\include` 进来的章节里、且那一章 .aux 的 `\@setckpt` 计数对得上时按位置数出编号
  （见下文“P4–P6 的审查修复”），`\input` 进来的文件、单文件文档、`thmcnt=section`、打字后多出来还没编译的框只显示名字；
  elegantbook 的语言
  只分 cn 和其他（其他语言用英文名），`nocolor` 用默认强调色；thmtools 的 `\declaretheorem`、ntheorem 和不在项目
  目录里的宏包定义的定理环境不认；amsthm 的 `\qedsymbol` 改了也显示 □；elegantbook 的 `example` 在 PDF 里编号和标题
  之间没有空格，这里加了一个。图片只认独占一行的 `\includegraphics`，按主文件目录和最后一个 `\graphicspath` 找
  （不查 TEXINPUTS：路径里有宏、或者项目里找不到的不带路径的名字保留源码、不加虚线下划线，TeX 可能在它自己的目录树里
  找到，比如 mwe 的 `example-image-a`），`trim`/`clip`/`angle`/`page` 等选项不跟；vault 外的位图、eps 不显示（保留源码和
  虚线下划线）；PDF 只显示第一页、白底。PDF 的第一页是异步画的（画的时候公式照常渲染，异步渲染按种类排队）。
- PDF 裁剪（P5）：要开着预览（会话里才有编译开始时的源文件快照），块的文本要和那时磁盘上的一样（改过、编译开始时
  没打开的文件、预览关着都不裁）。tcolorbox（elegantbook fancy 模式的定理框）里面的块不单独裁：pgf 移动了框里的内容，
  SyncTeX 报的位置低约 20 pt；框里的显示公式悬停用 MathJax，框里的图悬停显示整个框。实时预览只裁 TikZ 图、表格和
  MathJax 拒绝的独占整行的显示公式；行内公式从不裁（SyncTeX 只到行）。跨页的块只裁第一页。几何规则是在两本合成书和
  一个 pdfLaTeX 文档上量出来的（见下文 P5 一节）：在分页处、不在正文里的 TikZ 图和表格可能带进上一页送出时留下的盒子；
  用 PDF 变换缩放的块（`\resizebox`、adjustbox、graphicx 的 `width=`）SyncTeX 记录的是原始尺寸，只靠前后行限制。
  裁剪第一次画时是异步的（35–70 ms，裁剪一次画一个，公式照常渲染）；画好以后是同步的。上一行正文的字形墨迹伸到它的
  TeX 深度以下时（Fandol），裁剪顶边可能带一点墨点（没处理：要按墨迹裁掉贴着顶边的一条，需要在 Chrome 里核对）。
- 片段编译（P6）：只给悬停用（实时预览和光标处预览不用：每次按键编译太贵）。片段按自己的计数器编号：定理框取实时预览
  框头的编号（标签的 .aux 编号，或 `\include` 的章节里数出来的编号），都没有时从 0 编起（`\input` 进来的文件里没加标签的
  elegantbook `例题` 显示 0.1）；浮动体只在 `.aux` 里有它的标签时取那个编号；带编号的公式只给有标签的行
  `\tag`，`eqnarray` 从 1 编起；引用文献只到 `.aux` 的标签，`\cite` 显示键名（biblatex/BibTeX 的数据不带进来）。正文里的定义
  取项目里所有正文文件的（和 MathJax 的定义一样按文档顺序，不看片段在哪一行），能重定义已有的命令；导言区只用根文档的
  （`\input` 的文件照读）。不传 `-shell-escape`（minted 的片段失败）。XeLaTeX/LuaLaTeX 每次读整个导言区，约 1.3–1.5 s；
  pdfLaTeX 只有 “Cache the preamble” 开着、编译留下了对当前导言区就绪的格式时才快（约 0.3 s），否则约 0.5 s。

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
- [x] P1 悬停渲染（源码模式，2026-09-29）：项目宏的私有 MathJax 实例、数学扫描、悬停在 texlab 之前。
      GUI 检查 H1–H4 在 Obsidian 里做过（2026-09-29，courses vault 的 elegantbook 合成书）。
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
  - [ ] 完整 GUI 矩阵 L1–L9、L14–L16。2026-09-30 补测了真实中文组字、5891 行章节、190 行定理和光标预览；
        跨块原生拖选未完成。用户认可现有验证作为阶段基线，后续集中 LaTeX 开发；不把未测项记成通过。
- [x] P3 文本构造：标题、强调、列表、`\ref`/`\cite` 标签（aux、bib）。
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
  - [x] GUI 检查 L11（2026-09-29，Obsidian：elegantbook 合成书 ch2 的 `式~(1.4)`、`第~1 章`、`[王五 2022]`）。
- [x] P4 定理框（BlockWrapper）和图片。
  - [x] LaTeX 的定理框、图表行和图片（2026-09-29，无头部分；见下文“LaTeX 的实时预览：定理框与图片（P4）”）：
        定理表 `src/tex/theorems.ts`（amsthm 的 proof、`\newtheorem`/`\newtheorem*`、`\elegantnewtheorem`、elegantbook
        的内置表：标签前缀、defstyle/thmstyle/prostyle、五种配色、lang=cn 的中文名，和装好的 elegantbook.cls 对过），
        随引用数据一起按主文件缓存、改了就重读；`latexScan.ts` 的 `env`（`\begin`/`\end` 各自独占一行的环境）和
        `image` 构造，figure/table 的 `\begin`/`\end` 行折叠；`latexLive.ts` 的定理框（BlockWrapper、框头、`\end`
        行折叠、amsthm 证明的 □）和图片部件（`src/tex/graphics.ts` 按 `\graphicspath` 和 graphicx 的扩展名找文件，
        vault 里的文件走 Obsidian 的资源地址，PDF 用 pdf.js 画第一页）；`\autoref` 跟 hyperref 退回的 `\<type>name`
        （elegantbook simple 模式的 `定义 1.1`）；扫描器的递归有深度上限（R6）。测试 T-L9（`tests/theorems.test.ts`、
        `tests/latexLive.test.ts`）、扫描器和引用的新用例，浏览器冒烟 B6。
  - [x] P4 的审查修复（2026-09-29，无头部分；见下文“P4–P6 的审查修复（LaTeX Live）”）：没有标签的框在 `\include` 的章节里
        按 .aux 的 `\@setckpt` 核对后数出编号（`例题 1.1`、`定理 4.1`、附录的 `A.1`）；环境不收的参数留作文字
        （elegantbook 的 `\begin{proof}[另一种证明]`）；`loss_lr0.01` 这类名字按 graphicx 补扩展名；路径里有宏、不带路径的
        名字找不到时不再标错；elegantbook 的 `problemset` 按 enumerate 编号、行折叠；扫描器在没闭合的 `\text{$` 嵌套上
        不再指数级变慢。
  - [x] 光标在很长的环境里移动不再整篇重建（R1，2026-09-29，无头部分；见下文“P4–P6 的审查修复（LaTeX Live）”）：共享核心的
        `LiveLanguage.reveals`，除裁剪外的 `env` 只在 `\begin`、`\end` 两行看光标；3192 行章节里 190 行的环境中移动 p50
        0.3–0.4 ms、每次 6 次 decorate（以前 7.0–7.4 ms、6571 次）。测试 T-S5 的新用例、T-L9 的长框用例，浏览器冒烟 B5 的长框。
  - [x] GUI 检查 L12（2026-09-29，Obsidian：ch1 的 `定义 1.1 (概率空间 Probability space)`、`笔记` 框按配色、编号来自 .aux）。
- [x] P5 从上次编译的 PDF 裁剪（SyncTeX + pdf.js）。
  - [x] LaTeX 的 PDF 裁剪（2026-09-29，无头部分；见下文“LaTeX 的 PDF 裁剪（P5）”）：`synctex.ts` 的 `forwardSearchAll`
        （一行的全部记录）；会话在编译开始时读打开的本项目文件，写出 PDF 的结果带着这份快照（`session.compiled`）；
        `src/preview/blockCrop.ts`（按文本找回编译时的行号，SyncTeX 记录按量出来的规则合成区域，最多 4 个 synctex、
        2 s 超时、编译中不开始，按结果缓存，每个结果一个 pdf.js 文档，按设备像素比画出再裁到墨迹，纸卡片和反色）；
        `main.ts` 的 `sessionFor(root)`；悬停链（显示公式：裁剪 → MathJax；定理类、TikZ 图、表格、浮动体：裁剪 →
        “Changed since the last compile.”）；实时预览的 #4 和 #14（裁剪块部件，新结果的裁剪到之前保留旧的）。测试
        T-L10–T-L12（`tests/crop.test.ts`，真实 XeLaTeX）和实时、悬停、扫描器的新用例。
  - [x] P5 的审查修复（2026-09-29，无头部分；见下文“P4–P6 的审查修复（LaTeX Live）”）：编译进行时照样裁上一次结果
        （第二遍和排队的编译期间裁剪不再退回源码，悬停不再等）；跨页的 tcolorbox 定理框不再带上整页；公式的 `\begin`
        行当作前一行（段落最后一行不再露进裁剪顶边）；相同文本的块各自取最近的一处；SyncTeX 超时不再当成没有记录。
  - [x] GUI 检查 H5、H6、L13（2026-09-29，Obsidian）：源码模式悬停 tikz-cd 是 PDF 裁剪，改动保存后重新编译、悬停跟着变；
        ch3 定理 3.1 的悬停裁剪带框、中文标题、编号 (3.2)；实时模式的 tikz-cd 和表格是裁剪块。实测发现并修好：编译开始时
        没打开的章节（之后才打开）一直没有裁剪，见 P7。
- [x] P6 真实 TeX 片段编译兜底、光标处预览。
  - [x] LaTeX 的片段编译和光标处预览（2026-09-29，无头部分；见下文“片段编译与光标处预览（P6）”）：`src/tex/fragment.ts`
        （pdfLaTeX 用编译留下的导言区格式，`-fmt=<job>-preamble` 加 `TEXFORMATS`，格式旁的戳记说明它对哪个导言区就绪；
        XeLaTeX/LuaLaTeX 或没有格式时读整个导言区，带看门狗；preview 宏包 `active,tightpage,auctex`；片段用到的 `.aux` 标签
        `\global\@namedef{r@k}`；正文里的定义（章节自己的 `\newcommand`）；按日志里的 `Preview: Snippet n ended.(h+dxw)`
        取盒子；每个主文件一个队列，新的替换等着的；按内容哈希缓存在 `<构建目录>/snippets`；中止、超时、会话关闭、插件卸载时
        杀进程组；只写 `$TMPDIR`），`src/preview/fragments.ts`（用 Obsidian 的 pdf.js 画成纸卡片，反色和裁剪一样），悬停链的
        片段一步（MathJax 失败且没有新鲜裁剪时；设置 “Compile what the hover cannot render”，`texFragmentFallback`，默认开），
        光标处预览（共享的 `cursorPreview`，设置 “Preview the formula at the cursor”，`cursorPreview`，默认关）。测试 T-L13、T-L14
        （`tests/fragment.test.ts`，真实 pdfLaTeX 和 XeLaTeX）和源码、日志、定义、队列、悬停链、片段正文、光标处预览的新用例。
  - [x] GUI 检查 H11、H13（2026-09-29，Obsidian）：article 的 `\intertext` align 悬停显示排版好的块和编号 (4)；
        打开光标处预览后在 `$y^2_k+1$` 里打字，下方的渲染跟着更新。
  - [x] P6 的审查修复（2026-09-29，无头部分；见下文“P4–P6 的审查修复（LaTeX Live）”）：插件卸载或预览关闭时正在等格式检查的
        悬停不再启动 TeX；片段读的 `\input` 文件和图片改了会重新编译；中止或起不来的运行不留文件，`frag-*.aux` 不当成文档的
        标签；“Render formulas on hover” 的说明写全裁剪和片段编译。
  - [x] P4–P6 共享核心的审查修复（2026-09-29，无头部分，两个仓库相同；见下文“共享核心的审查修复（P4–P6）”）：
        图片和裁剪的请求不带纪元（改宏不再重画 PDF 图和裁剪）；异步渲染按种类排队（裁剪或 PDF 页在画的时候公式照样渲染）；
        展开的块里有错误诊断时下方的渲染保留（标 `is-error`）；光标处预览挂在公式最后一个视觉行下面（折行的公式不再盖住
        正在打的那一行），实时预览不装饰时（超过 maxLines）显示公式也有；窗格底边、绘制的视口止于块时 ArrowDown 不再多跳
        一行；深色主题下 `color=black` 的框头看得清。测试 T-S7、T-S9、T-S11、T-S13 的新用例、T-L9 的新断言，浏览器冒烟 B7、B8。
        之后（TY-R1 的第二种情况）：CodeMirror 因为下面放不下把光标处预览翻到上面时，浮层在构造第一行的上面，不再盖住
        显示公式的下半部分和正在打的那一行；B8 加了这种情况。
- [x] P7 复杂环境（多文件、elegantbook 模板）上的验证（2026-09-29，Obsidian 1.13.7，courses vault 的
      `_editor-test/` 合成项目：elegantbook 多文件书（XeLaTeX、中文）、article（pdfLaTeX、cleveref、natbib）、
      Typst 模板书）。上面各阶段的 GUI 检查加上：实时模式和悬停在三个项目里都没有控制台错误；Typst 的实时模式、
      纸面悬停（见 obsidian-tinymist 的 roadmap）。实测数字见各阶段的无头和浏览器冒烟记录。
  - [x] 实测修复：会话只在编译开始时读打开着的本项目文件，之后才打开的章节找不到编译时的文本，实时模式和悬停
        一直没有裁剪，直到下次编译。`CompiledPdf.source(file)`（`compiledSources`）：打开的文件照旧在开始时读，
        其余本项目文件第一次用到时从磁盘读，前提是编译开始后没写过（写过就不知道，下次编译再有）。测试在
        `tests/crop.test.ts` 的会话用例里。

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
  等，宏文件没有 `\begin{document}` 也不会被装饰）、`\footnote` 命令本身、TikZ 图和表格（P5）不装饰（定理框和图表环境
  见下文 P4）；
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

## LaTeX 的实时预览：定理框与图片（P4，2026-09-29）

实时模式下再加三类构造（design 4.4 #12、#8 的 figure/table、#13），光标规则和前面一样：

- **定理框**：项目的定理表（`src/tex/theorems.ts`，纯函数，输入是项目源文件去掉注释后的文本，主文件在前）里的环境，
  `\begin`（连同同一行的参数和紧跟的 `\label`）和 `\end` 各自独占一行时，整段画成一个 BlockWrapper 框
  （`lsp-lp-box`，颜色角色 `is-main|is-second|is-third`，elegantbook 的配色写进 `--lp-box-color`；上下外边距和内边距都是 0，
  间距只靠行）。`\begin` 行显示 PDF 印出来的框头：`定理 1.1 (全期望公式)`（elegantbook）、`Theorem 2.1 (Cauchy–Schwarz).`
  （amsthm 带句点）、`例题 1.1 抛硬币`（elegantbook 的 example 标题跟在编号后）、`Proof.`/`Proof of theorem 2.1.`（amsthm 的
  proof，可选参数替换名字）、`证明`；编号来自 .aux 里这个框的标签：elegantbook 的 `{title}{label}` 按前缀变成 `thm:label`，
  否则是 `\begin` 行上或下一行开头的 `\label`。标题里有公式或引用时不换成文字：标题留在原处（和框头一个样式），两边的
  框头部分是标签，公式照常渲染。`\end` 行折叠；amsthm 的 proof 在那一行靠右显示 □（elegantbook 的 proof 没有结束符）。
  光标在 `\begin` 行或 `\end` 行上时只有那一行显示源码；正文是普通文字，在里面打字框不变；框可以嵌套；不在定理表里的
  环境（`unknown`、`minipage`、`abstract`…）保持源码；某一行有错误诊断时那一行保持源码，框还在。
- **定理表**：amsthm 的 proof（ctex 的类或 ctex 宏包时叫 证明）；`\newtheorem{env}[shared]{Title}[within]` 编号、
  `\newtheorem*` 不编号，用 amsthm（或 AMS 文档类）时框头带句点；elegantbook 的七个 tcolorbox 定理（参数 `g o t\label g`，
  前缀 thm/def/pos/axi/cor/lem/pro，defstyle=main、thmstyle=second、prostyle=third）和它们的带星号形式，simple 模式下是
  amsthm 定理；example/exercise/problem（编号）、note、proof、solution、remark、assumption、conclusion、property、
  custom{名字}；名字按 `lang=cn`（中文）或其他（英文）；配色按 `color=green|cyan|blue|gray|black` 或裸的配色名，
  默认 blue（`\DeclareStringOption[blue]{color}`，所以合成书的框是 main 0,166,82、second 255,134,24、third 0,174,247）；
  `\elegantnewtheorem{env}{名字}{style}{prefix}`（前缀缺省是环境名）。`tests/theorems.test.ts` 把这张表和装好的
  elegantbook.cls（v4.6）逐项对照：五种配色的 RGB、cn/en 的 17 个名字、七个定理的前缀和样式。
  定理表和引用数据一起读（`TexRender.refsOf(root).theorems`）：项目文件保存后 300 ms、改到 `\documentclass`、
  `\usepackage`、`\newtheorem`、`\elegantnewtheorem`、`\graphicspath` 这些行后 500 ms 重读，内容不变就不换对象。
- **引用的类型名**（P3 推迟的一项）：用合成探针对过 PDF（TeX Live 2026）：`\newtheorem{thm}{Theorem}` 的 `\autoref` 只印编号
  （amsthm 不定义 `\thmname`，hyperref 没有名字可退），所以标签本来就对；hyperref 找不到 `\<type>autorefname` 时退回
  `\<type>name`，elegantbook 在 simple 模式下锚点是 `definition.1.1`，印 `定义 1.1`（`\theoremautorefname` 是 hyperref 的
  Theorem，优先）；fancy 模式的锚点是 `tcb@cnt@definition`，只印编号；elegantbook 的框用 cleveref 时印 `?? 1.1`。
  现在 `refNames` 从定理表取 `\<env>name`（有名字的环境）和 cleveref 用的 `\newtheorem` 标题，这几种都和 PDF 一致。
- **图表行**：figure、figure*、table、table* 独占一行的 `\begin`（带 `[htbp]`）和 `\end` 行像列表一样折叠。
- **图片**：独占一行的 `\includegraphics[..]{f}` 换成块部件（最高 320 px），文件按 graphicx 的规则找（`src/tex/graphics.ts`）：
  相对主文件目录，再加最后一个 `\graphicspath` 的前缀；没有扩展名时依次试 pdf、png、jpg、jpeg（和大写）。
  png/jpg/jpeg/gif/svg 用 Obsidian 的资源地址（`app.vault.adapter.getResourcePath`）显示，PDF 用 Obsidian 的 pdf.js
  （带 `PDFJS_ASSETS` 的 cMap）画第一页再转成 PNG；语言模块只拿到注入的 `image(path)`，保持纯函数。找不到的文件、
  不支持的格式（eps）、vault 外的位图保留源码加虚线下划线，提示框写原因。光标在那一行时显示源码，图片留在下面
  （和 Obsidian 的嵌入一样，不跳动）。解析结果按主文件缓存：vault 里新建、删除、重命名文件时清空，保存了某张图时只清它
  （请求里带修改时间，图片重新渲染）。
- **扫描器**：`env` 构造（除列表、center、figure、table、公式、verbatim、TikZ 之外，`\begin`/`\end` 各自独占一行、
  200 行内闭合的环境，带 `\begin` 行上的参数和标签，按名字配对，没闭合的里层环境丢掉）先占住 `\begin` 的位置，
  构造保持文档顺序；参数照常扫描（标题里的公式是构造）。`image` 构造。文字参数里的公式再嵌套文字参数最多 8 层，
  更深的按普通数学读，两万层的病态输入也不会栈溢出（R6）。

验证（2026-09-29，不入库的脚本在 scratchpad 的 `impl-p4/`）：

- 测试：T-L9（`tests/theorems.test.ts` 5 个：`\newtheorem`、elegantbook 的语言/模式/配色、`\elegantnewtheorem`、夹具书、
  和装好的 elegantbook.cls 对照；`tests/latexLive.test.ts` 4 个：夹具书的框头/编号/配色、`\begin`/`\end` 行分别展开和
  正文编辑、amsthm 的句点/□/嵌套/下一行的标签/错误诊断、figure/table 行和图片（PNG、PDF 第一页、找不到、eps、
  `\graphicspath`、新建文件、改了的图重新渲染）），扫描器 3 个（`env` 的参数和标签、图片、深嵌套），`\autoref` 退回
  `\<type>name` 的 1 个；全部 372 个测试通过，`npm run check`、`npm run build`、`test:yolo`（18/18）通过；浏览器冒烟
  25/25（新增 B6：两个紧挨着的框，ArrowDown/ArrowUp 一行一行经过框头、正文、显示公式、折叠的 `\end` 行，行号偏差 0 px）。
- 合成项目的新拷贝，用插件的 `Compiler` 编译两遍后在 jsdom 里把每个 `.tex` 以实时模式挂到真实编辑器栈上：
  latex-elegantbook（XeLaTeX，10 页）ch1–ch3 共 17 个框，编号都来自 .aux（`定义 1.1`、`定理 2.1`、`命题 2.1`、`引理 3.1`、
  `推论 3.1`…），颜色是默认的 blue 配色；latex-article（pdfLaTeX，3 页，本地宏包里的 `\newtheorem` 和 amsthm）5 个框头，
  Ghostscript 从 PDF 取出的文字里全都有（`Definition 2.1 (Linear reconstructor).`、`Lemma 2.2.`、`Proof of Theorem 2.2.`、
  `Theorem 3.1.`、`Remark.`）；三个项目的 3 张图（含没有扩展名的 `figures/heatmap`）都找到。多文件流程：在 ch1 开头插入
  带标签的新定理，编译后 ch1 的框头变成 `定理 1.1 (新定理)`，原来的全期望公式变成 `定理 1.2`；在 main.tex 里保存
  `\elegantnewtheorem{fact}{事实}{prostyle}{fac}`，ch3 里（未保存）新写的 `fact` 框 332 ms 后出现（300 ms 防抖，third 色），
  编译后是 `事实 3.1 (一个事实)`。
- 无头 Chrome（Obsidian 的 app.css 深色、插件 styles.css、Obsidian 的 MathJax 和 pdf.js 5.3.34），同一本书的编译拷贝，
  ch2 另加一张 pdfLaTeX 画的 TikZ PDF 图：ch1（98 行）、ch2（124 行）、ch3（90 行）行号和行的偏差都是 0 px，框的上下
  外边距和内边距都是 0，ArrowDown 到末行、ArrowUp 回首行，每一行都按顺序经过（折行的长行多按几次）；光标在定理的
  `\begin` 行时只有这一行显示源码；heatmap.png 按原尺寸 400×240 显示，PDF 图由 pdf.js 画成 187×149 的 PNG，图片加载后
  偏差仍是 0 px。ch1–ch3 重复成 3121 行（170 个定理类的框、图片）：实时模式挂载 6.5 ms、在框的正文里打字 p95 5.0 ms、
  光标 p50 0.3 ms / p95 1.6 ms、滚 20 屏帧 p90 16.7 ms、切到实时 8.6 ms、切回源码 4.2 ms；ch1 单独光标 p50 0.2 ms、
  框里打字 p95 1.7 ms。
- 和并行修改中的共享核心（obsidian-tinymist 的 `src/editor/shared/`，拷到 scratch 里的仓库副本）一起跑：实时预览相关的
  110 个测试和冒烟 B1、B4、B6 通过。GUI 检查 L12 仍然待做。

## LaTeX 的 PDF 裁剪（P5，2026-09-29）

MathJax 画不了的块（TikZ 图、表格、MathJax 拒绝的显示公式）和悬停时想看 PDF 原样的块（定理框、浮动体），从预览
上一次编译的 PDF 里裁出来（design 4.6、4.8；`src/preview/blockCrop.ts`，不依赖 obsidian 模块，pdf.js 由 main.ts 传入）。
共享核心同时同步到了 obsidian-tinymist 的新版本（新纪元时构造保留旧的渲染直到新的到来、`cursorPreview`），
LaTeX 这边的调用不用改。

- **新鲜度**：会话在每次编译开始时从磁盘读一遍打开在编辑器里的本项目文件（主文件、上次编译的依赖、主文件目录下的
  文件；通常一到三个，不到 1 ms），写出 PDF 的结果带着这份快照（`session.compiled`，`seq` 全局递增）。块只有在它现在的
  文本出现在快照里时才裁：离它现在所在行最近的那一处就是编译时的行号（文本搜索，不做变更映射：上面插入两行后按行号
  查，会查到旁边的块）。改过、编译开始时没打开、没有预览（没有会话）都不裁。
- **SyncTeX 的记录**：`forwardSearchAll` 返回一行的全部记录（原来的 `parseView` 只取第一条）。查块里面的行（最多 12 行：
  前 6 后 6）、`\end` 行，和块前后最近的非空、非注释行；不查 `\begin` 行。在合成书、合成文章和一个手写的 pdfLaTeX 文档上
  逐个渲染出来看过之后定下的规则（`cropRegion`，按 CropKind）：
  - 一行没有排出东西时，SyncTeX 返回邻近行的记录：`\begin{align}` 返回上一行正文；align 的一行续到下一行时，第一行也
    返回上一行正文；浮动体的 `\end{figure}` 返回图后面的正文。和前一行相同（块的 `\end` 行没有）、和后一行相同（块里面
    没有）的记录丢掉。
  - elegantbook 的 tcolorbox 定理框：`\end` 行的记录就是整个框（连标题），框里的内容 SyncTeX 报得比实际低约 20 pt（pgf
    用 PDF 变换移动了内容，SyncTeX 看不到）。所以框只取 `\end` 行，框里的东西不单独裁（latexLive 的 `cropKindOf`）。
    design 为框定的“上 18 pt、下 6 pt”的边距不再需要。
  - tikz-cd 的单元格记录在 TeX 放它们的位置，不在 pgf 画的位置（显示公式里差 (−35, +20) pt），`\end{tikzcd}` 行报告的
    图片框才包住墨迹。图和表取里面的记录，加上 `\end` 行里包住它们的框，但不取段落行（段落中间的 tikz-cd 的 `\end`
    行也报整行，连两边的文字）。
  - 分页时输出例程在读块的时候把上一页送出，那一页的许多盒子都带着块的行号（多行公式正好在分页处时，区域盖满整页）：
    正文里的块（公式、定理类）只取前一行下面的记录；第一页只剩不到 12 pt 的一条时从下一页开始。
  - 公式扩到正文宽度（记录可能缺一边，比如 `A =`）；所有的块上下不越过前后行（边距会带进前后行的下伸部分，tikz-cd 的
    图片框比墨迹高约 20 pt，graphicx 缩放的图 SyncTeX 记录原始尺寸）。
  - 上下 4 pt、左右 1.5 pt 边距，裁到页面内；跨页的只裁第一页，卡片下写 “Continues on the next page”。画出来以后再裁到
    墨迹（非白像素）外加 4 pt：居中在整行里的表格就只剩表格。
- **调度和缓存**：最多 4 个 `synctex view` 同时跑，每个 2 s 超时（超时、被杀或起不来的查询让这个区域失败，下次渲染
  重查，不当成“没有记录”）；编译进行时照样查上一次结果（审查修复后，见下文；原来会话编译时不开始新的查询，实时视图的裁剪
  在第二遍、排队的编译期间退回源码）；`.synctex.gz` 的修改时间不是结果落地时记下的那个（后一遍刚写完）就安静地失败。按结果缓存：区域按（文件、编译时的行号、种类），画好的图按区域，画好之后同步返回（新纪元、反色、悬停都
  不再等）。每个结果一个 pdf.js 文档，第一次用时从 `compiled.pdf.slice()` 加载（带 `PDFJS_ASSETS`），下一个结果或会话
  关闭时销毁。图是 PNG 的 blob URL（实时预览的缓存最多留 2000 个渲染，data URL 会一直占着内存），晚一个结果才撤销。
  插件卸载时杀掉还在跑的 synctex。
- **外观**：白底纸卡片（`lsp-lp-paper`），深色主题下按预览的 “Invert preview colors” 反色（`is-inverted`，是请求的一部分，
  换主题或改设置时视图重建）；窄窗格里等比缩小。
- **实时预览**：#14 TikZ 图（tikzpicture、tikzcd、pgfpicture、circuitikz；扫描器现在把 `\begin`/`\end` 各自独占一行的
  TikZ 图也报成 `env`，里面仍然不扫描）和表格（tabular、tabular*、tabularx、longtable）；#4 MathJax 拒绝的、独占整行的
  显示公式。新鲜时是块部件，光标在它的行上时显示源码，下面没有预览（那是旧的）。新结果到来时视图重建，新的裁剪画好之前
  还显示上一次的（`locate` 返回这个块上一次画出来的请求，语言层自己保留）。改过或裁不出来时：#14 是源码（表格里的公式照常
  渲染），#4 是 MathJax 的报错。编译结束（结果或失败）、预览关闭、换主题或改反色设置时通知渲染器重建。
- **悬停链**：`TexRender.hoverTarget` 取指针所在的公式，否则取包住它的最内层能裁的块（TikZ 图、表格、定理类、figure 和
  table 浮动体；tcolorbox 里的图算作整个框）。独占整行的显示公式：新鲜的裁剪 → MathJax（编译中不等）；行内公式只用
  MathJax；块：新鲜的裁剪（会话第一次编译时等它结束）→ 改过时显示 “Changed since the last compile.”；没有预览或还没编译时没有这一段
  （只有 texlab 的悬停）。P6 在裁剪和提示之间加了片段编译（见下一节）。

验证（2026-09-29，不入库的脚本在 scratchpad 的 `impl-p5/`）：

- 测试：`tests/crop.test.ts` 9 个。5 个纯函数用例（`compiledLines` 取最近的一处，`queryLines`，`cropRegion` 的借来的记录、
  tcolorbox、图片框和段落行、分页残留、跨页）；T-L10（真实 XeLaTeX 编译夹具书：align 的区域在定理框下面、`\[..\]` 上面，
  `\begin{align}` 行返回上一行，行内公式的一行是整行，tikz-cd 从它上面的正文行下面开始，tabular 在它的浮动体里）；T-L11
  （上面插入两行后仍映射回编译时的 18–21 行，改过的块 “Changed since”，编译时没打开的文件，编译中只有查过的块，没有会话）；
  T-L12（新的一次编译进行时同时查询，dispose 后记录下来的 synctex 和 xelatex 进程都退出了，`pgrep -f` 输出目录为空）；
  会话的快照（小的 pdfLaTeX 项目：只含本项目打开的文件、CRLF 变成 LF、每次编译一个新快照、`seq` 跨会话递增、没写出 PDF
  的编译保留上一次的）。
  `tests/latexLive.test.ts` 2 个（#4/#14 的裁剪部件、展开、改过、tcolorbox 里不裁、新结果的裁剪到之前保留旧的、裁不出时
  回到源码或 MathJax 的报错），`tests/texRender.test.ts` 1 个（悬停链），`tests/latexScan.test.ts` 2 个（TikZ 的 `env`、
  `blocks`/`blockAt`）。全部 391 个测试通过，`npm run check`、`npm run build`、`test:yolo`（18/18）、浏览器冒烟 25/25。
- 几何：合成书（XeLaTeX，10 页）的 36 个候选块、合成文章（pdfLaTeX，3 页）的 18 个和手写 pdfLaTeX 文档（段落中间的
  tikz-cd、行内的表格、amsthm 定理和证明、center 里的 tikzpicture）的 8 个，区域用 Ghostscript 渲染出来逐个看过，都对；
  上面的规则都是在这一步发现问题后加的。
- 延迟（合成书的新拷贝，`impl-p5/browser`）：
  - SyncTeX（Node，真实的 `synctex view`，最多 4 个同时）：每个块 3–14 次查询，p50 9.2 ms，最大 19.1 ms。
  - 无头 Chrome（Obsidian 的 pdf.js 5.3.34 和它的 cMap、深色 app.css、dpr 1），`CropService` 本身，SyncTeX 经 HTTP 转发到
    真实的 synctex：36 个块全部裁出，中文字形正常；pdf.js 打开文档 58–62 ms（每个结果一次）；一个块从请求到卡片（SyncTeX、
    区域渲染、裁到墨迹、PNG）p50 35–38 ms、p90 66 ms、最大 82 ms（第一个 148 ms，含打开文档）；同一个块再次请求 0 ms。
    没有 cMap 时中文字形全部消失（重现了 P0 的问题，Obsidian 自己带着这些资源）。
  - dpr 2 下 ch2 的实时视图在还没裁过的结果上第一次挂载：两个裁剪（tikz-cd #4、tabular #14）和全部公式 429 ms 内到位。
  - ch2（118 行）、ch3（90 行，`\intertext` 的 align 是 #4）、tikz-projection.tex（16 行）的实时模式：裁剪部件没有上下外边距、
    图片已加载，行号偏差 0 px，ArrowDown 逐行经过每一行（包括裁剪块）；光标在 tikz-cd 里时显示源码、下面没有预览，表格的
    裁剪还在；有裁剪时光标 p50 0.2 ms、打字 p95 1.3 ms。反色卡片和悬停定理框的裁剪也看过。截图 `impl-p5/browser/p5-*.png`。
- 发现（共享核心，没改）：光标在窗格底边、下面紧接着一个块部件、而这个块正好是 CodeMirror 渲染视口的最后一块时，ArrowDown
  会跳过块后面的那一行：那一行不在 DOM 里，CodeMirror 的 `posAtCoordsImprecise` 多估了一行，`enterBlocks` 因为中间隔着
  一行可见的行而不纠正。在 ch3 的 MathJax 公式块（68–74 行）上复现：渲染视口是 [1, 74] 时从 67 行下移到 76 行，块在视口
  中间时到 75 行。和裁剪无关，MathJax 块一样。
- GUI 检查 H5、H6、L13 仍然待做。

## 片段编译与光标处预览（P6，2026-09-29）

MathJax 画不了、又没有新鲜 PDF 裁剪的东西，悬停时用文档自己的引擎和导言区真的编译一次（design 4.7、4.8）；光标所在的公式
可以浮在它下面随打字更新（design 3.1 的 `cursorPreview`）。

- **片段**（`src/tex/fragment.ts`，不依赖 obsidian 模块）：每次一个 `.tex`，写在构建目录的 `snippets/` 里（`$TMPDIR`，从不写进
  vault），在根文档的目录里运行（`\input`、图片按文档里的路径找到），自己的进程组。
  - 导言区：pdfLaTeX 在编译留下的导言区格式就绪时用它（`-fmt=<job>-preamble`，`TEXFORMATS=<构建目录>:`，和编译一样按名字）：
    文件开头是占位的 `\documentclass{article}` 和 `\endofdump`（格式从这里接着读），再接根文档自己 `\endofdump` 之后的
    导言区。格式是否“就绪”看它旁边的戳记 `<job>-preamble.json`（`compiler.ts` 的 `readyPreambleFormat`：导言区的键和导言区读过的
    本项目文件的修改时间；编译器开始重建格式前删掉它、建好才写，格式坏了也删），所以预览没开、插件重启之后也能用上一次留下的
    格式。XeLaTeX、LuaLaTeX 或没有格式时读根文档 `\begin{document}` 之前的整个导言区，带看门狗（8 s 没有日志增长、也不占 CPU 就
    停，给出字体下载的提示）。超时 pdfLaTeX 10 s、其他 20 s，杀整个进程组。格式坏了（“Fatal format file error”）用整个导言区重试。
  - 然后是 `\usepackage[active,tightpage,auctex]{preview}`（每个片段一页，`auctex` 把盒子写进日志，还带 `\nofiles`：不写 `.aux`）、
    片段里提到的标签（上次编译 `.aux` 的 `\newlabel` 原样，`\global\@namedef{r@k}{..}`，cleveref 的 `k@cref` 一起），
    `\begin{document}` 之后是正文里的定义（`fragmentContext`：根文档正文和正文读入的文件里的 `\newcommand` 等，章节自己的 `\Lip`
    也在；临时让 `\@ifdefinable` 放行，所以能重定义）和每个片段一个 preview 环境。不是行内的片段末尾加一个空行
    （`\par\hbox{}`）：显示公式之后 preview 量到的盒子停在最后一行的基线，下伸部分会被页面切掉（合成文章的 `\intertext`
    align 就是这样），空行让它包进来，多出来的白边画的时候裁掉。
  - 结果：日志里的 `Preview: Snippet n ended.(h+dxw)`（sp）是第 n 页的盒子，`Preview: Tightpage` 是四边的留白（0.50001bp）；
    报错按文件和行归到片段，片段自己的行里有错就算失败，导言区的错只在片段没有盒子时才算。
  - 缓存：按内容哈希（引擎、生成的源文件、调用方给的戳记：导言区读的文件和格式的修改时间），`frag-<哈希>.pdf` 和 `.json`
    留在 `snippets/` 里，超过 200 个删最旧的；一次运行的其他文件都删掉。超时、卡住或没写日志的不缓存。
  - 队列（`FragmentQueue`）每个主文件一个：缓存命中直接返回；同时只跑一个、等一个，新的请求替换等着的那个（它得到 null，
    悬停不显示）。会话关闭（`releaseSession`）和插件卸载时停掉正在跑的（杀进程组）。
- **悬停里的样子**（`src/preview/fragments.ts` 的 `FragmentService`，pdf.js 由 main.ts 传入）：每次按编辑器里的内容（主文件未保存
  的也算）现拼任务；页面用 Obsidian 的 pdf.js 按设备像素比画出来，四周留 3 pt，显示公式和块裁到墨迹，行内公式保留整个盒子；
  白底纸卡片 `lsp-lp-paper ll-fragment`，和裁剪一样按 “Invert preview colors” 反色；画好的图是 PNG data URL，记住最近 50 个。
- **悬停链**（`texRender.ts`）：公式先用 MathJax；失败时（不是括号不配对：TeX 也会停在那里）走片段编译，TeX 也失败时仍显示
  MathJax 的报错和源码。独占整行的显示公式：新鲜的裁剪 → MathJax → 片段。块（TikZ 图、表格、定理类、浮动体）：新鲜的裁剪
  （会话第一次编译时等它结束）→ 片段（失败时显示 TeX 的报错）→ “Changed since the last compile.”。设置 “Compile what the hover cannot
  render”（`texFragmentFallback`，默认开）关掉这一步。片段在 400 ms 后还没好时悬停先显示转圈（共享 `renderHover` 的规则）。
  片段的正文（`fragmentBody`）：带编号的公式环境换成带星号的，有 `.aux` 编号的行加 `\tag{n}`（和 MathJax 悬停一样，删掉 `\label`
  留下的空行也删掉，否则是段落结束），`eqnarray` 不动；定理框和浮动体从它的标签在 `.aux` 里的 hyperref 锚点找到计数器，把
  `\the<计数器>` 定成那个编号（`thm:x` 的锚点 `tcb@cnt@theorem.3.1` 印 `定理 3.1`）；浮动体换成 `\linewidth` 的 minipage、
  `\@captype` 是它的类型（浮动体放不进 preview 的盒子），图注照样编号。
- **光标处预览**（`texExtensions.ts` 的 `texCursorPreview`，设置 “Preview the formula at the cursor”，`cursorPreview`，默认关）：
  光标所在的公式渲染在它最后一行下面，打字时在同一个浮层里更新。行内公式两种模式都有；显示公式只在源码模式（实时预览里独占
  整行的公式是块，展开时下面已经有渲染；在正文里的显示公式照样有）。只用 MathJax（`TexRender.preview`，不走裁剪和片段），
  失败时保留上一次的渲染并标出来；补全列表打开时隐藏；`.sty`/`.cls` 里没有。

验证（2026-09-29，不入库的脚本在 scratchpad 的 `impl-p6/`）：

- 测试：`tests/fragment.test.ts` 8 个：源文件（格式的占位和整个导言区、只带片段提到的标签和 cleveref 的孪生标签、能重定义的
  定义、每个片段的行号、非行内片段的空行）、日志（盒子、留白、报错归属）、`fragmentContext`（正文的定义、未保存的文本、导言区
  文件的戳记）、队列（假的 pdflatex：新的替换等着的、缓存、`dispose` 杀掉子进程）；T-L13（真实 pdfLaTeX：一次编译留下格式后
  4 个片段 4 页、盒子尺寸、`\eqref` 按 `.aux` 解析（没有标签时印 `??`，更宽），整个导言区给出同样的盒子；真实 XeLaTeX：夹具书
  的整个导言区、ch2 自己的 `\Lip`、elegantbook 的命题框和 tikz-cd，20 s 以内）；T-L14（`\loop` 的片段 1.5 s 超时后进程组
  被杀、`pgrep` 输出目录为空、不缓存；同一个哈希命中缓存，戳记变了不命中）。`tests/texRender.test.ts` 2 个（悬停链的片段一步、
  括号不配对和设置关掉时不编译、块的裁剪 → 片段 → 提示；`fragmentBody` 的星号和 `\tag`、定理框和浮动体的编号、`eqnarray`、
  标签独占一行）、`tests/texEditor.test.ts` 1 个（光标处预览：行内两种模式、显示公式只在源码模式、设置关掉）、
  `tests/compiler.test.ts` 的格式戳记。全部 402 个测试通过，`npm run check`、`npm run build`、`test:yolo`（18/18）、浏览器冒烟
  25/25 通过。
- 合成项目的新拷贝，用插件的 `Compiler` 编译（latex-article 用格式缓存，等格式的戳记就绪），然后在 jsdom 里把每个章节的每个
  公式和每个能裁的块经 `TexRender.hover` 走一遍，没有预览（没有裁剪，H11 的情形），片段走真实的 `FragmentService`（pdf.js 的绘制
  在下一条的 Chrome 里量）：

  | 项目 | 目标 | MathJax | 片段 | 片段的 TeX 时间 | 再次悬停（缓存） |
  | --- | --- | --- | --- | --- | --- |
  | latex-article（pdfLaTeX，格式） | 44 个公式、10 个块 | 41 | 13（`\intertext` 的 align、两处 `\set{..}[..]`、10 个块），全部用上格式 | p50 264–278 ms，p90 303–317 ms，最大 356 ms | p50 0.9 ms |
  | latex-elegantbook（XeLaTeX） | 129 个公式、23 个块 | 127 | 25（ch2 的 tikz-cd、ch3 的 `\intertext`、23 个块） | p50 1.31–1.43 s，p90 1.35–1.47 s，最大 1.51 s | p50 0.8 ms |

  以前没有预览时这 3 + 2 个公式只有 MathJax 的报错、块没有悬停；现在全部画出来，0 个失败。第一轮时发现两处并修掉：标签独占一行
  的带编号公式删掉标签后留下空行（TeX 当段落结束，报 “Missing $ inserted”），显示公式的最后一行下伸部分被 preview 的页面切掉。
  跑完后两个构建目录上没有进程（`pgrep`），项目拷贝和原件逐字节相同（`diff -r`）。
- 画面（无头 Chrome，Obsidian 的 pdf.js 5.3.34 和它的 cMap，深色 app.css，插件的 styles.css，dpr 2）：上面 38 个片段的 PDF 经
  `FragmentService` 自己的绘制代码画成卡片：每个 p50 70 ms、p90 86 ms、最大 103 ms（每个片段一个 pdf.js 文档），再画 0 ms；
  反色卡片 12/12。逐个看过：elegantbook 的定义、定理、命题框带中文标题和 `.aux` 里的编号（`定理 2.1 (谱定理 Spectral theorem)`、
  公式 `(2.2)`、`(2.3)`），证明、例题、笔记，tikz-cd，TikZ 图和 heatmap 的图注 `图 2.1`、`图 2.2`，表 `表 2.1`，ch3 的
  `\intertext` align 带 `(3.3)`；文章的 amsthm 定理、引理（(2a)、(2b)）、remark 里的 `\intertext` align 带 `(4)`、表格、图。
  合起来悬停在 pdfLaTeX 上约是 300 ms 停留 + 280 ms 编译 + 70 ms 绘制，XeLaTeX 约 300 ms + 1.4 s + 70 ms（400 ms 起显示转圈）。
- 光标处预览（jsdom，真实的编辑器扩展和 Obsidian 的 MathJax，elegantbook ch1 的 `$\E[Q]{X}$` 里打 28 个字符）：每键从 dispatch 到
  浮层换成新渲染 p50 2.7 ms、p95 6.8 ms、最大 7.3 ms（预算 40 ms）；中间 16 次公式不完整，浮层保留上一次的渲染并标 `is-error`；
  浮层一直是同一个。
- GUI 检查 H11、H13 仍然待做。

## 共享核心的审查修复（P4–P6，2026-09-29）

P4–P6 的审查里落在共享部分（`src/editor/shared/`，规范副本在 obsidian-tinymist，拷过来逐字节相同；`styles.css` 里的
`shared:editor.css` 一段同步）的问题，和两个仓库各自要跟着改的调用处：

- **不带纪元的请求**（P4-R5）：`ctx.request(kind, src, display, pos, epochFree)` 的键用 `*` 代替纪元。纪元（这里是定义语句的
  哈希）变了时缓存清空，但这类请求的结果留着，渲染到一半的也照样入缓存。`latexLive.ts` 的图片（`mtime|path`）和裁剪
  （含上一次结果的 `previous`）都这样请求：它们和宏无关，以前每改一次宏，每张 PDF 图都要读文件再让 pdf.js 画一遍，
  和公式挤在一个异步队列里。
- **按种类排队的调度**（P4/P5 的请求）：以前异步渲染在飞的时候整批停下；LaTeX 的渲染器是混合的（MathJax 同步，PDF 页和
  没画过的裁剪异步），公式要等裁剪。现在按请求的种类记下它是否返回过 promise：返回过的种类一次一个，等着；其他种类
  （和还没见过的种类）照常渲染。Typst 只有一种异步的请求，行为不变（一次一个，按顺序）。
- **错误诊断下的块**（TY-R2）：`renderConstruct` 以前只要构造里有错误诊断就直接返回，展开的块连下方的渲染也没了（打字停顿、
  诊断落地后公式整个消失）。现在只是不替换：展开的块保留下方的渲染（上一次的，新源码失败时标 `is-error`，不加虚线下划线，
  lint 的下划线在）；收起时仍是源码。新的 `liveActive(state)`（实时预览装着并且在装饰，即文档没超过 maxLines）替掉光标处预览里
  的 `isLive`：实时视图不装饰时显示公式也有光标处预览（`texCursorPreview`、`typstCursorPreview`）。
- **光标处预览的位置**（R3、TY-R1）：浮层的 `getCoords` 给出从构造第一行的上边到最后一行下边的矩形、锚点的左边：行内公式折行时
  浮层挂在最后一个视觉行下面，不再盖住正在打的那一行；窗格底部放不下、CodeMirror 把它翻到上面时在第一行上面（以前矩形的上边
  是最后一行的，翻上去的浮层盖住多行显示公式的下半部分和光标所在行）；左边还在公式开头（直接把锚点放到结尾会让宽的渲染伸出
  编辑器右边）。
- **长环境里的光标移动**（R1）：`LiveLanguage` 可选的 `reveals(c)` 给出构造真正看光标的范围（定理框：`\begin`、`\end` 两行），
  null 是它的所有行。扫描时另建一份按这些范围的区间索引（`of[k]` 指回构造）；选区移动时，是否碰到构造、局部重画选哪些构造都按
  这份索引，选中的构造仍把它所有的行加进重画的区域。所以光标移到框的 `\begin`、`\end` 行时整个框重画，在框里面移动只重画
  那几行上的构造。`reveals` 抛异常时和扫描器一样只记一次日志，退回构造自己的行。
- **窗格底边的行移动**：CodeMirror 按字符数估计没画出来的行的位置。块正好是它绘制的视口的最后一段、块后面是一行空行或短行时，
  从块上面一行按 ArrowDown 会落在块后第二行（空行几乎分不到高度），`enterBlocks` 因为中间有一行“可见”而不拦。现在
  `drawnViewport` 按状态记下每个视图上次绘制的视口（事务过滤器看不到视图），落点正好是块后第二行、而中间那一行不在视口里时
  也停在块上；那一行画出来了就是更长的跳转（PageDown），不改。
- **深色主题下的框头**（P4-R4）：`.theme-dark` 里框头文字用 `oklch(from var(--lp-box-color) max(l, 0.72) c h)`，色相不变、
  调亮；边框和底色仍是配色本身。浅色主题不变（和 PDF 一致）。

验证（2026-09-29，不入库的脚本在 scratchpad 的 `impl-p4/shared/`）：

- 测试：共享的 `tests/livePreview.test.ts` 新增 4 个（T-S7 视口止于块时的落点、T-S9 错误诊断下展开的块、T-S11 混合种类的调度、
  T-S11 不带纪元的请求），在修改前的核心上都失败；`tests/renderHover.test.ts` 新增 T-S13 的 `getCoords`；`tests/texEditor.test.ts`
  的光标处预览加上不装饰的实时视图；T-L9 加上改宏后图片不重画（图片的键带纪元时失败）。LaTeX Live 全部 407 个测试通过，
  obsidian-tinymist 268 个（1 个跳过，和以前一样）；两边 `npm run check`、`npm run build`、`test:yolo`（18/18）通过；
  浏览器冒烟两边都是 29/29（MathJax 3.2.2 和替身渲染器）。新增的 B7、B8 在修改前的核心上失败（B7 落在第 55 行而不是 37 行；
  B8 的浮层顶边在 25 px，盖住折行公式的第二、三行，也就是正在编辑的源码；现在在 137.5 px，正好是公式最后一行的下边）。B5：挂载
  13.8 ms、打字 p95 3.5 ms、展开的块里打字到重新渲染 p95 5.6 ms、光标 p50 0.2 ms、滚 20 屏帧 p90 16.7 ms。
- 无头 Chrome，P5 编译好的 latex-elegantbook 拷贝（Obsidian 的深色 app.css、MathJax 和 pdf.js，真实的 SyncTeX 和裁剪服务），
  同一脚本分别打包修改前后的核心：
  - ch2 在一个还没裁过的编译结果上挂载（dpr 2，视口在 tikz-cd 附近）：修改前 89 ms 时 4 个公式，裁剪在 258 ms、306 ms 落地，
    其余 12 个公式等到 330 ms；修改后视口里的公式 95 ms 起陆续出现，140 ms 全部画完，两个裁剪 293 ms、342 ms 落地（和以前一样）。
  - ch3 第 67 行在窗格底边（绘制的视口是 1–74 行，止于 68–74 行的公式，75 行是空行没画）：ArrowDown 以前落在 76 行，现在停在
    68 行（dpr 1 和 2 都是）；ch2（118 行）、ch3（90 行）、TikZ 文件（16 行）的完整行走每一行都经过，行号偏差 0 px。
- 框头的颜色（无头 Chrome，Obsidian 的 app.css，插件的 styles.css）：深色主题下 `color=black` 的框头是 rgb(164, 164, 164)，
  对比度 6.84:1（以前是黑字，约 1.2:1）；blue 配色的三个角色 7.04–7.32:1，green 的 main 7.28:1；边框仍是配色本身；浅色主题
  下框头就是配色（和以前一样）。
- Typst 那边用真实的 tinymist 在 typst-book 的拷贝上复查了错误诊断：ch1 末尾的块公式里打一个 `(`、诊断落地之后，1 个 lint
  范围，下方的渲染在（`is-below is-error`，上一次的渲染），0 个虚线下划线（以前 0 个下方渲染，什么都没有）。
- `reveals` 和翻到上面的浮层（之后补上，不入库的脚本在 scratchpad 的 `impl-p4/gate/`）：共享的 `tests/livePreview.test.ts` 新增
  T-S5 的 `reveals` 用例（同样 150 次随机移动和整篇重建比对；300 行的框里移动只重画那两行的 4 个公式，没有 `reveals` 时 600 多个）
  和 `reveals` 抛异常的用例，`tests/latexLive.test.ts` 新增长框用例（190 行的定理框和 quote 里移动只重画那两行的公式，移到
  `\begin` 行时框重画、框头变回源码），T-S13 的 `getCoords` 改成第一行上边到最后一行下边；这几个在忽略 `reveals` 或旧的
  `getCoords` 上都失败。LaTeX Live 全部 422 个测试通过，obsidian-tinymist 276 个（1 个跳过，和以前一样）。浏览器冒烟 31/31（两边）：B5 新增 3193 行文档里 190 行定理框中的光标移动（p50 0.1–0.2 ms、每次 5.95 次
  decorate；忽略 `reveals` 时每次 2321 次），B8 新增窗口底边的显示公式（浮层翻到上面、底边正好在 `\[` 行的上边 299.5 px；旧的
  `getCoords` 下浮层在 344–367 px，盖住公式）。审查时的无头探针（Typst 的 wrap 探针，窗口 469 px）：翻上去的浮层在 291–343 px，
  `$` 行的上边是 343 px，光标行 391–410 px 不再被盖；折行的行内公式仍挂在最后一行下面（74–126 px）。
- GUI 检查仍然待做（L12、L13、H11、H13 等）。

## P4–P6 的审查修复（LaTeX Live，2026-09-29）

审查里落在 LaTeX Live 自己代码里的问题（共享核心的见上一节）：

- **没有标签的框的编号**（P4-R1）：elegantbook 笔记里的框大多不加标签（`{标题}{}`、`例题`、`练习`），以前只显示名字，PDF 却有编号。
  现在 `\include` 进来的章节里按位置数出来：`src/tex/aux.ts` 的 `readAuxCheckpoints` 读每个章节 .aux 的 `\@setckpt`（章节结束时
  各计数器的值）和它最后一个编号章的 hyperref 锚点（`chapter.4` 是 4，附录的 `appendix.A` 是 A；不用 chapter 计数器，附录里它是
  1，也不用目录的 `\numberline`，`chinese` 下是 `第四章`），随标签一起读（`LatexRefs.checkpoints`，不变时同一个对象）。
  `theorems.ts` 给每个环境记下它按 `\thechapter.\arabic{c}` 编号、`\chapter` 清零的计数器 `counter`：elegantbook fancy 模式
  `tcb@cnt@<env>`、simple 模式 `<env>`（`thmcnt=chapter`，默认），`usesamecnt` 时都是 `ELEGANT@samecnt`，`\elegantnewtheorem`
  带 `[shared]` 时用那个环境的，example/exercise/problem 是 exam/exer/prob，`\newtheorem{env}{T}[chapter]` 和共用它计数器的；
  `thmcnt=section`、没有 `[chapter]` 的 `\newtheorem` 没有。`latexLive.ts` 的 `boxNumber` 只有这些都成立时才数：文件里只有一个
  `\chapter`、这个计数器上的框都在它后面、扫描器找到的个数等于检查点记的、有标签的框正好在 .aux 给它的位置上；否则不显示编号
  （和以前一样）。`TexView` 把文件的 include 名（`includeName`：相对主文件目录、去掉 `.tex`）传给语言；悬停的片段编译也用这个
  编号设 `\the<计数器>`（以前没标签的 `例题` 印 0.1）。
- **框头只吃环境收的参数**（P4-R3）：elegantbook 的 proof、remark 这类不带参数的环境，`\begin{proof}[另一种证明]` 的方括号以前被
  框头吃掉，PDF 印的是 `证明 [另一种证明]`；现在框头只盖住环境收下的参数（tcolorbox 的 `g o t\label g`、amsthm 的 `[标题]`、
  custom 的 `{名字}`），其余的留在原处当文字，里面的公式照常渲染。
- **图片**（P4-R2、P4-R6）：扩展名不是 graphicx 认识的（`loss_lr0.01`、`v1.2`）时和 graphicx 一样先补 pdf/png/jpg/jpeg 再试原名
  （pdfLaTeX 核对过：空的 `weird.01` 和 `weird.01.png` 都在时用后者）。路径里有宏（`\figdir/plot`）、或者项目里找不到的不带路径的
  名字（mwe 的 `example-image-a` 在 TeX 目录树里）不再标成找不到，保留源码。
- **problemset**（P4-R7）：elegantbook 的练习题环境（TeX Live 2026 里只有它定义这个名字）按 enumerate 编号，`\begin`/`\end` 行
  折叠；它的 `[标题]` 不当列表选项；它里面的 enumerate 在它的组里结束，后面的 `[resume]` 从 1 开始（XeLaTeX 印的就是这样）。
- **扫描器的时间**（R4）：文字参数的结束位置在一次扫描里按（位置、嵌套层数）记下来。以前 80 层没闭合的 `\text{$` 要 23 s，
  160 层超过 20 s（编辑器卡死：实时预览的字段和光标处预览都要扫描）；现在 40 层和 160 层都在 5 ms 左右。
- **编译进行时照样裁剪**（C1、C7）：`CropService.locate` 不再在会话编译时对没查过的块说“编译中”。以前一次结果后面紧跟着第二遍
  （标签变了）或排队的编译（编译中保存）时，实时视图在结果落地的同一个 tick 里重建，TikZ 图和表格退回源码约 2.5 s，下一次结果
  到来时也没有 `previous` 可显示；悬停也会在第一遍结果之后又碰上第二遍、去跑片段编译。那条规则（设计 4.6 “会话编译时不查询”）的
  前提不成立：XeLaTeX 和 pdfLaTeX 运行时写 `<job>.synctex(busy)`，只在一遍结束时换掉 `<job>.synctex.gz`。现在查询随时跑，
  `.synctex.gz` 的修改时间在结果落地时记下（`CompiledPdf.synctex`，会话的 `onResult` 里），查询后不一样就安静地失败；悬停只在
  会话还没有任何结果时等第一次编译。
- **跨页的 tcolorbox**（C3）：框的 `\end` 行报告了整页（章标题、前面的段落），以前悬停的裁剪是整页；现在框也只取前一行下面的记录
  （框的 `\end` 行报的前一行记录也算前一行的），只剩框在这一页的部分，仍然标“接下页”。
- **段落最后一行**（C5）：段落后面紧接显示公式时，段落最后一行记在 `\begin` 行上（TeX 在那一行才断行），以前那一行露进裁剪顶边；
  现在公式只打开的 `\begin` 行（`\[`、`$$`、`\begin{env}` 加参数和 `\label`）也查一次，它的记录当成前一行的。两行的块第一行只打开
  时不再算里面的行。
- **相同文本的块**（C4、R2）：`compiledLines` 的缓存键加上现在的行号，两个一模一样的公式各自裁自己的（以前先查的那个决定了
  后面所有同文本块的行号，第二个编号公式显示第一个的 (1)）。`drawn`/`previous` 仍按文本记（按编译时行号记的话，上面插入行后
  `previous` 就找不到了）。
- **SyncTeX 失败**（C6）：`synctex view` 没有记录时也以 0 退出（未知文件、未知 PDF 也是），所以超时、被杀、起不来才是失败：
  `forwardSearchAll` 这时 reject，区域失败、下次渲染重查，不再用剩下的记录拼一个缺边的区域缓存一整个结果。
- **片段编译**（F1、R5、F2、R6）：`FragmentService.render` 在第一个 await（格式检查）之前拿到这个主文件的队列，预览关闭或插件卸载时
  这个队列被停掉，不再在卸载后新建队列启动 TeX（`detached` 的 pdflatex 会活到超时）；卸载后的渲染直接返回 null。缓存键加上片段
  自己读的文件（`bodyStamp`：`\input`/`\include` 的文件和它们再读的、`\includegraphics` 的图片，按 `\graphicspath` 找，取修改时间），
  改了图或 TikZ 文件后悬停重新编译。中止或 TeX 起不来的运行也清掉它的文件；`readAuxLabels` 不读 `frag-<hash>.aux`。
- **设置说明**（R7）：“Render formulas on hover” 写上裁剪和片段编译；styles.css 里错位的注释放回 `.ll-render-note`。
- **长环境里的光标移动**（R1）：扫描器把每个 `\begin`/`\end` 各自独占一行的环境都报成 `env` 构造，光标在环境里面移动时
  共享核心要重画整个环境，超过 400 个构造就整篇重建。3192 行的章节里一个 190 行（570 个行内公式）的 quote、minipage、abstract、
  theorem、proof 里移动光标 p50 7.0–7.4 ms、p95 11 ms，每次 6571 次 decorate（外面 0.3 ms、6 次）。现在共享核心有
  `LiveLanguage.reveals`（见上一节），`latexLiveLanguage` 让除裁剪外的每个 `env` 只在 `\begin`、`\end` 两行看光标（扫描按文本
  缓存，看不到定理表，所以不只是定理框）：同样的移动 p50 0.33–0.44 ms、p95 0.6–0.8 ms，每次 6 次 decorate；300 次随机移动后装饰
  和整篇重建一样（24 个框，没有重复）。

验证（2026-09-29，不入库的脚本在 scratchpad 的 `impl-p4/fix-ll/`）：

- 测试：新增 12 个（`tests/crop.test.ts` 4 个：编译进行时照样裁剪和悬停〔真实 XeLaTeX 第二遍在跑〕、SyncTeX 失败〔假的 synctex〕、
  相同文本的块、段落最后一行，跨页的框加在分页残留的用例里；`tests/fragment.test.ts` 2 个：释放和卸载时不启动 TeX、`bodyStamp` 让改过的图重新编译；
  `tests/latexLive.test.ts` 2 个：没有标签的框按检查点编号〔章节、附录 A、多一个框、标签位置不对、`\chapter` 之前的框、两个章〕、
  不收的参数留作文字；`tests/aux.test.ts` 1 个：检查点；`tests/theorems.test.ts` 1 个：计数器；`tests/latexScan.test.ts` 2 个：
  problemset、没闭合的 `\text{$` 的时间），另有 T-L9 图片、T-L11、`queryLines`、`fragmentBody`、队列、`readAuxLabels` 的新断言。
  逐个把修复撤掉跑它的测试：16 处都失败（R4 的在 240 s 时限处被杀）。全部 419 个测试通过，`npm run check`、`npm run build`、
  `test:yolo`（18/18）、浏览器冒烟 29/29。
- 框头和 PDF 对照（合成 elegantbook 的新拷贝，加了第 4 章和附录里的框，插件的 `Compiler` 用 XeLaTeX 编译三遍，每章以实时模式挂到
  真实的编辑器栈上，pdf.js 取 PDF 的文字）：37 个框里 36 个的框头逐字出现在 PDF 里（剩下一个标题里有公式，是渲染部件），修复前
  7 个不对（ch1 的 `例题 1.1`、ch3 的 `练习 3.1`、ch4 两个没标签的定理和 `问题 4.1`、附录的 `定理 A.1`、`例题 A.1`）。一本 3 章的
  小书按 6 种选项各编译一次：默认、`usesamecnt`（`定义 1.1`、`定理 1.2`、`引理 1.3`）、`simple`、`simple,usesamecnt`、
  `\elegantnewtheorem{fact}{事实}{prostyle}{fac}[theorem]`（`事实 1.3`）都和 PDF 一样；`thmcnt=section` 的 7 个定理类框按设计不显示
  编号（PDF 是 `1.0.1` 这样的节编号），例题、练习、问题照样有。latex-article（pdfLaTeX、`\input`、amsthm）5 个框头不变，都在 PDF 里。
  1871 行、340 个没标签的框的章节：每次按键数编号 0.09 ms；框里打字 p50 1.59 ms，不传 include 名时 1.53 ms。
- 裁剪的几何（同一套规则，修复前后各算一遍，真实的 `synctex view`）：pdfLaTeX 的 adj 文档 9 个块、C3 的 XeLaTeX 书（带跨页定理的
  章节）28 个、合成 elegantbook 57 个，共 94 个块里 4 个变了：adj 的两个显示公式顶边从 136.7/243.3 移到 146.7/255.3（段落最后
  一行不再进裁剪）、跨页定理第 10 页的部分从 y=60.7（整页）变成 388.7（只有框，仍标接下页）、adv 的 align 顶边从 337.8 到 353.3
  （它前面一个零高度的空段落行，墨迹不变）；elegantbook 的 57 个一个没变。
- 编译进行时的裁剪（审查时的复现脚本，真实的 `LatexSession`、`Compiler`、`CropService` 和夹具书）：第二遍和排队编译的场景里 ch2 的
  表格一直有裁剪，旧的留到新的画好（16–17 ms 后）；第一次编译在第一遍结果后 1.74 s 就有裁剪（以前等第二遍，5.5 s）。
- 跑完后没有 xelatex、pdflatex、synctex、headless Chrome 进程；项目拷贝都在 scratchpad 里编译，构建目录在 `$TMPDIR`。
- GUI 检查仍然待做（L12、L13、H5、H6、H11、H13）。

## HTML 导出（2026-09-29 起）

目标：命令 “Export to HTML” 把一个 LaTeX 项目导出成一个自包含、不含 JavaScript 的 HTML 文件，重点是 elegantbook 这类模板
（`lang=cn` 的 ctex/XeLaTeX、带类名和编号的彩色定理框、按章编号的公式、`\ref`/`\eqref`/`\autoref`/`\cref` 的文字、biblatex
引用、`\include` 的多文件章节、图、TikZ/tikz-cd）。做法是自己的转换器：结构来自插件自己的解析树，编号、名字和颜色来自 TeX
本身（多跑一遍“探针”，`llxprobe.sty` 把每次计数器步进、目录项、类名和颜色按文档顺序写进 `<job>.llx`），TeX 以外画不了的
构造（TikZ、未知环境、MathJax 拒绝的公式）以后由同一遍的 DVI 经 dvisvgm 变成 SVG 片段。研究和设计在 scratchpad 的
`html-export/`（report.md、design.md，选型的证据：make4ht、pandoc、lwarp、unified-latex-to-hast 都丢中文或编号）。

默认选择（用户可以改）：参考文献是可重排的 HTML 列表；标题是紧凑的页头而不是封面；正文用读者系统字体加中文衬线字体栈
（Songti SC、Noto Serif CJK SC、Source Han Serif SC），不嵌入正文字体；PDF 模式的探针（LuaLaTeX）留到后续，不在首版，但 `\includepdf`
的页面在 S6 以图片导出。用户真实的 elegantbook 笔记还用 `\usepackage[utf8]{inputenc}`（和 ctex 一起）、pdfpages、listings、
algorithm + algpseudocode、`\setcounter{tocdepth}{2}`、`chinesefont=nofont`，第一版都要处理。

- [x] S1 流水线骨架（2026-09-29，见下）：`runTex`、解析器、签名表、计划、探针、`.llx` 读取和重同步、报告、页面组装、
      只有文字的输出、命令（保存对话框、带取消的进度 Notice、陈旧时完整构建、写文件）。
- [x] S2 数学和编号（2026-09-29，见下）：`ExportMath`（私有 CHTML 输出，只带用到的字形和字体，数据 URI），每行
      `\tag{TeX 的编号}`，`\intertext` 拆分，计划里的 `mathOk`，失败时 `<pre>`。
- [x] S3 引用、文献、脚注（2026-09-29，见下）：biblatex 的 `.bbl`（中文作者）、numeric-comp、natbib 的 `\bibitem`，`\citet`，
      脚注标记。
- [x] S4 外观（2026-09-30，见下）：`profiles.ts`（elegantbook 和标准类的配置、ctex 名字、普查分类、tcolorbox 框和 elegant 的
      head、amsthm 的风格、紧凑页头、按 `tocdepth` 的目录、明暗两套 CSS 和暗色的对比度、中文衬线字体栈）、导出器分成
      `prepareExport`/`emitExport`、`scripts/export-smoke.mjs`、忠实性断言 3、4。
- [x] S5 TeX 片段（2026-09-30，见下）：dvisvgm（`--exact-bbox --currentcolor --font-format=woff2`），每页的标记（片段号、基线），
      按片段加前缀，清理，暗色主题的颜色，片段里的步进按片段号丢掉并记为显示过的编号，失败时显示源码。
- [x] S6 浮动体、图片、表格（2026-09-30，见下）：图注（`\caption*`、subcaption 的 `(a)`、`\captionof`）、PNG/JPG/GIF/SVG 图片、
      PDF 图片和 `\includepdf` 的页面（宿主的 `pdfImages`：Obsidian 的 pdf.js）、tabular（l/c/r/p/m/b、竖线、`\hline`、booktabs、
      `\cline`/`\cmidrule`、`\multicolumn`；multirow、colortbl 交给 TeX）、`\lstinputlisting`、algorithm 浮动体。
- [x] S7a 界面（2026-09-30，见下）：报告弹窗（按严重程度分组，位置可点）、Open/Reveal（Electron 的 shell）、`exportFolder`
      设置、会话内记住每个主文件的目标、`.tex` 文件的右键菜单。S7b（以后）：文件夹打包。
- [x] S8 首版加固：elegantnote/elegantpaper/ctex 配置、`\newenvironment` 展开、`\import`/`\subfile`、带空格和 Unicode 的路径。
      用户以当前验证为基线进入功能研发；65 页冷导出 11.335 s、构建新鲜时 2.931 s，10 s 保留为后续优化目标。
      LuaLaTeX 的 PDF 模式探针、S7b 文件夹打包、S9 印刷 SVG 分页模式留到后续。

### S1：流水线骨架（2026-09-29）

模块（`src/export/`，除了 `command.ts` 都不依赖 obsidian 模块，整条流水线在 Node 测试里对真实 TeX 跑）：

- **`src/tex/run.ts` 的 `runTex`**：从 `Compiler.exec` 抽出来（自己的进程组、无进展看门狗、5 分钟超时、`AbortSignal` 中止时杀整组并
  reject `AbortError`，进程关闭之后才 settle）。`Compiler` 用它（dispose 时 abort 自己的 `AbortController`），探针也用它；
  `fragment.ts` 暂时还是自己 spawn（规则相同），`killTree` 搬到 `run.ts`。
- **解析器 `texTree.ts`**：容错、按偏移精确，顶层节点正好覆盖整个文件。节点：text、space、par、comment、group、macro、env、
  math、verb。和编辑器的词法规则一致（latexHighlight 的 `MATH_ENVS`、`VERBATIM_ENVS`、第一个出现在行首的 `\iffalse`；行内公式
  跳过文字参数，`$f = \text{当 $x$ 时} 1$` 是一个公式，段落结束行内公式）。TeX 自己的规则：`%` 吃掉行尾换行和下一行的缩进（所以
  跨行的 `a-%↵-b` 是一个连字符连接，注释后面的空行仍然分段）；`\verb`、`\lstinline`、`\mintinline`、verbatim 类环境是原样文字，
  listings/minted 的选项先读成参数；`\url` 和 `\href` 的地址是原样参数（里面的 `%`、`#`、`_` 是字符）；定义（`\newcommand`、`\def`、
  `\let`、`\newenvironment`、`\NewDocumentCommand`……以及文档改名的定义命令 `\nc`）是代码，一个节点；`\end` 关掉同名最近的
  环境，里面没关的环境到它为止，谁也没开的 `\end` 是一个 `end` 宏。参数按签名读（`s`、`t\label`、`o`/`O{}`、`m`、`g`、原样的 `v`），
  所以 elegantbook 的 `g o t\label g`（`{标题}{标签}` 和 `[标题]\label{k}` 两种写法）、用户宏、`\\[2pt]` 都和 TeX 读得一样；参数之间
  最多隔一个换行，空行结束查找。
- **签名表 `signatures.ts`**：内置的命令和环境（LaTeX、graphicx、hyperref、cleveref、natbib/biblatex、listings、pdfpages、algpseudocode、
  tabular 等），然后是项目的：`Definitions.macros`（`[n][默认]`）、源码里 `\NewDocumentCommand`/`\newenvironment`/`\NewDocumentEnvironment`
  的参数说明、定理表的环境；探针之后再加上普查（census）里 TeX 自己定义的环境（`\meaning` 里 xparse 的参数说明、`\@protected@testopt`
  是一个可选参数、`#1#2` 的个数），只补项目不知道的环境，然后用新签名重新解析（`reparse`）。
- **计划 `plan.ts`**：文件按“从主文件目录出发的路径、正斜杠、带扩展名”作键（`chapters/ch1.tex`，和 `\input` 写的、和探针记的
  `\CurrentFilePathUsed` 一样）。访问顺序：主文件是 0 号，正文里每个 `\input`/`\include`/`\subfile` 按文档顺序递归开下一个访问
  （同一个文件读两次就是两次访问），遵守 `\includeonly`；导言区读的文件（`macros.tex`）要解析但不算访问（探针在
  `\begin{document}` 之后才记录）。片段：TikZ 家族的图和 `\tikz` 是行内片段（`llxfrag`，lrbox），带 tikz-cd 的显示公式和输出器
  不认识的环境是块（`llxblock`，不装盒子，不改变编号）。插入都在行内：`\begin{llxfrag}{7}` 紧贴在构造前面，`\end{llxfrag}` 紧贴在后面，
  副本和原文件行数一样、插入之外逐字节相同。探针配置：要报告的名字（固定的一组加定理表的每个环境）、颜色（elegant 类的四个加
  `\definecolor` 和正文里 `\textcolor`/`\color` 用到的）、要普查的环境（正文里用到的非标准环境）。
- **探针 `probe.ts`**：`llxprobe.sty` 是 `probe.ts` 里的字符串，每次导出写到工作目录。工作目录是 `<构建目录>-export`（构建目录的兄弟：
  `readAuxLabels` 往构建目录里扫三层，放进去会把导出的 .aux 当成实时预览的标签）。准备：写 sty 和插桩副本（`src/<键>`），建
  `\include` 要写 .aux 的子目录，从构建目录复制 .aux（包括 `chapters/*.aux`）、.bbl、.toc；再用 `runTex` 跑
  `<引擎> <DVI 选项> -interaction=nonstopmode -file-line-error -jobname=<job> "\RequirePackage{llxprobe}\input{<主文件名>}"`，
  cwd 是工作目录，`TEXINPUTS=.:<工作目录>/src:<主文件目录>:`（加用户自己的）。和设计稿不同的一点：主文件用文件名 `\input`
  （由 `TEXINPUTS` 在 `src/` 里找到），所以它的记录是 `{}{main.tex}`，和其他文件的键一样，不用把 `src` 映射回去。DVI 选项：
  pdfLaTeX `-output-format=dvi`、XeLaTeX `-no-pdf`、LuaLaTeX 暂时也是 DVI（S8 换成 PDF 模式）。探针写的枚举记录是项目的标签
  （`\labelenumi`：enumerate 包的 `(a)`、enumitem 的 `(i)`、elegantbook 的 `{\color{structurecolor}1.}`），不是 `\theenumi`；展开值时
  `\color` 和字号命令（`\@setfontsize`）不起作用，`\protected@edef` 保护健壮命令。
- **`.llx` 读取 `probeLog.ts`**：记录按访问定位，不按它自己写的文件名：访问刚结束时 TeX 还报子文件的名字，行号却是父文件的（书的
  `\printbibliography` 的目录项写成 `appendix.tex` 第 43 行，其实是 main.tex 第 43 行）。计划的访问按（文件键，第几次）对上探针的访问；
  位置按访问链比较（`[根里的行, 第几个子访问, 子文件里的行, …]`，只比到范围的深度：一个构造的行读进来的文件里的记录算在构造里面）。
  `StepQueue.take(计数器, 范围)`：同一计数器、同一位置、同一值的记录合并（tcolorbox 每个框步进两次，subequations 的父编号两次）；
  范围之前的记录丢掉并记为孤儿（报告的 numbering 项）；队首在范围里就取走；否则给 null（输出器退到 .aux 的编号或 `?`）。`\tag` 的
  equation 步进又复原，下一个公式在别的文件里步进到同一个值：两条记录位置不同，各自被自己的构造取走（S2 的输出器把 `\tag` 那条
  取走不用）。`drop(范围)` 丢掉一个片段里的所有步进（编号在它的图里）。
- **输出 `emit.ts`（S1 只有文字）**：按计划的访问顺序走主文件的正文和它读的每个文件，每个构造的行就是 StepQueue 的范围。标题：
  级别和类印出来的编号（`第一章`、`1.1`、`A`）来自目录记录，标题文字来自源码，紧跟的 `\label` 作锚点；段落：空行和 `\par` 分段，
  中文字符之间的换行空格去掉（xeCJK 的做法，跨过行内标签也算），TeX 的连字（`--`、`---`、引号）在注释连起来的文字上做，`~` 是不断行
  空格；`\textbf` 这类样式和 `\bfseries` 这类字体开关（作用到组结束，跨段落，块用 div 包起来），`\textcolor`/`\color` 用探针的颜色和
  xcolor 的基本颜色；列表的标签是 TeX 印的（enumerate 来自探针，嵌套层数对应 enumi–enumiv），description 的词条；定理类环境：名字
  （探针的 `\<env>name`，否则定理表）、编号（计数器来自普查的 `\@thm`、定理表的 `counter`、elegantbook 的 `tcb@cnt@<env>`）、标题的
  位置（括号里、紧跟、替换名字）、amsthm 的句点和证明的 □；浮动体的图注用探针的名字和编号；verbatim 和 listings 是 `<pre>`（带
  `caption=` 的 listing 有 `Listing 1.1` 标题）；`\href`/`\url` 是链接（只允许 http(s)、mailto、ftp、片段和相对地址）；引用的文字和
  实时预览的芯片一样（latexRefs 的 `refText`，.aux 来自构建目录），链接到标签的锚点；引用先用 biblatex 的编号（探针的 `llxcite`）；
  脚注的标记来自探针；用户的文字宏（`\term`、`\zhen`）按定义展开。现在的占位：数学是转义过的源码 `<code>`（S2），片段是源码（S5），
  图片和 `\includepdf` 是方括号里的路径（S6），参考文献只有标题（S3）；每种占位在报告里记一条 info。不认识的宏保留参数的文字，
  按名字汇总成 warning。
- **页面 `html.ts`、报告 `report.ts`、编排 `exporter.ts`**：`renderPage` 组装 head、样式（探针颜色的 CSS 变量、明暗两套、中文衬线字体栈）、
  页头（`\maketitle` 时的 `\title`/`\subtitle`/`\author`/`\institute`/`\date`，`\thanks` 成脚注）、`\tableofcontents` 位置的目录（`tocdepth`
  以内的有目录项的标题）、正文、脚注；`<html lang>` 在 ctex 和中文 elegant 类时是 `zh-CN`。`buildFreshness`：没有 .aux 或 .log、主文件
  或 `.fls` 里的输入（构建目录以外）或 .bib 比 log 新、引用了却没有 .bbl 或 .bbl 比 .bib 旧、log 要求再跑一遍/Biber/BibTeX 或有未定义
  的引用时是陈旧的；最后一条只看不是 latexmk 写的 log（`.fdb_latexmk` 至少一样新时，完整构建已经跑满所有遍，剩下的未定义是文档
  自己的，否则每次导出都要完整构建）。陈旧时 `host.build`；构建有错也照样导出（报告的 build 项），没有 .aux 就中止并给出 log 的第一个
  错误。探针没有写出记录（`.llx` 里连名字都没有）时进入只靠 .aux 的模式，报告里一条 error；探针卡住或超时也是 error；探针 log 里的
  错误按原文件和行（`src/` 映射回项目）报 warning。`exportHtml(root, host, onProgress, signal)` 在各阶段之间检查 `signal`，输出器每
  30 ms 让一次 UI（`host.idle()`）。
- **命令 `command.ts`**：“Export to HTML”（`export-html`），活动视图是 `.tex` 的 LaTeX 编辑器时可用。先保存项目里打开的编辑器，
  检查 TeX；保存对话框用 Obsidian 暴露的 `require("electron").remote.dialog.showSaveDialog`（默认 `<主文件目录>/<名字>.html`，
  `createDirectory`、`showOverwriteConfirmation`），包在 `ExportIo` 里（测试可以换掉对话框和写入）；没有 `remote` 时写到默认路径并
  提示。进度是持续显示的 Notice（`setMessage` 更新，带 Cancel 按钮，中止 `AbortController`：`runTex` 杀进程组，构建阶段放开会话，
  只有导出持有的会话被释放时连同进程一起 dispose）。陈旧时的完整构建走主文件的会话（`acquireSession` → `request("full")` → 等
  `mode === "full"` 的 result，或 failure → `releaseSession`），`session.ts` 不用改。写入：vault 里的路径走 `vault.adapter.write`，
  外面的走 `fs`；`report.json` 留在工作目录；完成时 Notice “Exported main.html (28 KB, 1.9 s): 2 TeX fragments, 0 warnings”。
  每个主文件同时只有一个导出（第二次请求提示 already exporting），插件卸载时全部取消。

夹具（都是合成的，小）：`tests/fixtures/export-book`、`export-article` 是 scratchpad `rp/projects` 两个合成项目的拷贝，
`figures/heatmap.png` 换成 ImageMagick 生成的 400×240 渐变（2.5 KB，原来 400 KB）；`export-homework` 是新写的作业式笔记
（elegantbook `lang=cn,chinesefont=nofont` 加手动设的 Fandol 字体、`\usepackage[utf8]{inputenc}`、`\setcounter{tocdepth}{2}`、
`\include` 的一章：`lstlisting`（带 caption）和 `\lstinline`、`algorithm` + `algpseudocode`、`\includepdf` 一页 pdfLaTeX 画的
矢量 PDF，1.5 KB；S6 时重新生成过：原来的图超出 A5 页面，PDF 有两页、第一页是空的）；`export-static/` 是探针对前两个项目写的 `.llx`（重新生成：对新拷贝跑一次探针）和一个手写的 `twice.llx`
（同一文件读两次）。

验证（2026-09-29，TeX Live 2026，不入库的脚本在 scratchpad 的 `impl-export/`）：

- 测试：新增 5 个测试文件 42 个测试（另有 `tests/support/exportHost.ts`：用插件的 `Compiler` 做完整构建的 Node 宿主）。`tests/exportTree.test.ts` 20 个（行和注释规则、`\verb` 各种形式、verbatim 和 listings 的选项、
  嵌套 `\iffalse`、定义是代码（13 种定义和改名的 `\nc`）、公式的分隔符和偏移、`%` 在公式里、段落结束行内公式、文字参数里的公式、
  嵌套的数学环境、`\\[2pt]` 和 `\\*`、多余的 `\end` 和没关的 `\begin`、elegantbook 两种框的写法、跨一个换行的参数、跨段落的
  `\footnote`、`\caption` 里的公式、字体开关的组、`\item`、用户宏签名、`\url`/`\href` 原样、重音和 tabular；每个夹具文件的覆盖；和
  unified-latex 的差分；5700 行章节的时间；`main.js` 不打包 unified-latex）、`tests/exportPlan.test.ts` 6 个（文件图含嵌套的
  notation.tex、访问顺序和父行、`\includeonly`、读两次、插桩副本的行数和插入以外的字节、片段、`\tikz` 和片段里的 `\input` 仍是访问、
  探针配置）、`tests/exportProbeLog.test.ts` 8 个（静态 `.llx`：记录、目录项、颜色模型、tcolorbox 的两次步进、按访问定位的
  文献目录项、`\tag` 复原和 subequations、孤儿和缺失的步进、读两次的文件）、`tests/exportProbe.test.ts` 5 个（真实 XeLaTeX/pdfLaTeX，
  没有 TeX 时跳过：名字 定义/定理/命题/图/表/目录/证明、颜色等于 `ELEGANT_SCHEMES.blue`、`第一章`/`1.1`、`chapters/ch1.tex` 的归属；
  验收见下）、`tests/run.test.ts` 3 个（假的 TeX 脚本：中止杀掉整个进程组、已中止的信号不启动、超时）。全部 464 个测试通过，
  `npm run check`、`npm run build` 通过。
- 解析：和 unified-latex 1.8.4（devDependency，只给差分测试用）在 5 个夹具项目的 24 个 .tex/.sty 文件上比较环境、公式、verbatim
  和参数个数，650 个事件里 613 个相同，其余 37 个都是有意的（定义体里的宏在这里是代码、elegantbook 的 `g`/`t\label` 参数
  unified-latex 读不了、`\lstinline` 它当成普通命令）。`scripts/gen-perf-fixture.mjs` 的 5700 行章节（243,394 字符）解析中位数
  3.4 ms（最少 2.4 ms；设计稿的 spike 4.9 ms，unified-latex 365–466 ms）。计划 4–10 ms。
- 包大小：`main.js`（生产构建，不压缩）515,042 B，其中 `src/export/` 99,413 B（压缩后 62,456 B），`run.ts` 2,510 B；esbuild 的
  metafile 里没有 unified-latex 或 pegjs 的输入（测试检查）。
- 探针（合成项目的新拷贝，插件的 `Compiler` 完整构建之后）：书（XeLaTeX）1.9–2.3 s、作业 1.4–1.5 s、文章（pdfLaTeX）0.61–0.65 s，
  三个都没有 TeX 错误；书的 196 条记录里 16 条目录项、11 个编号框的步进（合并 tcolorbox 的重复之后）、2 个片段页。输出 3–8 ms，HTML 28 KB / 7 KB / 13 KB。构建新鲜时
  整个导出：书 1.9–2.3 s、作业 1.5 s、文章 0.62 s；陈旧时先完整构建（书 8.9–11.7 s、作业 5.8 s、文章 3.2 s），第二次导出不再构建。
- 验收（`tests/exportProbe.test.ts`）：书的 HTML 目录逐项等于构建目录 `.toc` 里 `tocdepth` 以内的条目（`第一章 概率空间与期望` …
  `第三章 练习`、`A 记号表`、`参考文献`），正文标题的编号按顺序相同；作业（`tocdepth` 2，`第 1 章`、`1.1.1 代码`）同样；文章没有目录，
  4 个节标题的编号和标题等于 .aux 的。忠实性断言 7：书、作业的正文里每一段汉字（文字节点、公式里 `\text` 的参数、verbatim）都在页面
  文字里（中文之间的空格规范化后），书有 150 段以上。取消：探针的 XeLaTeX 在跑时（`pgrep -f llxprobe` 找到）中止，导出约 0.1 s 后以
  `AbortError` 结束，之后没有探针进程。另外检查了 `定理 1.1 (全期望公式 Law of total expectation)`、`(a)` 标签、
  `Cauchy–Schwarz 不等式`、换行两边的中文连起来（`重新出现：条件期望`）、`\term` 展开成 `<b><em>概率空间</em></b>`、`\verb` 原样、
  没有 `<script>`；书的报告里除了 info 没有别的，文章有 `\cref` 等 19 处引用、`Lemma 2.2.`、`(ii)`。
- 画面（无头 Chrome 截图，1000 px，浅色）：书、作业、文章的页头、目录、标题、定理头、列表、listings 和算法的标题都在；公式和片段
  暂时是源码。
- 跑完后没有 xelatex、pdflatex 进程；所有编译都在 `$TMPDIR` 的拷贝和构建目录里，测试结束时删掉它们。
- 还没做：在 Obsidian 里点一次命令（保存对话框、进度 Notice 的 Cancel、写进 vault）；这次不碰任何 vault，留给 S7a 的 GUI 检查。

### S2：数学和编号（2026-09-29）

- **`src/export/math.ts` 的 `ExportMath`**：和实时预览一样经过 `ProjectMath`（项目的定义、垫片宏，失败抛 `MathError`），但
  用导出自己的 CHTML 输出（`new MathJax._.output.chtml_ts.CHTML({fontURL, adaptiveCSS: true})`，经 `ProjectMath.create` 新加的
  可选第四个参数 `{ output, tagSide }` 传进去；不传时和以前一样用 Obsidian 共享的输出，已有测试不变），所以它的样式表只有这次
  导出画过的字形。`stylesheet(html)` 从输出的 `styleSheet(它最后一次渲染的 MathDocument)` 里只留页面用到的：字形规则
  （`mjx-c.mjx-c1D465.TEX-I::before`）按页面里 `mjx-c` 元素的类组合留，字体类（`.TEX-I`、`.MJX-TEX`）按页面用到的类留，有
  可伸缩定界符时留它们的字体栈，再加这些字体（和内联样式里的 `MJXZERO`）的 `@font-face`，woff 内联成
  `data:font/woff;base64`；MathJax 的布局规则全留。字体在 Obsidian 里用 `fetch(MathJax 的 fontURL/文件名)` 取，测试里读
  `node_modules/mathjax` 的同名文件（和 Obsidian 的逐字节相同）。解析样式表要认字符串：`{` 这个字形的规则是
  `content: "{"`，按花括号切会把后面的 `@font-face` 全弄坏（书里的 `\set{0, 1}` 就这样，第一次截图公式全是系统字体）。
- **行和编号（`displayLayout`、`displayTex`）**：显示公式按外层环境自己的 `\\` 分行（`split`、`aligned`、`cases` 里面的不算，
  amsmath 和 MathJax 都不给它们编号），每行记下自己的 `\tag`/`\tag*`（及其文字）、`\notag`/`\nonumber` 和 `\label`；`equation`、
  `multline` 是一行；`alignat{2}` 的列数每一部分都带上。`\intertext`/`\shortintertext`（MathJax 没有）把对齐拆成几部分，中间的
  文字是一个段落（`llx-intertext`，用输出器渲染，里面的行内公式、引用照常）。输出器按探针的步进给每个要编号的行一个号，写成
  行尾的 `\tag{号}`（MathJax 的自动编号是关的）。探针实测的 amsmath 规则（TeX Live 2026）：`equation` 在 `\begin` 处步进一次，
  有自己的 `\tag`、`\notag`、`\nonumber` 时又退回去（这一步取走不显示）；`multline` 和 `align`/`gather`/`flalign`/`alignat` 的行只
  在要编号时步进；`eqnarray` 开头步进一次、每个编号行之后再步进一次、结束时退回最后一次（`eqnarray*` 步进一次又退回）；
  `\\` 结尾会多出一个空行，TeX 给它编号（MathJax 会丢掉只有 `\tag` 的空行，所以空行写成 `{}\tag{号}`）；`subequations` 自己的
  父编号（`2`）由它自己取走不显示，里面的行显示 `2a`、`2b`。没有步进时用该行 `\label` 的 .aux 编号，再没有就是 `?`（报告里一条
  numbering）。`leqno`（文档类选项，或 amsmath/mathtools 的包选项，从源码判断）让 MathJax 的 `tagSide` 为 left。`\label` 在公式
  前面成锚点（行内公式和片段里的 `\label` 也是）；公式里的 `\eqref` 等经 `prepareMath` 的 `formulaRefs` 变成和芯片一样的文字。
- **计划里的 `mathOk`**：计划先跑一遍只收集要问的公式，导出器再逐个检查（渲染，每 30 ms 让一次 UI、检查取消，进度
  “checking the formulas 60/130”），然后正式计划时只查缓存；显示公式按上面的部分逐一检查（不带编号）。MathJax 拒绝的成为片段
  （S5 之前显示源码）。渲染按“显示与否 + 源码”缓存，行内公式在计划里渲染一次、输出时直接用；输出时仍然失败的公式是 `<pre>`
  （行内是 `<code>`）的源码，报告里一条 math warning。MathJax 读不了的项目定义（文章的 `\NewDocumentCommand{\set}{m o}`）是 info。
- **页面**：`renderPage` 多了 `mathCss`；导出器用正文、页头和脚注的 HTML 算样式表。中文和公式之间的空格保留（公式的 `mjx-` 标签
  里没有文字，以前的 `joinCjk` 会把“写作 $X$”的空格当成两个汉字之间的删掉）；全角标点旁边的空格去掉（xeCJK 的做法，书的 PDF 里
  `、 (3.5)` 印成 `、(3.5)`）。报告多了 `numbers`：输出器从 TeX 取的每个号（计数器、显示的值、是否显示、给它命名的标签），
  忠实性测试拿它和探针、.aux 对比。

### S3：引用、文献、脚注（2026-09-29）

- **引用**：`\ref` 这一族的文字就是 latexRefs 的 `refText`（构建目录的 .aux），链接到标签的锚点；不在 .aux 的是不带链接的
  `is-missing`。输出结束时，指向页面上没有的 id 的链接（标签在页面不显示的构造里、引用了页面没列出的文献）变成普通文字，
  报告里一条 ref/cite warning。
- **探针新增的记录**（`probe.ts`）：biblatex 的 `\AtEveryBibitem` 为每个印出的条目写 `llxcite`（没被引用过的条目也有编号）和
  一条 `llxstep{llx@bib}{key}`（按位置归到 `\printbibliography` 的行）；`llxinfo{citestyle}`（`\blx@cbxfile`）和
  `llxinfo{sortcites}`；natbib 在 `enddocument` 时写 `llxinfo{natbib}{numbers,sort,compress}` 和 `natbib-open/close/sep/aysep/cmt`
  （natbib 读 .bbl 时才可能改成数字模式，所以在文末写）。展开值时 `\TextOrMath` 取文字那一支，`\thanks` 的 `\@fnsymbol` 记成
  `\textasteriskcentered`（以前是 `∗*`）。`export-static/*.llx` 重新生成过。
- **`src/export/bibliography.ts`**：`readBbl` 读 biblatex .bbl 第一个数据表里的条目（顺序就是编号的排序），名字分 given/family
  （中文作者只有 family），列表（publisher、location、language）、字段、`\verb` 字段（url、doi），biblatex 的分隔宏换成文字
  （`\bibrangedash` 是 –）。`formatEntry` 按 biblatex 标准样式（standard.bbx，英文字符串）排：作者（`A and B`、`A, B, and C`，
  超过 3 个或 `and others` 是 `A et al.`）、标题（article/inproceedings 等加引号，其余斜体）、语言（`chinese` 照印，`langgerman`
  印 German，英文省略）、`In: 期刊 12.3 (2019), pp. 101–118`、`2nd ed.`、`地点: 出版社, 年`、`DOI:`、`URL: … (visited on 09/01/2026)`，
  和书的 PDF 逐条一致（测试里有 6 条）。`numericLabels`：numeric 按引用顺序、`, ` 连接；numeric-comp（和 natbib 的
  sort/compress）排序，连续三个以上成区间（`[1–3, 6]`），两个照写（`[2, 3]`）；同一个键只出现一次。`postnoteText`：页码或
  区间的后注加 `p.`/`pp.`（`[5, pp. 12–15]`），其他照印（`[5, 第 2 章]`）。`readBibcites` 读 .aux 的 `\bibcite`。
- **输出器的引用**：biblatex 的 numeric/numeric-comp：编号来自 `llxcite`，`[前注 编号, 后注]`，`\textcite` 是 `Li and Doe [2]`，
  `\citeauthor`/`\citeyear`/`\citetitle`、`\supercite`、`\footcite`（一个脚注）；其他 biblatex 样式退回实时预览的作者年份标签
  （报告 info）。natbib 和 LaTeX 的标签来自 .aux 的 `\bibcite`（natbib 用 `\advance` 数自己的计数器，探针看不到步进，所以不是设计稿
  说的 enumiv）：数字模式 `[1, Sec. 3]`、`\Citet` 的 `Roe and Placeholder [3]`、`\citet*` 用全名、`\citealp`、`\citenum`；作者年份模式
  `(Doe and Example, 2023; Lee, 2024)`、`Roe and Placeholder (2022)`；标点用探针记下的 natbib 设定。没有 natbib 的 `\cite` 用
  `\bibcite` 的标签原样（`[Knu84, 1, p. 5]`）。引用命令都有星号参数（签名 `s o o m`），编号链接到文献条目 `#llx-bib-<键>`。
- **文献**：`\printbibliography` 列出探针看到它印出的条目（它那几行里的 `llx@bib` 步进，按印出的顺序），标签是 `[编号]`，标题
  来自目录记录（`heading=bibintoc`）、`title=` 选项，否则有 `\chapter` 的类用 `\bibname`、其余用 `\refname`；`heading=none` 没有标题；
  没有探针记录时列出 .bbl 的全部条目。BibTeX 的 `\bibliography` 在它的位置读构建目录的 .bbl，里面的 `thebibliography` 和文档里
  直接写的一样处理：每个 `\bibitem` 的标签来自 `\bibcite`（natbib 数字模式 `[1]`，作者年份模式没有标签、悬挂缩进；LaTeX 的
  `[1]` 或 `[Knu84]`），`\newblock`、`\natexlab`、`\penalty0`、`\doi` 按 BibTeX 的样式处理。
- **脚注**：`\footnote[7]{..}` 用给定的记号、不取步进；`\footnotemark` 取步进，`\footnotetext` 的文字跟最早一个等着的记号走（给了
  `[记号]` 就找那个）；没有正文记号的脚注不带返回链接。`\maketitle` 里 `\thanks` 的步进 TeX 记在下一行（`\maketitle` 读到下一行
  才执行），所以它的范围延伸到后面的第一个构造；记号跟在标题后面，页面的 `<title>` 不再带上 `\thanks` 的文字。
- **其他**：重音命令（`\"u`）按 texText 的规则变成字符（S1 里当成未知命令）。

验证（2026-09-29，TeX Live 2026，Ghostscript 10，合成项目的新拷贝，不入库的脚本在 scratchpad 的 `impl-export/s2/`）：

- 测试：新增 3 个测试文件 17 个测试，全部 481 个测试通过，`npm run check`、`npm run build` 通过。`tests/exportMath.test.ts` 5 个
  （align 的行、自己的 `\tag{$\star$}`、`\notag`/`\nonumber`、`\\[2pt]`、结尾 `\\` 的空行，`equation` 里的 `split`、`multline`、
  `gather`、带星号的环境、`\[..\]`；`\intertext` 拆分和 `alignat{2}`；项目宏 `\E`、`\KL`、`\loss`、`\iid`；编号行渲染成
  `mjx-mlabeledtr`，`leqno` 在左；失败和计划的检查；样式表只有页面用到的字形规则（先用 Obsidian 共享的输出画 `\mathfrak`、
  `\oint`、`\mathscr`，再用导出的输出画一个页面不显示的公式，两者都不进样式表），只有用到的字体族，数据 URI 解码后和
  `node_modules/mathjax` 的 woff 逐字节相同，`content: "{"` 不破坏样式表）、`tests/exportBib.test.ts` 7 个（.bbl 摘录、中文作者、
  `formatEntry` 和书的 PDF 一致、区间和后注、`\bibcite`，以及输出器在合成项目加手写探针记录上：biblatex numeric-comp、natbib 数字和
  作者年份、LaTeX、退回实时预览标签、脚注记号）、`tests/exportFidelity.test.ts` 5 个（真实 TeX，没有时跳过；没有 gs 时跳过和 PDF
  文字的比较）。
- 验收：书的公式编号序列 `1.1 … 1.4, 2.1 … 2.7, 3.1 … 3.5` 等于 `gs -sDEVICE=txtwrite` 从 PDF 取出的（行尾的括号编号）；文章显示
  `1, 2a, 2b, ⋆, 3, 4, 5`（PDF 的 ASCII 编号相同，外加图里的 `bound (2b)`）；另一个生成的 amsmath 文档（pdfLaTeX：`\tag`、`\notag`、
  `\nonumber`、gather、两种 multline、subequations、split、`\intertext`、flalign、`alignat`、`eqnarray` 和 `eqnarray*`、结尾 `\\`、
  `equation*` 的 `\tag`）21 个编号和 PDF 的逐个相同。忠实性断言 1（书 28 个、文章 13 个、数学文档 14 个带标签的号等于 .aux）、
  2（每个计数器取走的号等于探针合并后的步进，报告没有 numbering 项）、5（每个引用的文字等于 `refText`，书 44 处、文章 19 处，
  每个页内链接都有目标）、6（书的引用编号等于 `llxcite`，文献条目等于 .bbl 的 6 条且编号相同；文章的等于 `\bibcite`，3 条）。
  书显示 `[5, 第 2 章]`、`[2, 3]`、`[1, 5]`、`[6]`、`[4]`，PDF 里是 `[2,3]`、`[1,5]`（gs 丢了空格）；文章的
  `recover them [1].`、`Roe and Placeholder [3] give…`、`see also [1, Sec. 3].`、`Section 2 derives`、`Figures 1 and 2 show the
  trend`、`(Equation (⋆))`、`Proof of Theorem 2.2.`、`see [2, 3].`、`Compare with Theorem 3.1 and Section 1.` 在页面和 PDF 里都有；
  `\thanks` 的记号是 `∗`。书、文章的报告除了 info 没有别的。
- 时间（构建新鲜时的第二次导出，Node + jsdom）：书 1.6 s（计划 107–113 ms，含 130 个公式的检查；探针 1.4 s；输出 60 ms），
  文章 0.5–0.6 s，作业 1.2–1.3 s；陈旧时先完整构建：书 8.2–8.7 s、文章 3.1–3.5 s、作业 5.8–6.1 s。
- 大小：书 446 KB（其中 MathJax 字体 172 KB，11 个字体族，base64 后约 229 KB），文章 285 KB（字体 149 KB），作业 89 KB（55 KB）。
  `main.js`（生产构建，不压缩）557,961 B，其中 `src/export/` 141,990 B（压缩后 87,045 B）。
- 画面（无头 Chrome，1000 px）：公式用 MathJax 的 TeX 字体（`document.fonts` 里 11 个族都是 loaded），cases 的大括号、矩阵的定界符、
  `\sum` 的上下标正确，编号在右边和 PDF 一样；中文和公式之间有空格。
- 跑完后没有 xelatex、pdflatex、latexmk、Chrome 进程；测试的临时目录在测试结束时删掉。
- 还没做：在 Obsidian 里的导出（`fetch` 字体、Obsidian 的 MathJax 做私有输出）只做了类型检查，没有点命令；按设计留给 S7a 的
  GUI 检查。

### S4：外观（2026-09-30）

- **配置 `profiles.ts`**：两套，`profileOf(主文件, 源码)` 按 `\documentclass` 选：elegantbook（任何 `lang`/`mode`/`color`）和 standard
  （article、report、book、AMS 类、ctex 的类）；`lang` 是 `zh-CN`（ctex 的类或宏包、中文 elegant 类）或 `en`。外观都照安装的类印出来的
  样子（elegantbook.cls v4.6、LaTeX 和 amsthm 的默认），编号、名字、颜色仍全部来自 TeX：
  - elegantbook：标题、目录标题、图注标签、列表标签用 structurecolor；章标题居中（`第一章`，`\appendix` 之后 `附录 A`，英文
    `Chapter 1`；目录保留 .toc 的号，和 PDF 的目录一样是 `A 记号表`）；链接 winered，目录里的链接是黑的。fancy 模式的 tcolorbox 定理
    是框：角色色（defstyle main、thmstyle second、prostyle third）的 0.5pt 边框、`角色!5` 的底色、白色粗体标题贴在左上角并跨在边框上、
    右下角 ♣/♡/♠、正文 `\citshape`（lang=cn 是 ctex 的楷体，否则斜体）；类自己的 head（例题、练习、问题、解、笔记、证明、注……）是段首的
    角色色粗体，笔记、练习的左边距有 ☡、✍ 图标，`\citshape` 的 head 正文楷体，证明的正文仿宋（`\cfs`）；simple 模式的 amsthm 定理是角色色
    粗体 head 加楷体正文。封面变成紧凑页头：顶上一条 coverlinecolor 色带、标题、副标题、`作者：/组织：/时间：/版本：` 行（探针的
    `\authorname` 等）、`\extrainfo`。listings 是 structurecolor 细框（它的 `\lstset` 是 `frame=single`），不上关键字颜色；enumerate
    的标签按 enumitem 的颜色，itemize 是 structurecolor 的 ●。
  - standard：标题是正文色的粗体，书的章 `Chapter 1`（附录 `Appendix A`）单独一行在标题上面；定理按 amsthm 的风格（来自普查：plain
    粗体 head、斜体正文；definition 正文直立；remark head 斜体），note `(标题)` 是正常粗细、句点粗体；LaTeX 自己的 `\newtheorem`：head 和
    note 都粗体、正文斜体、没有句点；证明是斜体 `Proof.`（`[标题]` 代替名字），□ 在最后一行右端；居中的标题块，作者按 `\and` 用逗号连。
  - 共同：图注 `图 2.1:`（冒号是 CSS 的 `::after`，页面文字和 `numbers` 不变），子图 `(a)` 和 algorithm 的 ruled 标题没有冒号；`\paragraph`、
    `\subparagraph` 接在段首（输出器把它当下一段的开头）；description 的词条和正文同一行；目录最高一级（书的章、文章的节）粗体；
    脚注的返回链接在最后一段里；含公式的段落 `overflow-x: auto`（比 375 px 宽的行内公式在段落里横向滚动，不撑宽页面；段落是块，
    公式的基线不变）。字体：拉丁衬线在前（elegantbook：TeX Gyre Termes、Times New Roman；standard：Latin Modern Roman、CMU Serif、
    Times New Roman），然后中文衬线栈（Songti SC、Noto Serif CJK SC、Source Han Serif SC）；`font-synthesis-style: none`，中文不会被
    斜体压斜（xeCJK 也不压），中文文档里 `\emph` 和斜体的汉字用楷体（ctex 的斜体就是楷体）。
- **名字**：探针的 `\<name>name` 优先；没有探针（只靠 .aux 的模式）时是 elegantbook 的语言表、ctex 的中文名（目录、图、表、参考文献、
  摘要、附录、证明）或 LaTeX 的英文名（`fallbackName`），输出器里零散的英文兜底（`Contents`、`Figure`、`Abstract` 等）都换成它。
- **颜色**：浅色就是 TeX 的值，和 PDF 一样（所以浅色里 elegantbook 的 second、third 色的字对白底或框的底色只有 2.3–2.5:1，白字在
  它们的标题底上也是）。
  暗色：画文字的颜色和白色按 2 % 一步混合，直到对暗色里最亮的表面（框的底色，按 `#303034` 算）对比度 ≥ 4.5；白字下面的填充（框的
  标题）和黑色混合，直到白字 ≥ 4.5；框的底色是 12 % 的角色色叠在暗背景上。都在 TS 里算好写成 `rgb()`（不用 `color-mix`，浏览器
  算出的值可以直接检查）。页面只用颜色变量：`--llx-c-<名字>`（文字、边框），elegantbook 角色另有 `--llx-f-`（填充）和 `--llx-t-`
  （底色），浅色一套、`prefers-color-scheme: dark` 一套；`\textcolor`/`\color`/`\colorbox` 和列表标签写成 `var(--llx-c-..)`。xcolor 的表达式
  （`blue!70!black`、`red!30`、`-red`、`a!p!b!q!c` 链）用探针报告的基本色按 xcolor 的规则混合（计划把表达式里的颜色名交给探针），
  读不了的是 info，文字用正文色；`\colorbox` 里的文字固定是深色（PDF 里是黑字）。
- **普查分类**：计划把定理表不认识、HTML 画不了的环境做成 TeX 片段；探针之后，普查的 `\meaning` 是 amsthm 或 LaTeX 的 `\@thm`（类或
  宏包里的 `\newtheorem`，项目源码里看不到）时，这个环境按定理输出（`censusTheorems`：标题是 meaning 的标题或探针的 `\<env>name`，
  计数器和是否编号来自 meaning，amsthm 有句点），片段的 SVG 不用，步进照常取；里面有 TikZ 图的仍画成片段；报告一条 info。签名表给
  `\@thm` 的环境一个可选参数（note）。amsthm 的风格（`\th@plain`/`definition`/`remark`、自定义的按 plain）也读普查。
- **探针新增**：`llxname` 多了 author、institute、date、version；颜色多了 winered、coverlinecolor；`\tableofcontents` 时（`cmd/tableofcontents/before`）
  再写一次 `llxinfo{tocdepth}`，正文里的 `\setcounter{tocdepth}` 也算。enumitem 的标签在记录里本来就留着 `\protect \color {structurecolor}`
  （健壮命令，`\llx@expand` 挡不住），输出器现在把它变成标签的颜色。`export-static/book.llx` 重新生成过（只多了上面几行）。
- **导出器分成两段**：`prepareExport`（构建、计划、探针、片段、图片：文件和进程）和 `emitExport`（输出器、MathJax 的样式表、页面：只用
  DOM），`exportHtml` 依次调用；`exportMath(env, prepared)` 在任何窗口里建数学渲染器。`ExportImages` 在 `load` 时记下每个名字找到的文件，
  输出时不再碰文件系统（以前每次输出都再找一遍）。
- **`scripts/export-smoke.mjs`**（无头 Chrome，CDP，和 browser-smoke 一样的进程组和清理，没有 Chrome 或 TeX 时跳过）：三个夹具的新拷贝
  在 Node 里 `prepareExport`（`tests/support/exportHost.ts` 的宿主，PDF 页用 Ghostscript 144 dpi 代替 pdf.js），结果（Map/Set 带标记的 JSON）
  交给页面；页面里用 MathJax 3.2.2（`tex-chtml-full.js` + `ui/safe.js`，app.js 的配置）`emitExport`，字体从 MathJax 的字体目录 `fetch`，和
  Obsidian 里一样由真浏览器测量。页面用的 Node 模块在打包时换成桩（`path` 是一个小的 POSIX 实现，`Buffer` 只给 base64），输出器本来就
  不在输出时读文件。导出的页面单独打开，1000 px 和 375 px、浅色和深色各查一遍：E1 MathJax 和片段的字体都加载（`document.fonts.check('16px
  MJXTEX-I')`）、E2 每个 `mjx-c` 有宽度（不可见运算符 U+2061–2064 除外）、E3 框的边框等于探针的颜色（浅色）、对页面 ≥ 3:1（深色）、
  E4 按设备宽度没有横向溢出（移动视口会把自己撑宽，所以不看 `innerWidth`），滚动的段落不在竖直方向裁掉公式、E5 行内片段在基线上
  （±1 px）、E6 深色里所有文字 ≥ 4.5（浅色只报最小值）、E7 没有控制台错误。截图和导出的页面留在 `$TMPDIR/latex-live-export-smoke/`。

验证（2026-09-30，TeX Live 2026，Ghostscript 10.07，Chrome，合成夹具的新拷贝，不入库的脚本和截图在 scratchpad 的 `impl-export/s4/`、
`impl-export/shots/`）：

- 测试：新增 `tests/exportProfiles.test.ts` 6 个（判断；没有探针时的名字和章标签；颜色：xcolor 表达式、elegantbook 五套配色和 winered、
  xcolor 基本色的暗色变体对 `#303034` 和暗背景都 ≥ 4.5、填充上的白字 ≥ 4.5、已经够的颜色不变、页面变量；普查：amsthm 和 LaTeX 的
  `\newtheorem`、`\lemmaname` 这样的标题经探针名字、各风格的外观；elegantbook 的框、笔记、证明、例题的完整输出、`附录 A`、段首的
  `\paragraph`、彩色的列表标签和 ●、`\textcolor{blue!70!black}`；amsthm 三种风格、LaTeX 的定理（普查把片段换成定理）、两种标题块、
  目录和脚注），`tests/exportFidelity.test.ts` 新增 2 个（断言 3、4）；`tests/exportBib.test.ts`、`exportFloats.test.ts`、`exportProbe.test.ts`
  按新的标记（标题的 `class`、子图注的 `is-sub`、listing 的 `llx-lst`、彩色的枚举标签）改了三处正则。全部 512 个测试通过，
  `npm run check`、`npm run build` 通过，`node scripts/browser-smoke.mjs` 31/31（改了 styles.css）。
- 忠实性断言 3：书的框标题的名字集合等于探针的 定义/定理/命题/引理/推论，`定义 定理 命题 图 表 目录 证明` 等于探针的名字，图注标签
  只有 图、表，目录标题是 目录，段首 head 的名字是探针的 笔记、证明、例题、注、练习、解，文献标题等于 .toc 的 `参考文献`；文章的
  `Definition 2.1 (Linear reconstructor).`、`Lemma 2.2.`、`Theorem 3.1.`、`Remark.`、`Proof of Theorem 2.2.`、`Abstract`、`References`、
  `Table 1`、`Figure 1`、`Figure 2` 在页面和 PDF 的文字（gs）里都有，定义直立、引理斜体、注的 head 斜体。断言 4：页面的颜色变量等于探针的
  值（structurecolor、main、second、third、winered、coverlinecolor），main/second/third 等于 `ELEGANT_SCHEMES.blue`，winered 是
  `rgb(128, 0, 0)`，深色的每个变量对 `#303034` ≥ 4.5，框用自己角色的变量（定义 `is-main`、命题 `is-third`）。
- `node scripts/export-smoke.mjs`：81/81。在页面里输出：书 108–118 ms、文章 33–38 ms、作业 8 ms（新建 `ExportMath`、重新渲染所有公式、
  取字体、样式表）；字体书 11/11 + 片段 7/7、文章 9/9 + 19/19、作业 3/3 + 6/6 都加载；书 1,566 个、文章 522 个、作业 30 个 `mjx-c` 都有宽度；
  书 9 个框的边框等于探针的 main/second/third；行内片段的基线差 0 px（书 1 个、文章 2 个）；375 px 没有横向溢出（S2 记下的 15 px：书里
  两个行内公式比 375 px 的行宽，一个在两层的列表里，现在在各自的段落里滚动，没有段落在竖直方向裁掉东西）；深色文字的最小对比度书 4.56、文章 8.08、作业 6.04，
  浅色的最小值书 2.32（elegantbook 的 second/third 色，和 PDF 一样）、文章 7.28、作业 4.96。
- 时间（Node + jsdom，构建新鲜时的第二到四次导出）：书 1.67–1.91 s（计划 93–109 ms，探针 1.35–1.57 s，片段 152–185 ms，输出 41–56 ms），
  文章 0.74–0.82 s，作业 1.32–1.39 s（负载下一次 2.27 s）；陈旧时先完整构建：书 8.3 s、文章 4.0 s、作业 5.6 s。
- 大小：书 476 KB（在 Chrome 里输出 479 KB：真浏览器量出的 CHTML 尺寸不同）、文章 331 KB、作业 124 KB。`main.js`（生产构建，不压缩）
  620,017 B，其中 `src/export/` 202,187 B（压缩后 125,604 B），`profiles.ts` 21,427 B，`command.ts` 12,934 B。
- 和 PDF 并排比较（`impl-export/shots/*.png`：左边 gs 110 dpi 的 PDF 页，右边 1000 px 的页面，浅色和深色各一张；书 10 组、文章 3 组、作业
  3 组）。一致的：页头的标题行、目录的条目和粗体的章、章节编号和颜色、定理框（颜色、标题、编号、标题的位置、角上的花色、楷体正文）、
  head（例题的绿色、笔记和注的橙色、证明的仿宋）、公式编号、引用的 winered、图注 `图 2.1:`、表的 booktabs 线、`附录 A 记号表`、
  description 同行、problemset 的蓝色编号、算法（TeX 片段）、文章的 amsthm 头、证明的 □、摘要、文献。不同的（页面上可见）：
  - 字体：书的 PDF 是 Fandol 宋体 + Termes，页面是系统的 Songti SC + Times New Roman；文章的 PDF 是 Computer Modern，这台机器没有
    Latin Modern/CMU，页面退到 Times New Roman。PDF 10.95 pt、行距 1.3，页面 17 px、行高 1.75，行更疏。
  - 笔记的图标：PDF 是 manfnt 的危险弯道路牌，页面是 ☡ 字符（系统字体里画得像一个 Z）；练习的 ✍ 近似 bbding 的铅笔手。
  - itemize：PDF 是带阴影的蓝色小球，页面是 structurecolor 的 ●。problemset 标题两边 adforn 的花饰页面没有。`\TeX` 标志是纯文字 `TeX`。
  - `\norm{x}`（`\left\lVert x\right\rVert`）：MathJax 3.2.2 用 Size1 的扩展字形（高 0.602 em），双竖线比 PDF 短；`\norm{y}` 有下伸部分，
    用正常的字形。实时预览里也是这样，属于 MathJax。
  - 表格的行比 PDF 疏（单元格上下内边距）；目录没有引导点和页码；页眉、页码没有；脚注都在页面最后。
  - 作业的 listing：PDF 的关键字（`def`、`for`、`in`、`range`、`len`、`while`、`and`）是 winered、注释是灰的，页面只有框，没有语法颜色；
    PDF 有封面图和单独的目录页，页面是紧凑页头。
  - 文章：PDF 里引用是黑字（hyperref 没有 colorlinks），页面是蓝色链接。
- 跑完后没有 xelatex、pdflatex、latexmk、dvisvgm、Chrome 进程，没有留下 `latex-live-export-*` 临时目录（`latex-live-export-smoke` 是
  故意留下的截图目录）。
- 还没做：listings 的语法颜色；elegantbook 的封面图（设计的默认是紧凑页头）；elegantnote、elegantpaper、ctex 的专门配置（S8）。

### S5：TeX 片段（2026-09-30）

- **探针**（`probe.ts`）：每个片段都是 preview 的一页。`llxfrag`（lrbox）在 `\usebox` 前写
  `\special{dvisvgm:raw <g class="llx-ref" data-id="7" data-y="{?y}"/>}`，`llxblock` 开头写只有 `data-id` 的标记；两个环境都在
  `.llx` 里用 `llxopen{id}`/`llxclose{id}` 把自己括起来，读取时每条步进记下它所在的片段（`ProbeStep.frag`）。探针之后
  `runDvisvgm`（`runTex`：自己的进程组、看门狗、2 分钟超时、可中止）把 DVI/XDV 的每一页转成 `<工作目录>/frag/f<页>.svg`：
  `dvisvgm --page=1- --exact-bbox --currentcolor --font-format=woff2`。页和片段按标记里的片段号对应，不按页序：哪个宏包自己
  `\shipout` 一页也错不了位。没有 dvisvgm（TeX 装得不全）时报告一条 error，所有片段显示源码；dvisvgm 没转完的页报告一条 warning。
- **后处理 `fragments.ts`**（字符串变换，`prepareFragment(svg, id, fontPt, embed)`）：去掉 XML 声明、注释、CDATA 和标记；id、
  `href="#.."`、`url(#..)`、dvisvgm 的字体类（`text.f2`）和 `@font-face` 的字体族都加前缀 `llx<id>-`（书的两个片段各自嵌了一份
  `cmmi10` 的子集，字形不同，不加前缀后一个会盖掉前一个；内联 SVG 的 `<style>` 对整页生效）；黑色变成 `currentColor`
  （`--currentcolor` 只管字形，pgf 自己写 `fill='#000'`）；暗色主题下，和暗背景（`#1b1b1d`）对比度不到 3:1 的颜色（WCAG 对图形的
  要求，`blue!70!black` 是 1.4:1）用 `color-mix(in oklab, c 45%, white)` 提亮，红色、青色、橙色不动；大小按文档字号
  （`llxinfo{fontsize}`，SVG 的单位是 bp）换成 em，所以片段跟着周围文字缩放；行内片段用 `vertical-align:-深度em` 放在基线上
  （深度 = 墨迹底边 − 标记的 y）。实测基线：pdfLaTeX 标记 y=0，XeLaTeX 同一个盒子 y=−64.028（dvisvgm 保留 1in 偏移），两个引擎
  算出的深度都是 2.4907 bp = 2.500 pt，等于 TeX 的 `\dp`（`llxfrag{0}{7.5pt}{2.5pt}`）；红圈 1.4916/1.4930 pt 对 1.49167/1.493 pt。
- **清理**：raw special 能写任何东西，所以只留 dvisvgm 会写的 SVG 元素（`<script>`、`<foreignObject>` 连内容去掉，`<a>` 变成
  `<g>`，其他标签去掉）；属性里的 `on*`、`javascript:`（也认字符引用 `&#106;`）、指向页面外的 `href` 去掉，只留 `#..` 和
  PNG/JPEG/GIF 的数据 URI；样式里的 `@import`、外部 `url()` 去掉；标签按带引号的属性值读（值里可以有 `>`），读不成标签的 `<`
  转义成 `&lt;`，HTML 解析器不会看到过滤器没看到的标签。
- **两个实测出来的问题**：dvisvgm 按字体的 cmap 给字形起码位，Fandol 里“非”和康熙部首“⾮”（U+2FAE）是同一个字形，作业的
  算法里 `非空` 出来是 `⾮空`（看着一样，搜索、复制都错）。现在文本里康熙部首区和部首补充区（U+2E80–U+2FDF）的字符按 NFKC
  换成统一汉字（全角标点不动），这些字改用读者的中文字体画，和页面正文一样。pdfLaTeX 里 TikZ 节点中的 `\includegraphics`，
  dvisvgm（就算加 `--embed-bitmaps`）也只写相对项目目录的文件名，现在由导出器从主文件目录读成数据 URI；XeTeX 的图片 special
  dvisvgm 读不了，XeLaTeX 片段里有图片时报告一条 warning。
- **输出**：行内片段（TikZ 图、`\tikz`、HTML 画不了的表格、MathJax 拒绝的行内公式）是段落里的 SVG；块（显示公式、不认识的环境、
  `algorithmic`）是 `<div class="llx-frag-block">`，显示公式居中（`is-display`），其他左对齐；片段里的 `\label` 在前面做锚点。
  `\tikz ... ;` 的片段在计划里跨好几个兄弟节点，输出器以前只跳过了第一个，后面的路径（`[red] (0,0) circle (0.8ex);`）又当文字
  输出一遍，现在片段范围里的兄弟节点都跳过。没有 SVG 的片段显示源码（`<pre>`/`<code>`），报告一条 fragment warning。
- **片段里的编号**：S1 按行丢步进，和行内片段同一行的构造（同一行的 `\caption`、紧跟在行内公式后面的 `\footnote`）的步进也被丢掉；
  现在按 `llxopen`/`llxclose` 记下的片段号丢（`StepQueue.drop(id)`），丢掉的步进里页面会显示的计数器（equation、figure、table、
  footnote、lstlisting、algorithm、子图、定理类）记进 `report.numbers`（shown，片段里只有一个标签和一个步进时带上标签），忠实性
  断言 2 照样成立，断言 1 核对片段里画出的编号等于 .aux 的。

### S6：浮动体、图片、表格（2026-09-30）

- **图注**：浮动体（figure、table、algorithm，`figure*`/`table*`、wrapfigure、`sidewaysfigure`/`sidewaystable`）里的 `\caption` 用
  探针的名字（`图`、`表`）和步进；步进从浮动体开头找起，因为 subcaption 在第一个子图处就给 figure 步进了（在 `\caption` 之前）。
  `\caption*` 没有标签和编号；subfigure/subtable 的图注是 `(a)`（它的 `\label` 在 `\ref` 里是 `2a`，所以子图注不带标签记进
  `numbers`）；`\captionof{figure}{..}` 在哪里都行，浮动体外面是一个居中的段落（`figcaption` 只能在 `figure` 里）。subfigure 和
  minipage 按 TeX 给的宽度（`0.45\textwidth` 是 45 %，`3cm` 按字号换成 em）并排，`[t]`/`[b]` 是顶端/底端对齐。algorithm 浮动体是
  上下两条粗线、标题下一条细线的“ruled”样式，`algorithmic` 是 TeX 片段。
- **图片 `images.ts`**：输出前（输出器是同步的）读完计划访问的文件里每个 `\includegraphics` 和 `\includepdf`，按 graphicx 的规则找
  文件（`graphics.ts`）。PNG、JPEG、GIF、SVG 原样做成数据 URI；graphicx 的 `width`/`height`（行宽的分数是百分比，长度按字号换成 em）、
  `scale`、`keepaspectratio`、`angle`；没给大小时按 TeX 的自然大小：像素按文件记录的分辨率（PNG 的 pHYs、JPEG 的 JFIF 密度），
  没有就是 72 dpi；页面上都不超过正文宽度。PDF（`\includegraphics[page=n]`、pdfpages 的 `\includepdf[pages=..]`：`1,3-5`、`-`、`3-`、
  `-2`、`last`、倒序、`{}` 是空页不输出，默认只有第一页）经宿主的 `pdfImages(文件, want)` 画成 2 倍的 PNG：Obsidian 里是
  `pdfRenderer.ts` 新加的 `pdfPagePngs`（pdf.js 带 `PDFJS_ASSETS`，每个文件打开一次，`want(页数)` 选页），测试用替身；没有宿主的
  渲染器时页面写 `[文件]`，报告一条 image warning。EPS 不导出（warning，建议换成 PDF/PNG）；找不到的文件、名字里有宏的也是 warning。
  pdfpages 的 `addtotoc` 目录项做成锚点和目录条目。
- **表格 `tables.ts`**：列说明 `l c r`、`p/m/b{宽}`（顶端/居中/底端对齐的段落列，宽度进 `<colgroup>`）、`|` 和 `||`、`@{}`（去掉那边的
  内边距）、`*{n}{..}`、`>{..}`/`<{..}`/`!{..}`（忽略）、siunitx 的 `S`（居中）、`X`；行按 tabular 自己的 `\\` 分，单元格按它自己的 `&`
  分（组和公式里的不算）；行之间的线：`\hline`（两条是双线）、`\cline{a-b}`、booktabs 的 `\toprule`/`\bottomrule`（粗）、
  `\midrule`/`\cmidrule(lr){a-b}`（细）、`\specialrule`，画在下一行单元格的上边（最后一条在最后一行的下边）；`\multicolumn{n}{spec}{..}`
  跨列，用它自己的列说明（包括竖线，也把 `@{}` 的内边距还回来，和 TeX 一样）。有 `\multirow`、`\rowcolor`/`\cellcolor`/`\columncolor`、
  `\rowcolors`、`\hhline`、`\diagbox` 的 tabular 由计划交给 TeX（行内片段）；tabularx、longtable 本来就是不认识的环境（块片段）。
  `\resizebox`/`\scalebox`/`\rotatebox`/`\adjustbox` 里有环境时输出里面的内容（表格按正文宽度）。
- **listings**：`\lstinputlisting[caption=..,label=..,firstline=..,lastline=..]{文件}`（从主文件目录读）和 `lstlisting` 一样有标签、
  标题和探针的编号；读不到的文件是 build warning。

验证（2026-09-30，TeX Live 2026，dvisvgm 3.6，Ghostscript 10.07，合成项目的新拷贝，不入库的脚本在 scratchpad 的 `impl-export/s56/`）：

- 测试：新增 `tests/exportFragments.test.ts` 8 个（静态页：标记给出片段号和基线，pdfLaTeX 和 XeLaTeX 的深度都等于 TeX 的 `\dp`、
  宽高换成 em；两个 `cmmi10` 子集加前缀后分开，每个用到的类都在自己的样式表里；黑色是 `currentColor`、红色不变、`#0000b3` 有暗色
  规则；康熙部首；图里的图片嵌入；清理（script、各种 `on*`、`javascript:`、`&#106;avascript:`、foreignObject、iframe、`<set>`、
  `<animate>`、`@import`、外部 url、带 `>` 的属性值、断开的标签）；没画出来的片段显示源码并报告，片段同一行的图注保住自己的
  编号；真实 TeX 两个引擎：4 个片段都是 SVG，行内深度和探针记录的 `\dp` 差不到 0.1 pt，字体族互不重复）、`tests/exportFloats.test.ts`
  9 个（列说明、长度、`key=value`、pdfpages 的页列表、PNG/JPEG/GIF 的大小和分辨率、booktabs 和竖线表格的每个单元格的类、交给 TeX
  的表格、图片的各种大小和 EPS/缺文件的报告、PDF 图片和 `\includepdf` 经替身渲染（每个文件一次调用，页 1、2、3）、没有渲染器时
  的报告、各种图注和 minipage、`\lstinputlisting` 和 algorithm）、`tests/exportFidelity.test.ts` 新增 3 个、`tests/exportProbeLog.test.ts`
  新增 1 个（片段括起来的步进）。测试工具：`emitDoc`（手写探针记录跑输出器）从 `exportBib.test.ts` 挪进 `tests/support/exportHost.ts`，
  加了项目文件、片段和 `pdfImages`；`testPng` 生成带 pHYs 的 PNG。全部 502 个测试通过，`npm run check`、`npm run build` 通过。
  `export-static/book.llx`、`article.llx` 按新探针重新生成（只多了 `llxopen`/`llxclose`）；`export-static/fragments/` 是
  `fragments/main.tex` 在两个引擎上的 dvisvgm 页（6 个 SVG，共 12 KB）。
- 验收（`tests/exportFidelity.test.ts`）：书的投影图和 tikz-cd 是 SVG（计划 2 个、页面 2 个、没有源码），投影图的标签是 SVG 文字；
  热力图是文件原样的数据 URI，`width:55%`；表 2.1 第一行上边粗线、第二行上边细线、最后一行下边粗线；`fig:projection`、
  `fig:heatmap`、`tab:decomp`、`tab:notation` 的编号等于 .aux。文章的 4 个片段（`$m_i \in \set{0, 1}$` 在行内，`vertical-align:-0.25em`；
  `\[ \set{..}[..] \]`、`keypoint` 框、结果图）都是 SVG，没有源码。作业的 `\includepdf` 页经替身成为图片，算法是 SVG，里面有
  `标记`、`非空`、`未标记`，报告除 info 外为空。生成的浮动体文档（pdfLaTeX：MathJax 拒绝的编号公式、同一行带脚注的行内片段、TikZ 图、
  子图、竖线和双线表格、multirow 表格、`\caption*`、`\captionof`、两种 listings）：编号 1–4 等于 PDF 的（`gs`），11 个带标签的编号
  等于 .aux，每个计数器取走的号等于探针的步进，引用文字等于 `refText`，报告除 info 外为空。
- 画面（无头 Chrome）：书的投影图、tikz-cd、热力图、表格在 1000 px 的浅色和深色下都清楚（深色下 `blue!70!black` 的 x 提亮了）；
  作业的算法（中文）和扫描页；文章的 `$m_i \in \set{0,1}$` 在行内、`\[\set{..}[..]\]`、`keypoint` 块、结果图和表 1。行内片段的基线：
  每个 `vertical-align` 放下后 SVG 的基线和紧跟的零高度 inline-block 的底边差 0 px（书 1 个、文章 2 个）；片段的 32 个字体族在
  `document.fonts` 里都是 loaded。375 px 深色：文章、作业没有横向溢出，书仍是 S2 记下的那个 15 px 宽的行内公式（S4）。
- 时间（构建新鲜时的第二次导出，Node + jsdom）：片段和图片阶段书 174–186 ms（2 个片段），文章 206–234 ms（4 个），作业 247–295 ms
  （1 个片段，加上 Ghostscript 替身画 PDF 页）；整个导出书 1.8–1.9 s、文章 0.78–0.82 s、作业 1.5 s。
- 大小：书 469 KB（S3 446 KB）、文章 328 KB（285 KB）、作业 119 KB（89 KB，其中扫描页的 PNG）。`main.js`（生产构建，不压缩）
  593,986 B，其中 `src/export/` 176,769 B（压缩后 108,446 B），`fragments.ts`、`images.ts`、`tables.ts` 共 21,400 B。
- 跑完后没有 xelatex、pdflatex、latexmk、dvisvgm、Chrome 进程，也没有留下 `latex-live-export-*` 临时目录。
- 还没做：在 Obsidian 里点一次导出（`pdfPagePngs` 用 pdf.js 画 PDF 页只做了类型检查和构建），按设计留给 S7a 的 GUI 检查；
  没有 dvisvgm 时的降级只看过代码路径，没有测试（要一个有引擎却没有 dvisvgm 的 TeX 目录）；XeLaTeX 片段里的图片；带编号的
  显示公式片段按墨迹框居中，编号不在正文右边（TeX 的行宽和左边距没有传给 SVG）。

### S7a：界面（2026-09-30）

- **完成的 Notice**：摘要（`Exported main.html (大小, 时间): n TeX fragments, n warnings`）下面三个按钮，停留 15 s：Open（Electron 的
  `shell.openPath`，用系统的浏览器打开；失败时一条 Notice）、Reveal（`shell.showItemInFolder`）、Report。
- **报告弹窗 `ExportReportModal`**：文件、大小、引擎、配置、总时间和各阶段的时间，数量（标题、公式、定理、片段、图片、文献条目），
  Open/Reveal 按钮；条目按 错误/警告/说明 分组，每条是预览问题列表的 `ll-problem` 行（位置、`[种类] 消息 (×次数)`，没有位置的写种类）；
  vault 里的位置可以点，关掉弹窗并 `plugin.openLocation(文件, 行)`，vault 外的只显示。`report.json` 仍留在工作目录。
- **`exportFolder` 设置**（设置页新的 “HTML export” 标题下）：vault 里的文件夹，空是主文件旁边；对话框建议 `<文件夹>/<主文件名>.html`。
  写入时缺的文件夹会建（vault 里用适配器的 `exists`/`mkdir`，外面用 `fs.mkdir`）。
- **记住目标**：会话里每个主文件对话框返回的路径（导出失败也记），下次导出建议它，优先于 `exportFolder`。
- **文件菜单**：`.tex` 文件的右键菜单里 “Export to HTML”（图标 file-output），导出它所属的文档（`rootFor`）。命令仍只在 `.tex` 的
  LaTeX 编辑器里出现。
- `ExportIo` 多了 `openPath`、`showItemInFolder`（Electron 的 `shell`），测试可以换。数学的宿主用 MathJax 启动时的文档
  （`MathJax.startup.document.document`，Obsidian 里就是主窗口的 `document`）：MathJax 的 HTML 处理器只接受自己窗口的文档。

验证（2026-09-30）：

- `tests/exportCommand.test.ts` 2 个，在 Obsidian 替身上（`tests/support/obsidian.ts` 加了：`Notice` 的 `noticeEl`、`setMessage`、`hide`，
  `Modal`，Obsidian 的 DOM 小工具 `createEl`/`createDiv`/`createSpan`/`empty`/`setText`/`addClass`，`loadPdfJs`）：命令只在 `.tex` 的编辑器
  里可用；右键菜单只给 `.tex` 文件；取消对话框什么也不写、没有进度；`exportFolder` 的建议；对话框答过的路径下次再建议；构建失败的
  Notice；没有对话框时写到建议的路径并提示；没有 TeX 时不弹对话框。第二个（有 TeX）：文章夹具的新拷贝（加一个 `\ref{no:such}`），
  替身会话用插件的 `Compiler` 做完整构建，jsdom 里的 Obsidian MathJax，字体从 MathJax 的字体地址取（测试里的 `fetch` 读 node_modules）；
  写经 vault 适配器到 `exports/main.html`（先建了 `exports`），`report.json` 在工作目录；完成的 Notice 是 `Exported main.html (… KB, … s): 4 TeX
  fragments, 1 warning`，Open、Reveal 把目标交给 shell，Report 打开弹窗（`Warnings (1)`、`sections/intro.tex:行 [ref] \ref{no:such}: not in the .aux`），
  点这一行关掉弹窗并打开那个文件的那一行。第一个 0.3 s，第二个 4.1 s（含完整构建）。
- 还没做：在真的 Obsidian 里点一次（保存对话框、进度的 Cancel、Open/Reveal、弹窗、写进 vault）；这次不碰任何 vault，`command.ts`
  的 Obsidian 部分当时只在替身上测过；后续真实保存、报告、Open/Reveal 见下节。S7b（文件夹打包）仍在以后。

## 2026-09-30：首版收尾与后续开发

当前范围是原会话的实时编辑阶段和 LaTeX HTML 导出，独立路线图功能与 iPad 不在本轮。
用户决定 Tinymist 在当前版本告一段落，以现有验证为基线继续 LaTeX 开发。

### 编辑器修复与实际运行证据

真实 Obsidian 1.13.7 的 5891 行合成章节曾在第 64 行公式首行卡住方向键。DOM 和 CodeMirror 已聚焦，实时层却仍失焦：
排队的焦点事务被随后到达的渲染/选区更新丢弃。共享核心现在合并微任务，用当前状态一起应用所有 `focusChangeEffect`，
同步实时层与光标预览，组字期间延后。新增回归修复前失败；修复后共享测试 57/57，两仓库 B1–B8 各 31/31。
实际重载后 16 次方向键经过 61–76 行，p95 6 ms；190 行定理内 20 次移动经过 795–814 行，框保持，p95 6.2 ms。

真实拼音组字约 8 秒，81 次后台采样中磁盘、编译结果、定理框不变，选定中文后提交。实际键盘输入更新光标公式预览，
保持同一个浮窗 DOM。跨块原生拖选未完成，坐标接口返回窗口定位错误；用户暂不方便操作，浏览器 B3 不能代替原生检查。

P5 的旧裁剪现在按相同文本的出现次数区分，首次编译的悬停等待按主文件释放，卸载结束全部等待。
真实运行时的三个框头、PNG、中文 PDF 第一页、四个裁剪与深色反色正常；关闭预览后的运行时 API 返回真实 TeX 片段，
关闭 fallback 时显示 MathJax 错误。Typst 纸面/数学渲染和实际光标 SVG 预览正常，共享修复已部署到三个既有 vault。

### HTML 完成的实现

- 原生环境展开、import/subfile 上下文、定义及图片/PDF/listing 预加载；空格、Unicode、项目内绝对路径和 `./`/`../`
  经真实 XeLaTeX 验证。精确输入别名读取插桩副本，原始字节和访问顺序不变。
- 重复文件的 SVG 由片段号与访问号识别，字体和元素 id 独立，删除计数器记录限于本次访问；真实图和公式分别显示 1/2、
  (1)/(2)。缺图时报告不再声称编号已显示。
- elegantnote/elegantpaper 中英文、ctex/`scheme=plain` 配置、页头字段间隔、摘要字体和真实 TeX 日期。
- 缓存导言区依赖的新鲜度、缺失输入重建、临时输出清理与字体取消。LuaLaTeX 按原首版计划明确拒绝，其旧 DVI 流程会
  静默丢失 luamplib 图形，不能报告为成功导出。

真实命令从章节找到主文件，原生保存出 249 KB 自包含 HTML，零警告。报告、Open 在 Chrome 打开本地文件、Reveal 在
Finder 选中文件均已验证；中文、两张图片、引用和 (1.1)–(1.5) 编号正确。六个新类的明暗/桌面/窄屏检查 162/162。

### 性能后续目标

`scripts/gen-export-large-fixture.mjs` 生成实际 65 页中文 elegantbook，含定理、数学、表格、TikZ 和文献。
完整构建新鲜时导出 3.76/3.94 s，HTML 相同、零报告项；准确冷态约 22 s，其中完整构建约 17 s。
XeLaTeX 四遍占主要时间，Biber 约 0.43 s。现在通过 latexmk 公开的 `after_xlatex_analysis` hook，
仅移除本次物理构建目录/job 的 `.run.xml` 生成账本依赖：recorder 确认 OUTPUT、logreq 头、请求全部属于 biblatex。
现有用户 hook 保留；其他 XML 和其他 logreq package 保留。实际 XML 修改仍重建，文献修改仍运行 Biber 并收敛。
真实 65 页生产样本三遍 XeLaTeX，冷导出 11.335 s（构建 8.240 s、探针 2.463 s）；新鲜构建 2.931 s，
HTML 完全相同、零报告项。65 页冷态 10 s 目标仍未达到，不能以 warm-only 数据替代。
用户明确决定将 10 s 作为后续优化目标，先进入功能研发。

### 命令与取消的收尾

导出先保存当前缓冲区输入图、文献、已编译依赖与同主文件编辑器，目录外的章节也覆盖，独立项目不保存。
等待本次请求之后的 full start，避免采用此前在跑的完整构建结果。外部 HTML 先写临近临时文件，成功且未取消才 rename；
部分写入失败和取消保留旧文件。vault 内保留 Obsidian adapter.write。
PDF 的读取和 pdf.js loading/render task 接收信号，取消不用等当前页绘制或 PNG 编码结束，后续页不再启动。
命令新增 6 个回归（共 8/8），PDF 宿主 4/4；完整测试 573/573、零跳过，构建通过。
三个基准项目与六个类配置的最终浏览器检查 243/243，包含更新后的日期/字体、明暗主题和窄屏；
hook 的显式成功返回值补丁另经原生定向回归 2/2。

### 功能研发：代码清单语法着色

`\lstinline`、`lstlisting`、`\lstinputlisting` 复用 Obsidian 公开的 `loadPrism()` 和 `tokenize`。
探针在 listings 的 `Init` 记录实际语言/方言与关键字、注释、字符串样式，全局 `\lstset`、`style=`、局部选项、
分组恢复和 class 默认设置都由 TeX 决定。记录按 probe visit 和同行执行顺序消费，SVG 内的代码不重复处理；
输入子文件之后同一行的父文件 inline 也保留自己的记录。

纯 `listings.ts` 自己转义 token，并核对全文逐字不变；不用 Prism HTML hooks，不把 Prism 打进插件或导出页面。
支持标准 grammar 的三类 token、简单字体开关和 `\color`，不重实现 listings 的自定义 lexer、`literate`、`escapeinside`。
不可用的 grammar、复杂样式和不保留源码的 token 流保留完整代码并报告；没有 tokenizer 的 Node 宿主保持既有纯代码输出。
代码标题、标签、编号及外部文件的 `firstline/lastline` 不变，宿主模块加载等待可以取消。

新增探针 4/4、纯渲染 7/7、入口/取消集成 2/2；完整测试 586/586、零跳过，构建通过。
使用 Obsidian 1.13.7 自带的原始 `prism.min.js`，三个基准项目的浏览器检查 82/82：关键字、注释、字符串均有 token，
中文注释保持，明暗主题、窄屏、编号和字体检查通过。`PRISM_JS=/path/to/host/prism.min.js node scripts/export-smoke.mjs`。
新构建已在 courses 重载，LaTeX 源码改动仍在本地。

### 跨领域论文模板（2026-09-30）

以 PLOS、Springer Nature、REVTeX APS/AIP、AASTeX、AMS、LNCS、ACM（含当前 2.20）和 IEEE 的原生类/样式做校准，
原创短稿的 11 配置完整内容验收通过，零警告。补齐正文与导言区前置信息、多作者/机构关系、摘要/关键词/分类、
AASTeX 隐式标题、LNCS 定理、原生编号左右侧、出版者文献包装和引用默认/标点；ACM 匿名/公开两配置按 PDF 核对。
解析器保留完整有效公开声明，MathJax 输入与错误消息仍按原边界过滤。完整测试 688/688、零跳过，构建通过。

来源、版本、许可证、校验值、回归命令及实际显示检查边界见 [template-compatibility.md](template-compatibility.md)。
HTML 仍是可重排阅读版；原生 PDF 保留投稿版式。实时 citation chips 的作者年份摘要仍是已有边界。

### 当前项目的证明引用小窗（2026-09-30）

- [x] 在源码、公式中的 `\ref` 和实时引用芯片上悬停，显示“证明引用关系”。箭头由证明所属定理指向
  被引用定理；默认一层，点击“显示引用”逐层展开，同一定理只出现一次，小窗最多 25 个节点。
- [x] 点击定理 box 展开陈述与证明，保留正文、公式、列表、图片和脚注；卡片内定理引用可继续浏览，
  “源文件”定位到原始文件及行。复杂绘图没有可用渲染时保留源码，不自动编译。
- [x] 定理与证明来自当前输入图和已提交的未保存缓冲区。证明按原生可选标题中的唯一引用、包含关系或
  输入流中紧邻的定理关联；正文和章节阻断近邻关联。跨 `\input` 的证明和标签保留确切访问上下文。
  仅证明正文的字面 `\ref` 建边；数学内部也扫描，注释、声明、verbatim 不建边。重复标签明确显示歧义，
  回环和自引用作为源码事实保留。编号使用最近一次编译的 aux，未关联证明不猜测所属定理。
- [x] source-slice 入口复用 HTML emitter，前置校验原始 AST 与访问身份，上限 64,000 字符、5,000 节点、
  64 次输入访问。只预加载当前卡片的图片，沿用项目私有 MathJax。克隆卡片的内部 DOM/SVG id 独立，
  缓存上限 8 个项目、每项目 32 张卡片；编辑、保存、标签更新、文件增删及主题变化使快照失效。
- [x] 组字和按住鼠标拖选时不打开小窗；过期请求不落地，释放、取消或失焦后恢复。普通引用芯片点击仍进入
  源码编辑，现有按键仲裁不变。当前仓库只处理本地证明引用关系。

真实 Chrome 的 32 项交互检查通过，包括源码/实时、明暗、窄屏、点击节点、循环展开、源码跳转、IME 和
按住鼠标经过实时引用 350 ms 时无小窗、拖选保留。富内容、原始节点身份、跨文件证明、标签歧义、异步失效与
私有 MathJax 均有针对性回归；原有三个 HTML 基准项目的显示回归 81/81 通过。
最终完整测试 725/725、零跳过，生产构建通过。

此前 courses 已重载开发构建。真实 Obsidian 的合成 elegantbook 项目编译零错误、零警告，运行时索引 2 个节点、
1 条来自 `proof-body.tex` 的引用边；展开陈述/证明得到 4 个公式、正确编号和可导航引用。原生鼠标悬停尚未记录，
当时坐标接口返回 `noWindowsAvailable`；Chrome 交互结果与 Obsidian 运行时数据验证分别记录。
5,702 行合成源码的索引测量：冷读取 42.4 ms、缓存读取 0.7 ms；这是单次 Node 数据服务测量，不是完整小窗耗时。

#### 窗格裁切修复（2026-10-01）

DesktopDemo 准备录制时，原生 Obsidian 中已复现：小窗 DOM 有两列，但编辑器祖先的裁切和 transform
使第二列不可见，真实鼠标点击落到旁边 PDF。仅检查节点存在或调用 DOM 的 `click()` 不能发现这个问题。

LaTeX 编辑器现在通过 CodeMirror 官方 `tooltips({ parent })` 将提示窗挂到当前窗口的 `body`，每个编辑器
拥有独立零尺寸容器。外层保留现有编辑器样式作用域，CM 自身复制活动主题类；容器使用 Obsidian 的
`--layer-popover` 层级。恢复历史或编辑器移到弹出窗口时按实际 `ownerDocument` 重建，关闭编辑器时清理。
此设置也用于该 LaTeX 编辑器的补全、诊断和公式提示；共享编辑器模块和按键仲裁保持原样。

`scripts/theorem-graph-smoke.mjs` 已加入 400 px、`overflow: hidden`、带 transform 的编辑窗格和旁边的
合成 PDF 占位层。源码/实时模式与明暗主题都检查第二列实际超出窗格、`elementFromPoint` 命中正确节点，
再用真实 pointer press/release 验证内容展开和源码按钮，并保留拖选、IME、窄屏和循环展开检查。
同一场景的独立 Chrome 检查 44/44 通过；新增门户容器、主题、历史恢复、弹出窗口和清理回归后，
小窗单元测试 12/12 通过。修复后的原生 Obsidian 点击与录制验收另行记录，不以浏览器合成场景代替。

### 可配置编辑外观与 LuaLaTeX（2026-10-02）

- [x] 设置面板新增编辑字号（10–40 px）、行距（1.1–2.4）、源码字体列表和公式预览比例（50–200%）。
  空字号/行距/字体跟随 Obsidian，默认数学比例 100%；作用域只在本视图及其浮窗。
  保存即更新已打开的编辑器，IME 中延后；文字、选区、编辑模式和撤销历史保持。
  两个复用的空 theme 通过 CM compartment 触发字体度量刷新，避免短文档的 min-height 掩盖变化而令行号漂移。
  MathJax 原 CHTML 内联补偿百分比保留；图片、裁剪、错误、加载提示、正文及 PDF 排版不受数学比例影响。
- [x] LuaLaTeX 的真实实时编译验收：fontspec/Fandol 中文、连续编辑请求合并与最新 PDF、Unicode/空格路径
  SyncTeX 双向跳转、latexmk 完整构建/no-op，以及错误保留上一次 PDF、修复后替换来源快照。不开 pdfLaTeX format。
- [x] LuaLaTeX HTML 使用原生 PDF 探针，保留 Lua/MetaPost、TikZ、中文字体和图像；pdfLaTeX/XeLaTeX 原 DVI/XDV
  路径保持。shipout 的 `.llx` 元数据记录 source id、visit、实际物理页、savepos 与页尺寸，恢复 SVG 绘图身份和基线。
  重复输入与额外未标记页不靠页顺序猜测；基线同时按原生 box depth 与 preview border 独立核对。
  导出及既有 CLI adapter 支持三种引擎；取消仍杀本次进程组。缺失 PDF→SVG 后端或零输出会明确报告，保留源内容。
  本机 dvisvgm 3.6 使用 Homebrew mupdf-tools 1.28.5；转换子进程在既有 PATH 找不到 mutool 时才补标准目录，
  不改变全局 PATH。其他机器需安装 dvisvgm 支持的 PDF 后端。

完整测试 763/763、零跳过，生产构建通过。新 Lua 原生/会话/导出及 bridge 定向验收均通过；原 pdf/Xe 与原生类探针
回归保留。隔离 Chrome：外观 11/11、Lua 导出 27/27、共享实时编辑 31/31、定理小窗 44/44；
Lua 行内 SVG 基线与文字相差约 -0.01 px，32 个片段字体全部加载，明暗主题和 375 px 窄屏零溢出、零控制台错误。
本次用户明确允许录屏期间并行验证；录屏进程和录制窗口没有被停止或重载。

静态 `.llx`/SVG 再生成：`node scripts/regen-export-fixtures.mjs`。GUI 源和 PNG/PDF：
`node scripts/prepare-editor-fixture.mjs <scratch-folder>`。PDF、截图和运行日志留在临时目录，不进入 Git。

#### 原生录制与最终回归（2026-10-01）

ScreenCaptureKit 独立窗口录像已覆盖源码/实时模式、输入补全、错误恢复、公式提示、TikZ 裁剪、
证明引用图与陈述/证明展开、八个论文模板家族的十个配置，以及 HTML 保存、报告、浏览器阅读与引用跳转。
实际 PDF 双击将首行光标移动到同文件第 18 行，符合相同 PDF 点的 SyncTeX 反查结果；正向定位也可见。
YOLO 实际模型请求、附件内容校验、原生 Tab 接受/Undo、Enter 仅换行/Undo、审阅实际答复后的原生粘贴与
完整 PDF 构建均有录像和独立收据。首次请求中断和录制驱动的失败尝试保留，发布片只截取已验证的原速区间。
没有用这些录像替代尚未完成的操作系统跨块拖选验收，也没有做 Overleaf 同稿速度实验。

小窗的鼠标释放监听随实际 `ownerDocument.defaultView` 迁移；新窗口的 mouseup/pointercancel 可解除
按住状态，旧窗口事件不干扰当前编辑器。新增回归使用 CodeMirror 官方 `EditorView.setRoot`。
最终完整测试 **740/740、零跳过**，生产构建通过，永久证明小窗 Chrome 回归 **44/44**；共享模块、测试和
样式与 Tinymist 保持逐字节一致。实际日志与录制收据保留在本机 `LaTeX-Live-Demo-2026-09-30/evidence/`。

## 项目写作工具（2026-10-02）

实现与验证入口见 [project-writing-tools.md](project-writing-tools.md)。

- [x] 跨文件项目大纲与章节/证明/环境折叠；键盘编辑不进行结构扫描。
- [x] 当前根与输入文件搜索、按文件分组导航、跨文件替换预览。
- [x] 全量本地文献检索与补全，作者/标题/年份/key 和完整字段，无 texlab 50 条限制。
- [x] label 全引用与安全跨文件重命名；配对 begin/end 重命名；CAS/IME/多 pane/CRLF/备份与撤销。
- [x] 按需正文词数和中文字符统计、用项目签名排除公式与命令的系统拼写检查。
- [x] 显式剪贴板表格转换为 tabular/booktabs，预览后插入，一次撤销；支持单行/单列。
