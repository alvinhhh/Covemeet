import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import {
  access,
  chmod,
  readdir,
  symlink,
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
  verifyEncryptedRecording,
  type RecordingObjectStorage,
  type RecordingObjectReference,
  type EncryptedRecordingMetadata,
  type RecordingContext,
  type KeyProvider,
} from "@meeting-platform/recording";
import { EgressInfo, EgressStatus } from "livekit-server-sdk";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { RecordingService, type RecorderClient } from "../src/recordings.js";
import { MemoryStore, type Meeting, type Recording } from "../src/store.js";
import { digest, HttpError } from "../src/security.js";
import type { Media } from "../src/media.js";

const day = 86_400_000;
const origin = "http://localhost:5173";
const creationKey = "test-recording-creation-key-more-than-32-characters";
const forbidden = (error: unknown) =>
  error instanceof HttpError && error.status === 403;

async function fixture(
  t: TestContext,
  status = "ready",
  payloadBytes = 80_000,
) {
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
    close() {},
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
    Buffer.alloc(payloadBytes, 42),
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
  const endedRooms: string[] = [];
  const media: Media = {
    available: true,
    token: async () => "unused",
    remove: async () => {},
    end: async (meeting) => {
      endedRooms.push(meeting.code);
    },
    close() {},
  };
  async function app() {
    // Transports are created per send. Keep this factory stub for the test's
    // entire request lifecycle so no fixture opens an SMTP socket.
    t.mock.method(nodemailer, "createTransport", () => mail);
    const server = await createApp(config, store, media);
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
    endedRooms,
  };
}

