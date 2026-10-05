import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  access,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { Readable } from "node:stream";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Transporter } from "nodemailer";
import {
  EgressInfo,
  EgressStatus,
  RoomCompositeEgressRequest,
  type EncodedFileOutput,
} from "livekit-server-sdk";
import {
  LocalKeyProvider,
  type RecordingObjectReference,
  type RecordingObjectStorage,
} from "@meeting-platform/recording";
import { loadConfig } from "../src/config.js";
import { RecordingService, type RecorderClient } from "../src/recordings.js";
import { MemoryStore, type Meeting } from "../src/store.js";
import { HttpError } from "../src/security.js";

const unavailable = (error: unknown) =>
  error instanceof HttpError && error.status === 503;

async function fixture(t: TestContext, timestamped = false) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "meeting-recorder-start-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-longer-than-32-characters",
    RECORDING_ENABLED: "true",
    RECORDING_KEK: randomBytes(32).toString("base64"),
    RECORDING_DIR: directory,
    EGRESS_FILE_ROOT: "/recordings",
    LIVEKIT_API_KEY: "test-key",
    LIVEKIT_API_SECRET: "test-secret",
    SMTP_HOST: "unused.test",
  });
  const store = new MemoryStore();
  const meeting: Meeting = {
    id: randomUUID(),
    code: randomBytes(16).toString("hex"),
    room: `m_${randomUUID()}`,
    title: "Failure injection",
    mode: "meeting",
    locked: false,
    ended: false,
    recordingAllowed: true,
    createdAt: Date.now(),
    revision: 1,
    passwordHash: "unused",
    hostTokenExpiresAt: 0,
    participants: [],
    bans: { ip: [], device: [] },
    breakouts: [],
    messages: [],
    recordings: [],
    hostEmail: "host@example.test",
    hostEmailVerified: true,
  };
  await store.create(meeting);
  const jobs: EgressInfo[] = [];
  const stops: string[] = [];
  const controls = {
    startTimeout: false,
    stopFailures: 0,
    listFailures: 0,
    listOverride: undefined as EgressInfo[] | undefined,
  };
  const client = {
    async startRoomCompositeEgress(room: string, output: EncodedFileOutput) {
      const info = new EgressInfo({
        egressId: `EG_${randomUUID()}`,
        roomName: room,
        status: EgressStatus.EGRESS_ACTIVE,
        startedAt: timestamped ? BigInt(Date.now()) * 1_000_000n : 0n,
        updatedAt: timestamped ? BigInt(Date.now()) * 1_000_000n : 0n,
        request: {
          case: "roomComposite",
          value: new RoomCompositeEgressRequest({
            roomName: room,
            fileOutputs: [output],
          }),
        },
      });
      jobs.push(info);
      if (controls.startTimeout)
        throw new Error("RPC acknowledgement lost after recorder started");
      return info;
    },
    async stopEgress(id: string) {
      stops.push(id);
      if (controls.stopFailures > 0) {
        controls.stopFailures--;
        throw new Error("Recorder temporarily unreachable");
      }
      return jobs.find((job) => job.egressId === id)!;
    },
    async listEgress(options?: { egressId?: string; roomName?: string }) {
      if (controls.listFailures > 0) {
        controls.listFailures--;
        throw new Error("Recorder listing temporarily unreachable");
      }
      return (
        controls.listOverride ??
        jobs.filter(
          (job) =>
            (!options?.egressId || job.egressId === options.egressId) &&
            (!options?.roomName || job.roomName === options.roomName),
        )
      );
    },
  } as unknown as RecorderClient;
  const service = new RecordingService(
    config,
    store,
    {} as Transporter,
    client,
  );
  const row = async () => (await store.get(meeting.code))!.recordings[0]!;
  const reconcile = async () =>
    service.reconcile((await store.get(meeting.code))!);
  return {
    directory,
    config,
    store,
    meeting,
    jobs,
    stops,
    controls,
    service,
    client,
    row,
    reconcile,
  };
}

