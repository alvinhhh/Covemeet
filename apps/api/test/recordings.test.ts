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
  readEncryptionReceipt,
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
  assert.deepEqual(Object.keys(apiResult).sort(), [
    "expiresAt",
    "passwordEmailSent",
    "url",
  ]);
  assert.equal(apiResult.passwordEmailSent, true);
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
    next.then(() =>
      assert.fail("Second plaintext frame escaped authorization"),
    ),
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
    next.then(() =>
      assert.fail("Second plaintext frame escaped authorization"),
    ),
  ]);
  gate.fail();
  gate.release();
  await assert.rejects(next, /Synthetic shared-store outage/);
  assert.equal(stream.destroyed, true);
});

test("email failure retains one encrypted password intent for an exact retry", async (t) => {
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
  assert.ok(row.tokenHash);
  assert.ok(row.passwordHash);
  assert.ok(row.expiresAt);
  assert.ok(row.delivery?.password?.wrappedKey.ciphertext);
  assert.equal(JSON.stringify(row).includes("Synthetic SMTP failure"), false);
});

test("completed recording issues one recoverable link, emails only the password, and purges its envelope", async (t) => {
  const f = await fixture(t);
  await f.store.change(f.meeting.code, (meeting) => {
    meeting.recordings[0]!.autoLinkPending = true;
    meeting.recordings[0]!.readyAt = Date.now();
  });
  const service = new RecordingService(
    { ...f.config, recordingEnabled: false },
    f.store,
    f.mail,
  );
  await service.reconcileDelivery((await f.store.get(f.meeting.code))!);
  await service.reconcileDelivery((await f.store.get(f.meeting.code))!);
  assert.equal(f.emails.length, 1);
  const row = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(row.autoLinkPending, false);
  assert.ok(row.delivery?.sentAt);
  assert.equal(row.delivery?.password, undefined);
  assert.ok(row.delivery?.token.wrappedKey.ciphertext);
  assert.equal(row.delivery?.mode, "auto");
  const link = await service.currentLink(f.meeting, f.recording.id);
  assert.equal(link.passwordEmailSent, true);
  assert.equal(new URL(link.url).pathname, `/download/${f.meeting.code}`);
  assert.ok(!f.emails[0]!.text.includes(link.url));
  assert.ok(!f.emails[0]!.text.includes(new URL(link.url).hash.slice(1)));
  const app = await f.app();
  const url = `/api/meetings/${f.meeting.code}/recordings/${f.recording.id}/link`;
  const guest = await app.inject({
    method: "GET",
    url,
    headers: { cookie: `mp_${f.meeting.code}=${f.guestSession}` },
  });
  assert.equal(guest.statusCode, 403);
  const host = await app.inject({
    method: "GET",
    url,
    headers: { cookie: `mp_${f.meeting.code}=${f.hostSession}` },
  });
  assert.equal(host.statusCode, 200);
  assert.equal(host.json().url, link.url);
  assert.equal(host.json().passwordEmailSent, true);
  assert.equal(host.headers["cache-control"], "no-store");
  await service.revoke(f.meeting, f.recording.id);
  await assert.rejects(service.currentLink(f.meeting, f.recording.id));
  const revoked = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(revoked.delivery, undefined);
});

test("current link reports pending password email until delivery is acknowledged", async (t) => {
  const f = await fixture(t);
  await f.store.change(f.meeting.code, (meeting) => {
    meeting.recordings[0]!.autoLinkPending = true;
    meeting.recordings[0]!.readyAt = Date.now();
  });
  const sendMail = f.mail.sendMail.bind(f.mail);
  f.mail.sendMail = (async () => {
    throw new Error("Synthetic mail outage");
  }) as typeof f.mail.sendMail;
  await f.service.reconcileDelivery((await f.store.get(f.meeting.code))!);
  const app = await f.app();
  const url = `/api/meetings/${f.meeting.code}/recordings/${f.recording.id}/link`;
  const getLink = () =>
    app.inject({
      method: "GET",
      url,
      headers: { cookie: `mp_${f.meeting.code}=${f.hostSession}` },
    });
  const pending = await getLink();
  assert.equal(pending.statusCode, 200);
  assert.equal(pending.json().passwordEmailSent, false);
  assert.equal(f.emails.length, 0);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.delivery?.sentAt,
    undefined,
  );

  f.mail.sendMail = sendMail as typeof f.mail.sendMail;
  await f.store.change(f.meeting.code, (meeting) => {
    meeting.recordings[0]!.delivery!.nextAttemptAt = 0;
  });
  await f.service.reconcileDelivery((await f.store.get(f.meeting.code))!);
  const sent = await getLink();
  assert.equal(sent.statusCode, 200);
  assert.equal(sent.json().passwordEmailSent, true);
  assert.equal(sent.json().url, pending.json().url);
  assert.equal(f.emails.length, 1);
  assert.ok((await f.store.get(f.meeting.code))!.recordings[0]!.delivery?.sentAt);
});

test("ambiguous password mail retries the same message and credentials without reminting", async (t) => {
  const f = await fixture(t);
  await f.store.change(f.meeting.code, (meeting) => {
    meeting.recordings[0]!.autoLinkPending = true;
  });
  const delivered: Record<string, any>[] = [];
  let first = true;
  f.mail.sendMail = (async (message: Record<string, any>) => {
    delivered.push(message);
    if (first) {
      first = false;
      throw new Error("Accepted before response was lost");
    }
    return { messageId: "synthetic" };
  }) as typeof f.mail.sendMail;
  await f.service.reconcileDelivery((await f.store.get(f.meeting.code))!);
  const pending = (await f.store.get(f.meeting.code))!.recordings[0]!;
  const originalHash = pending.tokenHash;
  const originalIntent = pending.delivery?.id;
  assert.ok(pending.delivery?.password);
  await f.store.change(f.meeting.code, (meeting) => {
    meeting.recordings[0]!.delivery!.nextAttemptAt = 0;
  });
  await f.service.reconcileDelivery((await f.store.get(f.meeting.code))!);
  await f.service.reconcileDelivery((await f.store.get(f.meeting.code))!);
  const finished = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0]!.messageId, delivered[1]!.messageId);
  assert.equal(delivered[0]!.text, delivered[1]!.text);
  assert.equal(finished.tokenHash, originalHash);
  assert.equal(finished.delivery?.id, originalIntent);
  assert.equal(finished.delivery?.password, undefined);
});

