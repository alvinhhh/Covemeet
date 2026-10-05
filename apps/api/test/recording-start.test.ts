import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Transporter } from "nodemailer";
import {
  EgressInfo,
  EgressStatus,
  RoomCompositeEgressRequest,
  type EncodedFileOutput,
} from "livekit-server-sdk";
import { loadConfig } from "../src/config.js";
import { RecordingService, type RecorderClient } from "../src/recordings.js";
import { MemoryStore, type Meeting } from "../src/store.js";
import { HttpError } from "../src/security.js";

const unavailable = (error: unknown) =>
  error instanceof HttpError && error.status === 503;

async function fixture(t: TestContext) {
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
  const controls = { startTimeout: false, stopFailures: 0, listFailures: 0 };
  const client = {
    async startRoomCompositeEgress(room: string, output: EncodedFileOutput) {
      const info = new EgressInfo({
        egressId: `EG_${randomUUID()}`,
        roomName: room,
        status: EgressStatus.EGRESS_ACTIVE,
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
    async listEgress() {
      if (controls.listFailures > 0) {
        controls.listFailures--;
        throw new Error("Recorder listing temporarily unreachable");
      }
      return jobs;
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
