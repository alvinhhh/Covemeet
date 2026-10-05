import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import {
  entitlementSchema,
  type HostedEntitlement,
} from "../src/meeting-limits.js";
import { HttpError } from "../src/security.js";
import { MemoryStore, type Meeting } from "../src/store.js";

const now = Date.UTC(2026, 9, 5, 12);
const anchorAt = Date.UTC(2024, 0, 31, 12);
async function fixture(
  t: TestContext,
  allowance: number | undefined = 100,
  at = now,
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
      participantSecondsPerMonth: 360000,
      ...(allowance === undefined ? {} : { downloadBytesPerMonth: allowance }),
    },
    hostAccountIds: [owner],
    limits: { participants: 100, durationSeconds: 7200, concurrentMeetings: 1 },
  };
  await store.setHostedEntitlement(grant);
  const m: Meeting = {
    hosted: { accountId: randomUUID(), billingOwnerId: owner, version: 1 },
    code: randomUUID(),
    id: randomUUID(),
    room: randomUUID(),
    title: "Synthetic recording allowance fixture",
    mode: "meeting",
    locked: false,
    ended: true,
    recordingAllowed: false,
    createdAt: at,
    revision: 1,
    passwordHash: "fixture",
    hostTokenExpiresAt: at,
    participants: [],
    bans: { ip: [], device: [] },
    breakouts: [],
    messages: [],
    recordings: [
      {
        id: "recording",
        status: "ready",
        passwordHash: "initial",
        storage: { billingOwnerId: owner, maxBytes: 100, attempts: [] },
      },
    ],
  };
  await store.create(m);
  const debit = (bytes: number, authorize: (m: Meeting) => void = () => {}) =>
    store.debitRecordingDownload(m.code, bytes, authorize);
  return {
    store,
    owner,
    grant,
    m,
    debit,
    usage: () => store.hostedUsage(owner),
  };
}

test("concurrent whole-file starts share the original owner allowance and each retry counts again", async (t) => {
  const f = await fixture(t);
  const otherRoom = {
    ...structuredClone(f.m),
    code: randomUUID(),
    id: randomUUID(),
    room: randomUUID(),
  };
  await f.store.create(otherRoom);
  const starts = await Promise.allSettled([
    f.debit(60),
    f.store.debitRecordingDownload(otherRoom.code, 60, () => {}),
  ]);
  assert.equal(
    starts.filter((result) => result.status === "fulfilled").length,
    1,
  );
  assert.deepEqual((await f.usage()).recordingDownloadBytes, {
    limit: 100,
    used: 60,
    available: 40,
  });
  await f.debit(20);
  await f.debit(20);
  await assert.rejects(f.debit(1), {
    code: "RECORDING_DOWNLOAD_QUOTA_UNAVAILABLE",
  });
  assert.deepEqual((await f.usage()).recordingDownloadBytes, {
    limit: 100,
    used: 100,
    available: 0,
  });
  assert.deepEqual((await f.usage()).participantSeconds, {
    limit: 360000,
    used: 0,
    reserved: 0,
    available: 360000,
  });
  assert.equal((await f.store.get(f.m.code))!.hosted!.billingOwnerId, f.owner);
});

