import assert from "node:assert/strict";
import test from "node:test";
import { publish } from "./rtc-fixture.mjs";

test("invalid PCM amplitudes reject before creating media", async () => {
  for (const amplitude of [0, -1, 16001, 1.5, NaN, Infinity, "8000", null]) {
    await assert.rejects(
      publish(null, 440, amplitude),
      /Invalid synthetic PCM amplitude/,
    );
  }
});
