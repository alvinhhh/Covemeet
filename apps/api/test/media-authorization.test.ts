import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { AccessToken, ServerError } from "livekit-server-sdk";
import { loadConfig } from "../src/config.js";
import { LiveMedia } from "../src/media.js";
import { createApp } from "../src/server.js";
import {
  completeMediaFence,
  fenceParticipantMedia,
  mediaIdentity,
} from "../src/media-identity.js";
import type { WebSocket } from "ws";
import { MemoryStore, type Meeting, type Participant } from "../src/store.js";
import { digest } from "../src/security.js";

async function fixture(t: TestContext) {
  const config = loadConfig({
    SESSION_SECRET: "test-media-session-secret-over-32-characters",
    LIVEKIT_API_KEY: "test-media-key",
    LIVEKIT_API_SECRET: "test-media-signing-secret-over-32-characters",
  });
  const store = new MemoryStore();
  const participant: Participant = {
    id: randomUUID(),
    name: "Guest",
    role: "participant",
    status: "admitted",
    audioAllowed: true,
    videoAllowed: true,
    mediaVersion: 1,
    tokenHash: "unused",
    expiresAt: Date.now() + 3_600_000,
    ipHash: "",
    deviceHash: "",
    breakoutId: null,
  };
  const meeting: Meeting = {
    id: randomUUID(),
    code: "MEDIATOKENAUTHORIZATIONTEST",
    room: `m_${randomUUID()}`,
    title: "Media authorization",
    mode: "meeting",
    locked: false,
    ended: false,
    recordingAllowed: false,
    createdAt: Date.now(),
    revision: 1,
    passwordHash: "unused",
    hostTokenExpiresAt: 0,
    participants: [participant],
    bans: { ip: [], device: [] },
    breakouts: [],
    messages: [],
    recordings: [],
  };
  await store.create(meeting);
  const media = new LiveMedia(config, store);
  t.after(() => media.close());
  async function signed({
    room = meeting.room,
    identity = participant.id,
    version = participant.mediaVersion,
    ttl = 120,
    key = config.livekitKey,
    secret = config.livekitSecret,
  } = {}) {
    const token = new AccessToken(key, secret, {
      identity,
      ttl,
      metadata: JSON.stringify({ code: meeting.code, v: version }),
    });
    token.addGrant({ room, roomJoin: true, canSubscribe: true });
    return token.toJwt();
  }
  return { config, store, media, meeting, participant, signed };
}

test("media admission verifies a real signed token against current application state", async (t) => {
  const f = await fixture(t);
  const token = await f.media.token(f.meeting, f.participant);
  const admitted = await f.media.authorize(token);
  assert.equal(admitted.m.code, f.meeting.code);
  assert.equal(admitted.p.id, f.participant.id);
  await assert.rejects(f.media.authorize(`${token.slice(0, -10)}invalidtag`));
  await assert.rejects(
    f.media.authorize(
      await f.signed({
        secret: "untrusted-server-signing-secret-over-32-characters",
      }),
    ),
  );
  await assert.rejects(f.media.authorize(await f.signed({ ttl: -3600 })));
});

test("media token claims deny data publishing, metadata changes, and blocked track sources", async (t) => {
  const f = await fixture(t);
  const inspect = async (p: Participant) =>
    f.media.verifier.verify(await f.media.token(f.meeting, p));
  const full = await inspect(f.participant);
  assert.equal(full.video?.canPublishData, false);
  assert.equal(full.video?.canUpdateOwnMetadata, false);
  assert.equal(full.video?.canSubscribe, true);
  const audio = await inspect({ ...f.participant, videoAllowed: false });
  assert.deepEqual(audio.video?.canPublishSources, ["microphone"]);
  const video = await inspect({ ...f.participant, audioAllowed: false });
  assert.deepEqual(video.video?.canPublishSources, ["camera", "screen_share"]);
  const viewer = await inspect({
    ...f.participant,
    role: "viewer",
    audioAllowed: false,
    videoAllowed: false,
  });
  assert.equal(viewer.video?.canPublish, false);
  assert.deepEqual(viewer.video?.canPublishSources, []);
  const inconsistentViewer = await inspect({
    ...f.participant,
    role: "viewer",
  });
  assert.equal(inconsistentViewer.video?.canPublish, false);
  assert.deepEqual(inconsistentViewer.video?.canPublishSources, []);
});

