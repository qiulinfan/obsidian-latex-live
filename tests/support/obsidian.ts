// Stand-in for the "obsidian" module in tests (scripts/run-tests.mjs aliases it here), so the
// plugin's views mount in jsdom. It models only the documented behaviour the views rely on,
// not Obsidian's implementation: TextFileView.requestSave debounces save(), and save() writes
// getViewData() through vault.modify when it changed since the last load or save (save(true),
// on unload, also calls clear()); FileView's state is `{ file }`, and setState opens that file;
// addAction prepends a header button whose icon and tooltip setIcon / setTooltip change.

type Callback = (...args: unknown[]) => unknown;

export class Component {
  load(): void {}
  unload(): void {}
  registerEvent(_ref: unknown): void {}
  register(_cb: Callback): void {}
}

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

/** Messages of every Notice shown, in order. */
export const notices: string[] = [];

export class Notice {
  constructor(message: string, _duration?: number) {
    notices.push(message);
  }
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