test("latest authorization, revocation and invalid file sizes fail without debiting", async (t) => {
  const f = await fixture(t);
  await f.store.change(f.m.code, (m) => {
    m.recordings[0]!.passwordHash = "changed";
  });
  await assert.rejects(
    f.debit(50, (m) => {
      assert.equal(m.recordings[0]!.passwordHash, "changed");
      throw new HttpError(403, "Recording access denied");
    }),
    /Recording access denied/,
  );
  for (const bytes of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
    await assert.rejects(f.debit(bytes), /Recording size is unavailable/);
  await f.store.change(f.m.code, (m) => {
    m.hosted!.revoked = true;
  });
  await assert.rejects(f.debit(50), /Recording access denied/);
  assert.equal((await f.usage()).recordingDownloadBytes.used, 0);
});

test("ended recordings retain allowance after grant cancellation and expiry, with no refund or reset", async (t) => {
  const f = await fixture(t);
  await f.debit(40); // A caller's subsequent socket cancellation cannot refund this start.
  await f.store.setHostedEntitlement({
    ...f.grant,
    revision: 2,
    enabled: false,
    validUntil: now - 1,
    hostAccountIds: [],
  });
  assert.equal((await f.usage()).blocked, true);
  await f.debit(30);
  await f.store.setHostedEntitlement({
    ...f.grant,
    revision: 3,
    quota: { ...f.grant.quota!, downloadBytesPerMonth: 50 },
  });
  assert.deepEqual((await f.usage()).recordingDownloadBytes, {
    limit: 50,
    used: 70,
    available: 0,
  });
  await assert.rejects(f.debit(1), /download allowance is unavailable/);
  await f.store.setHostedEntitlement({ ...f.grant, revision: 4 });
  assert.deepEqual((await f.usage()).recordingDownloadBytes, {
    limit: 100,
    used: 70,
    available: 30,
  });
});

test("missing download quota denies bound downloads while legacy counters remain readable", async (t) => {
  const f = await fixture(t);
  const { downloadBytesPerMonth: _unused, ...quota } = f.grant.quota!;
  await f.store.setHostedEntitlement({ ...f.grant, revision: 2, quota });
  assert.deepEqual((await f.usage()).recordingDownloadBytes, {
    limit: 0,
    used: 0,
    available: 0,
  });
  await assert.rejects(f.debit(1), /download allowance is unavailable/);
  f.store.usageLedgers.delete(f.owner);
  await assert.rejects(f.debit(1), /Usage unavailable/);
});

test("downloads use the pinned UTC anniversary, including leap day, without carrying unused bytes", async (t) => {
  const boundary = Date.UTC(2024, 1, 29, 12);
  const f = await fixture(t, 100, boundary - 1);
  await f.debit(70);
  t.mock.timers.tick(1);
  await f.debit(40);
  const usage = await f.usage();
  assert.deepEqual(usage.window, {
    start: boundary,
    end: Date.UTC(2024, 2, 31, 12),
  });
  assert.deepEqual(usage.recordingDownloadBytes, {
    limit: 100,
    used: 40,
    available: 60,
  });
  assert.equal(
    f.store.usageLedgers.get(f.owner)!.windows.find((w) => w.end === boundary)!
      .recordingDownloadBytesUsed,
    70,
  );
  await assert.rejects(
    f.store.setHostedEntitlement({
      ...f.grant,
      revision: 2,
      enabled: false,
      quota: { ...f.grant.quota!, anchorAt: anchorAt + 1 },
    }),
    /anniversary cannot change/,
  );
});

test("unbound rooms still authorize but do not need a hosted quota", async (t) => {
  const f = await fixture(t);
  await f.store.change(f.m.code, (m) => {
    delete m.hosted;
  });
  let checks = 0;
  await f.debit(1000, () => {
    checks++;
  });
  assert.equal(checks, 1);
  await assert.rejects(
    f.debit(1000, () => {
      throw new HttpError(403, "Wrong recording password");
    }),
    /Wrong recording password/,
  );
  assert.equal((await f.usage()).recordingDownloadBytes.used, 0);
});

test("download grants reject invalid limits and a changed same-revision allowance", async (t) => {
  const f = await fixture(t);
  for (const value of [-1, 0.5, 1e12 + 1])
    assert.equal(
      entitlementSchema.safeParse({
        ...f.grant,
        quota: { ...f.grant.quota!, downloadBytesPerMonth: value },
      }).success,
      false,
    );
  assert.equal(
    entitlementSchema.safeParse({
      ...f.grant,
      quota: { ...f.grant.quota!, downloadBytesPerMonth: 1e12 },
    }).success,
    true,
  );
  await assert.rejects(
    f.store.setHostedEntitlement({
      ...f.grant,
      quota: { ...f.grant.quota!, downloadBytesPerMonth: 99 },
    }),
    /revision conflicts/,
  );
  await f.debit(1);
  assert.equal((await f.usage()).recordingDownloadBytes.used, 1);
});
