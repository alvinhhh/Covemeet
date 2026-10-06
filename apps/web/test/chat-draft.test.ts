import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeetingState, Participant } from "../src/api.ts";
import { Chat } from "../src/chat.tsx";

const host: Participant = {
  id: "host",
  name: "Host",
  role: "host",
  status: "admitted",
  audioAllowed: true,
  videoAllowed: true,
  mediaVersion: 1,
  breakoutId: null,
  transport: "browser",
};
const guest: Participant = {
  ...host,
  id: "guest",
  name: "Guest",
  role: "participant",
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
  participants: [host, guest],
  messages: [],
  recordings: [],
  revision: 1,
};
const props: ComponentProps<typeof Chat> = {
  state,
  text: "Unsent message\nSecond line",
  setText: () => {},
  send: async () => true,
  busy: false,
  recipient: "everyone",
  setRecipient: () => {},
  setMode: async () => true,
  remove: async () => true,
};
const render = (overrides: Partial<typeof props> = {}) =>
  renderToStaticMarkup(createElement(Chat, { ...props, ...overrides }));

test("chat displays its retained draft on every fresh mount", () => {
  assert.match(
    render(),
    /<textarea[^>]*>Unsent message\nSecond line<\/textarea>/,
  );
  assert.match(
    render(),
    /<textarea[^>]*>Unsent message\nSecond line<\/textarea>/,
  );
  assert.match(render({ text: "" }), /<textarea[^>]*><\/textarea>/);
});

test("chat sender controls are host-only and disabled modes retain the draft", () => {
  assert.doesNotMatch(render(), /Who can send/);
  const restricted: MeetingState = {
    ...state,
    meeting: { ...state.meeting, chatMode: "host-only" },
  };
  const guestMarkup = render({ state: restricted });
  assert.match(guestMarkup, /Only the host can send messages/);
  assert.match(guestMarkup, /<textarea[^>]*disabled=""[^>]*>Unsent message/);
  assert.match(guestMarkup, /<button[^>]*type="submit"[^>]*disabled=""/);
  const hostMarkup = render({ state: { ...restricted, me: host } });
  assert.match(hostMarkup, /Who can send/);
  assert.match(hostMarkup, /aria-pressed="true"[^>]*>Host only/);
  assert.doesNotMatch(hostMarkup, /<textarea[^>]*disabled/);
  assert.match(
    render({
      state: {
        ...restricted,
        me: host,
        meeting: { ...restricted.meeting, chatMode: "disabled" },
      },
    }),
    /Chat is off/,
  );
});

test("private chat labels identify the recipient and only hosts can reply or remove", () => {
  const privateState: MeetingState = {
    ...state,
    messages: [
      {
        id: "message",
        senderId: guest.id,
        recipientId: host.id,
        name: guest.name,
        text: "Private question",
        createdAt: "2026-10-06T00:00:00Z",
      },
    ],
  };
  const guestMarkup = render({ state: privateState, recipient: "host" });
  assert.match(guestMarkup, /Private to host/);
  assert.match(guestMarkup, /placeholder="Message host"/);
  assert.doesNotMatch(guestMarkup, /Reply privately|>Remove</);
  const hostMarkup = render({
    state: { ...privateState, me: host },
    recipient: guest.id,
  });
  assert.match(hostMarkup, /Private to you/);
  assert.match(hostMarkup, /Reply privately/);
  assert.match(hostMarkup, />Remove</);
  assert.match(hostMarkup, /Guest · Private/);
  assert.match(hostMarkup, /placeholder="Message Guest"/);
  assert.match(
    render({
      state: { ...privateState, me: host, participants: [host] },
      recipient: guest.id,
    }),
    /Recipient unavailable/,
  );
});

test("removed message slots show a tombstone without their old text or actions", () => {
  const markup = render({
    state: {
      ...state,
      me: host,
      messages: [
        {
          id: "removed",
          senderId: guest.id,
          name: guest.name,
          text: "Never display removed text",
          deleted: true,
          createdAt: "2026-10-06T00:00:00Z",
        },
      ],
    },
  });
  assert.match(markup, /Message removed/);
  assert.doesNotMatch(
    markup,
    /Never display removed text|Reply privately|>Remove</,
  );
});
