import assert from "node:assert/strict";
import test from "node:test";
import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomContext } from "@livekit/components-react";
import { Room } from "livekit-client";
import { MediaControls } from "../src/media-controls.tsx";
import { MeetingTools } from "../src/meeting-tools.tsx";
import type { Participant } from "../src/api.ts";

const me: Participant = {
  id: "participant",
  name: "Participant",
  role: "participant",
  status: "admitted",
  transport: "browser",
  audioAllowed: true,
  videoAllowed: true,
  screenShareAllowed: true,
  mediaVersion: 1,
  breakoutId: null,
};
function media(participant: Participant) {
  return renderToStaticMarkup(
    createElement(
      RoomContext.Provider,
      { value: new Room() },
      createElement(MediaControls, {
        me: participant,
        deviceTarget: null,
        inputDevices: {
          microphoneId: "mic-choice",
          cameraId: "camera-choice",
          speakerId: "speaker-choice",
        },
        setInputDevices() {
          assert.fail("Rendering must not change devices");
        },
        cameraChanged() {
          assert.fail("Rendering must not publish a camera");
        },
      }),
    ),
  );
}

test("primary controls retain independent host and viewer media restrictions", () => {
  const allowed = media(me);
  assert.equal((allowed.match(/<fieldset/g) ?? []).length, 3);
  assert.doesNotMatch(allowed, /<fieldset[^>]*disabled/);
  const microphoneBlocked = media({ ...me, audioAllowed: false });
  assert.equal(
    (microphoneBlocked.match(/<fieldset[^>]*disabled/g) ?? []).length,
    1,
  );
  const viewer = media({ ...me, role: "viewer", screenShareAllowed: false });
  assert.equal((viewer.match(/<fieldset[^>]*disabled/g) ?? []).length, 3);
});

test("More keeps its content mounted and exposes a disclosure and notification status", () => {
  const markup = renderToStaticMarkup(
    createElement(MeetingTools, {
      buttonRef: createRef<HTMLButtonElement>(),
      notifications: "2 unread chat messages. 1 waiting to join",
      children: () =>
        createElement(
          "select",
          { "aria-label": "Speaker" },
          createElement("option", null, "Default speaker"),
        ),
    }),
  );
  assert.match(
    markup,
    /aria-label="More"[^>]*aria-expanded="false"[^>]*aria-controls=/,
  );
  assert.match(markup, /role="group" aria-label="Meeting tools" hidden=""/);
  assert.match(markup, /<select aria-label="Speaker"/);
  assert.match(
    markup,
    /role="status"[^>]*>2 unread chat messages\. 1 waiting to join/,
  );
  assert.doesNotMatch(markup, /role="menu/);
});
