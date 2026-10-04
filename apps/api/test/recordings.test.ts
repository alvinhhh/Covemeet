import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import {
  LocalKeyProvider,
  encryptRecording,
} from "@meeting-platform/recording";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { RecordingService } from "../src/recordings.js";
import { MemoryStore, type Meeting, type Recording } from "../src/store.js";
import { digest, HttpError } from "../src/security.js";
import type { Media } from "../src/media.js";

const day = 86_400_000;
const origin = "http://localhost:5173";
const creationKey = "test-recording-creation-key-more-than-32-characters";
const forbidden = (error: unknown) =>
  error instanceof HttpError && error.status === 403;

async function fixture(t: TestContext, status = "ready") {
  const directory = await mkdtemp(
    path.join(tmpdir(), "meeting-recording-service-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "raw"), { mode: 0o700 });
  await mkdir(path.join(directory, "encrypted"), { mode: 0o700 });
  const key = randomBytes(32);
  const config = loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "test-recording-session-secret-more-than-32-characters",
    CREATION_KEY: creationKey,
    SITE_ORIGIN: origin,
    RECORDING_ENABLED: "true",
    RECORDING_DIR: directory,
    RECORDING_KEK: key.toString("base64"),
    LIVEKIT_API_KEY: "test-key",
    LIVEKIT_API_SECRET: "test-media-secret",
    LIVEKIT_URL: "http://127.0.0.1:1",
    SMTP_HOST: "unused.test",
    SMTP_FROM: "test@example.test",
  });
  const emails: Record<string, any>[] = [];
  const mail = {
    sendMail: async (message: Record<string, any>) => {
      emails.push(message);
      return { messageId: "test" };
    },
  } as unknown as Transporter;
  const store = new MemoryStore();
  const recording: Recording = {
    id: randomUUID(),
    status,
    createdAt: Date.now(),
    egressId: "test-egress-id",
  };
  const hostSession = randomBytes(32).toString("base64url");
  const guestSession = randomBytes(32).toString("base64url");
  const participant = {
    status: "admitted" as const,
    audioAllowed: true,
    videoAllowed: true,
    mediaVersion: 1,
    expiresAt: Date.now() + 60_000,
    ipHash: "",
    deviceHash: "",
    breakoutId: null,
  };
  const meeting: Meeting = {
    id: randomUUID(),
    code: "TESTRECORDINGMEETINGCODE123",
    room: `m_${randomUUID()}`,
    title: "Recording test",
    mode: "meeting",
    locked: false,
    ended: false,
    recordingAllowed: true,
    createdAt: Date.now(),
    revision: 1,
    passwordHash: "unused",
    hostTokenExpiresAt: 0,
    participants: [
      {
        ...participant,
        id: randomUUID(),
        name: "Host",
        role: "host",
        tokenHash: digest(hostSession),
      },
      {
        ...participant,
        id: randomUUID(),
        name: "Guest",
        role: "participant",
        tokenHash: digest(guestSession),
      },
    ],
    bans: { ip: [], device: [] },
    breakouts: [],
    messages: [],
    recordings: [recording],
    hostEmail: "host@example.test",
    hostEmailVerified: true,
  };
  const plaintext = Buffer.concat([
    Buffer.from("synthetic recording payload\n"),
    Buffer.alloc(80_000, 42),
  ]);
  const raw = path.join(directory, "raw", `${recording.id}.mp4`);
  const encrypted = path.join(directory, "encrypted", `${recording.id}.mprec`);
  await writeFile(raw, plaintext, { mode: 0o600 });
  const provider = new LocalKeyProvider({ keyId: "operator-kek-v1", key });
  recording.metadata = await encryptRecording(
    raw,
    encrypted,
    {
      tenantId: "installation",
      meetingId: meeting.id,
      recordingId: recording.id,
    },
    provider,
  );
  provider.destroy();
  key.fill(0);
  if (status === "ready") await unlink(raw);
  await store.create(meeting);
  const service = new RecordingService(config, store, mail);
  async function link() {
    const result = await service.link(meeting, recording.id);
    const token = new URL(result.url).hash.slice(1);
    const password = /^Password: (.+)$/m.exec(emails.at(-1)!.text)![1]!;
    return { ...result, token, password };
  }
  async function collect(token: string, password: string) {
    const stream = await service.download(meeting, recording, token, password);
    const parts: Buffer[] = [];
    for await (const chunk of stream) parts.push(Buffer.from(chunk));
    return Buffer.concat(parts);
  }
  const media: Media = {
    available: true,
    token: async () => "unused",
    remove: async () => {},
    end: async () => {},
    close() {},
  };
  async function app() {
    // Inject a transport through nodemailer's factory, without opening a socket or sending real mail.
    const original = nodemailer.createTransport;
    nodemailer.createTransport = (() =>
      mail) as typeof nodemailer.createTransport;
    let server;
    try {
      server = await createApp(config, store, media);
    } finally {
      nodemailer.createTransport = original;
    }
    t.after(() => server.close());
    return server;
  }
  return {
    config,
    store,
    service,
    mail,
    emails,
    meeting,
    recording,
    plaintext,
    raw,
    encrypted,
    hostSession,
    guestSession,
    link,
    collect,
    app,
  };
}