async function hostedFixture(
  t: TestContext,
  seconds = 90,
  storageBytes = 3_000_000_000,
) {
  const now = Date.UTC(2026, 9, 5, 12);
  t.mock.timers.enable({ apis: ["Date"], now });
  const f = await fixture(t, true);
  const owner = randomUUID();
  await f.store.change(f.meeting.code, (m) => {
    m.hosted = { accountId: owner, billingOwnerId: owner, version: 1 };
  });
  await f.store.setHostedEntitlement({
    billingOwnerId: owner,
    revision: 1,
    enabled: true,
    validUntil: now + 300_000,
    hostAccountIds: [owner],
    limits: { participants: 100, durationSeconds: 7200, concurrentMeetings: 2 },
    quota: {
      anchorAt: Date.UTC(2026, 8, 5, 12),
      participantSecondsPerMonth: 360_000,
      recordingSecondsPerMonth: seconds,
      storageBytes,
    },
  });
  await f.store.change(f.meeting.code, (m) => {
    m.lifecycle = { startedAt: now, deadlineAt: now + 7_200_000 };
  });
  const current = () => f.store.get(f.meeting.code) as Promise<Meeting>;
  const usage = async () => (await f.store.hostedUsage(owner)).recordingSeconds;
  const another = async () => {
    const m = structuredClone(await current());
    m.id = randomUUID();
    m.code = randomBytes(16).toString("hex");
    m.room = `m_${randomUUID()}`;
    m.recordings = [];
    await f.store.create(m);
    return m;
  };
  return { ...f, now, owner, current, usage, another };
}

test("hosted ciphertext is accounted through key rotation and failed retention cleanup", async (t) => {
  const f = await hostedFixture(t, 90, 2000);
  await f.service.start(await f.current());
  const id = (await f.row()).id;
  await writeFile(
    path.join(f.directory, "raw", `${id}.mp4`),
    Buffer.alloc(400, 42),
    { mode: 0o600 },
  );
  f.jobs[0]!.status = EgressStatus.EGRESS_COMPLETE;
  f.jobs[0]!.endedAt = BigInt(f.now + 1000) * 1_000_000n;
  t.mock.timers.tick(2000);
  await f.reconcile();
  const ready = await f.row();
  assert.equal(ready.status, "ready");
  const bytes = ready.metadata.encryptedBytes;
  assert.deepEqual((await f.store.hostedUsage(f.owner)).recordingStorageBytes, {
    limit: 2000,
    used: bytes,
    reserved: 0,
    available: 2000 - bytes,
  });
  const encrypted = path.join(
    f.directory,
    "encrypted",
    `${id}.${ready.ciphertextId}.mprec`,
  );
  await access(`${encrypted}.closed`);
  await assert.rejects(access(path.join(f.directory, "raw", `${id}.mp4`)));
  await f.service.rotateKey(await f.current(), id);
  assert.equal(
    (await f.store.hostedUsage(f.owner)).recordingStorageBytes.used,
    bytes,
  );
  t.mock.timers.tick(8 * 86400000);
  const service = f.service as unknown as {
    removeFile(file: string): Promise<void>;
  };
  const remove = service.removeFile.bind(service);
  service.removeFile = async (file) => {
    if (file === encrypted) throw new Error("Synthetic local removal failure");
    return remove(file);
  };
  await f.reconcile();
  assert.equal((await f.row()).status, "deleting");
  assert.ok((await f.row()).metadata);
  assert.equal(
    (await f.store.hostedUsage(f.owner)).recordingStorageBytes.used,
    bytes,
  );
  service.removeFile = remove;
  await f.reconcile();
  assert.equal((await f.row()).status, "deleted");
  assert.equal((await f.row()).metadata, undefined);
  assert.equal(
    (await f.store.hostedUsage(f.owner)).recordingStorageBytes.available,
    2000,
  );
  await assert.rejects(access(encrypted));
  await access(`${encrypted}.closed`);
});

