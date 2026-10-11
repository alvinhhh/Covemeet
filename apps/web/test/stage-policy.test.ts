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
    mediaIdentity: `p${i}`,
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
    assert(selected.visible.some((track) => track.mediaIdentity === "p0"));
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
    mediaIdentity: member.id,
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
    !selected.visible.some((track) => track.mediaIdentity.startsWith("viewer")),
  );
});

test("webinar tiles stay in the viewer's actual stage or backstage room", () => {
  const presenters = [
    {
      id: "host",
      role: "host" as const,
      status: "admitted",
      breakoutId: null,
      webinarBackstage: false,
    },
    {
      id: "presenter",
      role: "participant" as const,
      status: "admitted",
      breakoutId: null,
      webinarBackstage: true,
    },
  ];
  const tracks = ["host", "presenter"].map((id) => ({
    key: `${id}:camera`,
    mediaIdentity: id,
    source: "camera" as const,
  }));
  const base = { localId: "host", mode: "webinar" as const, breakoutId: null };
  assert.deepEqual(
    selectStage(tracks, presenters, { ...base, webinarBackstage: false }, 0)
      .visible.map((track) => track.mediaIdentity),
    ["host"],
  );
  assert.deepEqual(
    selectStage(tracks, presenters, { ...base, webinarBackstage: true }, 0)
      .visible.map((track) => track.mediaIdentity),
    ["presenter"],
  );
  assert.deepEqual(
    selectStage(
      tracks,
      [{ ...presenters[0]!, webinarBackstage: undefined }, presenters[1]!],
      { ...base, webinarBackstage: false },
      0,
    ).visible.map((track) => track.mediaIdentity),
    ["host"],
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
  assert.equal(first.visible[2].mediaIdentity, "p0");
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
    selected.visible.map((track) => track.mediaIdentity),
    ["p0", "p4"],
  );
  assert.equal(selectStage([], [], context, 0).pageCount, 1);
});

test("admitted phone callers retain audio eligibility without consuming video tiles", () => {
  const people = members(20).map((member, i) => ({
    ...member,
    transport: i >= 10 ? ("phone" as const) : ("browser" as const),
  }));
  const selected = selectStage(cameras(20), people, context, 0);
  assert.equal(selected.total, 10);
  assert.equal(selected.pageCount, 1);
  assert.equal(selected.eligibleIds.size, 20);
  for (const caller of people.slice(10)) {
    assert(selected.eligibleIds.has(caller.id));
    assert(
      !selected.visible.some((track) => track.mediaIdentity === caller.id),
    );
  }
});

test("phone transport does not bypass admission, room isolation, or webinar viewer policy", () => {
  const people = members(5).map((member, i) => ({
    ...member,
    transport: "phone" as const,
    status: i === 1 ? "waiting" : i === 2 ? "kicked" : "admitted",
    breakoutId: i === 3 ? "other-room" : null,
    role: i === 4 ? ("viewer" as const) : member.role,
  }));
  const selected = selectStage(
    cameras(5),
    people,
    { ...context, mode: "webinar" },
    0,
  );
  assert.deepEqual([...selected.eligibleIds], ["p0"]);
  assert.equal(selected.visible.length, 0);
});

test("current media identities preserve logical self and roles while retiring old publishers", () => {
  const people = [
    { ...members(1)[0], mediaIdentity: "host-current" },
    { ...members(2)[1], mediaIdentity: "guest-current" },
    {
      ...members(3)[2],
      mediaIdentity: "phone-current",
      transport: "phone" as const,
    },
    { ...members(4)[3] }, // Untouched legacy participant still uses its logical ID.
  ];
  const identities = [
    "host-current",
    "guest-current",
    "phone-current",
    "p3",
    "p0",
    "p1",
    "host-retired",
    "guest-retired",
  ];
  const tracks = identities.map((mediaIdentity) => ({
    key: `${mediaIdentity}:camera`,
    mediaIdentity,
    source: "camera" as const,
  }));
  const selected = selectStage(tracks, people, context, 0);
  assert.deepEqual(
    [...selected.eligibleIds],
    ["host-current", "guest-current", "phone-current", "p3"],
  );
  assert.deepEqual(
    selected.visible.map((track) => track.mediaIdentity),
    ["host-current", "guest-current", "p3"],
  );
  assert.equal(selected.visible[0].mediaIdentity, "host-current");
  const next = selectStage(
    tracks,
    people.map((member) =>
      member.id === "p1" ? { ...member, mediaIdentity: "guest-next" } : member,
    ),
    context,
    0,
  );
  assert(!next.eligibleIds.has("guest-current"));
  assert(
    !next.visible.some((track) => track.mediaIdentity === "guest-current"),
  );
});