test("recording links last 24 hours and send the password without the capability URL", async (t) => {
  const f = await fixture(t);
  const before = Date.now();
  const link = await f.link();
  assert.equal(new URL(link.url).pathname, `/download/${f.meeting.code}`);
  assert.equal(new URL(link.url).hash, `#${link.token}`);
  assert.ok(
    link.expiresAt >= before + day && link.expiresAt <= Date.now() + day,
  );
  assert.equal(f.emails.at(-1)!.to, "host@example.test");
  assert.ok(!f.emails.at(-1)!.text.includes(link.url));
  assert.ok(!f.emails.at(-1)!.text.includes(link.token));
  const apiResult = await f.service.link(f.meeting, f.recording.id);
  assert.deepEqual(Object.keys(apiResult).sort(), ["expiresAt", "url"]);
  const stored = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.notEqual(stored.passwordHash, link.password);
  assert.notEqual(stored.tokenHash, link.token);
  assert.ok(
    !(await readFile(f.encrypted)).includes(f.plaintext.subarray(0, 24)),
  );
});

test("correct password decrypts the recording and wrong password cannot", async (t) => {
  const f = await fixture(t);
  const link = await f.link();
  await assert.rejects(f.collect(link.token, "incorrect-password"), forbidden);
  assert.deepEqual(await f.collect(link.token, link.password), f.plaintext);
});

test("regenerating, expiring, and revoking a link invalidate old credentials", async (t) => {
  const f = await fixture(t);
  const first = await f.link();
  const second = await f.link();
  assert.equal(await f.service.findToken(first.token, f.meeting.code), null);
  await assert.rejects(f.collect(first.token, first.password), forbidden);
  await f.store.change(f.meeting.code, (meeting) => {
    meeting.recordings[0]!.expiresAt = Date.now() - 1;
  });
  assert.equal(await f.service.findToken(second.token, f.meeting.code), null);
  await assert.rejects(f.collect(second.token, second.password), forbidden);
  const third = await f.link();
  await f.service.revoke(f.meeting, f.recording.id);
  assert.equal(await f.service.findToken(third.token, f.meeting.code), null);
  await assert.rejects(f.collect(third.token, third.password), forbidden);
});

test("email failure revokes the newly generated download credentials", async (t) => {
  const f = await fixture(t);
  const failingMail = {
    sendMail: async () => {
      throw new Error("Synthetic SMTP failure");
    },
  } as unknown as Transporter;
  const service = new RecordingService(f.config, f.store, failingMail);
  await assert.rejects(
    service.link(f.meeting, f.recording.id),
    (error) => error instanceof HttpError && error.status === 503,
  );
  const row = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(row.tokenHash, undefined);
  assert.equal(row.passwordHash, undefined);
  assert.equal(row.expiresAt, undefined);
});

test("token lookup reads only the authenticated meeting and never scans all meetings", async (t) => {
  const f = await fixture(t);
  const link = await f.link();
  const get = f.store.get.bind(f.store);
  const reads: string[] = [];
  f.store.get = async (code) => {
    reads.push(code);
    return get(code);
  };
  f.store.all = async () => {
    throw new Error("Global token lookup is forbidden");
  };
  assert.equal(
    (await f.service.findToken(link.token, f.meeting.code))!.r.id,
    f.recording.id,
  );
  assert.equal(await f.service.findToken(link.token, "UNRELATEDMEETING"), null);
  assert.deepEqual(reads, [f.meeting.code, "UNRELATEDMEETING"]);
});

