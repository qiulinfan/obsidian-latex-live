import { type Dirent, existsSync, promises as fsp } from "fs";
import { basename, delimiter, dirname, join, relative } from "path";
import { texEnv, texTool } from "../tex/binaries";
import type { Engine } from "../tex/project";
import { abortError, runTex } from "../tex/run";
import type { ExportPlan, ProbeConfig } from "./plan";

// The probe pass (design 3.2): one extra TeX run over the plan's instrumented copies, in the
// export's work folder (`<build folder>-export`, a sibling: readAuxLabels scans the build folder
// three levels deep), with llxprobe.sty loaded before \documentclass. It writes <job>.llx (see
// probeLog.ts) and a DVI whose pages are the fragments (the preview package), which dvisvgm turns
// into SVG (`runDvisvgm`, fragments.ts).
//   <engine> <DVI flag> -interaction=nonstopmode -file-line-error -jobname=<job>
//            "\RequirePackage{llxprobe}\input{<root file>}"          cwd: the work folder
//   TEXINPUTS=.:<work>/src:<root folder>: (+ the user's): the instrumented copies first, then the
//   project's own files (local packages, images, files the plan did not parse).
// The build folder's .aux files (\include's in their subfolders), .bbl and .toc are copied in
// first, so references, citations and the contents typeset as in the PDF; labels and page
// numbers are always read from the build folder itself.

/** What a probe run needs from the export's host. */
export interface ProbeHost {
  binDir: string;
  engine: Engine;
  shellEscape: boolean;
  buildDir: string;
  workDir: string;
  /** Stall watchdog (default 30 s). */
  stallMs?: number;
}

export interface ProbeResult {
  /** The .llx file's text; null when TeX wrote none (it failed before \documentclass). */
  llx: string | null;
  /** The run's log ("" without one). */
  log: string;
  /** What the run printed, for a run without a log. */
  output: string;
  stalled: boolean;
  timedOut: boolean;
  /** The DVI (pdfLaTeX) or XDV (XeLaTeX) of the fragments, when written. */
  dvi: string | null;
  durationMs: number;
}

/** LuaLaTeX needs a PDF-mode probe; the first release refuses it before using this table. */
const DVI_FLAGS = { pdflatex: "-output-format=dvi", xelatex: "-no-pdf" };

const csList = (names: readonly string[]) => names.filter((n) => /^[A-Za-z@*]+$/.test(n)).join(",");

interface ProbeInput { source: string; copy: string; key: string }

/** Exact aliases only for the in-project sources the planner made instrumented copies of. */
function inputAliases(inputs: readonly ProbeInput[]): string {
  const text = (path: string) => String.raw`\detokenize{${path.replace(/\\/g, "/")}}`;
  const aliases = inputs.map(({ source, copy, key }) =>
    String.raw`\llxmapinput{${text(source)}}{${text(copy)}}{${text(dirname(key) === "." ? "" : dirname(key))}}{${text(basename(key))}}`,
  ).join("\n");
  return String.raw`% TEXINPUTS cannot shadow an absolute input or import.sty's absolute input@path. Remap
% the resolved file just before LaTeX reads it, retaining CurrentFile* for import/subfile context.
% Kernel file substitutions key only by basename, so they cannot distinguish two detail.tex files.
\ExplSyntaxOn
\prop_new:N \g_llx_input_prop
\prop_new:N \g_llx_key_prop
\tl_new:N \l_llx_input_tl
\tl_new:N \l_llx_copy_tl
\int_new:N \g_llx_visit_int
\seq_new:N \g_llx_visit_seq
\seq_gpush:Nn \g_llx_visit_seq {0}
\tl_new:N \l_llx_visit_tl
\cs_new_protected:Npn \llx@enterfile
  {\int_gincr:N \g_llx_visit_int \seq_gpush:Nx \g_llx_visit_seq {\int_use:N \g_llx_visit_int}}
\cs_new_protected:Npn \llx@leavefile
  {\seq_gpop:NN \g_llx_visit_seq \l_llx_visit_tl}
\cs_new:Npn \llx@visit {\seq_item:Nn \g_llx_visit_seq {1}}
\cs_new_protected:Npn \llxmapinput #1#2#3#4
  {
    \tl_set:Nx \l_llx_input_tl {#1}
    \prop_gput:NVx \g_llx_input_prop \l_llx_input_tl {#2}
    \prop_gput:NVx \g_llx_key_prop \l_llx_input_tl {{#3}{#4}}
    % import.sty uses openin's automatic .tex extension and may hand the hook an extensionless
    % absolute name; file_full_name:n does not resolve that name. Both exact spellings alias it.
    \regex_replace_once:nnN { \.tex\Z } {} \l_llx_input_tl
    \prop_gput:NVx \g_llx_input_prop \l_llx_input_tl {#2}
    \tl_set:Nx \l_llx_input_tl {#2}
    \prop_gput:NVx \g_llx_key_prop \l_llx_input_tl {{#3}{#4}}
  }
\cs_new_eq:NN \llx_original_input: \@input@file@exists@with@hooks
\cs_set_protected:Npn \@input@file@exists@with@hooks #1
  {
    \tl_set:Nx \l_llx_input_tl {\tl_trim_spaces:n {#1}}
    \tl_remove_all:Nn \l_llx_input_tl {"}
    \tl_set:Nx \l_llx_input_tl {\tl_to_str:V \l_llx_input_tl}
    \prop_get:NVNTF \g_llx_input_prop \l_llx_input_tl \l_llx_copy_tl
      {\exp_args:Nx \llx_original_input: {"\l_llx_copy_tl"\c_space_tl}}
      {\llx_original_input: {#1}}
  }
\cs_new:Npn \llx@filefields
  {\exp_args:Ne \llx_file_fields:n {\tl_to_str:e {\CurrentFilePathUsed/\CurrentFileUsed}}}
\cs_new:Npn \llx_file_fields:n #1
  {
    \prop_if_in:NnTF \g_llx_key_prop {#1}
      {\prop_item:Nn \g_llx_key_prop {#1}}
      {{\CurrentFilePathUsed}{\CurrentFileUsed}}
  }
\ExplSyntaxOff
${aliases}
`;
}

