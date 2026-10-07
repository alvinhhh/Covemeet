import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { MemoryStore, type Meeting, type Participant } from "../src/store.js";
import type { Media } from "../src/media.js";
import { RecordingService } from "../src/recordings.js";
import argon2 from "argon2";
import {
  controllerPresent,
  meetingAllowed,
  meetingController,
  occupiesRoomSeat,
  reconcileHostAbsence,
} from "../src/meeting-limits.js";

const origin = "http://localhost:5173";
const creationKey = "test-creation-key-that-is-longer-than-32-characters";
const password = "a-test-meeting-passphrase-2026";

class TestMedia implements Media {
  available = true;
  issued: { meeting: Meeting; participant: Participant }[] = [];
  removed: string[] = [];
  ended: string[] = [];
  async token(meeting: Meeting, participant: Participant) {
    this.issued.push(structuredClone({ meeting, participant }));
    return `test-media-${participant.id}-${participant.mediaVersion}`;
  }
  async remove(_meeting: Meeting, participant: Participant) {
    this.removed.push(participant.id);
  }
  async end(meeting: Meeting) {
    this.ended.push(meeting.code);
  }
  close() {}
}

class Client {
  cookie = "";
  constructor(
    readonly app: FastifyInstance,
    readonly ip: string,
  ) {}
  async request(
    method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT",
    url: string,
    payload?: object,
    extraHeaders: Record<string, string> = {},
  ) {
    const response = await this.app.inject({
      method,
      url,
      payload,
      remoteAddress: this.ip,
      headers: {
        origin,
        "x-requested-with": "MeetingPlatform",
        cookie: this.cookie,
        ...extraHeaders,
      },
    });
    const values = response.headers["set-cookie"];
    const jar = new Map(
      this.cookie
        .split("; ")
        .filter(Boolean)
        .map((part) => {
          const split = part.indexOf("=");
          return [part.slice(0, split), part.slice(split + 1)];
        }),
    );
    for (const value of Array.isArray(values)
      ? values
      : values
        ? [String(values)]
        : []) {
      const pair = value.split(";")[0]!;
      const split = pair.indexOf("=");
      jar.set(pair.slice(0, split), pair.slice(split + 1));
    }
    this.cookie = [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
    return response;
  }
}

const ok = (response: { statusCode: number; body: string }) =>
  assert.ok(
    response.statusCode >= 200 && response.statusCode < 300,
    response.body,
  );
const rejected = (response: { statusCode: number; body: string }) =>
  assert.ok(
    response.statusCode >= 400 && response.statusCode < 500,
    `Expected client rejection: ${response.statusCode} ${response.body}`,
  );

async function fixture(
  t: TestContext,
  edition = "hosted",
  portalOrigin?: string,
) {
  const config = loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "test-session-secret-with-at-least-32-characters",
    CREATION_KEY: creationKey,
    EDITION: edition,
    SITE_ORIGIN: origin,
    LIVEKIT_API_KEY: "test-key",
    LIVEKIT_API_SECRET: "test-livekit-secret-longer-than-32-characters",
    RECORDING_ENABLED: "false",
    ...(portalOrigin ? { PORTAL_ORIGIN: portalOrigin } : {}),
  });
  const store = new MemoryStore();
  const media = new TestMedia();
  const app = await createApp(config, store, media);
  await app.ready();
  t.after(() => app.close());
  const host = new Client(app, "198.51.100.10");
  async function create(overrides: Record<string, unknown> = {}) {
    return host.request("POST", "/api/meetings", {
      title: "Security review",
      hostName: "Host",
      password,
      mode: "meeting",
      creationKey,
      ...overrides,
    });
  }
  async function meeting(overrides: Record<string, unknown> = {}) {
    const response = await create(overrides);
    ok(response);
    const { code, hostToken } = response.json();
    const exchanged = await host.request("POST", `/api/meetings/${code}/host`, {
      token: hostToken,
    });
    ok(exchanged);
    return {
      code: code as string,
      hostToken: hostToken as string,
      hostId: exchanged.json().participantId as string,
    };
  }
  async function join(
    code: string,
    ip = "198.51.100.20",
    client = new Client(app, ip),
  ) {
    const response = await client.request(
      "POST",
      `/api/meetings/${code}/join`,
      { name: "Guest", password },
    );
    ok(response);
    return { client, id: response.json().participantId as string };
  }
  async function action(code: string, id: string, name: string, options = {}) {
    const response = await host.request(
      "POST",
      `/api/meetings/${code}/participants/${id}/action`,
      { action: name, ...options },
    );
    ok(response);
    return response;
  }
  return { app, store, media, host, create, meeting, join, action };
}

test("hands require admission, accept explicit state, and preserve webinar media restrictions", async (t) => {
  const f = await fixture(t);
  const room = await f.meeting({ mode: "webinar" });
  const viewer = await f.join(room.code);
  const path = `/api/meetings/${room.code}`;
  const hand = `${path}/participants/${viewer.id}/hand`;
  for (const raised of [true, false])
    assert.equal(
      (await viewer.client.request("PUT", hand, { raised })).statusCode,
      403,
    );
  await f.action(room.code, viewer.id, "admit");
  const before = (await f.store.get(room.code))!.participants.find(
    (p) => p.id === viewer.id,
  )!;
  const initial = (await viewer.client.request("GET", `${path}/state`)).json();
  assert.equal(initial.me.handRaised, false);
  assert.equal(initial.me.mediaAllowed, false);
  assert.equal(initial.me.audioAllowed, false);
  assert.equal(initial.me.videoAllowed, false);
  for (const body of [{}, { raised: "true" }, { raised: true, role: "host" }])
    assert.equal(
      (await viewer.client.request("PUT", hand, body)).statusCode,
      400,
    );
  assert.equal(
    (
      await viewer.client.request(
        "PUT",
        hand,
        { raised: true },
        { origin: "https://foreign.example" },
      )
    ).statusCode,
    403,
  );
  for (const raised of [true, true, false, false]) {
    const response = await viewer.client.request("PUT", hand, { raised });
    ok(response);
    assert.deepEqual(response.json(), {
      ok: true,
      handRaised: raised,
      revision: (await f.store.get(room.code))!.revision,
    });
    const state = (await viewer.client.request("GET", `${path}/state`)).json();
    assert.equal(state.me.handRaised, raised);
    const hostState = (await f.host.request("GET", `${path}/state`)).json();
    assert.equal(
      hostState.participants.find((p: any) => p.id === viewer.id).handRaised,
      raised,
    );
  }
  const { handRaised, ...after } = (await f.store.get(
    room.code,
  ))!.participants.find((p) => p.id === viewer.id)!;
  assert.equal(handRaised, false);
  assert.deepEqual(after, before);
  assert.deepEqual(f.media.removed, []);
  assert.deepEqual(f.media.issued, []);
});

test("hand moderation uses current authority and rejects inactive or stale actors", async (t) => {
  const f = await fixture(t);
  const room = await f.meeting();
  const path = `/api/meetings/${room.code}`;
  const cohost = await f.join(room.code);
  const peer = await f.join(room.code, "198.51.100.21");
  const guest = await f.join(room.code, "198.51.100.22");
  const hand = (client: Client, id: string, raised: boolean) =>
    client.request("PUT", `${path}/participants/${id}/hand`, { raised });
  for (const p of [cohost, peer, guest]) {
    await f.action(room.code, p.id, "admit");
    ok(await hand(p.client, p.id, true));
  }
  for (const p of [cohost, peer])
    ok(
      await f.host.request("PUT", `${path}/participants/${p.id}/moderator`, {
        enabled: true,
      }),
    );
  ok(await hand(f.host, room.hostId, true));
  for (const raised of [true, false]) {
    assert.equal((await hand(guest.client, cohost.id, raised)).statusCode, 403);
    assert.equal((await hand(cohost.client, peer.id, raised)).statusCode, 403);
    assert.equal(
      (await hand(cohost.client, room.hostId, raised)).statusCode,
      403,
    );
  }
  assert.equal((await hand(f.host, guest.id, true)).statusCode, 403);
  ok(await hand(f.host, room.hostId, false));
  ok(await hand(f.host, peer.id, false));
  ok(await hand(cohost.client, guest.id, false));
  ok(
    await f.host.request("PUT", `${path}/participants/${cohost.id}/moderator`, {
      enabled: false,
    }),
  );
  ok(await hand(guest.client, guest.id, true));
  assert.equal((await hand(cohost.client, guest.id, false)).statusCode, 403);
  const original = (await f.store.get(room.code))!.participants.find(
    (p) => p.id === guest.id,
  )!;
  const inactive: Partial<Participant>[] = [
    { status: "waiting" },
    { status: "kicked" },
    { status: "banned" },
    { status: "left" },
    { enforcementPending: true },
    { expiresAt: Date.now() - 1 },
    { tokenHash: "replaced-session" },
  ];
  for (const patch of inactive) {
    await f.store.change(room.code, (m) =>
      Object.assign(
        m.participants.find((p) => p.id === guest.id)!,
        original,
        { enforcementPending: false },
        patch,
      ),
    );
    for (const raised of [true, false])
      rejected(await hand(guest.client, guest.id, raised));
    assert.equal(
      (await f.store.get(room.code))!.participants.find(
        (p) => p.id === guest.id,
      )!.handRaised,
      true,
    );
  }
  await f.store.change(room.code, (m) => {
    Object.assign(m.participants.find((p) => p.id === guest.id)!, original, {
      enforcementPending: false,
    });
    m.participants.find((p) => p.id === room.hostId)!.enforcementPending = true;
  });
  assert.equal((await hand(f.host, guest.id, false)).statusCode, 403);
  await f.store.change(room.code, (m) => {
    m.participants.find((p) => p.id === room.hostId)!.enforcementPending =
      false;
  });
  ok(await f.host.request("POST", `${path}/end`, {}));
  for (const client of [f.host, guest.client])
    assert.equal((await hand(client, guest.id, false)).statusCode, 410);
});

test("raised hands follow breakout and webinar roster visibility for guests and co-hosts", async (t) => {
  const f = await fixture(t, "self-hosted");
  const room = await f.meeting({ mode: "webinar" });
  const path = `/api/meetings/${room.code}`;
  const presenter = await f.join(room.code);
  const viewer = await f.join(room.code, "198.51.100.21");
  const cohost = await f.join(room.code, "198.51.100.22");
  for (const p of [presenter, viewer, cohost])
    await f.action(room.code, p.id, "admit");
  await f.action(room.code, presenter.id, "promote");
  ok(
    await f.host.request("PUT", `${path}/participants/${cohost.id}/moderator`, {
      enabled: true,
    }),
  );
  const hand = (client: Client, id: string, raised: boolean) =>
    client.request("PUT", `${path}/participants/${id}/hand`, { raised });
  ok(await hand(presenter.client, presenter.id, true));
  ok(await hand(viewer.client, viewer.id, true));
  for (const client of [viewer.client, cohost.client]) {
    const state = (await client.request("GET", `${path}/state`)).json();
    assert.ok(!state.participants.some((p: any) => p.id === presenter.id));
    assert.equal(
      state.participants.find((p: any) => p.id === viewer.id).handRaised,
      true,
    );
  }
  assert.equal(
    (await hand(cohost.client, presenter.id, false)).statusCode,
    404,
  );
  ok(await hand(f.host, presenter.id, false));
  ok(await hand(presenter.client, presenter.id, true));
  ok(await f.host.request("POST", `${path}/breakouts`, { name: "Discussion" }));
  const breakoutId = (await f.store.get(room.code))!.breakouts[0]!.id;
  ok(
    await f.host.request("POST", `${path}/move`, {
      participantId: presenter.id,
      breakoutId,
    }),
  );
  const audience = (await viewer.client.request("GET", `${path}/state`)).json();
  assert.ok(!audience.participants.some((p: any) => p.id === presenter.id));
  const moderator = (
    await cohost.client.request("GET", `${path}/state`)
  ).json();
  assert.equal(
    moderator.participants.find((p: any) => p.id === presenter.id).handRaised,
    true,
  );
  ok(await hand(cohost.client, presenter.id, false));
  const ownRoom = (
    await presenter.client.request("GET", `${path}/state`)
  ).json();
  assert.equal(ownRoom.me.handRaised, false);
  assert.ok(!ownRoom.participants.some((p: any) => p.id === viewer.id));
});

