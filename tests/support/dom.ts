// jsdom globals so @codemirror/view runs headless. Import this module FIRST
// in a test file: @codemirror/view reads navigator/document at load time
// (platform detection decides "Mod" = Cmd on mac, as in Obsidian).
import { JSDOM } from "jsdom";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) obsidian/1.13.7 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  pretendToBeVisual: true,
  url: "http://localhost/",
  userAgent: UA,
});
const w = dom.window as unknown as Record<string, unknown> & typeof dom.window;
Object.defineProperty(w.navigator, "platform", { value: "MacIntel", configurable: true });

const define = (k: string, v: unknown) =>
  Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
define("window", w);
define("document", w.document);
define("navigator", w.navigator);
for (const k of [
  "Node", "Element", "HTMLElement", "Text", "Range", "Selection", "DocumentFragment",
  "ShadowRoot", "Event", "KeyboardEvent", "MouseEvent", "FocusEvent", "InputEvent",
  "CompositionEvent", "CustomEvent", "MutationObserver", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "DOMRect", "Window", "Document",
  "HTMLDocument",
]) {
  const v = w[k];
  if (v !== undefined) {
    define(k, typeof v === "function" && /^[a-z]/.test(k) ? (v as () => unknown).bind(w) : v);
  }
}

// Layout stubs: jsdom has no layout engine.
const emptyRect = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0 };
const emptyList = Object.assign([], { item: () => null });
dom.window.Range.prototype.getClientRects = () => emptyList as unknown as DOMRectList;
dom.window.Range.prototype.getBoundingClientRect = () => emptyRect as DOMRect;
if (!dom.window.Element.prototype.scrollIntoView) {
  dom.window.Element.prototype.scrollIntoView = () => {};
}

export { dom };
