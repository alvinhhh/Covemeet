import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { MemoryStore, type Meeting, type Participant } from "../src/store.js";
import type { Media } from "../src/media.js";
import { digest } from "../src/security.js";
import {
  PhoneDialogService,
  type PhoneCleanupProof,
  type PhoneDialog,
  type PhoneDialogChange,
  type PhoneDialogInput,
} from "../src/phone-dialogs.js";

const gatewayKey = "journal-gateway-test-key-over-32-characters";
const proof: PhoneCleanupProof = {
  allocationsStopped: true,
  callerAbsent: true,
  outboundAbsent: true,
  bridgeAbsent: true,
  nativeAbsent: true,
  holdingRelayAbsent: true,
  rtcClosed: true,
};
const ownerId = randomUUID();
function input(): PhoneDialogInput {
  return {
    callId: randomUUID(),
    ownerId,
    pbxId: "test-pbx",
    pbxEpoch: "boot-1",
    callerChannelId: `caller-${randomUUID()}`,
    trunkId: "test-trunk",
    inboundEndpoint: "inbound",
    outboundEndpoint: "outbound",
    sipTrunkId: "ST_test",
    sipRuleId: "SDR_test",
  };
}
function meeting(): Meeting {
  return {
    id: randomUUID(),
    code: "JOURNALTEST",
    room: "journal-room",
    title: "Journal test",
    mode: "meeting",
    locked: false,
    ended: false,
    recordingAllowed: false,
    createdAt: Date.now(),
    revision: 1,
    passwordHash: "unused",
    hostTokenExpiresAt: 0,
    participants: [],
    bans: { ip: [], device: [] },
    breakouts: [],
    messages: [],
    recordings: [],
  };
}
async function fixture() {
  const config = loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "journal-session-test-key-over-32-characters",
    PHONE_ENABLED: "true",
    PHONE_GATEWAY_KEY: gatewayKey,
    PHONE_TRUNK_ID: "test-trunk",
    PHONE_SIP_ADDRESS: "sips:phone.example.test",
    PHONE_MAX_CALLS: "2",
  });
  const store = new MemoryStore();
  const m = meeting();
  await store.create(m);
  const media: Media & { fail: boolean; afterRemove?: () => Promise<void> } = {
    fail: false,
    available: true,
    token: async () => "unused",
    async remove() {
      if (this.fail) throw new Error("synthetic media failure");
      await this.afterRemove?.();
    },
    end: async () => {},
    close() {},
  };
  const service = new PhoneDialogService(config, store, media);
  await service.claim({ pbxId: "test-pbx", ownerId, pbxEpoch: "boot-1" });
  const change = (d: PhoneDialog, change: PhoneDialogChange) =>
    service.change(d.callId, {
      ownerId: d.ownerId,
      revision: d.revision,
      change,
    });
  const query = async (id: string) =>
    (await service.query({ callId: id })).dialogs[0]!;
  const stop = (d: PhoneDialog) =>
    service.stop(d.callId, { ownerId: d.ownerId, revision: d.revision });
  const finish = (d: PhoneDialog) =>
    service.finish(d.callId, {
      ownerId: d.ownerId,
      revision: d.revision,
      proof,
    });
  async function answered(data = input()) {
    let d = await service.create(data);
    d = await change(d, { type: "begin", operation: "answer" });
    return change(d, {
      type: "settle",
      operation: "answer",
      outcome: "confirmed",
    });
  }
  async function join(callId: string, ownerId?: string) {
    const participantId = randomUUID();
    const session = await store.reservePhone(
      m.code,
      callId,
      participantId,
      2,
      (state) => {
        const p: Participant = {
          id: participantId,
          name: "Phone caller",
          transport: "phone",
          role: "participant",
          status: "waiting",
          audioAllowed: true,
          videoAllowed: false,
          mediaVersion: 1,
          tokenHash: "not-a-capability",
          expiresAt: Date.now() + 60000,
          ipHash: "",
          deviceHash: "",
          breakoutId: null,
          phone: {
            callId,
            trunkId: "test-trunk",
            muted: true,
            handRaised: false,
            leaseExpiresAt: Date.now() + 10000,
            callExpiresAt: Date.now() + 60000,
          },
        };
        state.participants.push(p);
        return { participantId };
      },
      ownerId,
    );
    return session;
  }
  return {
    config,
    store,
    media,
    service,
    m,
    change,
    query,
    stop,
    finish,
    answered,
    join,
  };
}

