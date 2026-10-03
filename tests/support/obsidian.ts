// Stand-in for the "obsidian" module in tests (scripts/run-tests.mjs aliases it here), so the
// plugin's views mount in jsdom. It models only the documented behaviour the views rely on,
// not Obsidian's implementation: TextFileView.requestSave debounces save(), and save() writes
// getViewData() through vault.modify when it changed since the last load or save (save(true),
// on unload, also calls clear()); FileView's state is `{ file }`, and setState opens that file;
// addAction prepends a header button whose icon and tooltip setIcon / setTooltip change. A
// Notice's message (a string or a fragment) is in its noticeEl, setMessage replaces it and hide
// hides it; a Modal calls onOpen on open and onClose on close. Obsidian's DOM helpers (createEl,
// createDiv, createSpan, empty, setText, addClass) are installed on elements and fragments.

type Callback = (...args: unknown[]) => unknown;

export class Component {
  load(): void {}
  unload(): void {}
  registerEvent(_ref: unknown): void {}
  register(_cb: Callback): void {}
}

/** Obsidian's documented canonical vault paths: separators and NFC Unicode. */
export function normalizePath(path: string): string {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length && parts.at(-1) !== "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/").normalize("NFC");
}

/** Settings tabs inherit Component; navigation tests import the plugin without loading it. */
export class PluginSettingTab extends Component {}

export class FileSystemAdapter {
  constructor(private basePath: string) {}
  getBasePath(): string { return this.basePath; }
}

/** Entry-point imports only; navigation tests must not initialize settings or global math. */
export class Setting {
  constructor() { throw new Error("Settings UI is not available in this test host."); }
}
export async function loadMathJax(): Promise<void> { throw new Error("Global MathJax is not available in this test host."); }
export function finishRenderMath(): void { throw new Error("Global MathJax is not available in this test host."); }

export class Scope {
  keys: { modifiers: string[]; key: string | null; func: Callback }[] = [];
  constructor(public parent?: Scope) {}
  register(modifiers: string[], key: string | null, func: Callback) {
    const handler = { modifiers, key, func };
    this.keys.push(handler);
    return handler;
  }
}

export const MarkdownRenderer = {
  async render(_app: unknown, markdown: string, el: HTMLElement): Promise<void> {
    el.textContent = markdown;
  },
};

type DomInfo = string | { cls?: string | string[]; text?: string; attr?: Record<string, string | number | boolean> };
type Helpers = {
  createEl(tag: string, o?: DomInfo, cb?: (el: HTMLElement) => void): HTMLElement;
  createDiv(o?: DomInfo, cb?: (el: HTMLElement) => void): HTMLElement;
  createSpan(o?: DomInfo, cb?: (el: HTMLElement) => void): HTMLElement;
  empty(): void;
};

/** Obsidian's DOM helpers, as far as the plugin uses them (once; the globals of tests/support/dom). */
function installDomHelpers(): void {
  const el = HTMLElement.prototype as unknown as Partial<Helpers> & { setText(t: string): void; addClass(...c: string[]): void; setCssProps(props: Record<string, string>): void };
  if (el.createEl) return;
  for (const proto of [el as Helpers, DocumentFragment.prototype as unknown as Helpers]) {
    proto.createEl = function (this: Node, tag, o = {}, cb) {
      const child = document.createElement(tag);
      const info = typeof o === "string" ? { cls: o } : o;
      if (info.cls) child.className = [info.cls].flat().join(" ");
      if (info.text !== undefined) child.textContent = info.text;
      for (const [k, v] of Object.entries(info.attr ?? {})) child.setAttribute(k, String(v));
      this.appendChild(child);
      cb?.(child);
      return child;
    };
    proto.createDiv = function (this: Helpers, o, cb) {
      return this.createEl("div", o, cb);
    };
    proto.createSpan = function (this: Helpers, o, cb) {
      return this.createEl("span", o, cb);
    };
    proto.empty = function (this: Node) {
      while (this.firstChild) this.removeChild(this.firstChild);
    };
  }
  el.setText = function (this: HTMLElement, t: string) {
    this.textContent = t;
  };
  el.addClass = function (this: HTMLElement, ...c: string[]) {
    this.classList.add(...c);
  };
  el.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
    for (const [property, value] of Object.entries(props)) this.style.setProperty(property, value);
  };
}

