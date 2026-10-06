import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { MemoryStore, type Meeting, type Participant } from "../src/store.js";
import {
  entitlementFor,
  entitlementSchema,
  type HostedEntitlement,
} from "../src/meeting-limits.js";
import {
  usageWindow,
  quotaOverdrawn,
  type UsageLedger,
} from "../src/participant-meter.js";

const now = Date.UTC(2026, 9, 5, 12);
const anchorAt = Date.UTC(2026, 0, 31, 12);
async function fixture(
  t: TestContext,
  allowance: number | null = 360000,
  at = now,
  metering?: "meeting",
) {
  t.mock.timers.enable({ apis: ["Date"], now: at });
  const store = new MemoryStore(),
    owner = randomUUID();
  const grant: HostedEntitlement = {
    billingOwnerId: owner,
    revision: 1,
    validUntil: at + 300000,
    enabled: true,
    quota: {
      anchorAt,
      participantSecondsPerMonth: allowance,
      ...(metering ? { metering } : {}),
    },
    hostAccountIds: [owner],
    limits: { participants: 100, durationSeconds: 7200, concurrentMeetings: 1 },
  };
  await store.setHostedEntitlement(grant);
  const participant = (role: Participant["role"]): Participant => ({
    id: randomUUID(),
    name: role,
    role,
    status: "admitted",
    audioAllowed: true,
    videoAllowed: true,
    mediaVersion: 1,
    tokenHash: "fixture",
    expiresAt: at + 7200000,
    ipHash: "fixture",
    deviceHash: "fixture",
    breakoutId: null,
  });
  const host = participant("host"),
    guest = participant("participant");
  const m: Meeting = {
    hosted: {
      accountId: owner,
      billingOwnerId: owner,
      version: 1,
      entitlement: entitlementFor(grant, owner),
    },
    lifecycle: { startedAt: at, deadlineAt: at + 7200000 },
    code: randomUUID(),
    id: randomUUID(),
    room: randomUUID(),
    title: "Synthetic meter fixture",
    mode: "meeting",
    locked: false,
    ended: false,
    recordingAllowed: false,
    createdAt: at,
    revision: 1,
    passwordHash: "fixture",
    hostTokenExpiresAt: at + 1000,
    participants: [host, guest],
    bans: { ip: [], device: [] },
    breakouts: [],
    messages: [],
    recordings: [],
  };
  await store.create(m);
  const act = (
    p: Participant,
    connectionId: string,
    action: "claim" | "connected" | "heartbeat",
    mediaVersion = p.mediaVersion,
  ) =>
    store.updateParticipantMeter(m.code, {
      participantId: p.id,
      connectionId,
      action,
      mediaVersion,
    });
  return {
    store,
    owner,
    grant,
    m,
    host,
    guest,
    act,
    usage: () => store.hostedUsage(owner),
  };
}

test("legacy recording inventory cannot block meeting admission or ongoing media", async (t) => {
  const f = await fixture(t, 360000, now, "meeting");
  await f.store.setHostedEntitlement({
    ...f.grant,
    revision: 2,
    quota: {
      ...f.grant.quota!,
      recordingSecondsPerMonth: null,
      storageBytes: 5_000_000_000,
    },
  });
  await f.store.change(f.m.code, (m) => {
    m.recordingAllowed = true;
  });
  await f.act(f.host, "host-connection", "claim");
  await f.act(f.host, "host-connection", "connected");
  await f.store.create({
    ...structuredClone(f.m),
    id: randomUUID(),
    code: randomUUID(),
    room: randomUUID(),
    ended: true,
    participants: [],
    lifecycle: { startedAt: now - 86400000, cleanupConfirmed: true },
    recordings: [
      { id: randomUUID(), status: "deleted", createdAt: now - 86400000 },
    ],
  });

  // These are the store entry points used by host exchange/admission/media
  // issuance and by the signaling gateway's claims and heartbeat.
  await f.store.checkUsage(f.m.code);
  await f.act(f.guest, "guest-connection", "claim");
  await f.act(f.guest, "guest-connection", "connected");
  t.mock.timers.tick(5000);
  await f.act(f.host, "host-connection", "heartbeat");
  assert.equal(
    f.store.usageLedgers.get(f.owner)!.windows[0]!.meetingUsedMs,
    5000,
  );

  await assert.rejects(f.usage(), /Recording storage inventory is unavailable/);
  const recording = {
    id: randomUUID(),
    status: "starting",
    createdAt: Date.now(),
  };
  await assert.rejects(
    f.store.withRecordingLock(f.m.code, recording.id, (lock) =>
      lock.reserveRecording(recording, () => {}, { maxBytes: 1000, copies: 1 }),
    ),
    /Recording storage inventory is unavailable/,
  );
  assert.equal((await f.store.get(f.m.code))!.recordings.length, 0);
});