test("terminal browser history prunes only expired unaudited guests after cleanup", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture(t);
  const m = await f.meeting();
  const client = new Client(f.app, "198.51.100.20");
  const departed: string[] = [];
  for (let i = 0; i < 4; i++) {
    const guest = await f.join(m.code, client.ip, client);
    departed.push(guest.id);
    ok(await client.request("POST", `/api/meetings/${m.code}/leave`, {}));
  }
  const state = await client.request("GET", `/api/meetings/${m.code}/state`);
  ok(state);
  assert.equal(state.json().me.status, "left");
  const held: Partial<Participant>[] = [
    { auditReferenced: undefined },
    { auditReferenced: true },
    { role: "host" },
    { transport: "phone" },
    {
      phone: {
        callId: "retained-call",
        trunkId: "fixture",
        muted: true,
        handRaised: false,
        leaseExpiresAt: 0,
        callExpiresAt: 0,
        closed: true,
      },
    },
    { status: "waiting" },
    { status: "admitted" },
    { status: "kicked" },
    { status: "banned" },
    { enforcementPending: true },
    { previousMediaIdentity: "retired-identity" },
    { previousRoom: "retired-room" },
    { gatewayConnectionId: "held-connection" },
    { gatewayPresenceUntil: 0 },
    {
      meter: {
        connectionId: "held-meter",
        mediaVersion: 2,
        phase: "closing",
        accountedAt: 0,
        fundedUntil: 0,
        presenceUntil: 0,
      },
    },
  ];
  await f.store.change(m.code, (current) => {
    const sample = current.participants.find((p) => p.id === departed[0])!;
    for (const p of current.participants)
      if (departed.slice(0, -1).includes(p.id)) p.expiresAt = Date.now() - 1;
    for (const [index, patch] of held.entries())
      current.participants.push({
        ...structuredClone(sample),
        id: `retained-${index}`,
        tokenHash: `retained-${index}`,
        ...patch,
      });
  });
  // Unresolved test rows must keep their cleanup proof, not be silently settled.
  t.mock.method(f.media, "remove", async () => {
    throw new Error("Media unavailable");
  });
  t.mock.timers.tick(5000);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    (await f.store.get(m.code))!.participants.map((p) => p.id).sort(),
    [m.hostId, departed.at(-1)!, ...held.map((_, i) => `retained-${i}`)].sort(),
    "Expired cleaned unaudited browser history was retained or protected rows were lost",
  );
  const terminal = await client.request("GET", `/api/meetings/${m.code}/state`);
  ok(terminal);
  assert.equal(terminal.json().me.status, "left");
});

test("terminal browser history retains identity while its moderation audit is pending", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code);
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const pending = new Promise<void>((resolve) => (entered = resolve));
  const audit = f.store.audit.bind(f.store);
  t.mock.method(f.store, "audit", async (code, actor, action, target) => {
    if (target === guest.id) {
      entered();
      await gate;
    }
    await audit(code, actor, action, target);
  });
  const admission = f.action(m.code, guest.id, "admit");
  try {
    await pending;
    assert.equal(
      f.store.auditEvents.some((event) => event.target === guest.id),
      false,
    );
    ok(await guest.client.request("POST", `/api/meetings/${m.code}/leave`, {}));
    await f.store.change(m.code, (current) => {
      current.participants.find((p) => p.id === guest.id)!.expiresAt =
        Date.now() - 1;
    });
    t.mock.timers.tick(5000);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const retained = (await f.store.get(m.code))!.participants.find(
      (p) => p.id === guest.id,
    );
    assert.equal(retained?.auditReferenced, true);
    assert.equal(retained?.name, "Guest");
  } finally {
    release();
    await admission;
  }
  assert(f.store.auditEvents.some((event) => event.target === guest.id));
});

test("hosted creation requires its server credential and rejects custom meeting codes", async (t) => {
  const f = await fixture(t);
  rejected(await f.create({ creationKey: undefined }));
  rejected(await f.create({ creationKey: "wrong" }));
  rejected(await f.create({ customCode: "MYCUSTOMMEETING" }));
  const response = await f.create();
  ok(response);
  assert.match(response.json().code, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.ok(response.json().hostToken.length >= 32);
  assert.ok(!response.json().guestUrl.includes(response.json().hostToken));
});

test("meeting passwords accept one character but reject empty and oversized values", async (t) => {
  const f = await fixture(t);
  rejected(await f.create({ password: "" }));
  rejected(await f.create({ password: "x".repeat(257) }));
  const { code } = await f.meeting({ password: "x" });
  const guest = new Client(f.app, "198.51.100.20");
  ok(
    await guest.request("POST", `/api/meetings/${code}/join`, {
      name: "Guest",
      password: "x",
    }),
  );
});

test("self-hosted installations can select a custom meeting code", async (t) => {
  const f = await fixture(t, "self-hosted");
  rejected(await f.create({ customCode: "------" }));
  const response = await f.create({ customCode: "TEAMDEMO2026" });
  ok(response);
  assert.equal(response.json().code, "TEAMDEMO2026");
});

test("host capabilities are one-use and guest state omits server secrets", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const attacker = new Client(f.app, "198.51.100.30");
  rejected(
    await attacker.request("POST", `/api/meetings/${m.code}/host`, {
      token: m.hostToken,
    }),
  );
  rejected(
    await attacker.request("POST", `/api/meetings/${m.code}/host`, {
      token: "invented-capability",
    }),
  );
  const guest = await f.join(m.code);
  const state = await guest.client.request(
    "GET",
    `/api/meetings/${m.code}/state`,
  );
  ok(state);
  assert.doesNotMatch(
    state.body,
    /passwordHash|hostTokenHash|tokenHash|ipHash|deviceHash|emailOtpHash|livekitSecret/,
  );
  assert.equal(state.json().me.role, "participant");
});

test("lobby admission is enforced before media and guests cannot moderate or unlock", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code);
  rejected(
    await guest.client.request("POST", `/api/meetings/${m.code}/media`, {}),
  );
  assert.equal(f.media.issued.length, 0);
  rejected(
    await guest.client.request(
      "POST",
      `/api/meetings/${m.code}/participants/${guest.id}/action`,
      { action: "admit" },
    ),
  );
  rejected(
    await guest.client.request("PATCH", `/api/meetings/${m.code}`, {
      locked: false,
      recordingAllowed: true,
    }),
  );
  await f.action(m.code, guest.id, "admit");
  ok(await guest.client.request("POST", `/api/meetings/${m.code}/media`, {}));
  assert.equal(f.media.issued.at(-1)?.participant.id, guest.id);
  assert.equal(f.media.issued.at(-1)?.participant.status, "admitted");
});

test("repeated browser joins preserve the existing participant and cookie even when the room is full", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code);
  const cookie = guest.client.cookie;
  const retry = () =>
    guest.client.request("POST", `/api/meetings/${m.code}/join`, {
      name: "Replacement name",
      password,
    });
  for (const status of ["waiting", "admitted"]) {
    if (status === "admitted") {
      await f.action(m.code, guest.id, "admit");
      await f.action(m.code, guest.id, "block-audio");
      await f.action(m.code, guest.id, "block-video");
      await f.store.change(m.code, (meeting) => {
        meeting.limits = { participants: 2, durationSeconds: 3600 };
      });
    }
    const before = (await f.store.get(m.code))!;
    assert.equal(
      before.participants.find((p) => p.id === guest.id)!.status,
      status,
    );
    const responses = await Promise.all([retry(), retry(), retry()]);
    for (const response of responses) {
      ok(response);
      assert.equal(
        response.json().participantId,
        guest.id,
        "Retry allocated another participant",
      );
    }
    assert.equal(
      guest.client.cookie,
      cookie,
      "Retry replaced the browser session",
    );
    assert.deepEqual(
      (await f.store.get(m.code))!.participants,
      before.participants,
      "Retry changed participant identity, authority, expiry, or occupied seats",
    );
  }
  const before = (await f.store.get(m.code))!;
  const hostCookie = f.host.cookie;
  const hostRetry = await f.host.request(
    "POST",
    `/api/meetings/${m.code}/join`,
    {
      name: "Guest name",
      password,
    },
  );
  ok(hostRetry);
  assert.equal(hostRetry.json().participantId, m.hostId);
  assert.equal(f.host.cookie, hostCookie);
  assert.deepEqual(
    (await f.store.get(m.code))!.participants,
    before.participants,
  );
});

test("kick invalidates the old session but permits a fresh lobby admission", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code);
  await f.action(m.code, guest.id, "admit");
  await f.action(m.code, guest.id, "kick");
  assert.ok(f.media.removed.includes(guest.id));
  rejected(
    await guest.client.request("POST", `/api/meetings/${m.code}/media`, {}),
  );
  const joinedAgain = await f.join(m.code, guest.client.ip, guest.client);
  assert.notEqual(joinedAgain.id, guest.id);
  const state = await joinedAgain.client.request(
    "GET",
    `/api/meetings/${m.code}/state`,
  );
  ok(state);
  assert.equal(state.json().me.status, "waiting");
});

test("device meeting ban follows its signed device marker to another IP", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code);
  await f.action(m.code, guest.id, "admit");
  await f.action(m.code, guest.id, "ban", { banDevice: true, banIp: false });
  const sameDevice = new Client(f.app, "198.51.100.99");
  sameDevice.cookie = guest.client.cookie;
  rejected(
    await sameDevice.request("POST", `/api/meetings/${m.code}/join`, {
      name: "Returned",
      password,
    }),
  );
  rejected(
    await guest.client.request("POST", `/api/meetings/${m.code}/media`, {}),
  );
  const unrelated = await f.join(m.code, "198.51.100.98");
  assert.notEqual(unrelated.id, guest.id);
});

test("IP meeting ban rejects a new device and ignores spoofed forwarding headers", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code);
  await f.action(m.code, guest.id, "admit");
  await f.action(m.code, guest.id, "ban", { banDevice: false, banIp: true });
  const freshDevice = new Client(f.app, guest.client.ip);
  rejected(
    await freshDevice.request(
      "POST",
      `/api/meetings/${m.code}/join`,
      { name: "Returned", password },
      { "x-forwarded-for": "203.0.113.99" },
    ),
  );
  const otherMeeting = await f.meeting();
  const joined = await f.join(otherMeeting.code, guest.client.ip);
  assert.ok(
    joined.id,
    "An occurrence-scoped ban must not silently become an installation-wide ban",
  );
});

test("locking rejects new guests while admitted participants retain access", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code);
  await f.action(m.code, guest.id, "admit");
  ok(
    await f.host.request("PATCH", `/api/meetings/${m.code}`, { locked: true }),
  );
  const outsider = new Client(f.app, "198.51.100.40");
  rejected(
    await outsider.request("POST", `/api/meetings/${m.code}/join`, {
      name: "Late",
      password,
    }),
  );
  ok(await guest.client.request("POST", `/api/meetings/${m.code}/media`, {}));
  ok(
    await f.host.request("PATCH", `/api/meetings/${m.code}`, { locked: false }),
  );
  ok(
    await outsider.request("POST", `/api/meetings/${m.code}/join`, {
      name: "Late",
      password,
    }),
  );
});

test("guest password verification does not block moderation and admission rechecks the lock", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  let verifying!: () => void;
  const started = new Promise<void>((resolve) => (verifying = resolve));
  let release!: (valid: boolean) => void;
  t.mock.method(argon2, "verify", async () => {
    verifying();
    return new Promise<boolean>((resolve) => (release = resolve));
  });
  const guest = new Client(f.app, "198.51.100.40");
  const joining = guest.request("POST", `/api/meetings/${m.code}/join`, {
    name: "Guest",
    password,
  });
  await started;
  const locking = f.host.request("PATCH", `/api/meetings/${m.code}`, {
    locked: true,
  });
  let timeout!: ReturnType<typeof setTimeout>;
  const locked = await Promise.race([
    locking,
    new Promise<undefined>((resolve) => {
      timeout = setTimeout(resolve, 1000);
    }),
  ]);
  clearTimeout(timeout);
  release(true);
  const joined = await joining;
  await locking;
  assert.ok(locked, "Host moderation waited for guest password verification");
  ok(locked);
  assert.equal(joined.statusCode, 403);
  assert.match(joined.json().error, /locked/i);
  assert.equal((await f.store.get(m.code))!.participants.length, 1);
});

test("admission rejects a password changed while verification was pending", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  t.mock.method(argon2, "verify", async () => {
    await f.store.change(m.code, (meeting) => {
      meeting.passwordHash = "replaced-password-hash";
    });
    return true;
  });
  const response = await new Client(f.app, "198.51.100.40").request(
    "POST",
    `/api/meetings/${m.code}/join`,
    { name: "Guest", password },
  );
  assert.equal(response.statusCode, 403);
  assert.match(response.json().error, /credentials/i);
  assert.equal((await f.store.get(m.code))!.participants.length, 1);
});