/** llxprobe.sty for a plan's configuration (the file comment of probeLog.ts lists its records). */
export function probeSty(cfg: ProbeConfig, inputs: readonly ProbeInput[] = []): string {
  // LNCS's \institutename is a stateful typesetter, not a label. Even manually constructed
  // probe configurations may only expand these optional names for a verified class contract.
  const titleNames = cfg.titleLabels === "elegantbook" ? ["author", "institute", "date", "version"] : [];
  const names = cfg.names.filter((n) => !["author", "institute", "date", "version"].includes(n) || titleNames.includes(n));
  return String.raw`% llxprobe.sty: LaTeX Live's HTML export probe, generated for one export (not user code).
\ProvidesPackage{llxprobe}[2026/09/29 LaTeX Live export probe]
\def\pgfsysdriver{pgfsys-dvisvgm.def}
\ifdefined\XeTeXrevision\else\ifdefined\directlua\else
  \PassOptionsToPackage{dvisvgm}{graphicx}\PassOptionsToPackage{dvisvgm}{graphics}\PassOptionsToPackage{dvisvgm}{xcolor}
\fi\fi
\newwrite\llx@out
\immediate\openout\llx@out=\jobname.llx
\def\llx@write#1{\immediate\write\llx@out{#1}}
${inputAliases(inputs)}
\def\llx@where{\llx@filefields{\the\inputlineno}}
\def\llx@gobblethree#1#2#3{}
% Expand a value for the log with typesetting commands silenced (\color, font sizes) and text
% chosen over math (\@fnsymbol's \TextOrMath).
\def\llx@expand#1#2{\let\color\@gobble\let\@setfontsize\llx@gobblethree\let\TextOrMath\@firstoftwo\protected@edef#1{#2}}
% Keep dates from this TeX run, not the exporting host's calendar. \maketitle clears \@date
% in the article classes, and elegantbook deliberately starts with an empty date.
\def\llx@valueinfo#1#2{\begingroup\llx@expand\llx@t{#2}%
  \llx@write{llxinfo{#1}{\unexpanded\expandafter{\llx@t}}}\endgroup}
\def\llx@titleinfo{%
  \ifdefined\today\llx@valueinfo{today}{\today}\fi
  \ifdefined\@date\llx@valueinfo{title-date}{\@date}\fi}
% Compare newif flags rather than expanding conditional tokens. Undefined flags never enter
% a skipped branch with a stray \else/\fi (ordinary article has neither amsmath nor ACM flags).
\def\llx@tagleft#1{\llx@write{llxinfo{equation-tag-side}{left}}}
\def\llx@tagfalse#1{\ifx#1\iffalse\llx@write{llxinfo{equation-tag-side}{right}}\fi}
\def\llx@tagbool#1{\ifx#1\iftrue\let\llx@tagresult\llx@tagleft
  \else\let\llx@tagresult\llx@tagfalse\fi\llx@tagresult#1}
\def\llx@kernelTagSide{\@ifundefined{if@leqno}{%
  \@ifundefined{ver@leqno.clo}{\llx@write{llxinfo{equation-tag-side}{right}}}{\llx@write{llxinfo{equation-tag-side}{left}}}%
  }{\llx@tagbool\if@leqno}}
\def\llx@taginfo{\@ifundefined{iftagsleft@}{\llx@kernelTagSide}{\llx@tagbool\iftagsleft@}}
\def\llx@anontrue{\llx@write{llxinfo{title-anonymous}{true}}}
\def\llx@anonfalse{\ifx\if@ACM@anonymous\iffalse\llx@write{llxinfo{title-anonymous}{false}}\fi}
\def\llx@anonymousinfo{\ifx\if@ACM@anonymous\iftrue\let\llx@anonresult\llx@anontrue
  \else\let\llx@anonresult\llx@anonfalse\fi\llx@anonresult}
% listings reaches Init after global, inherited style and local options have been applied.
% Keep token styles unexpanded: executing \color or font switches while writing changes them.
\def\llx@listing{\begingroup\escapechar=92\relax
  \ifdefined\lst@language\let\llx@language\lst@language\else\let\llx@language\@empty\fi
  \ifdefined\lst@dialect\let\llx@dialect\lst@dialect\else\let\llx@dialect\@empty\fi
  \llx@write{llxlisting{\llx@language}{\llx@dialect}%
    {\unexpanded\expandafter{\lst@keywordstyle}}%
    {\unexpanded\expandafter{\lst@commentstyle}}%
    {\unexpanded\expandafter{\lst@stringstyle}}\llx@where}\endgroup}
\def\llx@log#1{\ifx\measuring@true\@undefined\expandafter\@firstofone\else\expandafter\llx@ifmeas\fi{\llx@@log{#1}}}
\def\llx@ifmeas#1{\ifmeasuring@\else#1\fi}
% enumi..enumiv log the item's label (enumitem's robust \color stays: elegantbook's
% {\protect \color  {structurecolor}1.}), other counters \the<counter>.
\def\llx@@log#1{\begingroup
  \ifcsname llx@label@#1\endcsname\ifcsname label#1\endcsname
    \llx@expand\llx@val{\csname label#1\endcsname}\else\llx@expand\llx@val{\csname the#1\endcsname}\fi
  \else\llx@expand\llx@val{\csname the#1\endcsname}\fi
  \llx@write{llxstep{#1}{\unexpanded\expandafter{\llx@val}}\llx@where}\endgroup}
\@namedef{llx@label@enumi}{}\@namedef{llx@label@enumii}{}\@namedef{llx@label@enumiii}{}\@namedef{llx@label@enumiv}{}
\def\llx@names{${csList(names)}}
\def\llx@colors{${csList(cfg.colors)}}
\def\llx@envs{${csList(cfg.envs)}}
\newsavebox\llx@box
% tocdepth as \tableofcontents reads the contents (a body's \setcounter{tocdepth} counts).
\AddToHook{cmd/tableofcontents/before}{\llx@write{llxinfo{tocdepth}{\the\c@tocdepth}}}
\AddToHook{begindocument/end}{%
  \llx@taginfo
  \@ifundefined{if@ACM@anonymous}{}{\llx@anonymousinfo}%
  \ifdefined\today\llx@valueinfo{today}{\today}\fi
  \AddToHook{cmd/maketitle/before}{\llx@titleinfo}%
  \ifdefined\lst@AddToHook\lst@AddToHook{Init}{\llx@listing}\fi
  \AddToHook{file/before}{\llx@enterfile\llx@write{llxin\llx@filefields{\the\inputlineno}}}%
  \AddToHook{file/after}{\llx@write{llxout\llx@filefields}\llx@leavefile}%
  \let\llx@orig@sc\stepcounter
  \def\stepcounter#1{\llx@orig@sc{#1}\ifcsname the#1\endcsname\llx@log{#1}\fi}%
  \def\@stpelt#1{\global\csname c@#1\endcsname\m@ne\llx@orig@sc{#1}}%
  \let\llx@orig@acl\addcontentsline
  \long\def\addcontentsline#1#2#3{\llx@orig@acl{#1}{#2}{#3}%
    \def\llx@t{#1}\def\llx@toc{toc}\ifx\llx@t\llx@toc
      \begingroup\llx@expand\llx@e{#3}\llx@write{llxtoc{#2}{\unexpanded\expandafter{\llx@e}}\llx@where}\endgroup\fi}%
  \@for\llx@n:=\llx@names\do{\ifcsname\llx@n name\endcsname
    \begingroup\llx@expand\llx@t{\csname\llx@n name\endcsname}%
    \llx@write{llxname{\llx@n}{\unexpanded\expandafter{\llx@t}}}\endgroup\fi}%
  % elegantnote/elegantpaper's title labels have no "name" suffix. Use the same normalized
  % names the HTML title block asks for, including a project's redefinitions.
  ${cfg.titleLabels === "elegantarticle" ? String.raw`\ifdefined\versiontext\begingroup\llx@expand\llx@t{\versiontext}%
    \llx@write{llxname{version}{\unexpanded\expandafter{\llx@t}}}\endgroup\fi
  \ifdefined\updatetext\begingroup\llx@expand\llx@t{\updatetext}%
    \llx@write{llxname{date}{\unexpanded\expandafter{\llx@t}}}\endgroup\fi` : ""}
  \ifdefined\extractcolorspecs\@for\llx@c:=\llx@colors\do{\@ifundefinedcolor{\llx@c}{}{%
    \extractcolorspecs{\llx@c}\llx@model\llx@spec\llx@write{llxcolor{\llx@c}{\llx@model}{\llx@spec}}}}\fi
  \@for\llx@e:=\llx@envs\do{\ifcsname\llx@e\endcsname
    \llx@write{llxenv{\llx@e}{\expandafter\meaning\csname\llx@e\endcsname}}\fi}%
  \llx@write{llxinfo{fontsize}{\f@size}}%
  \llx@write{llxinfo{tocdepth}{\the\c@tocdepth}}%
  \llx@write{llxinfo{secnumdepth}{\the\c@secnumdepth}}%
  \ifdefined\blx@cbxfile\llx@biblatex\fi
}
% biblatex's citation style and sortcites; natbib's mode and punctuation (at the end: natbib
% switches to numbers when the .bbl has no author-year labels).
\def\llx@biblatex{\llx@write{llxinfo{citestyle}{\blx@cbxfile}}\ifbool{sortcites}{\llx@write{llxinfo{sortcites}{1}}}{}}
\AddToHook{package/natbib/after}{\global\let\llx@nativecite\cite}
\def\llx@natbib{%
  \llx@write{llxinfo{natbib}{\ifNAT@numbers numbers\else authoryear\fi\ifNAT@super,super\fi%
    \ifnum\NAT@sort>\z@,sort\fi\ifnum\NAT@cmprs>\z@,compress\fi}}%
  \@for\llx@p:=open,close,sep,aysep,cmt\do{\begingroup
    \llx@expand\llx@t{\csname NAT@\llx@p\endcsname}\llx@write{llxinfo{natbib-\llx@p}{\unexpanded\expandafter{\llx@t}}}\endgroup}%
  % A class or the author may alias cite to citep/citet. Compare the real commands, never
  % execute a citation just to inspect its default (that would write aux/counter records).
  \ifx\cite\citep\llx@write{llxinfo{natbib-default-cite}{citep}}%
    \else\ifx\cite\citet\llx@write{llxinfo{natbib-default-cite}{citet}}%
    \else\ifx\cite\llx@nativecite\llx@write{llxinfo{natbib-default-cite}{auto}}%
    \else\llx@write{llxinfo{natbib-default-cite}{custom}}\fi\fi\fi}
\def\llx@citepackage{%
  \begingroup
  % cite.sty's public options choose sorting/compression; nosort/nocompress win even when
  % the empty default options were also supplied. Its punctuation is already class-adjusted.
  \@ifpackagewith{cite}{nosort}{\def\llx@sort{nosort}}{\def\llx@sort{sort}}%
  \@ifpackagewith{cite}{nocompress}{\def\llx@compress{nocompress}}{\def\llx@compress{compress}}%
  \llx@write{llxinfo{cite-package}{\llx@sort,\llx@compress}}%
  \@ifpackagewith{cite}{superscript}{\llx@write{llxinfo{cite-super}{1}}}{%
    \@ifpackagewith{cite}{super}{\llx@write{llxinfo{cite-super}{1}}}{}}%
  \@for\llx@p:=citeleft,citeright,citepunct,citedash,citemid\do{%
    \ifcsname\llx@p\endcsname\llx@valueinfo{\llx@p}{\csname\llx@p\endcsname}\fi}\endgroup}
\AddToHook{enddocument}{\ifdefined\NAT@numberstrue\llx@natbib\fi
  \@ifpackageloaded{cite}{\llx@citepackage}{}}
% biblatex: each cited key's label, and each entry a bibliography prints (in order, where it prints).
\def\llx@citekey{\llx@write{llxcite{\thefield{entrykey}}{\thefield{labelnumber}}{\thefield{labelprefix}}}}
\AddToHook{begindocument/before}{\ifdefined\AtEveryCitekey\AtEveryCitekey{\llx@citekey}%
  \AtEveryBibitem{\llx@citekey\llx@write{llxstep{llx@bib}{\thefield{entrykey}}\llx@where}}\fi}
% Fragments: one preview page each, marked for dvisvgm (fragments.ts): the id, and an inline
% one's baseline in SVG coordinates; llxopen/llxclose bracket the steps TeX takes inside one.
\AddToHook{class/after}{\ifdefined\endllxfrag\else
  \RequirePackage[active,tightpage]{preview}%
  \newenvironment{llxfrag}[1]{\def\llx@id{#1}\edef\llx@fragmentvisit{\llx@visit}\llx@write{llxopen{#1}}\begin{lrbox}{\llx@box}}{\end{lrbox}%
    \llx@write{llxclose{\llx@id}}\llx@write{llxfrag{\llx@id}{\the\ht\llx@box}{\the\dp\llx@box}{\the\wd\llx@box}{\llx@fragmentvisit}}%
    \leavevmode\special{dvisvgm:raw <g class="llx-ref" data-id="\llx@id" data-visit="\llx@fragmentvisit" data-y="{?y}"/>}\usebox\llx@box}%
  \newenvironment{llxblock}[1]{\def\llx@id{#1}\edef\llx@fragmentvisit{\llx@visit}\llx@write{llxopen{#1}}\llx@write{llxblock{#1}{\llx@fragmentvisit}}%
    \special{dvisvgm:raw <g class="llx-ref" data-id="#1" data-visit="\llx@fragmentvisit"/>}}{\llx@write{llxclose{\llx@id}}}%
  \PreviewEnvironment{llxfrag}\PreviewEnvironment{llxblock}\fi}
\endinput
`;
}

