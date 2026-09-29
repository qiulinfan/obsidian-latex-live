// YOLO contract check (not part of `npm test`): the key matrix and the cases that depend
// on YOLO's own logic, replayed against the REAL YOLO controllers sliced from YOLO_MAIN.
// Run through scripts/yolo-contract.mjs (`npm run test:yolo`).
import "./support/dom";
import assert from "node:assert/strict";
import { test } from "node:test";
import { YOLO_VERIFIED_VERSIONS, bindYolo } from "../src/editor/shared/yoloBridge";
import { YoloSettings } from "./support/fakeYolo";
import {
  Ctx, GOLDEN, KEYS, STATES, matrixRow, openPopup, press, settle, setup, sleep, snap, triggerSettings, typeText,
} from "./support/keyMatrix";
import { loadYolo } from "./support/realYolo";

const yolo = loadYolo(process.env.YOLO_MAIN!);
const makeReal = (o: { settings: YoloSettings }) => yolo.make(o);
const done = (c: Ctx) => {
  c.view.destroy();
  c.bridge.destroy();
};

test(`bindYolo accepts the real YOLO (${yolo.file}, sha256/16 ${yolo.sha256_16})`, () => {
  const bound = bindYolo(yolo.make({ settings: triggerSettings() }).plugin);
  assert.equal(typeof bound, "object", String(bound));
  assert.ok(YOLO_VERIFIED_VERSIONS.length > 0);
});

for (const state of Object.keys(STATES)) {
  test(`matrix (real YOLO): ${state} x ${KEYS.join(", ")}`, async () => {
    assert.deepEqual(await matrixRow(makeReal, state), GOLDEN[state]);
  });
}

test("X7 YOLO's trigger fires once after ', ' with the file name", async () => {
  const c = setup(makeReal, { settings: triggerSettings({ idleTriggerEnabled: false }) });
  for (const ch of "we have x, ") {
    typeText(c.view, ch);
    await sleep(5);
  }
  await sleep(0);
  assert.equal(snap(c).armed, true);
  await sleep(80);
  assert.deepEqual(c.yolo!.runCalls, [{ title: "notes.typ", head: 11, replaceFromOffset: null }]);
  assert.equal(snap(c).ai, "(generating)");
  done(c);
});

test("X7b YOLO's idle cooldown is respected", async () => {
  const c = setup(makeReal, { settings: triggerSettings({ autoTriggerCooldownMs: 10000 }) });
  for (const ch of "abcdefgh") {
    typeText(c.view, ch);
    await sleep(5);
  }
  await sleep(120);
  for (const ch of "ijkl") {
    typeText(c.view, ch);
    await sleep(5);
  }
  await sleep(120);
  assert.equal(c.yolo!.runCalls.length, 1);
  done(c);
});

test("X7c YOLO's own enable toggle is respected", async () => {
  const c = setup(makeReal, { settings: triggerSettings() });
  c.yolo!.settings.continuationOptions.enableTabCompletion = false;
  for (const ch of "we have x, ") typeText(c.view, ch);
  await sleep(120);
  assert.equal(c.yolo!.runCalls.length, 0);
  done(c);
});

test("X8 no arming under the popup; closing it arms YOLO", async () => {
  const c = setup(makeReal, { settings: triggerSettings({ idleTriggerEnabled: true, autoTriggerDelayMs: 60 }) });
  typeText(c.view, "some text \\fr");
  await openPopup(c.view);
  typeText(c.view, "a");
  await sleep(100);
  assert.deepEqual([snap(c).armed, c.yolo!.runCalls.length], [false, 0]);
  press(c.view, "Escape");
  await sleep(0);
  assert.equal(snap(c).armed, true);
  await sleep(100);
  assert.equal(c.yolo!.runCalls.length, 1);
  done(c);
});

test("X16 accept inserts raw text where YOLO's own path would escape it", async () => {
  const text = "<intro>\nSee @intro, and $x> 0$.";
  assert.equal(yolo.escapeForMarkdown(text, { escapeAngleBrackets: true, preserveCodeBlocks: true }), "\\<intro\\>\nSee @intro, and $x\\> 0$.");
  const c = setup(makeReal);
  typeText(c.view, "= Intro ");
  await settle(c.view);
  c.bridge.triggerNow(c.view);
  c.yolo!.respond(text);
  await sleep(0);
  press(c.view, "Tab");
  assert.equal(c.view.state.doc.toString(), "= Intro " + text);
  done(c);
});

test("X19 Backspace while YOLO generates deletes and re-arms", async () => {
  const c = setup(makeReal, { settings: triggerSettings({ idleTriggerEnabled: false }) });
  typeText(c.view, "x, y");
  await sleep(0);
  c.bridge.triggerNow(c.view);
  await sleep(0);
  assert.equal(snap(c).ai, "(generating)");
  press(c.view, "Backspace");
  await sleep(0);
  assert.deepEqual([c.view.state.doc.toString(), snap(c).ai, snap(c).armed], ["x, ", null, true]);
  done(c);
});