test("source restrictions revoke previous grants and cannot be lifted by a guest", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code);
  await f.action(m.code, guest.id, "admit");
  const before = (await f.store.get(m.code))!.participants.find(
    (p) => p.id === guest.id,
  )!;
  await f.action(m.code, guest.id, "block-audio");
  await f.action(m.code, guest.id, "block-video");
  const after = (await f.store.get(m.code))!.participants.find(
    (p) => p.id === guest.id,
  )!;
  assert.ok(after.mediaVersion > before.mediaVersion);
  assert.equal(after.audioAllowed, false);
  assert.equal(after.videoAllowed, false);
  assert.ok(f.media.removed.includes(guest.id));
  rejected(
    await guest.client.request(
      "POST",
      `/api/meetings/${m.code}/participants/${guest.id}/action`,
      { action: "allow-audio" },
    ),
  );
  rejected(
    await guest.client.request(
      "POST",
      `/api/meetings/${m.code}/participants/${guest.id}/action`,
      { action: "allow-video" },
    ),
  );
  ok(
    await guest.client.request("POST", `/api/meetings/${m.code}/media`, {
      audioAllowed: true,
      videoAllowed: true,
    }),
  );
  assert.equal(f.media.issued.at(-1)?.participant.audioAllowed, false);
  assert.equal(f.media.issued.at(-1)?.participant.videoAllowed, false);
});

test("only the host grants screen sharing independently of camera and stage", async (t) => {
  const f = await fixture(t);
  const meeting = await f.meeting();
  const guest = await f.join(meeting.code);
  await f.action(meeting.code, guest.id, "admit");
  const path = `/api/meetings/${meeting.code}`;
  const state = () => guest.client.request("GET", `${path}/state`);
  assert.equal((await state()).json().me.videoAllowed, true);
  assert.equal((await state()).json().me.screenShareAllowed, false);
  rejected(
    await guest.client.request(
      "POST",
      `${path}/participants/${guest.id}/action`,
      {
        action: "allow-screen-share",
      },
    ),
  );

  const cohost = await f.join(meeting.code, "198.51.100.31");
  await f.action(meeting.code, cohost.id, "admit");
  ok(
    await f.host.request("PUT", `${path}/participants/${cohost.id}/moderator`, {
      enabled: true,
    }),
  );
  assert.equal(
    (
      await cohost.client.request(
        "POST",
        `${path}/participants/${guest.id}/action`,
        { action: "allow-screen-share" },
      )
    ).statusCode,
    403,
  );
  await f.action(meeting.code, guest.id, "allow-screen-share");
  let current = (await f.store.get(meeting.code))!.participants.find(
    (p) => p.id === guest.id,
  )!;
  assert.equal(current.screenShareAllowed, true);
  assert.equal((await state()).json().me.screenShareAllowed, true);
  const grantedVersion = current.mediaVersion;

  await f.action(meeting.code, guest.id, "block-video");
  current = (await f.store.get(meeting.code))!.participants.find(
    (p) => p.id === guest.id,
  )!;
  assert.equal(current.videoAllowed, false);
  assert.equal(current.screenShareAllowed, true);
  await f.action(meeting.code, guest.id, "block-screen-share");
  current = (await f.store.get(meeting.code))!.participants.find(
    (p) => p.id === guest.id,
  )!;
  assert.equal(current.videoAllowed, false);
  assert.equal(current.screenShareAllowed, false);
  assert.ok(current.mediaVersion > grantedVersion);
  assert.equal((await state()).json().me.screenShareAllowed, false);
  assert.ok(f.media.removed.includes(guest.id));

  const webinar = await f.meeting({ mode: "webinar" });
  const viewer = await f.join(webinar.code, "198.51.100.41");
  await f.action(webinar.code, viewer.id, "admit");
  assert.equal(
    (
      await f.host.request(
        "POST",
        `/api/meetings/${webinar.code}/participants/${viewer.id}/action`,
        { action: "allow-screen-share" },
      )
    ).statusCode,
    409,
  );
  await f.action(webinar.code, viewer.id, "promote");
  assert.equal(
    (
      await viewer.client.request("GET", `/api/meetings/${webinar.code}/state`)
    ).json().me.screenShareAllowed,
    false,
  );
  await f.action(webinar.code, viewer.id, "allow-screen-share");
  await f.action(webinar.code, viewer.id, "demote");
  assert.equal(
    (await f.store.get(webinar.code))!.participants.find(
      (p) => p.id === viewer.id,
    )!.screenShareAllowed,
    false,
  );
});

test("ended meetings cannot issue media credentials or admit new participants", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code);
  await f.action(m.code, guest.id, "admit");
  rejected(
    await guest.client.request("POST", `/api/meetings/${m.code}/end`, {}),
  );
  ok(await f.host.request("POST", `/api/meetings/${m.code}/end`, {}));
  assert.ok(f.media.ended.includes(m.code));
  rejected(
    await guest.client.request("POST", `/api/meetings/${m.code}/media`, {}),
  );
  rejected(await f.host.request("POST", `/api/meetings/${m.code}/media`, {}));
  const outsider = new Client(f.app, "198.51.100.50");
  rejected(
    await outsider.request("POST", `/api/meetings/${m.code}/join`, {
      name: "Late",
      password,
    }),
  );
});

test("cross-origin mutations and cross-meeting cookies are rejected", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code);
  await f.action(m.code, guest.id, "admit");
  rejected(
    await f.host.request(
      "PATCH",
      `/api/meetings/${m.code}`,
      { locked: true },
      { origin: "https://untrusted.example" },
    ),
  );
  const other = await f.meeting();
  rejected(
    await guest.client.request("GET", `/api/meetings/${other.code}/state`),
  );
  rejected(
    await guest.client.request("POST", `/api/meetings/${other.code}/media`, {}),
  );
  const missingHeader = await f.app.inject({
    method: "POST",
    url: `/api/meetings/${m.code}/messages`,
    headers: { origin, cookie: guest.client.cookie },
    payload: { text: "CSRF attempt" },
  });
  rejected(missingHeader);
});

test("breakout moves rotate media authority and room chat stays scoped", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const first = await f.join(m.code, "198.51.100.61");
  const second = await f.join(m.code, "198.51.100.62");
  await f.action(m.code, first.id, "admit");
  await f.action(m.code, second.id, "admit");
  rejected(
    await first.client.request("POST", `/api/meetings/${m.code}/breakouts`, {
      name: "Unauthorized",
    }),
  );
  ok(
    await f.host.request("POST", `/api/meetings/${m.code}/breakouts`, {
      name: "Small group",
    }),
  );
  const state = await f.host.request("GET", `/api/meetings/${m.code}/state`);
  ok(state);
  const breakoutId = state.json().meeting.breakouts[0].id;
  const before = (await f.store.get(m.code))!.participants.find(
    (p) => p.id === first.id,
  )!.mediaVersion;
  rejected(
    await first.client.request("POST", `/api/meetings/${m.code}/move`, {
      participantId: first.id,
      breakoutId,
    }),
  );
  ok(
    await f.host.request("POST", `/api/meetings/${m.code}/move`, {
      participantId: first.id,
      breakoutId,
    }),
  );
  const moved = (await f.store.get(m.code))!.participants.find(
    (p) => p.id === first.id,
  )!;
  assert.ok(moved.mediaVersion > before);
  assert.equal(moved.breakoutId, breakoutId);
  assert.ok(f.media.removed.includes(first.id));
  ok(await first.client.request("POST", `/api/meetings/${m.code}/media`, {}));
  assert.equal(f.media.issued.at(-1)?.participant.breakoutId, breakoutId);
  ok(
    await first.client.request("POST", `/api/meetings/${m.code}/messages`, {
      text: "Breakout-only message",
    }),
  );
  const mainState = await second.client.request(
    "GET",
    `/api/meetings/${m.code}/state`,
  );
  ok(mainState);
  assert.ok(
    !mainState
      .json()
      .messages.some(
        (message: { text: string }) => message.text === "Breakout-only message",
      ),
  );
  assert.ok(
    !mainState
      .json()
      .participants.some(
        (participant: { id: string }) => participant.id === first.id,
      ),
  );
  rejected(
    await first.client.request("POST", `/api/meetings/${m.code}/broadcast`, {
      text: "Not a host",
    }),
  );
  ok(
    await f.host.request("POST", `/api/meetings/${m.code}/broadcast`, {
      text: "Host announcement",
    }),
  );
  const breakoutState = await first.client.request(
    "GET",
    `/api/meetings/${m.code}/state`,
  );
  ok(breakoutState);
  assert.equal(
    breakoutState
      .json()
      .messages.find(
        (message: { text: string }) => message.text === "Breakout-only message",
      ).senderId,
    first.id,
  );
  assert.equal(
    breakoutState
      .json()
      .messages.find(
        (message: { text: string }) => message.text === "Host announcement",
      ).senderId,
    state.json().me.id,
  );
  assert.ok(
    breakoutState
      .json()
      .messages.some(
        (message: { text: string }) => message.text === "Host announcement",
      ),
  );
  assert.ok(
    breakoutState
      .json()
      .messages.some(
        (message: { text: string }) => message.text === "Breakout-only message",
      ),
  );
  ok(
    await first.client.request(
      "POST",
      `/api/meetings/${m.code}/return-main`,
      {},
    ),
  );
  const returned = (await f.store.get(m.code))!.participants.find(
    (p) => p.id === first.id,
  )!;
  assert.equal(returned.breakoutId, null);
  assert.ok(returned.mediaVersion > moved.mediaVersion);
  ok(
    await f.host.request("POST", `/api/meetings/${m.code}/close-breakouts`, {}),
  );
  assert.equal((await f.store.get(m.code))!.breakouts.length, 0);
});

test("a current co-host can moderate without receiving host-only state", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const cohost = await f.join(m.code, "198.51.100.31");
  const guest = await f.join(m.code, "198.51.100.32");
  const waiting = await f.join(m.code, "198.51.100.33");
  await f.action(m.code, cohost.id, "admit");
  await f.action(m.code, guest.id, "admit");
  const path = `/api/meetings/${m.code}`;
  ok(
    await f.host.request("POST", `${path}/messages`, {
      text: "Host private",
      recipient: guest.id,
    }),
  );
  await f.store.change(m.code, (current) => {
    current.hostEmailVerified = true;
    current.recordings.push({
      id: randomUUID(),
      status: "ready",
      createdAt: Date.now(),
    });
  });
  rejected(
    await cohost.client.request(
      "PUT",
      `${path}/participants/${guest.id}/moderator`,
      { enabled: true },
    ),
  );
  ok(
    await f.host.request("PUT", `${path}/participants/${cohost.id}/moderator`, {
      enabled: true,
    }),
  );
  const saved = (await f.store.get(m.code))!.participants.find(
    (p) => p.id === cohost.id,
  )!;
  assert.equal(saved.moderator?.grantedBy, m.hostId);
  assert.equal(typeof saved.moderator?.revision, "number");
  const state = (await cohost.client.request("GET", `${path}/state`)).json();
  assert.equal(state.me.moderator, true);
  assert.ok(
    state.participants.some((p: { id: string }) => p.id === waiting.id),
  );
  assert.equal(state.meeting.hostEmailVerified, undefined);
  assert.equal(state.meeting.usage, undefined);
  assert.deepEqual(state.recordings, []);
  assert.ok(
    !state.messages.some(
      (entry: { text: string }) => entry.text === "Host private",
    ),
  );

  ok(await cohost.client.request("PATCH", path, { locked: true }));
  rejected(
    await cohost.client.request("PATCH", path, {
      locked: false,
      recordingAllowed: true,
    }),
  );
  rejected(
    await cohost.client.request("PATCH", path, {
      locked: false,
      chatMode: "disabled",
    }),
  );
  ok(await cohost.client.request("PATCH", path, { locked: false }));
  ok(
    await cohost.client.request(
      "POST",
      `${path}/participants/${waiting.id}/action`,
      { action: "admit" },
    ),
  );
  ok(
    await cohost.client.request("POST", `${path}/breakouts`, { name: "Group" }),
  );
  const breakoutId = (
    await cohost.client.request("GET", `${path}/state`)
  ).json().meeting.breakouts[0].id;
  ok(
    await cohost.client.request("POST", `${path}/move`, {
      participantId: guest.id,
      breakoutId,
    }),
  );
  const priorRemovals = f.media.removed.filter((id) => id === guest.id).length;
  ok(
    await cohost.client.request(
      "POST",
      `${path}/participants/${guest.id}/action`,
      { action: "block-audio" },
    ),
  );
  assert.equal(
    f.media.removed.filter((id) => id === guest.id).length,
    priorRemovals + 1,
  );
  assert.equal(
    (await f.store.get(m.code))!.participants.find((p) => p.id === guest.id)!
      .audioAllowed,
    false,
  );
  ok(await cohost.client.request("POST", `${path}/close-breakouts`, {}));
  ok(
    await cohost.client.request(
      "POST",
      `${path}/participants/${waiting.id}/action`,
      { action: "ban", banDevice: true },
    ),
  );
  ok(
    await cohost.client.request(
      "POST",
      `${path}/participants/${guest.id}/action`,
      { action: "kick" },
    ),
  );
  assert.equal(
    (await f.store.get(m.code))!.participants.find((p) => p.id === guest.id)!
      .status,
    "kicked",
  );
  ok(
    await f.host.request("PUT", `${path}/participants/${cohost.id}/moderator`, {
      enabled: false,
    }),
  );
  assert.equal(
    (await cohost.client.request("GET", `${path}/state`)).json().me.moderator,
    false,
  );
  rejected(await cohost.client.request("PATCH", path, { locked: true }));
});

