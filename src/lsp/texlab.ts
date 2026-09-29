import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { extname, join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import type { ChangeSet, Text } from "@codemirror/state";
import { logicalMapper } from "../tex/project";
import { LspClient } from "./client";

// texlab (https://github.com/latex-lsp/texlab) as the completion and hover backend.
// One server per vault; it stays free of the obsidian module so tests drive it in Node.
// Conventions (measured against texlab 5.26, see docs/design.md):
//   - The workspace is the vault root: texlab walks up from an opened file to its root
//     document, bounded by the workspace folder (a chapter folder loses the other chapters).
//   - Every document is sent with a trailing "\n" when it lacks one: texlab returns no
//     command completions when the command touches the very end of the document (CR-4).
//     Real positions all lie before the extra character, so nothing else is translated.
//   - Settings are pulled with workspace/configuration (section "texlab");
//     didChangeConfiguration {settings: null} makes texlab pull them again.
//   - Its diagnostics are ignored: compile diagnostics from the TeX log stay authoritative.

export type TexlabStatus = "idle" | "missing" | "starting" | "running" | "failed" | "stopped";

export interface TexlabOptions {
  /** Absolute path of the texlab binary, or null when none was found. */
  binary: () => string | null;
  /** Workspace root (the vault base path). */
  root: string;
  /** Process environment; PATH should start with the TeX bin directory (CR-11). */
  env: () => NodeJS.ProcessEnv;
  /** The "texlab" configuration section (see texlabSettings). */
  settings: () => Record<string, unknown>;
  onStatus?: (status: TexlabStatus) => void;
}

export interface TexlabLocation {
  path: string;
  line: number;
  character: number;
}

interface LspPos {
  line: number;
  character: number;
}

/** Location or LocationLink. */
interface LspLocation {
  uri?: string;
  range?: { start: LspPos };
  targetUri?: string;
  targetSelectionRange?: { start: LspPos };
}

interface Doc {
  refs: number;
  version: number;
  /** Latest text from the views. */
  doc: Text;
  /** What the server has (as a view Text), or null when it has not been opened there. */
  synced: Text | null;
}

const EXE = process.platform === "win32" ? ".exe" : "";
const MAX_RESTARTS = 3;

/** The texlab binary: the configured path, a common install location, or the login shell's PATH. */
export function resolveTexlab(configured: string): string | null {
  const c = configured.trim();
  if (c) return existsSync(c) ? c : null;
  const dirs =
    process.platform === "win32"
      ? [join(homedir(), ".cargo", "bin")]
      : ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".cargo", "bin"), "/usr/bin"];
  for (const d of dirs) {
    const p = join(d, `texlab${EXE}`);
    if (existsSync(p)) return p;
  }
  const res = spawnSync(
    process.platform === "win32" ? "where.exe" : "/bin/sh",
    process.platform === "win32" ? ["texlab"] : ["-lc", "command -v texlab"],
    { encoding: "utf8", timeout: 4000 },
  );
  const found = res.status === 0 ? res.stdout.split(/\r?\n/).map((s) => s.trim()).find(Boolean) : undefined;
  return found && existsSync(found) ? found : null;
}

/**
 * The settings LaTeX Live gives texlab (TL-09). `outDir` is the compile output folder of the
 * active document, where texlab finds the .aux for label numbers ("Equation (2)").
 */
export function texlabSettings(outDir: string | null): Record<string, unknown> {
  return {
    completion: { matcher: "fuzzy-ignore-case" },
    hover: { symbols: "glyph" },
    chktex: { onOpenAndSave: false, onEdit: false },
    diagnosticsDelay: 300,
    latexFormatter: "none",
    bibtexFormatter: "texlab",
    ...(outDir ? { build: { auxDirectory: outDir, pdfDirectory: outDir } } : {}),
  };
}

/** Text as sent to texlab: always ends with a newline (CR-4). */
const shadow = (text: string) => (text.endsWith("\n") ? text : text + "\n");
const endsWithNewline = (doc: Text) => doc.length > 0 && doc.sliceString(doc.length - 1) === "\n";

const CLIENT_CAPABILITIES = {
  general: { positionEncodings: ["utf-16"] },
  workspace: {
    configuration: true,
    didChangeConfiguration: { dynamicRegistration: true },
    workspaceFolders: true,
  },
  textDocument: {
    synchronization: { didSave: false },
    completion: {
      contextSupport: true,
      completionItem: {
        snippetSupport: true,
        documentationFormat: ["markdown", "plaintext"],
        deprecatedSupport: true,
        preselectSupport: true,
        tagSupport: { valueSet: [1] },
        insertReplaceSupport: true,
        labelDetailsSupport: true,
        resolveSupport: { properties: ["documentation", "detail"] },
      },
    },
    hover: { contentFormat: ["markdown", "plaintext"] },
    definition: { linkSupport: true },
  },
};

