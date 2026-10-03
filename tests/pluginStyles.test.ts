import "./support/dom";
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { Notice, notices } from "./support/obsidian";
import { checkPluginStyles } from "../src/pluginStyles";

new Notice(""); notices.length = 0;
const cleanups: (() => void)[] = [];
const wait = () => new Promise((resolve) => setTimeout(resolve, 350));
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  document.head.replaceChildren(); document.body.replaceChildren(); notices.length = 0;
});
function preview(doc = document): HTMLElement {
  const element = doc.body.appendChild(doc.createElement("div")); element.className = "ll-preview";
  return element;
}
function loadStyles(doc = document): void {
  const sheet = doc.head.appendChild(doc.createElement("style"));
  sheet.textContent = readFileSync("styles.css", "utf8");
}
function check(element: HTMLElement): void { cleanups.push(checkPluginStyles(element)); }

test("missing stylesheet gives actionable update/restart guidance, with no CSS injection", async () => {
  check(preview()); await wait();
  assert.equal(notices.length, 1);
  assert.match(notices[0], /preview styles are not loaded.*Community plugins.*restart Obsidian/);
  assert.equal(document.head.children.length, 0);
});

test("normal and startup-delayed host stylesheet loading gives no false warning", async () => {
  check(preview()); loadStyles(); await wait();
  assert.equal(notices.length, 0);
  assert.equal(document.head.children.length, 1);
  check(preview()); await wait(); assert.equal(notices.length, 0);
});

test("closing or disconnecting the preview cancels the check; repeated checks warn once", async () => {
  const closed = preview(), detached = preview();
  checkPluginStyles(closed)(); check(detached); detached.remove(); await wait();
  assert.equal(notices.length, 0);
  check(closed); await wait(); check(closed); await wait();
  assert.equal(notices.length, 1);
});

test("a popout checks its own stylesheet rather than the main document", async () => {
  const other = new JSDOM("<!doctype html><html><head></head><body></body></html>", { pretendToBeVisual: true });
  try {
    loadStyles(); check(preview()); check(preview(other.window.document)); await wait();
    assert.equal(notices.length, 1);
    assert.equal(other.window.document.head.children.length, 0);
  } finally { other.window.close(); }
});