export interface FragmentPages {
  /** The SVG of each page dvisvgm wrote, in page order. */
  svgs: string[];
  /** What dvisvgm printed (its warnings and errors). */
  output: string;
  code: number | null;
  stalled: boolean;
  timedOut: boolean;
  durationMs: number;
}

/**
 * dvisvgm over every page of the probe's DVI into `<work>/frag/f<page>.svg` (runTex: its own
 * process group, the stall watchdog, `signal` kills it): exact ink boxes, black glyphs as
 * `currentColor`, fonts as WOFF2. Pages it could not convert are missing from `svgs`.
 */
export async function runDvisvgm(dvi: string, host: ProbeHost, signal?: AbortSignal): Promise<FragmentPages> {
  const started = Date.now();
  const dir = join(host.workDir, "frag");
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.mkdir(dir, { recursive: true });
  const run = await runTex(
    texTool(host.binDir, "dvisvgm"),
    ["--page=1-", "--exact-bbox", "--currentcolor", "--font-format=woff2", `--output=${join(dir, "f%p.svg")}`, dvi],
    { cwd: host.workDir, env: texEnv(host.binDir), log: null, stallMs: host.stallMs, timeoutMs: 120_000, signal },
  );
  const files = (await fsp.readdir(dir).catch(() => [] as string[]))
    .map((f) => /^f(\d+)\.svg$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]));
  const svgs: string[] = [];
  for (const m of files) svgs.push(await fsp.readFile(join(dir, m[0]), "utf8"));
  return { svgs, output: run.output, code: run.code, stalled: run.stalled, timedOut: run.timedOut, durationMs: Date.now() - started };
}

