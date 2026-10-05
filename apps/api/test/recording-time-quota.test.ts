import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  entitlementSchema,
  type HostedEntitlement,
} from "../src/meeting-limits.js";
import { HttpError } from "../src/security.js";
import {
  MemoryStore,
  type Meeting,
  type Recording,
  type RecordingLock,
} from "../src/store.js";

const now = Date.UTC(2026, 9, 5, 12);
const anchorAt = Date.UTC(2024, 0, 31, 12);

async function fixture(t: TestContext, allowance = 90, at = now) {
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
      participantSecondsPerMonth: 360000,
      downloadBytesPerMonth: 100,
      recordingSecondsPerMonth: allowance,
    },
    hostAccountIds: [owner],
    limits: { participants: 100, durationSeconds: 7200, concurrentMeetings: 2 },
  };
  await store.setHostedEntitlement(grant);
  const room = async () => {
    const m: Meeting = {
      hosted: {
        accountId: owner,
        billingOwnerId: owner,
        version: 1,
        entitlement: { ...grant, allowed: true },
      },
      code: randomUUID(),
      id: randomUUID(),
      room: randomUUID(),
      title: "Synthetic recording-time fixture",
      mode: "meeting",
      locked: false,
      ended: false,
      recordingAllowed: true,
      createdAt: at,
      revision: 1,
      passwordHash: "fixture",
      hostTokenExpiresAt: at + 300000,
      lifecycle: { startedAt: at, deadlineAt: at + 7200000 },
      participants: [],
      bans: { ip: [], device: [] },
      breakouts: [],
      messages: [],
      recordings: [],
    };
    await store.create(m);
    return m;
  };
  const m = await room();
  const lock = async <T>(
    id: string,
    work: (lock: RecordingLock) => Promise<T>,
    current = m,
  ) => {
    const result = await store.withRecordingLock(current.code, id, work);
    assert.equal(result.acquired, true);
    if (!result.acquired) throw new Error("Fixture lock not acquired");
    return result.value;
  };
  const reserve = (
    id = randomUUID(),
    current = m,
    authorize: (m: Meeting) => void = () => {},
  ) =>
    lock(
      id,
      (l) =>
        l.reserveRecording(
          { id, status: "starting", createdAt: Date.now() },
          authorize,
        ),
      current,
    );
  const observe = (
    r: Recording,
    proof: Parameters<RecordingLock["observeRecordingTime"]>[0],
    current = m,
  ) => lock(r.id, (l) => l.observeRecordingTime(proof), current);
  return {
    store,
    owner,
    grant,
    m,
    room,
    lock,
    reserve,
    observe,
    usage: async () => (await store.hostedUsage(owner)).recordingSeconds,
  };
}

