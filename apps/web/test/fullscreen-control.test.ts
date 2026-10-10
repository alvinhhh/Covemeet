import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  FullscreenControl,
  observeFullscreen,
  toggleFullscreen,
} from "../src/fullscreen-control.tsx";

function fullscreenFixture() {
  const doc = Object.assign(new EventTarget(), {
    fullscreenEnabled: true,
    fullscreenElement: null as HTMLElement | null,
    async exitFullscreen() {
      this.fullscreenElement = null;
      this.dispatchEvent(new Event("fullscreenchange"));
    },
  });
  const target = {
    ownerDocument: doc,
    async requestFullscreen() {
      doc.fullscreenElement = target;
      doc.dispatchEvent(new Event("fullscreenchange"));
    },
  } as unknown as HTMLElement;
  return { doc, target };
}

test("fullscreen follows browser state for entry, exit, Escape, and unrelated elements", async () => {
  const { doc, target } = fullscreenFixture();
  const states: { active: boolean; supported: boolean }[] = [];
  const stop = observeFullscreen(target, (state) => states.push(state));
  assert.deepEqual(states.at(-1), { active: false, supported: true });
  await toggleFullscreen(target);
  assert.equal(doc.fullscreenElement, target);
  assert.equal(states.at(-1)?.active, true);
  await toggleFullscreen(target);
  assert.equal(doc.fullscreenElement, null);
  await toggleFullscreen(target);
  // Escape changes the browser's fullscreen element without calling the control.
  doc.fullscreenElement = null;
  doc.dispatchEvent(new Event("fullscreenchange"));
  assert.equal(states.at(-1)?.active, false);
  doc.fullscreenElement = {} as HTMLElement;
  doc.dispatchEvent(new Event("fullscreenchange"));
  assert.equal(states.at(-1)?.active, false);
  await toggleFullscreen(target);
  assert.equal(doc.fullscreenElement, target);
  stop();
  const count = states.length;
  await toggleFullscreen(target);
  assert.equal(states.length, count);
});

test("unsupported and denied fullscreen never report entry", async () => {
  const { doc, target } = fullscreenFixture();
  doc.fullscreenEnabled = false;
  let state = { active: false, supported: true };
  const stop = observeFullscreen(target, (next) => {
    state = next;
  });
  assert.deepEqual(state, { active: false, supported: false });
  const denied = new Error("Denied");
  target.requestFullscreen = async () => {
    throw denied;
  };
  await assert.rejects(toggleFullscreen(target), denied);
  assert.equal(state.active, false);
  assert.equal(doc.fullscreenElement, null);
  stop();
});

test("fullscreen control has an accessible action before browser capability detection", () => {
  const markup = renderToStaticMarkup(
    createElement(FullscreenControl, { target: { current: null } }),
  );
  assert.match(markup, /aria-label="Enter fullscreen"/);
  assert.match(
    markup,
    /title="Fullscreen is unavailable in this browser" disabled=""/,
  );
  assert.doesNotMatch(markup, /role="alert"/);
});
