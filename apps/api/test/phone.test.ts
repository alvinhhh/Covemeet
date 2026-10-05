import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { LiveMedia } from "../src/media.js";
import {
  completeMediaFence,
  fenceParticipantMedia,
  mediaIdentity,
} from "../src/media-identity.js";
import { MemoryStore, type Meeting, type Participant } from "../src/store.js";
import { RecordingService } from "../src/recordings.js";

const origin = "http://localhost:5173";
const secret = "session-key-for-phone-tests-at-least-32-characters";
const gatewayKey = "gateway-key-for-phone-tests-at-least-32-characters";
const creationKey = "creation-key-for-phone-tests-at-least-32-characters";
const env = {
  NODE_ENV: "test",
  SESSION_SECRET: secret,
  EDITION: "hosted",
  SITE_ORIGIN: origin,
  CREATION_KEY: creationKey,
  PHONE_ENABLED: "true",
  PHONE_GATEWAY_KEY: gatewayKey,
  PHONE_TRUNK_ID: "test-trunk",
  PHONE_SIP_ADDRESS: "sips:join@phone.example.test",
  LIVEKIT_API_KEY: "phone-test-key",
  LIVEKIT_API_SECRET: "phone-test-livekit-key-over-32-characters",
};
class TestMedia extends LiveMedia {
  removed: string[] = [];
  failRemove = false;
  override async remove(_m: Meeting, p: Participant) {
    if (this.failRemove) throw new Error("simulated SFU failure");
    this.removed.push(p.id);
  }
  override async end(_m: Meeting) {}
}
async function fixture(t: TestContext, extra: Record<string, string> = {}) {
  const config = loadConfig({ ...env, ...extra });
  const store = new MemoryStore();
  const media = new TestMedia(config, store);
  const app = await createApp(config, store, media);
  await app.ready();
  t.after(() => app.close());
  const browser = (method: any, url: string, payload: any = {}, cookie = "") =>
    app.inject({
      method,
      url,
      payload: method === "GET" ? undefined : payload,
      headers: { origin, "x-requested-with": "MeetingPlatform", cookie },
    });
  const gateway = (
    url: string,
    payload: object,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method: "POST",
      url,
      payload,
      headers: {
        authorization: `Bearer ${gatewayKey}`,
        "x-requested-with": "CovemeetPhone",
        ...headers,
      },
    });
  async function host(mode = "meeting") {
    const created = await browser("POST", "/api/meetings", {
      title: "Phone test",
      hostName: "Host",
      password: "browser-password",
      mode,
      creationKey,
    });
    assert.equal(created.statusCode, 200, created.body);
    const { code, hostToken } = created.json();
    const joined = await browser("POST", `/api/meetings/${code}/host`, {
      token: hostToken,
    });
    const setCookies = joined.headers["set-cookie"];
    const cookie = (
      Array.isArray(setCookies) ? setCookies : [String(setCookies)]
    )
      .map((value) => value.split(";")[0])
      .join("; ");
    const access = await browser(
      "POST",
      `/api/meetings/${code}/phone`,
      {},
      cookie,
    );
    assert.equal(access.statusCode, 200, access.body);
    return {
      code,
      cookie,
      access: access.json(),
      action: (id: string, action: string, extra = {}) =>
        browser(
          "POST",
          `/api/meetings/${code}/participants/${id}/action`,
          { action, ...extra },
          cookie,
        ),
    };
  }
  async function call(
    h: Awaited<ReturnType<typeof host>>,
    callerId = "+15551234567",
    callId = randomUUID(),
  ) {
    const response = await gateway("/api/internal/phone/calls", {
      locator: h.access.locator,
      pin: h.access.pin,
      callId,
      trunkId: "test-trunk",
      callerId,
    });
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json();
    const update = (action = "poll", overrides = {}) =>
      gateway(`/api/internal/phone/calls/${h.code}/${data.participantId}`, {
        callId,
        sessionToken: data.sessionToken,
        action,
        ...overrides,
      });
    return { ...data, callId, update };
  }
  return { config, store, media, app, browser, gateway, host, call };
}