test("co-host authority cannot change the host, another delegate or sensitive policy", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const first = await f.join(m.code, "198.51.100.41");
  const second = await f.join(m.code, "198.51.100.42");
  const guest = await f.join(m.code, "198.51.100.43");
  const path = `/api/meetings/${m.code}`;
  await f.action(m.code, first.id, "admit");
  await f.action(m.code, second.id, "admit");
  await f.action(m.code, guest.id, "admit");
  rejected(
    await f.host.request("PUT", `${path}/participants/${first.id}/moderator`, {
      enabled: true,
      role: "host",
    }),
  );
  ok(
    await f.host.request("PUT", `${path}/participants/${first.id}/moderator`, {
      enabled: true,
    }),
  );
  ok(
    await f.host.request("PUT", `${path}/participants/${second.id}/moderator`, {
      enabled: true,
    }),
  );
  for (const id of [m.hostId, second.id]) {
    rejected(
      await first.client.request("POST", `${path}/participants/${id}/action`, {
        action: "kick",
      }),
    );
    rejected(
      await first.client.request("POST", `${path}/move`, {
        participantId: id,
        breakoutId: null,
      }),
    );
  }
  for (const action of ["promote", "demote", "rename"] as const)
    assert.equal(
      (
        await first.client.request(
          "POST",
          `${path}/participants/${guest.id}/action`,
          { action, ...(action === "rename" ? { name: "Other" } : {}) },
        )
      ).statusCode,
      403,
    );
  rejected(
    await first.client.request("POST", `${path}/broadcast`, {
      text: "Not host",
    }),
  );
  rejected(await first.client.request("POST", `${path}/end`, {}));
  rejected(
    await first.client.request(
      "PUT",
      `${path}/participants/${second.id}/moderator`,
      { enabled: false },
    ),
  );
  ok(await f.host.request("POST", `${path}/breakouts`, { name: "Protected" }));
  const breakoutId = (await f.host.request("GET", `${path}/state`)).json()
    .meeting.breakouts[0].id;
  ok(
    await f.host.request("POST", `${path}/move`, {
      participantId: second.id,
      breakoutId,
    }),
  );
  rejected(await first.client.request("POST", `${path}/close-breakouts`, {}));
  assert.equal((await f.store.get(m.code))!.breakouts.length, 1);
  ok(await f.host.request("POST", `${path}/close-breakouts`, {}));
  await f.store.change(m.code, (current) => {
    current.participants.find((p) => p.id === first.id)!.expiresAt =
      Date.now() - 1;
  });
  rejected(await first.client.request("PATCH", path, { locked: true }));
});

test("whiteboard writes require admission, obey host policy, and replay by room", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code, "198.51.100.70");
  const path = `/api/meetings/${m.code}/whiteboard`;
  const stroke = {
    kind: "stroke",
    epoch: 0,
    id: "00000000-0000-4000-8000-000000000001",
    points: [
      [0, 0],
      [12, -8],
    ],
  };
  rejected(await guest.client.request("GET", path));
  rejected(await guest.client.request("POST", path, stroke));
  await f.action(m.code, guest.id, "admit");
  const written = await guest.client.request("POST", path, stroke);
  ok(written);
  assert.equal(written.json().event.seq, 1);
  const repeated = await guest.client.request("POST", path, stroke);
  ok(repeated);
  assert.equal(repeated.json().event.seq, 1);
  const main = await f.host.request("GET", path);
  ok(main);
  assert.equal(main.json().events.length, 1);
  assert.equal(main.json().events[0].points[1][1], -8);
  rejected(
    await guest.client.request("POST", path, { kind: "clear", epoch: 0 }),
  );
  ok(
    await f.host.request("POST", path, {
      kind: "policy",
      epoch: 0,
      readOnly: true,
    }),
  );
  assert.equal(f.store.whiteboards.get(`${m.code}\0`)?.events.length, 1);
  rejected(
    await guest.client.request("POST", path, {
      kind: "text",
      epoch: 0,
      id: "00000000-0000-4000-8000-000000000002",
      x: 1,
      y: 2,
      text: "blocked",
    }),
  );
  ok(await f.host.request("POST", path, { kind: "clear", epoch: 0 }));
  rejected(await guest.client.request("POST", path, stroke));
  const afterClear = await f.host.request("GET", `${path}?after=1`);
  ok(afterClear);
  assert.deepEqual(
    afterClear.json().events.map((event: any) => event.kind),
    ["clear"],
  );
  assert.equal(afterClear.json().readOnly, true);
  assert.equal(afterClear.json().epoch, 1);
  ok(
    await f.host.request("POST", `/api/meetings/${m.code}/breakouts`, {
      name: "Side",
    }),
  );
  const state = await f.host.request("GET", `/api/meetings/${m.code}/state`);
  const breakoutId = state.json().meeting.breakouts[0].id;
  ok(
    await f.host.request("POST", `/api/meetings/${m.code}/move`, {
      participantId: guest.id,
      breakoutId,
    }),
  );
  const side = await guest.client.request("GET", path);
  ok(side);
  assert.deepEqual(side.json().events, []);
  assert.equal(side.json().readOnly, false);
  ok(
    await guest.client.request("POST", path, {
      kind: "text",
      epoch: 0,
      id: "00000000-0000-4000-8000-000000000003",
      x: 5,
      y: 9,
      text: "Side room",
    }),
  );
  const stillMain = await f.host.request("GET", path);
  assert.deepEqual(
    stillMain.json().events.map((event: any) => event.kind),
    ["clear"],
  );
  await f.action(m.code, guest.id, "kick");
  rejected(await guest.client.request("GET", path));
  ok(await f.host.request("POST", `/api/meetings/${m.code}/end`, {}));
  assert.equal(f.store.whiteboards.size, 0);
});

test("webinar viewers cannot publish until the host grants presenter permissions", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting({ mode: "webinar" });
  const viewer = await f.join(m.code);
  rejected(
    await f.host.request(
      "POST",
      `/api/meetings/${m.code}/participants/${viewer.id}/action`,
      { action: "promote" },
    ),
  );
  await f.action(m.code, viewer.id, "admit");
  for (const action of ["allow-audio", "allow-video"]) {
    rejected(
      await f.host.request(
        "POST",
        `/api/meetings/${m.code}/participants/${viewer.id}/action`,
        { action },
      ),
    );
  }
  assert.equal(
    (await viewer.client.request("POST", `/api/meetings/${m.code}/media`, {}))
      .statusCode,
    403,
  );
  ok(
    await f.host.request("POST", `/api/meetings/${m.code}/webinar/start`, {
      expectedRevision: 0,
      expectedControlRevision: (await f.store.get(m.code))!.hostControl!
        .revision,
    }),
  );
  ok(await viewer.client.request("POST", `/api/meetings/${m.code}/media`, {}));
  assert.equal(f.media.issued.at(-1)?.participant.role, "viewer");
  assert.equal(f.media.issued.at(-1)?.participant.audioAllowed, false);
  assert.equal(f.media.issued.at(-1)?.participant.videoAllowed, false);
  rejected(
    await viewer.client.request(
      "POST",
      `/api/meetings/${m.code}/participants/${viewer.id}/action`,
      { action: "promote" },
    ),
  );
  await f.action(m.code, viewer.id, "promote");
  ok(await viewer.client.request("POST", `/api/meetings/${m.code}/media`, {}));
  assert.equal(f.media.issued.at(-1)?.participant.role, "participant");
  assert.equal(f.media.issued.at(-1)?.participant.audioAllowed, true);
  await f.action(m.code, viewer.id, "demote");
  ok(await viewer.client.request("POST", `/api/meetings/${m.code}/media`, {}));
  assert.equal(f.media.issued.at(-1)?.participant.videoAllowed, false);
});

test("concurrent promotions cannot exceed ten webinar presenters including the host", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting({ mode: "webinar" });
  const first = await f.join(m.code);
  const second = await f.join(m.code, "198.51.100.21");
  await f.action(m.code, first.id, "admit");
  await f.action(m.code, second.id, "admit");
  await f.store.change(m.code, (state) => {
    const template = state.participants.find((p) => p.id === first.id)!;
    for (let i = 0; i < 8; i++)
      state.participants.push({
        ...template,
        id: `presenter-${i}`,
        role: "participant",
        tokenHash: `unusable-${i}`,
      });
  });
  const responses = await Promise.all(
    [first, second].map((guest) =>
      f.host.request(
        "POST",
        `/api/meetings/${m.code}/participants/${guest.id}/action`,
        { action: "promote" },
      ),
    ),
  );
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  const state = (await f.store.get(m.code))!;
  const winner = [first, second].find(
    (guest) =>
      state.participants.find((p) => p.id === guest.id)?.role === "participant",
  )!;
  const remaining = winner === first ? second : first;
  assert.equal(
    state.participants.filter((p) => p.role !== "viewer").length,
    10,
  );
  await f.action(m.code, winner.id, "kick");
  await f.action(m.code, remaining.id, "promote");
  const publicState = await f.host.request(
    "GET",
    `/api/meetings/${m.code}/state`,
  );
  assert.equal(publicState.json().meeting.webinar.presenters, 10);
  assert.equal(publicState.json().meeting.webinar.presenterLimit, 10);
});

test("the webinar audience has its own 1000-seat limit and demotion cannot overflow it", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting({ mode: "webinar" });
  const viewer = await f.join(m.code);
  await f.action(m.code, viewer.id, "admit");
  await f.store.change(m.code, (state) => {
    const template = state.participants.find((p) => p.id === viewer.id)!;
    for (let i = 0; i < 998; i++)
      state.participants.push({
        ...template,
        id: `viewer-${i}`,
        status: "waiting",
        tokenHash: `unusable-${i}`,
      });
  });
  const clients = [
    new Client(f.app, "198.51.100.31"),
    new Client(f.app, "198.51.100.32"),
  ];
  const responses = await Promise.all(
    clients.map((c) =>
      c.request("POST", `/api/meetings/${m.code}/join`, {
        name: "Viewer",
        password,
      }),
    ),
  );
  assert.deepEqual(responses.map((r) => r.statusCode).sort(), [200, 409]);
  await f.action(m.code, viewer.id, "promote");
  const replacement = await f.join(m.code, "198.51.100.33");
  const full = await f.host.request(
    "POST",
    `/api/meetings/${m.code}/participants/${viewer.id}/action`,
    { action: "demote" },
  );
  assert.equal(full.statusCode, 409);
  assert.match(full.json().error, /audience is full/i);
  await f.action(m.code, replacement.id, "kick");
  await f.action(m.code, viewer.id, "demote");
  const state = await f.host.request("GET", `/api/meetings/${m.code}/state`);
  assert.equal(state.json().meeting.webinar.viewers, 1000);
  assert.equal(state.json().meeting.webinar.presenters, 1);
  // Expired sessions must neither reserve a seat nor regain admission.
  await f.store.change(m.code, (meeting) => {
    meeting.participants.find((p) => p.id === "viewer-0")!.expiresAt =
      Date.now() - 1;
  });
  rejected(
    await f.host.request(
      "POST",
      `/api/meetings/${m.code}/participants/viewer-0/action`,
      { action: "admit" },
    ),
  );
  await f.join(m.code, "198.51.100.34");
});

