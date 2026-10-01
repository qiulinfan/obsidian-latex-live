import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { safeHtmlFragment } from "../src/editor/htmlFragment";
import { ProjectMath } from "../src/editor/mathjaxProject";
import { obsidianMathJax } from "./support/mathjax";

test("card HTML removes executable content and unsafe URLs without losing safe structure", () => {
  const fragment = safeHtmlFragment(document, `<section><h4>Proof</h4><script>throw 1</script><iframe src="https://example.test"></iframe><img src="data:image/png;base64,AA==" onerror="throw 2"><a href="javascript:alert(1)">bad</a><a href="#theorem" data-ll-tex-ref="theorem">good</a><mjx-container jax="CHTML" onclick="throw 3"><mjx-math><mjx-mi>x</mjx-mi></mjx-math></mjx-container><svg onload="throw 4"><defs><path id="glyph" d="M0 0L1 1"></path></defs><use href="#glyph"></use><use href="https://example.test/glyph"></use><foreignObject><div onmouseover="throw 5">bad</div></foreignObject></svg></section>`);
  assert.equal(fragment.querySelector("script, iframe, foreignObject"), null);
  for (const element of fragment.querySelectorAll("*")) for (const attribute of element.attributes) assert.ok(!attribute.name.toLowerCase().startsWith("on"));
  assert.equal(fragment.querySelector("a")!.getAttribute("href"), null);
  assert.equal(fragment.querySelector("a[data-ll-tex-ref]")!.getAttribute("href"), "#theorem");
  assert.equal(fragment.querySelector("mjx-container")!.getAttribute("jax"), "CHTML");
  assert.equal(fragment.querySelector("use")!.getAttribute("href"), "#glyph");
  assert.equal(fragment.querySelectorAll("use")[1].getAttribute("href"), null);
  assert.match(fragment.querySelector("img")!.getAttribute("src")!, /^data:image\/png/);
});

test("card HTML preserves real MathJax CHTML layout and uses the requested document", async () => {
  const env = await obsidianMathJax();
  const math = ProjectMath.create(env.MathJax, env.window.document, { statements: [], physics: false, unsupported: new Map() });
  for (const formula of [String.raw`\frac{x^2+\sqrt[3]{y}}{\overline{a}}`, String.raw`\begin{aligned}x&=\sum_{i=0}^n a_i\\y&=\left(\frac{1}{x}\right)\end{aligned}`, String.raw`\begin{pmatrix}a&b\\c&d\end{pmatrix}`]) {
    const rendered = math.render(formula, true);
    const fragment = safeHtmlFragment(document, rendered.outerHTML);
    assert.equal(fragment.ownerDocument, document);
    assert.equal(fragment.firstElementChild!.outerHTML, rendered.outerHTML, "safe CHTML nodes and scalar layout attributes survive unchanged");
  }
  const popout = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
  try {
    const fragment = safeHtmlFragment(popout.window.document, '<p data-ll-tex-ref="local">popout</p>');
    assert.equal(fragment.ownerDocument, popout.window.document);
    assert.equal(fragment.firstElementChild!.ownerDocument, popout.window.document);
  } finally { popout.window.close(); }
});