test("kick, ban, lobby, expired session, and pending enforcement all deny existing tokens", async (t) => {
  const f = await fixture(t);
  const token = await f.media.token(f.meeting, f.participant);
  for (const status of ["waiting", "kicked", "banned", "left"] as const) {
    await f.store.change(f.meeting.code, (m) => {
      m.participants[0]!.status = status;
    });
    await assert.rejects(f.media.authorize(token));
  }
  await f.store.change(f.meeting.code, (m) => {
    m.participants[0]!.status = "admitted";
    m.participants[0]!.expiresAt = Date.now() - 1;
  });
  await assert.rejects(f.media.authorize(token));
  await f.store.change(f.meeting.code, (m) => {
    m.participants[0]!.expiresAt = Date.now() + 60000;
    m.participants[0]!.enforcementPending = true;
  });
  await assert.rejects(f.media.authorize(token));
});

test("changed permissions invalidate old tokens and permit only the current grant version", async (t) => {
  const f = await fixture(t);
  const oldToken = await f.media.token(f.meeting, f.participant);
  await f.store.change(f.meeting.code, (m) => {
    m.participants[0]!.mediaVersion++;
    m.participants[0]!.videoAllowed = false;
  });
  await assert.rejects(f.media.authorize(oldToken));
  const current = (await f.store.get(f.meeting.code))!;
  const freshToken = await f.media.token(current, current.participants[0]!);
  assert.equal((await f.media.authorize(freshToken)).p.videoAllowed, false);
});

test("unknown participant identities, wrong rooms, and ended meetings deny media", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    f.media.authorize(await f.signed({ identity: randomUUID() })),
  );
  await assert.rejects(
    f.media.authorize(await f.signed({ room: "another-meeting-room" })),
  );
  const token = await f.media.token(f.meeting, f.participant);
  await f.store.change(f.meeting.code, (m) => {
    m.ended = true;
  });
  await assert.rejects(f.media.authorize(token));
});

test("breakout movement rejects the previous room even with an otherwise current signature", async (t) => {
  const f = await fixture(t);
  const original = await f.media.token(f.meeting, f.participant);
  const breakout = {
    id: randomUUID(),
    name: "Group",
    room: `b_${randomUUID()}`,
  };
  await f.store.change(f.meeting.code, (m) => {
    m.breakouts.push(breakout);
    m.participants[0]!.breakoutId = breakout.id;
    m.participants[0]!.mediaVersion++;
  });
  await assert.rejects(f.media.authorize(original));
  const current = (await f.store.get(f.meeting.code))!;
  await assert.rejects(
    f.media.authorize(
      await f.signed({ version: current.participants[0]!.mediaVersion }),
    ),
  );
  const token = await f.media.token(current, current.participants[0]!);
  assert.equal(
    (await f.media.verifier.verify(token)).video?.room,
    breakout.room,
  );
  assert.equal((await f.media.authorize(token)).p.breakoutId, breakout.id);
});

test("removing an absent participant accepts only LiveKit's structured not_found response", async (t) => {
  const f = await fixture(t);
  const calls: string[][] = [];
  f.participant.previousRoom = "previous-breakout-room";
  f.media.client.removeParticipant = async (room, identity) => {
    calls.push([room, identity]);
    throw new ServerError("TwirpError", "unknown identity", 404, "not_found");
  };
  await f.media.remove(f.meeting, f.participant);
  await f.media.remove(f.meeting, f.participant);
  assert.deepEqual(calls, [
    [f.participant.previousRoom, f.participant.id],
    [f.participant.previousRoom, f.participant.id],
  ]);
});

