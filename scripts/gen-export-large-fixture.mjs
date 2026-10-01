// A synthetic 65-page elegantbook for the HTML export's performance acceptance.
// No private notes or build artifacts. Run export-smoke.mjs on the printed folder.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "latex-live-large-book-"));
const out = [String.raw`\PassOptionsToPackage{fontset=fandol}{ctex}
\documentclass[lang=cn,mode=fancy,color=blue]{elegantbook}
\usepackage{amsmath,tikz}
\addbibresource{refs.bib}
\newcommand{\R}{\mathbb{R}}
\begin{document}
\chapter{合成大书验证}`];
for (let i = 1; i <= 64; i++) {
  out.push(String.raw`\section{第 ${i} 页的内容}
令 $x_{${i}}\in\R$，则 $x_{${i}}^2\ge 0$。这是完全合成的性能验证材料。
\begin{definition}{测试定义 ${i}}{page-${i}}
这里的定义用于检查中文名称、定理配色与编号。
\end{definition}
\begin{equation}\label{eq:page-${i}}
S_{${i}}=\sum_{k=1}^{${i}}\frac{1}{k^2}+\int_0^1 t^{${i}}\,dt.
\end{equation}
由公式~\eqref{eq:page-${i}} 和定义~\ref{def:page-${i}}，可得到这一页的结论。参考文献~\cite{synthetic}。
\begin{tabular}{cc}项目 & 数值 \\ 甲 & ${i} \\ 乙 & ${i + 1}\end{tabular}`);
  if (i % 8 === 0) out.push(String.raw`\begin{tikzpicture}\draw[blue,thick] (0,0)--(1,1);\node at (1.5,.5){第 ${i} 页};\end{tikzpicture}`);
  if (i < 64) out.push("\\newpage");
}
out.push("\\printbibliography[heading=bibintoc]\n\\end{document}\n");
writeFileSync(join(dir, "main.tex"), out.join("\n"));
writeFileSync(join(dir, "refs.bib"), "@book{synthetic,author={Synthetic Author},title={Synthetic Reference},year={2026},publisher={Example Press}}\n");
console.log(dir);