test("phone configuration is disabled by default and rejects shared keys or excessive limits", () => {
  assert.equal(loadConfig({ SESSION_SECRET: secret }).phoneEnabled, false);
  for (const override of [
    { PHONE_GATEWAY_KEY: secret },
    { PHONE_GATEWAY_KEY: creationKey },
    { PHONE_TRUNK_ID: "" },
    { PHONE_MAX_CALLS: "21" },
    { PHONE_LOBBY_SECONDS: "301" },
    { PHONE_MAX_DURATION_SECONDS: "7201" },
    { PHONE_SIP_ADDRESS: "" },
  ])
    assert.throws(() => loadConfig({ ...env, ...override }));
});

test("disabled phone configuration still validates a supplied gateway key", () => {
  for (const key of ["short", secret, creationKey, env.LIVEKIT_API_SECRET])
    assert.throws(() =>
      loadConfig({ ...env, PHONE_ENABLED: "false", PHONE_GATEWAY_KEY: key }),
    );
  assert.equal(
    loadConfig({ ...env, PHONE_ENABLED: "false" }).phoneGatewayKey,
    gatewayKey,
  );
  assert.equal(
    loadConfig({ SESSION_SECRET: secret, PHONE_GATEWAY_KEY: "" }).phoneEnabled,
    false,
  );
});

test("disabled phone authentication never accepts an empty or short configured key", async (t) => {
  const f = await fixture(t, {
    PHONE_ENABLED: "false",
    PHONE_GATEWAY_KEY: "",
  });
  for (const key of ["", "short"]) {
    // Also guard against a malformed Config supplied without loadConfig.
    f.config.phoneGatewayKey = key;
    assert.equal(
      (
        await f.gateway(
          "/api/internal/phone/calls",
          {},
          {
            authorization: `Bearer ${key}`,
          },
        )
      ).statusCode,
      403,
    );
  }
});

test("global phone disable terminates authenticated existing actions without releasing reservations", async (t) => {
  const f = await fixture(t),
    h = await f.host();
  const calls = [];
  for (const action of ["poll", "toggle-mute", "toggle-hand"]) {
    const call = await f.call(h);
    assert.equal((await h.action(call.participantId, "admit")).statusCode, 200);
    calls.push({ call, action, grant: (await call.update()).json().grant });
  }
  f.config.phoneEnabled = false;
  assert.equal(
    (await f.browser("POST", `/api/meetings/${h.code}/phone`, {}, h.cookie))
      .statusCode,
    503,
  );
  assert.equal(
    (
      await f.gateway("/api/internal/phone/calls", {
        locator: h.access.locator,
        pin: h.access.pin,
        callId: randomUUID(),
        trunkId: "test-trunk",
      })
    ).statusCode,
    503,
  );
  const first = calls[0]!.call;
  const url = `/api/internal/phone/calls/${h.code}/${first.participantId}`;
  const payload = {
    callId: first.callId,
    sessionToken: first.sessionToken,
    action: "leave",
  };
  for (const headers of [
    { authorization: "Bearer " },
    { authorization: `Bearer ${creationKey}` },
    { origin },
    { "x-requested-with": "MeetingPlatform" },
  ])
    assert.equal((await f.gateway(url, payload, headers)).statusCode, 403);
  assert.equal(
    (await first.update("leave", { sessionToken: "x".repeat(43) })).statusCode,
    403,
  );
  assert.equal(
    (await first.update("leave", { callId: randomUUID() })).statusCode,
    403,
  );
  for (const { call, action, grant } of calls) {
    const response = await call.update(action);
    assert.equal(response.statusCode, 200, response.body);
    const policy = response.json();
    assert.equal(policy.state, "ended");
    assert.equal(policy.leaseExpiresAt, 0);
    assert.equal(policy.grant, undefined);
    assert.equal(policy.muted, true);
    assert.equal(policy.handRaised, false);
    assert.ok(f.media.removed.includes(call.participantId));
    await assert.rejects(f.media.authorize(grant.token));
    assert.equal(f.store.phoneCalls.get(call.callId)!.released, false);
    assert.equal((await call.update("leave")).statusCode, 200);
    assert.equal(f.store.phoneCalls.get(call.callId)!.released, true);
  }
});

test("global phone disable retains capacity when cleanup fails and accepts a later cleanup acknowledgement", async (t) => {
  const f = await fixture(t),
    h = await f.host(),
    call = await f.call(h);
  await h.action(call.participantId, "admit");
  f.config.phoneEnabled = false;
  f.media.failRemove = true;
  assert.equal((await call.update("leave")).statusCode, 503);
  assert.equal(f.store.phoneCalls.get(call.callId)!.released, false);
  const participant = (await f.store.get(h.code))!.participants.find(
    (p) => p.id === call.participantId,
  )!;
  assert.equal(participant.status, "left");
  assert.equal(participant.phone!.leaseExpiresAt, 0);
  assert.equal(participant.enforcementPending, true);
  f.media.failRemove = false;
  const response = await call.update("leave");
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().state, "ended");
  assert.equal(f.store.phoneCalls.get(call.callId)!.released, true);
});