test("one damaged delivery cannot starve a later recording in the same room", async (t) => {
  const f = await fixture(t);
  f.mail.sendMail = (async () => {
    throw new Error("Synthetic initial outage");
  }) as typeof f.mail.sendMail;
  await assert.rejects(f.service.link(f.meeting, f.recording.id));
  const laterId = randomUUID();
  await f.store.change(f.meeting.code, (meeting) => {
    const first = meeting.recordings[0]!;
    first.delivery!.password!.wrappedKey.ciphertext = "invalid";
    first.delivery!.nextAttemptAt = 0;
    meeting.recordings.push({
      id: laterId,
      status: "ready",
      createdAt: Date.now(),
      readyAt: Date.now(),
      autoLinkPending: true,
    });
  });
  const delivered: Record<string, any>[] = [];
  f.mail.sendMail = (async (message: Record<string, any>) => {
    delivered.push(message);
    return { messageId: "synthetic" };
  }) as typeof f.mail.sendMail;
  await f.service.reconcileDelivery((await f.store.get(f.meeting.code))!);
  await f.service.reconcileDelivery((await f.store.get(f.meeting.code))!);
  assert.equal(delivered.length, 1);
  assert.match(delivered[0]!.text, new RegExp(`Recording: ${laterId}`));
  assert.ok(
    (await f.store.get(f.meeting.code))!.recordings[1]!.delivery?.sentAt,
  );
});

test("changing the verified host email cancels an in-flight password delivery and its link", async (t) => {
  const f = await fixture(t);
  await f.store.change(f.meeting.code, (meeting) => {
    meeting.recordings[0]!.autoLinkPending = true;
  });
  let entered!: () => void;
  let release!: () => void;
  const sending = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  f.mail.sendMail = (async (message: Record<string, any>) => {
    if (message.subject === "Recording download password") {
      entered();
      await gate;
    }
    f.emails.push(message);
    return { messageId: "synthetic" };
  }) as typeof f.mail.sendMail;
  const pending = f.service.reconcileDelivery(
    (await f.store.get(f.meeting.code))!,
  );
  await sending;
  try {
    const app = await f.app();
    const changed = await app.inject({
      method: "POST",
      url: `/api/meetings/${f.meeting.code}/host-email`,
      headers: {
        origin,
        "x-requested-with": "MeetingPlatform",
        cookie: `mp_${f.meeting.code}=${f.hostSession}`,
      },
      payload: { email: "replacement@example.test" },
    });
    assert.equal(changed.statusCode, 200);
  } finally {
    release();
    await pending;
  }
  const row = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(row.tokenHash, undefined);
  assert.equal(row.passwordHash, undefined);
  assert.equal(row.delivery, undefined);
  assert.equal(row.autoLinkPending, false);
  assert.equal(await f.service.findToken("A".repeat(43), f.meeting.code), null);
});

test("host revoke invalidates a link before a blocked password send returns", async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  let release!: () => void;
  const sending = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  f.mail.sendMail = (async (message: Record<string, any>) => {
    if (message.subject === "Recording download password") {
      entered();
      await gate;
    }
    return { messageId: "synthetic" };
  }) as typeof f.mail.sendMail;
  const app = await f.app();
  const path = `/api/meetings/${f.meeting.code}/recordings/${f.recording.id}`;
  const issue = app.inject({
    method: "POST",
    url: `${path}/link`,
    headers: {
      origin,
      "x-requested-with": "MeetingPlatform",
      cookie: `mp_${f.meeting.code}=${f.hostSession}`,
    },
    payload: {},
  });
  await sending;
  try {
    const revoke = app.inject({
      method: "POST",
      url: `${path}/revoke`,
      headers: {
        origin,
        "x-requested-with": "MeetingPlatform",
        cookie: `mp_${f.meeting.code}=${f.hostSession}`,
      },
      payload: {},
    });
    const quick = await Promise.race([
      revoke.then((response) => response.statusCode),
      new Promise<number>((resolve) => setTimeout(() => resolve(0), 250)),
    ]);
    assert.equal(quick, 200, "Revoke must not wait for SMTP");
  } finally {
    release();
  }
  assert.equal((await issue).statusCode, 403);
  const row = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(row.tokenHash, undefined);
  assert.equal(row.delivery, undefined);
});

test("revoke during a KMS wrap prevents a late link commit", async (t) => {
  const f = await fixture(t);
  const key = Buffer.from(f.config.recordingKek, "base64");
  const local = new LocalKeyProvider({ keyId: "operator-kek-v1", key });
  let entered!: () => void;
  let release!: () => void;
  const wrapping = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  let first = true;
  const provider: KeyProvider = {
    wrapKey: async (secret, binding) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return local.wrapKey(secret, binding);
    },
    unwrapKey: (wrapped, binding) => local.unwrapKey(wrapped, binding),
  };
  const service = new RecordingService(f.config, f.store, f.mail, undefined, {
    keyProvider: provider,
  });
  const pending = service.link(f.meeting, f.recording.id);
  await wrapping;
  try {
    await service.revoke(f.meeting, f.recording.id);
    assert.equal(
      (await f.store.get(f.meeting.code))!.recordings[0]!.linkGeneration,
      1,
    );
  } finally {
    release();
  }
  await assert.rejects(pending, (error: any) => error.status === 409);
  const row = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(row.tokenHash, undefined);
  assert.equal(row.delivery, undefined);
  assert.equal(f.emails.length, 0);
  local.destroy();
  key.fill(0);
});