test("ending a meeting continues across structurally absent main and breakout rooms", async (t) => {
  const f = await fixture(t);
  f.meeting.breakouts = [
    { id: randomUUID(), name: "Breakout", room: "absent-breakout-room" },
  ];
  const calls: string[] = [];
  f.media.client.deleteRoom = async (room) => {
    calls.push(room);
    throw new ServerError("TwirpError", "unknown room", 404, "not_found");
  };
  await f.media.end(f.meeting);
  assert.deepEqual(calls, [f.meeting.room, f.meeting.breakouts[0]!.room]);
});

test("media cleanup preserves unrecognized, authentication, service and network failures", async (t) => {
  const f = await fixture(t);
  for (const error of [
    new Error("participant not found"),
    Object.assign(new Error("does not exist"), { code: "not_found" }),
    new ServerError("TwirpError", "not found", 404),
    new ServerError(
      "TwirpError",
      "participant not found",
      401,
      "unauthenticated",
    ),
    new ServerError(
      "TwirpError",
      "room does not exist",
      403,
      "permission_denied",
    ),
    new ServerError("TwirpError", "service not found", 503, "unavailable"),
    new TypeError("fetch failed"),
  ]) {
    f.media.client.removeParticipant = async () => {
      throw error;
    };
    f.media.client.deleteRoom = async () => {
      throw error;
    };
    await assert.rejects(
      f.media.remove(f.meeting, f.participant),
      (caught) => caught === error,
    );
    await assert.rejects(f.media.end(f.meeting), (caught) => caught === error);
  }
});

test("unmetered browser leave retains its physical cleanup fence when media control is unavailable", async (t) => {
  const f = await fixture(t);
  const session = "unmetered-test-session";
  await f.store.change(f.meeting.code, (m) => {
    m.participants[0]!.tokenHash = digest(session);
  });
  const app = await createApp(f.config, f.store, f.media);
  await app.ready();
  t.after(() => app.close());
  const removed: string[] = [];
  f.media.client.removeParticipant = async (_room, identity) => {
    removed.push(identity);
  };
  const leave = () =>
    app.inject({
      method: "POST",
      url: `/api/meetings/${f.meeting.code}/leave`,
      payload: {},
      headers: {
        origin: f.config.origin,
        "x-requested-with": "MeetingPlatform",
        cookie: `mp_${f.meeting.code}=${session}`,
      },
    });

  f.media.available = false;
  const unavailable = await leave();
  assert.equal(unavailable.statusCode, 503);
  const pending = (await f.store.get(f.meeting.code))!.participants[0]!;
  assert.equal(pending.status, "left");
  assert.equal(pending.enforcementPending, true);
  assert.equal(pending.previousMediaIdentity, f.participant.id);
  assert.equal(pending.previousRoom, f.meeting.room);
  assert.deepEqual(removed, []);

  f.media.available = true;
  const retried = await leave();
  assert.equal(retried.statusCode, 200, retried.body);
  assert.deepEqual(removed, [f.participant.id]);
  const settled = (await f.store.get(f.meeting.code))!.participants[0]!;
  assert.equal(settled.enforcementPending, false);
  assert.equal(settled.previousMediaIdentity, undefined);
  assert.equal(settled.previousRoom, undefined);
});