test("closed owned ciphertext recovers after the selected metadata commit is lost without a second allocation", async (t) => {
  const f = await hostedFixture(t, 90, 2000);
  await f.service.start(await f.current());
  const id = (await f.row()).id;
  await writeFile(
    path.join(f.directory, "raw", `${id}.mp4`),
    Buffer.alloc(400, 42),
    { mode: 0o600 },
  );
  f.jobs[0]!.status = EgressStatus.EGRESS_COMPLETE;
  f.jobs[0]!.endedAt = BigInt(f.now + 1000) * 1_000_000n;
  t.mock.timers.tick(2000);
  await f.service.reconcile(await f.current(), "capture");
  const original = f.store.withRecordingLock.bind(f.store);
  f.store.withRecordingLock = (code, recordingId, work) =>
    original(code, recordingId, (lock) =>
      work({
        ...lock,
        change: async (change) => {
          const r = (await lock.get())!.recordings.find(
            (r) => r.id === recordingId,
          )!;
          if (
            !r.metadata &&
            r.storage?.attempts.some(
              (a) => a.proof?.kind === "local" && a.proof.receipt.published,
            )
          )
            throw new Error("Synthetic lost selected-metadata commit");
          return lock.change(change);
        },
      }),
    );
  await f.service.reconcile(await f.current(), "files");
  assert.equal((await f.row()).metadata, undefined);
  assert.equal((await f.row()).storage!.attempts.length, 1);
  const charged = (await f.store.hostedUsage(f.owner)).recordingStorageBytes
    .used;
  assert.ok(charged > 0);
  f.store.withRecordingLock = original;
  await f.service.reconcile(await f.current(), "files");
  assert.equal((await f.row()).status, "ready");
  assert.equal((await f.row()).storage!.attempts.length, 1);
  assert.equal(
    (await f.store.hostedUsage(f.owner)).recordingStorageBytes.used,
    charged,
  );
  assert.equal(
    (await readdir(path.join(f.directory, "encrypted"))).filter((file) =>
      file.endsWith(".mprec"),
    ).length,
    1,
  );
});

test("storage ceiling stops capture before a failed listing and rejects an oversized terminal spool", async (t) => {
  const f = await hostedFixture(t, 90, 2000);
  await f.service.start(await f.current());
  const id = (await f.row()).id,
    raw = path.join(f.directory, "raw", `${id}.mp4`);
  await writeFile(raw, Buffer.alloc(1850), { mode: 0o600 });
  f.controls.listFailures = 1;
  await f.service.reconcile(await f.current(), "capture");
  assert.equal((await f.row()).status, "stopping");
  assert.deepEqual(f.stops, [f.jobs[0]!.egressId]);
  assert.equal(
    (await f.store.hostedUsage(f.owner)).recordingStorageBytes.reserved,
    2000,
  );
  // Shutdown can overshoot the raw target, but no unfunded ciphertext is written.
  await writeFile(raw, Buffer.alloc(2000), { mode: 0o600 });
  f.jobs[0]!.status = EgressStatus.EGRESS_COMPLETE;
  f.jobs[0]!.endedAt = BigInt(f.now + 1000) * 1_000_000n;
  t.mock.timers.tick(2000);
  await f.reconcile();
  assert.equal((await f.row()).status, "failed");
  assert.equal((await f.row()).rawCleanupPending, true);
  assert.deepEqual(await readdir(path.join(f.directory, "encrypted")), []);
  await f.reconcile();
  assert.equal((await f.row()).rawCleanupPending, undefined);
  assert.equal(
    (await f.store.hostedUsage(f.owner)).recordingStorageBytes.available,
    2000,
  );
  await assert.rejects(access(raw));
});