test("host link read rechecks the cookie after asynchronous token recovery", async (t) => {
  const f = await fixture(t);
  await f.link();
  const app = await f.app();
  const get = f.store.get.bind(f.store);
  let reads = 0;
  let entered!: () => void;
  let release!: () => void;
  const recovering = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  f.store.get = async (code) => {
    const snapshot = await get(code);
    if (code === f.meeting.code && ++reads === 2) {
      entered();
      await gate;
    }
    return snapshot;
  };
  const response = app.inject({
    method: "GET",
    url: `/api/meetings/${f.meeting.code}/recordings/${f.recording.id}/link`,
    headers: { cookie: `mp_${f.meeting.code}=${f.hostSession}` },
  });
  await recovering;
  try {
    await f.store.change(f.meeting.code, (meeting) => {
      meeting.participants[0]!.tokenHash = digest("replacement-host-cookie");
    });
  } finally {
    release();
  }
  assert.equal((await response).statusCode, 401);
});

test("expired delivery purges both envelopes without a mail or key provider", async (t) => {
  const f = await fixture(t);
  f.mail.sendMail = (async () => {
    throw new Error("Synthetic outage");
  }) as typeof f.mail.sendMail;
  await assert.rejects(f.service.link(f.meeting, f.recording.id));
  const link = await f.service.currentLink(f.meeting, f.recording.id);
  assert.ok(
    (await f.store.get(f.meeting.code))!.recordings[0]!.delivery?.password,
  );
  await f.store.change(f.meeting.code, (meeting) => {
    meeting.recordings[0]!.expiresAt = Date.now() - 1;
  });
  const disabled = new RecordingService(
    { ...f.config, recordingEnabled: false, recordingLocalKeys: {} },
    f.store,
    undefined,
  );
  await disabled.reconcileDelivery((await f.store.get(f.meeting.code))!);
  const row = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(row.tokenHash, undefined);
  assert.equal(row.passwordHash, undefined);
  assert.equal(row.delivery, undefined);
  assert.equal(
    await f.service.findToken(new URL(link.url).hash.slice(1), f.meeting.code),
    null,
  );
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

test("new capture can be disabled while retained links still require a verified host email", async (t) => {
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
  const retained = await disabled.link(f.meeting, f.recording.id);
  assert.match(retained.url, /#.+/);
  await f.store.change(f.meeting.code, (meeting) => {
    meeting.hostEmailVerified = false;
  });
  await assert.rejects(f.link(), forbidden);
  assert.equal(f.emails.length, 1);
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
  const legacy = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(legacy.contextVersion, undefined);
  assert.equal(legacy.metadata.context.tenantId, "installation");
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

test("recording reservation stamps context from the locked room, never a supplied marker", async (t) => {
  const f = await fixture(t);
  await f.store.change(f.meeting.code, (m) => { m.recordings = []; });
  const reserve = (id: string) => f.store.withRecordingLock(
    f.meeting.code,
    id,
    (lock) => lock.reserveRecording(
      { id, status: "starting", createdAt: Date.now(), contextVersion: 1 },
      () => {},
      { maxBytes: 1_000_000, copies: 1 },
    ),
  );
  const selfHosted = await reserve(randomUUID());
  assert.equal(selfHosted.acquired && selfHosted.value.contextVersion, 1);
  const accountId = randomUUID(), owner = randomUUID();
  await f.store.change(f.meeting.code, (m) => {
    m.recordings = [];
    m.hosted = { accountId, billingOwnerId: owner, version: 1 };
  });
  await f.store.setHostedEntitlement({
    billingOwnerId: owner,
    revision: 1,
    enabled: true,
    validUntil: Date.now() + 300_000,
    hostAccountIds: [accountId],
    limits: { participants: 100, durationSeconds: 7200, concurrentMeetings: 1 },
    quota: {
      anchorAt: Date.now() - day,
      participantSecondsPerMonth: 360_000,
      recordingSecondsPerMonth: null,
      storageBytes: 2_000_000,
    },
  });
  const hosted = await reserve(randomUUID());
  assert.equal(hosted.acquired && hosted.value.contextVersion, 2);
  const saved = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(saved.contextVersion, 2);
  const attempt = saved.storage!.attempts[0]!;
  const metadata = {
    version: 1,
    context: {
      tenantId: "installation",
      meetingId: f.meeting.id,
      recordingId: saved.id,
    },
    recordingKeyId: randomBytes(16).toString("hex"),
    wrappedKey: { provider: "fixture", keyId: "fixture", ciphertext: "wrapped" },
    plaintextBytes: 1,
    encryptedBytes: 400,
  } as EncryptedRecordingMetadata;
  await assert.rejects(
    f.store.withRecordingLock(f.meeting.code, saved.id, (lock) =>
      lock.prepareRecordingStorage(attempt.id, { kind: "local", metadata }),
    ),
    /Recording storage attempt changed/,
  );
  const accepted = await f.store.withRecordingLock(
    f.meeting.code,
    saved.id,
    (lock) => lock.prepareRecordingStorage(attempt.id, {
      kind: "local",
      metadata: {
        ...metadata,
        context: { ...metadata.context, tenantId: `hosted-owner:${owner}` },
      },
    }),
  );
  assert.equal(accepted.acquired, true);
  await f.store.change(f.meeting.code, (m) => { delete m.hosted!.billingOwnerId; });
  await assert.rejects(reserve(randomUUID()), /Recording owner is unavailable/);
});

test("hosted recording context binds links and ciphertext to the original billing owner", async (t) => {
  const f = await fixture(t);
  const accountId = randomUUID(), originalOwner = randomUUID();
  await f.store.change(f.meeting.code, (m) => {
    m.hosted = { accountId, billingOwnerId: originalOwner, version: 1 };
    m.recordings[0]!.contextVersion = 2;
  });
  await f.store.setHostedEntitlement({
    billingOwnerId: originalOwner,
    revision: 1,
    enabled: true,
    validUntil: Date.now() + 300_000,
    hostAccountIds: [accountId],
    limits: { participants: 100, durationSeconds: 7200, concurrentMeetings: 1 },
    quota: {
      anchorAt: Date.now() - day,
      participantSecondsPerMonth: 360_000,
      recordingSecondsPerMonth: null,
      storageBytes: 1_000_000,
      downloadBytesPerMonth: f.plaintext.length * 3,
    },
  });
  await writeFile(f.raw, f.plaintext, { mode: 0o600 });
  await unlink(f.encrypted);
  const key = Buffer.from(f.config.recordingKek, "base64");
  const provider = new LocalKeyProvider({ keyId: "operator-kek-v1", key });
  try {
    const metadata = await encryptRecording(
      f.raw,
      f.encrypted,
      {
        tenantId: `hosted-owner:${originalOwner}`,
        meetingId: f.meeting.id,
        recordingId: f.recording.id,
      },
      provider,
    );
    await f.store.change(f.meeting.code, (m) => { m.recordings[0]!.metadata = metadata; });
  } finally {
    provider.destroy();
    key.fill(0);
  }
  const link = await f.link();
  assert.deepEqual(await f.collect(link.token, link.password), f.plaintext);
  // A later team move does not rewrite the room's creation-time owner.
  const nextOwner = randomUUID();
  await f.store.setHostedEntitlement({
    billingOwnerId: nextOwner,
    revision: 1,
    enabled: true,
    validUntil: Date.now() + 300_000,
    hostAccountIds: [accountId],
    limits: { participants: 100, durationSeconds: 7200, concurrentMeetings: 1 },
    quota: { anchorAt: Date.now() - day, participantSecondsPerMonth: 360_000 },
  });
  assert.equal((await f.store.get(f.meeting.code))!.hosted!.billingOwnerId, originalOwner);
  assert.deepEqual(await f.collect(link.token, link.password), f.plaintext);
  await f.store.change(f.meeting.code, (m) => { m.hosted!.billingOwnerId = nextOwner; });
  await assert.rejects(f.service.currentLink(f.meeting, f.recording.id));
  await f.store.change(f.meeting.code, (m) => { delete m.hosted!.billingOwnerId; });
  await assert.rejects(f.service.currentLink(f.meeting, f.recording.id), /tenant binding/);
  await f.store.change(f.meeting.code, (m) => { m.hosted!.billingOwnerId = originalOwner; });
  await f.store.change(f.meeting.code, (m) => { (m.recordings[0] as any).contextVersion = 3; });
  await assert.rejects(f.service.currentLink(f.meeting, f.recording.id), /Unsupported recording context version/);
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
  const link = await service.link(f.meeting, f.recording.id);
  const before = structuredClone(
    (await f.store.get(f.meeting.code))!.recordings[0]!.metadata,
  );
  assert.equal(before.wrappedKey.keyId, "operator-kek-v1");
  await service.rotateKey(f.meeting, f.recording.id);
  const after = (await f.store.get(f.meeting.code))!.recordings[0]!.metadata;
  assert.equal(after.wrappedKey.keyId, "operator-kek-v2");
  assert.deepEqual(after.storage, before.storage);
  assert.equal(after.recordingKeyId, before.recordingKeyId);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.delivery?.token
      .wrappedKey.keyId,
    "operator-kek-v2",
  );
  const recovered = new RecordingService(
    { ...config, recordingLocalKeys: { "operator-kek-v2": newKey } },
    f.store,
    f.mail,
    undefined,
    { objectStorage: storage },
  );
  assert.deepEqual(
    await recovered.currentLink(f.meeting, f.recording.id),
    link,
  );
  assert.deepEqual(await collectFromService(recovered, f), f.plaintext);
});

test("rotation rewraps pending password delivery before the old key is retired", async (t) => {
  const f = await fixture(t);
  const newKey = randomBytes(32).toString("base64");
  const config = {
    ...f.config,
    recordingActiveKeyId: "operator-kek-v2",
    recordingLocalKeys: {
      ...f.config.recordingLocalKeys,
      "operator-kek-v2": newKey,
    },
  };
  f.mail.sendMail = (async () => {
    throw new Error("Synthetic SMTP outage");
  }) as typeof f.mail.sendMail;
  const service = new RecordingService(config, f.store, f.mail);
  await assert.rejects(service.link(f.meeting, f.recording.id));
  const original = await service.currentLink(f.meeting, f.recording.id);
  await service.rotateKey(f.meeting, f.recording.id);
  await f.store.change(f.meeting.code, (meeting) => {
    meeting.recordings[0]!.delivery!.nextAttemptAt = 0;
  });
  const messages: Record<string, any>[] = [];
  const deliveredMail = {
    sendMail: async (message: Record<string, any>) => {
      messages.push(message);
      return { messageId: "synthetic" };
    },
  } as unknown as Transporter;
  const recovered = new RecordingService(
    { ...config, recordingLocalKeys: { "operator-kek-v2": newKey } },
    f.store,
    deliveredMail,
  );
  await recovered.reconcileDelivery((await f.store.get(f.meeting.code))!);
  assert.equal(messages.length, 1);
  assert.deepEqual(await recovered.currentLink(f.meeting, f.recording.id), {
    ...original,
    passwordEmailSent: true,
  });
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordings[0]!.delivery?.password,
    undefined,
  );
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

test("recording recovery opens ended files without restoring room or media authority", async (t) => {
  const f = await fixture(t);
  const link = await f.link();
  await f.store.change(f.meeting.code, (m) => {
    m.ended = true;
    m.participants[0]!.status = "left";
    m.participants[0]!.expiresAt = Date.now() - 1;
  });
  const before = (await f.store.get(f.meeting.code))!;
  const app = await f.app(),
    base = `/api/meetings/${f.meeting.code}`;
  const post = (suffix: string, payload: object, cookie = "") =>
    app.inject({
      method: "POST",
      url: base + suffix,
      headers: { origin, "x-requested-with": "MeetingPlatform", cookie },
      payload,
    });
  const requested = await post("/recording-access/request", {});
  assert.equal(requested.statusCode, 202);
  const challenge = requested.cookies.find((c) =>
    c.name.startsWith("mp_recording_recovery_"),
  )!;
  const challengeCookie = `${challenge.name}=${challenge.value}`;
  assert.equal(f.emails.at(-1)!.to, before.hostEmail);
  const otp = /Verification code: (\d{6})/.exec(f.emails.at(-1)!.text)![1]!;
  // An unrelated browser cannot consume or exhaust this browser's challenge.
  assert.equal(
    (await post("/recording-access/verify", { otp })).statusCode,
    403,
  );
  const verified = await post(
    "/recording-access/verify",
    { otp },
    challengeCookie,
  );
  assert.equal(verified.statusCode, 200, verified.body);
  const c = verified.cookies.find((c) => c.name.startsWith("mp_recordings_"))!;
  const cookie = `${c.name}=${c.value}`;
  assert.equal(c.httpOnly, true);
  assert.equal(c.sameSite, "Strict");
  assert.equal(
    (await post("/recording-access/verify", { otp }, challengeCookie))
      .statusCode,
    403,
  );
  const list = await app.inject({
    url: base + "/recordings",
    headers: { cookie },
  });
  assert.equal(list.statusCode, 200);
  assert.equal(list.headers["cache-control"], "no-store");
  assert.deepEqual(Object.keys(list.json()).sort(), ["recordings", "title"]);
  assert.equal(list.json().recordings[0].id, f.recording.id);
  assert.ok(!list.body.includes(before.hostEmail!));
  assert.ok(!list.body.includes(before.participants[0]!.tokenHash));
  const current = await app.inject({
    url: `${base}/recordings/${f.recording.id}/link`,
    headers: { cookie },
  });
  assert.equal(current.statusCode, 200, current.body);
  assert.equal(
    current.json().url,
    link.url,
    "Opening files must not rotate the existing link",
  );
  const download = await post(
    "/download",
    { token: link.token, password: link.password },
    cookie,
  );
  assert.equal(download.statusCode, 200, download.body);
  assert.deepEqual(download.rawPayload, f.plaintext);
  assert.equal(
    (await post("/download", { token: link.token, password: "wrong" }, cookie))
      .statusCode,
    403,
  );
  for (const [suffix, body] of [
    ["/host-email", { email: "other@example.test" }],
    ["/recordings", {}],
    [`/recordings/${f.recording.id}/stop`, {}],
    ["/messages", { text: "not allowed" }],
    ["/media", {}],
  ] as const)
    assert.notEqual((await post(suffix, body, cookie)).statusCode, 200, suffix);
  assert.equal(
    (await app.inject({ url: base + "/state", headers: { cookie } }))
      .statusCode,
    401,
  );
  const after = (await f.store.get(f.meeting.code))!;
  assert.deepEqual(after.participants, before.participants);
  assert.deepEqual(after.lifecycle, before.lifecycle);
  assert.equal(after.ended, true);
  assert.deepEqual(f.endedRooms, []);
  // A changed verified recipient invalidates the recovered session immediately.
  await f.store.change(f.meeting.code, (m) => {
    m.hostEmail = "replacement@example.test";
  });
  assert.equal(
    (await app.inject({ url: base + "/recordings", headers: { cookie } }))
      .statusCode,
    401,
  );
});

test("recording recovery challenge is purpose-bound, rate bounded and has an atomic five-attempt limit", async (t) => {
  const f = await fixture(t),
    app = await f.app(),
    base = `/api/meetings/${f.meeting.code}`;
  const post = (suffix: string, payload: object, cookie = "") =>
    app.inject({
      method: "POST",
      url: base + suffix,
      headers: { origin, "x-requested-with": "MeetingPlatform", cookie },
      payload,
    });
  assert.equal(
    (
      await post("/recording-access/request", {
        email: "attacker@example.test",
      })
    ).statusCode,
    400,
  );
  const first = await post("/recording-access/request", {});
  const c = first.cookies.find((c) =>
    c.name.startsWith("mp_recording_recovery_"),
  )!;
  const cookie = `${c.name}=${c.value}`;
  const otp = /Verification code: (\d{6})/.exec(f.emails.at(-1)!.text)![1]!;
  const wrong = otp === "111111" ? "222222" : "111111";
  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      post("/recording-access/verify", { otp: wrong }, cookie),
    ),
  );
  assert.ok(results.every((r) => r.statusCode === 403));
  assert.equal(
    (await post("/recording-access/verify", { otp }, cookie)).statusCode,
    403,
  );
  assert.equal((await f.store.get(f.meeting.code))!.recordingAccess, undefined);
  assert.equal((await f.store.get(f.meeting.code))!.hostEmailVerified, true);
  assert.equal(f.emails.length, 1);
  // A resend within the durable room cooldown does not replace the challenge.
  const again = await post("/recording-access/request", {}, cookie);
  assert.equal(again.statusCode, 202);
  assert.equal(
    again.cookies.find((item) => item.name === c.name)?.value,
    c.value,
  );
  assert.equal(f.emails.length, 1);
});

test("original ended or left host cookie can read files while guests cannot", async (t) => {
  const f = await fixture(t),
    app = await f.app();
  await f.store.change(f.meeting.code, (m) => {
    m.ended = true;
    m.participants[0]!.status = "left";
  });
  const url = `/api/meetings/${f.meeting.code}/recordings`;
  assert.equal(
    (
      await app.inject({
        url,
        headers: { cookie: `mp_${f.meeting.code}=${f.hostSession}` },
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await app.inject({
        url,
        headers: { cookie: `mp_${f.meeting.code}=${f.guestSession}` },
      })
    ).statusCode,
    403,
  );
});

test("hosted recording tickets use current creator authority, survive ordinary end, and replace only recording access", async (t) => {
  const f = await fixture(t);
  f.config.edition = "hosted";
  const accountId = randomUUID(),
    billingOwnerId = randomUUID();
  await f.store.change(f.meeting.code, (m) => {
    m.hosted = { accountId, billingOwnerId, version: 1 };
    m.ended = true;
    m.lifecycle = { startedAt: Date.now() - day, cleanupConfirmed: true };
    m.participants[0]!.status = "left";
    m.participants[0]!.expiresAt = Date.now() - 1;
  });
  await f.store.setHostedAuthority({
    accountId,
    billingOwnerId,
    version: 1,
    enabled: true,
  });
  const before = (await f.store.get(f.meeting.code))!;
  const app = await f.app(),
    base = `/api/meetings/${f.meeting.code}`;
  const internal = (payload: object) =>
    app.inject({
      method: "POST",
      url: `/api/internal/hosted/meetings/${f.meeting.code}/recording-access`,
      headers: {
        "x-requested-with": "MeetingPlatformHosted",
        authorization: `Bearer ${creationKey}`,
      },
      payload,
    });
  const post = (suffix: string, payload: object, cookie = "") =>
    app.inject({
      method: "POST",
      url: base + suffix,
      headers: { origin, "x-requested-with": "MeetingPlatform", cookie },
      payload,
    });
  assert.equal(
    (await internal({ accountId: randomUUID(), version: 1 })).statusCode,
    403,
  );
  assert.equal((await internal({ accountId, version: 2 })).statusCode, 403);
  assert.equal(
    (await internal({ accountId, version: 1, billingOwnerId })).statusCode,
    400,
  );
  await f.store.change(f.meeting.code, (m) => {
    m.recordings = [];
  });
  assert.equal(
    (await internal({ accountId: randomUUID(), version: 1 })).statusCode,
    403,
  );
  const empty = await internal({ accountId, version: 1 });
  assert.equal(empty.statusCode, 200, empty.body);
  assert.deepEqual(empty.json(), {
    code: f.meeting.code,
    recordingsAvailable: false,
  });
  assert.equal((await f.store.get(f.meeting.code))!.recordingAccess, undefined);
  await f.store.change(f.meeting.code, (m) => {
    m.recordings = before.recordings;
  });
  const expired = await internal({ accountId, version: 1 });
  await f.store.change(f.meeting.code, (m) => {
    m.recordingAccess!.ticket!.expiresAt = Date.now() - 1;
  });
  assert.equal(
    (
      await post("/recording-access/exchange", {
        ticket: expired.json().ticket,
      })
    ).statusCode,
    403,
  );
  const issued = await internal({ accountId, version: 1 });
  assert.equal(issued.statusCode, 200, issued.body);
  const otherCode = "ANOTHERRECORDINGMEETINGCODE";
  await f.store.create({
    ...structuredClone(before),
    id: randomUUID(),
    code: otherCode,
  });
  const wrongRoom = await app.inject({
    method: "POST",
    url: `/api/meetings/${otherCode}/recording-access/exchange`,
    headers: { origin, "x-requested-with": "MeetingPlatform" },
    payload: { ticket: issued.json().ticket },
  });
  assert.equal(wrongRoom.statusCode, 403);
  const first = await post("/recording-access/exchange", {
    ticket: issued.json().ticket,
  });
  assert.equal(first.statusCode, 200, first.body);
  const cookieOf = (r: typeof first) => {
    const c = r.cookies.find((c) => c.name.startsWith("mp_recordings_"))!;
    return `${c.name}=${c.value}`;
  };
  const cookie = cookieOf(first);
  assert.equal(
    (await post("/recording-access/exchange", { ticket: issued.json().ticket }))
      .statusCode,
    403,
  );
  assert.equal(
    (await app.inject({ url: base + "/recordings", headers: { cookie } }))
      .statusCode,
    200,
  );
  const renewed = await internal({ accountId, version: 1 });
  const second = await post("/recording-access/exchange", {
    ticket: renewed.json().ticket,
  });
  assert.equal(second.statusCode, 200);
  assert.equal(
    (await app.inject({ url: base + "/recordings", headers: { cookie } }))
      .statusCode,
    401,
  );
  const cookie2 = cookieOf(second);
  assert.equal(
    (await app.inject({ url: base + "/state", headers: { cookie: cookie2 } }))
      .statusCode,
    401,
  );
  const requested = await post("/recording-access/request", {});
  assert.equal(requested.statusCode, 202);
  assert.equal(
    f.emails.length,
    0,
    "Hosted accounts cannot fall back to email OTP recovery",
  );
  const after = (await f.store.get(f.meeting.code))!;
  assert.deepEqual(after.participants, before.participants);
  assert.deepEqual(after.lifecycle, before.lifecycle);
  assert.equal(after.hostTokenHash, before.hostTokenHash);
  // No hosting grant was installed; artifact tickets must not require or reserve one.
  await assert.rejects(
    f.store.hostedUsage(billingOwnerId),
    (error: unknown) => error instanceof HttpError && error.status === 404,
  );
  const stale = await internal({ accountId, version: 1 });
  await f.store.setHostedAuthority({
    accountId,
    billingOwnerId,
    version: 2,
    enabled: false,
  });
  assert.equal(
    (await post("/recording-access/exchange", { ticket: stale.json().ticket }))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await app.inject({
        url: base + "/recordings",
        headers: { cookie: cookie2 },
      })
    ).statusCode,
    401,
  );
});

test("recording-only credentials cannot act in an active room", async (t) => {
  const f = await fixture(t),
    token = randomBytes(32).toString("base64url");
  await f.store.change(f.meeting.code, (m) => {
    m.recordingAccess = {
      identity: { email: m.hostEmail! },
      session: { hash: digest(token), expiresAt: Date.now() + day },
    };
  });
  const app = await f.app(),
    base = `/api/meetings/${f.meeting.code}`;
  const cookie = `mp_recordings_${f.meeting.code}=${token}`,
    host = `mp_${f.meeting.code}=${f.hostSession}`;
  for (const suffix of ["/state", "/whiteboard"]) {
    assert.equal(
      (await app.inject({ url: base + suffix, headers: { cookie } }))
        .statusCode,
      401,
      suffix,
    );
    assert.equal(
      (await app.inject({ url: base + suffix, headers: { cookie: host } }))
        .statusCode,
      200,
      suffix,
    );
  }
  for (const [suffix, payload] of [
    ["/media", {}],
    ["/host-email", { email: "other@example.test" }],
    ["/recordings", {}],
    [`/recordings/${f.recording.id}/stop`, {}],
    ["/messages", { text: "forbidden" }],
    ["/end", {}],
  ] as const) {
    const result = await app.inject({
      method: "POST",
      url: base + suffix,
      headers: { origin, "x-requested-with": "MeetingPlatform", cookie },
      payload,
    });
    assert.equal(result.statusCode, 401, `${suffix}: ${result.body}`);
  }
  const policy = (credential: string) =>
    app.inject({
      method: "PATCH",
      url: base,
      headers: {
        origin,
        "x-requested-with": "MeetingPlatform",
        cookie: credential,
      },
      payload: { locked: true },
    });
  assert.equal((await policy(cookie)).statusCode, 401);
  assert.equal((await policy(host)).statusCode, 200);
  assert.equal(
    (
      await app.inject({
        method: "POST",
        url: base + "/media",
        headers: {
          origin,
          "x-requested-with": "MeetingPlatform",
          cookie: host,
        },
        payload: {},
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await app.inject({ url: base + "/recordings", headers: { cookie } }))
      .statusCode,
    200,
  );
  assert.equal((await f.store.get(f.meeting.code))!.ended, false);
  await f.store.change(f.meeting.code, (m) => {
    m.recordingAccess!.session!.expiresAt = Date.now() - 1;
  });
  assert.equal(
    (await app.inject({ url: base + "/recordings", headers: { cookie } }))
      .statusCode,
    401,
  );
});

test("recording recovery expiration and failed email leave no usable capability", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const f = await fixture(t),
    app = await f.app(),
    base = `/api/meetings/${f.meeting.code}`;
  const request = (code = f.meeting.code) =>
    app.inject({
      method: "POST",
      url: `/api/meetings/${code}/recording-access/request`,
      headers: { origin, "x-requested-with": "MeetingPlatform" },
      payload: {},
    });
  const unknown = await request("UNKNOWNRECORDINGMEETINGCODE");
  const known = await request();
  assert.equal(unknown.statusCode, 202);
  assert.equal(unknown.body, known.body);
  const c = known.cookies.find((c) =>
    c.name.startsWith("mp_recording_recovery_"),
  )!;
  const otp = /Verification code: (\d{6})/.exec(f.emails.at(-1)!.text)![1]!;
  const challenge = (await f.store.get(f.meeting.code))!.recordingRecovery!;
  t.mock.timers.setTime(challenge.expiresAt + 1);
  const invalid = await app.inject({
    method: "POST",
    url: base + "/recording-access/verify",
    headers: {
      origin,
      "x-requested-with": "MeetingPlatform",
      cookie: `${c.name}=${c.value}`,
    },
    payload: { otp },
  });
  assert.equal(invalid.statusCode, 403);
  assert.deepEqual(
    (await f.store.get(f.meeting.code))!.recordingRecovery,
    challenge,
    "Expiry must reject the unchanged challenge, not a mismatched HMAC",
  );
  await f.store.change(f.meeting.code, (m) => {
    m.recordingRecoveryRequestedAt = 0;
  });
  f.mail.sendMail = (async () => {
    throw new Error("synthetic SMTP failure");
  }) as typeof f.mail.sendMail;
  const failed = await request();
  assert.equal(failed.statusCode, 202);
  const state = (await f.store.get(f.meeting.code))!;
  assert.equal(state.recordingRecovery, undefined);
  assert.equal(
    state.recordingRecoveryRequestedAt,
    undefined,
    "Failed delivery permits a rate-limited retry",
  );
  assert.equal(state.recordingAccess, undefined);
  assert.equal(state.hostEmailVerified, true);
});

test("recording recovery has a fixed 24-hour lifetime even when links are renewed late", async (t) => {
  const f = await fixture(t),
    issuedAt = Date.now(),
    token = randomBytes(32).toString("base64url");
  await f.store.change(f.meeting.code, (m) => {
    m.recordingAccess = {
      identity: { email: m.hostEmail! },
      session: { hash: digest(token), expiresAt: issuedAt + day },
    };
  });
  let now = issuedAt + 23 * 3600000;
  t.mock.method(Date, "now", () => now);
  const app = await f.app(),
    base = `/api/meetings/${f.meeting.code}`;
  const cookie = `mp_recordings_${f.meeting.code}=${token}`;
  const renewed = await app.inject({
    method: "POST",
    url: `${base}/recordings/${f.recording.id}/link`,
    headers: { origin, "x-requested-with": "MeetingPlatform", cookie },
    payload: {},
  });
  assert.equal(renewed.statusCode, 200, renewed.body);
  assert.equal(renewed.json().expiresAt, now + day);
  assert.equal(
    renewed.cookies.length,
    0,
    "Link renewal must not renew the recording cookie",
  );
  const read = await app.inject({
    url: `${base}/recordings/${f.recording.id}/link`,
    headers: { cookie },
  });
  assert.equal(read.statusCode, 200);
  assert.equal(read.cookies.length, 0);
  assert.equal(
    (await f.store.get(f.meeting.code))!.recordingAccess!.session!.expiresAt,
    issuedAt + day,
  );
  now = issuedAt + day + 1;
  assert.equal(
    (await app.inject({ url: base + "/recordings", headers: { cookie } }))
      .statusCode,
    401,
  );
  assert.ok(
    await f.service.findToken(
      new URL(renewed.json().url).hash.slice(1),
      f.meeting.code,
    ),
    "The separately valid link still exists for the next recovered session",
  );
});

test("account erasure physically removes owned recordings and closes their storage holds", async (t) => {
  const f = await fixture(t);
  await downloadAllowance(f);
  const owner = (await f.store.get(f.meeting.code))!.hosted!.billingOwnerId!;
  const attemptId = randomUUID();
  const ownedFile = path.join(f.config.recordingDir, "encrypted", `${f.recording.id}.${attemptId}.mprec`);
  await unlink(f.encrypted);
  await writeFile(f.raw, f.plaintext, { mode: 0o600 });
  await f.store.change(f.meeting.code, (m) => {
    const r = m.recordings[0]!;
    delete r.metadata;
    r.storage = { billingOwnerId: owner, maxBytes: 1_000_000, attempts: [{ id: attemptId, kind: "local", maxBytes: 1_000_000, state: "reserved" }] };
  });
  const provider = new LocalKeyProvider({ keyId: "operator-kek-v1", key: Buffer.from(f.config.recordingKek, "base64") });
  t.after(() => provider.destroy());
  await f.store.withRecordingLock(f.meeting.code, f.recording.id, async (lock) => {
    const context = { tenantId: "installation", meetingId: f.meeting.id, recordingId: f.recording.id };
    const metadata = await encryptRecording(f.raw, ownedFile, context, provider, {
      maxEncryptedBytes: 1_000_000,
      onPrepared: async (prepared) => { await lock.prepareRecordingStorage(attemptId, { kind: "local", metadata: prepared }); },
    });
    const receipt = await readEncryptionReceipt(ownedFile, metadata, context);
    assert.ok(receipt?.published);
    await lock.retainRecordingStorage(attemptId, { kind: "local", metadata, receipt });
    await lock.change((m) => {
      m.recordings[0]!.metadata = metadata;
      m.recordings[0]!.ciphertextId = attemptId;
      m.ended = true;
      m.hosted!.revoked = true;
      m.hosted!.erasureRequested = true;
    });
  });
  await access(ownedFile);
  await access(f.raw);
  await f.service.reconcile((await f.store.get(f.meeting.code))!, "files", 4);
  const r = (await f.store.get(f.meeting.code))!.recordings[0]!;
  assert.equal(r.status, "deleted");
  assert.equal(r.metadata, undefined);
  assert.equal(r.storage!.attempts[0]!.state, "released");
  assert.equal(r.storage!.attempts[0]!.release!.kind, "local");
  await assert.rejects(access(ownedFile), { code: "ENOENT" });
  await assert.rejects(access(f.raw), { code: "ENOENT" });
  // The closed-writer marker remains as a fence against reopening the attempt.
  await access(`${ownedFile}.closed`);
});

test("account erasure refuses legacy recordings without an owned attempt inventory", async (t) => {
  const f = await fixture(t);
  const accountId = randomUUID();
  await f.store.change(f.meeting.code, (m) => {
    m.hosted = { accountId, version: 1 };
  });
  await f.store.setHostedAuthority({ accountId, version: 2, enabled: false });
  await f.store.requestHostedErasure(accountId, 2);
  await f.store.change(f.meeting.code, (m) => {
    m.cleanupPending = false;
    m.hosted!.cleanupConfirmed = true;
    for (const p of m.participants) delete p.enforcementPending;
  });
  await f.service.reconcile((await f.store.get(f.meeting.code))!, "files", 4);
  assert.equal((await f.store.get(f.meeting.code))!.recordings[0]!.status, "ready");
  await access(f.encrypted);
  assert.equal(await f.store.finishHostedErasure(accountId, 2), false);
  // Even a legacy row whose referenced file was deleted is not orphan-copy proof.
  await f.store.change(f.meeting.code, (m) => { m.recordings[0]!.status = "deleted"; delete m.recordings[0]!.metadata; });
  assert.equal(await f.store.finishHostedErasure(accountId, 2), false);
});
