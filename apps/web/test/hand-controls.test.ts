import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeetingState, Participant } from "../src/api.ts";
import {
  admittedWithHandsFirst,
  applyHandUpdate,
  HandControl,
  handRaised,
  newestMeetingState,
} from "../src/hand-controls.tsx";

const guest: Participant = {
  id: "guest",
  name: "Guest",
  role: "participant",
  status: "admitted",
  audioAllowed: false,
  videoAllowed: false,
  screenShareAllowed: false,
  mediaVersion: 1,
  breakoutId: null,
  transport: "browser",
  handRaised: false,
};
const state: MeetingState = {
  meeting: {
    code: "meeting",
    title: "Meeting",
    mode: "meeting",
    locked: false,
    ended: false,
    recordingAllowed: false,
    createdAt: "2026-10-06T00:00:00Z",
  },
  me: guest,
  participants: [guest, { ...guest, id: "other" }],
  messages: [],
  recordings: [],
  revision: 3,
};

test("raise hand is available without media access; pending and inactive sessions cannot submit", () => {
  const props = {
    me: guest,
    ended: false,
    busy: false,
    pending: false,
    onChange: (_raised: boolean) => {},
  };
  const render = (overrides: Partial<typeof props> = {}) =>
    renderToStaticMarkup(
      createElement(HandControl, { ...props, ...overrides }),
    );
  assert.match(render(), /aria-label="Raise hand"[^>]*aria-pressed="false"/);
  assert.doesNotMatch(render(), /disabled/);
  assert.doesNotMatch(
    render({ me: { ...guest, role: "viewer", mediaAllowed: false } }),
    /disabled/,
  );
  assert.match(
    render({ me: { ...guest, handRaised: true } }),
    /aria-label="Lower hand"[^>]*aria-pressed="true"/,
  );
  assert.match(render({ pending: true }), /aria-busy="true"[^>]*disabled/);
  assert.match(render({ pending: true }), /Raising…/);
  assert.match(
    render({ pending: true, me: { ...guest, handRaised: true } }),
    /Lowering…/,
  );
  for (const overrides of [
    { busy: true },
    { ended: true },
    { me: { ...guest, enforcementPending: true } },
    ...(["waiting", "left", "kicked", "banned"] as const).map((status) => ({
      me: { ...guest, status },
    })),
  ])
    assert.match(render(overrides), /disabled/);
  const changes: boolean[] = [];
  for (const raised of [false, true]) {
    HandControl({
      ...props,
      me: { ...guest, handRaised: raised },
      onChange: (next) => changes.push(next),
    }).props.onClick();
  }
  assert.deepEqual(changes, [true, false]);
});

test("raised browser and phone participants sort first without changing waiting or source order", () => {
  const phone: Participant = {
    ...guest,
    id: "phone",
    transport: "phone",
    handRaised: undefined,
    phone: { muted: true, handRaised: true, canBanCallerId: false },
  };
  const people = [
    guest,
    { ...guest, id: "waiting", status: "waiting" as const, handRaised: true },
    phone,
    { ...guest, id: "raised", handRaised: true },
    { ...guest, id: "other" },
    { ...guest, id: "left", status: "left" as const, handRaised: true },
  ];
  const original = people.map((person) => person.id);
  assert.deepEqual(
    admittedWithHandsFirst(people).map((person) => person.id),
    ["phone", "raised", "guest", "other"],
  );
  assert.deepEqual(
    people.map((person) => person.id),
    original,
  );
  assert.equal(handRaised(phone), true);
  assert.equal(handRaised({ ...phone, handRaised: false }), false);
  assert.equal(handRaised({ ...guest, handRaised: undefined }), false);
});

test("successful hand responses update self and roster immediately without replacing newer state", () => {
  const raised = applyHandUpdate(state, state, guest.id, {
    handRaised: true,
    revision: 4,
  });
  assert.equal(raised.me.handRaised, true);
  assert.equal(raised.participants[0].handRaised, true);
  assert.equal(raised.participants[1], state.participants[1]);
  assert.equal(raised.revision, 4);
  assert.equal(state.me.handRaised, false);
  const moderated = applyHandUpdate(raised, raised, guest.id, {
    handRaised: false,
    revision: 5,
  });
  assert.equal(moderated.me.handRaised, false);
  assert.equal(
    applyHandUpdate(moderated, state, guest.id, {
      handRaised: true,
      revision: 4,
    }),
    moderated,
  );
  const other = applyHandUpdate(raised, raised, "other", {
    handRaised: true,
    revision: 5,
  });
  assert.equal(other.me, raised.me);
  assert.equal(other.participants[1].handRaised, true);
  for (const next of [
    { ...state, meeting: { ...state.meeting, code: "other-meeting" } },
    { ...state, me: { ...guest, id: "new-session" } },
  ]) {
    assert.equal(
      applyHandUpdate(next, state, guest.id, { handRaised: true, revision: 9 }),
      next,
    );
    assert.equal(newestMeetingState(moderated, next), next);
  }
  assert.equal(newestMeetingState(moderated, state), moderated);
  assert.equal(newestMeetingState(undefined, state), state);
  const equalRevision = {
    ...moderated,
    meeting: { ...state.meeting, locked: true },
  };
  assert.equal(newestMeetingState(moderated, equalRevision), equalRevision);
});