test("owned object upload recovers a lost response and retains capacity until every copy is fenced or removed", async (t) => {
  const f = await hostedFixture(t, 90, 4000);
  let ciphertext: Buffer | undefined,
    reference: RecordingObjectReference | undefined;
  let puts = 0,
    failFence = true;
  const storage: RecordingObjectStorage = {
    async put() {
      throw new Error("Legacy upload must not run for paid storage");
    },
    async delete() {
      throw new Error("Legacy deletion must not run for paid storage");
    },
    async read(ref) {
      assert.deepEqual(ref, reference);
      if (!ciphertext) throw new Error("Object unavailable");
      return Readable.from([ciphertext]);
    },
    async putOwned(file, metadata, _context, _provider, options) {
      puts++;
      const data = await readFile(file);
      const intent = {
        provider: "s3-single" as const,
        storageId: "b".repeat(64),
        key: `owned/${metadata.recordingKeyId}`,
        bytes: data.length,
        sha256: createHash("sha256").update(data).digest("hex"),
      };
      await options.onPrepared(intent);
      ciphertext = data;
      reference = {
        provider: "s3",
        key: intent.key,
        bytes: intent.bytes,
        sha256: intent.sha256,
        etag: "data-etag",
        versionId: "data-version",
      };
      throw new Error("Provider completed but response was lost");
    },
    async recoverOwned(intent) {
      assert.equal(intent.key, reference?.key);
      return reference ?? null;
    },
    async fenceOwned(intent) {
      if (failFence) throw new Error("Provider cleanup unavailable");
      assert.equal(intent.key, reference?.key);
      ciphertext = undefined;
      return {
        provider: "s3-single",
        storageId: intent.storageId,
        key: intent.key,
        etag: "fence-etag",
        versionId: "fence-version",
        bytes: 0,
        cleaned: true,
      };
    },
  };
  const service = new RecordingService(
    { ...f.config, recordingStorage: "s3" },
    f.store,
    {} as Transporter,
    f.client,
    { objectStorage: storage },
  );
  await service.start(await f.current());
  const id = (await f.row()).id;
  await writeFile(
    path.join(f.directory, "raw", `${id}.mp4`),
    Buffer.alloc(400, 42),
    { mode: 0o600 },
  );
  f.jobs[0]!.status = EgressStatus.EGRESS_COMPLETE;
  f.jobs[0]!.endedAt = BigInt(f.now + 1000) * 1_000_000n;
  t.mock.timers.tick(2000);
  await service.reconcile(await f.current());
  const pending = await f.row(),
    bytes = pending.metadata.encryptedBytes;
  assert.equal(pending.status, "encrypting");
  assert.deepEqual((await f.store.hostedUsage(f.owner)).recordingStorageBytes, {
    limit: 4000,
    used: bytes,
    reserved: 2000,
    available: 2000 - bytes,
  });
  await service.reconcile(await f.current());
  const ready = await f.row();
  assert.equal(ready.status, "ready");
  assert.equal(
    puts,
    1,
    "Recover the exact committed intent before another PUT",
  );
  assert.deepEqual((await f.store.hostedUsage(f.owner)).recordingStorageBytes, {
    limit: 4000,
    used: bytes,
    reserved: 0,
    available: 4000 - bytes,
  });
  const encrypted = path.join(
    f.directory,
    "encrypted",
    `${id}.${ready.ciphertextId}.mprec`,
  );
  await assert.rejects(access(encrypted));
  await access(`${encrypted}.closed`);
  await service.rotateKey(await f.current(), id);
  t.mock.timers.tick(8 * 86400000);
  await service.reconcile(await f.current());
  assert.equal((await f.row()).status, "deleting");
  assert.ok((await f.row()).metadata);
  assert.equal(
    (await f.store.hostedUsage(f.owner)).recordingStorageBytes.used,
    bytes,
  );
  failFence = false;
  await service.reconcile(await f.current());
  assert.equal((await f.row()).status, "deleted");
  assert.equal(
    (await f.store.hostedUsage(f.owner)).recordingStorageBytes.available,
    4000,
  );
});

test("hosted recording settles verified job time once before file finalization", async (t) => {
  const f = await hostedFixture(t);
  await f.service.start(await f.current());
  assert.deepEqual(await f.usage(), {
    limit: 90,
    used: 0,
    reserved: 30,
    available: 60,
  });
  t.mock.timers.setTime(f.now + 10_000);
  await f.service.reconcile(await f.current(), "capture");
  const active = await f.usage();
  assert.equal(active.used, 0, "Only verified terminal job time is charged");
  assert.ok(active.reserved >= 30);
  assert.equal(active.used + active.reserved + active.available, 90);
  f.jobs[0]!.status = EgressStatus.EGRESS_COMPLETE;
  f.jobs[0]!.endedAt = BigInt(f.now + 12_000) * 1_000_000n;
  t.mock.timers.setTime(f.now + 15_000);
  await f.service.reconcile(await f.current(), "capture");
  assert.equal((await f.row()).status, "encrypting");
  assert.equal((await f.row()).metadata, undefined);
  assert.deepEqual(await f.usage(), {
    limit: 90,
    used: 12,
    reserved: 0,
    available: 78,
  });
  await f.service.reconcile(await f.current(), "capture");
  assert.equal(
    (await f.usage()).used,
    12,
    "Terminal replay must not debit twice",
  );
});