test("pre-IVR dialogs and legacy reservations share one cap, counted once after binding", async () => {
  const f = await fixture();
  const legacy = randomUUID();
  await f.join(legacy);
  const d = await f.answered();
  const joined = await f.join(d.callId, d.ownerId);
  assert.equal(
    (await f.query(d.callId)).binding?.participantId,
    joined.participantId,
  );
  await assert.rejects(f.service.create(input()), /capacity/);
  await assert.rejects(f.join(randomUUID()), /capacity/);
  await f.store.releasePhone(
    legacy,
    f.m.code,
    (await f.store.get(f.m.code))!.participants[0]!.id,
  );
  await f.service.create(input());
  await assert.rejects(f.service.create(input()), /capacity/);
});

test("concurrent pre-answer claims cannot exceed the installation cap", async () => {
  const f = await fixture();
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () => f.service.create(input())),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal(
    (await f.service.query({ pbxId: "test-pbx" })).dialogs.length,
    2,
  );
});

test("pre-IVR attempts are bounded while exact create retries remain idempotent", async () => {
  const f = await fixture();
  const original = input();
  const d = await f.service.create(original);
  await f.service.create(input());
  for (let i = 0; i < 28; i++)
    await assert.rejects(f.service.create(input()), /capacity/);
  await assert.rejects(f.service.create(input()), /attempts/);
  assert.deepEqual(await f.service.create(original), d);
});

test("ownership and revisions cannot be bypassed; caller and call tombstones persist", async () => {
  const f = await fixture();
  const original = input();
  let d = await f.service.create(original);
  assert.deepEqual(await f.service.create(original), d);
  await assert.rejects(
    f.service.create({ ...original, ownerId: randomUUID() }),
    /ownership/,
  );
  await assert.rejects(
    f.service.create({ ...original, callId: randomUUID() }),
    /identity/,
  );
  await assert.rejects(f.join(d.callId), /owner/);
  await assert.rejects(f.join(randomUUID(), d.ownerId), /missing/);
  await assert.rejects(
    f.service.change(d.callId, {
      ownerId: randomUUID(),
      revision: d.revision,
      change: { type: "uncertain" },
    }),
    /ownership/,
  );
  const old = d;
  d = await f.change(d, { type: "begin", operation: "answer" });
  await assert.rejects(f.change(old, { type: "uncertain" }), /revision/);
  d = await f.change(d, {
    type: "settle",
    operation: "answer",
    outcome: "rejected",
  });
  d = await f.stop(d);
  d = await f.finish(d);
  assert.equal(d.state, "closed");
  await assert.rejects(f.service.create(original), /identity/);
  await assert.rejects(f.change(d, { type: "uncertain" }), /closed/);
});

test("lost join response remains bound; ordinary leave cannot free journaled capacity", async () => {
  const f = await fixture();
  let d = await f.answered();
  await f.join(d.callId, d.ownerId); // Deliberately discard the returned participant/session binding.
  d = await f.query(d.callId);
  assert(d.binding);
  await f.store.releasePhone(d.callId, d.binding.code, d.binding.participantId);
  assert.equal(f.store.phoneCalls.get(d.callId)!.released, false);
  await f.service.create(input());
  await assert.rejects(f.service.create(input()), /capacity/);
  d = await f.stop(d);
  const p = (await f.store.get(f.m.code))!.participants[0]!;
  assert.equal(p.status, "left");
  assert.equal(p.phone!.leaseExpiresAt, 0);
  assert.equal(p.enforcementPending, false);
  d = await f.finish(d);
  assert.equal(d.state, "closed");
  assert.equal(f.store.phoneCalls.get(d.callId)!.released, true);
  await f.service.create(input());
});

test("failed admission transaction leaves dialog unbound and the slot reserved", async () => {
  const f = await fixture();
  const d = await f.answered();
  await assert.rejects(
    f.store.reservePhone(
      f.m.code,
      d.callId,
      randomUUID(),
      2,
      () => {
        throw new Error("synthetic admission rejection");
      },
      d.ownerId,
    ),
    /rejection/,
  );
  assert.equal((await f.query(d.callId)).binding, undefined);
  assert.equal(f.store.phoneCalls.size, 0);
  assert.equal((await f.store.get(f.m.code))!.participants.length, 0);
});

