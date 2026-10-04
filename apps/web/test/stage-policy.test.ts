import assert from "node:assert/strict";
import test from "node:test";
import { selectStage, type StageCandidate } from "../src/stage-policy.ts";

const context = { localId: "p0", mode: "meeting" as const, breakoutId: null };
const members = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `p${i}`,
    role: i === 0 ? ("host" as const) : ("participant" as const),
    status: "admitted",
    breakoutId: null,
  }));
const cameras = (count: number): StageCandidate[] =>
  Array.from({ length: count }, (_, i) => ({
    key: `p${i}:camera`,
    participantId: `p${i}`,
    source: "camera",
  }));

test("100-person meeting stays within 16 tiles on every page, keeps self visible and reaches every participant", () => {
  const people = members(100),
    tracks = cameras(100);
  const first = selectStage(tracks, people, context, 0);
  const seen = new Set<string>();
  for (let page = 0; page < first.pageCount; page++) {
    const selected = selectStage(tracks, people, context, page);
    assert(selected.visible.length <= 16);
    assert(selected.visible.some((track) => track.participantId === "p0"));
    for (const track of selected.visible) seen.add(track.key);
  }
  assert.equal(seen.size, 100);
  assert.deepEqual(
    selectStage([...tracks].reverse(), people, context, 2).visible,
    selectStage(tracks, people, context, 2).visible,
  );
});

test("1000 webinar viewers do not create video placeholders or consume presenter slots", () => {
  const stage = members(10);
  const audience = members(1000).map((member, i) => ({
    ...member,
    id: `viewer${i}`,
    role: "viewer" as const,
  }));
  const viewerTracks: StageCandidate[] = audience.map((member) => ({
    key: `${member.id}:camera`,
    participantId: member.id,
    source: "camera",
  }));
  const selected = selectStage(
    [...cameras(10), ...viewerTracks],
    [...stage, ...audience],
    { ...context, localId: "viewer0", mode: "webinar" },
    0,
  );
  assert.equal(selected.visible.length, 10);
  assert.equal(selected.eligibleIds.size, 10);
  assert(
    !selected.visible.some((track) => track.participantId.startsWith("viewer")),
  );
});

test("screen sharing gets bounded priority while overflow screens and cameras remain reachable", () => {
  const tracks: StageCandidate[] = [
    ...cameras(40),
    ...cameras(20).map((track) => ({
      ...track,
      key: track.key.replace("camera", "screen"),
      source: "screen_share" as const,
    })),
  ];
  const people = members(40);
  const first = selectStage(tracks, people, context, 0);
  assert(
    first.visible.slice(0, 2).every((track) => track.source === "screen_share"),
  );
  assert.equal(first.visible[2].participantId, "p0");
  const seen = new Set<string>();
  for (let page = 0; page < first.pageCount; page++) {
    const selected = selectStage(tracks, people, context, page);
    assert(selected.visible.length <= 16);
    assert.equal(
      new Set(selected.visible.map((track) => track.key)).size,
      selected.visible.length,
    );
    for (const track of selected.visible) seen.add(track.key);
  }
  assert.equal(seen.size, 60);
});

test("unknown, waiting, removed and other-room publishers are excluded; stale pages clamp after people leave", () => {
  const people = members(5).map((member, i) => ({
    ...member,
    status: i === 1 ? "waiting" : i === 2 ? "kicked" : "admitted",
    breakoutId: i === 3 ? "other-room" : null,
  }));
  const selected = selectStage(cameras(6), people, context, 99);
  assert.equal(selected.page, 0);
  assert.deepEqual(
    selected.visible.map((track) => track.participantId),
    ["p0", "p4"],
  );
  assert.equal(selectStage([], [], context, 0).pageCount, 1);
});