test("Egress provisional STARTING time may change before exact terminal settlement", async (t) => {
  const f = await hostedFixture(t);
  const start = f.client.startRoomCompositeEgress.bind(f.client);
  f.client.startRoomCompositeEgress = async (...args) => {
    const info = await start(...args);
    info.status = EgressStatus.EGRESS_STARTING;
    return info;
  };
  await f.service.start(await f.current());
  assert.equal((await f.row()).status, "starting");
  const id = (await f.row()).id;

  // Egress validates the request in one process, then initializes the same job
  // again in its child. The child publishes a later top-level startedAt.
  t.mock.timers.setTime(f.now + 5_000);
  f.jobs[0]!.status = EgressStatus.EGRESS_ACTIVE;
  f.jobs[0]!.startedAt = BigInt(f.now + 262) * 1_000_000n;
  await f.service.reconcile(await f.current(), "capture");
  assert.equal((await f.row()).status, "recording");
  assert.equal((await f.row()).timeReservation!.startedAt, f.now);
  assert.deepEqual(f.stops, []);
  assert.equal((await f.usage()).used, 0);
  assert.ok((await f.usage()).reserved >= 30);

  f.jobs[0]!.status = EgressStatus.EGRESS_COMPLETE;
  f.jobs[0]!.endedAt = BigInt(f.now + 12_100) * 1_000_000n;
  t.mock.timers.setTime(f.now + 15_000);
  await f.service.reconcile(await f.current(), "capture");
  assert.equal((await f.row()).status, "encrypting");
  assert.deepEqual((await f.row()).timeReservation!.settled, {
    startedAt: f.now + 262,
    endedAt: f.now + 12_100,
  });
  assert.equal(
    (await f.usage()).used,
    12,
    "Charge the final11.838s interval, not the provisional12.1s interval",
  );
  assert.equal((await f.usage()).reserved, 0);

  await writeFile(
    path.join(f.directory, "raw", `${id}.mp4`),
    Buffer.from("Synthetic recording encryption fixture"),
    { mode: 0o600 },
  );
  await f.service.reconcile(await f.current(), "files");
  assert.equal((await f.row()).status, "ready");
  await f.service.reconcile(await f.current(), "capture");
  assert.equal((await f.usage()).used, 12);
});

test("terminal usage survives a crash before the recording file-state transition", async (t) => {
  const f = await hostedFixture(t);
  await f.service.start(await f.current());
  f.jobs[0]!.status = EgressStatus.EGRESS_COMPLETE;
  f.jobs[0]!.endedAt = BigInt(f.now + 12_000) * 1_000_000n;
  t.mock.timers.setTime(f.now + 15_000);
  const withLock = f.store.withRecordingLock.bind(f.store);
  let failNextChange = false;
  f.store.withRecordingLock = (code, id, work) =>
    withLock(code, id, (lock) =>
      work({
        ...lock,
        observeRecordingTime: async (observation) => {
          const result = await lock.observeRecordingTime(observation);
          if (observation.terminal) failNextChange = true;
          return result;
        },
        change: async (change) => {
          if (failNextChange) {
            failNextChange = false;
            throw new Error("Process lost after terminal usage commit");
          }
          return lock.change(change);
        },
      }),
    );
  await f.service.reconcile(await f.current(), "capture");
  assert.equal((await f.row()).status, "recording");
  assert.equal((await f.usage()).used, 12);
  assert.equal((await f.usage()).reserved, 0);
  f.store.withRecordingLock = withLock;
  await f.service.reconcile(await f.current(), "capture");
  assert.equal((await f.row()).status, "encrypting");
  assert.equal((await f.usage()).used, 12);
  assert.equal((await f.usage()).reserved, 0);
});

test("malformed recorder times and a different job never release the hosted hold", async (t) => {
  for (const scenario of [
    "zero-start",
    "zero-end",
    "negative-start",
    "reversed",
    "unsafe",
    "different-job",
  ]) {
    await t.test(scenario, async (t) => {
      const f = await hostedFixture(t);
      await f.service.start(await f.current());
      const id = f.jobs[0]!.egressId;
      const job = f.jobs[0]!;
      job.status = EgressStatus.EGRESS_COMPLETE;
      job.endedAt = BigInt(f.now + 12_000) * 1_000_000n;
      if (scenario === "zero-start") job.startedAt = 0n;
      if (scenario === "zero-end") job.endedAt = 0n;
      if (scenario === "negative-start") job.startedAt = -1n;
      if (scenario === "reversed")
        job.startedAt = BigInt(f.now + 20_000) * 1_000_000n;
      if (scenario === "unsafe")
        job.endedAt = (BigInt(Number.MAX_SAFE_INTEGER) + 1n) * 1_000_000n;
      if (scenario === "different-job") {
        job.egressId = `EG_${randomUUID()}`;
        f.controls.listOverride = f.jobs;
      }
      t.mock.timers.setTime(f.now + 12_000);
      await f.service.reconcile(await f.current(), "capture");
      const row = await f.row();
      assert.equal(row.egressId, id);
      assert.ok(["starting", "recording", "stopping"].includes(row.status));
      assert.equal(row.metadata, undefined);
      assert.ok((await f.usage()).reserved > 0);
      assert.ok(f.stops.every((stopped) => stopped === id));
    });
  }
});