/** The .aux files under `dir` (\include's in subfolders), up to three levels, as relative paths. */
async function auxFiles(dir: string, depth = 0, out: string[] = [], base = dir): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory() && depth < 3) await auxFiles(p, depth + 1, out, base);
    else if (e.isFile() && e.name.endsWith(".aux")) out.push(relative(base, p));
  }
  return out;
}

/**
 * Set up the work folder for the plan: llxprobe.sty, the instrumented copies under `src/`, the
 * build folder's .aux (with \include's folders), .bbl and .toc; outputs of an earlier probe go.
 */
export async function prepareWorkDir(plan: ExportPlan, host: ProbeHost, signal?: AbortSignal): Promise<void> {
  const check = () => { if (signal?.aborted) throw abortError(); };
  check();
  const work = host.workDir;
  // This directory belongs only to the export. Clear it as a whole: removing just the root's
  // aux leaves an old included chapter's labels available after that chapter was removed.
  await fsp.rm(work, { recursive: true, force: true });
  await fsp.mkdir(work, { recursive: true });
  const inputs = new Map<string, ProbeInput>();
  for (const key of plan.copies.keys()) {
    const source = plan.files.get(key)!.abs;
    inputs.set(source, { source, copy: join(work, "src", ...key.split("/")), key });
  }
  // TeX retains literal ./ and ../ in resolved import names. The planner supplies only exact
  // spellings of sources it actually visited; never redirect an unparsed or outside-project file.
  for (const [source, key] of plan.sourceAliases) if (plan.copies.has(key)) {
    inputs.set(source, { source, copy: join(work, "src", ...key.split("/")), key });
  }
  await fsp.writeFile(join(work, "llxprobe.sty"), probeSty(plan.probe, [...inputs.values()]));
  for (const [key, text] of plan.copies) {
    check();
    const dest = join(work, "src", ...key.split("/"));
    await fsp.mkdir(dirname(dest), { recursive: true });
    await fsp.writeFile(dest, text);
  }
  // \include writes <name>.aux next to where TeX runs: its folders must exist.
  for (const v of plan.visits) {
    const sub = dirname(v.key);
    if (sub !== ".") await fsp.mkdir(join(work, sub), { recursive: true });
  }
  const copies = [...(await auxFiles(host.buildDir)), `${plan.job}.bbl`, `${plan.job}.toc`];
  for (const rel of copies) {
    check();
    const from = join(host.buildDir, rel);
    if (!existsSync(from)) continue;
    await fsp.mkdir(dirname(join(work, rel)), { recursive: true });
    await fsp.copyFile(from, join(work, rel));
  }
  check();
}

