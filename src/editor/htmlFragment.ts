import createDOMPurify, { type DOMPurify, type WindowLike } from "dompurify";

const purifiers = new WeakMap<Window, DOMPurify>();
// CHTML uses these scalar layout attributes in addition to standard HTML/MathML.
const chtmlAttributes = new Set(["jax", "size", "space", "rspace", "texclass", "type", "unselectable"]);

/** Sanitize card or clipboard HTML in its actual owner window before reading or inserting nodes. */
export function safeHtmlFragment(doc: Document, html: string): DocumentFragment {
  const win = doc.defaultView;
  if (!win) throw new Error("The theorem card requires an active document window.");
  let purifier = purifiers.get(win);
  if (!purifier) {
    purifier = createDOMPurify(win as unknown as WindowLike);
    if (!purifier.isSupported) throw new Error("HTML sanitization is unavailable in this window.");
    purifier.addHook("uponSanitizeAttribute", (element, attribute) => {
      // SVG glyph reuse must stay inside the generated drawing, never load a URL.
      if (element.localName === "use" && ["href", "xlink:href"].includes(attribute.attrName) && !attribute.attrValue.startsWith("#")) attribute.keepAttr = false;
    });
    purifiers.set(win, purifier);
  }
  const fragment = purifier.sanitize(html, {
    RETURN_DOM_FRAGMENT: true,
    // Only MathJax's generated CHTML custom elements extend the default safe tags.
    ADD_TAGS: (tag) => /^mjx-[a-z][a-z0-9-]*$/.test(tag) || tag === "use",
    ADD_ATTR: (attribute, tag) => tag.startsWith("mjx-") && chtmlAttributes.has(attribute),
  });
  return doc.importNode(fragment, true);
}
