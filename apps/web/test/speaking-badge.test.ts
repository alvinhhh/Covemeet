import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AudioSignal } from "../src/audio-signal.js";
import { SpeakingBadge } from "../src/speaking-badge.js";

test("speaking cues keep a compact slot, label the speaker and show measured levels", () => {
  const quiet: AudioSignal = {
    microphoneOn: true,
    speaking: false,
    level: 0,
    bars: 0,
  };
  const cue = (surface: "tile" | "list" | "dock", signal?: AudioSignal) =>
    renderToStaticMarkup(
      createElement(SpeakingBadge, { surface, signal, name: "Alex" }),
    );
  assert.match(cue("tile"), /aria-label="Alex: Microphone off"/);
  assert.match(cue("tile", quiet), /aria-label="Alex: Microphone on"/);
  for (const surface of ["tile", "list", "dock"] as const) {
    assert.match(
      cue(surface, quiet),
      new RegExp(`class="speaking-badge ${surface}"`),
    );
    const speaking = cue(surface, {
      ...quiet,
      speaking: true,
      level: 0.2,
      bars: 2,
    });
    assert.match(speaking, /aria-label="Alex: Speaking"/);
    assert.equal((speaking.match(/<i class="active"/g) ?? []).length, 2);
    assert.equal((speaking.match(/<i /g) ?? []).length, 4);
    assert.doesNotMatch(speaking, />Speaking<|role="status"/);
  }
  assert.match(cue("list", quiet), /aria-hidden="true"/);
  assert.match(cue("dock", quiet), /aria-hidden="true"/);
});