export class TexlabServer {
  status: TexlabStatus = "idle";
  private client: LspClient | null = null;
  private starting: Promise<boolean> | null = null;
  private triggers: string[] = [];
  private docs = new Map<string, Doc>();
  private restarts = 0;
  private disposed = false;
  private readonly toLogical: (p: string) => string;

  constructor(private opts: TexlabOptions) {
    this.toLogical = logicalMapper(opts.root);
  }

  /** completionProvider.triggerCharacters (empty until the server runs). */
  triggerCharacters(): readonly string[] {
    return this.triggers;
  }

  /** A view shows `path` (refcounted); starts the server on first use. */
  open(path: string, doc: Text): void {
    const d = this.docs.get(path);
    if (d) {
      d.refs++;
      this.change(path, doc);
      return;
    }
    this.docs.set(path, { refs: 1, version: 0, doc, synced: null });
    if (this.status === "running") this.sendOpen(path);
    else void this.ensureStarted();
  }

  /**
   * The document changed. With `changes` from `startDoc` (what the server last saw) and an
   * unchanged trailing-newline state, the edit goes out incrementally; else as full text.
   */
  change(path: string, doc: Text, changes?: ChangeSet, startDoc?: Text): void {
    const d = this.docs.get(path);
    if (!d) return;
    d.doc = doc;
    this.sync(path, d, doc, changes, startDoc);
  }

  /** Bring the server's copy of `path` to `doc`. */
  private sync(path: string, d: Doc, doc: Text, changes?: ChangeSet, startDoc?: Text): void {
    if (this.status !== "running" || !d.synced || d.synced === doc) return;
    const incremental =
      changes && startDoc === d.synced && endsWithNewline(startDoc) === endsWithNewline(doc);
    const contentChanges = incremental ? incrementalChanges(changes, startDoc) : [{ text: shadow(doc.toString()) }];
    d.synced = doc;
    this.client?.notify("textDocument/didChange", {
      textDocument: { uri: uriOf(path), version: ++d.version },
      contentChanges,
    });
  }

  close(path: string): void {
    const d = this.docs.get(path);
    if (!d || --d.refs > 0) return;
    this.docs.delete(path);
    if (this.status === "running" && d.synced) {
      this.client?.notify("textDocument/didClose", { textDocument: { uri: uriOf(path) } });
    }
  }

  completion(path: string, doc: Text, position: LspPos, context: unknown): Promise<unknown> {
    return this.call(path, doc, "textDocument/completion", { position, context });
  }

  async resolve(item: unknown): Promise<unknown> {
    if (!(await this.ensureStarted())) return null;
    return this.client!.request("completionItem/resolve", item);
  }

  hover(path: string, doc: Text, position: LspPos): Promise<unknown> {
    return this.call(path, doc, "textDocument/hover", { position });
  }

  /** Definition targets as logical file paths (texlab may report /private/... paths). */
  async definition(path: string, doc: Text, position: LspPos): Promise<TexlabLocation[]> {
    const res = (await this.call(path, doc, "textDocument/definition", { position })) as
      | LspLocation
      | LspLocation[]
      | null;
    const list = Array.isArray(res) ? res : res ? [res] : [];
    const out: TexlabLocation[] = [];
    for (const l of list) {
      const uri = l.targetUri ?? l.uri;
      const start = l.targetSelectionRange?.start ?? l.range?.start;
      if (!uri?.startsWith("file:") || !start) continue;
      out.push({ path: this.toLogical(fileURLToPath(uri)), line: start.line, character: start.character });
    }
    return out;
  }

  /** Settings changed (e.g. another document's output folder): texlab pulls them again. */
  configurationChanged(): void {
    if (this.status === "running") this.client?.notify("workspace/didChangeConfiguration", { settings: null });
  }

  /** Stop and start again (settings changed, or the user asked); lazy when nothing is open. */
  async restart(): Promise<boolean> {
    await this.stop();
    this.restarts = 0;
    this.setStatus("idle");
    return this.docs.size ? this.ensureStarted() : true;
  }

  /** Plugin unload: kill the server and never start it again. */
  dispose(): Promise<void> {
    this.disposed = true;
    return this.stop();
  }

