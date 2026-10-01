import { resolveFileReference } from "../tex/project";
import type { ExportPlan, PlanFile } from "./plan";
import { argText, given, type TexArg, type TexNode } from "./texTree";

/** Source-backed inline/block content. Nodes retain the offsets and file of their declaration. */
export interface FrontmatterPart {
  file: PlanFile;
  nodes: TexNode[];
  from: number;
  to: number;
  /** Known body invocation; preamble inputs have no drawing occurrence. */
  visit?: number;
  /** Explicit subject API; the optional AMS classification scheme is retained as its qualifier. */
  kind?: "subject" | "subjclass" | "ccsdesc";
  qualifier?: string;
}

export interface PaperAuthor {
  name: FrontmatterPart;
  affiliationIds: string[];
  emails: FrontmatterPart[];
  notes: FrontmatterPart[];
  corresponding?: boolean;
  orcid?: FrontmatterPart;
}

export interface PaperAffiliation {
  id: string;
  content: FrontmatterPart;
  current?: boolean;
}

export interface PaperFrontmatter {
  className: string;
  /** A class whose author/affiliation API has explicit source relationships. */
  paper: boolean;
  /** The first title trigger: explicit maketitle, or AASTeX 7.0.1's verified first section. */
  maketitle: { file: PlanFile; node: TexNode; visit?: number } | null;
  title?: FrontmatterPart;
  subtitle?: FrontmatterPart;
  author?: FrontmatterPart;
  institute?: FrontmatterPart;
  date?: FrontmatterPart;
  version?: FrontmatterPart;
  extrainfo?: FrontmatterPart;
  shorttitle?: FrontmatterPart;
  shortauthors?: FrontmatterPart;
  titlerunning?: FrontmatterPart;
  authorrunning?: FrontmatterPart;
  subject?: FrontmatterPart;
  dedication?: FrontmatterPart;
  authors: PaperAuthor[];
  affiliations: PaperAffiliation[];
  abstracts: FrontmatterPart[];
  keywords: FrontmatterPart[];
  subjects: FrontmatterPart[];
  notes: FrontmatterPart[];
  /** Metadata declarations only, never the title trigger or declarations after it. Empty without a trigger. */
  consumed: Set<TexNode>;
}

type Macro = TexNode & { t: "macro" };
const INPUTS = new Set(["input", "include", "subfile", "subfileinclude", "import", "subimport", "inputfrom", "subinputfrom", "includefrom", "subincludefrom"]);
const IMPORTS = new Set(["import", "subimport", "inputfrom", "subinputfrom", "includefrom", "subincludefrom"]);
const PAPER_CLASSES = new Set(["sn-jnl", "wlpeerj", "acmart", "revtex4", "revtex4-1", "revtex4-2", "amsart", "amsbook", "amsproc", "llncs", "ieeetran", "aastex601", "aastex631", "aastex701"]);
const AAS_CLASSES = new Set(["aastex601", "aastex631", "aastex701"]);
const LAST_PARTS = new Set(["title", "subtitle", "date", "version", "extrainfo", "subject"]);

function mandatory(node: Macro): TexArg | undefined {
  return [...node.args].reverse().find(arg => (arg.kind === "m" || arg.kind === "g" || arg.kind === "v") && given(arg));
}

function part(file: PlanFile, nodes: TexNode[], from: number, to: number, visit?: number): FrontmatterPart {
  return { file, nodes, from: nodes[0]?.from ?? from, to: nodes.at(-1)?.to ?? to, ...(visit !== undefined ? { visit } : {}) };
}

function argument(file: PlanFile, arg: TexArg | undefined, visit?: number): FrontmatterPart | null {
  return arg && given(arg) ? part(file, arg.body ?? [], arg.from, arg.to, visit) : null;
}

function ids(file: PlanFile, node: Macro): string[] {
  const optional = node.args.find(arg => arg.kind === "o" && given(arg));
  return optional ? argText(file.src, optional).split(",").map(value => value.trim()).filter(Boolean) : [];
}

