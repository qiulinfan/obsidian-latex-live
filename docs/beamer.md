# Beamer 幻灯片的实时编辑

根文件的文档类是 `beamer`（`\documentclass[…]{beamer}`）时，实时编辑视图按幻灯片显示。
判断只看根文件；`\input` 进来的章节文件跟随它的根。下面除「居中」一项外，都只在 beamer 里生效，
论文（`article`、`book` 等）不变。和 [实时编辑规则](./live-rules.md) 一样，这些只影响实时编辑视图，
PDF 和导出仍按 TeX 处理。

## 显示

| 源码 | 显示 | 光标进入时 |
| --- | --- | --- |
| `\begin{frame}[t]{标题}{副标题}` … `\end{frame}`（`\begin`、`\end` 各自独占一行） | 一张卡片。`\begin` 行是标题栏：标题（其中的公式照常渲染）和副标题，选项和其余标记隐藏；`\end{frame}` 行折叠。卡片内容照常编辑，里面可以有定理框 | 该行显示源码 |
| `\frametitle{…}`、`\framesubtitle{…}` | 标题栏样式的一行，命令和花括号隐藏 | 显示源码 |
| 卡片右上角的页码 | 这一帧在 PDF 里的页码，带 overlay 的帧显示 `a–b`。点击让已打开的 PDF 预览跳到第一页；没有打开预览时不做任何事 | — |
| `\titlepage`（beamer 里的 `\maketitle` 同样）独占一行 | 居中的标题页卡片：导言区的 `\title`（大字）、`\subtitle`、`\author`、`\institute`、`\date`。卡片不可编辑，点击打开 `\title` 所在的行（可能在另一个文件） | 显示源码 |
| `\pause`，以及 `\item`、`\only`、`\onslide`、`\uncover`、`\visible`、`\alt` 的 `<…>` | 隐藏；`\only<2>{文字}` 只藏 `\only<2>{` 和 `}`，参数照常显示 | 显示源码 |
| `columns`、`column` 环境 | 外壳：`\begin`/`\end` 行折叠，各列上下排列（不并排） | 显示源码 |
| 字体大小命令（`\small`、`\Large` 等） | 隐藏 | 显示源码 |
| 横幅宏的调用，例如 `\sectionframe{Part}{标题}{说明}` | 一张居中的横幅卡片，各参数分行显示，参数可以直接编辑；右上角是页码 | 显示源码 |
| 图片宏的调用，例如 `\DeckFigure[height=3cm]{figures/a.pdf}`，独占一行 | 显示图片（同 `\includegraphics`） | 显示源码，图片在下方 |
| `tikzpicture`（以及 `tikzcd`、`pgfpicture`、`circuitikz`） | 折叠成一行「▸ TikZ (N lines)」。点击或光标进入时展开成源码 | 显示源码 |
| `tabular` 等表格 | 源码 | — |

**居中**（论文也生效）：`\centering` 之后到所在分组结束的行，和 `center` 环境里的行，按行居中显示，
内容仍是可编辑的文字。

### 页码从哪里来

页码读编译输出目录里的 `<根文件名>.nav`：beamer 每帧写一条 `\beamer@framepages{a}{b}`，按帧的顺序排列。
插件按阅读顺序数帧：根文件 `\begin{document}` 之后的 `\begin{frame}` 和横幅宏的调用，遇到
`\input`/`\include` 就先数被读入的文件（深度优先，注释里的不算）。两边的帧数相等时，第 n 帧显示 `.nav` 的
第 n 条。帧数不等（例如刚加了一帧还没编译，或帧由别的宏生成）时不显示页码，重新编译后恢复。

## 自动识别的宏

只在 beamer 里，读项目所有源文件的 `\newcommand` / `\renewcommand` / `\providecommand` /
`\DeclareRobustCommand`，同一名字以最后一次定义为准：

1. **横幅宏**：宏体里有 `\begin{frame}`。调用按横幅显示，参数个数取自定义。
2. **图片宏**：宏体实质上只有一张图——`\includegraphics[…]{#k}`（或另一个图片宏，路径是 `#k`），外面只有
   花括号和排版命令（第 3 条的命令）。调用独占一行时显示第 k 个参数指向的图片。
3. **排版宏**（隐藏）：宏体只由下面这些组成：
   - [实时编辑规则](./live-rules.md#三层来源) 里论文也认的排版命令（`\centering`、`\vspace{…}`、内置外壳环境等）；
   - 字体大小命令、`\pause`、`\setlength{…}{…}`、`\addtolength{…}{…}`、`\addvspace{…}`；
   - `\renewcommand{\arraystretch}{1.2}`（或 `\baselinestretch`）这类只改行距参数、值里没有命令的定义；
   - `\csname P#1\endcsname`，且项目里所有名字以 `P` 开头的宏都已识别为排版宏；
   - 已识别的排版宏，以及只起分组作用的花括号。

   宏体有没用到的参数（`\newcommand\x[1]{}`），或源文件在排版时给这个名字赋值（`\g@addto@macro`、`\appto`、
   `\def`、`\let` 等，也包括名字作为参数传给做赋值的宏）时，不算排版宏，保持源码。

   识别反复进行到没有新结果为止，所以排版宏可以调用别的排版宏。例如
   `\newcommand{\DeckLayout}[1]{\DeckNormal\csname DeckFamily@#1\endcsname\DeckMathSpacing}`：
   `\DeckFamily@…` 都只有 `\setlength` 或 `\renewcommand{\arraystretch}{…}`，`\DeckNormal`、
   `\DeckMathSpacing` 也只有排版命令，于是 `\DeckLayout` 被隐藏。

其他定义一律不猜，保持源码。想关掉某个识别结果，在 Hidden commands 里写 `"!name"`；没识别出的，按
[实时编辑规则](./live-rules.md) 手动加。

## 设置

**Crop tabular/TikZ in beamer**（默认关）：打开后，beamer 里的表格和 TikZ 图和论文一样显示为 PDF 裁剪图，
不再折叠。论文里的裁剪不受这个设置影响。

## 不做的

- 分栏并排显示：`columns` 只折叠外壳，各列上下排列。
- 帧选项（`[t]`、`[fragile]` 等）和 overlay 规格不影响显示，只隐藏。
