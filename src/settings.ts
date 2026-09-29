import { App, PluginSettingTab, Setting } from "obsidian";
import type LatexLivePlugin from "./main";
import type { EngineSetting } from "./tex/project";

export interface LatexLiveSettings {
  /** Directory with pdflatex, latexmk, synctex; empty means auto-detect. */
  texBinDir: string;
  /** Engine when the document has no `% !TEX program` comment. */
  engine: EngineSetting;
  /** Delay after the last keystroke before saving and recompiling. */
  debounceMs: number;
  /** Precompile the preamble into a format file (pdfLaTeX only). */
  preambleCache: boolean;
  /** Pass -shell-escape (needed by minted etc.; runs arbitrary commands). */
  shellEscape: boolean;
  /** Scroll the preview to the cursor (SyncTeX) as you move around. */
  followCursor: boolean;
  /** Invert preview colors: never, or follow Obsidian's dark theme. */
  invertPreview: "never" | "dark-theme";
  /** texlab binary for completion and hover; empty means auto-detect. */
  texlabPath: string;
  /** Show the YOLO plugin's AI ghost-text completion in LaTeX files. */
  yoloTabCompletion: boolean;
}

export const DEFAULT_SETTINGS: LatexLiveSettings = {
  texBinDir: "",
  engine: "auto",
  debounceMs: 400,
  preambleCache: true,
  shellEscape: false,
  followCursor: true,
  invertPreview: "never",
  texlabPath: "",
  yoloTabCompletion: false,
};

export class LatexLiveSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private plugin: LatexLivePlugin,
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => void this.plugin.saveSettings();

    const detected = this.plugin.texBinDir();
    new Setting(containerEl)
      .setName("TeX binary directory")
      .setDesc(
        `Directory containing pdflatex, latexmk and synctex. Leave empty to ` +
          `auto-detect. Currently using: ${detected ?? "not found"}`,
      )
      .addText((t) =>
        t
          .setPlaceholder("/Library/TeX/texbin")
          .setValue(s.texBinDir)
          .onChange((v) => {
            s.texBinDir = v.trim();
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Default engine")
      .setDesc(
        "Used when the root file has no '% !TEX program = ...' comment. " +
          "'auto' reads latexmkrc and the preamble (fontspec/ctex → XeLaTeX).",
      )
      .addDropdown((d) =>
        d
          .addOptions({
            auto: "auto",
            pdflatex: "pdfLaTeX",
            xelatex: "XeLaTeX",
            lualatex: "LuaLaTeX",
          })
          .setValue(s.engine)
          .onChange((v) => {
            s.engine = v as EngineSetting;
            save();
          }),
      );

    new Setting(containerEl)
      .setName("Compile delay (ms)")
      .setDesc("Pause after typing before the file is saved and recompiled.")
      .addText((t) =>
        t.setValue(String(s.debounceMs)).onChange((v) => {
          const n = Number(v);
          if (Number.isFinite(n) && n >= 100 && n <= 10000) {
            s.debounceMs = n;
            save();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Cache the preamble")
      .setDesc(
        "pdfLaTeX only: precompile everything before \\begin{document} into " +
          "a format (mylatexformat) and rebuild it when the preamble or a " +
          "local file it loads changes. Often halves compile time.",
      )
      .addToggle((t) =>
        t.setValue(s.preambleCache).onChange((v) => {
          s.preambleCache = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Follow cursor in preview")
      .setDesc("Scroll the preview to the text under the cursor (SyncTeX).")
      .addToggle((t) =>
        t.setValue(s.followCursor).onChange((v) => {
          s.followCursor = v;
          save();
        }),
      );

    new Setting(containerEl)
      .setName("Invert preview colors")
      .addDropdown((d) =>
        d
          .addOptions({ never: "never", "dark-theme": "with dark theme" })
          .setValue(s.invertPreview)
          .onChange((v) => {
            s.invertPreview = v === "dark-theme" ? "dark-theme" : "never";
            save();
            this.plugin.refreshPreviews();
          }),
      );

    const texlab = this.plugin.texlabPath();
    new Setting(containerEl)
      .setName("texlab binary")
      .setDesc(
        "Language server for completion (commands, environments, labels, citations, " +
          "packages, files) and hover. Leave empty to auto-detect. Currently using: " +
          `${texlab ?? "not found (brew install texlab)"}; status: ${this.plugin.texlab.status}.`,
      )
      .addText((t) =>
        t
          .setPlaceholder("/opt/homebrew/bin/texlab")
          .setValue(s.texlabPath)
          .onChange((v) => {
            s.texlabPath = v.trim();
            save();
          }),
      );

    const yoloDesc = () =>
      "Show the YOLO plugin's AI ghost text in LaTeX files. Tab order: completion popup > " +
      "AI ghost text > next snippet field > indent; Enter never accepts AI text; Shift-Tab " +
      "or Escape dismisses it. Uses YOLO's own triggers, delay and enable switch. Bridge: " +
      `${s.yoloTabCompletion ? this.plugin.yolo.describe() : "off"}.`;
    const yolo = new Setting(containerEl)
      .setName("YOLO AI tab completion")
      .setDesc(yoloDesc())
      .addToggle((t) =>
        t.setValue(s.yoloTabCompletion).onChange(async (v) => {
          s.yoloTabCompletion = v;
          await this.plugin.saveSettings();
          this.plugin.yolo.refresh();
          yolo.setDesc(yoloDesc());
        }),
      );

    new Setting(containerEl)
      .setName("Allow shell escape")
      .setDesc(
        "Pass -shell-escape (minted, gnuplot, ...). Documents can then run " +
          "arbitrary commands on this machine; enable only for trusted files.",
      )
      .addToggle((t) =>
        t.setValue(s.shellEscape).onChange((v) => {
          s.shellEscape = v;
          save();
        }),
      );
  }
}