test("delayed duplicate physical removal cannot disconnect or authorize a successor generation", async (t) => {
  const f = await fixture(t);
  const second = new LiveMedia(f.config, f.store);
  t.after(() => second.close());
  const oldToken = await f.media.token(f.meeting, f.participant);
  const retired = await f.store.change(f.meeting.code, (m) => {
    fenceParticipantMedia(m, m.participants[0]!);
    m.participants[0]!.videoAllowed = false;
    return structuredClone(m);
  });
  const previous = retired.participants[0]!;
  assert.equal(previous.previousMediaIdentity, f.participant.id);
  assert.notEqual(mediaIdentity(previous), f.participant.id);
  const physicalPeers = new Set([f.participant.id]);
  let release!: () => void, entered!: () => void;
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  const requested = new Promise<void>((resolve) => {
    entered = resolve;
  });
  t.after(release);
  second.client.removeParticipant = async (_room, identity) => {
    entered();
    await delayed;
    physicalPeers.delete(identity);
  };
  f.media.client.removeParticipant = async (_room, identity) => {
    physicalPeers.delete(identity);
  };
  const staleRemoval = second.remove(retired, previous);
  await requested;
  await f.media.remove(retired, previous);
  await f.store.change(f.meeting.code, (m) => {
    assert.equal(completeMediaFence(m.participants[0]!, previous), true);
  });
  const fresh = (await f.store.get(f.meeting.code))!,
    successor = fresh.participants[0]!;
  const successorId = mediaIdentity(successor);
  physicalPeers.add(successorId);
  let closed = false;
  const socket = {
    close: () => {
      closed = true;
    },
    terminate: () => {},
  } as unknown as WebSocket;
  second.sockets.set(successorId, new Set([socket]));
  const freshToken = await second.token(fresh, successor);
  assert.equal((await second.verifier.verify(freshToken)).sub, successorId);
  assert.equal((await second.authorize(freshToken)).p.id, f.participant.id);
  await assert.rejects(second.authorize(oldToken));
  // Even a current-version token addressed to the retired logical identity is denied.
  await assert.rejects(
    second.authorize(await f.signed({ version: successor.mediaVersion })),
  );
  release();
  await staleRemoval;
  // A delayed invocation (not only a delayed provider response) must also target the old map.
  await second.remove(retired, previous);
  assert.deepEqual([...physicalPeers], [successorId]);
  assert.equal(closed, false);
  assert.equal(second.sockets.get(successorId)?.has(socket), true);
  await f.store.change(f.meeting.code, (m) => {
    assert.equal(completeMediaFence(m.participants[0]!, previous), false);
  });
});

test("overlapping restrictions keep the first retired room and identity until matching cleanup", async (t) => {
  const f = await fixture(t),
    m = f.meeting,
    p = f.participant;
  const breakout = { id: randomUUID(), name: "Breakout", room: randomUUID() };
  m.breakouts.push(breakout);
  fenceParticipantMedia(m, p);
  p.breakoutId = breakout.id;
  const first = structuredClone(p),
    firstNextIdentity = mediaIdentity(p);
  fenceParticipantMedia(m, p);
  assert.equal(p.previousRoom, m.room);
  assert.equal(p.previousMediaIdentity, p.id);
  assert.notEqual(mediaIdentity(p), firstNextIdentity);
  assert.equal(completeMediaFence(p, first), false);
  const latest = structuredClone(p);
  assert.equal(completeMediaFence(p, latest), true);
  fenceParticipantMedia(m, p);
  assert.equal(p.previousRoom, breakout.room);
  assert.equal(p.previousMediaIdentity, mediaIdentity(latest));
});

test("legacy pending cleanup rotates before release and keeps delayed legacy removal off the successor", async (t) => {
  const f = await fixture(t);
  const pending = await f.store.change(f.meeting.code, (m) => {
    const p = m.participants[0]!;
    p.mediaVersion++;
    p.enforcementPending = true;
    p.previousRoom = m.room;
    return structuredClone(m);
  });
  const old = pending.participants[0]!;
  assert.equal(old.mediaIdentity, undefined);
  const peers = new Set([old.id]);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(release);
  f.media.client.removeParticipant = async (_room, identity) => {
    await gate;
    peers.delete(identity);
  };
  const delayed = f.media.remove(pending, old);
  // Another process confirms the same original participant absent and completes the fence.
  peers.delete(old.id);
  await f.store.change(f.meeting.code, (m) => {
    assert.equal(completeMediaFence(m.participants[0]!, old), true);
  });
  const current = (await f.store.get(f.meeting.code))!,
    next = current.participants[0]!;
  assert.equal(next.mediaVersion, old.mediaVersion + 1);
  assert.notEqual(mediaIdentity(next), old.id);
  assert.equal(next.enforcementPending, false);
  peers.add(mediaIdentity(next));
  release();
  await delayed;
  assert.deepEqual([...peers], [mediaIdentity(next)]);
  assert.equal(
    (await f.media.authorize(await f.media.token(current, next))).p.id,
    old.id,
  );
  await assert.rejects(
    f.media.authorize(await f.signed({ version: next.mediaVersion })),
  );
});