test("uncapped refresh preserves shared accounting across months and recording byte limits", async (t) => {
  const boundary = Date.UTC(2026, 9, 31, 12);
  const f = await fixture(t, 30, boundary - 15000, "meeting");
  for (const p of [f.host, f.guest]) {
    await f.act(p, p.id, "claim");
    await f.act(p, p.id, "connected");
  }
  t.mock.timers.tick(10000);
  for (const p of [f.host, f.guest]) await f.act(p, p.id, "heartbeat");
  assert.equal((await f.usage()).participantSeconds.used, 10);
  const grant = {
    ...f.grant,
    revision: 2,
    quota: {
      ...f.grant.quota!,
      participantSecondsPerMonth: null,
      recordingSecondsPerMonth: null,
      storageBytes: 1000,
      downloadBytesPerMonth: 100,
    },
  };
  assert.equal(entitlementSchema.safeParse(grant).success, true);
  await f.store.setHostedEntitlement(grant);
  await f.store.setHostedEntitlement(f.grant); // stale numeric delivery cannot undo the refresh
  for (let i = 0; i < 8; i++) {
    t.mock.timers.tick(10000);
    for (const p of [f.host, f.guest]) await f.act(p, p.id, "heartbeat");
  }
  const usage = await f.usage();
  assert.equal(usage.participantSeconds.limit, null);
  assert.equal(usage.participantSeconds.available, null);
  assert.equal(usage.participantSeconds.used, 75);
  assert(usage.participantSeconds.reserved > 0);
  assert.equal(usage.blocked, false);
  const ledger = f.store.usageLedgers.get(f.owner)!;
  assert.equal(
    ledger.windows.find((w) => w.end === boundary)!.meetingUsedMs,
    15000,
  );
  assert.equal(
    quotaOverdrawn(ledger, grant, [(await f.store.get(f.m.code))!], Date.now()),
    false,
  );
  assert.equal((await f.store.get(f.m.code))!.ended, false);
  await assert.rejects(
    f.store.setHostedEntitlement({ ...grant, quota: f.grant.quota }),
    /revision conflicts/,
  );

  await f.store.change(f.m.code, (m) => {
    m.recordingAllowed = true;
  });
  const recording = {
    id: randomUUID(),
    status: "starting",
    createdAt: Date.now(),
  };
  await f.store.withRecordingLock(f.m.code, recording.id, (lock) =>
    lock.reserveRecording(recording, () => {}, { maxBytes: 1001, copies: 1 }),
  );
  assert.equal(
    (await f.store.get(f.m.code))!.recordings[0]!.storage!.maxBytes,
    1000,
  );
  await assert.rejects(
    f.store.withRecordingLock(f.m.code, recording.id, (lock) =>
      lock.reserveRecordingStorage("s3"),
    ),
    /Recording storage allowance is unavailable/,
  );
  await f.store.debitRecordingDownload(f.m.code, 100, () => {});
  await assert.rejects(
    f.store.debitRecordingDownload(f.m.code, 1, () => {}),
    /download allowance/,
  );
  assert.equal((await f.usage()).recordingDownloadBytes.used, 100);
  assert.equal((await f.usage()).recordingStorageBytes.available, 0);
});

