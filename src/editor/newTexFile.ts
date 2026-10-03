import { Modal, Notice, TFile, TFolder, getLanguage, normalizePath } from "obsidian";
import type LatexLivePlugin from "../main";

const messages = () => getLanguage().startsWith("zh") ? {
  title: "新建 TeX 文件", name: "文件名", create: "创建", open: "打开文件", cancel: "取消", untitled: "未命名", root: "库根目录",
  invalid: "请输入有效的文件名，不含路径分隔符或特殊字符。", exists: "已存在同名文件或文件夹，请换一个名称。",
  moved: "文件夹已移动或删除，请重新从文件夹菜单创建。", failed: "无法创建文件", openFailed: "文件已创建，但未能打开", created: "已创建",
} : {
  title: "New TeX file", name: "File name", create: "Create", open: "Open file", cancel: "Cancel", untitled: "Untitled", root: "Vault root",
  invalid: "Enter a valid file name without path separators or special characters.", exists: "A file or folder with this name already exists. Choose another name.",
  moved: "The folder was moved or removed. Open the folder menu again.", failed: "Could not create file", openFailed: "File created, but could not open it", created: "Created",
};

/** One portable filename, not a path; preserve literal percent sequences and Unicode. */
export function texFileName(value: string): string | null {
  const name = value.trim().normalize("NFC").replace(/\.tex$/i, "");
  if (!name || name === "." || name === ".." || /[\\/:*?"<>|\p{Cc}]/u.test(name) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) return null;
  return name + ".tex";
}
const inFolder = (folder: TFolder, name: string) => normalizePath(folder.isRoot() ? name : `${folder.path}/${name}`);

/** Name first, create once, then open through Obsidian's registered .tex view. */
export class NewTexFileModal extends Modal {
  private busy = false;
  private closed = false;
  private created: TFile | null = null;
  private composing = false;
  private readonly folderPath: string;
  private readonly text = messages();
  constructor(private plugin: LatexLivePlugin, private folder: TFolder, private done: () => void = () => {}) {
    super(plugin.app);
    this.folderPath = folder.path;
  }
  onClose(): void { this.closed = true; this.done(); }
  onOpen(): void {
    this.titleEl.setText(this.text.title);
    const form = this.contentEl.createEl("form");
    form.createEl("p", { text: this.folder.isRoot() ? this.text.root : this.folderPath });
    const label = form.createEl("label", { text: this.text.name });
    const input = label.createEl("input", { attr: { type: "text", "aria-label": this.text.name, spellcheck: "false", autocomplete: "off" } });
    let name = this.text.untitled + ".tex", suffix = 1;
    while (this.plugin.app.vault.getAbstractFileByPath(inFolder(this.folder, name))) name = `${this.text.untitled} ${suffix++}.tex`;
    input.value = name;
    const status = form.createEl("p", { attr: { role: "status", "aria-live": "polite" } });
    const create = form.createEl("button", { text: this.text.create, cls: "mod-cta", attr: { type: "submit" } });
    const cancel = form.createEl("button", { text: this.text.cancel, attr: { type: "button" } });
    cancel.addEventListener("click", () => this.close());
    input.addEventListener("compositionstart", () => { this.composing = true; });
    input.addEventListener("compositionend", () => { this.composing = false; });
    form.addEventListener("keydown", event => {
      if (event.key === "Enter" && (this.composing || event.isComposing || event.keyCode === 229)) event.preventDefault();
    });
    form.addEventListener("submit", event => {
      event.preventDefault();
      if (this.busy || this.closed || this.composing) return;
      void (async () => {
        this.busy = true; create.disabled = true; cancel.disabled = true;
        try {
          if (!this.created) {
            const fileName = texFileName(input.value);
            if (!fileName) { status.setText(this.text.invalid); return; }
            const vault = this.plugin.app.vault;
            const current = this.folder.isRoot() ? vault.getRoot() : vault.getAbstractFileByPath(this.folderPath);
            if (current !== this.folder || this.folder.path !== this.folderPath) { status.setText(this.text.moved); return; }
            const path = inFolder(this.folder, fileName);
            if (vault.getAbstractFileByPath(path)) { status.setText(this.text.exists); return; }
            // Vault.create fails rather than overwriting a file created concurrently.
            this.created = await vault.create(path, "");
            input.disabled = true;
          }
          if (this.closed) { new Notice(`${this.text.created}: ${this.created.path}`); return; }
          try {
            await this.plugin.app.workspace.getLeaf("tab").openFile(this.created);
            this.close();
          } catch (error) {
            status.setText(`${this.text.openFailed}: ${this.created.path}. ${String(error)}`);
            create.setText(this.text.open);
          }
        } catch (error) { status.setText(`${this.text.failed}: ${String(error)}`); }
        finally { this.busy = false; create.disabled = false; cancel.disabled = false; }
      })();
    });
    input.focus();
    input.setSelectionRange(0, input.value.length - 4);
  }
}

export function registerNewTexFile(plugin: LatexLivePlugin): void {
  const open = new Set<NewTexFileModal>();
  const show = (folder: TFolder) => {
    const modal = new NewTexFileModal(plugin, folder, () => open.delete(modal));
    open.add(modal); modal.open();
  };
  plugin.register(() => { for (const modal of [...open]) modal.close(); });
  plugin.registerEvent(plugin.app.workspace.on("file-menu", (menu, file) => {
    if (!(file instanceof TFolder)) return;
    menu.addItem(item => item.setTitle(messages().title).setIcon("file-plus").setSection("action-primary").onClick(() => show(file)));
  }));
  plugin.addCommand({ id: "new-tex-file", name: messages().title, callback: () => {
    const path = plugin.app.workspace.getActiveFile()?.path ?? "";
    show(plugin.app.fileManager.getNewFileParent(path));
  } });
}