/** Messages of every Notice shown (and each setMessage), in order, as text. */
export const notices: string[] = [];
/** Every Notice shown, in order. */
export const shownNotices: Notice[] = [];

export class Notice {
  noticeEl: HTMLElement;
  hidden = false;

  constructor(message: string | DocumentFragment, _duration?: number) {
    installDomHelpers();
    this.noticeEl = document.createElement("div");
    this.setMessage(message);
    shownNotices.push(this);
  }

  setMessage(message: string | DocumentFragment): this {
    this.noticeEl.textContent = "";
    if (typeof message === "string") this.noticeEl.textContent = message;
    else this.noticeEl.appendChild(message);
    notices.push(this.noticeEl.textContent ?? "");
    return this;
  }

  hide(): void {
    this.hidden = true;
  }
}

/** Every Modal opened, in order. */
export const modals: Modal[] = [];

export class Modal {
  modalEl: HTMLElement;
  titleEl: HTMLElement;
  contentEl: HTMLElement;
  isOpen = false;

  constructor(public app: unknown) {
    installDomHelpers();
    this.modalEl = document.createElement("div");
    this.titleEl = this.modalEl.appendChild(document.createElement("div"));
    this.contentEl = this.modalEl.appendChild(document.createElement("div"));
  }

  open(): void {
    this.isOpen = true;
    modals.push(this);
    this.onOpen();
  }

  close(): void {
    this.isOpen = false;
    this.onClose();
  }

  onOpen(): void {}
  onClose(): void {}
}

let testPdfJs: unknown;
/** Set only in tests exercising the pdf.js host's lifecycle. */
export function setPdfJsForTest(value: unknown): void {
  testPdfJs = value;
}
/** Obsidian's pdf.js loader: PDF images normally come from stand-in renderers. */
export async function loadPdfJs(): Promise<unknown> {
  if (testPdfJs !== undefined) return testPdfJs;
  throw new Error("pdf.js is Obsidian's: not available in tests");
}

/** Code highlighting is injected by Node export hosts; Obsidian supplies the runtime Prism. */
export async function loadPrism(): Promise<never> {
  throw new Error("Prism is Obsidian's: not available in tests");
}

/** The icon's name (Obsidian draws its SVG). */
export function setIcon(el: HTMLElement, icon: string): void {
  el.dataset.icon = icon;
}

export function setTooltip(el: HTMLElement, tooltip: string): void {
  el.setAttribute("aria-label", tooltip);
}

export class TFile {
  constructor(public path: string) {}
  get name(): string {
    return this.path.split("/").pop()!;
  }
  get basename(): string {
    return this.name.replace(/\.[^.]*$/, "");
  }
  get extension(): string {
    return this.name.split(".").pop()!;
  }
}

export class TFolder {
  constructor(public path: string) {}
  isRoot(): boolean { return this.path === "/" || this.path === ""; }
}
export function getLanguage(): string { return "zh"; }

/** An in-memory vault; `writes` records every modify in order. */
export class TestVault {
  files = new Map<string, string>();
  writes: { path: string; data: string }[] = [];
  async read(file: TFile): Promise<string> {
    return this.files.get(file.path) ?? "";
  }
  async modify(file: TFile, data: string): Promise<void> {
    this.files.set(file.path, data);
    this.writes.push({ path: file.path, data });
  }
}

export interface TestApp {
  vault: TestVault;
  scope: Scope;
  workspace: { on(...args: unknown[]): unknown; requestSaveLayout(): void; layoutSaves: number };
  plugins: { plugins: Record<string, unknown> };
}

export function testApp(): TestApp {
  const workspace = {
    layoutSaves: 0,
    on: () => ({}),
    requestSaveLayout() {
      workspace.layoutSaves++;
    },
  };
  return { vault: new TestVault(), scope: new Scope(), workspace, plugins: { plugins: {} } };
}

export class WorkspaceLeaf {
  constructor(public app: TestApp) {}
}

/** Side-panel views share the ordinary Component lifecycle, without file-saving behaviour. */
export abstract class ItemView extends Component {
  app: TestApp;
  containerEl: TestEl;
  contentEl: TestEl;
  actionsEl: HTMLElement;

  constructor(public leaf: WorkspaceLeaf) {
    super();
    installDomHelpers();
    this.app = leaf.app;
    this.containerEl = testEl("div");
    this.actionsEl = this.containerEl.appendChild(document.createElement("div"));
    this.contentEl = this.containerEl.appendChild(testEl("div"));
    document.body.appendChild(this.containerEl);
  }

