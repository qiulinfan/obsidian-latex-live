import { Notice } from "obsidian";

const warned = new WeakSet<HTMLElement>();

/** The host loads styles.css after plugin startup. Check after that loading window;
 * a missing optional download must produce an actionable notice, never runtime CSS. */
export function checkPluginStyles(element: HTMLElement): () => void {
  const win = element.ownerDocument.defaultView;
  if (!win) return () => {};
  const timer = win.setTimeout(() => {
    if (!element.isConnected || warned.has(element) ||
        win.getComputedStyle(element).getPropertyValue("--ll-styles-loaded").trim() === "1") return;
    warned.add(element);
    new Notice("LaTeX Live: preview styles are not loaded. Update LaTeX Live in Community plugins, then restart Obsidian. If styles.css is still missing, reinstall the plugin after backing up its settings.", 15_000);
  }, 300);
  return () => { win.clearTimeout(timer); };
}
