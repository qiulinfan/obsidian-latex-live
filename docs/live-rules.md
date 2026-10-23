# 实时编辑规则：公式别名、外壳环境、隐藏命令

在 **设置 → LaTeX Live → Live editor rules** 里有三个栏目，各有一个 **Edit** 按钮，
打开一个 JSON 编辑窗口。规则对所有项目生效，只影响实时编辑视图；PDF、原生引用和
HTML 导出（`src/export/`）仍按 TeX 本身处理，不读这些规则。

## 三类规则

| 栏目 | 显示 | JSON 示例 |
| --- | --- | --- |
| Formula environments（公式别名） | 把环境当成某个已知公式环境渲染：编号、`\label` 显示为 `\tag`、出错时退回源码，都沿用目标环境 | `{ "myeq": "equation", "myalign": "align" }` |
| Wrapper environments（外壳） | `\begin`/`\end` 两行连同参数折叠，里面的文字和公式照常实时渲染；光标进入这两行时显示源码 | `["subequations", "minipage"]` |
| Hidden commands（隐藏命令） | 命令连同参数隐藏，光标碰到时显示源码；独占一行时整行折叠 | `["centering", "DeckLayout"]` |

别名不能当外壳：公式环境里没有 `$`，收掉外壳后里面会按普通文字显示。所以同一个名字
不能同时是公式别名和外壳，保存时会报错。

隐藏命令的参数个数按顺序取：

1. 项目导言区 `\newcommand{\X}[n]`（以及 `\renewcommand`、`\providecommand`、`\DeclareRobustCommand`）的参数个数；
2. 内置表（`\vspace`、`\hspace` 各 1 个参数，其余内置命令 0 个）；
3. 都读不到时，只藏紧跟在命令后的 `[…]` 和 `{…}`。

参数不完整（例如少一个 `{…}`）时不隐藏，保持源码。

## JSON 只写你自己加的条目

内置默认值在编辑窗口里只读列出，不写进你的 JSON，插件以后新增的默认值会自动生效。

- 名字是字面名字：不带 `\`、花括号或空格。
- 公式别名的目标必须是已知公式环境（下表的内置列表）。写 `"source"` 让该环境保持源码，
  包括内置的和自动识别出的环境。
- 外壳和隐藏命令写 `"!name"` 关掉一个内置或自动识别的条目，例如 `["!subequations"]`。
- JSON 写错或名字不合规时，窗口里显示错误，不保存。保存后，已打开的编辑器立即重新扫描。

## 三层来源

优先级从高到低：

1. **用户规则**：上面的三个 JSON。
2. **自动识别**：读项目所有源文件的 `\newenvironment` / `\NewDocumentEnvironment` / `\newcommand`：
   - 开始代码恰好是 `\begin{E}`、结束代码恰好是 `\end{E}`，且 E 是内置公式环境 → 公式别名 E；
   - 开始和结束代码只有内置外壳环境的 `\begin`/`\end` 和排版命令（`\centering`、`\vspace{…}` 等）→ 外壳；
   - 宏体只有排版命令的 `\newcommand` → 隐藏命令。
   - 其他一律不猜，保持源码。例如含 `\small`、`\textbf{…}` 或定理环境的定义都不识别。
   同一名字定义多次时以最后一次为准。
3. **内置默认值**。

同一个环境名也出现在当前项目的 Custom template profile 里时，以 profile 为准
（按项目指定，范围更具体）。

## 内置默认值

- 公式环境：`equation`、`align`、`gather`、`multline`、`flalign`、`alignat`、`eqnarray` 及其带 `*` 的形式，
  `displaymath`、`math`、`xalignat`、`xalignat*`、`xxalignat`。
- 外壳环境：`itemize`、`enumerate`、`description`、`problemset`、`center`、`figure`、`figure*`、`table`、
  `table*`、`subequations`、`minipage`、`flushleft`、`flushright`、`adjustbox`；beamer 里另有 `columns`、`column`。
- 隐藏命令：`centering`、`raggedright`、`raggedleft`、`vfill`、`hfill`、`medskip`、`smallskip`、`bigskip`、
  `noindent`、`par`、`newpage`、`clearpage`（0 个参数），`vspace`、`hspace`（1 个参数）；beamer 里另有
  `\tiny` … `\Huge` 和 `\pause`（0 个参数）。
- `\centering` 之后和 `center` 环境里的行居中显示。

## 同一处的另外两项

- **图表标题**：`figure`/`table` 里的 `\caption{…}` 显示为 `Figure n: …` / `Table n: …`，编号取自
  `.aux` 中同一浮动体的 `\label`。还没有编号（未编译、没有 `\label`）时只隐藏命令本身，标题文字照常显示。
- **跳到标签**：`\ref`、`\eqref`、`\cref` 等引用标记像 Obsidian 的链接一样可以点击：鼠标悬停时显示手形光标和下划线，
  单击（带不带 Cmd/Ctrl 都行）跳到对应的 `\label`：在当前文件就移动光标并滚动到那里；在项目的其他文件就打开该文件并定位。
  要修改引用本身，点在标记紧旁边（左侧或右侧），或用方向键移进去，就会显示源码；Shift-点击和 Alt-点击也不跳转。
  `\cite` 不跳转。

## Beamer

根文件是 beamer 时另有一组显示（帧卡片、页码、标题页折叠、overlay、横幅宏和图片宏），外壳多 `columns`、`column`，
隐藏命令多字体大小命令和 `\pause`，排版宏的自动识别也更宽：`\setlength`、`\csname…\endcsname` 组合出的
布局宏（如 `\DeckLayout`）会被隐藏。见 [Beamer 幻灯片的实时编辑](./beamer.md)。

## 例子：自动识别不了的布局宏

导言区定义 `\newcommand{\DeckLayout}[1]{\def\decklayout{#1}}` 时，宏体不是排版命令，自动识别不会隐藏它
（beamer 里也不会）。在 Hidden commands 里写 `["DeckLayout"]`，参数个数 1 从 `\newcommand` 读出，
`\DeckLayout{two}` 整体隐藏。