function gateSecondFrameRead(store: MemoryStore, code: string) {
  const get = store.get.bind(store);
  const debit = store.debitRecordingDownload.bind(store);
  let debitCompleted = false;
  let frameReads = 0;
  let release!: () => void;
  let enter!: () => void;
  let unavailable = false;
  const entered = new Promise<void>((resolve) => (enter = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  store.debitRecordingDownload = async (...args) => {
    await debit(...args);
    if (args[0] === code) debitCompleted = true;
  };
  store.get = async (currentCode) => {
    if (currentCode === code && debitCompleted && ++frameReads === 2) {
      // Count frame checks after debit, independent of hosted or legacy preflight reads.
      enter();
      await gate;
      if (unavailable) throw new Error("Synthetic shared-store outage");
    }
    return get(currentCode);
  };
  return {
    entered,
    release,
    fail: () => (unavailable = true),
    restore: () => {
      store.get = get;
      store.debitRecordingDownload = debit;
    },
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

test("a revoked download stops before its next plaintext frame, including across service instances", async (t) => {
  const f = await fixture(t, "ready", 2 * 1024 * 1024 + 17);
  const used = await downloadAllowance(f, f.plaintext.length * 2);
  const link = await f.link();
  const gate = gateSecondFrameRead(f.store, f.meeting.code);
  const stream = await f.service.download(
    f.meeting,
    f.recording,
    link.token,
    link.password,
  );
  t.after(() => {
    gate.release();
    gate.restore();
    stream.destroy();
  });
  const frames = stream[Symbol.asyncIterator]();
  const first = await frames.next();
  assert.equal(first.done, false);
  assert.equal(first.value.length, 1024 * 1024);

  const otherInstance = new RecordingService(f.config, f.store, f.mail);
  const next = frames.next();
  await Promise.race([
    gate.entered,
    next.then(() => assert.fail("Second plaintext frame escaped authorization")),
  ]);
  try {
    await otherInstance.revoke(f.meeting, f.recording.id);
  } finally {
    gate.release();
  }
  await assert.rejects(next, forbidden);
  assert.equal(stream.destroyed, true);
  assert.equal(await used(), f.plaintext.length);

  const renewed = await f.link();
  assert.deepEqual(
    await f.collect(renewed.token, renewed.password),
    f.plaintext,
  );
  assert.equal(await used(), f.plaintext.length * 2);
});

test("an active download stops if current recording authority is unavailable", async (t) => {
  const f = await fixture(t, "ready", 2 * 1024 * 1024 + 17);
  const link = await f.link();
  const gate = gateSecondFrameRead(f.store, f.meeting.code);
  const stream = await f.service.download(
    f.meeting,
    f.recording,
    link.token,
    link.password,
  );
  t.after(() => {
    gate.release();
    gate.restore();
    stream.destroy();
  });
  const frames = stream[Symbol.asyncIterator]();
  assert.equal((await frames.next()).value.length, 1024 * 1024);
  const next = frames.next();
  await Promise.race([
    gate.entered,
    next.then(() => assert.fail("Second plaintext frame escaped authorization")),
  ]);
  gate.fail();
  gate.release();
  await assert.rejects(next, /Synthetic shared-store outage/);
  assert.equal(stream.destroyed, true);
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

test("SES configuration enables recording links without an SMTP host", async (t) => {
  const f = await fixture(t);
  f.config.smtpHost = "";
  f.config.mailTransport = "ses";
  f.config.mailDatabaseUrl =
    "postgres://mail:unused@localhost/covemeet_mail_test";
  f.config.ses = {
    region: "us-east-2",
    accountId: "123456789012",
    roleArn: "arn:aws:iam::123456789012:role/MailTest",
  };
  const service = new RecordingService(f.config, f.store, f.mail);
  assert.equal(service.available, true);
  const link = await service.link(f.meeting, f.recording.id);
  assert.match(link.url, /#.+/);
  assert.match(f.emails.at(-1)!.text, /Password: /);
  assert.doesNotMatch(f.emails.at(-1)!.text, /#|https?:/);
});

test("failed host verification email invalidates only its code", async (t) => {
  const f = await fixture(t);
  f.mail.sendMail = (async () => {
    throw new Error("Private provider error");
  }) as typeof f.mail.sendMail;
  const app = await f.app();
  const result = await app.inject({
    method: "POST",
    url: `/api/meetings/${f.meeting.code}/host-email`,
    headers: {
      origin,
      "x-requested-with": "MeetingPlatform",
      cookie: `mp_${f.meeting.code}=${f.hostSession}`,
    },
    payload: { email: "next@example.test" },
  });
  assert.equal(result.statusCode, 503);
  assert.match(result.body, /Verification email failed/);
  assert.doesNotMatch(result.body, /Private provider/);
  const meeting = (await f.store.get(f.meeting.code))!;
  assert.equal(meeting.hostEmailVerified, false);
  assert.equal(meeting.emailOtpHash, undefined);
  assert.equal(meeting.emailOtpExpiresAt, undefined);
  assert.equal(meeting.emailOtpAttempts, undefined);
});

test("a delayed email failure cannot clear a newer verification request", async (t) => {
  const f = await fixture(t);
  let rejectFirst!: (error: Error) => void;
  let firstSending!: () => void;
  const started = new Promise<void>((resolve) => {
    firstSending = resolve;
  });
  let attempts = 0;
  f.mail.sendMail = (async () => {
    if (++attempts === 1) {
      firstSending();
      await new Promise<void>((_resolve, reject) => {
        rejectFirst = reject;
      });
    }
    return { messageId: "synthetic" };
  }) as typeof f.mail.sendMail;
  const app = await f.app();
  const request = (email: string) =>
    app.inject({
      method: "POST",
      url: `/api/meetings/${f.meeting.code}/host-email`,
      headers: {
        origin,
        "x-requested-with": "MeetingPlatform",
        cookie: `mp_${f.meeting.code}=${f.hostSession}`,
      },
      payload: { email },
    });
  const first = request("first@example.test");
  await Promise.race([
    started,
    first.then(() => {
      throw new Error("First request did not reach mail");
    }),
  ]);
  let current: Meeting;
  try {
    assert.equal((await request("second@example.test")).statusCode, 200);
    current = (await f.store.get(f.meeting.code))!;
    assert.ok(current.emailOtpHash);
  } finally {
    rejectFirst(new Error("Synthetic timeout"));
    await first;
  }
  assert.equal((await first).statusCode, 503);
  const after = (await f.store.get(f.meeting.code))!;
  assert.equal(after.hostEmail, "second@example.test");
  assert.equal(after.emailOtpHash, current.emailOtpHash);
  assert.equal(after.emailOtpExpiresAt, current.emailOtpExpiresAt);
});

test("core mail sends release their transport before store shutdown", async (t) => {
  const f = await fixture(t);
  const closed: string[] = [];
  f.mail.close = () => {
    closed.push("mail");
  };
  f.store.close = async () => {
    closed.push("store");
  };
  const app = await f.app();
  const response = await app.inject({
    method: "POST",
    url: `/api/meetings/${f.meeting.code}/host-email`,
    headers: {
      origin,
      "x-requested-with": "MeetingPlatform",
      cookie: `mp_${f.meeting.code}=${f.hostSession}`,
    },
    payload: { email: "next@example.test" },
  });
  assert.equal(response.statusCode, 200);
  assert.equal(f.emails.length, 1);
  assert.deepEqual(closed, ["mail"]);
  await app.close();
  assert.deepEqual(closed, ["mail", "store"]);
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

test("turning recording off and ending a meeting persist stop intent with policy", async (t) => {
  const f = await fixture(t, "recording");
  const app = await f.app();
  const request = (method: "PATCH" | "POST", path: string, payload: object) =>
    app.inject({
      method,
      url: `/api/meetings/${f.meeting.code}${path}`,
      headers: {
        origin,
        "x-requested-with": "MeetingPlatform",
        cookie: `mp_${f.meeting.code}=${f.hostSession}`,
      },
      payload,
    });
  await request("PATCH", "", { recordingAllowed: false });
  let state = (await f.store.get(f.meeting.code))!;
  assert.equal(state.recordingAllowed, false);
  assert.equal(state.recordings[0]!.status, "stopping");

  await f.store.change(f.meeting.code, (m) => {
    m.recordings[0]!.status = "recording";
  });
  await request("POST", "/end", {});
  state = (await f.store.get(f.meeting.code))!;
  assert.equal(state.ended, true);
  assert.equal(state.recordings[0]!.status, "stopping");
  assert.deepEqual(f.endedRooms, [f.meeting.code]);
});

test("one expired recording failure does not block the next row", async (t) => {
  const f = await fixture(t);
  const next: Recording = {
    id: randomUUID(),
    status: "ready",
    createdAt: Date.now() - 8 * day,
  };
  await f.store.change(f.meeting.code, (m) => {
    m.recordings[0]!.createdAt = Date.now() - 8 * day;
    m.recordings.push(next);
  });
  const audit = f.store.audit.bind(f.store);
  f.store.audit = async (code, actor, action, target) => {
    if (target === f.recording.id)
      throw new Error("Synthetic retention failure");
    return audit(code, actor, action, target);
  };
  await f.service.reconcile((await f.store.get(f.meeting.code))!);
  const [failed, completed] = (await f.store.get(f.meeting.code))!.recordings;
  assert.equal(failed!.status, "deleting");
  assert.equal(completed!.status, "deleted");
});

test("retention continues after new recording and email are disabled", async (t) => {
  const f = await fixture(t);
  await f.store.change(f.meeting.code, (m) => {
    m.recordings[0]!.createdAt = Date.now() - 8 * day;
  });
  f.config.recordingEnabled = false;
  f.config.smtpHost = "";
  const restarted = new RecordingService(f.config, f.store, f.mail);
  assert.equal(restarted.available, false);
  await restarted.reconcile((await f.store.get(f.meeting.code))!);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.status,
    "deleted",
  );
  await assert.rejects(
    access(f.encrypted),
    (error: any) => error.code === "ENOENT",
  );
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

/** Service-boundary fake; actual S3 command and ciphertext tests live in the recording package. */
class TestObjectStorage implements RecordingObjectStorage {
  objects = new Map<string, Buffer>();
  failPut = false;
  failDelete = false;
  putCount = 0;
  afterPut?: () => void;
  async put(
    file: string,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
    provider: KeyProvider,
  ) {
    this.putCount++;
    if (this.failPut) throw new Error("object storage unavailable");
    await verifyEncryptedRecording(file, metadata, context, provider);
    const bytes = await readFile(file);
    const key = `${context.tenantId}/${context.meetingId}/${context.recordingId}/${metadata.recordingKeyId}`;
    if (this.objects.has(key)) assert.deepEqual(this.objects.get(key), bytes);
    this.objects.set(key, bytes);
    const reference: RecordingObjectReference = {
      provider: "s3",
      key,
      etag: '"test-version"',
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      versionId: "version-1",
    };
    this.afterPut?.();
    return reference;
  }
  async read(
    reference: RecordingObjectReference,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
    _signal?: AbortSignal,
  ) {
    assert.equal(
      reference.key,
      `${context.tenantId}/${context.meetingId}/${context.recordingId}/${metadata.recordingKeyId}`,
    );
    const bytes = this.objects.get(reference.key);
    if (!bytes) throw new Error("object missing");
    return Readable.from([bytes]);
  }
  async delete(reference: RecordingObjectReference) {
    if (this.failDelete) throw new Error("deletion unavailable");
    this.objects.delete(reference.key);
  }
}

async function collectFromService(
  service: RecordingService,
  f: Awaited<ReturnType<typeof fixture>>,
) {
  const link = await service.link(f.meeting, f.recording.id);
  const token = new URL(link.url).hash.slice(1);
  const password = /^Password: (.+)$/m.exec(f.emails.at(-1)!.text)![1]!;
  const stream = await service.download(
    f.meeting,
    f.recording,
    token,
    password,
  );
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function downloadAllowance(
  f: Awaited<ReturnType<typeof fixture>>,
  bytes = f.plaintext.length * 3,
) {
  const owner = randomUUID();
  await f.store.setHostedEntitlement({
    billingOwnerId: owner,
    revision: 1,
    enabled: true,
    validUntil: Date.now() + 300_000,
    hostAccountIds: [owner],
    limits: { participants: 100, durationSeconds: 7200, concurrentMeetings: 1 },
    quota: {
      anchorAt: Date.now() - day,
      participantSecondsPerMonth: 360_000,
      downloadBytesPerMonth: bytes,
    },
  });
  await f.store.change(f.meeting.code, (m) => {
    m.hosted = { accountId: owner, billingOwnerId: owner, version: 1 };
  });
  return async () =>
    // This preexisting file deliberately has no migrated storage inventory.
    // Downloads remain authorized; the aggregate storage view must fail closed.
    f.store.usageLedgers
      .get(owner)!
      .windows.reduce(
        (total, window) => total + (window.recordingDownloadBytesUsed ?? 0),
        0,
      );
}

function boundedSourceClose(source: Readable) {
  let timer: NodeJS.Timeout;
  return Promise.race([
    once(source, "close"),
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error("Download cancellation left its ciphertext source open"),
          ),
        1500,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

test("download starts debit the full file once, and a retry consumes another full debit", async (t) => {
  const f = await fixture(t);
  const used = await downloadAllowance(f, f.plaintext.length * 2);
  const link = await f.link();
  assert.deepEqual(await f.collect(link.token, link.password), f.plaintext);
  assert.equal(await used(), f.plaintext.length);
  assert.deepEqual(await f.collect(link.token, link.password), f.plaintext);
  assert.equal(await used(), f.plaintext.length * 2);
  await assert.rejects(f.collect(link.token, link.password), {
    code: "RECORDING_DOWNLOAD_QUOTA_UNAVAILABLE",
  });
  assert.equal(await used(), f.plaintext.length * 2);
});

test("invalid credentials and missing or unauthentic ciphertext never debit download bytes", async (t) => {
  const f = await fixture(t);
  const used = await downloadAllowance(f);
  const link = await f.link();
  await assert.rejects(f.collect(link.token, "incorrect"), forbidden);
  await assert.rejects(
    f.collect(randomBytes(32).toString("base64url"), link.password),
    forbidden,
  );
  const ciphertext = await readFile(f.encrypted);
  await unlink(f.encrypted);
  await assert.rejects(f.collect(link.token, link.password));
  // Corrupt the first data frame, leaving file size and metadata plausible.
  ciphertext[80] ^= 1;
  await writeFile(f.encrypted, ciphertext, { mode: 0o600 });
  await assert.rejects(f.collect(link.token, link.password));
  assert.equal(await used(), 0);
});

test(
  "download admission rechecks host, link, metadata, and retention after first-frame preparation",
  { timeout: 20_000 },
  async (t) => {
    const changes: [string, (m: Meeting) => void][] = [
      [
        "host session",
        (m) => {
          m.participants[0]!.tokenHash = "revoked";
        },
      ],
      [
        "link",
        (m) => {
          delete m.recordings[0]!.tokenHash;
        },
      ],
      [
        "password",
        (m) => {
          m.recordings[0]!.passwordHash = "replaced";
        },
      ],
      [
        "metadata",
        (m) => {
          m.recordings[0]!.metadata.plaintextBytes++;
        },
      ],
      [
        "ciphertext",
        (m) => {
          m.recordings[0]!.ciphertextId = randomUUID();
        },
      ],
      [
        "deletion",
        (m) => {
          m.recordings[0]!.status = "deleting";
        },
      ],
      [
        "retention",
        (m) => {
          m.recordings[0]!.createdAt = Date.now() - 8 * day;
        },
      ],
      [
        "account revocation",
        (m) => {
          m.hosted!.revoked = true;
        },
      ],
    ];
    for (const [name, change] of changes) {
      await t.test(name, async (t) => {
        const f = await fixture(t);
        const used = await downloadAllowance(f);
        const link = await f.link();
        const provider = new LocalKeyProvider({
          keyId: "operator-kek-v1",
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
        const service = new RecordingService(
          f.config,
          f.store,
          f.mail,
          undefined,
          {
            keyProvider: {
              wrapKey: (...args) => provider.wrapKey(...args),
              unwrapKey: async (...args) => {
                enter();
                await gate;
                return provider.unwrapKey(...args);
              },
            },
          },
        );
        const pending = service.download(
          f.meeting,
          f.recording,
          link.token,
          link.password,
          (current) => {
            if (current.participants[0]!.tokenHash !== digest(f.hostSession))
              throw new HttpError(403, "Host revoked");
          },
        );
        const denied = assert.rejects(pending, forbidden);
        try {
          await entered;
          await f.store.change(f.meeting.code, change);
        } finally {
          release();
        }
        await denied;
        assert.equal(await used(), 0);
      });
    }
  },
);

test(
  "unopened and interrupted outputs close their primed source without refunding the full debit",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const used = await downloadAllowance(f, f.plaintext.length * 2);
    const link = await f.link();
    const storage = new TestObjectStorage();
    const ciphertext = await readFile(f.encrypted);
    const reference: RecordingObjectReference = {
      provider: "s3",
      key: "synthetic-download",
      etag: '"test-version"',
      bytes: ciphertext.length,
      sha256: createHash("sha256").update(ciphertext).digest("hex"),
    };
    await f.store.change(f.meeting.code, (m) => {
      m.recordings[0]!.metadata.storage = reference;
    });
    const inputs: Readable[] = [];
    storage.read = async () => {
      // Authenticate the only data frame, but hold EOF indefinitely. A closed
      // source therefore proves cancellation, rather than natural completion.
      const input = new Readable({ read() {} });
      input.push(ciphertext.subarray(0, ciphertext.length - 25));
      inputs.push(input);
      return input;
    };
    t.after(() => {
      for (const input of inputs) input.destroy();
    });
    const service = new RecordingService(
      { ...f.config, recordingStorage: "s3" },
      f.store,
      f.mail,
      undefined,
      { objectStorage: storage },
    );
    const unopened = await service.download(
      f.meeting,
      f.recording,
      link.token,
      link.password,
    );
    const firstClosed = boundedSourceClose(inputs[0]!);
    unopened.destroy();
    await firstClosed;
    assert.equal(await used(), f.plaintext.length);
    const interrupted = await service.download(
      f.meeting,
      f.recording,
      link.token,
      link.password,
    );
    const secondClosed = boundedSourceClose(inputs[1]!);
    const iterator = interrupted[Symbol.asyncIterator]();
    assert.deepEqual((await iterator.next()).value, f.plaintext);
    interrupted.destroy();
    await secondClosed;
    assert.equal(await used(), f.plaintext.length * 2);
    await assert.rejects(
      service.download(f.meeting, f.recording, link.token, link.password),
      {
        code: "RECORDING_DOWNLOAD_QUOTA_UNAVAILABLE",
      },
    );
    assert.equal(
      inputs[2]!.destroyed,
      true,
      "Denied primed ciphertext must be closed",
    );
    assert.equal(await used(), f.plaintext.length * 2);
  },
);

test("retention denies new links and downloads before a cleanup worker runs", async (t) => {
  const f = await fixture(t);
  const used = await downloadAllowance(f);
  const link = await f.link();
  await f.store.change(f.meeting.code, (m) => {
    m.recordings[0]!.createdAt = Date.now() - 8 * day;
  });
  assert.equal(await f.service.findToken(link.token, f.meeting.code), null);
  await assert.rejects(f.collect(link.token, link.password), forbidden);
  await assert.rejects(
    f.link(),
    (error) => error instanceof HttpError && error.status === 409,
  );
  await access(f.encrypted);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.status,
    "ready",
  );
  assert.equal(await used(), 0);
});

test(
  "aborting before the first authenticated frame closes ciphertext and never debits",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const used = await downloadAllowance(f);
    const link = await f.link();
    const ciphertext = await readFile(f.encrypted);
    const controller = new AbortController();
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let input!: Readable;
    t.after(() => input?.destroy());
    const storage = new TestObjectStorage();
    let reads = 0;
    storage.read = async (_reference, _metadata, _context, signal) => {
      reads++;
      assert.equal(signal, controller.signal);
      input = new Readable({
        read() {
          enter();
        },
      });
      input.push(ciphertext.subarray(0, 68)); // Valid header, no authenticated frame.
      return input;
    };
    await f.store.change(f.meeting.code, (m) => {
      m.recordings[0]!.metadata.storage = {
        provider: "s3",
        key: "synthetic-download",
        etag: '"test-version"',
        bytes: ciphertext.length,
        sha256: createHash("sha256").update(ciphertext).digest("hex"),
      };
    });
    const service = new RecordingService(
      { ...f.config, recordingStorage: "s3" },
      f.store,
      f.mail,
      undefined,
      { objectStorage: storage },
    );
    const pending = service.download(
      f.meeting,
      f.recording,
      link.token,
      link.password,
      undefined,
      controller.signal,
    );
    const denied = assert.rejects(pending, { name: "AbortError" });
    await entered;
    const closed = boundedSourceClose(input);
    controller.abort();
    await closed;
    await denied;
    assert.equal(await used(), 0);
    assert.equal(reads, 1);
    await assert.rejects(
      service.download(
        f.meeting,
        f.recording,
        link.token,
        link.password,
        undefined,
        controller.signal,
      ),
      { name: "AbortError" },
    );
    assert.equal(reads, 1, "An already-aborted request must not open storage");
  },
);

test(
  "HTTP disconnect while download admission waits prevents the atomic debit",
  { timeout: 10_000 },
  async (t) => {
    const f = await fixture(t);
    const used = await downloadAllowance(f);
    const link = await f.link();
    const app = await f.app();
    let enter!: () => void;
    let release!: () => void;
    let complete!: () => void;
    let closed!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const completed = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const disconnected = new Promise<void>((resolve) => {
      closed = resolve;
    });
    const debit = f.store.debitRecordingDownload.bind(f.store);
    f.store.debitRecordingDownload = async (...args) => {
      enter();
      try {
        await gate;
        return await debit(...args);
      } finally {
        complete();
      }
    };
    app.addHook("onRequest", async (_req, reply) => {
      reply.raw.once("close", () => {
        if (!reply.raw.writableFinished) closed();
      });
    });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const body = JSON.stringify({ token: link.token, password: link.password });
    const client = httpRequest(
      `${address}/api/meetings/${f.meeting.code}/download`,
      {
        method: "POST",
        headers: {
          origin,
          "x-requested-with": "MeetingPlatform",
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          cookie: `mp_${f.meeting.code}=${f.hostSession}`,
        },
      },
    );
    client.on("error", () => {});
    client.end(body);
    try {
      await entered;
      client.destroy();
      await disconnected;
    } finally {
      client.destroy();
      release();
    }
    await completed;
    assert.equal(await used(), 0);
  },
);

test("native download forms require exact Origin, strict fields, and the current host session", async (t) => {
  const f = await fixture(t);
  const used = await downloadAllowance(f);
  const link = await f.link();
  const app = await f.app();
  let address = 1;
  const fields = new URLSearchParams({
    token: link.token,
    password: link.password,
  }).toString();
  const request = (
    options: {
      origin?: string;
      session?: string;
      payload?: string;
      url?: string;
      xrw?: boolean;
    } = {},
  ) =>
    app.inject({
      method: "POST",
      url: options.url ?? `/api/meetings/${f.meeting.code}/download`,
      remoteAddress: `198.51.100.${address++}`,
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.session
          ? { cookie: `mp_${f.meeting.code}=${options.session}` }
          : {}),
        ...(options.xrw ? { "x-requested-with": "MeetingPlatform" } : {}),
      },
      payload: options.payload ?? fields,
    });
  const noOrigin = await request({ session: f.hostSession });
  assert.equal(noOrigin.statusCode, 403);
  assert.match(String(noOrigin.headers["content-type"]), /^text\/html/);
  assert.match(noOrigin.body, /<pre>.*Request verification failed.*<\/pre>/);
  assert.equal(
    (await request({ origin: "null", session: f.hostSession })).statusCode,
    403,
  );
  assert.equal(
    (await request({ origin: "https://foreign.test", session: f.hostSession }))
      .statusCode,
    403,
  );
  assert.notEqual(
    (await request({ session: f.hostSession, xrw: true })).statusCode,
    200,
  );
  assert.equal((await request({ origin })).statusCode, 401);
  assert.equal(
    (await request({ origin, session: f.guestSession })).statusCode,
    403,
  );
  for (const payload of [
    `${fields}&token=duplicate`,
    `${fields}&extra=field`,
    "token=missing-password",
  ])
    assert.equal(
      (await request({ origin, session: f.hostSession, payload })).statusCode,
      400,
    );
  const hostileField = new URLSearchParams({
    "</pre><script>&</script>": "unused",
  });
  const escapedError = await request({
    origin,
    session: f.hostSession,
    payload: `${fields}&${hostileField}`,
  });
  assert.equal(escapedError.statusCode, 400);
  assert.match(
    escapedError.body,
    /&lt;\/pre&gt;&lt;script&gt;&amp;&lt;\/script&gt;/,
  );
  assert.doesNotMatch(escapedError.body, /<script\b/i);
  assert.equal(
    (
      await request({
        origin,
        session: f.hostSession,
        url: `/api/meetings/${f.meeting.code}/end`,
      })
    ).statusCode,
    403,
  );
  assert.equal(await used(), 0);
  const response = await request({
    origin,
    session: f.hostSession,
    url: `/api/meetings/${f.meeting.code}/%64ownload`,
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.rawPayload, f.plaintext);
  assert.match(String(response.headers["content-disposition"]), /^attachment;/);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "same-origin");
  assert.equal(await used(), f.plaintext.length);
  const debit = f.store.debitRecordingDownload.bind(f.store);
  f.store.debitRecordingDownload = async (...args) => {
    await f.store.change(f.meeting.code, (m) => {
      m.participants[0]!.tokenHash = "revoked";
    });
    return debit(...args);
  };
  assert.equal(
    (await request({ origin, session: f.hostSession })).statusCode,
    401,
  );
  assert.equal(await used(), f.plaintext.length);
});

test("failed object upload preserves private recovery files and retries before recording becomes ready", async (t) => {
  const f = await fixture(t, "encrypting");
  const storage = new TestObjectStorage();
  storage.failPut = true;
  const service = new RecordingService(
    { ...f.config, recordingStorage: "s3" },
    f.store,
    f.mail,
    undefined,
    { objectStorage: storage },
  );
  await service.reconcile((await f.store.get(f.meeting.code))!);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.status,
    "encrypting",
  );
  await access(f.raw);
  await access(f.encrypted);
  await assert.rejects(
    service.link(f.meeting, f.recording.id),
    (error: any) => error.status === 409,
  );
  storage.failPut = false;
  await service.reconcile((await f.store.get(f.meeting.code))!);
  const row = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(row.status, "ready");
  assert.ok(row.metadata.storage);
  await assert.rejects(access(f.raw));
  await assert.rejects(access(f.encrypted));
  assert.deepEqual(await collectFromService(service, f), f.plaintext);
});

test("lost database acknowledgement after object upload is retryable without losing ciphertext or plaintext cleanup", async (t) => {
  const f = await fixture(t, "encrypting");
  const storage = new TestObjectStorage();
  const service = new RecordingService(
    { ...f.config, recordingStorage: "s3" },
    f.store,
    f.mail,
    undefined,
    { objectStorage: storage },
  );
  let failNextCommit = false;
  const change = f.store.change.bind(f.store);
  f.store.change = (async (...args: Parameters<typeof f.store.change>) => {
    if (failNextCommit) {
      failNextCommit = false;
      throw new Error("database unavailable");
    }
    return change(...args);
  }) as typeof f.store.change;
  storage.afterPut = () => {
    failNextCommit = true;
    storage.afterPut = undefined;
  };
  await service.reconcile((await f.store.get(f.meeting.code))!);
  assert.equal(storage.objects.size, 1);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.metadata.storage,
    undefined,
  );
  await access(f.raw);
  await access(f.encrypted);
  await service.reconcile((await f.store.get(f.meeting.code))!);
  assert.equal(storage.objects.size, 1);
  assert.equal(storage.putCount, 2);
  assert.deepEqual(await collectFromService(service, f), f.plaintext);
});

test("operator rotation preserves S3 identity and recovery works after old key is removed", async (t) => {
  const f = await fixture(t, "encrypting");
  const storage = new TestObjectStorage();
  const newKey = randomBytes(32).toString("base64");
  const config = {
    ...f.config,
    recordingStorage: "s3",
    recordingActiveKeyId: "operator-kek-v2",
    recordingLocalKeys: {
      ...f.config.recordingLocalKeys,
      "operator-kek-v2": newKey,
    },
  };
  const service = new RecordingService(config, f.store, f.mail, undefined, {
    objectStorage: storage,
  });
  await service.reconcile((await f.store.get(f.meeting.code))!);
  const before = structuredClone(
    (await f.store.get(f.meeting.code))!.recordings[0]!.metadata,
  );
  assert.equal(before.wrappedKey.keyId, "operator-kek-v1");
  await service.rotateKey(f.meeting, f.recording.id);
  const after = (await f.store.get(f.meeting.code))!.recordings[0]!.metadata;
  assert.equal(after.wrappedKey.keyId, "operator-kek-v2");
  assert.deepEqual(after.storage, before.storage);
  assert.equal(after.recordingKeyId, before.recordingKeyId);
  const recovered = new RecordingService(
    { ...config, recordingLocalKeys: { "operator-kek-v2": newKey } },
    f.store,
    f.mail,
    undefined,
    { objectStorage: storage },
  );
  assert.deepEqual(await collectFromService(recovered, f), f.plaintext);
});

test("failed rotation recovery does not replace the known-good envelope", async (t) => {
  const f = await fixture(t);
  const before = structuredClone(
    (await f.store.get(f.meeting.code))!.recordings[0]!.metadata,
  );
  const old = new LocalKeyProvider({
    keyId: "operator-kek-v1",
    key: Buffer.from(f.config.recordingKek, "base64"),
  });
  const wrong = new LocalKeyProvider({
    keyId: "new-unrecoverable",
    key: randomBytes(32),
  });
  t.after(() => {
    old.destroy();
    wrong.destroy();
  });
  const service = new RecordingService(f.config, f.store, f.mail, undefined, {
    keyProvider: {
      wrapKey: (key, binding) => wrong.wrapKey(key, binding),
      unwrapKey: (wrapped, binding) => old.unwrapKey(wrapped, binding),
    },
  });
  await assert.rejects(service.rotateKey(f.meeting, f.recording.id));
  assert.deepEqual(
    (await f.store.get(f.meeting.code))!.recordings[0]!.metadata,
    before,
  );
  assert.deepEqual(await collectFromService(f.service, f), f.plaintext);
});

test("object retention revokes access even during storage failure and retries deletion", async (t) => {
  const f = await fixture(t, "encrypting");
  const storage = new TestObjectStorage();
  const service = new RecordingService(
    { ...f.config, recordingStorage: "s3" },
    f.store,
    f.mail,
    undefined,
    { objectStorage: storage },
  );
  await service.reconcile((await f.store.get(f.meeting.code))!);
  const link = await service.link(f.meeting, f.recording.id);
  const token = new URL(link.url).hash.slice(1);
  await f.store.change(f.meeting.code, (meeting) => {
    meeting.recordings[0]!.createdAt = Date.now() - 8 * day;
  });
  storage.failDelete = true;
  await service.reconcile((await f.store.get(f.meeting.code))!);
  assert.equal(await service.findToken(token, f.meeting.code), null);
  assert.equal(storage.objects.size, 1);
  storage.failDelete = false;
  await service.reconcile((await f.store.get(f.meeting.code))!);
  assert.equal(storage.objects.size, 0);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.status,
    "deleted",
  );
});

test("recording configuration rejects invalid keyrings and production HTTP object endpoints", async () => {
  const base = {
    SESSION_SECRET: "recording-config-test-more-than-32-characters",
    RECORDING_ENABLED: "true",
    RECORDING_KEK: randomBytes(32).toString("base64"),
    LIVEKIT_API_KEY: "key",
    LIVEKIT_API_SECRET: "secret",
    SMTP_HOST: "mail.test",
  };
  for (const value of [
    "not-json",
    "[]",
    '{"bad/key":"abc"}',
    '{"key":"short"}',
  ]) {
    assert.throws(() => loadConfig({ ...base, RECORDING_LOCAL_KEYS: value }));
  }
  assert.throws(() => loadConfig({ ...base, RECORDING_STORAGE: "public-web" }));
  const config = loadConfig({
    ...base,
    NODE_ENV: "production",
    SITE_ORIGIN: "https://meet.example.test",
    RECORDING_STORAGE: "s3",
    RECORDING_S3_BUCKET: "private-recordings",
    RECORDING_S3_ENDPOINT: "http://127.0.0.1:9000",
    RECORDING_S3_ALLOW_LOCAL_HTTP: "true",
  });
  assert.throws(
    () => new RecordingService(config, new MemoryStore(), {} as Transporter),
    /HTTPS/,
  );
});

function completedRecorder(): RecorderClient {
  return {
    listEgress: async () => [
      new EgressInfo({
        egressId: "test-egress-id",
        status: EgressStatus.EGRESS_COMPLETE,
      }),
    ],
  } as unknown as RecorderClient;
}

test("concurrent and stale reconciliations preserve the committed encryption attempt", async (t) => {
  const f = await fixture(t, "recording");
  await f.store.change(f.meeting.code, (m) => {
    delete m.recordings[0]!.metadata;
  });
  const originalCiphertext = await readFile(f.encrypted);
  const provider = new LocalKeyProvider({
    keyId: "operator-kek-v1",
    key: Buffer.from(f.config.recordingKek, "base64"),
  });
  t.after(() => provider.destroy());
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let wraps = 0;
  const owner = new RecordingService(
    f.config,
    f.store,
    f.mail,
    completedRecorder(),
    {
      keyProvider: {
        wrapKey: async (...args) => {
          wraps++;
          entered();
          await blocked;
          return provider.wrapKey(...args);
        },
        unwrapKey: (...args) => provider.unwrapKey(...args),
      },
    },
  );
  const other = new RecordingService(
    f.config,
    f.store,
    f.mail,
    completedRecorder(),
  );
  const stale = (await f.store.get(f.meeting.code))!;
  const first = owner.reconcile(stale);
  await pending;
  await other.reconcile(stale);
  await access(f.raw);
  release();
  await first;
  const committed = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(committed.status, "ready");
  assert.ok(committed.ciphertextId);
  const ciphertext = path.join(
    f.config.recordingDir,
    "encrypted",
    `${committed.id}.${committed.ciphertextId}.mprec`,
  );
  const committedBytes = await readFile(ciphertext);
  await other.reconcile(stale);
  assert.equal(wraps, 1);
  assert.deepEqual(
    (await f.store.get(f.meeting.code))!.recordings[0]!.metadata,
    committed.metadata,
  );
  assert.deepEqual(await readFile(ciphertext), committedBytes);
  assert.deepEqual(
    await readFile(f.encrypted),
    originalCiphertext,
    "An uncertain old output must never be overwritten or deleted",
  );
  assert.deepEqual(await collectFromService(other, f), f.plaintext);
});

test("a lost encryption commit acknowledgement preserves its committed immutable output", async (t) => {
  const f = await fixture(t, "recording");
  await f.store.change(f.meeting.code, (m) => {
    delete m.recordings[0]!.metadata;
  });
  const change = f.store.change.bind(f.store);
  let loseCommit = true;
  f.store.change = async (...args) => {
    const result = await change(...args);
    const row = (await f.store.get(f.meeting.code))!.recordings[0]!;
    if (loseCommit && row.metadata && row.ciphertextId) {
      loseCommit = false;
      throw new Error("Commit acknowledgement lost");
    }
    return result;
  };
  const service = new RecordingService(
    f.config,
    f.store,
    f.mail,
    completedRecorder(),
  );
  await service.reconcile((await f.store.get(f.meeting.code))!);
  const committed = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(committed.status, "encrypting");
  const ciphertext = path.join(
    f.config.recordingDir,
    "encrypted",
    `${committed.id}.${committed.ciphertextId}.mprec`,
  );
  const before = await readFile(ciphertext);
  await access(f.raw);
  await service.reconcile((await f.store.get(f.meeting.code))!);
  assert.deepEqual(await readFile(ciphertext), before);
  assert.deepEqual(
    (await f.store.get(f.meeting.code))!.recordings[0]!.metadata,
    committed.metadata,
  );
  assert.deepEqual(await collectFromService(service, f), f.plaintext);
});

test("recovery preserves plaintext when committed ciphertext is missing or damaged", async (t) => {
  const f = await fixture(t, "encrypting");
  const ciphertext = await readFile(f.encrypted);
  await unlink(f.encrypted);
  await f.service.reconcile((await f.store.get(f.meeting.code))!);
  await access(f.raw);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.status,
    "encrypting",
  );
  ciphertext[ciphertext.length - 1] ^= 1;
  await writeFile(f.encrypted, ciphertext);
  await f.service.reconcile((await f.store.get(f.meeting.code))!);
  await access(f.raw);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.status,
    "encrypting",
  );
});

test("retention is exclusive and denies new links before storage deletion completes", async (t) => {
  const f = await fixture(t, "encrypting");
  const storage = new TestObjectStorage();
  const first = new RecordingService(
    { ...f.config, recordingStorage: "s3" },
    f.store,
    f.mail,
    undefined,
    { objectStorage: storage },
  );
  const second = new RecordingService(
    { ...f.config, recordingStorage: "s3" },
    f.store,
    f.mail,
    undefined,
    { objectStorage: storage },
  );
  await first.reconcile((await f.store.get(f.meeting.code))!);
  await f.store.change(f.meeting.code, (m) => {
    m.recordings[0]!.createdAt = Date.now() - 8 * day;
  });
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const remove = storage.delete.bind(storage);
  let deletions = 0;
  storage.delete = async (...args) => {
    deletions++;
    entered();
    await blocked;
    await remove(...args);
  };
  const stale = (await f.store.get(f.meeting.code))!;
  const deleting = first.reconcile(stale);
  await pending;
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.status,
    "deleting",
  );
  await second.reconcile(stale);
  await assert.rejects(
    second.link(f.meeting, f.recording.id),
    (error: any) => error.status === 409,
  );
  await assert.rejects(
    second.rotateKey(f.meeting, f.recording.id),
    (error: any) => error.status === 409,
  );
  release();
  await deleting;
  await second.reconcile(stale);
  assert.equal(deletions, 1);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.status,
    "deleted",
  );
});

test("recording refuses public or redirected spool directories and over-limit sources", async (t) => {
  const f = await fixture(t, "recording");
  await f.store.change(f.meeting.code, (m) => {
    delete m.recordings[0]!.metadata;
  });
  const service = new RecordingService(
    { ...f.config, recordingMaxBytes: 93 },
    f.store,
    f.mail,
    completedRecorder(),
  );
  await service.reconcile((await f.store.get(f.meeting.code))!);
  await access(f.raw);
  assert.equal((await readdir(path.dirname(f.encrypted))).length, 1);
  await chmod(path.dirname(f.raw), 0o755);
  await assert.rejects(service.start(f.meeting), /private directories/);
  await chmod(path.dirname(f.raw), 0o700);
  const redirected = path.join(f.config.recordingDir, "redirected");
  await mkdir(redirected, { mode: 0o700 });
  await rm(path.dirname(f.raw), { recursive: true });
  await symlink(redirected, path.dirname(f.raw));
  await assert.rejects(service.start(f.meeting), /private directories/);
});