test("meeting capacity includes the host and stage actions cannot cross meeting boundaries", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code);
  await f.action(m.code, guest.id, "admit");
  for (const action of ["promote", "demote"])
    rejected(
      await f.host.request(
        "POST",
        `/api/meetings/${m.code}/participants/${guest.id}/action`,
        { action },
      ),
    );
  const webinar = await f.meeting({ mode: "webinar" });
  rejected(
    await f.host.request(
      "POST",
      `/api/meetings/${webinar.code}/participants/${guest.id}/action`,
      { action: "promote" },
    ),
  );
  await f.store.change(m.code, (state) => {
    const template = state.participants.find((p) => p.id === guest.id)!;
    for (let i = 0; i < 98; i++)
      state.participants.push({
        ...template,
        id: `participant-${i}`,
        tokenHash: `unusable-${i}`,
      });
  });
  const response = await new Client(f.app, "198.51.100.40").request(
    "POST",
    `/api/meetings/${m.code}/join`,
    { name: "Over capacity", password },
  );
  assert.equal(response.statusCode, 409);
  await f.action(m.code, guest.id, "kick");
  await f.join(m.code, "198.51.100.41");
});

test("branding administration requires operator authority and rejects executable asset formats", async (t) => {
  const f = await fixture(t);
  await f.meeting();
  const configResponse = await f.host.request("GET", "/api/config");
  ok(configResponse);
  const branding = configResponse.json().branding;
  rejected(await f.host.request("PATCH", "/api/admin/branding", branding));
  rejected(
    await f.host.request("POST", "/api/admin/assets", {
      mime: "image/png",
      data: Buffer.alloc(16).toString("base64"),
    }),
  );
  const operator = new Client(f.app, "198.51.100.80");
  ok(await operator.request("POST", "/api/admin/session", { creationKey }));
  rejected(
    await operator.request("PATCH", "/api/admin/branding", {
      ...branding,
      supportUrl: "javascript:alert(1)",
    }),
  );
  rejected(
    await operator.request("PATCH", "/api/admin/branding", {
      ...branding,
      logoUrl: "https://untrusted.example/track.svg",
    }),
  );
  rejected(
    await operator.request("POST", "/api/admin/assets", {
      mime: "image/svg+xml",
      data: Buffer.from('<svg onload="alert(1)"></svg>').toString("base64"),
    }),
  );
  rejected(
    await operator.request("POST", "/api/admin/assets", {
      mime: "image/png",
      data: Buffer.alloc(16).toString("base64"),
    }),
  );
  ok(
    await operator.request("PATCH", "/api/admin/branding", {
      ...branding,
      brandName: "Test installation",
    }),
  );
  const updated = await operator.request("GET", "/api/config");
  ok(updated);
  assert.equal(updated.json().branding.brandName, "Test installation");
  assert.doesNotMatch(
    updated.body,
    /SESSION_SECRET|CREATION_KEY|LIVEKIT_API_SECRET|RECORDING_KEK/,
  );
});

test("recording key rotation requires operator authority and rejects caller-selected keys", async (t) => {
  const f = await fixture(t);
  const meeting = await f.meeting();
  const guest = await f.join(meeting.code);
  const id = "0e0b6375-ff2a-4df7-9e64-6d4bacf2e8a4";
  const endpoint = `/api/admin/meetings/${meeting.code}/recordings/${id}/rotate-key`;
  const invoked: string[] = [];
  t.mock.method(
    RecordingService.prototype,
    "rotateKey",
    async (m: Meeting, recordingId: string) => {
      invoked.push(`${m.code}/${recordingId}`);
    },
  );
  assert.equal((await f.host.request("POST", endpoint, {})).statusCode, 401);
  assert.equal(
    (await guest.client.request("POST", endpoint, {})).statusCode,
    401,
  );
  const operator = new Client(f.app, "198.51.100.85");
  ok(await operator.request("POST", "/api/admin/session", { creationKey }));
  rejected(await operator.request("POST", endpoint, { keyId: "attacker-key" }));
  rejected(
    await operator.request(
      "POST",
      endpoint,
      {},
      { origin: "https://untrusted.example" },
    ),
  );
  assert.deepEqual(invoked, []);
  ok(await operator.request("POST", endpoint, {}));
  assert.deepEqual(invoked, [`${meeting.code}/${id}`]);
});

test("a separate self-hosted portal origin is allowed only on portal administration and creation", async (t) => {
  const portalOrigin = "http://localhost:5174";
  const f = await fixture(t, "self-hosted", portalOrigin);
  const portal = new Client(f.app, "198.51.100.90");
  const signedIn = await portal.request(
    "POST",
    "/api/admin/session",
    { creationKey },
    { origin: portalOrigin },
  );
  ok(signedIn);
  assert.doesNotMatch(String(signedIn.headers["set-cookie"]), /Domain=/i);
  const created = await portal.request(
    "POST",
    "/api/meetings",
    {
      title: "Portal creation",
      hostName: "Host",
      password,
      mode: "meeting",
      creationKey,
    },
    { origin: portalOrigin },
  );
  ok(created);
  const { code, hostToken } = created.json();
  rejected(
    await portal.request(
      "POST",
      `/api/meetings/${code}/host`,
      { token: hostToken },
      { origin: portalOrigin },
    ),
  );
  rejected(
    await portal.request(
      "POST",
      `/api/meetings/${code}/join`,
      { name: "Guest", password },
      { origin: portalOrigin },
    ),
  );
  const hostExchange = await f.host.request(
    "POST",
    `/api/meetings/${code}/host`,
    { token: hostToken },
  );
  ok(hostExchange);
  assert.doesNotMatch(String(hostExchange.headers["set-cookie"]), /Domain=/i);
  rejected(
    await f.host.request(
      "POST",
      `/api/meetings/${code}/media`,
      {},
      { origin: portalOrigin },
    ),
  );
  rejected(
    await f.host.request(
      "PATCH",
      `/api/meetings/${code}`,
      { locked: true },
      { origin: portalOrigin },
    ),
  );
  ok(await f.host.request("POST", `/api/meetings/${code}/media`, {}));
  const branding = (await f.host.request("GET", "/api/config")).json().branding;
  ok(
    await portal.request(
      "PATCH",
      "/api/admin/branding",
      { ...branding, brandName: "Separate portal" },
      { origin: portalOrigin },
    ),
  );
});

test("six admitted participants behind one NAT can each poll meeting state normally", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guests = [];
  for (let i = 0; i < 6; i++) {
    const guest = await f.join(m.code, "198.51.100.120");
    await f.action(m.code, guest.id, "admit");
    guests.push(guest);
  }
  // At the UI's two-second interval this is less than one minute per participant.
  // The shared external address must not collapse them into a 120-request budget.
  for (let round = 0; round < 25; round++) {
    const results = await Promise.all(
      guests.map((guest) =>
        guest.client.request("GET", `/api/meetings/${m.code}/state`),
      ),
    );
    for (const response of results)
      assert.equal(
        response.statusCode,
        200,
        `Shared-NAT state polling failed: ${response.body}`,
      );
  }
});

test("hand rate limits keep admitted participants behind one NAT independent", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guests = [];
  for (let i = 0; i < 5; i++) {
    const guest = await f.join(m.code, "198.51.100.120");
    await f.action(m.code, guest.id, "admit");
    guests.push(guest);
  }
  for (let round = 0; round < 25; round++)
    for (const guest of guests)
      ok(
        await guest.client.request(
          "PUT",
          `/api/meetings/${m.code}/participants/${guest.id}/hand`,
          { raised: round % 2 === 0 },
        ),
      );
  const first = guests[0]!;
  for (let i = 0; i < 5; i++)
    ok(
      await first.client.request(
        "PUT",
        `/api/meetings/${m.code}/participants/${first.id}/hand`,
        { raised: false },
      ),
    );
  assert.equal(
    (
      await first.client.request(
        "PUT",
        `/api/meetings/${m.code}/participants/${first.id}/hand`,
        { raised: true },
      )
    ).statusCode,
    429,
  );
  const second = guests[1]!;
  ok(
    await second.client.request(
      "PUT",
      `/api/meetings/${m.code}/participants/${second.id}/hand`,
      { raised: false },
    ),
  );
});

test("media grants and host admissions have authenticated budgets behind a shared NAT", async (t) => {
  const f = await fixture(t);
  const room = await f.meeting();
  const guests = [
    await f.join(room.code, f.host.ip),
    await f.join(room.code, f.host.ip),
  ];
  for (const guest of guests) await f.action(room.code, guest.id, "admit");
  const media = `/api/meetings/${room.code}/media`;
  for (let i = 0; i < 70; i++)
    for (const guest of guests)
      ok(await guest.client.request("POST", media, {}));
  for (let i = 0; i < 50; i++)
    ok(await guests[0]!.client.request("POST", media, {}));
  assert.equal(
    (await guests[0]!.client.request("POST", media, {})).statusCode,
    429,
  );
  ok(await guests[1]!.client.request("POST", media, {}));
  // Host moderation does not consume the guests' media or shared IP budget.
  for (let i = 0; i < 125; i++)
    await f.action(room.code, guests[0]!.id, "rename", { name: "Guest" });
  ok(await f.host.request("POST", media, {}));
});

test("forged meeting sessions retain the shared IP budget before further lookups", async (t) => {
  const f = await fixture(t);
  const room = await f.meeting();
  const guest = await f.join(room.code, "198.51.100.122");
  await f.action(room.code, guest.id, "admit");
  const reads = t.mock.method(f.store, "get");
  for (let i = 0; i < 120; i++) {
    const client = new Client(f.app, guest.client.ip);
    client.cookie = guest.client.cookie.replace(
      new RegExp(`mp_${room.code}=[^;]+`),
      `mp_${room.code}=forged-${i}`,
    );
    const suffix = i % 2 ? "media" : `participants/${guest.id}/action`;
    assert.equal(
      (
        await client.request("POST", `/api/meetings/${room.code}/${suffix}`, {
          action: "admit",
        })
      ).statusCode,
      401,
    );
  }
  const before = reads.mock.callCount();
  assert.equal(
    (await guest.client.request("POST", `/api/meetings/${room.code}/media`, {}))
      .statusCode,
    429,
  );
  assert.equal(reads.mock.callCount(), before);
  // The pre-auth join limiter remains independent and unchanged.
  const unknown = new Client(f.app, "198.51.100.123");
  for (let i = 0; i < 120; i++)
    assert.equal(
      (
        await unknown.request("POST", "/api/meetings/UNKNOWN/join", {
          name: "Guest",
          password,
        })
      ).statusCode,
      404,
    );
  assert.equal(
    (
      await unknown.request("POST", "/api/meetings/UNKNOWN/join", {
        name: "Guest",
        password,
      })
    ).statusCode,
    429,
  );
});

test("poll limits reject forged cookie and code rotation before further store reads", async (t) => {
  const f = await fixture(t);
  const stateReads = t.mock.method(f.store, "get");
  const boardReads = t.mock.method(f.store, "readWhiteboard");
  const cases = [
    { route: "state", ipv6: false },
    { route: "state", ipv6: true },
    { route: "whiteboard", ipv6: true },
  ];
  const observed = [];
  for (const { route, ipv6 } of cases) {
    const reads = route === "state" ? stateReads.mock : boardReads.mock;
    const before = reads.callCount();
    const statuses = [];
    let atLimit = 0;
    for (let i = 0; i < 92; i++) {
      const code = String(i + 1).padStart(26, "A");
      const ip = ipv6
        ? `2001:db8:1234:5678::${(i + 1).toString(16)}`
        : "198.51.100.121";
      const client = new Client(f.app, ip);
      client.cookie = `mp_${code}=forged-${i}; mp_device=device-${i}.invalid`;
      const response = await client.request(
        "GET",
        `/api/meetings/${code}/${route}`,
      );
      statuses.push(response.statusCode);
      if (i === 89) atLimit = reads.callCount();
    }
    observed.push({
      route,
      ipv6,
      initialLookupsDenied: statuses
        .slice(0, 90)
        .every((status) => status === 404),
      limitedStatuses: statuses.slice(90),
      storeReads: atLimit - before,
      readsAfterLimit: reads.callCount() - atLimit,
    });
  }
  assert.deepEqual(
    observed,
    cases.map(({ route, ipv6 }) => ({
      route,
      ipv6,
      initialLookupsDenied: true,
      limitedStatuses: [429, 429],
      storeReads: 90,
      readsAfterLimit: 0,
    })),
  );
});

