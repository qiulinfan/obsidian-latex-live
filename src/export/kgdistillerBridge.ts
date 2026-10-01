import { access, cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectMath } from "../editor/mathjaxProject";
import { emptyDefinitions, projectDefinitions } from "../tex/macros";
import { detectEngine, findRoot, hasDocumentclass, literalTexPath, resolveFileReference, stripComments, type Engine } from "../tex/project";
import { findGraphics, graphicsPaths } from "../tex/graphics";
import { abortError } from "../tex/run";
import { theoremMap } from "../tex/theorems";
import { exportHtml } from "./exporter";
import { planExport } from "./plan";
import { createNodeExportHost, createNodeMathEnv, type NodeMathEnv } from "./nodeHost";
import { projectSignatures } from "./signatures";
import { argText, parseTex, walkTex, type Signatures } from "./texTree";
import type { ExportReport } from "./report";

export interface KnowledgeMarker { name: string; id: string; url: string }
export type KgdistillerRequest =
  | { schema: "latex-live-html-request-v1"; operation: "labels"; source?: string; labels: { id: string; latex: string }[] }
  | { schema: "latex-live-html-request-v1"; operation: "document"; source: string; project_root?: string; markers: KnowledgeMarker[]; engine?: Engine };
export type KgdistillerResult =
  | { schema: "latex-live-html-result-v1"; operation: "labels"; labels: { id: string; html: string }[] }
  | { schema: "latex-live-html-result-v1"; operation: "document"; html: string; report: ExportReport };