test("exhausted recording funding requests stop even when the recorder listing fails", async (t) => {
  const f = await hostedFixture(t, 5);
  await f.service.start(await f.current());
  t.mock.timers.setTime(f.now + 6_000);
  f.controls.listFailures = 1;
  await f.service.reconcile(await f.current(), "capture");
  assert.equal((await f.row()).status, "stopping");
  assert.ok(f.stops.includes(f.jobs[0]!.egressId));
  assert.ok(
    (await f.usage()).reserved > 0,
    "An unconfirmed stop is not a refund",
  );
});

test("uncertain recorder status stops before funding expires and blocks another room", async (t) => {
  for (const lookup of ["failed", "empty"] as const) {
    await t.test(lookup, async (t) => {
      const f = await hostedFixture(t);
      await f.service.start(await f.current());
      const id = f.jobs[0]!.egressId;
      t.mock.timers.setTime(f.now + 1_000);
      assert.ok((await f.row()).timeReservation!.fundedUntil > Date.now());
      if (lookup === "failed") f.controls.listFailures = 1;
      else f.controls.listOverride = [];

      await f.service.reconcile(await f.current(), "capture");

      assert.equal((await f.row()).status, "stopping");
      assert.deepEqual(f.stops, [id]);
      const usage = await f.usage();
      assert.equal(
        usage.used,
        0,
        "Missing terminal evidence must not debit used time",
      );
      assert.ok(
        usage.reserved > 0,
        "An uncertain job must retain its pool hold",
      );
      await assert.rejects(
        f.service.start(await f.another()),
        (error: unknown) => error instanceof HttpError && error.status === 409,
      );
      assert.equal(
        f.jobs.length,
        1,
        "A second room cannot allocate around the hold",
      );
      assert.equal((await f.usage()).used, 0);
    });
  }
});

test("unknown start retains its pool hold across missing recorder listings", async (t) => {
  const f = await hostedFixture(t);
  f.controls.startTimeout = true;
  f.controls.listFailures = 1;
  await assert.rejects(f.service.start(await f.current()), unavailable);
  assert.equal((await f.row()).egressId, undefined);
  f.jobs.length = 0;
  t.mock.timers.setTime(f.now + 31_000);
  await f.service.reconcile(await f.current(), "capture");
  assert.equal((await f.row()).status, "stopping");
  assert.ok((await f.usage()).reserved > 0);
  f.controls.startTimeout = false;
  await assert.rejects(
    f.service.start(await f.another()),
    (error: unknown) => error instanceof HttpError && error.status === 409,
  );
  assert.equal(
    f.jobs.length,
    0,
    "Another room must not bypass uncertain usage",
  );
});

