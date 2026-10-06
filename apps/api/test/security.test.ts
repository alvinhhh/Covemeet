import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { MemoryStore, type Meeting, type Participant } from "../src/store.js";
import type { Media } from "../src/media.js";
import { RecordingService } from "../src/recordings.js";

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
    method: "GET" | "POST" | "PATCH" | "DELETE",
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
      senderId: second.id,
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