/**
 * Run the probe pass in the prepared work folder (runTex: its own process group, the stall
 * watchdog; `signal` kills it). Rejects when the engine is unsupported, TeX cannot start, or
 * the run is aborted.
 */
export async function runProbe(plan: ExportPlan, host: ProbeHost, signal?: AbortSignal): Promise<ProbeResult> {
  const started = Date.now();
  const work = host.workDir;
  if (signal?.aborted) throw abortError();
  if (host.engine === "lualatex") throw new Error("HTML export currently supports pdfLaTeX and XeLaTeX. LuaLaTeX requires a PDF-mode probe, which is not supported yet.");
  // A direct retry must not mistake the previous run's records or pages for this run's output,
  // even when the engine exits before opening its log (runProbe is also used independently).
  for (const ext of ["llx", "log", "dvi", "xdv"]) await fsp.rm(join(work, `${plan.job}.${ext}`), { force: true });
  const env = texEnv(host.binDir);
  const own = process.env.TEXINPUTS ?? "";
  env.TEXINPUTS = [".", join(work, "src"), plan.rootDir, own].join(delimiter) + (own.endsWith(delimiter) ? "" : delimiter);
  const log = join(work, `${plan.job}.log`);
  const run = await runTex(
    texTool(host.binDir, host.engine),
    [
      DVI_FLAGS[host.engine],
      "-interaction=nonstopmode",
      "-file-line-error",
      ...(host.shellEscape ? ["-shell-escape"] : []),
      `-jobname=${plan.job}`,
      `\\RequirePackage{llxprobe}\\input{${plan.rootKey}}`,
    ],
    { cwd: work, env, log, stallMs: host.stallMs, signal },
  );
  const read = (path: string) => fsp.readFile(path, "utf8").catch(() => null);
  const dvi = [join(work, `${plan.job}.xdv`), join(work, `${plan.job}.dvi`)].find((p) => existsSync(p)) ?? null;
  return {
    llx: await read(join(work, `${plan.job}.llx`)),
    log: (await read(log)) ?? "",
    output: run.output,
    stalled: run.stalled,
    timedOut: run.timedOut,
    dvi,
    durationMs: Date.now() - started,
  };
}
