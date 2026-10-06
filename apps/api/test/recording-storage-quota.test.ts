import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { EncryptedRecordingMetadata } from "@meeting-platform/recording";
import {
  entitlementSchema,
  type HostedEntitlement,
} from "../src/meeting-limits.js";
import { recordingContext } from "../src/recording-context.js";
import {
  MemoryStore,
  type Meeting,
  type Recording,
  type RecordingLock,
} from "../src/store.js";

const now = Date.UTC(2026, 9, 5, 12);
async function fixture(t: TestContext, limit = 1000) {
  t.mock.timers.enable({ apis: ["Date"], now });
  const store = new MemoryStore(),
    owner = randomUUID();
  const grant: HostedEntitlement = {
    billingOwnerId: owner,
    revision: 1,
    enabled: true,
    validUntil: now + 300000,
    quota: {
      anchorAt: Date.UTC(2024, 0, 31),
      participantSecondsPerMonth: 360000,
      recordingSecondsPerMonth: 3600,
      storageBytes: limit,
    },
    hostAccountIds: [owner],
    limits: { participants: 100, durationSeconds: 7200, concurrentMeetings: 2 },
  };
  await store.setHostedEntitlement(grant);
  const room = async () => {
    const m: Meeting = {
      id: randomUUID(),
      code: randomUUID(),
      room: randomUUID(),
      title: "Storage fixture",
      mode: "meeting",
      locked: false,
      ended: false,
      recordingAllowed: true,
      createdAt: now,
      revision: 1,
      passwordHash: "fixture",
      hostTokenExpiresAt: now + 300000,
      participants: [],
      bans: { ip: [], device: [] },
      breakouts: [],
      messages: [],
      recordings: [],
      lifecycle: { startedAt: now, deadlineAt: now + 7200000 },
      hosted: {
        accountId: owner,
        billingOwnerId: owner,
        version: 1,
        entitlement: { ...grant, allowed: true },
      },
    };
    await store.create(m);
    return m;
  };
  const m = await room();
  const lock = async <T>(
    r: Recording,
    fn: (lock: RecordingLock) => Promise<T>,
    meeting = m,
  ) => {
    const result = await store.withRecordingLock(meeting.code, r.id, fn);
    assert.equal(result.acquired, true);
    if (!result.acquired) throw new Error("Fixture lock unavailable");
    return result.value;
  };
  const reserve = (copies: 1 | 2 = 1, maxBytes = limit, meeting = m) => {
    const r = { id: randomUUID(), status: "starting", createdAt: now };
    return lock(
      r,
      (l) => l.reserveRecording(r, () => {}, { maxBytes, copies }),
      meeting,
    );
  };
  const metadata = (
    r: Recording,
    encryptedBytes: number,
    meeting = m,
  ): EncryptedRecordingMetadata => ({
    version: 1,
    context: recordingContext(meeting, r),
    recordingKeyId: randomUUID(),
    wrappedKey: {
      provider: "fixture",
      keyId: "fixture",
      ciphertext: "wrapped",
    },
    plaintextBytes: 1,
    encryptedBytes,
  });
  return {
    store,
    owner,
    grant,
    m,
    room,
    lock,
    reserve,
    metadata,
    usage: async () => (await store.hostedUsage(owner)).recordingStorageBytes,
  };
}

test("legacy recording metadata retains the installation context", async (t) => {
  const f = await fixture(t);
  const legacy = { id: randomUUID(), status: "ready" as const, createdAt: now };
  assert.equal(recordingContext(f.m, legacy).tenantId, "installation");
  assert.equal(
    recordingContext(f.m, { ...legacy, contextVersion: 1 }).tenantId,
    "installation",
  );
});

