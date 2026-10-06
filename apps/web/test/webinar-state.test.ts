import assert from "node:assert/strict";
import test from "node:test";
import {
  participantMediaAllowed,
  participantRoomScope,
} from "../src/webinar-state.ts";

test("webinar backstage has a distinct chat and whiteboard scope", () => {
  const backstage = { breakoutId: null, webinarBackstage: true };
  assert.equal(participantRoomScope("webinar", backstage), "webinar:backstage");
  assert.equal(
    participantRoomScope("webinar", { ...backstage, webinarBackstage: false }),
    "main",
  );
  assert.equal(participantRoomScope("meeting", backstage), "main");
  assert.equal(
    participantRoomScope("webinar", {
      ...backstage,
      breakoutId: "room-1",
    }),
    "breakout:room-1",
  );
});

test("the audience has no media until the server permits it", () => {
  assert.equal(participantMediaAllowed({ mediaAllowed: false }), false);
  assert.equal(
    participantMediaAllowed({ mediaAllowed: true, enforcementPending: true }),
    false,
  );
  assert.equal(participantMediaAllowed({ mediaAllowed: true }), true);
  assert.equal(participantMediaAllowed({}), true);
});