test(
  "blocked encryption does not prevent another room's capture-phase stop",
  { timeout: 10_000 },
  async (t) => {
    const f = await hostedFixture(t, 90, 6_000_000_000);
    await f.service.start(await f.current());
    const first = await f.row();
    f.jobs[0]!.status = EgressStatus.EGRESS_COMPLETE;
    f.jobs[0]!.endedAt = BigInt(f.now + 12_000) * 1_000_000n;
    t.mock.timers.setTime(f.now + 12_000);
    await f.service.reconcile(await f.current(), "capture");
    await writeFile(
      path.join(f.directory, "raw", `${first.id}.mp4`),
      Buffer.from("Synthetic recording encryption fixture"),
      { mode: 0o600 },
    );
    const provider = new LocalKeyProvider({
      keyId: f.config.recordingActiveKeyId,
      key: Buffer.from(f.config.recordingKek, "base64"),
    });
    t.after(() => provider.destroy());
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const files = new RecordingService(
      f.config,
      f.store,
      {} as Transporter,
      f.client,
      {
        keyProvider: {
          unwrapKey: (...args) => provider.unwrapKey(...args),
          wrapKey: async (...args) => {
            enter();
            await gate;
            return provider.wrapKey(...args);
          },
        },
      },
    );
    let finished = false;
    const finalizing = files
      .reconcile(await f.current(), "files")
      .finally(() => {
        finished = true;
      });
    try {
      await entered;
      const second = await f.another();
      await f.service.start(second);
      const secondJob = f.jobs[1]!;
      t.mock.timers.setTime(f.now + 50_000);
      await f.service.reconcile((await f.store.get(second.code))!, "capture");
      assert.ok(f.stops.includes(secondJob.egressId));
      assert.equal(
        finished,
        false,
        "The file pass must still be waiting on encryption",
      );
    } finally {
      release();
      await finalizing;
    }
    assert.equal((await f.row()).status, "ready");
  },
);

test("recovery stops capture after committed opt-out or global disable", async (t) => {
  const f = await fixture(t);
  await f.service.start(f.meeting);
  assert.equal((await f.row()).status, "recording");
  await f.store.change(f.meeting.code, (m) => {
    m.recordingAllowed = false;
  });
  await f.reconcile();
  assert.equal((await f.row()).status, "stopping");
  assert.deepEqual(f.stops, [f.jobs[0]!.egressId]);

  await f.store.change(f.meeting.code, (m) => {
    m.recordingAllowed = true;
    m.recordings[0]!.status = "recording";
  });
  f.config.recordingEnabled = false;
  const restarted = new RecordingService(
    f.config,
    f.store,
    {} as Transporter,
    f.client,
  );
  assert.equal(restarted.available, false);
  await restarted.reconcile((await f.store.get(f.meeting.code))!);
  assert.equal((await f.row()).status, "stopping");
  assert.deepEqual(f.stops, [f.jobs[0]!.egressId, f.jobs[0]!.egressId]);
});

test("audit failure after recorder start stops the remote job and retains its recovery ID", async (t) => {
  const f = await fixture(t);
  f.store.audit = async () => {
    throw new Error("Audit unavailable");
  };
  await assert.rejects(f.service.start(f.meeting), unavailable);
  const row = await f.row();
  assert.equal(row.egressId, f.jobs[0]!.egressId);
  assert.equal(row.status, "stopping");
  assert.deepEqual(f.stops, [row.egressId]);
  assert.equal(row.metadata, undefined);
});

test("database outage after start still stops the job, then recovers its ID by exact room and output", async (t) => {
  const f = await fixture(t);
  const change = f.store.change.bind(f.store);
  let calls = 0;
  f.store.change = async (...args) => {
    if (++calls > 1)
      throw new Error("Database unavailable after initial intent");
    return change(...args);
  };
  await assert.rejects(f.service.start(f.meeting), unavailable);
  assert.equal((await f.row()).egressId, undefined);
  assert.equal((await f.row()).status, "starting");
  assert.deepEqual(
    f.stops,
    [f.jobs[0]!.egressId],
    "Stop must run before failed persistence is retried",
  );
  f.store.change = change;
  await f.reconcile();
  assert.equal((await f.row()).egressId, f.jobs[0]!.egressId);
  assert.equal((await f.row()).status, "stopping");
  assert.ok(f.stops.length >= 2);
});

test("ambiguous start timeout recovers and stops a job even without its RPC response", async (t) => {
  const f = await fixture(t);
  f.controls.startTimeout = true;
  await assert.rejects(f.service.start(f.meeting), unavailable);
  assert.equal((await f.row()).egressId, f.jobs[0]!.egressId);
  assert.equal((await f.row()).status, "stopping");
  assert.deepEqual(f.stops, [f.jobs[0]!.egressId]);
});

