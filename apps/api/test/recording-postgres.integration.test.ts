import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { Transporter } from "nodemailer";
import { EgressInfo, EgressStatus } from "livekit-server-sdk";
import {
  LocalKeyProvider,
  decryptRecordingToStream,
} from "@meeting-platform/recording";
import { loadConfig } from "../src/config.js";
import { RecordingService, type RecorderClient } from "../src/recordings.js";
import { PgStore, type Meeting } from "../src/store.js";

// Only the disposable, loopback PostgreSQL fixture is permitted.
const databaseUrl =
  process.env.RECORDING_TEST_DATABASE_URL ??
  process.env.PHONE_TEST_DATABASE_URL;
function fixtureUrl() {
  const url = new URL(databaseUrl!);
  assert.ok(
    ["127.0.0.1", "localhost", "phone-postgres"].includes(url.hostname),
  );
  assert.equal(url.pathname, "/covemeet_phone_test");
  return databaseUrl!;
}

test(
  "PostgreSQL recording ownership releases after owner process death",
  { skip: !databaseUrl, timeout: 15000 },
  async (t) => {
    const store = new PgStore(fixtureUrl());
    t.after(() => store.close());
    const code = randomUUID(),
      id = randomUUID();
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
    import { PgStore } from './apps/api/src/store.ts';
    const store = new PgStore(process.env.RECORDING_TEST_DATABASE_URL);
    await store.withRecordingLock(process.env.RECORDING_TEST_CODE, process.env.RECORDING_TEST_ID, async () => {
      process.send('owned');
      await new Promise(() => {});
    });
  `,
      ],
      {
        cwd: path.resolve(import.meta.dirname, "../../.."),
        env: {
          ...process.env,
          RECORDING_TEST_DATABASE_URL: databaseUrl!,
          RECORDING_TEST_CODE: code,
          RECORDING_TEST_ID: id,
        },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let childError = "";
    child.stderr?.on("data", (chunk) => {
      childError += chunk;
    });
    await Promise.race([
      once(child, "message"),
      once(child, "exit").then(() => {
        throw new Error(`Owner failed before lock acquisition: ${childError}`);
      }),
    ]);
    assert.deepEqual(
      await store.withRecordingLock(code, id, async () =>
        assert.fail("Second process acquired a live owner's lock"),
      ),
      { acquired: false },
    );
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    let acquired = false;
    for (let attempt = 0; attempt < 20 && !acquired; attempt++) {
      acquired = (
        await store.withRecordingLock(code, id, async (lock) => lock.check())
      ).acquired;
      if (!acquired) await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(
      acquired,
      true,
      "Process death must release recording ownership without manual lease expiry",
    );
  },
);

test(
  "PostgreSQL connection loss fences a stale encryptor and preserves the winning output",
  { skip: !databaseUrl, timeout: 15000 },
  async (t) => {
    const first = new PgStore(fixtureUrl()),
      second = new PgStore(fixtureUrl());
    await first.init();
    let meetingCode: string | undefined;
    let release: (() => void) | undefined;
    let work: Promise<void> | undefined;
    t.after(async () => {
      release?.();
      await work;
      if (meetingCode)
        await second.pool.query("DELETE FROM meetings WHERE code=$1", [
          meetingCode,
        ]);
      await first.close();
      await second.close();
    });
    const directory = await mkdtemp(path.join(tmpdir(), "recording-postgres-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await mkdir(path.join(directory, "raw"), { mode: 0o700 });
    await mkdir(path.join(directory, "encrypted"), { mode: 0o700 });
    const config = loadConfig({
      NODE_ENV: "test",
      SESSION_SECRET: "recording-test-session-secret-over-32-characters",
      RECORDING_ENABLED: "true",
      RECORDING_KEK: randomBytes(32).toString("base64"),
      RECORDING_DIR: directory,
      LIVEKIT_API_KEY: "test-key",
      LIVEKIT_API_SECRET: "test-secret",
      SMTP_HOST: "unused.test",
    });
    const recording = {
      id: randomUUID(),
      status: "recording",
      egressId: "test-egress-id",
      createdAt: Date.now(),
    };
    const meeting: Meeting = {
      id: randomUUID(),
      code: randomUUID(),
      room: randomUUID(),
      title: "Ownership fixture",
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
      recordings: [recording],
    };
    await first.create(meeting);
    meetingCode = meeting.code;
    const plaintext = Buffer.from("Isolated recording ownership fixture");
    const raw = path.join(directory, "raw", `${recording.id}.mp4`);
    await writeFile(raw, plaintext, { mode: 0o600 });
    const client = {
      listEgress: async () => [
        new EgressInfo({
          egressId: recording.egressId,
          status: EgressStatus.EGRESS_COMPLETE,
        }),
      ],
    } as unknown as RecorderClient;
    const owner = new RecordingService(
      config,
      first,
      {} as Transporter,
      client,
    );
    const successor = new RecordingService(
      config,
      second,
      {} as Transporter,
      client,
    );
    let entered!: () => void,
      ownerPid = 0;
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    first.pool.on("acquire", (connection) => {
      ownerPid = (connection as any).processID;
    });
    const own = first.withRecordingLock.bind(first);
    first.withRecordingLock = (code, id, fn) =>
      own(code, id, (lock) =>
        fn({
          ...lock,
          change: async (change) => {
            entered();
            await blocked;
            return lock.change(change);
          },
        }),
      );
    const stale = await second.get(meeting.code);
    work = owner.reconcile(stale!);
    await pending;
    assert.equal((await readdir(path.join(directory, "encrypted"))).length, 1);
    await successor.reconcile(stale!);
    assert.equal(
      (await readdir(path.join(directory, "encrypted"))).length,
      1,
      "Live ownership prevents another encryption attempt",
    );
    assert.ok(ownerPid > 0);
    await second.pool.query("SELECT pg_terminate_backend($1)", [ownerPid]);
    await successor.reconcile(stale!);
    const winner = (await second.get(meeting.code))!.recordings[0]!;
    assert.equal(winner.status, "ready");
    assert.ok(winner.ciphertextId);
    const ciphertext = path.join(
      directory,
      "encrypted",
      `${winner.id}.${winner.ciphertextId}.mprec`,
    );
    const before = await readFile(ciphertext);
    release!();
    await work;
    assert.deepEqual(
      (await second.get(meeting.code))!.recordings[0]!.metadata,
      winner.metadata,
    );
    assert.deepEqual(await readFile(ciphertext), before);
    assert.equal(
      (await readdir(path.join(directory, "encrypted"))).length,
      2,
      "The stale output remains an orphan, never a replacement for the winner",
    );
    await assert.rejects(access(raw));
    const provider = new LocalKeyProvider({
      keyId: "operator-kek-v1",
      key: Buffer.from(config.recordingKek, "base64"),
    });
    t.after(() => provider.destroy());
    const chunks: Buffer[] = [];
    for await (const chunk of await decryptRecordingToStream(
      ciphertext,
      winner.metadata,
      {
        tenantId: "installation",
        meetingId: meeting.id,
        recordingId: winner.id,
      },
      provider,
    ))
      chunks.push(Buffer.from(chunk));
    assert.deepEqual(Buffer.concat(chunks), plaintext);
  },
);