test("chat policy controls every send using current meeting authority", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting({ mode: "webinar" });
  const guest = await f.join(m.code);
  const path = `/api/meetings/${m.code}`;
  rejected(
    await guest.client.request("POST", `${path}/messages`, { text: "Waiting" }),
  );
  await f.action(m.code, guest.id, "admit");
  rejected(await guest.client.request("PATCH", path, { chatMode: "disabled" }));
  // Existing serialized rooms without a policy retain public chat.
  await f.store.change(m.code, (state) => {
    delete state.chatMode;
  });
  assert.equal(
    (await guest.client.request("GET", `${path}/state`)).json().meeting
      .chatMode,
    "everyone",
  );
  ok(
    await guest.client.request("POST", `${path}/messages`, {
      text: "Viewer message",
    }),
  );
  ok(await f.host.request("PATCH", path, { chatMode: "host-only" }));
  for (const recipient of ["everyone", "host"])
    rejected(
      await guest.client.request("POST", `${path}/messages`, {
        text: "Blocked",
        recipient,
      }),
    );
  ok(
    await f.host.request("POST", `${path}/messages`, { text: "Host message" }),
  );
  ok(
    await f.host.request("POST", `${path}/broadcast`, {
      text: "Host announcement",
    }),
  );
  ok(await f.host.request("PATCH", path, { chatMode: "disabled" }));
  const count = (await f.store.get(m.code))!.messages.length;
  for (const client of [guest.client, f.host])
    for (const endpoint of ["messages", "broadcast"])
      rejected(
        await client.request("POST", `${path}/${endpoint}`, {
          text: "Stale client send",
        }),
      );
  assert.equal((await f.store.get(m.code))!.messages.length, count);
  const reconnected = new Client(f.app, guest.client.ip);
  reconnected.cookie = guest.client.cookie;
  assert.equal(
    (await reconnected.request("GET", `${path}/state`)).json().meeting.chatMode,
    "disabled",
  );
  ok(await f.host.request("PATCH", path, { chatMode: "everyone" }));
  ok(
    await reconnected.request("POST", `${path}/messages`, {
      text: "Re-enabled",
    }),
  );
  rejected(await f.host.request("PATCH", path, { chatMode: "unknown" }));
  await f.action(m.code, guest.id, "kick");
  rejected(
    await guest.client.request("POST", `${path}/messages`, { text: "Kicked" }),
  );
  await f.store.change(m.code, (state) => {
    state.participants.find((p) => p.id === m.hostId)!.expiresAt =
      Date.now() - 1;
  });
  rejected(await f.host.request("PATCH", path, { chatMode: "everyone" }));
});

test("private host chat and replies stay scoped across breakouts and reconnect", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code, "198.51.100.21");
  const other = await f.join(m.code, "198.51.100.22");
  await f.action(m.code, guest.id, "admit");
  await f.action(m.code, other.id, "admit");
  const path = `/api/meetings/${m.code}`;
  ok(
    await f.host.request("POST", `${path}/breakouts`, { name: "Small group" }),
  );
  const breakoutId = (await f.host.request("GET", `${path}/state`)).json()
    .meeting.breakouts[0].id;
  ok(
    await f.host.request("POST", `${path}/move`, {
      participantId: guest.id,
      breakoutId,
    }),
  );
  ok(
    await guest.client.request("POST", `${path}/messages`, {
      text: "Breakout public",
    }),
  );
  ok(
    await guest.client.request("POST", `${path}/messages`, {
      text: "Private help",
      recipient: "host",
    }),
  );
  ok(
    await f.host.request("POST", `${path}/messages`, {
      text: "Private reply",
      recipient: guest.id,
    }),
  );
  const hostState = (await f.host.request("GET", `${path}/state`)).json();
  assert.deepEqual(
    hostState.messages.map((message: { text: string }) => message.text),
    ["Private help", "Private reply"],
  );
  assert.equal(hostState.messages[0].recipientId, m.hostId);
  assert.equal(hostState.messages[1].recipientId, guest.id);
  const stored = (await f.store.get(m.code))!;
  assert.deepEqual(
    stored.messages.map((message) => message.text),
    ["Breakout public"],
  );
  assert.equal(stored.privateMessages?.length, 2);
  // The old serializer only sees messages, so a rollback cannot expose private text.
  assert.ok(!JSON.stringify(stored.messages).includes("Private help"));
  assert.ok(!JSON.stringify(stored.messages).includes("Private reply"));
  assert.deepEqual(
    (await other.client.request("GET", `${path}/state`)).json().messages,
    [],
  );
  // A caller cannot choose a guest recipient, impersonate a sender or make a private broadcast.
  rejected(
    await guest.client.request("POST", `${path}/messages`, {
      text: "Guest DM",
      recipient: other.id,
    }),
  );
  rejected(
    await guest.client.request("POST", `${path}/messages`, {
      text: "Spoofed",
      senderId: m.hostId,
    }),
  );
  rejected(
    await guest.client.request("POST", `${path}/messages`, {
      text: "Spoofed scope",
      recipientId: other.id,
    }),
  );
  rejected(
    await f.host.request("POST", `${path}/broadcast`, {
      text: "Leaky broadcast",
      recipient: guest.id,
    }),
  );
  const foreign = await f.meeting();
  const foreignGuest = await f.join(foreign.code, "198.51.100.23");
  await f.action(foreign.code, foreignGuest.id, "admit");
  rejected(
    await f.host.request("POST", `${path}/messages`, {
      text: "Foreign recipient",
      recipient: foreignGuest.id,
    }),
  );
  rejected(await foreignGuest.client.request("GET", `${path}/state`));
  // Private host conversations follow their recipient; public breakout history does not.
  ok(
    await f.host.request("POST", `${path}/move`, {
      participantId: guest.id,
      breakoutId: null,
    }),
  );
  const returning = new Client(f.app, guest.client.ip);
  returning.cookie = guest.client.cookie;
  assert.deepEqual(
    (await returning.request("GET", `${path}/state`))
      .json()
      .messages.map((message: { text: string }) => message.text),
    ["Private help", "Private reply"],
  );
  assert.deepEqual(
    (await other.client.request("GET", `${path}/state`)).json().messages,
    [],
  );
  ok(await guest.client.request("POST", `${path}/leave`, {}));
  rejected(
    await guest.client.request("POST", `${path}/messages`, {
      text: "Left message",
      recipient: "host",
    }),
  );
  rejected(
    await f.host.request("POST", `${path}/messages`, {
      text: "Departed recipient",
      recipient: guest.id,
    }),
  );
});

test("host message removal preserves the history window and private scope", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code);
  const other = await f.join(m.code, "198.51.100.25");
  await f.action(m.code, guest.id, "admit");
  await f.action(m.code, other.id, "admit");
  const path = `/api/meetings/${m.code}`;
  await f.store.change(m.code, (state) => {
    state.messages = Array.from({ length: 101 }, (_, index) => ({
      id: randomUUID(),
      senderId: guest.id,
      name: "Guest",
      text: String(index),
      createdAt: Date.now(),
      breakoutId: null,
    }));
  });
  const before = (await guest.client.request("GET", `${path}/state`)).json()
    .messages;
  const id = before.at(-1).id;
  rejected(await guest.client.request("DELETE", `${path}/messages/${id}`, {}));
  ok(await f.host.request("PATCH", path, { chatMode: "disabled" }));
  ok(await f.host.request("DELETE", `${path}/messages/${id}`, {}));
  ok(await f.host.request("DELETE", `${path}/messages/${id}`, {}));
  const after = (await guest.client.request("GET", `${path}/state`)).json()
    .messages;
  assert.deepEqual(
    after.map((message: { id: string }) => message.id),
    before.map((message: { id: string }) => message.id),
  );
  assert.equal(after.at(-1).text, "");
  assert.equal(after.at(-1).deleted, true);
  assert.equal((await f.store.get(m.code))!.messages.at(-1)!.text, "");
  ok(await f.host.request("PATCH", path, { chatMode: "everyone" }));
  ok(
    await guest.client.request("POST", `${path}/messages`, {
      text: "Private to remove",
      recipient: "host",
    }),
  );
  const privateId = (await f.host.request("GET", `${path}/state`))
    .json()
    .messages.at(-1).id;
  ok(await f.host.request("DELETE", `${path}/messages/${privateId}`, {}));
  assert.equal(
    (await guest.client.request("GET", `${path}/state`)).json().messages.at(-1)
      .deleted,
    true,
  );
  assert.ok(
    !(await other.client.request("GET", `${path}/state`))
      .json()
      .messages.some((message: { id: string }) => message.id === privateId),
  );
  const foreign = await f.meeting();
  assert.equal(
    (
      await f.host.request(
        "DELETE",
        `/api/meetings/${foreign.code}/messages/${id}`,
        {},
      )
    ).statusCode,
    404,
  );
  assert.equal(
    (await f.store.get(m.code))!.messages.find((message) => message.id === id)!
      .deleted,
    true,
  );
  // Public and private rows share one bounded history, not two independent limits.
  await f.store.change(m.code, (state) => {
    state.messages = Array.from({ length: 500 }, (_, index) => ({
      id: randomUUID(),
      senderId: guest.id,
      name: "Guest",
      text: String(index),
      createdAt: Date.now() - 1000 + index,
      breakoutId: null,
    }));
  });
  ok(
    await guest.client.request("POST", `${path}/messages`, {
      text: "Newest private",
      recipient: "host",
    }),
  );
  const retained = (await f.store.get(m.code))!;
  assert.equal(
    retained.messages.length + retained.privateMessages!.length,
    500,
  );
  assert.ok(
    retained.privateMessages!.some(
      (message) => message.text === "Newest private",
    ),
  );
  assert.ok(!retained.messages.some((message) => message.recipientId));
});

test("same-clock chat preserves append order and drops the oldest shared history", async (t) => {
  const f = await fixture(t);
  const m = await f.meeting();
  const guest = await f.join(m.code);
  await f.action(m.code, guest.id, "admit");
  const path = `/api/meetings/${m.code}`;
  const now = Date.now();
  t.mock.method(Date, "now", () => now);
  const oldest = [randomUUID(), randomUUID()];
  await f.store.change(m.code, (state) => {
    state.revision = 1000;
    state.messages = [2, 1].map((offset) => ({
      id: randomUUID(),
      senderId: guest.id,
      name: "Guest",
      text: "Legacy public",
      createdAt: now - offset,
      breakoutId: null,
    }));
    state.privateMessages = Array.from({ length: 498 }, (_, index) => ({
      id: oldest[index] ?? randomUUID(),
      senderId: guest.id,
      recipientId: m.hostId,
      name: "Guest",
      text: `Earlier ${index}`,
      createdAt: now,
      sequence: index + 1,
      breakoutId: null,
    }));
  });
  for (const [text, recipient] of [
    ["First private", "host"],
    ["Second public", "everyone"],
    ["Third private", "host"],
    ["Fourth public", "everyone"],
  ])
    ok(
      await guest.client.request("POST", `${path}/messages`, {
        text,
        recipient,
      }),
    );
  const state = (await guest.client.request("GET", `${path}/state`)).json();
  assert.deepEqual(
    state.messages.slice(-4).map((message: { text: string }) => message.text),
    ["First private", "Second public", "Third private", "Fourth public"],
  );
  assert.ok(
    state.messages
      .slice(-4)
      .every((message: { createdAt: number }) => message.createdAt === now),
  );
  const saved = (await f.store.get(m.code))!;
  assert.equal(saved.messages.length + saved.privateMessages!.length, 500);
  assert.ok(
    !saved.privateMessages!.some((message) => oldest.includes(message.id)),
  );
  assert.ok(
    !saved.messages.some((message) => message.text === "Legacy public"),
  );
  assert.ok(saved.messages.some((message) => message.text === "Second public"));
  assert.ok(saved.messages.some((message) => message.text === "Fourth public"));
});