test("concurrent recordings reserve a shared owner allowance before persisting a start", async (t) => {
  const f = await fixture(t, 30),
    other = await f.room();
  const starts = await Promise.allSettled([
    f.reserve(),
    f.reserve(randomUUID(), other),
  ]);
  assert.equal(starts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(starts.filter((r) => r.status === "rejected").length, 1);
  assert.deepEqual(await f.usage(), {
    limit: 30,
    used: 0,
    reserved: 30,
    available: 0,
  });
  assert.equal(
    (await f.store.get(f.m.code))!.recordings.length +
      (await f.store.get(other.code))!.recordings.length,
    1,
  );
});

test("authorization runs on the current meeting and missing quota never creates a reservation", async (t) => {
  const f = await fixture(t);
  await f.store.change(f.m.code, (m) => {
    m.recordingAllowed = false;
  });
  f.store.usageLedgers.delete(f.owner);
  await assert.rejects(
    f.reserve(randomUUID(), f.m, (m) => {
      assert.equal(m.recordingAllowed, false);
      throw new HttpError(403, "Recording disabled");
    }),
    { status: 403 },
  );
  assert.equal((await f.store.get(f.m.code))!.recordings.length, 0);
  await f.store.setHostedEntitlement({
    ...f.grant,
    revision: 2,
    quota: { anchorAt, participantSecondsPerMonth: 360000 },
  });
  await f.store.change(f.m.code, (m) => {
    m.recordingAllowed = true;
  });
  await assert.rejects(f.reserve(), {
    code: "RECORDING_TIME_QUOTA_UNAVAILABLE",
  });
  assert.deepEqual(await f.usage(), {
    limit: 0,
    used: 0,
    reserved: 0,
    available: 0,
  });
});

test("active observations reserve time; an earlier terminal end settles exactly once across the status-commit boundary", async (t) => {
  const f = await fixture(t),
    r = await f.reserve();
  const job = { egressId: "job-one", startedAt: now };
  t.mock.timers.tick(20000);
  await f.observe(r, { ...job, terminal: false });
  assert.deepEqual(await f.usage(), {
    limit: 90,
    used: 0,
    reserved: 50,
    available: 40,
  });
  const terminal = { ...job, terminal: true as const, endedAt: now + 12345 };
  await f.observe(r, terminal);
  assert.deepEqual(await f.usage(), {
    limit: 90,
    used: 13,
    reserved: 0,
    available: 77,
  });
  const check = await f.lock(r.id, (l) => l.checkRecordingTime());
  assert.equal(check.mustStop, true);
  assert.equal(check.recording.status, "stopping");
  await assert.rejects(
    f.observe(r, { ...job, terminal: false }),
    /settlement changed/,
  );
  await assert.rejects(
    f.observe(r, { ...terminal, endedAt: now + 12000 }),
    /settlement changed/,
  );
  await assert.rejects(
    f.observe(r, { ...terminal, egressId: "other-job" }),
    /job changed/,
  );
  assert.equal((await f.observe(r, terminal)).mustStop, false);
  assert.equal(
    f.store.usageLedgers.get(f.owner)!.windows[0]!.recordingUsedMs,
    12345,
  );
});

test("unknown start and stop outcomes retain overdue holds and block new recording allocation only", async (t) => {
  const f = await fixture(t),
    r = await f.reserve(),
    other = await f.room();
  t.mock.timers.tick(45000);
  const expired = await f.lock(r.id, (l) => l.checkRecordingTime());
  assert.equal(expired.mustStop, true);
  assert.equal(expired.recording.status, "stopping");
  assert.deepEqual(await f.usage(), {
    limit: 90,
    used: 0,
    reserved: 45,
    available: 45,
  });
  await assert.rejects(
    f.reserve(randomUUID(), other),
    /Recording-time allowance is unavailable/,
  );
  await f.store.debitRecordingDownload(other.code, 10, () => {});
  assert.equal((await f.store.hostedUsage(f.owner)).blocked, false);
  assert.equal(
    (await f.store.hostedUsage(f.owner)).recordingDownloadBytes.used,
    10,
  );
  await f.observe(r, {
    egressId: "unknown-start-recovered",
    terminal: true,
    startedAt: now + 1000,
    endedAt: now + 35000,
  });
  assert.deepEqual(await f.usage(), {
    limit: 90,
    used: 34,
    reserved: 0,
    available: 56,
  });
  await f.reserve(randomUUID(), other);
});

test("provisional start changes cannot release holds; the final exact-job interval settles once", async (t) => {
  const f = await fixture(t),
    r = await f.reserve();
  t.mock.timers.tick(5000);
  await f.observe(r, {
    egressId: "stable-job",
    terminal: false,
    startedAt: now + 1000,
  });
  const before = await f.usage();
  const deadline = (await f.store.get(f.m.code))!.recordings[0]!
    .timeReservation!.fundedUntil;
  await f.observe(r, {
    egressId: "stable-job",
    terminal: false,
    startedAt: now + 2000,
  });
  assert.deepEqual(
    await f.usage(),
    before,
    "A later provisional start does not refund held time",
  );
  let held = (await f.store.get(f.m.code))!.recordings[0]!.timeReservation!;
  assert.equal(held.startedAt, now + 1000);
  assert.equal(held.fundedUntil, deadline);
  for (const end of [0, now + 6000, now + 0.5, NaN])
    await assert.rejects(
      f.observe(r, {
        egressId: "stable-job",
        terminal: true,
        startedAt: now + 1000,
        endedAt: end,
      }),
      /evidence is unavailable/,
    );
  assert.deepEqual(await f.usage(), before);
  await f.observe(r, {
    egressId: "stable-job",
    terminal: false,
    startedAt: now + 500,
  });
  held = (await f.store.get(f.m.code))!.recordings[0]!.timeReservation!;
  assert.equal(
    held.startedAt,
    now + 500,
    "Earlier observations conservatively increase the held interval",
  );
  assert.equal(held.fundedUntil, deadline);
  // The real provider's child pipeline revised the initial start by 262ms.
  const terminal = {
    egressId: "stable-job",
    terminal: true as const,
    startedAt: now + 1262,
    endedAt: now + 4000,
  };
  await f.observe(r, terminal);
  assert.deepEqual(await f.usage(), {
    limit: 90,
    used: 3,
    reserved: 0,
    available: 87,
  });
  await f.observe(r, terminal);
  assert.equal(
    f.store.usageLedgers.get(f.owner)!.windows[0]!.recordingUsedMs,
    2738,
  );
  await assert.rejects(
    f.observe(r, { ...terminal, startedAt: now + 1000 }),
    /settlement changed/,
  );
  assert.equal(
    f.store.usageLedgers.get(f.owner)!.windows[0]!.recordingUsedMs,
    2738,
  );
});

test("unknown and settled intervals split at the original leap-day anniversary without carrying time", async (t) => {
  const boundary = Date.UTC(2024, 1, 29, 12),
    at = boundary - 10000;
  const f = await fixture(t, 90, at),
    r = await f.reserve();
  assert.deepEqual(await f.usage(), {
    limit: 90,
    used: 0,
    reserved: 10,
    available: 80,
  });
  t.mock.timers.tick(45000);
  assert.deepEqual(await f.usage(), {
    limit: 90,
    used: 0,
    reserved: 35,
    available: 55,
  });
  await f.observe(r, {
    egressId: "cross-month",
    terminal: true,
    startedAt: at,
    endedAt: boundary + 25000,
  });
  assert.deepEqual(await f.usage(), {
    limit: 90,
    used: 25,
    reserved: 0,
    available: 65,
  });
  const ledger = f.store.usageLedgers.get(f.owner)!;
  assert.equal(
    ledger.windows.find((w) => w.end === boundary)!.recordingUsedMs,
    10000,
  );
  assert.equal(
    (await f.store.hostedUsage(f.owner)).window.end,
    Date.UTC(2024, 2, 31, 12),
  );
  await assert.rejects(
    f.store.setHostedEntitlement({
      ...f.grant,
      revision: 2,
      quota: { ...f.grant.quota!, anchorAt: anchorAt + 1 },
    }),
    /anniversary cannot change/,
  );
});

test("downgrades stop capture and terminal overrun remains used instead of being capped or refunded", async (t) => {
  const f = await fixture(t),
    r = await f.reserve();
  await f.store.setHostedEntitlement({
    ...f.grant,
    revision: 2,
    quota: { ...f.grant.quota!, recordingSecondsPerMonth: 10 },
  });
  assert.equal(
    (await f.lock(r.id, (l) => l.checkRecordingTime())).mustStop,
    true,
  );
  t.mock.timers.tick(45000);
  await f.observe(r, {
    egressId: "late-stop",
    terminal: true,
    startedAt: now,
    endedAt: now + 40000,
  });
  assert.deepEqual(await f.usage(), {
    limit: 10,
    used: 40,
    reserved: 0,
    available: 0,
  });
  await f.store.setHostedEntitlement({ ...f.grant, revision: 3 });
  assert.deepEqual(await f.usage(), {
    limit: 90,
    used: 40,
    reserved: 0,
    available: 50,
  });
});

test("legacy bound capture stops with retained uncertainty; self-hosted capture needs no paid ledger", async (t) => {
  const f = await fixture(t);
  const legacy = {
    id: "legacy-recording",
    status: "recording",
    createdAt: now - 10000,
    egressId: "legacy-job",
  };
  await f.store.change(f.m.code, (m) => {
    m.recordings.push(legacy);
  });
  const checked = await f.lock(legacy.id, (l) => l.checkRecordingTime());
  assert.equal(checked.mustStop, true);
  assert.equal(
    checked.recording.timeReservation!.reservedFrom,
    legacy.createdAt,
  );
  assert.equal((await f.usage()).reserved, 10);
  const unbound = await f.room();
  await f.store.change(unbound.code, (m) => {
    delete m.hosted;
  });
  const free = await f.reserve(randomUUID(), unbound);
  assert.equal(free.timeReservation, undefined);
  assert.equal(
    (await f.lock(free.id, (l) => l.checkRecordingTime(), unbound)).mustStop,
    false,
  );
  assert.equal((await f.usage()).reserved, 10);
});

test("grant recording limits are bounded and same-revision changes are rejected", async (t) => {
  const f = await fixture(t);
  for (const limit of [-1, 0.1, 360001])
    assert.equal(
      entitlementSchema.safeParse({
        ...f.grant,
        quota: { ...f.grant.quota!, recordingSecondsPerMonth: limit },
      }).success,
      false,
    );
  assert.equal(
    entitlementSchema.safeParse({
      ...f.grant,
      quota: { ...f.grant.quota!, recordingSecondsPerMonth: 360000 },
    }).success,
    true,
  );
  await assert.rejects(
    f.store.setHostedEntitlement({
      ...f.grant,
      quota: { ...f.grant.quota!, recordingSecondsPerMonth: 91 },
    }),
    /revision conflicts/,
  );
});

test("legacy capture with missing usage history still stops without fabricating a ledger", async (t) => {
  const f = await fixture(t);
  const legacy = {
    id: "missing-ledger",
    status: "recording",
    createdAt: now - 10000,
    egressId: "known-job",
  };
  await f.store.change(f.m.code, (m) => {
    m.recordings.push(legacy);
  });
  f.store.usageLedgers.delete(f.owner);
  const checked = await f.lock(legacy.id, (l) => l.checkRecordingTime());
  assert.equal(checked.mustStop, true);
  assert.equal(
    (await f.store.get(f.m.code))!.recordings[0]!.status,
    "stopping",
  );
  assert.equal(f.store.usageLedgers.has(f.owner), false);
  await assert.rejects(
    f.observe(legacy, {
      egressId: "known-job",
      terminal: true,
      startedAt: now - 10000,
      endedAt: now,
    }),
    /usage is unavailable/,
  );
  assert.equal(
    (await f.store.get(f.m.code))!.recordings[0]!.timeReservation!.settled,
    undefined,
  );
});
