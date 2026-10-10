import assert from "node:assert/strict";
import test from "node:test";
import { cameraIntentFor, rememberCameraChoice } from "../src/camera-intent.ts";

const participant = {
  id: "guest",
  role: "participant" as const,
  status: "admitted" as const,
  videoAllowed: true,
  mediaVersion: 1,
};
const scope = "meeting:main";

test("camera starts off and remembers only successful explicit user changes", () => {
  const initial = cameraIntentFor(participant, scope, 0);
  assert.equal(initial.enabled, false);
  assert.equal(rememberCameraChoice(initial, initial, true, false), initial);
  const on = rememberCameraChoice(initial, initial, true, true);
  assert.equal(on.enabled, true);
  assert.equal(cameraIntentFor(participant, scope, 0, on), on);
  assert.equal(rememberCameraChoice(on, on, false, false), on);
  const off = rememberCameraChoice(on, on, false, true);
  assert.equal(off.enabled, false);
  assert.equal(
    cameraIntentFor({ ...participant, mediaVersion: 2 }, scope, 0, off).enabled,
    false,
  );
});

test("camera intent survives same-room moderation and reconnect but rejects old connection callbacks", () => {
  const initial = cameraIntentFor(participant, scope, 0);
  const on = rememberCameraChoice(initial, initial, true, true);
  const next = cameraIntentFor(
    { ...participant, mediaVersion: 2 },
    scope,
    0,
    on,
  );
  assert.equal(next.enabled, true);
  assert.equal(rememberCameraChoice(next, on, false, true), next);
  const reconnect = cameraIntentFor(
    { ...participant, mediaVersion: 2 },
    scope,
    1,
    next,
  );
  assert.equal(reconnect.enabled, true);
  const off = rememberCameraChoice(reconnect, reconnect, false, true);
  assert.equal(rememberCameraChoice(off, next, true, true), off);
  assert.equal(rememberCameraChoice(off, initial, true, true), off);
});

test("camera permission, participant, role and room changes clear intent without restoring it on return", () => {
  const initial = cameraIntentFor(participant, scope, 0);
  const on = rememberCameraChoice(initial, initial, true, true);
  for (const changed of [
    { ...participant, videoAllowed: false },
    { ...participant, role: "viewer" as const },
    { ...participant, status: "left" as const },
    { ...participant, id: "another-guest" },
  ]) {
    const cleared = cameraIntentFor(changed, scope, 0, on);
    assert.equal(cleared.enabled, false);
    assert.equal(rememberCameraChoice(cleared, on, true, true), cleared);
    const returned = cameraIntentFor(participant, scope, 0, cleared);
    assert.equal(returned.enabled, false);
    assert.equal(rememberCameraChoice(returned, on, true, true), returned);
  }
  for (const nextScope of [
    "meeting:breakout:1",
    "meeting:webinar:backstage",
    "other-meeting:main",
  ]) {
    const cleared = cameraIntentFor(participant, nextScope, 0, on);
    assert.equal(cleared.enabled, false);
    assert.equal(rememberCameraChoice(cleared, on, true, true), cleared);
    const returned = cameraIntentFor(participant, scope, 0, cleared);
    assert.equal(returned.enabled, false);
    assert.equal(rememberCameraChoice(returned, on, true, true), returned);
  }
});

test("a consent epoch change clears camera intent even when intermediate server states were missed", () => {
  const initial = cameraIntentFor(participant, scope, 0);
  const on = rememberCameraChoice(initial, initial, true, true);
  for (const cameraConsentVersion of [1, 2, 4]) {
    const current = cameraIntentFor(
      { ...participant, mediaVersion: 2, cameraConsentVersion },
      scope,
      0,
      on,
    );
    assert.equal(current.enabled, false);
    assert.equal(rememberCameraChoice(current, on, true, true), current);
    const later = cameraIntentFor(
      { ...participant, mediaVersion: 3, cameraConsentVersion },
      scope,
      0,
      current,
    );
    assert.equal(later.enabled, false);
  }
});