function splitAnd(nodes: TexNode[]): TexNode[][] {
  const chunks: TexNode[][] = [[]];
  for (const node of nodes) {
    if (node.t === "macro" && node.name === "and") chunks.push([]);
    else chunks.at(-1)!.push(node);
  }
  return chunks.filter(chunk => chunk.some(node => node.t !== "space" && node.t !== "comment"));
}

/** Remove relationship/notes commands from a name without flattening its rich inline markup. */
function extract(nodes: TexNode[], names: ReadonlySet<string>, take: (node: Macro) => void): TexNode[] {
  const out: TexNode[] = [];
  for (const node of nodes) {
    if (node.t === "macro" && names.has(node.name)) { take(node); continue; }
    if (node.t === "group") out.push({ ...node, body: extract(node.body, names, take) });
    else if (node.t === "macro" && !node.code) out.push({ ...node, args: node.args.map(arg => arg.body ? { ...arg, body: extract(arg.body, names, take) } : arg) });
    else out.push(node);
  }
  return out;
}

/**
 * Source frontmatter in execution order, stopping at the first title trigger. Uses only the plan's
 * already loaded file graph; definitions, class implementation bodies and arbitrary environments
 * are not executed. AASTeX 7.0.1 stores its abstract/keywords, then its first section calls
 * maketitle (unmodified installed class, lines 7583-7620); the section remains ordinary body
 * content. No implicit trigger is inferred for other classes or a handwritten PLOS header.
 */