test("pending and unknown mutations stay reserved even with claimed cleanup proof", async () => {
  const f = await fixture();
  let d = await f.service.create(input());
  d = await f.change(d, { type: "begin", operation: "answer" });
  d = await f.stop(d);
  await assert.rejects(f.finish(d), /unresolved/);
  await assert.rejects(
    f.change(d, { type: "begin", operation: "originate" }),
    /unavailable/,
  );
  d = await f.change(d, {
    type: "settle",
    operation: "answer",
    outcome: "unknown",
  });
  assert.equal(d.uncertain, true);
  await assert.rejects(f.finish(d), /unresolved/);
  await assert.rejects(
    f.change(d, { type: "settle", operation: "answer", outcome: "confirmed" }),
    /not pending/,
  );
});

test("playback IDs are persisted and rotate only after the previous mutation settles", async () => {
  const f = await fixture();
  let d = await f.answered();
  d = await f.change(d, { type: "begin", operation: "play" });
  const first = d.playbackId;
  assert.equal(first, `cm-play-${d.callId}-${d.revision}`);
  assert.equal((await f.query(d.callId)).playbackId, first);
  await assert.rejects(
    f.change(d, { type: "begin", operation: "play" }),
    /unavailable/,
  );
  d = await f.change(d, {
    type: "settle",
    operation: "play",
    outcome: "confirmed",
  });
  d = await f.change(d, { type: "begin", operation: "play" });
  assert.notEqual(d.playbackId, first);
  d = await f.stop(d);
  await assert.rejects(f.finish(d), /unresolved/);
});

test("holding binding is exact and immutable; arbitrary fields and secrets are rejected", async () => {
  const f = await fixture();
  await assert.rejects(f.service.create({ ...input(), pin: "12345678" }));
  let d = await f.answered();
  await f.join(d.callId, d.ownerId);
  d = await f.query(d.callId);
  d = await f.change(d, { type: "begin", operation: "originate" });
  d = await f.change(d, {
    type: "settle",
    operation: "originate",
    outcome: "confirmed",
  });
  const holding = {
    type: "holding" as const,
    roomName: `phone-hold-${d.callId}_abcdefgh`,
    roomSid: "RM_test",
    nativeSid: "PA_test",
    nativeIdentity: `sip_${createHash("sha256").update("covemeet-pbx").digest("hex").slice(0, 16)}`,
  };
  await assert.rejects(
    f.change(d, {
      ...holding,
      roomName: `phone-hold-${randomUUID()}_abcdefgh`,
    }),
    /mismatch/,
  );
  d = await f.change(d, holding);
  await assert.rejects(
    f.change(d, { ...holding, nativeSid: "PA_other" }),
    /mismatch/,
  );
  await assert.rejects(
    f.service.change(d.callId, {
      ownerId: d.ownerId,
      revision: d.revision,
      change: { type: "uncertain", reason: "secret" },
    }),
  );
});

test("media cleanup failure blocks finish and disabled admission still permits cleanup", async () => {
  const f = await fixture();
  let d = await f.answered();
  await f.join(d.callId, d.ownerId);
  d = await f.query(d.callId);
  f.config.phoneEnabled = false;
  await assert.rejects(f.service.create(input()), /disabled/);
  f.media.fail = true;
  await assert.rejects(f.stop(d), /media failure/);
  d = await f.query(d.callId);
  assert.equal(d.state, "stopping");
  await assert.rejects(f.finish(d), /meeting cleanup/);
  f.media.fail = false;
  d = await f.stop(d);
  d = await f.finish(d);
  assert.equal(d.state, "closed");
});

test("media removal cannot acknowledge a newer participant generation", async () => {
  const f = await fixture();
  let d = await f.answered();
  await f.join(d.callId, d.ownerId);
  d = await f.query(d.callId);
  f.media.afterRemove = () =>
    f.store.change(f.m.code, (m) => {
      m.participants[0]!.mediaVersion++;
    });
  d = await f.stop(d);
  await assert.rejects(f.finish(d), /meeting cleanup/);
  f.media.afterRemove = undefined;
  d = await f.stop(d);
  assert.equal((await f.finish(d)).state, "closed");
});