test("handoff preserves ownership and private data while only the selected co-host can end", async (t) => {
  const f = await fixture(t, "self-hosted");
  const room = await f.meeting();
  const a = await f.join(room.code, "198.51.100.61");
  const b = await f.join(room.code, "198.51.100.62");
  for (const p of [a, b]) {
    await f.action(room.code, p.id, "admit");
    ok(
      await f.host.request(
        "PUT",
        `/api/meetings/${room.code}/participants/${p.id}/moderator`,
        { enabled: true },
      ),
    );
  }
  const path = `/api/meetings/${room.code}`;
  ok(
    await f.host.request("POST", `${path}/messages`, {
      text: "Owner private history",
      recipient: b.id,
    }),
  );
  await f.store.change(room.code, (m) => {
    m.hostEmail = "owner@example.test";
    m.hostEmailVerified = true;
  });
  const before = (await f.store.get(room.code))!;
  const body = {
    participantId: a.id,
    grantRevision: before.participants.find((p) => p.id === a.id)!.moderator!
      .revision,
    expectedRevision: before.hostControl!.revision,
    requestId: randomUUID(),
  };
  assert.equal(
    (await a.client.request("POST", `${path}/handoff`, body)).statusCode,
    403,
  );
  ok(await f.host.request("POST", `${path}/handoff`, body));
  const after = (await f.store.get(room.code))!;
  assert.equal(after.ended, false);
  assert.deepEqual(after.lifecycle, before.lifecycle);
  assert.deepEqual(after.hosted, before.hosted);
  assert.deepEqual(after.recordings, before.recordings);
  assert.deepEqual(after.privateMessages, before.privateMessages);
  assert.equal(after.hostEmail, before.hostEmail);
  assert.deepEqual(
    after.participants.filter((p) => p.role === "host").map((p) => p.id),
    [room.hostId],
  );
  assert.equal(meetingController(after)?.id, a.id);
  assert.equal(
    after.participants.find((p) => p.id === room.hostId)!.status,
    "left",
  );
  assert.equal(
    occupiesRoomSeat(
      after,
      after.participants.find((p) => p.id === room.hostId)!,
    ),
    true,
  );
  assert.deepEqual(f.media.removed, [room.hostId]);
  assert.deepEqual(f.media.ended, []);
  const state = (await a.client.request("GET", `${path}/state`)).json();
  assert.equal(state.meeting.canEnd, true);
  assert.equal(state.meeting.hostEmailVerified, undefined);
  assert.equal(state.meeting.usage, undefined);
  assert.deepEqual(state.recordings, []);
  assert.equal(
    state.messages.some(
      (m: { text: string }) => m.text === "Owner private history",
    ),
    false,
  );
  assert.equal(JSON.stringify(state).includes("ownerSessionHash"), false);
  assert.equal(
    (await a.client.request("POST", `${path}/broadcast`, { text: "No" }))
      .statusCode,
    403,
  );
  assert.equal(
    (await a.client.request("POST", `${path}/recordings`, {})).statusCode,
    403,
  );
  assert.equal(
    (await b.client.request("POST", `${path}/end`, {})).statusCode,
    403,
  );
  assert.equal(
    (await f.host.request("POST", `${path}/leave`, {})).statusCode,
    409,
  );
  let cleanupFails = true;
  t.mock.method(f.media, "end", async (m: Meeting) => {
    f.media.ended.push(m.code);
    if (cleanupFails) throw new Error("Synthetic cleanup failure");
  });
  assert.equal(
    (await a.client.request("POST", `${path}/end`, {})).statusCode,
    202,
  );
  assert.equal((await f.store.get(room.code))!.ended, true);
  assert.equal(
    (await b.client.request("POST", `${path}/end`, {})).statusCode,
    403,
  );
  cleanupFails = false;
  ok(await a.client.request("POST", `${path}/end`, {}));
  // The completed response may also be lost; the same controller can retry.
  ok(await a.client.request("POST", `${path}/end`, {}));
  assert.deepEqual(f.media.ended, [room.code, room.code, room.code]);
  await f.store.change(room.code, (m) => {
    m.participants.find((p) => p.id === a.id)!.moderator!.revision++;
  });
  assert.equal(
    (await a.client.request("POST", `${path}/end`, {})).statusCode,
    403,
  );
});

test("handoff retries one physical fence and self-host return invalidates delayed handoff without losing owner cookie", async (t) => {
  const f = await fixture(t, "self-hosted");
  const room = await f.meeting();
  const a = await f.join(room.code, "198.51.100.63");
  await f.action(room.code, a.id, "admit");
  const path = `/api/meetings/${room.code}`;
  ok(
    await f.host.request("PUT", `${path}/participants/${a.id}/moderator`, {
      enabled: true,
    }),
  );
  const before = (await f.store.get(room.code))!;
  const body = {
    participantId: a.id,
    grantRevision: before.participants.find((p) => p.id === a.id)!.moderator!
      .revision,
    expectedRevision: before.hostControl!.revision,
    requestId: randomUUID(),
  };
  let failed = true;
  const removed: number[] = [];
  t.mock.method(f.media, "remove", async (_m: Meeting, p: Participant) => {
    removed.push(p.mediaVersion);
    if (failed) throw new Error("Synthetic disconnect failure");
  });
  const pending = await f.host.request("POST", `${path}/handoff`, body);
  assert.equal(pending.statusCode, 202);
  assert.equal(pending.json().cleanupPending, true);
  const committed = (await f.store.get(room.code))!;
  assert.equal(committed.ended, false);
  const generation = committed.participants.find(
    (p) => p.id === room.hostId,
  )!.mediaVersion;
  assert.equal(
    (await f.host.request("POST", `${path}/media`, {})).statusCode,
    403,
  );
  assert.equal(
    (
      await f.host.request("POST", `${path}/handoff`, {
        ...body,
        requestId: randomUUID(),
      })
    ).statusCode,
    409,
  );
  failed = false;
  ok(await f.host.request("POST", `${path}/handoff`, body));
  ok(await f.host.request("POST", `${path}/handoff`, body));
  assert.deepEqual(removed, [generation, generation]);
  const cookie = f.host.cookie;
  const revision = (await f.store.get(room.code))!.hostControl!.revision;
  ok(
    await f.host.request("POST", `${path}/host-return`, {
      expectedRevision: revision,
    }),
  );
  // Treat the first response as lost: keep the original cookie and repeat the request.
  f.host.cookie = cookie;
  ok(
    await f.host.request("POST", `${path}/host-return`, {
      expectedRevision: revision,
    }),
  );
  const returned = (await f.store.get(room.code))!;
  assert.equal(meetingController(returned)?.id, room.hostId);
  assert.equal(returned.hostControl!.revision, revision + 1);
  assert.deepEqual(returned.lifecycle, before.lifecycle);
  assert.equal(
    (await a.client.request("POST", `${path}/end`, {})).statusCode,
    403,
  );
  assert.equal(
    (await f.host.request("POST", `${path}/handoff`, body)).statusCode,
    409,
  );
  ok(await f.host.request("POST", `${path}/media`, {}));
  const next = {
    ...body,
    expectedRevision: returned.hostControl!.revision,
    requestId: randomUUID(),
  };
  ok(await f.host.request("POST", `${path}/handoff`, next));
  assert.equal(
    (
      await f.host.request("POST", `${path}/host-return`, {
        expectedRevision: revision,
      })
    ).statusCode,
    409,
  );
  assert.equal(meetingController((await f.store.get(room.code))!)?.id, a.id);
});