test("a local pin stays on every bounded page after shared screens without duplicating self", () => {
  const people = members(40);
  const tracks: StageCandidate[] = [
    ...cameras(40),
    ...cameras(3).map((track) => ({
      ...track,
      key: `${track.mediaIdentity}:screen`,
      source: "screen_share" as const,
    })),
  ];
  const view = { pinnedParticipantId: "p39" };
  const first = selectStage(tracks, people, context, 0, view);
  const seen = new Set<string>();
  for (let page = 0; page < first.pageCount; page++) {
    const selected = selectStage(tracks, people, context, page, view);
    assert(selected.visible.length <= 16);
    assert(
      selected.visible
        .slice(0, 2)
        .every((track) => track.source === "screen_share"),
    );
    assert.equal(selected.visible[2].mediaIdentity, "p39");
    assert.equal(selected.visible[3].mediaIdentity, "p0");
    assert.equal(selected.pinnedParticipantId, "p39");
    assert.equal(
      new Set(selected.visible.map((track) => track.key)).size,
      selected.visible.length,
    );
    for (const track of selected.visible) seen.add(track.key);
  }
  assert.equal(seen.size, tracks.length);
  const selfPin = selectStage(tracks, people, context, 0, {
    pinnedParticipantId: "p0",
  });
  assert.equal(
    selfPin.visible.filter((track) => track.key === "p0:camera").length,
    1,
  );
  assert.deepEqual(
    selectStage(tracks, people, context, 0, { pinnedParticipantId: null }),
    selectStage(tracks, people, context, 0),
  );
});

test("hiding self removes only the local camera, keeps local screen and audio eligibility, and can be reversed", () => {
  const people = members(3).map((member, i) => ({
    ...member,
    mediaIdentity: `current${i}`,
  }));
  const tracks: StageCandidate[] = [
    ...cameras(3).map((track, i) => ({
      ...track,
      mediaIdentity: `current${i}`,
    })),
    { key: "self-screen", mediaIdentity: "current0", source: "screen_share" },
  ];
  const normal = selectStage(tracks, people, context, 0);
  const hidden = selectStage(tracks, people, context, 0, {
    hideSelfView: true,
    pinnedParticipantId: "p0",
  });
  assert.deepEqual(hidden.eligibleIds, normal.eligibleIds);
  assert.equal(hidden.selfViewAvailable, true);
  assert.equal(hidden.pinnedParticipantId, null);
  assert(hidden.visible.some((track) => track.key === "self-screen"));
  assert(
    !hidden.visible.some(
      (track) =>
        track.source === "camera" && track.mediaIdentity === "current0",
    ),
  );
  assert.equal(hidden.total, normal.total - 1);
  assert.deepEqual(
    selectStage(tracks, people, context, 0, { hideSelfView: false }),
    normal,
  );
  assert.equal(tracks.length, 4);
});

test("pins follow current identities without admitting retired, other-room, waiting, viewer, or phone tiles", () => {
  const people = members(6).map((member, i) => ({
    ...member,
    mediaIdentity: i === 1 ? "guest-current" : member.id,
    status: i === 2 ? "waiting" : member.status,
    breakoutId: i === 3 ? "other-room" : null,
    role: i === 4 ? ("viewer" as const) : member.role,
    transport: i === 5 ? ("phone" as const) : ("browser" as const),
  }));
  const tracks: StageCandidate[] = [
    ...cameras(7),
    { key: "guest-camera", mediaIdentity: "guest-current", source: "camera" },
  ];
  const webinar = {
    ...context,
    mode: "webinar" as const,
    webinarBackstage: false,
  };
  const pinned = selectStage(tracks, people, webinar, 0, {
    pinnedParticipantId: "p1",
  });
  assert.equal(pinned.visible[0].mediaIdentity, "guest-current");
  assert(!pinned.visible.some((track) => track.mediaIdentity === "p1"));
  for (const id of ["p2", "p3", "p4", "p5", "p6"]) {
    const selected = selectStage(tracks, people, webinar, 0, {
      pinnedParticipantId: id,
    });
    assert.equal(selected.pinnedParticipantId, null);
    assert.deepEqual(
      selected.visible.map((track) => track.mediaIdentity),
      ["p0", "guest-current"],
    );
  }
  const removed = selectStage(
    tracks,
    people.filter((member) => member.id !== "p1"),
    webinar,
    99,
    { pinnedParticipantId: "p1" },
  );
  assert.equal(removed.pinnedParticipantId, null);
  assert.equal(removed.page, 0);
  assert.deepEqual(
    removed.visible.map((track) => track.mediaIdentity),
    ["p0"],
  );
  assert.equal(
    selectStage(tracks, people, { ...webinar, localId: "p4" }, 0)
      .selfViewAvailable,
    false,
  );
});