test("journal routes require private credentials, exact query shape, and bounded proof", async (t) => {
  const f = await fixture();
  const app = await createApp(f.config, f.store, f.media);
  await app.ready();
  t.after(() => app.close());
  const headers = {
    authorization: `Bearer ${gatewayKey}`,
    "x-requested-with": "CovemeetPhone",
  };
  const data = input();
  for (const h of [{}, { ...headers, origin: "https://untrusted.example" }]) {
    const claim = await app.inject({
      method: "POST",
      url: "/api/internal/phone/supervisors/claim",
      payload: {
        pbxId: data.pbxId,
        ownerId: data.ownerId,
        pbxEpoch: data.pbxEpoch,
      },
      headers: h,
    });
    assert.equal(claim.statusCode, 403);
    const response = await app.inject({
      method: "POST",
      url: "/api/internal/phone/dialogs",
      payload: data,
      headers: h,
    });
    assert.equal(response.statusCode, 403);
  }
  const duplicateOwner = await app.inject({
    method: "POST",
    url: "/api/internal/phone/supervisors/claim",
    payload: {
      pbxId: data.pbxId,
      ownerId: randomUUID(),
      pbxEpoch: data.pbxEpoch,
    },
    headers,
  });
  assert.equal(duplicateOwner.statusCode, 409);
  const created = await app.inject({
    method: "POST",
    url: "/api/internal/phone/dialogs",
    payload: data,
    headers,
  });
  assert.equal(created.statusCode, 200, created.body);
  const query = await app.inject({
    method: "POST",
    url: "/api/internal/phone/dialogs/query",
    payload: { callId: data.callId, pbxId: data.pbxId },
    headers,
  });
  assert.equal(query.statusCode, 400);
  const stopped = await app.inject({
    method: "POST",
    url: `/api/internal/phone/dialogs/${data.callId}/stop`,
    payload: { ownerId: data.ownerId, revision: 1 },
    headers,
  });
  assert.equal(stopped.statusCode, 200, stopped.body);
  const denied = await app.inject({
    method: "POST",
    url: `/api/internal/phone/dialogs/${data.callId}/finish`,
    payload: {
      ownerId: data.ownerId,
      revision: stopped.json().revision,
      proof: { ...proof, callerAbsent: false },
    },
    headers,
  });
  assert.equal(denied.statusCode, 400);
});

test("shared gateway traffic cannot consume the quota needed for verified cleanup", async (t) => {
  const f = await fixture();
  const data = input();
  let dialog = await f.answered(data);
  const { participantId } = await f.join(dialog.callId, dialog.ownerId);
  const sessionToken = "phone-session-for-rate-limit-test-over-32-characters";
  await f.store.change(f.m.code, (meeting) => {
    meeting.participants[0]!.tokenHash = digest(sessionToken);
  });
  const app = await createApp(f.config, f.store, f.media);
  await app.ready();
  t.after(() => app.close());
  const headers = {
    authorization: `Bearer ${gatewayKey}`,
    "x-requested-with": "CovemeetPhone",
  };
  const request = (url: string, payload: object) =>
    app.inject({ method: "POST", url, payload, headers });
  const control = async (url: string, payload: object) => {
    const response = await request(url, payload);
    assert.equal(response.statusCode, 200, response.body);
    return response.json();
  };

  // Exact retries do not consume another reservation, but admission still has
  // its HTTP limit. Exhausting it must not prevent existing-call cleanup.
  for (let i = 0; i < 61; i++) {
    const response = await request("/api/internal/phone/dialogs", data);
    assert.equal(response.statusCode, i < 60 ? 200 : 429, response.body);
  }
  for (let i = 0; i < 3001; i++) {
    const result = await control("/api/internal/phone/dialogs/query", {
      callId: dialog.callId,
    });
    dialog = result.dialogs[0];
  }
  const denied = await app.inject({
    method: "POST",
    url: "/api/internal/phone/dialogs/query",
    payload: { callId: dialog.callId },
  });
  assert.equal(denied.statusCode, 403);

  const path = `/api/internal/phone/dialogs/${dialog.callId}`;
  for (const change of [
    { type: "begin", operation: "play" },
    { type: "settle", operation: "play", outcome: "rejected" },
  ])
    dialog = await control(path, {
      ownerId: dialog.ownerId,
      revision: dialog.revision,
      change,
    });
  const left = await control(
    `/api/internal/phone/calls/${f.m.code}/${participantId}`,
    { callId: dialog.callId, sessionToken, action: "leave" },
  );
  assert.equal(left.state, "ended");
  assert.equal(f.store.phoneCalls.get(dialog.callId)!.released, false);
  dialog = await control(`${path}/stop`, {
    ownerId: dialog.ownerId,
    revision: dialog.revision,
  });
  dialog = await control(`${path}/finish`, {
    ownerId: dialog.ownerId,
    revision: dialog.revision,
    proof,
  });
  assert.equal(dialog.state, "closed");
  assert.equal(f.store.phoneCalls.get(dialog.callId)!.released, true);
});
