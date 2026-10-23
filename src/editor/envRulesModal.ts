import { App, Modal } from "obsidian";
import { DEFAULT_HIDDEN, DEFAULT_MATH_ENVS, DEFAULT_WRAPPERS, UserEnvRules, parseFormulaRules, parseNameList } from "../tex/envRules";

export type EnvRulesKind = keyof UserEnvRules;

const TEXT: Record<EnvRulesKind, { title: string; help: string; example: string; defaults: () => string }> = {
  formulas: {
    title: "Formula environments",
    help: 'Environment → the formula environment it renders as (numbering, \\label and the error fallback follow it). "source" keeps any environment as source.',
    example: '{ "myeq": "equation" }',
    defaults: () => DEFAULT_MATH_ENVS.join(", "),
  },
  wrappers: {
    title: "Wrapper environments",
    help: "Environments whose \\begin and \\end lines collapse (with their arguments); the content keeps rendering, formulas included. \"!name\" keeps a default as source.",
    example: '["subequations"]',
    defaults: () => DEFAULT_WRAPPERS.join(", "),
  },
  hidden: {
    title: "Hidden commands",
    help: "Commands (without \\) hidden with their arguments until the cursor touches them. The arguments come from the project's \\newcommand, else the built-in table, else the [..]/{..} right after. \"!name\" keeps a default visible.",
    example: '["centering", "DeckLayout"]',
    defaults: () => [...DEFAULT_HIDDEN].map(([n, a]) => (a.args ? `${n} (${a.args})` : n)).join(", "),
  },
};

/** The JSON of one rule list; the parsed value when valid, else the readable error. */
export function parseRulesJson(kind: EnvRulesKind, json: string): UserEnvRules[EnvRulesKind] {
  let value: unknown;
  try { value = JSON.parse(json.trim() || (kind === "formulas" ? "{}" : "[]")); }
  catch (error) { throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`); }
  return kind === "formulas" ? parseFormulaRules(value) : parseNameList(value, kind === "wrappers" ? "environment" : "command");
}

export interface EnvRulesHost {
  app: App;
  kind: EnvRulesKind;
  value: UserEnvRules[EnvRulesKind];
  /** Validate against the other lists, store, and redecorate the open editors; throws to keep the modal open. */
  save(value: UserEnvRules[EnvRulesKind]): Promise<void>;
}

/** Edit one of settings.envRules' lists as JSON: the defaults are shown, only additions are stored. */
export class EnvRulesModal extends Modal {
  private closed = false;

  constructor(private host: EnvRulesHost) {
    super(host.app);
  }

  onOpen(): void {
    this.closed = false;
    const t = TEXT[this.host.kind];
    this.titleEl.setText(`Live editor rules: ${t.title.toLowerCase()}`);
    this.modalEl.addClass("ll-template-modal");
    this.contentEl.createEl("p", { text: t.help });
    this.contentEl.createEl("p", { text: `Built in (always on unless removed with "!"): ${t.defaults()}` , cls: "ll-env-rules-defaults" });
    this.contentEl.createEl("p", { text: `Example: ${t.example}. A template profile naming the same environment wins. These rules change the live editor only, not the PDF or the HTML export.` });
    const area = this.contentEl.createEl("textarea", { cls: "ll-env-rules-json", attr: { rows: "10", spellcheck: "false", "aria-label": t.title } });
    area.value = JSON.stringify(this.host.value, null, 2);
    const error = this.contentEl.createDiv({ cls: "ll-template-error", attr: { role: "status", "aria-live": "polite" } });
    const actions = this.contentEl.createDiv({ cls: "ll-template-actions" });
    const save = actions.createEl("button", { text: "Save" });
    save.addClass("mod-cta");
    save.addEventListener("click", () => {
      let value: UserEnvRules[EnvRulesKind];
      try { value = parseRulesJson(this.host.kind, area.value); }
      catch (e) { error.setText(e instanceof Error ? e.message : String(e)); return; }
      save.disabled = true;
      void this.host.save(value).then(() => { if (!this.closed) this.close(); }).catch((e) => {
        if (!this.closed) { error.setText(e instanceof Error ? e.message : String(e)); save.disabled = false; }
      });
    });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
  }

  onClose(): void { this.closed = true; this.contentEl.empty(); }
}