test("phone locator/PIN are host-only independent credentials; public state does not expose authority", async (t) => {
  const f = await fixture(t),
    h = await f.host();
  assert.match(h.code, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  assert.match(h.access.locator, /^\d{12}$/);
  assert.match(h.access.pin, /^\d{8}$/);
  assert.equal(
    (await f.browser("GET", `/api/meetings/${h.code}/phone`)).statusCode,
    401,
  );
  const settings = (
    await f.browser("GET", `/api/meetings/${h.code}/phone`, {}, h.cookie)
  ).json();
  assert.equal(settings.pin, undefined);
  assert.equal(
    (
      await f.browser("POST", `/api/meetings/${h.code}/join`, {
        name: "Guest",
        password: h.access.pin,
      })
    ).statusCode,
    403,
  );
  const c = await f.call(h);
  const stored = (await f.store.get(h.code))!;
  assert.match(stored.phoneAccess!.pinHash, /^\$argon2id\$/);
  assert.equal(JSON.stringify(stored).includes("+15551234567"), false);
  assert.equal(JSON.stringify(stored).includes(c.sessionToken), false);
  const pub = (
    await f.browser("GET", `/api/meetings/${h.code}/state`, {}, h.cookie)
  ).json();
  const participant = pub.participants.find(
    (p: any) => p.id === c.participantId,
  );
  assert.deepEqual(participant.phone, {
    muted: true,
    handRaised: false,
    canBanCallerId: true,
  });
  assert.equal(participant.transport, "phone");
  for (const hidden of [
    "callerHash",
    "callId",
    "sessionToken",
    "tokenHash",
    "trunkId",
  ])
    assert.equal(JSON.stringify(pub).includes(hidden), false);
  const poll = (await c.update()).json();
  assert.equal(poll.state, "waiting");
  assert.equal(poll.grant, undefined);
});

test("gateway authentication, exact trunk and call-session binding cannot be bypassed", async (t) => {
  const f = await fixture(t),
    h = await f.host();
  const body = {
    locator: h.access.locator,
    pin: h.access.pin,
    callId: randomUUID(),
    trunkId: "test-trunk",
  };
  for (const headers of [
    { authorization: `Bearer ${creationKey}` },
    { authorization: "Bearer invalid" },
    { origin },
    { "x-requested-with": "MeetingPlatform" },
  ])
    assert.equal(
      (await f.gateway("/api/internal/phone/calls", body, headers)).statusCode,
      403,
    );
  assert.equal(
    (
      await f.gateway("/api/internal/phone/calls", {
        ...body,
        trunkId: "other",
      })
    ).statusCode,
    403,
  );
  for (const path of [
    "/api/%69nternal/phone/calls",
    "/api//internal/phone/calls",
  ]) {
    const r = await f.gateway(path, body, { authorization: "Bearer invalid" });
    assert.ok(r.statusCode >= 400, r.body);
  }
  const c = await f.call(h);
  assert.equal(
    (await c.update("poll", { callId: randomUUID() })).statusCode,
    403,
  );
  assert.equal(
    (await c.update("poll", { sessionToken: "x".repeat(43) })).statusCode,
    403,
  );
  assert.equal(
    (
      await f.browser(
        "POST",
        `/api/meetings/${h.code}/media`,
        {},
        `mp_${h.code}=${c.sessionToken}`,
      )
    ).statusCode,
    403,
  );
});

test("admission, mute and host permission changes bind real media grants to current lease and version", async (t) => {
  const f = await fixture(t),
    h = await f.host(),
    c = await f.call(h);
  assert.equal((await h.action(c.participantId, "admit")).statusCode, 200);
  const admitted = (await c.update()).json();
  assert.equal(admitted.state, "admitted");
  assert.equal(admitted.muted, true);
  assert.equal(admitted.grant.cookie, `mp_${h.code}=${c.sessionToken}`);
  assert.equal(
    (await f.media.verifier.verify(admitted.grant.token)).video?.canPublish,
    false,
  );
  assert.ok(admitted.grant.subscribeParticipantIds.length === 1);
  const speaking = (await c.update("toggle-mute")).json();
  assert.deepEqual(
    (await f.media.verifier.verify(speaking.grant.token)).video
      ?.canPublishSources,
    ["microphone"],
  );
  await h.action(c.participantId, "block-audio");
  await assert.rejects(f.media.authorize(speaking.grant.token));
  const blocked = (await c.update("toggle-mute")).json();
  assert.equal(blocked.audioAllowed, false);
  assert.equal(blocked.muted, true);
  await h.action(c.participantId, "allow-audio");
  assert.equal((await c.update()).json().muted, true);
  assert.equal(
    (await h.action(c.participantId, "allow-video")).statusCode,
    400,
  );
  assert.equal(
    (await h.action(c.participantId, "rename", { name: "Reception" }))
      .statusCode,
    200,
  );
  const current = await f.store.get(h.code);
  assert.equal(
    current!.participants.find((p) => p.id === c.participantId)!.name,
    "Reception",
  );
  await f.store.change(h.code, (m) => {
    m.participants.find(
      (p) => p.id === c.participantId,
    )!.phone!.leaseExpiresAt = Date.now() - 1;
  });
  await assert.rejects(
    f.media.authorize(
      (await c.update()).json().grant?.token ?? admitted.grant.token,
    ),
  );
  assert.equal((await c.update()).json().state, "ended");
});

test("meeting lock blocks pending/new phone admission but permits existing admitted call polling", async (t) => {
  const f = await fixture(t),
    h = await f.host(),
    existing = await f.call(h),
    waiting = await f.call(h, "+15551234568");
  await h.action(existing.participantId, "admit");
  await f.browser(
    "PATCH",
    `/api/meetings/${h.code}`,
    { locked: true },
    h.cookie,
  );
  assert.equal(
    (await h.action(waiting.participantId, "admit")).statusCode,
    403,
  );
  assert.equal((await existing.update()).json().state, "admitted");
  const denied = await f.gateway("/api/internal/phone/calls", {
    locator: h.access.locator,
    pin: h.access.pin,
    callId: randomUUID(),
    trunkId: "test-trunk",
  });
  assert.equal(denied.statusCode, 403);
  await f.browser("POST", `/api/meetings/${h.code}/end`, {}, h.cookie);
  assert.equal((await existing.update()).json().state, "ended");
});

test("caller ban survives redial; kick permits a fresh lobby session without banning shared gateway", async (t) => {
  const f = await fixture(t),
    h = await f.host(),
    c = await f.call(h);
  assert.equal(
    (await h.action(c.participantId, "ban", { banIp: true })).statusCode,
    400,
  );
  await h.action(c.participantId, "kick");
  await c.update("leave");
  const redial = await f.call(h);
  await h.action(redial.participantId, "ban", { banCallerId: true });
  await redial.update("leave");
  assert.equal(
    (
      await f.gateway("/api/internal/phone/calls", {
        locator: h.access.locator,
        pin: h.access.pin,
        callId: randomUUID(),
        trunkId: "test-trunk",
        callerId: "+15551234567",
      })
    ).statusCode,
    403,
  );
  await f.call(h, "+15551234568");
  const m = (await f.store.get(h.code))!;
  assert.deepEqual(m.bans.ip, []);
  assert.deepEqual(m.bans.device, []);
  assert.equal(m.bans.caller?.length, 1);
});

test("installation cap is atomic across meetings and reservations survive kick/expiry until cleanup acknowledgement", async (t) => {
  const f = await fixture(t, { PHONE_MAX_CALLS: "2" }),
    a = await f.host(),
    b = await f.host();
  const payload = (h: typeof a) => ({
    locator: h.access.locator,
    pin: h.access.pin,
    callId: randomUUID(),
    trunkId: "test-trunk",
  });
  const requests = [payload(a), payload(b), payload(a)];
  const results = await Promise.all(
    requests.map((body) => f.gateway("/api/internal/phone/calls", body)),
  );
  assert.equal(results.filter((r) => r.statusCode === 200).length, 2);
  assert.equal(results.filter((r) => r.statusCode === 409).length, 1);
  const n = results.findIndex((r) => r.statusCode === 200),
    c = results[n]!.json(),
    h = c.code === a.code ? a : b;
  await h.action(c.participantId, "kick");
  assert.equal(
    (await f.gateway("/api/internal/phone/calls", payload(b))).statusCode,
    409,
  );
  const leave = () =>
    f.gateway(`/api/internal/phone/calls/${h.code}/${c.participantId}`, {
      callId: requests[n]!.callId,
      sessionToken: c.sessionToken,
      action: "leave",
    });
  assert.equal((await leave()).statusCode, 200);
  assert.equal((await leave()).statusCode, 200);
  assert.equal(
    (
      await f.gateway("/api/internal/phone/calls", {
        ...payload(b),
        callId: requests[n]!.callId,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await f.gateway("/api/internal/phone/calls", payload(b))).statusCode,
    200,
  );
});

test("webinar phones are listeners, promote stays audio-only, and phone moves are rejected", async (t) => {
  const f = await fixture(t),
    h = await f.host("webinar"),
    c = await f.call(h);
  await h.action(c.participantId, "admit");
  assert.equal((await c.update("toggle-mute")).json().audioAllowed, false);
  await h.action(c.participantId, "promote");
  const promoted = (await c.update()).json();
  assert.equal(promoted.audioAllowed, true);
  assert.equal(promoted.muted, true);
  assert.equal(
    (await f.store.get(h.code))!.participants.find(
      (p) => p.id === c.participantId,
    )!.videoAllowed,
    false,
  );
  assert.equal(
    (
      await f.browser(
        "POST",
        `/api/meetings/${h.code}/move`,
        { participantId: c.participantId, breakoutId: null },
        h.cookie,
      )
    ).statusCode,
    409,
  );
});

test("credential rotation and disable revoke calls; leave cannot free capacity when media cleanup fails", async (t) => {
  const f = await fixture(t, { PHONE_MAX_CALLS: "1" }),
    h = await f.host(),
    c = await f.call(h);
  const next = await f.browser(
    "POST",
    `/api/meetings/${h.code}/phone`,
    {},
    h.cookie,
  );
  assert.equal(next.statusCode, 200);
  assert.notEqual(next.json().locator, h.access.locator);
  assert.equal((await c.update()).json().state, "ended");
  await c.update("leave");
  h.access = next.json();
  const second = await f.call(h);
  f.media.failRemove = true;
  assert.equal((await second.update("leave")).statusCode, 503);
  assert.equal(f.store.phoneCalls.get(second.callId)!.released, false);
  f.media.failRemove = false;
  await second.update("leave");
  await f.browser("DELETE", `/api/meetings/${h.code}/phone`, {}, h.cookie);
  assert.equal(
    (
      await f.browser("GET", `/api/meetings/${h.code}/phone`, {}, h.cookie)
    ).json().enabled,
    false,
  );
});

test("PIN attempt caps persist in shared store; active recording rejects new callers", async (t) => {
  const f = await fixture(t),
    h = await f.host();
  const bad = h.access.pin === "00000000" ? "00000001" : "00000000";
  for (let n = 0; n < 10; n++)
    assert.equal(
      (
        await f.gateway("/api/internal/phone/calls", {
          locator: h.access.locator,
          pin: bad,
          callId: randomUUID(),
          trunkId: "test-trunk",
        })
      ).statusCode,
      403,
    );
  assert.equal(
    (
      await f.gateway("/api/internal/phone/calls", {
        locator: h.access.locator,
        pin: h.access.pin,
        callId: randomUUID(),
        trunkId: "test-trunk",
      })
    ).statusCode,
    429,
  );
  const other = await f.host();
  await f.store.change(other.code, (m) => {
    m.recordings.push({
      id: "test-recording",
      status: "recording",
      createdAt: Date.now(),
    });
  });
  assert.equal(
    (
      await f.gateway("/api/internal/phone/calls", {
        locator: other.access.locator,
        pin: other.access.pin,
        callId: randomUUID(),
        trunkId: "test-trunk",
      })
    ).statusCode,
    403,
  );
});

test("RecordingService itself blocks a waiting phone before starting an Egress job", async (t) => {
  const f = await fixture(t),
    h = await f.host();
  await f.call(h);
  await f.store.change(h.code, (m) => {
    m.recordingAllowed = true;
    m.hostEmailVerified = true;
  });
  // Exercise the service entry directly with a harmless fake recorder and directory gate.
  let starts = 0;
  const service = Object.create(RecordingService.prototype) as RecordingService;
  Object.defineProperty(service, "available", { value: true });
  Object.assign(service, {
    config: f.config,
    store: f.store,
    directories: async () => {},
    client: {
      startRoomCompositeEgress: async () => {
        starts++;
        throw new Error("must not start");
      },
    },
  });
  await assert.rejects(
    service.start((await f.store.get(h.code))!),
    /phone calls are active/,
  );
  assert.equal(starts, 0);
  assert.equal((await f.store.get(h.code))!.recordings.length, 0);
});

test("lobby and admitted deadlines are bounded, and timed-out calls cannot renew their lease", async (t) => {
  const f = await fixture(t),
    h = await f.host(),
    start = Date.now(),
    c = await f.call(h);
  assert.ok(
    c.expiresAt <= start + 301_000,
    "Phone lobby must expire within the configured300 seconds",
  );
  await h.action(c.participantId, "admit");
  const live = (await c.update()).json();
  assert.ok(
    live.expiresAt <= start + 7_201_000,
    "Phone call must not exceed the configured7200-second duration",
  );
  assert.ok(live.expiresAt > start + 7_100_000);
  assert.ok(live.leaseExpiresAt <= Date.now() + 10_000);
  await f.store.change(h.code, (m) => {
    m.participants.find((p) => p.id === c.participantId)!.expiresAt =
      Date.now() - 1;
  });
  assert.equal((await c.update()).json().state, "ended");
  assert.equal(
    f.store.phoneCalls.get(c.callId)!.released,
    false,
    "Expired leases must retain the installation-wide call reservation until cleanup is acknowledged",
  );
});

test("browser and phone callers share the meeting limit and webinar stage limit", async (t) => {
  const f = await fixture(t),
    h = await f.host();
  await f.store.change(h.code, (m) => {
    const host = m.participants[0]!;
    for (let n = 0; n < 99; n++)
      m.participants.push({
        ...host,
        id: randomUUID(),
        role: "participant",
        status: "waiting",
        tokenHash: `reserved-${n}`,
      });
  });
  const full = await f.gateway("/api/internal/phone/calls", {
    locator: h.access.locator,
    pin: h.access.pin,
    callId: randomUUID(),
    trunkId: "test-trunk",
  });
  assert.equal(
    full.statusCode,
    409,
    "Waiting and admitted browser participants reserve the same100 meeting seats used by phone callers",
  );
  const webinar = await f.host("webinar"),
    c = await f.call(webinar);
  await webinar.action(c.participantId, "admit");
  await f.store.change(webinar.code, (m) => {
    const host = m.participants[0]!;
    for (let n = 0; n < 9; n++)
      m.participants.push({
        ...host,
        id: randomUUID(),
        role: "participant",
        tokenHash: `presenter-${n}`,
      });
  });
  assert.equal(
    (await webinar.action(c.participantId, "promote")).statusCode,
    409,
    "Phone promotion must respect the10-presenter webinar limit including the host",
  );
});

test("relay subscription roster excludes pending removals and expired phone leases", async (t) => {
  const f = await fixture(t),
    h = await f.host(),
    a = await f.call(h),
    b = await f.call(h, "+15551234568");
  await h.action(a.participantId, "admit");
  await h.action(b.participantId, "admit");
  await f.store.change(h.code, (m) => {
    m.participants[0]!.enforcementPending = true;
    m.participants.find(
      (p) => p.id === b.participantId,
    )!.phone!.leaseExpiresAt = Date.now() - 1;
  });
  assert.deepEqual((await a.update()).json().grant.subscribeParticipantIds, []);
});

test("phone attempt counters are bounded by expired minute-bucket cleanup", async () => {
  const store = new MemoryStore(),
    now = Date.now();
  await store.phoneAttempt("old-test-counter", 10, now - 4 * 60_000);
  await store.phoneAttempt("current-test-counter", 10, now);
  assert.equal(store.phoneAttempts.has("old-test-counter"), false);
  assert.equal(store.phoneAttempts.size, 1);
});

test("runtime phone admission requires durable ownership outside isolated test mode", async (t) => {
  const f = await fixture(t, { NODE_ENV: "development" }),
    h = await f.host();
  const response = await f.gateway("/api/internal/phone/calls", {
    locator: h.access.locator,
    pin: h.access.pin,
    callId: randomUUID(),
    trunkId: "test-trunk",
  });
  assert.equal(response.statusCode, 403);
  assert.equal(
    (await f.store.get(h.code))!.participants.filter(
      (p) => p.transport === "phone",
    ).length,
    0,
  );
});

test("phone and browser admission enforce the same1000-viewer cap below the total webinar cap", async (t) => {
  const f = await fixture(t),
    h = await f.host("webinar");
  await f.store.change(h.code, (m) => {
    for (let i = 0; i < 1000; i++)
      m.participants.push({
        ...m.participants[0]!,
        id: randomUUID(),
        role: "viewer",
        status: "waiting",
        tokenHash: "",
      });
  });
  const phoneJoin = () =>
    f.gateway("/api/internal/phone/calls", {
      locator: h.access.locator,
      pin: h.access.pin,
      callId: randomUUID(),
      trunkId: "test-trunk",
    });
  const browserJoin = () =>
    f.browser("POST", `/api/meetings/${h.code}/join`, {
      name: "Extra viewer",
      password: "browser-password",
    });
  assert.equal((await phoneJoin()).statusCode, 409);
  assert.equal((await browserJoin()).statusCode, 409);
  await f.store.change(h.code, (m) => {
    const p = m.participants.at(-1)!;
    p.status = "left";
    p.enforcementPending = true;
  });
  assert.equal(
    (await phoneJoin()).statusCode,
    409,
    "Unconfirmed removal still occupies its viewer place",
  );
  await f.store.change(h.code, (m) => {
    m.participants.at(-1)!.enforcementPending = false;
  });
  assert.equal((await phoneJoin()).statusCode, 200);
  assert.equal((await browserJoin()).statusCode, 409);
});

test("ending with an unresolved phone reservation returns pending until verified teardown", async (t) => {
  const f = await fixture(t),
    h = await f.host(),
    call = await f.call(h);
  const ending = await f.browser(
    "POST",
    `/api/meetings/${h.code}/end`,
    {},
    h.cookie,
  );
  assert.equal(ending.statusCode, 202);
  assert.deepEqual(ending.json(), { ok: true, cleanupPending: true });
  const state = await f.browser(
    "GET",
    `/api/meetings/${h.code}/state`,
    undefined,
    h.cookie,
  );
  assert.equal(state.json().meeting.ended, true);
  assert.equal(state.json().meeting.cleanupPending, true);
  assert.equal((await call.update("leave")).statusCode, 200);
  const completed = await f.browser(
    "POST",
    `/api/meetings/${h.code}/end`,
    {},
    h.cookie,
  );
  assert.equal(completed.statusCode, 200);
  assert.deepEqual(completed.json(), { ok: true, cleanupPending: false });
});

test("legacy pending phone cleanup returns the migrated grant and physical subscription roster", async (t) => {
  const f = await fixture(t),
    h = await f.host(),
    c = await f.call(h);
  assert.equal((await h.action(c.participantId, "admit")).statusCode, 200);
  const old = (await c.update()).json();
  const snapshot = await f.store.change(h.code, (m) => {
    const host = m.participants.find((p) => p.role === "host")!;
    fenceParticipantMedia(m, host);
    completeMediaFence(host, structuredClone(host));
    const phone = m.participants.find((p) => p.id === c.participantId)!;
    phone.mediaVersion++;
    phone.enforcementPending = true;
    phone.previousRoom = m.room;
    return structuredClone(m);
  });
  const response = await c.update();
  assert.equal(response.statusCode, 200, response.body);
  const policy = response.json();
  assert.equal(policy.state, "admitted");
  assert.notEqual(policy.mediaIdentity, c.participantId);
  assert.equal(policy.mediaVersion, old.mediaVersion + 2);
  assert.equal(
    (await f.media.verifier.verify(policy.grant.token)).sub,
    policy.mediaIdentity,
  );
  assert.equal(
    (await f.media.authorize(policy.grant.token)).p.id,
    c.participantId,
  );
  assert.deepEqual(policy.grant.subscribeParticipantIds, [
    mediaIdentity(snapshot.participants.find((p) => p.role === "host")!),
  ]);
  await assert.rejects(f.media.authorize(old.grant.token));
  const publicState = (
    await f.browser("GET", `/api/meetings/${h.code}/state`, {}, h.cookie)
  ).json();
  assert.equal(
    publicState.me.mediaIdentity,
    policy.grant.subscribeParticipantIds[0],
  );
  assert.equal(
    publicState.participants.find((p: Participant) => p.id === c.participantId)
      .mediaIdentity,
    policy.mediaIdentity,
  );
});
