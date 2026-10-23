import type { Extension, Text } from "@codemirror/state";
import { BlockType, EditorView } from "@codemirror/view";
import { CITE_COMMANDS } from "./latexHighlight";
import { literalAt } from "./latexScan";
import { flashElement, flashLine } from "./reveal";

/**
 * A click on a reference chip (`\ref`, `\eqref`, `\cref`, ...; with or without Cmd/Ctrl) jumps to
 * its `\label`, like an Obsidian link: in this document the view scrolls there and the target
 * flashes; otherwise `elsewhere` opens the project file that has it. The handler runs on mousedown,
 * before CodeMirror places the cursor, and only for the chip itself: a click beside it, the arrow
 * keys or a Shift/Alt-click put the cursor at the chip and reveal its source.
 */
export function labelJump(elsewhere: (key: string) => void): Extension {
  return EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || event.shiftKey || event.altKey) return false;
      const chip = (event.target as HTMLElement | null)?.closest?.("[data-ll-ref-key]") as HTMLElement | null;
      const key = chip?.dataset.llRefKey;
      const command = chip?.dataset.llRefCommand ?? "";
      if (!chip || !key || CITE_COMMANDS.has(command) || command === "nocite") return false;
      event.preventDefault();
      const at = labelIn(view.state.doc, key);
      if (at === null) elsewhere(key);
      else landOn(view, at);
      return true;
    },
  });
}

/** The position of `\label{key}` in `doc` outside comments and literal code, or null. */
export function labelIn(doc: Text, key: string): number | null {
  const text = doc.toString();
  const needle = `\\label{${key}}`;
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + 1)) {
    if (!literalAt(doc, i + 1)) return i;
  }
  return null;
}

/**
 * Show where a jump landed. A label under a rendered block (a formula) puts the cursor on the
 * line just above the block (below it at the document's start), not in it: that would turn the
 * block back into source, and the block is what the reader wants to see, so the rendered block
 * flashes. The cursor must come along, or whatever scrolls the cursor back into view later (a
 * click's mouseup, a re-render) takes the view back to where the jump started. Elsewhere the
 * cursor moves to the label and its line flashes.
 */
function landOn(view: EditorView, at: number): void {
  const block = view.lineBlockAt(at);
  if (block.type !== BlockType.WidgetRange) {
    view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
    view.focus();
    flashLine(view, at);
    return;
  }
  const next = block.from > 0 ? block.from - 1 : Math.min(block.to + 1, view.state.doc.length);
  view.dispatch({ selection: { anchor: next }, effects: EditorView.scrollIntoView(block.from, { y: "center" }) });
  view.focus();
  // The block's DOM exists once the scroll has been measured; wait a few frames for it.
  const win = view.dom.ownerDocument.defaultView ?? window;
  let tries = 10;
  const flash = () => {
    const el = Array.from(view.contentDOM.querySelectorAll<HTMLElement>(".lsp-lp-render.is-block")).find((e) => view.posAtDOM(e) === block.from);
    if (el) flashElement(view, el);
    else if (--tries > 0) win.requestAnimationFrame(flash);
  };
  win.requestAnimationFrame(flash);
}
