import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeetingState, Participant, Reaction } from "../src/api.ts";
import {
  decodeReactionPacket,
  ReactionControl,
  ReactionFeed,
  ReactionStrip,
  reactionLabels,
  reactionsAllowed,
  REACTION_TOPIC,
} from "../src/reactions.tsx";

const participant = (id: string): Participant => ({
  id,
  name: id,
  role: "participant",
  status: "admitted",
  transport: "browser",
  audioAllowed: false,
  videoAllowed: false,
  screenShareAllowed: false,
  mediaVersion: 1,
  mediaIdentity: `media-${id}`,
  breakoutId: null,
});
const state = (): MeetingState => ({
  meeting: {
    code: "meeting",
    title: "Meeting",
    mode: "meeting",
    attendeeCount: 10,
    locked: false,
    ended: false,
    recordingAllowed: false,
    createdAt: "2026-10-10",
  },
  me: participant("self"),
  participants: [
    participant("self"),
    ...Array.from({ length: 9 }, (_, i) => participant(`guest-${i}`)),
  ],
  messages: [],
  recordings: [],
  revision: 1,
});
const reaction = (overrides: Partial<Reaction> = {}): Reaction => ({
  id: "reaction-1",
  participantId: "guest-0",
  mediaIdentity: "media-guest-0",
  mediaVersion: 1,
  kind: "like",
  scope: "",
  createdAt: 10000,
  expiresAt: 16000,
  ...overrides,
});

test("reactions merge live delivery and polls once without extending expiry or replaying replaced events", () => {
  const feed = new ReactionFeed(),
    s = state(),
    r = reaction();
  assert.equal(feed.update(s, 10000, [r], 1000).length, 1);
  assert.equal(feed.visible(s, 1000)[0]!.deadline, 7000);
  assert.equal(feed.update(s, 12000, [r], 3000).length, 0);
  assert.equal(feed.update(s, 11000, [r], 4000).length, 0);
  assert.equal(feed.visible(s, 6999).length, 1);
  assert.equal(feed.visible(s, 7000).length, 0);
  assert.equal(feed.update(s, 10000, [r], 8000).length, 0);
  const next = reaction({
    id: "reaction-2",
    kind: "love",
    createdAt: 18000,
    expiresAt: 24000,
  });
  assert.equal(feed.update(s, 18000, [next], 9000).length, 1);
  feed.update(s, 19000, [r], 10000);
  assert.equal(feed.visible(s, 10000)[0]!.id, "reaction-2");
});

test("reactions filter unknown, fenced, stale-generation, cross-room and hidden-viewer senders", () => {
  for (const change of [
    (s: MeetingState) => {
      s.participants = [];
    },
    (s: MeetingState) => {
      s.participants[1]!.enforcementPending = true;
    },
    (s: MeetingState) => {
      s.participants[1]!.mediaIdentity = "retired";
    },
    (s: MeetingState) => {
      s.participants[1]!.mediaVersion++;
    },
    (s: MeetingState) => {
      s.participants[1]!.breakoutId = "other";
    },
    (s: MeetingState) => {
      s.meeting.ended = true;
    },
    (s: MeetingState) => {
      s.meeting.mode = "webinar";
      s.me.role = "viewer";
      s.participants[1]!.role = "viewer";
    },
  ]) {
    const s = state(),
      feed = new ReactionFeed();
    change(s);
    assert.deepEqual(feed.update(s, 10000, [reaction()], 1000), []);
    assert.deepEqual(feed.visible(s, 1000), []);
  }
  const s = state(),
    feed = new ReactionFeed();
  feed.update(s, 10000, [reaction()], 1000);
  s.me.breakoutId = "other";
  assert.deepEqual(feed.visible(s, 1001), []);
  s.me.breakoutId = null;
  assert.deepEqual(feed.visible(s, 1002), []);
});

test("reaction strip is bounded and disappears when sender access changes", () => {
  const s = state(),
    feed = new ReactionFeed();
  const items = Array.from({ length: 9 }, (_, i) =>
    reaction({
      id: `reaction-${i}`,
      participantId: `guest-${i}`,
      mediaIdentity: `media-guest-${i}`,
      createdAt: 10000 + i,
      expiresAt: 16000 + i,
    }),
  );
  feed.update(s, 10009, items, 1000);
  assert.equal(feed.visible(s, 1000).length, 6);
  s.participants.forEach((p) => {
    p.status = "left";
  });
  assert.equal(feed.visible(s, 1000).length, 0);
});

test("reaction data accepts only finite server packets on the expected topic", () => {
  const packet = {
    version: 1,
    code: "meeting",
    reaction: reaction(),
    serverTime: 10000,
  };
  const encode = (p: unknown) => new TextEncoder().encode(JSON.stringify(p));
  assert.deepEqual(
    decodeReactionPacket(encode(packet), undefined, REACTION_TOPIC),
    packet,
  );
  assert.equal(
    decodeReactionPacket(
      encode(packet),
      { identity: "attacker" },
      REACTION_TOPIC,
    ),
    undefined,
  );
  assert.equal(
    decodeReactionPacket(encode(packet), undefined, "chat"),
    undefined,
  );
  assert.equal(
    decodeReactionPacket(new Uint8Array(2049), undefined, REACTION_TOPIC),
    undefined,
  );
  for (const r of [
    reaction({ kind: "<script>" as any }),
    reaction({ expiresAt: 20000 }),
    { ...reaction(), name: "forged" },
    reaction({ scope: "x".repeat(81) }),
  ])
    assert.equal(
      decodeReactionPacket(
        encode({ ...packet, reaction: r }),
        undefined,
        REACTION_TOPIC,
      ),
      undefined,
    );
  assert.equal(
    decodeReactionPacket(
      encode({ ...packet, serverTime: 16000 }),
      undefined,
      REACTION_TOPIC,
    ),
    undefined,
  );
});

test("reaction controls use plain labels and an independent muted-user action", () => {
  assert.deepEqual(Object.values(reactionLabels), [
    "Like",
    "Applause",
    "Love",
    "Laugh",
    "Surprised",
    "Celebrate",
  ]);
  const s = state();
  assert.equal(reactionsAllowed(s), true);
  const render = (disabled: boolean) =>
    renderToStaticMarkup(
      createElement(ReactionControl, {
        disabled,
        pending: false,
        cooldown: false,
        error: "",
        send: async () => {},
      }),
    );
  assert.match(
    render(false),
    /aria-label="Reactions"[^>]*aria-expanded="false"/,
  );
  assert.doesNotMatch(render(false), /disabled/);
  assert.match(render(true), /disabled/);
  const markup = renderToStaticMarkup(
    createElement(ReactionStrip, {
      items: [{ ...reaction(), name: "<Guest>", deadline: 16000 }],
      announcement: { id: "reaction-1", text: "Guest: Like" },
    }),
  );
  assert.match(markup, /&lt;Guest&gt;/);
  assert.match(markup, /aria-live="polite"/);
  assert.match(markup, /aria-hidden="true"/);
  s.me.mediaAllowed = false;
  assert.equal(reactionsAllowed(s), false);
});