test("download requires the matching host session as well as token and password", async (t) => {
  const f = await fixture(t);
  const link = await f.link();
  const app = await f.app();
  let address = 1;
  const request = (
    session?: string,
    password = link.password,
    token = link.token,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/meetings/${f.meeting.code}/download`,
      remoteAddress: `192.0.2.${address++}`,
      headers: {
        origin,
        "x-requested-with": "MeetingPlatform",
        ...(session ? { cookie: `mp_${f.meeting.code}=${session}` } : {}),
      },
      payload: { token, password },
    });
  assert.equal((await request()).statusCode, 401);
  assert.equal(
    (
      await request(
        undefined,
        link.password,
        randomBytes(32).toString("base64url"),
      )
    ).statusCode,
    401,
  );
  assert.equal((await request(f.guestSession)).statusCode, 403);
  assert.equal((await request("wrong-meeting-session")).statusCode, 401);
  assert.equal((await request(f.hostSession, "incorrect")).statusCode, 403);
  assert.equal(
    (
      await request(
        f.hostSession,
        link.password,
        randomBytes(32).toString("base64url"),
      )
    ).statusCode,
    403,
  );
  const response = await request(f.hostSession);
  assert.equal(response.statusCode, 200, response.body);
  assert.match(String(response.headers["content-disposition"]), /^attachment;/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.rawPayload, f.plaintext);
});

test("issuing a download link keeps the same host session valid through link expiry", async (t) => {
  const f = await fixture(t);
  const app = await f.app();
  const response = await app.inject({
    method: "POST",
    url: `/api/meetings/${f.meeting.code}/recordings/${f.recording.id}/link`,
    headers: {
      origin,
      "x-requested-with": "MeetingPlatform",
      cookie: `mp_${f.meeting.code}=${f.hostSession}`,
    },
    payload: {},
  });
  assert.equal(response.statusCode, 200, response.body);
  const expiry = response.json().expiresAt;
  const host = (await f.store.get(f.meeting.code))!.participants.find(
    (p) => p.role === "host",
  )!;
  assert.ok(
    host.expiresAt >= expiry,
    "A link must not outlive the only host session that can use it",
  );
  const cookies = String(response.headers["set-cookie"]);
  assert.match(cookies, /HttpOnly/i);
  assert.match(cookies, /Max-Age=86400/);
});

test("encrypted metadata survives a crash before raw spool removal", async (t) => {
  const f = await fixture(t, "encrypting");
  await f.service.reconcile((await f.store.get(f.meeting.code))!);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.status,
    "ready",
  );
  await assert.rejects(access(f.raw), (error: any) => error.code === "ENOENT");
  const link = await f.link();
  assert.deepEqual(await f.collect(link.token, link.password), f.plaintext);
});

test("encrypted metadata survives a crash after raw removal but before ready state", async (t) => {
  const f = await fixture(t, "encrypting");
  await unlink(f.raw);
  await f.service.reconcile((await f.store.get(f.meeting.code))!);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.status,
    "ready",
  );
  const link = await f.link();
  assert.deepEqual(await f.collect(link.token, link.password), f.plaintext);
});

test("failed raw cleanup keeps the recording unavailable and retries safely", async (t) => {
  const f = await fixture(t, "encrypting");
  await unlink(f.raw);
  await mkdir(f.raw);
  await f.service.reconcile((await f.store.get(f.meeting.code))!);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.status,
    "encrypting",
  );
  await assert.rejects(
    f.link(),
    (error) => error instanceof HttpError && error.status === 409,
  );
  await rm(f.raw, { recursive: true });
  await f.service.reconcile((await f.store.get(f.meeting.code))!);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.status,
    "ready",
  );
});

test("retention removes expired encrypted data and revoked access", async (t) => {
  const f = await fixture(t);
  const link = await f.link();
  await f.store.change(f.meeting.code, (meeting) => {
    meeting.recordings[0]!.createdAt = Date.now() - 8 * day;
  });
  await f.service.reconcile((await f.store.get(f.meeting.code))!);
  const row = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(row.status, "deleted");
  assert.equal(row.metadata, undefined);
  assert.equal(await f.service.findToken(link.token, f.meeting.code), null);
  await assert.rejects(
    access(f.encrypted),
    (error: any) => error.code === "ENOENT",
  );
});

test("recording off and unverified host email fail closed", async (t) => {
  const f = await fixture(t);
  const disabled = new RecordingService(
    { ...f.config, recordingEnabled: false },
    f.store,
    f.mail,
  );
  assert.equal(disabled.available, false);
  await assert.rejects(
    disabled.start(f.meeting),
    (error) => error instanceof HttpError && error.status === 503,
  );
  await assert.rejects(
    disabled.link(f.meeting, f.recording.id),
    (error) => error instanceof HttpError && error.status === 503,
  );
  await f.store.change(f.meeting.code, (meeting) => {
    meeting.hostEmailVerified = false;
  });
  await assert.rejects(f.link(), forbidden);
  assert.equal(f.emails.length, 0);
});