test("untracked start recovery retries after listing failure and ignores other outputs", async (t) => {
  const f = await fixture(t);
  f.controls.startTimeout = true;
  f.controls.listFailures = 1;
  await assert.rejects(f.service.start(f.meeting), unavailable);
  assert.equal((await f.row()).egressId, undefined);
  const correct = f.jobs[0]!;
  const unrelated = new EgressInfo({
    egressId: "unrelated-job",
    roomName: f.meeting.room,
    status: EgressStatus.EGRESS_ACTIVE,
    request: {
      case: "roomComposite",
      value: new RoomCompositeEgressRequest({ roomName: f.meeting.room }),
    },
  });
  f.jobs.unshift(unrelated);
  await f.reconcile();
  assert.equal((await f.row()).egressId, correct.egressId);
  assert.ok(f.stops.length > 0);
  assert.ok(f.stops.every((id) => id === correct.egressId));
});

test("failed stop remains pending with the job ID and reconciliation retries it", async (t) => {
  const f = await fixture(t);
  f.store.audit = async () => {
    throw new Error("Audit unavailable");
  };
  f.controls.stopFailures = 1;
  await assert.rejects(f.service.start(f.meeting), unavailable);
  assert.equal((await f.row()).status, "stopping");
  assert.equal((await f.row()).egressId, f.jobs[0]!.egressId);
  await f.reconcile();
  assert.deepEqual(f.stops, [f.jobs[0]!.egressId, f.jobs[0]!.egressId]);
});

test("missing remote job stays pending and blocks another recording instead of hiding uncertainty", async (t) => {
  const f = await fixture(t);
  f.controls.startTimeout = true;
  f.controls.listFailures = 1;
  await assert.rejects(f.service.start(f.meeting), unavailable);
  f.jobs.length = 0;
  await f.reconcile();
  assert.equal((await f.row()).status, "stopping");
  await assert.rejects(
    f.service.start(f.meeting),
    (error) => error instanceof HttpError && error.status === 409,
  );
});

test("another API cannot recover an in-flight start, and stop intent survives its ownership", async (t) => {
  const f = await fixture(t);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const original = f.client.startRoomCompositeEgress.bind(f.client);
  f.client.startRoomCompositeEgress = async (...args) => {
    const job = await original(...args);
    entered();
    await blocked;
    return job;
  };
  const other = new RecordingService(
    f.config,
    f.store,
    {} as Transporter,
    f.client,
  );
  const starting = f.service.start(f.meeting);
  await pending;
  const snapshot = (await f.store.get(f.meeting.code))!;
  await other.reconcile(snapshot);
  assert.deepEqual(
    f.stops,
    [],
    "A healthy owner's start must not be recovered by another API",
  );
  await assert.rejects(
    other.start(snapshot),
    (error: any) => error.status === 409,
  );
  await other.stop(snapshot, snapshot.recordings[0]!.id);
  assert.equal((await f.row()).status, "stopping");
  release();
  await starting;
  assert.equal(f.jobs.length, 1);
  assert.deepEqual(f.stops, [f.jobs[0]!.egressId]);
});

test("hosted deadline and stale plan snapshots prevent recorder startup using an older authorized request", async (t) => {
  const f = await fixture(t);
  const accountId = randomUUID();
  const policy = {
    revision: 1,
    validUntil: Date.now() + 300000,
    enabled: true,
    quota: {
      anchorAt: Date.UTC(2026, 0, 31),
      participantSecondsPerMonth: 360000,
    },
    allowed: true,
    limits: { participants: 100, durationSeconds: 7200, concurrentMeetings: 1 },
  };
  for (const reason of [
    "deadline",
    "grant",
    "membership",
    "missing",
  ] as const) {
    await f.store.change(f.meeting.code, (m) => {
      m.hosted = {
        accountId,
        billingOwnerId: accountId,
        version: 1,
        entitlement: structuredClone(policy),
      };
      m.lifecycle = {
        startedAt: Date.now() - 1000,
        deadlineAt: Date.now() + 1000,
      };
      if (reason === "deadline") m.lifecycle.deadlineAt = Date.now() - 1;
      if (reason === "grant") m.hosted.entitlement!.validUntil = Date.now() - 1;
      if (reason === "membership") m.hosted.entitlement!.allowed = false;
      if (reason === "missing") delete m.hosted.entitlement;
    });
    await assert.rejects(
      f.service.start(f.meeting),
      (error: unknown) => error instanceof HttpError && error.status === 403,
    );
    assert.equal(f.jobs.length, 0, reason);
    assert.equal(
      (await f.store.get(f.meeting.code))!.recordings.length,
      0,
      reason,
    );
  }
});