test("capture reserves both encrypted copies atomically and rejected starts persist no time or row", async (t) => {
  const f = await fixture(t),
    other = await f.room();
  const starts = await Promise.allSettled([
    f.reserve(2),
    f.reserve(2, 1000, other),
  ]);
  assert.equal(starts.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(starts.filter((r) => r.status === "rejected").length, 1);
  const winner = starts.find((r) => r.status === "fulfilled")!;
  if (winner.status !== "fulfilled") throw new Error("Missing winner");
  assert.equal(winner.value.storage!.maxBytes, 500);
  assert.deepEqual(
    winner.value.storage!.attempts.map((a) => a.kind),
    ["local", "s3"],
  );
  assert.deepEqual(await f.usage(), {
    limit: 1000,
    used: 0,
    reserved: 1000,
    available: 0,
  });
  assert.equal(
    (await f.store.hostedUsage(f.owner)).recordingSeconds!.reserved,
    30,
  );
  assert.equal(
    (await f.store.get(f.m.code))!.recordings.length +
      (await f.store.get(other.code))!.recordings.length,
    1,
  );
});

test("pending local attempts retain their ceiling until exact closed-writer cleanup, and late replay cannot reallocate", async (t) => {
  const f = await fixture(t),
    r = await f.reserve(),
    slot = r.storage!.attempts[0]!,
    metadata = f.metadata(r, 400);
  await f.lock(r, (l) =>
    l.prepareRecordingStorage(slot.id, { kind: "local", metadata }),
  );
  await f.lock(r, (l) => l.removeRecordingStorage(slot.id));
  assert.deepEqual(await f.usage(), {
    limit: 1000,
    used: 0,
    reserved: 1000,
    available: 0,
  });
  await assert.rejects(
    f.lock(r, (l) => l.releaseRecordingStorage(slot.id, { kind: "unused" })),
    /attempt changed/,
  );
  await assert.rejects(
    f.lock(r, (l) => l.reserveRecordingStorage("local")),
    /allowance is unavailable/,
  );
  const proof = {
    kind: "local" as const,
    metadata,
    receipt: { version: 1 as const, published: false, bytes: 120 },
    removed: true as const,
  };
  await assert.rejects(
    f.lock(r, (l) =>
      l.releaseRecordingStorage(slot.id, {
        ...proof,
        metadata: { ...metadata, recordingKeyId: randomUUID() },
      }),
    ),
    /attempt changed/,
  );
  await f.lock(r, (l) => l.releaseRecordingStorage(slot.id, proof));
  await f.lock(r, (l) => l.releaseRecordingStorage(slot.id, proof));
  assert.deepEqual(await f.usage(), {
    limit: 1000,
    used: 0,
    reserved: 0,
    available: 1000,
  });
  await assert.rejects(
    f.lock(r, (l) =>
      l.prepareRecordingStorage(slot.id, { kind: "local", metadata }),
    ),
    /attempt changed/,
  );
  const next = await f.lock(r, (l) => l.reserveRecordingStorage("local"));
  assert.notEqual(next.id, slot.id);
  assert.deepEqual(await f.usage(), {
    limit: 1000,
    used: 0,
    reserved: 1000,
    available: 0,
  });
});

test("retained local plus remote versions remain counted through removal until a verified fence", async (t) => {
  const f = await fixture(t),
    r = await f.reserve(2),
    [local, remote] = r.storage!.attempts;
  const metadata = f.metadata(r, 400),
    receipt = { version: 1 as const, published: true, bytes: 400 };
  await f.lock(r, (l) =>
    l.prepareRecordingStorage(local!.id, { kind: "local", metadata }),
  );
  await f.lock(r, (l) =>
    l.retainRecordingStorage(local!.id, { kind: "local", metadata, receipt }),
  );
  const intent = {
    provider: "s3-single" as const,
    storageId: "b".repeat(64),
    key: "owned/fixture",
    bytes: 400,
    sha256: "a".repeat(64),
  };
  await f.lock(r, (l) =>
    l.prepareRecordingStorage(remote!.id, { kind: "s3", metadata, intent }),
  );
  const reference = {
    provider: "s3" as const,
    key: intent.key,
    bytes: 400,
    sha256: intent.sha256,
    etag: "etag",
    versionId: "version-one",
  };
  await assert.rejects(
    f.lock(r, (l) =>
      l.retainRecordingStorage(remote!.id, {
        kind: "s3",
        metadata,
        reference: { ...reference, versionId: "null" },
      }),
    ),
    /attempt changed/,
  );
  await f.lock(r, (l) =>
    l.retainRecordingStorage(remote!.id, { kind: "s3", metadata, reference }),
  );
  assert.deepEqual(await f.usage(), {
    limit: 1000,
    used: 800,
    reserved: 0,
    available: 200,
  });
  await f.lock(r, (l) => l.removeRecordingStorage(local!.id));
  await f.lock(r, (l) =>
    l.releaseRecordingStorage(local!.id, {
      kind: "local",
      metadata,
      receipt,
      removed: true,
    }),
  );
  await f.lock(r, (l) => l.removeRecordingStorage(remote!.id));
  assert.deepEqual(await f.usage(), {
    limit: 1000,
    used: 400,
    reserved: 0,
    available: 600,
  });
  const fence = {
    provider: "s3-single" as const,
    storageId: intent.storageId,
    key: intent.key,
    etag: "fence",
    versionId: "fence-version",
    bytes: 0 as const,
    cleaned: true as const,
  };
  await assert.rejects(
    f.lock(r, (l) =>
      l.releaseRecordingStorage(remote!.id, {
        kind: "s3",
        metadata,
        fence: { ...fence, key: "other/key" },
      }),
    ),
    /attempt changed/,
  );
  await assert.rejects(
    f.lock(r, (l) =>
      l.releaseRecordingStorage(remote!.id, {
        kind: "s3",
        metadata,
        fence: { ...fence, storageId: "c".repeat(64) },
      }),
    ),
    /attempt changed/,
  );
  await f.lock(r, (l) =>
    l.releaseRecordingStorage(remote!.id, { kind: "s3", metadata, fence }),
  );
  assert.equal((await f.usage()).available, 1000);
});

test("month rollover, disabled grants, and downgrade never erase retained or unknown copies", async (t) => {
  const f = await fixture(t),
    r = await f.reserve(2),
    metadata = f.metadata(r, 400),
    local = r.storage!.attempts[0]!;
  await f.lock(r, (l) =>
    l.prepareRecordingStorage(local.id, { kind: "local", metadata }),
  );
  await f.lock(r, (l) =>
    l.retainRecordingStorage(local.id, {
      kind: "local",
      metadata,
      receipt: { version: 1, published: true, bytes: 400 },
    }),
  );
  t.mock.timers.tick(40 * 86400000);
  await f.store.setHostedEntitlement({
    ...f.grant,
    revision: 2,
    enabled: false,
    quota: { ...f.grant.quota!, storageBytes: 300 },
  });
  assert.deepEqual(await f.usage(), {
    limit: 300,
    used: 400,
    reserved: 500,
    available: 0,
  });
  await assert.rejects(
    f.lock(r, (l) => l.reserveRecordingStorage("local")),
    /allowance is unavailable/,
  );
  await f.lock(r, (l) => l.removeRecordingStorage(local.id));
  await f.lock(r, (l) =>
    l.releaseRecordingStorage(local.id, {
      kind: "local",
      metadata,
      receipt: { version: 1, published: true, bytes: 400 },
      removed: true,
    }),
  );
  assert.deepEqual(await f.usage(), {
    limit: 300,
    used: 0,
    reserved: 500,
    available: 0,
  });
});

test("unknown legacy inventory blocks new allocation and usage, while unbound capture stays outside paid storage", async (t) => {
  const f = await fixture(t),
    legacy = { id: randomUUID(), status: "deleted", createdAt: now };
  await f.store.change(f.m.code, (m) => {
    m.recordings.push(legacy);
  });
  await assert.rejects(f.usage(), { status: 503 });
  await assert.rejects(f.reserve(), /inventory is unavailable/);
  const unbound = await f.room();
  await f.store.change(unbound.code, (m) => {
    delete m.hosted;
  });
  const free = await f.reserve(1, 100, unbound);
  assert.equal(free.storage, undefined);
  assert.equal(free.timeReservation, undefined);
});

test("missing storage allowance or plan rejects paid capture and leaves existing resources intact", async (t) => {
  const f = await fixture(t);
  const r = { id: randomUUID(), status: "starting", createdAt: now };
  await assert.rejects(
    f.lock(r, (l) => l.reserveRecording(r, () => {})),
    { code: "RECORDING_STORAGE_QUOTA_UNAVAILABLE" },
  );
  await f.store.setHostedEntitlement({
    ...f.grant,
    revision: 2,
    quota: {
      anchorAt: f.grant.quota!.anchorAt,
      participantSecondsPerMonth: 360000,
      recordingSecondsPerMonth: 3600,
    },
  });
  await assert.rejects(f.reserve(), {
    code: "RECORDING_STORAGE_QUOTA_UNAVAILABLE",
  });
  assert.equal((await f.store.get(f.m.code))!.recordings.length, 0);
  assert.equal(
    (await f.store.hostedUsage(f.owner)).recordingSeconds!.reserved,
    0,
  );
});

test("prepared evidence and completed byte counts cannot be replaced or exceed their reservation", async (t) => {
  const f = await fixture(t),
    r = await f.reserve(),
    slot = r.storage!.attempts[0]!,
    metadata = f.metadata(r, 400);
  await assert.rejects(
    f.lock(r, (l) =>
      l.prepareRecordingStorage(slot.id, {
        kind: "local",
        metadata: { ...metadata, encryptedBytes: 1001 },
      }),
    ),
    /attempt changed/,
  );
  await f.lock(r, (l) =>
    l.prepareRecordingStorage(slot.id, { kind: "local", metadata }),
  );
  await assert.rejects(
    f.lock(r, (l) =>
      l.prepareRecordingStorage(slot.id, {
        kind: "local",
        metadata: { ...metadata, recordingKeyId: randomUUID() },
      }),
    ),
    /attempt changed/,
  );
  await assert.rejects(
    f.lock(r, (l) =>
      l.retainRecordingStorage(slot.id, {
        kind: "local",
        metadata,
        receipt: { version: 1, published: true, bytes: 399 },
      }),
    ),
    /attempt changed/,
  );
  assert.equal((await f.usage()).reserved, 1000);
  await f.lock(r, (l) =>
    l.retainRecordingStorage(slot.id, {
      kind: "local",
      metadata,
      receipt: { version: 1, published: true, bytes: 400 },
    }),
  );
  await assert.rejects(
    f.lock(r, (l) =>
      l.retainRecordingStorage(slot.id, {
        kind: "local",
        metadata,
        receipt: { version: 1, published: false, bytes: 399 },
      }),
    ),
    /attempt changed/,
  );
  assert.equal((await f.usage()).used, 400);
});

test("storage grants are bounded and same-revision allowance changes conflict", async (t) => {
  const f = await fixture(t);
  for (const limit of [-1, 0.5, 1_000_000_000_001])
    assert.equal(
      entitlementSchema.safeParse({
        ...f.grant,
        quota: { ...f.grant.quota!, storageBytes: limit },
      }).success,
      false,
    );
  assert.equal(
    entitlementSchema.safeParse({
      ...f.grant,
      quota: { ...f.grant.quota!, storageBytes: 1_000_000_000_000 },
    }).success,
    true,
  );
  await assert.rejects(
    f.store.setHostedEntitlement({
      ...f.grant,
      quota: { ...f.grant.quota!, storageBytes: 1001 },
    }),
    /revision conflicts/,
  );
});