test("uncapped grants retain session deadlines, paid expiry, cleanup and concurrency gates", async (t) => {
  for (const reason of ["session", "paid", "cleanup", "revoked"] as const) {
    await t.test(reason, async (t) => {
      const f = await fixture(t, null, now, "meeting");
      await f.act(f.host, "host", "claim");
      await f.act(f.host, "host", "connected");
      if (reason === "session")
        await f.store.change(f.m.code, (m) => {
          m.lifecycle!.deadlineAt = now + 10000;
        });
      if (reason === "paid")
        await f.store.setHostedEntitlement({
          ...f.grant,
          revision: 2,
          validUntil: now + 10000,
        });
      if (reason === "revoked")
        await f.store.setHostedEntitlement({
          ...f.grant,
          revision: 2,
          enabled: false,
        });
      t.mock.timers.tick(reason === "cleanup" ? 16000 : 10000);
      await assert.rejects(f.act(f.host, "host", "heartbeat"));
      const m = (await f.store.get(f.m.code))!;
      assert.equal(m.participants[0]!.meter!.phase, "closing");
      assert((await f.usage()).participantSeconds.reserved > 0);
      assert.equal((await f.usage()).blocked, true);
    });
  }
  await t.test("concurrency", async (t) => {
    const f = await fixture(t, null, now, "meeting");
    const next = structuredClone(f.m);
    next.code = randomUUID();
    next.id = randomUUID();
    next.room = randomUUID();
    delete next.lifecycle;
    await f.store.create(next);
    await assert.rejects(
      f.store.startMeeting(next.code, () => {}),
      /host already has a meeting/,
    );
    const otherHost = randomUUID();
    await f.store.setHostedEntitlement({
      ...f.grant,
      revision: 2,
      hostAccountIds: [f.owner, otherHost],
    });
    await f.store.change(next.code, (m) => {
      m.hosted!.accountId = otherHost;
    });
    await assert.rejects(
      f.store.startMeeting(next.code, () => {}),
      /simultaneous meeting limit/,
    );
  });
});

test("uncapped grants require explicit meeting metering; legacy numeric grants remain valid", async (t) => {
  const f = await fixture(t);
  assert.equal(entitlementSchema.safeParse(f.grant).success, true);
  const uncapped = {
    ...f.grant,
    quota: { ...f.grant.quota!, participantSecondsPerMonth: null },
  };
  assert.equal(entitlementSchema.safeParse(uncapped).success, false);
  assert.equal(
    entitlementSchema.safeParse({
      ...uncapped,
      quota: { ...uncapped.quota, metering: "meeting" },
    }).success,
    true,
  );
});

test("UTC monthly windows clamp the original anniversary without February drift", () => {
  const anchor = Date.UTC(2024, 0, 31, 9, 12, 30, 123);
  assert.deepEqual(usageWindow(anchor, Date.UTC(2024, 1, 29, 10)), {
    start: Date.UTC(2024, 1, 29, 9, 12, 30, 123),
    end: Date.UTC(2024, 2, 31, 9, 12, 30, 123),
  });
  assert.deepEqual(usageWindow(anchor, Date.UTC(2025, 1, 28, 10)), {
    start: Date.UTC(2025, 1, 28, 9, 12, 30, 123),
    end: Date.UTC(2025, 2, 31, 9, 12, 30, 123),
  });
});

test("no paid anchor is unavailable; disable and subscription changes cannot reset it", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.store.hostedUsage(randomUUID()), /Usage unavailable/);
  await f.store.setHostedEntitlement({
    ...f.grant,
    revision: 2,
    enabled: false,
    quota: null,
  });
  assert.equal((await f.usage()).blocked, true);
  await assert.rejects(
    f.store.setHostedEntitlement({
      ...f.grant,
      revision: 3,
      quota: { ...f.grant.quota!, anchorAt: anchorAt + 1 },
    }),
    /anniversary cannot change/,
  );
  assert.equal(
    entitlementSchema.safeParse({ ...f.grant, quota: null }).success,
    false,
  );
  await f.store.setHostedEntitlement({ ...f.grant, revision: 3 });
  assert.equal((await f.usage()).participantSeconds.available, 360000);
});

