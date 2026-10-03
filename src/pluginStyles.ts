import type { Component } from "obsidian";
import stylesheet from "../styles.css";

type StyleOwner = Pick<Component, "register">;
const recovered = new WeakMap<StyleOwner, WeakMap<Document, HTMLStyleElement>>();

/** The host treats a failed styles.css download as optional. Recover from the same
 * authored stylesheet bundled in main.js, without a network request or a second source. */
export function ensurePluginStyles(element: HTMLElement, owner: StyleOwner): void {
  const doc = element.ownerDocument;
  const win = doc.defaultView;
  if (!win || win.getComputedStyle(element).getPropertyValue("--ll-styles-loaded").trim() === "1") return;
  let windows = recovered.get(owner);
  if (!windows) { windows = new WeakMap(); recovered.set(owner, windows); }
  if (windows.get(doc)?.isConnected) return;
  // Match the host's ordering: plugin CSS precedes theme/snippet style elements.
  const before = doc.head.querySelector("style");
  const style = doc.head.createEl("style", { text: stylesheet, attr: { "data-latex-live-recovery": "" } });
  if (before) doc.head.insertBefore(style, before);
  windows.set(doc, style);
  owner.register(() => { style.remove(); windows.delete(doc); });
}