test("speaker layout keeps an off-page speaker visible within the tile budget; gallery keeps its existing page", () => {
  const people = members(100),
    tracks = cameras(100);
  const speaking = { ...context, speakingIds: ["p99"] };
  assert.deepEqual(
    selectStage(tracks, people, speaking, 2).visible,
    selectStage(tracks, people, context, 2).visible,
  );
  assert.equal(selectStage(tracks, people, speaking, 2).speakerKey, undefined);
  const view = { layout: "speaker" as const };
  const first = selectStage(tracks, people, speaking, 0, view);
  const seen = new Set<string>();
  for (let page = 0; page < first.pageCount; page++) {
    const selected = selectStage(tracks, people, speaking, page, view);
    assert.equal(selected.speakerKey, "p99:camera");
    assert.equal(selected.visible[0].mediaIdentity, "p99");
    assert(selected.visible.some((track) => track.mediaIdentity === "p0"));
    assert(selected.visible.length <= 16);
    assert.equal(
      new Set(selected.visible.map((track) => track.key)).size,
      selected.visible.length,
    );
    for (const track of selected.visible) seen.add(track.key);
  }
  assert.equal(seen.size, 100);
});

test("speaker selection stays through silence and overlapping speech, then follows the next speaker", () => {
  const view = { layout: "speaker" as const };
  const select = (speakingIds: string[], speakerIdentity: string | null) =>
    selectStage(
      cameras(4),
      members(4),
      { ...context, speakingIds, speakerIdentity },
      0,
      view,
    );
  assert.equal(select([], null).speakerIdentity, "p1");
  assert.equal(select(["p3"], "p1").speakerIdentity, "p3");
  assert.equal(select([], "p3").speakerIdentity, "p3");
  assert.equal(select(["p2", "p3"], "p3").speakerIdentity, "p3");
  assert.equal(select(["p2"], "p3").speakerIdentity, "p2");
});

test("both layouts preserve an explicit pin and screen priority while speaker mode respects hidden self", () => {
  const tracks: StageCandidate[] = [
    ...cameras(40),
    { key: "screen", mediaIdentity: "p1", source: "screen_share" },
  ];
  for (const layout of ["gallery", "speaker"] as const) {
    const selected = selectStage(
      tracks,
      members(40),
      { ...context, speakingIds: ["p38"] },
      2,
      { layout, pinnedParticipantId: "p39", hideSelfView: true },
    );
    assert.equal(selected.visible[0].key, "screen");
    assert.equal(selected.visible[1].key, "p39:camera");
    assert.equal(selected.pinnedParticipantId, "p39");
    assert.equal(
      selected.speakerKey,
      layout === "speaker" ? "p39:camera" : undefined,
    );
    assert(!selected.visible.some((track) => track.mediaIdentity === "p0"));
    assert(selected.visible.length <= 16);
  }
  const hidden = selectStage(
    cameras(2),
    members(2),
    { ...context, speakingIds: ["p0"], speakerIdentity: "p0" },
    0,
    { layout: "speaker", hideSelfView: true },
  );
  assert.equal(hidden.speakerKey, "p1:camera");
});

test("speaker selection cannot retain retired, other-room, waiting, phone or backstage identities", () => {
  const people = members(7).map((member, i) => ({
    ...member,
    mediaIdentity: i === 1 ? "current" : member.id,
    breakoutId: i === 2 ? "other-room" : null,
    status: i === 3 ? "waiting" : member.status,
    transport: i === 4 ? ("phone" as const) : ("browser" as const),
    webinarBackstage: i === 5,
    role: i === 6 ? ("viewer" as const) : member.role,
  }));
  const tracks: StageCandidate[] = [
    ...cameras(7),
    { key: "current:camera", mediaIdentity: "current", source: "camera" },
  ];
  for (const invalid of ["p1", "p2", "p3", "p4", "p5", "p6", "unknown"]) {
    const selected = selectStage(
      tracks,
      people,
      {
        ...context,
        mode: "webinar",
        webinarBackstage: false,
        speakerIdentity: invalid,
        speakingIds: [invalid],
      },
      0,
      { layout: "speaker" },
    );
    assert.equal(selected.speakerIdentity, "current");
    assert.equal(selected.speakerKey, "current:camera");
    assert(!selected.visible.some((track) => track.mediaIdentity === invalid));
  }
  const empty = selectStage([], [], context, 0, { layout: "speaker" });
  assert.equal(empty.speakerIdentity, null);
  assert.equal(empty.speakerKey, undefined);
  assert.equal(empty.pageCount, 1);
});