  /** Kill the server; open documents are kept and reopened by the next start. */
  async stop(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.starting = null;
    for (const d of this.docs.values()) d.synced = null;
    this.setStatus("stopped");
    await client?.stop();
  }

  /** Start once; resolves to whether the server is running. */
  ensureStarted(): Promise<boolean> {
    if (this.status === "running") return Promise.resolve(true);
    if (this.disposed || this.status === "missing" || this.status === "failed") return Promise.resolve(false);
    return (this.starting ??= this.start());
  }

  private async start(): Promise<boolean> {
    const binary = this.opts.binary();
    if (!binary) {
      this.setStatus("missing");
      return false;
    }
    this.setStatus("starting");
    const client = new LspClient({
      command: binary,
      cwd: this.opts.root,
      env: this.opts.env(),
      name: "texlab",
      onRequest: (method, params) => this.onServerRequest(method, params),
      onExit: (code) => this.onExit(client, code),
    });
    this.client = client;
    try {
      await client.start();
      const root = pathToFileURL(this.opts.root).href;
      const init = (await client.request(
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "obsidian-latex-live" },
          rootUri: root,
          workspaceFolders: [{ uri: root, name: "vault" }],
          capabilities: CLIENT_CAPABILITIES,
        },
        20000,
      )) as { capabilities?: { completionProvider?: { triggerCharacters?: string[] } } } | null;
      if (this.client !== client) return false; // stopped meanwhile
      this.triggers = init?.capabilities?.completionProvider?.triggerCharacters ?? [];
      client.notify("initialized", {});
      this.setStatus("running");
      for (const path of this.docs.keys()) this.sendOpen(path);
      return true;
    } catch (err) {
      console.error("[texlab] failed to start:", err);
      if (this.client === client) {
        this.client = null;
        this.setStatus("failed");
      }
      void client.stop();
      return false;
    } finally {
      if (this.client === client || this.client === null) this.starting = null;
    }
  }

  private onExit(client: LspClient, code: number | null): void {
    if (this.client !== client) return;
    console.error(`[texlab] exited with code ${code}`);
    this.client = null;
    this.starting = null;
    for (const d of this.docs.values()) d.synced = null;
    this.setStatus("failed");
    if (this.restarts++ < MAX_RESTARTS) {
      setTimeout(() => {
        if (this.status !== "failed" || this.client) return;
        this.setStatus("idle");
        if (this.docs.size) void this.ensureStarted();
      }, 1000);
    }
  }

  private sendOpen(path: string): void {
    const d = this.docs.get(path);
    if (!d || !this.client) return;
    d.synced = d.doc;
    d.version = 1;
    this.client.notify("textDocument/didOpen", {
      textDocument: {
        uri: uriOf(path),
        languageId: extname(path).toLowerCase() === ".bib" ? "bibtex" : "latex",
        version: 1,
        text: shadow(d.doc.toString()),
      },
    });
  }

  private async call(path: string, doc: Text, method: string, params: object): Promise<unknown> {
    if (!(await this.ensureStarted())) return null;
    const d = this.docs.get(path);
    if (!d) return null;
    // The request's text wins on the server; the views' latest text (d.doc) stays as is.
    this.sync(path, d, doc);
    return this.client!.request(method, { textDocument: { uri: uriOf(path) }, ...params });
  }

  private onServerRequest(method: string, params: unknown): unknown {
    if (method !== "workspace/configuration") return null; // progress, registerCapability, ...
    const items = (params as { items?: { section?: string }[] } | null)?.items ?? [];
    const settings = this.opts.settings();
    return items.map(({ section }) => {
      if (!section || section === "texlab") return settings;
      let v: unknown = settings;
      for (const k of section.replace(/^texlab\./, "").split(".")) {
        v = v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined;
      }
      return v ?? null;
    });
  }

  private setStatus(s: TexlabStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.opts.onStatus?.(s);
  }
}

function uriOf(path: string): string {
  return pathToFileURL(path).href;
}

/** LSP incremental changes for `changes` applied to `startDoc`, last change first. */
function incrementalChanges(changes: ChangeSet, startDoc: Text) {
  const pos = (offset: number): LspPos => {
    const line = startDoc.lineAt(offset);
    return { line: line.number - 1, character: offset - line.from };
  };
  const out: { range: { start: LspPos; end: LspPos }; text: string }[] = [];
  // Ranges refer to startDoc; sending them back to front keeps earlier ones valid.
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out.push({ range: { start: pos(fromA), end: pos(toA) }, text: inserted.toString() });
  });
  return out.reverse();
}