test("succession requires the current co-host grant and cannot select an inactive or foreign target", async (t) => {
  const f = await fixture(t);
  const room = await f.meeting();
  const a = await f.join(room.code, "198.51.100.64");
  const path = `/api/meetings/${room.code}`;
  await f.action(room.code, a.id, "admit");
  ok(
    await f.host.request("PUT", `${path}/participants/${a.id}/moderator`, {
      enabled: true,
    }),
  );
  const before = (await f.store.get(room.code))!;
  const body = {
    participantId: a.id,
    grantRevision: before.participants.find((p) => p.id === a.id)!.moderator!
      .revision,
    expectedRevision: before.hostControl!.revision,
    requestId: randomUUID(),
  };
  for (const patch of [
    { participantId: randomUUID() },
    { participantId: room.hostId },
    { grantRevision: body.grantRevision - 1 },
  ])
    assert.equal(
      (await f.host.request("POST", `${path}/handoff`, { ...body, ...patch }))
        .statusCode,
      409,
    );
  ok(
    await f.host.request("PUT", `${path}/participants/${a.id}/moderator`, {
      enabled: false,
    }),
  );
  ok(
    await f.host.request("PUT", `${path}/participants/${a.id}/moderator`, {
      enabled: true,
    }),
  );
  assert.equal(
    (await f.host.request("POST", `${path}/handoff`, body)).statusCode,
    409,
  );
  await f.store.change(room.code, (m) => {
    m.participants.find((p) => p.id === a.id)!.expiresAt = Date.now() - 1;
  });
  const current = (await f.store.get(room.code))!;
  assert.equal(
    (
      await f.host.request("POST", `${path}/handoff`, {
        ...body,
        grantRevision: current.participants.find((p) => p.id === a.id)!
          .moderator!.revision,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await f.store.get(room.code))!.participants.find(
      (p) => p.id === room.hostId,
    )!.status,
    "admitted",
  );
});

test("host absence has durable grace without promoting guests or allowing late resurrection", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
  const f = await fixture(t, "self-hosted");
  const room = await f.meeting();
  const path = `/api/meetings/${room.code}`;
  let m = (await f.store.get(room.code))!;
  const original = structuredClone(m.lifecycle);
  t.mock.timers.setTime(now + 31_000);
  assert.equal(controllerPresent(m), false);
  assert.equal(reconcileHostAbsence(m, 300), true);
  const absentSince = m.hostControl!.absentSince;
  assert.equal(absentSince, now + 30_000);
  assert.equal(m.ended, false);
  await f.store.change(room.code, (current) => {
    current.hostControl = structuredClone(m.hostControl);
  });
  t.mock.timers.setTime(now + 60_000);
  ok(await f.host.request("GET", `${path}/state`));
  m = (await f.store.get(room.code))!;
  assert.equal(m.hostControl!.absentSince, undefined);
  assert.equal(controllerPresent(m), true);
  // A fresh media presence also keeps control alive when the control tab is throttled.
  t.mock.timers.setTime(now + 120_000);
  m.participants[0]!.gatewayPresenceUntil = now + 130_000;
  assert.equal(reconcileHostAbsence(m, 300), false);
  assert.equal(controllerPresent(m), true);
  t.mock.timers.setTime(now + 131_000);
  reconcileHostAbsence(m, 300);
  assert.equal(m.hostControl!.absentSince, now + 130_000);
  const reopened = structuredClone(m);
  t.mock.timers.setTime(now + 430_000);
  assert.equal(meetingAllowed(reopened), false);
  reconcileHostAbsence(reopened, 300);
  assert.equal(reopened.ended, true);
  assert.deepEqual(reopened.lifecycle, original);
  await f.store.change(room.code, (current) => {
    current.hostControl = m.hostControl;
  });
  assert.equal(
    (await f.host.request("POST", `${path}/media`, {})).statusCode,
    410,
  );
  const unstarted = structuredClone(m);
  delete unstarted.lifecycle;
  assert.equal(reconcileHostAbsence(unstarted, 300), false);
  assert.equal(unstarted.ended, false);
  const unadopted = structuredClone(m);
  delete unadopted.hostControl;
  reconcileHostAbsence(unadopted, 300);
  const saved = structuredClone(unadopted.hostControl);
  reconcileHostAbsence(unadopted, 300);
  assert.deepEqual(unadopted.hostControl, saved);
});

test("self-host absence setting is bounded and cannot override hosted grace", () => {
  const env = { SESSION_SECRET: "host-absence-test-secret-over-32-characters" };
  assert.equal(loadConfig(env).hostAbsenceGraceSeconds, 300);
  assert.equal(
    loadConfig({ ...env, HOST_ABSENCE_GRACE_SECONDS: "30" })
      .hostAbsenceGraceSeconds,
    30,
  );
  for (const value of ["0", "29", "1801", "NaN", "1.5"])
    assert.throws(() =>
      loadConfig({ ...env, HOST_ABSENCE_GRACE_SECONDS: value }),
    );
  assert.equal(
    loadConfig({
      ...env,
      EDITION: "hosted",
      CREATION_KEY: creationKey,
      HOST_ABSENCE_GRACE_SECONDS: "30",
    }).hostAbsenceGraceSeconds,
    300,
  );
});

test("a departed successor starts absence grace without promoting or refreshing from another guest", async (t) => {
  const now = Date.now();
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
  const f = await fixture(t, "self-hosted");
  const room = await f.meeting(),
    path = `/api/meetings/${room.code}`;
  const a = await f.join(room.code, "198.51.100.71"),
    b = await f.join(room.code, "198.51.100.72");
  for (const p of [a, b]) {
    await f.action(room.code, p.id, "admit");
    ok(
      await f.host.request("PUT", `${path}/participants/${p.id}/moderator`, {
        enabled: true,
      }),
    );
  }
  const before = (await f.store.get(room.code))!;
  ok(
    await f.host.request("POST", `${path}/handoff`, {
      participantId: a.id,
      grantRevision: before.participants.find((p) => p.id === a.id)!.moderator!
        .revision,
      expectedRevision: before.hostControl!.revision,
      requestId: randomUUID(),
    }),
  );
  ok(await a.client.request("POST", `${path}/leave`, {}));
  t.mock.timers.setTime(now + 31_000);
  await f.store.change(room.code, (m) => {
    reconcileHostAbsence(m, 300);
  });
  const absent = (await f.store.get(room.code))!;
  assert.equal(meetingController(absent), undefined);
  assert.equal(absent.hostControl!.absentSince, now + 30_000);
  t.mock.timers.setTime(now + 100_000);
  const other = await b.client.request("GET", `${path}/state`);
  ok(other);
  assert.equal(other.json().meeting.canEnd, false);
  assert.equal(
    (await f.store.get(room.code))!.hostControl!.absentSince,
    absent.hostControl!.absentSince,
  );
  assert.equal(
    (await b.client.request("POST", `${path}/end`, {})).statusCode,
    403,
  );
  t.mock.timers.setTime(now + 330_000);
  assert.equal(
    (
      await f.host.request("POST", `${path}/host-return`, {
        expectedRevision: absent.hostControl!.revision,
      })
    ).statusCode,
    410,
  );
  await f.store.change(room.code, (m) => {
    reconcileHostAbsence(m, 300);
  });
  assert.equal((await f.store.get(room.code))!.ended, true);
});

test("webinar backstage keeps audience media, roster, chat and whiteboard separate", async (t) => {
  const f = await fixture(t, "self-hosted");
  const room = await f.meeting({ mode: "webinar" });
  const path = `/api/meetings/${room.code}`;
  const presenter = await f.join(room.code);
  const viewer = await f.join(room.code, "198.51.100.22");
  for (const p of [presenter, viewer]) await f.action(room.code, p.id, "admit");
  await f.action(room.code, presenter.id, "promote");
  const before = (await f.store.get(room.code))!;
  assert.equal(before.webinar!.phase, "backstage");
  assert.equal(
    before.participants.find((p) => p.id === presenter.id)!.webinarLocation,
    "backstage",
  );
  ok(
    await f.host.request("POST", `${path}/messages`, {
      text: "Private rehearsal",
    }),
  );
  ok(
    await presenter.client.request("POST", `${path}/messages`, {
      text: "Presenter rehearsal",
    }),
  );
  ok(
    await f.host.request("POST", `${path}/broadcast`, {
      text: "Starting shortly",
    }),
  );
  const privateStroke = randomUUID();
  ok(
    await f.host.request("POST", `${path}/whiteboard`, {
      kind: "stroke",
      epoch: 0,
      id: privateStroke,
      points: [
        [0, 0],
        [1, 1],
      ],
    }),
  );
  const audience = (await viewer.client.request("GET", `${path}/state`)).json();
  assert.equal(audience.me.mediaAllowed, false);
  assert.deepEqual(
    audience.participants.map((p: { id: string }) => p.id),
    [viewer.id],
  );
  assert.deepEqual(
    audience.messages.map((m: { text: string }) => m.text),
    ["Starting shortly"],
  );
  assert.ok(!JSON.stringify(audience).includes(before.webinar!.backstageRoom));
  assert.equal(
    (await viewer.client.request("POST", `${path}/media`, {})).statusCode,
    403,
  );
  assert.deepEqual(
    (await viewer.client.request("GET", `${path}/whiteboard`)).json().events,
    [],
  );
  assert.equal(
    (
      await viewer.client.request("POST", `${path}/whiteboard`, {
        kind: "clear",
        epoch: 0,
        scope: "@backstage",
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await presenter.client.request("GET", `${path}/whiteboard`)).json()
      .events[0].id,
    privateStroke,
  );
  const saved = (await f.store.get(room.code))!;
  assert.ok(
    !saved.messages.some((m) => m.text.includes("rehearsal")),
    "Old public-only readers cannot expose backstage messages",
  );
  assert.equal(saved.backstageMessages!.length, 2);
  ok(
    await f.host.request("POST", `${path}/webinar/start`, {
      expectedRevision: saved.webinar!.revision,
      expectedControlRevision: before.hostControl!.revision,
    }),
  );
  const live = (await f.store.get(room.code))!;
  assert.deepEqual(live.lifecycle, before.lifecycle);
  assert.deepEqual(live.hosted, before.hosted);
  const state = (await viewer.client.request("GET", `${path}/state`)).json();
  assert.equal(state.meeting.webinar.phase, "live");
  assert.equal(state.me.mediaAllowed, true);
  assert.ok(
    state.participants.some((p: { id: string }) => p.id === room.hostId),
  );
  assert.ok(
    !state.participants.some((p: { id: string }) => p.id === presenter.id),
  );
  assert.ok(
    !state.messages.some((m: { text: string }) => m.text.includes("rehearsal")),
  );
  assert.deepEqual(
    (await f.host.request("GET", `${path}/whiteboard`)).json().events,
    [],
  );
  ok(
    await f.host.request(
      "PUT",
      `${path}/webinar/participants/${presenter.id}`,
      {
        location: "stage",
        expectedRevision: live.webinar!.revision,
        expectedControlRevision: before.hostControl!.revision,
      },
    ),
  );
  assert.equal(
    (await presenter.client.request("GET", `${path}/state`)).json().me
      .webinarBackstage,
    false,
  );
  ok(
    await presenter.client.request("POST", `${path}/messages`, {
      text: "Public presentation",
    }),
  );
  assert.ok(
    (await viewer.client.request("GET", `${path}/state`))
      .json()
      .messages.some((m: { text: string }) => m.text === "Public presentation"),
  );
  ok(await f.host.request("POST", `${path}/breakouts`, { name: "Discussion" }));
  const breakout = (await f.store.get(room.code))!.breakouts[0]!;
  ok(
    await f.host.request("POST", `${path}/move`, {
      participantId: presenter.id,
      breakoutId: breakout.id,
    }),
  );
  ok(await presenter.client.request("POST", `${path}/return-main`, {}));
  const returned = (
    await presenter.client.request("GET", `${path}/state`)
  ).json();
  assert.equal(
    returned.me.webinarBackstage,
    true,
    "Returning from a breakout does not silently go on stage",
  );
  assert.equal(
    (
      await viewer.client.request("POST", `${path}/move`, {
        participantId: viewer.id,
        breakoutId: "@backstage",
      })
    ).statusCode,
    403,
  );
});

test("webinar start fences old backstage identities and never commits live after failed cleanup or changed control", async (t) => {
  const f = await fixture(t, "self-hosted");
  const room = await f.meeting({ mode: "webinar" });
  const path = `/api/meetings/${room.code}`;
  const viewer = await f.join(room.code);
  await f.action(room.code, viewer.id, "admit");
  const before = (await f.store.get(room.code))!;
  const originalHost = before.participants.find((p) => p.id === room.hostId)!;
  let fail = true;
  const removals: Participant[] = [];
  f.media.remove = async (_m, p) => {
    removals.push(structuredClone(p));
    if (fail) throw new Error("unavailable");
  };
  const input = {
    expectedRevision: 0,
    expectedControlRevision: before.hostControl!.revision,
  };
  assert.equal(
    (await f.host.request("POST", `${path}/webinar/start`, input)).statusCode,
    503,
  );
  const pending = (await f.store.get(room.code))!;
  assert.equal(pending.webinar!.phase, "backstage");
  assert.equal(pending.webinar!.starting, true);
  assert.equal(removals[0]!.previousRoom, before.webinar!.backstageRoom);
  assert.equal(removals[0]!.previousMediaIdentity, originalHost.id);
  for (const client of [f.host, viewer.client])
    assert.equal(
      (await client.request("POST", `${path}/media`, {})).statusCode,
      403,
    );
  fail = false;
  ok(await f.host.request("POST", `${path}/webinar/start`, input));
  assert.equal(
    removals[1]!.previousMediaIdentity,
    removals[0]!.previousMediaIdentity,
  );
  assert.equal(removals[1]!.mediaVersion, removals[0]!.mediaVersion);
  assert.equal((await f.store.get(room.code))!.webinar!.phase, "live");
  assert.equal(
    (await f.host.request("POST", `${path}/webinar/start`, input)).statusCode,
    409,
    "Old revision cannot replay",
  );
  const live = (await f.store.get(room.code))!;
  await f.store.change(room.code, (m) => {
    m.hostControl!.revision++;
  });
  assert.equal(
    (
      await f.host.request(
        "PUT",
        `${path}/webinar/participants/${room.hostId}`,
        {
          location: "backstage",
          expectedRevision: live.webinar!.revision,
          expectedControlRevision: before.hostControl!.revision,
        },
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await f.store.get(room.code))!.participants.find(
      (p) => p.id === room.hostId,
    )!.webinarLocation,
    "stage",
  );
});

test("webinar only the selected current controller can run the broadcast; revoked delegates and legacy rooms stay bounded", async (t) => {
  const f = await fixture(t, "self-hosted");
  const room = await f.meeting({ mode: "webinar" });
  const path = `/api/meetings/${room.code}`;
  const guest = await f.join(room.code);
  await f.action(room.code, guest.id, "admit");
  await f.action(room.code, guest.id, "promote");
  ok(
    await f.host.request("PUT", `${path}/participants/${guest.id}/moderator`, {
      enabled: true,
    }),
  );
  let saved = (await f.store.get(room.code))!;
  assert.equal(
    (
      await guest.client.request("POST", `${path}/webinar/start`, {
        expectedRevision: saved.webinar!.revision,
        expectedControlRevision: saved.hostControl!.revision,
      })
    ).statusCode,
    403,
  );
  ok(
    await f.host.request("POST", `${path}/handoff`, {
      participantId: guest.id,
      grantRevision: saved.participants.find((p) => p.id === guest.id)!
        .moderator!.revision,
      expectedRevision: saved.hostControl!.revision,
      requestId: randomUUID(),
    }),
  );
  saved = (await f.store.get(room.code))!;
  ok(
    await guest.client.request(
      "PUT",
      `${path}/webinar/participants/${guest.id}`,
      {
        location: "stage",
        expectedRevision: saved.webinar!.revision,
        expectedControlRevision: saved.hostControl!.revision,
      },
    ),
  );
  saved = (await f.store.get(room.code))!;
  const start = {
    expectedRevision: saved.webinar!.revision,
    expectedControlRevision: saved.hostControl!.revision,
  };
  ok(await guest.client.request("POST", `${path}/webinar/start`, start));
  await f.store.change(room.code, (m) => {
    delete m.participants.find((p) => p.id === guest.id)!.moderator;
  });
  assert.equal(
    (await guest.client.request("POST", `${path}/webinar/start`, start))
      .statusCode,
    403,
  );
  const legacy = await f.meeting({ mode: "webinar" });
  await f.store.change(legacy.code, (m) => {
    delete m.webinar;
  });
  const viewer = await f.join(legacy.code, "198.51.100.23");
  await f.action(legacy.code, viewer.id, "admit");
  ok(
    await viewer.client.request(
      "POST",
      `/api/meetings/${legacy.code}/media`,
      {},
    ),
  );
  assert.equal(
    (
      await viewer.client.request("GET", `/api/meetings/${legacy.code}/state`)
    ).json().meeting.webinar.phase,
    "live",
  );
});

test("webinar start rechecks control after physical removal before committing live", async (t) => {
  const f = await fixture(t, "self-hosted");
  const room = await f.meeting({ mode: "webinar" });
  const path = `/api/meetings/${room.code}`;
  const before = (await f.store.get(room.code))!;
  let rotate = true;
  f.media.remove = async () => {
    if (rotate) {
      rotate = false;
      await f.store.change(room.code, (m) => {
        m.hostControl!.revision++;
      });
    }
  };
  const command = {
    expectedRevision: before.webinar!.revision,
    expectedControlRevision: before.hostControl!.revision,
  };
  assert.equal(
    (await f.host.request("POST", `${path}/webinar/start`, command)).statusCode,
    409,
  );
  const pending = (await f.store.get(room.code))!;
  assert.equal(pending.webinar!.phase, "backstage");
  assert.equal(pending.webinar!.starting, true);
  assert.equal(
    pending.participants.some((p) => p.enforcementPending),
    false,
  );
  assert.equal(
    (await f.host.request("POST", `${path}/media`, {})).statusCode,
    403,
  );
  ok(
    await f.host.request("POST", `${path}/webinar/start`, {
      ...command,
      expectedControlRevision: pending.hostControl!.revision,
    }),
  );
  assert.equal((await f.store.get(room.code))!.webinar!.phase, "live");
});
