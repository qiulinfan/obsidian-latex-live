import "./support/dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { Component, Notice } from "./support/obsidian";
import { ensurePluginStyles } from "../src/pluginStyles";
import stylesheet from "../styles.css";

new Notice("");
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.head.replaceChildren(); document.body.replaceChildren();
});
function owner(): Component {
  const component = new Component();
  component.register = (cleanup) => { cleanups.push(() => { cleanup(); }); };
  return component;
}
function preview(doc = document): HTMLElement {
  const element = doc.body.appendChild(doc.createElement("div"));
  element.className = "ll-preview";
  const bar = element.appendChild(doc.createElement("div")); bar.className = "ll-toolbar";
  const actions = bar.appendChild(doc.createElement("div")); actions.className = "ll-actions";
  return element;
}

test("missing host stylesheet recovers horizontal preview controls from the authored CSS", () => {
  const element = preview();
  assert.notEqual(getComputedStyle(element.querySelector(".ll-actions")!).display, "flex");
  ensurePluginStyles(element, owner());
  assert.equal(getComputedStyle(element).display, "flex");
  assert.equal(getComputedStyle(element.querySelector(".ll-toolbar")!).display, "flex");
  assert.equal(getComputedStyle(element.querySelector(".ll-actions")!).display, "flex");
  assert.equal(document.head.querySelector("style")!.textContent, stylesheet);
});

test("normally loaded CSS needs no recovery; theme overrides retain their order", () => {
  const native = document.head.createEl("style", { text: stylesheet });
  const theme = document.head.createEl("style", { text: ".ll-preview { color: rgb(1, 2, 3); }" });
  const element = preview(), component = owner();
  ensurePluginStyles(element, component);
  assert.equal(document.head.querySelectorAll("style").length, 2);
  assert.equal(cleanups.length, 0);
  native.remove();
  ensurePluginStyles(element, component);
  assert.equal(document.head.lastElementChild, theme);
  assert.equal(getComputedStyle(element).color, "rgb(1, 2, 3)");
});

test("multiple previews reuse recovery and plugin unload removes only the recovery sheet", () => {
  const theme = document.head.createEl("style", { text: ".ll-preview { color: red; }" });
  const component = owner();
  ensurePluginStyles(preview(), component); ensurePluginStyles(preview(), component);
  assert.equal(document.querySelectorAll("[data-latex-live-recovery]").length, 1);
  cleanups.splice(0).forEach((cleanup) => cleanup());
  assert.deepEqual([...document.head.children], [theme]);
});

test("a popout recovers in its own document and both sheets clean up", () => {
  const other = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true });
  try {
    Object.assign(other.window.HTMLElement.prototype, { createEl: HTMLElement.prototype.createEl });
    const component = owner(); ensurePluginStyles(preview(), component);
    ensurePluginStyles(preview(other.window.document), component);
    assert.equal(other.window.document.head.querySelectorAll("[data-latex-live-recovery]").length, 1);
    assert.equal(cleanups.length, 2);
    cleanups.splice(0).forEach((cleanup) => cleanup());
    assert.equal(other.window.document.head.children.length, 0);
  } finally { other.window.close(); }
});