export function collectFrontmatter(plan: ExportPlan): PaperFrontmatter {
  const root = plan.files.get(plan.rootKey);
  const classNode = root?.nodes.find(node => node.t === "macro" && !node.code && node.name === "documentclass");
  const className = root && classNode?.t === "macro" ? argText(root.src, mandatory(classNode)).trim().replace(/^.*[/\\]/, "").replace(/\.cls$/, "") : "";
  const cls = className.toLowerCase();
  const out: PaperFrontmatter = { className, paper: PAPER_CLASSES.has(cls), maketitle: null, authors: [], affiliations: [], abstracts: [], keywords: [], subjects: [], notes: [], consumed: new Set() };
  if (!root) return out;
  const declarations = new Set<TexNode>();
  const loaded = new Map([...plan.files.values()].map(file => [file.abs, file]));
  const stack = new Set<string>();
  let pendingAuthors: PaperAuthor[] = [];
  let previousGroup: PaperAuthor[] = [];
  let nextAffiliation = 1;
  let nextCurrent = 1;
  let titleNotes: FrontmatterPart[] = [];
  const lastAuthor = () => out.authors.at(-1);
  const addIds = (author: PaperAuthor, values: readonly string[]) => { for (const id of values) if (!author.affiliationIds.includes(id)) author.affiliationIds.push(id); };
  const addAffiliation = (content: FrontmatterPart, authors: readonly PaperAuthor[], id = String(nextAffiliation++), current = false) => {
    out.affiliations.push({ id, content, ...(current ? { current: true } : {}) });
    for (const author of authors) addIds(author, [id]);
  };
  const namedAuthor = (name: FrontmatterPart, explicitIds: string[] = [], corresponding = false): PaperAuthor => {
    const author: PaperAuthor = { name, affiliationIds: [...explicitIds], emails: [], notes: [], ...(corresponding ? { corresponding: true } : {}) };
    author.name = { ...name, nodes: extract(name.nodes, new Set(["inst", "thanks", "authornote", "equalcont", "email", "orcid", "orcidID"]), node => {
      const value = argument(name.file, mandatory(node), name.visit);
      if (node.name === "inst") addIds(author, argText(name.file.src, mandatory(node)).split(",").map(text => text.trim()).filter(Boolean));
      else if ((node.name === "orcid" || node.name === "orcidID") && value) author.orcid = value;
      else if (value) (node.name === "email" ? author.emails : author.notes).push(value);
    }) };
    out.authors.push(author);
    pendingAuthors.push(author);
    return author;
  };

  const authorDeclaration = (file: PlanFile, node: Macro, value: FrontmatterPart) => {
    out.author = value;
    if (!out.paper) { out.authors = []; pendingAuthors = []; }
    const corresponding = node.args.some(arg => arg.kind === "s" && given(arg));
    // These optional arguments have distinct public meanings: Springer/authblk institution
    // indices, AASTeX's ORCID, and short running names in AMS/ACM. Only indices form a relation.
    const affiliationIds = cls === "sn-jnl" || cls === "wlpeerj" ? ids(file, node) : [];
    const orcid = AAS_CLASSES.has(cls) ? argument(file, node.args.find(arg => arg.kind === "o" && given(arg)), value.visit) : null;
    for (const chunk of splitAnd(value.nodes)) {
      if (cls === "ieeetran" && chunk.some(n => n.t === "macro" && /^IEEEauthorblock[NA]$/.test(n.name))) {
        const group: PaperAuthor[] = [];
        for (const block of chunk) {
          if (block.t !== "macro") continue;
          const content = argument(file, mandatory(block), value.visit);
          if (!content) continue;
          if (block.name === "IEEEauthorblockN") group.push(namedAuthor(content));
          else if (block.name === "IEEEauthorblockA") addAffiliation(content, group);
          else if (block.name === "thanks") (group.at(-1)?.notes ?? out.notes).push(content);
        }
      } else {
        const author = namedAuthor(part(file, chunk, value.from, value.to, value.visit), affiliationIds, corresponding);
        if (orcid) author.orcid = orcid;
      }
    }
  };

  const metadata = (file: PlanFile, node: Macro, visit?: number): boolean => {
    const value = argument(file, mandatory(node), visit);
    if (LAST_PARTS.has(node.name) && value) {
      let content = value;
      if (out.paper && node.name === "title") {
        out.notes = out.notes.filter(note => !titleNotes.includes(note));
        titleNotes = [];
        content = { ...value, nodes: extract(value.nodes, new Set(["thanks"]), note => {
          const body = argument(file, mandatory(note), visit); if (body) { out.notes.push(body); titleNotes.push(body); }
        }) };
      }
      if (node.name === "subject") content = { ...content, kind: "subject" };
      out[node.name as "title" | "subtitle" | "date" | "version" | "extrainfo" | "subject"] = content;
      if (node.name === "subject") out.subjects = [content];
      return true;
    }
    if (node.name === "author" && value) { authorDeclaration(file, node, value); return true; }
    if (AAS_CLASSES.has(cls) && value && (node.name === "shorttitle" || node.name === "shortauthors")) {
      out[node.name] = value;
      return true;
    }
    if (cls === "llncs" && value && (node.name === "titlerunning" || node.name === "authorrunning")) {
      out[node.name] = value;
      return true;
    }
    if (node.name === "institute" && value) {
      out.institute = value;
      if (cls === "llncs") {
        out.affiliations = [];
        nextAffiliation = 1;
        for (const chunk of splitAnd(value.nodes)) addAffiliation(part(file, chunk, value.from, value.to, value.visit), []);
      }
      return true;
    }
    if ((node.name === "affil" || node.name === "affiliation") && value && out.paper) {
      const explicit = ids(file, node);
      if (cls === "sn-jnl" || cls === "wlpeerj") {
        for (const id of explicit.length ? explicit : [String(nextAffiliation++)]) out.affiliations.push({ id, content: value });
      } else if (/^revtex/.test(cls)) {
        const group = pendingAuthors.length ? pendingAuthors : previousGroup;
        addAffiliation(value, group);
        previousGroup = [...group];
        pendingAuthors = [];
      } else addAffiliation(value, lastAuthor() ? [lastAuthor()!] : []);
      return true;
    }
    if ((node.name === "address" || node.name === "curraddr") && value && /^ams/.test(cls)) {
      addAffiliation(value, lastAuthor() ? [lastAuthor()!] : [], node.name === "curraddr" ? `current-${nextCurrent++}` : String(nextAffiliation++), node.name === "curraddr");
      return true;
    }
    if (node.name === "email" && value && out.paper) { (lastAuthor()?.emails ?? out.notes).push(value); return true; }
    if ((node.name === "orcid" || node.name === "orcidID") && value && out.paper) {
      const author = lastAuthor(); if (author) author.orcid = value; else out.notes.push(value);
      return true;
    }
    if (node.name === "correspondingauthor" && value && out.paper) {
      const author = lastAuthor(); if (author) author.corresponding = true;
      (author?.notes ?? out.notes).push(value);
      return true;
    }
    if (["thanks", "equalcont", "authornote"].includes(node.name) && value) { (lastAuthor()?.notes ?? out.notes).push(value); return true; }
    if (node.name === "abstract" && value) { out.abstracts = [value]; return true; }
    if (node.name === "keywords" && value) { out.keywords = [value]; return true; }
    if (node.name === "subjclass" && value) {
      const schema = node.args.find(arg => arg.kind === "o" && given(arg));
      out.subjects.push({ ...value, kind: "subjclass", ...(schema ? { qualifier: argText(file.src, schema) } : {}) });
      return true;
    }
    if (node.name === "ccsdesc" && value && cls === "acmart") { out.subjects.push({ ...value, kind: "ccsdesc" }); return true; }
    if ((node.name === "dedication" || node.name === "dedicatory") && value) { out.dedication = value; return true; }
    return false;
  };

  const walk = (file: PlanFile, nodes: readonly TexNode[], visit: number | null, dirs: readonly string[], depth: number): void => {
    if (out.maketitle || depth >= 32) return;
    const context = `${file.key}|${visit ?? "preamble"}|${dirs.join("|")}`;
    if (stack.has(context)) return;
    stack.add(context);
    for (const node of nodes) {
      if (out.maketitle) break;
      if (node.t === "env" && node.name === "document") { walk(file, node.body, file === root ? 0 : visit, dirs, depth + 1); continue; }
      if (node.t === "env" && node.name === "abstract") {
        out.abstracts.push(part(file, node.body, node.bodyFrom, node.bodyTo, visit ?? undefined));
        declarations.add(node);
        continue;
      }
      if (node.t !== "macro" || node.code) continue;
      if (node.name === "maketitle" || (cls === "aastex701" && visit !== null && node.name === "section")) {
        out.maketitle = { file, node, ...(visit !== null ? { visit } : {}) };
        break;
      }
      if (INPUTS.has(node.name)) {
        const target = visit === null ? undefined : plan.inputTargets.get(`${visit}@${node.from}`);
        if (target !== undefined) {
          const invocation = plan.visits[target];
          const child = invocation && plan.files.get(invocation.key);
          if (child) {
            const document = invocation.bodyOnly ? child.nodes.find(n => n.t === "env" && n.name === "document") : null;
            walk(child, document?.t === "env" ? document.body : child.nodes, target, invocation.inputDirs, depth + 1);
          }
        } else {
          // Body include directives absent from the visit graph were excluded by includeonly.
          if (visit !== null && /^(?:include|subfileinclude|(?:sub)?includefrom)$/.test(node.name)) continue;
          const name = argText(file.src, mandatory(node));
          const directory = IMPORTS.has(node.name) ? argText(file.src, node.args.at(-2)) : null;
          const reference = resolveFileReference(plan.rootDir, node.name, name, directory, dirs, path => loaded.has(path));
          const child = reference && loaded.get(reference.path);
          if (child && reference) {
            const document = reference.bodyOnly ? child.nodes.find(n => n.t === "env" && n.name === "document") : null;
            walk(child, document?.t === "env" ? document.body : child.nodes, null, reference.inputDirs, depth + 1);
          }
        }
        continue;
      }
      if (metadata(file, node, visit ?? undefined)) declarations.add(node);
    }
    stack.delete(context);
  };
  walk(root, root.nodes, null, [plan.rootDir], 0);
  if (out.maketitle) out.consumed = declarations;
  return out;
}