const checkAbort = (signal: AbortSignal) => { if (signal.aborted) throw abortError("The export was cancelled."); };
const safeId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id);
const safeUrl = (url: unknown): url is string => typeof url === "string" && !!url &&
  !/[\s\\{}]/.test(url) && !/^\/\//.test(url) &&
  (/^https?:\/\//i.test(url) || !/^[a-z][a-z0-9+.-]*:/i.test(url));
const inDirectory = (directory: string, path: string) => {
  const rel = relative(directory, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

/** Protocol validation happens before allocating a DOM or running a TeX process. */
export function parseKgdistillerRequest(value: unknown): KgdistillerRequest {
  if (!value || typeof value !== "object") throw new Error("Expected one JSON request object.");
  const request = value as Record<string, unknown>;
  if (request.schema !== "latex-live-html-request-v1") throw new Error("Unsupported request schema.");
  if (request.source !== undefined && (typeof request.source !== "string" || !isAbsolute(request.source) || extname(request.source).toLowerCase() !== ".tex")) {
    throw new Error("source must be an absolute .tex path.");
  }
  if (request.operation === "labels") {
    if (!Array.isArray(request.labels)) throw new Error("labels must be an array.");
    const ids = new Set<string>();
    for (const label of request.labels) {
      if (!label || typeof label !== "object" || !safeId(label.id) || typeof label.latex !== "string" || !label.latex.trim()) {
        throw new Error("Every label requires a safe id and nonempty latex.");
      }
      if (ids.has(label.id)) throw new Error(`Duplicate label id: ${label.id}`);
      ids.add(label.id);
    }
  } else if (request.operation === "document") {
    if (typeof request.source !== "string" || !Array.isArray(request.markers)) throw new Error("document requires source and markers.");
    if (request.engine !== undefined && !["pdflatex", "xelatex", "lualatex"].includes(String(request.engine))) throw new Error("Unsupported engine.");
    if (request.project_root !== undefined && (typeof request.project_root !== "string" || !isAbsolute(request.project_root))) throw new Error("project_root must be an absolute directory.");
    const names = new Set<string>();
    const ids = new Map<string, string>();
    for (const marker of request.markers) {
      if (!marker || typeof marker !== "object" || !safeId(marker.id) || typeof marker.name !== "string" || !marker.name.trim() ||
          !safeUrl(marker.url)) {
        throw new Error("Every marker requires a raw name, safe id, and safe http(s) or relative url.");
      }
      if (names.has(marker.name) || (ids.has(marker.id) && ids.get(marker.id) !== marker.url)) throw new Error(`Conflicting marker mapping: ${marker.name}`);
      names.add(marker.name);
      ids.set(marker.id, marker.url);
    }
  } else throw new Error("operation must be labels or document.");
  return request as unknown as KgdistillerRequest;
}

// MathML is a portable label format: no CHTML glyph stylesheet or MathJax font is needed.
const MML_TAGS = new Set("math mrow mi mn mo ms mtext mspace mfrac msqrt mroot mstyle merror mpadded mphantom mfenced menclose msub msup msubsup munder mover munderover mmultiscripts mprescripts none mtable mtr mtd maligngroup malignmark".split(" "));
const MML_ATTRIBUTES = new Set("xmlns display mathvariant mathsize mathcolor mathbackground dir scriptlevel displaystyle scriptsizemultiplier scriptminsize infixlinebreakstyle form fence separator lspace rspace stretchy symmetric maxsize minsize largeop movablelimits accent accentunder bevelled linethickness numalign denomalign subscriptshift superscriptshift width height depth voffset notation rowalign columnalign groupalign align axis rowspacing columnspacing rowlines columnlines frame framespacing equalrows equalcolumns side minlabelspacing columnspan rowspan open close separators".split(" "));

function cleanMathML(node: Element): string {
  const elements = [node, ...node.querySelectorAll("*")];
  for (const element of elements) {
    if (!MML_TAGS.has(element.localName)) throw new Error(`Unsupported MathML label element: ${element.localName}`);
    for (const attribute of [...element.attributes]) {
      if (!MML_ATTRIBUTES.has(attribute.name) || /(?:url\s*\(|javascript:|data:)/i.test(attribute.value)) element.removeAttribute(attribute.name);
    }
  }
  return node.outerHTML;
}

/** ProjectMath's ensuremath shim is for math mode; labels also use it in running text. */
function labelSource(latex: string): string {
  const edits: Replacement[] = [];
  walkTex(parseTex(latex, { macros: new Map([["ensuremath", "m"]]), envs: new Map() }), (node) => {
    if (node.t !== "macro" || node.name !== "ensuremath") return;
    edits.push({ from: node.from, to: node.to, text: `$${argText(latex, node.args[0])}$` });
    return false;
  });
  for (const edit of edits.sort((a, b) => b.from - a.from)) latex = latex.slice(0, edit.from) + edit.text + latex.slice(edit.to);
  return latex;
}

/** ProjectMath still owns parsing, macro isolation, errors, and render-table cleanup. */
function labelMath(env: NodeMathEnv, source?: string): ProjectMath {
  const defs = source ? projectDefinitions(findRoot(source, homedir())) : emptyDefinitions();
  const internals = env.mj._ as {
    output: { chtml_ts: { CHTML: new (options: object) => { typeset: (item: { root: unknown }) => Element } } };
    core: { MmlTree: { SerializedMmlVisitor: { SerializedMmlVisitor: new () => { visitTree(root: unknown): string } } } };
  };
  const output = new internals.output.chtml_ts.CHTML({ adaptiveCSS: true });
  const visitor = new internals.core.MmlTree.SerializedMmlVisitor.SerializedMmlVisitor();
  output.typeset = (item) => {
    const template = env.document.createElement("template");
    template.innerHTML = visitor.visitTree(item.root);
    if (!template.content.firstElementChild) throw new Error("MathJax produced no MathML.");
    return template.content.firstElementChild;
  };
  const math = ProjectMath.create(env.mj, env.document, {
    statements: defs.statements, physics: defs.packages.has("physics"), unsupported: defs.unsupported,
  }, { output });
  if (!math.isolated) throw new Error("MathJax 3.2 internals are required for project labels.");
  return math;
}

interface Replacement { from: number; to: number; text: string }

/** Replace only parsed, explicit marker calls; macro definitions, comments and listings stay. */
function rewriteMarkers(source: string, sig: Signatures, markers: ReadonlyMap<string, KnowledgeMarker>, token: string, definitions: Set<string>, references: Map<string, string>, activePositions: ReadonlySet<number>, expectedReferences: Set<string>): string {
  const edits: Replacement[] = [];
  const reserved = new Set([...markers.values()].flatMap((marker) => [`kgd-kn-${marker.id}`, `kn-${marker.id}`]));
  walkTex(parseTex(source, sig), (node) => {
    if (node.t === "macro" && node.code) return false;
    if (node.t === "math") {
      let marker = false;
      walkTex(parseTex(source.slice(node.srcFrom, node.srcTo), sig), (part) => { if (part.t === "macro" && /^(kn|knref)$/.test(part.name)) marker = true; });
      if (marker) throw new Error("Knowledge markers must surround math in their name; markers inside a formula cannot carry an HTML anchor.");
      return false;
    }
    if (node.t === "macro" && node.name === "label" && reserved.has(argText(source, node.args[0]).trim())) throw new Error("A source label conflicts with a reserved knowledge anchor.");
    if (node.t !== "macro" || !/^(kn|knref)$/.test(node.name)) return;
    const name = argText(source, node.args[0]);
    const mapping = markers.get(name);
    if (!mapping) throw new Error(`Unmapped explicit knowledge marker: ${name}`);
    if (node.name === "kn") {
      if (activePositions.has(node.from)) {
        if (definitions.has(mapping.id)) throw new Error(`Duplicate explicit knowledge definition: ${name}`);
        definitions.add(mapping.id);
      }
      edits.push({ from: node.from, to: node.to, text: `\\label{kgd-kn-${mapping.id}}${name}` });
    } else {
      const href = `https://kgdistiller.invalid/${token}/${references.size}`;
      references.set(href, mapping.id);
      if (activePositions.has(node.from)) expectedReferences.add(href);
      edits.push({ from: node.from, to: node.to, text: `\\href{${href}}{${name}}` });
    }
    return false;
  });
  for (const edit of edits.sort((a, b) => b.from - a.from)) source = source.slice(0, edit.from) + edit.text + source.slice(edit.to);
  return source;
}

/** Read-only project export, with only the static dependency closure copied into temp. */
async function exportDocument(request: Extract<KgdistillerRequest, { operation: "document" }>, env: NodeMathEnv, signal: AbortSignal): Promise<KgdistillerResult> {
  const source = await realpath(request.source);
  const rootText = await readFile(source, "utf8");
  if (!hasDocumentclass(rootText) || !/\\begin\s*\{document\}/.test(stripComments(rootText))) throw new Error("document source must be a complete root LaTeX document.");
  const engine = request.engine ?? detectEngine(rootText, dirname(source), "auto");
  if (engine === "lualatex") throw new Error("HTML export currently supports pdfLaTeX and XeLaTeX; LuaLaTeX is not supported.");
  const originalDir = dirname(source);
  const boundary = await realpath(request.project_root ?? originalDir);
  if (!inDirectory(boundary, source)) throw new Error("source is outside project_root.");
  const defs = projectDefinitions(source);
  const sources = await Promise.all(defs.files.map((file) => readFile(file, "utf8")));
  const base = projectSignatures(defs, sources, theoremMap(sources));
  const sig = {
    ...base, macros: new Map([...base.macros, ["kn", "m"], ["knref", "m"]]),
    // The export parser recognizes newcommand/renewcommand natively; providecommand has
    // the same argument structure and must also be opaque code in marker/dependency walks.
    definers: new Map([...base.definers ?? [], ["providecommand", "newcommand"]]),
  };
  const mappings = new Map(request.markers.map((marker) => [marker.name, marker]));
  const byId = new Map(request.markers.map((marker) => [marker.id, marker]));
  const definitions = new Set<string>();
  const references = new Map<string, string>();
  const expectedReferences = new Set<string>();
  const token = randomUUID();
  const folder = await mkdtemp(join(tmpdir(), "latex-live-kgdistiller-"));
  try {
    checkAbort(signal);
    const project = join(folder, "project");
    await mkdir(project);
    const root = join(project, `kgdistiller-${token}.tex`);
    const stageFiles = new Map<string, string>([[source, root]]);
    const textFiles = new Map<string, string>();
    const pathEdits = new Map<string, Map<number, Replacement>>();
    const includeSelections: { file: string; from: number; to: number; names: string[] }[] = [];
    const checked = new Set<string>();
    const paths = graphicsPaths(sources.map(stripComments));
    const slash = (path: string) => path.split(sep).join("/");
    const existing = async (path: string) => { try { await access(path); return true; } catch { return false; } };
    const staged = async (path: string): Promise<{ original: string; copy: string }> => {
      checkAbort(signal);
      const original = await realpath(path);
      if (!inDirectory(boundary, original)) throw new Error(`Project dependency is outside project_root: ${path}`);
      let copy = stageFiles.get(original);
      if (!copy) {
        // Local .sty/.cls files retain their TeX package names at the new root.
        const packageFile = /\.(sty|cls|bst)$/.test(original) && dirname(original) === originalDir;
        copy = join(project, packageFile ? basename(original) : relative(boundary, original));
        if ([...stageFiles.values()].includes(copy)) throw new Error(`Conflicting staged dependency: ${path}`);
        stageFiles.set(original, copy);
      }
      return { original, copy };
    };
    const editPath = (file: string, from: number, to: number, text: string) => {
      let edits = pathEdits.get(file);
      if (!edits) pathEdits.set(file, (edits = new Map()));
      const before = edits.get(from);
      if (before && before.text !== text) throw new Error(`A repeated input resolves differently by visit: ${file}`);
      edits.set(from, { from, to, text });
    };
    const inputs = new Set(["input", "include", "subfile", "subfileinclude", "import", "inputfrom", "includefrom", "subimport", "subinputfrom", "subincludefrom"]);
    const imports = /^(?:sub)?(?:import|inputfrom|includefrom)$/;
    const visit = async (path: string, dirs: readonly string[], depth = 0): Promise<void> => {
      if (depth > 64 || checked.size > 512) throw new Error("Project input closure exceeds the bridge limit.");
      const target = await staged(path);
      const context = `${target.original}|${dirs.join("|")}`;
      if (checked.has(context)) return;
      checked.add(context);
      const text = textFiles.get(target.original) ?? await readFile(target.original, "utf8");
      textFiles.set(target.original, text);
      const nodes: Parameters<typeof walkTex>[0][number][] = [];
      walkTex(parseTex(text, sig), (node) => { if (node.t === "macro" && !node.code) nodes.push(node); });
      for (const node of nodes) {
        if (node.t !== "macro") continue;
        if (inputs.has(node.name)) {
          const imported = imports.test(node.name);
          const nameArg = node.args[node.args.length - 1];
          const name = literalTexPath(argText(text, nameArg));
          const directory = imported ? argText(text, node.args[node.args.length - 2]) : null;
          const ref = resolveFileReference(originalDir, node.name, name, directory, dirs);
          if (!ref) throw new Error(`A dynamic input cannot be staged: ${text.slice(node.from, node.to)}`);
          const child = await staged(ref.path);
          const copy = slash(relative(project, child.copy));
          if (imported) {
            const arg = node.args[node.args.length - 2];
            editPath(target.original, arg.from, arg.to, `{${slash(dirname(copy))}/}`);
            editPath(target.original, nameArg.from, nameArg.to, `{${basename(copy)}}`);
            // Every directory argument now names its target from the staged root. Reset
            // import's base instead of prefixing the inherited directory a second time.
            if (node.name.startsWith("sub")) editPath(target.original, node.from, node.from + node.name.length + 1, `\\${node.name.slice(3)}`);
          } else editPath(target.original, nameArg.from, nameArg.to, `{${copy}}`);
          await visit(child.original, ref.inputDirs, depth + 1);
        } else if (node.name === "includeonly") {
          const arg = node.args[0];
          includeSelections.push({ file: target.original, from: arg.from, to: arg.to, names: argText(text, arg).split(",").map((name) => name.trim()) });
        } else if (node.name === "includegraphics" || node.name === "includepdf" || node.name === "lstinputlisting") {
          const arg = node.args[node.args.length - 1];
          const name = literalTexPath(argText(text, arg));
          const siteRoot = dirs[0] ?? originalDir;
          const file = node.name === "includegraphics" ? findGraphics(name, siteRoot, paths)?.path : resolve(siteRoot, name);
          if (!file || !await existing(file)) continue; // The existing exporter reports a missing resource.
          const resource = await staged(file);
          editPath(target.original, arg.from, arg.to, `{${slash(relative(project, resource.copy))}}`);
        } else if (node.name === "bibliography" || node.name === "addbibresource" || node.name === "bibliographystyle") {
          const arg = node.args[node.args.length - 1];
          const names = argText(text, arg).split(",").map((name) => name.trim());
          const copied: string[] = [];
          for (const name of names) {
            const suffix = node.name === "bibliographystyle" ? ".bst" : ".bib";
            const file = resolve(originalDir, extname(name) ? name : name + suffix);
            if (!await existing(file)) { copied.push(name); continue; }
            const resource = await staged(file);
            const relativeName = slash(relative(project, resource.copy));
            copied.push(node.name === "bibliographystyle" ? relativeName.replace(/\.bst$/, "") : relativeName);
          }
          editPath(target.original, arg.from, arg.to, `{${copied.join(",")}}`);
        }
      }
    };
    await visit(source, [originalDir]);
    // Include local package/class definitions in the closure too; projectDefinitions already
    // resolves these using the plugin's existing project rules.
    for (const path of defs.files) if (/\.(sty|cls)$/.test(path)) await visit(path, [originalDir]);
    for (const selection of includeSelections) {
      const names: string[] = [];
      for (const name of selection.names) {
        const ref = resolveFileReference(originalDir, "include", name);
        const original = ref && await realpath(ref.path).catch(() => null);
        const copy = original && stageFiles.get(original);
        names.push(copy ? slash(relative(project, copy)).replace(/\.tex$/, "") : name);
      }
      editPath(selection.file, selection.from, selection.to, `{${names.join(",")}}`);
    }
    const stageTexts = new Map<string, string>();
    for (const [original, copy] of stageFiles) {
      checkAbort(signal);
      await mkdir(dirname(copy), { recursive: true });
      const sourceText = textFiles.get(original);
      if (sourceText === undefined) { await cp(original, copy); continue; }
      let rewritten = sourceText;
      for (const edit of [...(pathEdits.get(original)?.values() ?? [])].sort((a, b) => b.from - a.from)) {
        rewritten = rewritten.slice(0, edit.from) + edit.text + rewritten.slice(edit.to);
      }
      if (original === source) {
        const document = parseTex(rewritten, sig).find((node) => node.t === "env" && node.name === "document");
        if (!document) throw new Error("document source must contain an active root document environment.");
        const preamble = "\\makeatletter\\@ifpackageloaded{hyperref}{}{\\RequirePackage{hyperref}}\\makeatother\\providecommand{\\kn}[1]{#1}\\providecommand{\\knref}[1]{#1}";
        rewritten = rewritten.slice(0, document.from) + preamble + rewritten.slice(document.from);
      }
      stageTexts.set(copy, rewritten);
      await writeFile(copy, rewritten);
    }
    // The existing planner owns which bodies TeX actually visits (includeonly and
    // subfiles' preamble boundaries). The copied closure also holds disabled sources,
    // but their markers are not expectations for this document's HTML.
    const stageDefs = projectDefinitions(root);
    const activePlan = planExport(root, { defs: stageDefs, theorems: theoremMap([...stageTexts.values()]) });
    const activePositions = new Map<string, Set<number>>();
    for (const visit of activePlan.visits) {
      const file = activePlan.files.get(visit.key);
      if (!file) continue;
      let positions = activePositions.get(file.abs);
      if (!positions) activePositions.set(file.abs, (positions = new Set()));
      const nodes = parseTex(file.src, sig);
      const document = visit.bodyOnly ? nodes.find((node) => node.t === "env" && node.name === "document") : null;
      walkTex(document?.t === "env" ? document.body : nodes, (node) => {
        if (node.t === "macro" && node.code) return false;
        if (node.t === "macro" && /^(kn|knref)$/.test(node.name)) { positions!.add(node.from); return false; }
      });
    }
    for (const [copy, text] of stageTexts) {
      const rewritten = rewriteMarkers(text, sig, mappings, token, definitions, references, activePositions.get(copy) ?? new Set(), expectedReferences);
      await writeFile(copy, rewritten);
    }
    const build = join(folder, "build");
    await mkdir(build);
    const result = await exportHtml(root, createNodeExportHost(root, build, engine, env), () => undefined, signal);
    checkAbort(signal);
    const Parser = env.document.defaultView!.DOMParser;
    const document = new Parser().parseFromString(result.html, "text/html");
    for (const id of definitions) {
      const anchor = document.getElementById(`kgd-kn-${id}`);
      if (!anchor) throw new Error(`Export omitted the explicit knowledge anchor: ${id}`);
      anchor.id = `kn-${id}`;
      anchor.setAttribute("data-ql-kn", id);
      if ([...document.querySelectorAll("[id]")].filter((element) => element.id === anchor.id).length !== 1) throw new Error(`A document id conflicts with a knowledge anchor: ${id}`);
    }
    const seenRefs = new Set<string>();
    for (const link of document.querySelectorAll("a[href]")) {
      const href = link.getAttribute("href")!;
      const id = references.get(href);
      if (!id) continue;
      link.setAttribute("href", byId.get(id)!.url);
      link.setAttribute("data-ql-ref", id);
      seenRefs.add(href);
    }
    for (const href of expectedReferences) if (!seenRefs.has(href)) throw new Error(`Export omitted an explicit knowledge reference: ${references.get(href)}`);
    const html = `<!doctype html>\n${document.documentElement.outerHTML}`;
    result.report.bytes = Buffer.byteLength(html);
    const originalFiles = new Map([...stageFiles].map(([original, copy]) => [copy, original]));
    for (const item of result.report.items) if (item.file && originalFiles.has(item.file)) item.file = originalFiles.get(item.file);
    return { schema: "latex-live-html-result-v1", operation: "document", html, report: result.report };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

export async function kgdistillerHtml(value: unknown, signal = new AbortController().signal): Promise<KgdistillerResult> {
  const request = parseKgdistillerRequest(value);
  if (request.source) await realpath(request.source);
  checkAbort(signal);
  const env = await createNodeMathEnv();
  try {
    checkAbort(signal);
    if (request.operation === "document") return await exportDocument(request, env, signal);
    const math = labelMath(env, request.source);
    const labels = request.labels.map((label) => {
      checkAbort(signal);
      return { id: label.id, html: cleanMathML(math.render(`\\text{${labelSource(label.latex)}}`, false)) };
    });
    return { schema: "latex-live-html-result-v1", operation: "labels", labels };
  } finally { env.close(); }
}
