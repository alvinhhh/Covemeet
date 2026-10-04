import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { loadConfig } from "../src/config.js";
import { LiveMedia } from "../src/media.js";
import { MemoryStore, type Meeting, type Participant } from "../src/store.js";

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