test("tokenless admitted users spend nothing; two claims cannot oversubscribe the final30seconds", async (t) => {
  const f = await fixture(t, 30);
  assert.equal((await f.usage()).participantSeconds.used, 0);
  const results = await Promise.allSettled([
    f.act(f.host, "host", "claim"),
    f.act(f.guest, "guest", "claim"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.deepEqual((await f.usage()).participantSeconds, {
    limit: 30,
    used: 0,
    reserved: 30,
    available: 0,
  });
  t.mock.timers.tick(16000);
  await f.store.reconcileParticipantMeters(f.m.code);
  const p = (await f.store.get(f.m.code))!.participants.find(
    (p) => p.id === f.host.id,
  )!;
  assert.equal(p.enforcementPending, true);
  assert.equal((await f.usage()).participantSeconds.used, 0);
  await f.store.settleParticipantMeter(f.m.code, p.id, p.mediaVersion, p.meter); // caller has confirmed SFU removal
  assert.deepEqual((await f.usage()).participantSeconds, {
    limit: 30,
    used: 0,
    reserved: 0,
    available: 30,
  });
});

test("same participant reconnect has one reservation and stale socket callbacks cannot change its successor", async (t) => {
  const f = await fixture(t);
  await f.act(f.host, "first", "claim");
  t.mock.timers.tick(1000);
  await f.act(f.host, "first", "connected");
  t.mock.timers.tick(5000);
  await f.act(f.host, "second", "claim");
  await f.act(f.host, "second", "connected");
  await assert.rejects(
    f.act(f.host, "first", "heartbeat"),
    /connection changed/,
  );
  await assert.rejects(
    f.act(f.host, "first", "connected"),
    /connection changed/,
  );
  const p = (await f.store.get(f.m.code))!.participants[0]!;
  assert.equal(p.meter!.connectionId, "second");
  assert.equal(p.enforcementPending, undefined);
  assert.deepEqual((await f.usage()).participantSeconds, {
    limit: 360000,
    used: 5,
    reserved: 24,
    available: 359971,
  });
});

test("missed presence does not renew an admitted user; unknown cleanup holds quota across restart time", async (t) => {
  const f = await fixture(t, 60);
  await f.act(f.host, "connection", "claim");
  await f.act(f.host, "connection", "connected");
  t.mock.timers.tick(1000);
  await f.act(f.host, "connection", "heartbeat");
  t.mock.timers.tick(16000);
  await f.store.reconcileParticipantMeters(f.m.code);
  const before = await f.usage();
  assert.equal(before.blocked, true);
  assert.equal(before.participantSeconds.used, 1);
  assert.equal(before.participantSeconds.reserved, 29);
  t.mock.timers.tick(100000);
  assert.deepEqual(
    (await f.usage()).participantSeconds,
    before.participantSeconds,
  );
  await assert.rejects(
    f.act(f.guest, "other", "claim"),
    /allowance is unavailable/,
  );
  const p = (await f.store.get(f.m.code))!.participants[0]!;
  await f.store.settleParticipantMeter(f.m.code, p.id, p.mediaVersion, p.meter);
  assert.equal((await f.usage()).participantSeconds.used, 30);
  assert.equal((await f.usage()).participantSeconds.reserved, 0);
});

test("sustained quiet participant stops at its prepaid endpoint without overspending", async (t) => {
  const f = await fixture(t, 35);
  await f.act(f.host, "connection", "claim");
  await f.act(f.host, "connection", "connected");
  for (let n = 0; n < 6; n++) {
    t.mock.timers.tick(5000);
    await f.act(f.host, "connection", "heartbeat");
  }
  assert.equal((await f.usage()).participantSeconds.used, 30);
  assert.equal((await f.usage()).participantSeconds.reserved, 5);
  t.mock.timers.tick(5000);
  await assert.rejects(
    f.act(f.host, "connection", "heartbeat"),
    /Media access denied/,
  );
  assert.equal((await f.store.get(f.m.code))!.ended, true);
  assert.equal((await f.usage()).blocked, true);
  const p = (await f.store.get(f.m.code))!.participants[0]!;
  await f.store.settleParticipantMeter(f.m.code, p.id, p.mediaVersion, p.meter);
  assert.deepEqual((await f.usage()).participantSeconds, {
    limit: 35,
    used: 35,
    reserved: 0,
    available: 0,
  });
});

test("a live lease splits at monthly boundary without rollover or double counting", async (t) => {
  const boundary = Date.UTC(2026, 9, 31, 12);
  const f = await fixture(t, 60, boundary - 15000);
  await f.act(f.host, "connection", "claim");
  await f.act(f.host, "connection", "connected");
  t.mock.timers.tick(10000);
  await f.act(f.host, "connection", "heartbeat");
  t.mock.timers.tick(10000);
  await f.act(f.host, "connection", "heartbeat");
  const ledger = f.store.usageLedgers.get(f.owner)!;
  assert.equal(ledger.windows.find((w) => w.end === boundary)!.usedMs, 15000);
  const view = await f.usage();
  assert.equal(view.window.start, boundary);
  assert.equal(view.participantSeconds.used, 5);
  assert.equal(view.participantSeconds.reserved, 30);
  assert.equal(view.participantSeconds.available, 25);
  assert.equal((await f.store.get(f.m.code))!.ended, false);
});

test("display rounding never drives downgrade enforcement; absolute quota reductions do", async (t) => {
  const f = await fixture(t, 30);
  await f.act(f.host, "connection", "claim");
  await f.act(f.host, "connection", "connected");
  t.mock.timers.tick(1);
  await f.act(f.host, "connection", "heartbeat");
  const m = (await f.store.get(f.m.code))!;
  const ledger = f.store.usageLedgers.get(f.owner)!;
  assert.equal(quotaOverdrawn(ledger, f.grant, [m], Date.now()), false);
  await f.store.setHostedEntitlement({ ...f.grant, revision: 2 });
  assert.equal((await f.store.get(f.m.code))!.ended, false);
  await f.store.setHostedEntitlement({
    ...f.grant,
    revision: 3,
    quota: { ...f.grant.quota!, participantSecondsPerMonth: 20 },
  });
  assert.equal((await f.store.get(f.m.code))!.ended, true);
});

for (const metering of [undefined, "meeting"] as const)
  test(`${metering ?? "participant"} phone moderation can rejoin after confirmed shared-leg removal; terminal phone cleanup cannot refund early`, async (t) => {
    const f = await fixture(t, 360000, now, metering);
    await f.store.change(f.m.code, (m) => {
      Object.assign(m.participants[0]!, {
        transport: "phone",
        phone: {
          callId: randomUUID(),
          trunkId: "fixture",
          muted: false,
          handRaised: false,
          leaseExpiresAt: now + 10000,
          callExpiresAt: now + 7200000,
        },
      });
    });
    await f.act(f.host, "first", "claim");
    await f.act(f.host, "first", "connected");
    t.mock.timers.tick(1000);
    await f.store.change(f.m.code, (m) => {
      m.participants[0]!.mediaVersion++;
      m.participants[0]!.enforcementPending = true;
    });
    await f.store.settleParticipantMeter(f.m.code, f.host.id, 2, {
      connectionId: "first",
      mediaVersion: 1,
    });
    await f.store.change(f.m.code, (m) => {
      m.participants[0]!.enforcementPending = false;
    });
    await f.act(f.host, "second", "claim", 2);
    await f.act(f.host, "second", "connected", 2);
    await f.store.change(f.m.code, (m) => {
      const p = m.participants[0]!;
      p.status = "left";
      p.mediaVersion++;
      p.enforcementPending = true;
      p.phone!.leaseExpiresAt = 0;
    });
    await f.store.settleParticipantMeter(f.m.code, f.host.id, 3, {
      connectionId: "second",
      mediaVersion: 2,
    });
    assert.ok((await f.store.get(f.m.code))!.participants[0]!.meter);
    assert.equal((await f.usage()).blocked, true);
    await f.store.change(f.m.code, (m) => {
      m.participants[0]!.enforcementPending = false;
      m.participants[0]!.phone!.closed = true;
    });
    await f.store.reconcileParticipantMeters(f.m.code);
    assert.equal(
      (await f.store.get(f.m.code))!.participants[0]!.meter,
      undefined,
    );
  });

test("an unfunded late guest cannot end or extend another participant's prepaid access", async (t) => {
  const f = await fixture(t, 31);
  await f.act(f.host, "host", "claim");
  await f.act(f.host, "host", "connected");
  await f.act(f.guest, "guest", "claim");
  await f.act(f.guest, "guest", "connected");
  t.mock.timers.tick(1000);
  await f.store.reconcileParticipantMeters(f.m.code);
  assert.equal((await f.store.get(f.m.code))!.ended, false);
  assert.equal((await f.usage()).blocked, true);
  for (let n = 0; n < 4; n++) {
    t.mock.timers.tick(5000);
    await f.act(f.host, "host", "heartbeat");
  }
  const current = (await f.store.get(f.m.code))!;
  assert.equal(current.ended, false);
  assert.equal(current.participants[0]!.meter!.fundedUntil, now + 30000);
  await f.store.checkUsage(f.m.code, f.host.id);
  await assert.rejects(
    f.act(f.guest, "replacement", "claim"),
    /Media access denied/,
  );
});

test("a delayed cleanup proof cannot refund a replacement with the same participant media version", async (t) => {
  const f = await fixture(t);
  await f.act(f.host, "old", "claim");
  await f.act(f.host, "old", "connected");
  await f.store.change(f.m.code, (m) => {
    const p = m.participants[0]!;
    p.mediaVersion = 2;
    p.enforcementPending = true;
  });
  await f.store.settleParticipantMeter(f.m.code, f.host.id, 2, {
    connectionId: "old",
    mediaVersion: 1,
  });
  await f.store.change(f.m.code, (m) => {
    m.participants[0]!.enforcementPending = false;
  });
  await f.act(f.host, "replacement", "claim", 2);
  await f.act(f.host, "replacement", "connected", 2);
  await f.store.settleParticipantMeter(f.m.code, f.host.id, 2, {
    connectionId: "old",
    mediaVersion: 1,
  });
  const p = (await f.store.get(f.m.code))!.participants[0]!;
  assert.equal(p.meter!.connectionId, "replacement");
  assert.equal(p.meter!.phase, "active");
  assert.equal((await f.usage()).participantSeconds.reserved, 30);
});

test("meeting mode funds one interval for host, audience and phone peers, including a breakout", async (t) => {
  const f = await fixture(t, 60, now, "meeting");
  const phone = {
    ...f.guest,
    id: randomUUID(),
    role: "viewer" as const,
    transport: "phone" as const,
    phone: {
      callId: randomUUID(),
      trunkId: "fixture",
      muted: true,
      handRaised: false,
      leaseExpiresAt: now + 60000,
      callExpiresAt: now + 60000,
    },
  };
  await f.store.change(f.m.code, (m) => {
    m.breakouts.push({ id: "breakout", name: "Room", room: randomUUID() });
    m.participants[1]!.breakoutId = "breakout";
    m.participants.push(phone);
  });
  for (const p of [f.host, f.guest, phone]) {
    await f.act(p, p.id, "claim");
    await f.act(p, p.id, "connected");
  }
  assert.deepEqual((await f.usage()).participantSeconds, {
    limit: 60,
    used: 0,
    reserved: 30,
    available: 30,
  });
  t.mock.timers.tick(10000);
  for (const p of [f.host, f.guest, phone]) await f.act(p, p.id, "heartbeat");
  const view = await f.usage();
  assert.equal(view.metering, "meeting");
  assert.equal(view.participantSeconds.used, 10);
  assert.equal(view.participantSeconds.reserved, 20);
  assert.equal(f.store.usageLedgers.get(f.owner)!.windows[0]!.usedMs, 0);
});

test("meeting mode admits peers against the same prepaid interval and stops the room at exhaustion", async (t) => {
  const f = await fixture(t, 30, now, "meeting");
  const claims = await Promise.allSettled([
    f.act(f.host, "host", "claim"),
    f.act(f.guest, "guest", "claim"),
  ]);
  assert.equal(claims.filter((r) => r.status === "fulfilled").length, 2);
  assert.equal((await f.usage()).participantSeconds.reserved, 30);
  await f.act(f.host, "host", "connected");
  await f.act(f.guest, "guest", "connected");
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(5000);
    await f.act(f.host, "host", "heartbeat");
    await f.act(f.guest, "guest", "heartbeat");
  }
  t.mock.timers.tick(5000);
  await f.store.reconcileParticipantMeters(f.m.code);
  const m = (await f.store.get(f.m.code))!;
  assert.equal(m.ended, true);
  for (const p of m.participants) {
    assert.equal(p.meter!.phase, "closing");
    await f.store.settleParticipantMeter(m.code, p.id, p.mediaVersion, p.meter);
  }
  assert.deepEqual((await f.usage()).participantSeconds, {
    limit: 30,
    used: 30,
    reserved: 0,
    available: 0,
  });
});

test("simultaneous meetings consume separate pooled intervals without attendee multiplication", async (t) => {
  const f = await fixture(t, 45, now, "meeting");
  const other = structuredClone(f.m);
  other.code = randomUUID();
  other.id = randomUUID();
  other.room = randomUUID();
  other.participants = [{ ...f.host, id: randomUUID() }];
  await f.store.create(other);
  const p = other.participants[0]!;
  for (const action of ["claim", "connected"] as const) {
    await Promise.all([
      f.act(f.host, "first", action),
      f.store.updateParticipantMeter(other.code, {
        participantId: p.id,
        mediaVersion: 1,
        connectionId: "second",
        action,
      }),
    ]);
  }
  assert.equal((await f.usage()).participantSeconds.reserved, 45);
  t.mock.timers.tick(10000);
  await f.act(f.host, "first", "heartbeat");
  const usage = await f.usage();
  assert.equal(usage.participantSeconds.used, 20);
  assert.equal(usage.participantSeconds.reserved, 25);
});

test("meeting reconnect and one peer cleanup preserve the shared reservation and newer connection", async (t) => {
  const f = await fixture(t, 90, now, "meeting");
  for (const [p, id] of [
    [f.host, "host"],
    [f.guest, "guest"],
  ] as const) {
    await f.act(p, id, "claim");
    await f.act(p, id, "connected");
  }
  t.mock.timers.tick(5000);
  await f.act(f.host, "successor", "claim");
  await f.act(f.host, "successor", "connected");
  await assert.rejects(
    f.act(f.host, "host", "heartbeat"),
    /connection changed/,
  );
  await f.store.change(f.m.code, (m) => {
    m.participants[1]!.mediaVersion++;
    m.participants[1]!.enforcementPending = true;
  });
  await f.store.reconcileParticipantMeters(f.m.code);
  assert.equal((await f.usage()).blocked, true);
  const guest = (await f.store.get(f.m.code))!.participants[1]!;
  await f.store.settleParticipantMeter(
    f.m.code,
    guest.id,
    guest.mediaVersion,
    guest.meter,
  );
  assert.equal((await f.usage()).participantSeconds.reserved, 25);
  assert.equal(
    (await f.store.get(f.m.code))!.participants[0]!.meter!.connectionId,
    "successor",
  );
  t.mock.timers.tick(5000);
  await f.act(f.host, "successor", "heartbeat");
  assert.equal((await f.usage()).participantSeconds.used, 10);
});

test("meeting mode preserves unused attempts and uncertain presence holds until exact cleanup", async (t) => {
  const f = await fixture(t, 30, now, "meeting");
  await f.act(f.host, "attempt", "claim");
  t.mock.timers.tick(16000);
  await f.store.reconcileParticipantMeters(f.m.code);
  const pending = await f.usage();
  assert.equal(pending.blocked, true);
  assert.deepEqual(pending.participantSeconds, {
    limit: 30,
    used: 0,
    reserved: 30,
    available: 0,
  });
  t.mock.timers.tick(60000);
  assert.deepEqual(
    (await f.usage()).participantSeconds,
    pending.participantSeconds,
  );
  const p = (await f.store.get(f.m.code))!.participants[0]!;
  await f.store.settleParticipantMeter(f.m.code, p.id, p.mediaVersion, p.meter);
  assert.deepEqual((await f.usage()).participantSeconds, {
    limit: 30,
    used: 0,
    reserved: 0,
    available: 30,
  });
  assert.equal((await f.store.get(f.m.code))!.meetingMeter, undefined);
});

test("meeting intervals split at the original monthly boundary", async (t) => {
  const boundary = Date.UTC(2026, 9, 31, 12);
  const f = await fixture(t, 60, boundary - 15000, "meeting");
  for (const p of [f.host, f.guest]) {
    await f.act(p, p.id, "claim");
    await f.act(p, p.id, "connected");
  }
  for (let i = 0; i < 2; i++) {
    t.mock.timers.tick(10000);
    for (const p of [f.host, f.guest]) await f.act(p, p.id, "heartbeat");
  }
  const ledger = f.store.usageLedgers.get(f.owner)!;
  assert.equal(
    ledger.windows.find((w) => w.end === boundary)!.meetingUsedMs,
    15000,
  );
  assert.equal((await f.usage()).participantSeconds.used, 5);
  assert.equal((await f.usage()).participantSeconds.reserved, 30);
});

test("one-way migration drains legacy access without relabeling history or resetting later meeting usage", async (t) => {
  const f = await fixture(t, 60);
  await f.act(f.host, "legacy", "claim");
  await f.act(f.host, "legacy", "connected");
  t.mock.timers.tick(5000);
  await f.act(f.host, "legacy", "heartbeat");
  const grant = {
    ...f.grant,
    revision: 2,
    quota: { ...f.grant.quota!, metering: "meeting" as const },
  };
  await f.store.setHostedEntitlement(grant);
  const legacy = (await f.store.get(f.m.code))!;
  assert.equal(legacy.ended, true);
  assert.equal((await f.usage()).metering, "meeting");
  assert.equal((await f.usage()).participantSeconds.used, 0);
  assert.equal((await f.usage()).blocked, true);
  const old = legacy.participants[0]!;
  await f.store.settleParticipantMeter(
    legacy.code,
    old.id,
    old.mediaVersion,
    old.meter,
  );
  assert.equal(f.store.usageLedgers.get(f.owner)!.windows[0]!.usedMs, 5000);
  const fresh = structuredClone(f.m);
  fresh.code = randomUUID();
  fresh.id = randomUUID();
  fresh.room = randomUUID();
  fresh.hosted!.entitlement = entitlementFor(grant, f.owner);
  await f.store.create(fresh);
  for (const action of ["claim", "connected"] as const)
    await f.store.updateParticipantMeter(fresh.code, {
      participantId: f.host.id,
      mediaVersion: 1,
      connectionId: "fresh",
      action,
    });
  t.mock.timers.tick(1000);
  assert.equal((await f.usage()).participantSeconds.used, 1);
  await f.store.setHostedEntitlement({ ...grant, revision: 3 });
  assert.equal((await f.usage()).participantSeconds.used, 1);
  await f.store.setHostedEntitlement({
    ...grant,
    revision: 4,
    enabled: false,
    quota: null,
  });
  assert.equal((await f.usage()).metering, "meeting");
  assert.equal((await f.usage()).participantSeconds.used, 1);
  await f.store.setHostedEntitlement({ ...grant, revision: 5 });
  await assert.rejects(
    f.store.setHostedEntitlement({ ...f.grant, revision: 6 }),
    /cannot revert/,
  );
  assert.equal((await f.usage()).participantSeconds.used, 1);
});