  abstract getViewType(): string;
  abstract getDisplayText(): string;
  getIcon(): string { return "document"; }
  getState(): Record<string, unknown> { return {}; }
  async setState(_state: unknown, _result?: unknown): Promise<void> {}
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
  addAction(icon: string, title: string, cb: Callback): HTMLElement {
    const el = document.createElement("button");
    setIcon(el, icon);
    setTooltip(el, title);
    el.addEventListener("click", (event) => cb(event));
    this.actionsEl.prepend(el);
    return el;
  }
}

/** Registrations can be inspected by integration tests; no application is started. */
export class Plugin extends Component {
  commands: Record<string, unknown>[] = [];
  views = new Map<string, (leaf: WorkspaceLeaf) => unknown>();
  constructor(public app: TestApp) { super(); }
  addCommand(command: Record<string, unknown>): void { this.commands.push(command); }
  registerView(type: string, creator: (leaf: WorkspaceLeaf) => unknown): void { this.views.set(type, creator); }
}

type TestEl = HTMLElement & {
  addClass(...classes: string[]): void;
  toggleClass(classes: string | string[], value: boolean): void;
};

function testEl(tag: string): TestEl {
  const el = document.createElement(tag) as TestEl;
  el.addClass = (...classes) => el.classList.add(...classes);
  el.toggleClass = (classes, value) => {
    for (const c of Array.isArray(classes) ? classes : [classes]) el.classList.toggle(c, value);
  };
  return el;
}

export abstract class TextFileView extends Component {
  /** requestSave's debounce (2 s in Obsidian). */
  static requestSaveMs = 2000;
  app: TestApp;
  leaf: WorkspaceLeaf;
  file: TFile | null = null;
  data = "";
  scope: Scope | null = null;
  containerEl: TestEl;
  /** The header's action buttons (addAction), left to right. */
  actionsEl: HTMLElement;
  contentEl: TestEl;
  private lastSaved: string | null = null;
  private requestTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(leaf: WorkspaceLeaf) {
    super();
    this.leaf = leaf;
    this.app = leaf.app;
    this.containerEl = testEl("div");
    this.actionsEl = this.containerEl.appendChild(document.createElement("div"));
    this.contentEl = this.containerEl.appendChild(testEl("div"));
    document.body.appendChild(this.containerEl);
  }

  abstract getViewData(): string;
  abstract setViewData(data: string, clear: boolean): void;
  abstract clear(): void;

  requestSave = (): void => {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    this.requestTimer = setTimeout(() => {
      this.requestTimer = null;
      void this.save();
    }, TextFileView.requestSaveMs);
  };

  async save(clear?: boolean): Promise<void> {
    if (!this.file) return;
    const data = this.getViewData();
    const changed = data !== this.lastSaved;
    this.lastSaved = clear ? null : data;
    if (clear) this.clear();
    if (changed) await this.app.vault.modify(this.file, data);
  }

  async loadFile(file: TFile): Promise<void> {
    if (this.file) await this.onUnloadFile(this.file);
    this.file = file;
    this.data = this.lastSaved = await this.app.vault.read(file);
    this.setViewData(this.data, true);
  }

  async onUnloadFile(_file: TFile): Promise<void> {
    await this.save(true);
  }

  async onRename(_file: TFile): Promise<void> {}

  async onClose(): Promise<void> {
    if (this.requestTimer) clearTimeout(this.requestTimer);
    if (this.file) await this.onUnloadFile(this.file);
    this.file = null;
    this.containerEl.remove();
  }

  getState(): Record<string, unknown> {
    return { file: this.file?.path ?? null };
  }

  async setState(state: unknown, _result: unknown): Promise<void> {
    const path = (state as { file?: unknown } | null)?.file;
    if (typeof path === "string" && path !== this.file?.path) await this.loadFile(new TFile(path));
  }

  getEphemeralState(): Record<string, unknown> {
    return {};
  }

  setEphemeralState(_state: unknown): void {}

  addAction(icon: string, title: string, cb: Callback): HTMLElement {
    const el = document.createElement("button");
    el.className = "clickable-icon view-action";
    setIcon(el, icon);
    setTooltip(el, title);
    el.addEventListener("click", (e) => cb(e));
    this.actionsEl.prepend(el);
    return el;
  }
}
