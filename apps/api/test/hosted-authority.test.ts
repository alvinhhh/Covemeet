import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { LiveMedia } from "../src/media.js";
import { MemoryStore, type Meeting, type Participant } from "../src/store.js";
import { RecordingService } from "../src/recordings.js";

const origin = "http://localhost:5173";
const creationKey = "hosted-authority-creation-key-at-least-32-chars";
const gatewayKey = "hosted-authority-phone-key-at-least-32-chars";
const settings = {
  title: "Owned meeting",
  hostName: "Host",
  password: "meeting-password",
  mode: "meeting",
};
const machineHeaders = {
  "x-requested-with": "MeetingPlatformHosted",
  authorization: `Bearer ${creationKey}`,
};
class TestMedia extends LiveMedia {
  ended: string[] = [];
  failEnd = false;
  override async end(m: Meeting) {
    this.ended.push(m.code);
    if (this.failEnd) throw new Error("SFU unavailable");
  }
  override async remove(_m: Meeting, _p: Participant) {}
}
async function fixture(
  t: TestContext,
  edition = "hosted",
  portalOrigin?: string,
) {
  const config = loadConfig({
    NODE_ENV: "test",
    EDITION: edition,
    SITE_ORIGIN: origin,
    SESSION_SECRET: "hosted-authority-session-secret-at-least-32-chars",
    CREATION_KEY: creationKey,
    LIVEKIT_API_KEY: "test-key",
    LIVEKIT_API_SECRET: "hosted-authority-media-key-at-least-32-chars",
    PHONE_ENABLED: "true",
    PHONE_GATEWAY_KEY: gatewayKey,
    PHONE_TRUNK_ID: "fixture",
    PHONE_SIP_ADDRESS: "sips:join@phone.example.test",
    RECORDING_ENABLED: "false",
    ...(portalOrigin ? { PORTAL_ORIGIN: portalOrigin } : {}),
  });
  t.mock.timers.enable({ apis: ["setInterval"] });
  const store = new MemoryStore();
  const media = new TestMedia(config, store);
  const app = await createApp(config, store, media);
  t.after(() => app.close());
  const accountId = randomUUID();
  const input = {
    accountId,
    version: 1,
    operationId: randomUUID(),
    meeting: settings,
  };
  const internal = (
    path: string,
    payload: object,
    headers: Record<string, string> = machineHeaders,
  ) =>
    app.inject({
      method: "POST",
      url: `/api/internal/hosted/${path}`,
      headers,
      payload,
    });
  const create = (changes = {}) =>
    internal("meetings", { ...input, ...changes });
  async function tick() {
    t.mock.timers.tick(5000);
    // MemoryStore and fake media settle through promise continuations in this turn.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  async function authority(version: number, enabled: boolean, extra = {}) {
    const body = { accountId, version, enabled, ...extra };
    let response = await internal("authority", body);
    if (response.statusCode === 202) {
      await tick();
      response = await internal("authority", body);
    }
    return response;
  }
  const browser = (path: string, payload?: object, cookie = "") =>
    app.inject({
      method: payload ? "POST" : "GET",
      url: path,
      headers: { origin, "x-requested-with": "MeetingPlatform", cookie },
      ...(payload ? { payload } : {}),
    });
  async function exchange(code: string, hostToken: string) {
    const response = await browser(`/api/meetings/${code}/host`, {
      token: hostToken,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  }
  const gateway = (path: string, payload: object) =>
    app.inject({
      method: "POST",
      url: `/api/internal/phone/${path}`,
      headers: {
        "x-requested-with": "CovemeetPhone",
        authorization: `Bearer ${gatewayKey}`,
      },
      payload,
    });
  return {
    config,
    store,
    media,
    app,
    accountId,
    input,
    internal,
    create,
    authority,
    browser,
    exchange,
    gateway,
    tick,
  };
}

test("hosted internal mutations require the exact server credential and reject browser/cookie authority", async (t) => {
  const f = await fixture(t);
  for (const headers of [
    {},
    { ...machineHeaders, origin },
    { ...machineHeaders, origin: "" },
    {
      "x-requested-with": "MeetingPlatform",
      authorization: `Bearer ${creationKey}`,
    },
    {
      ...machineHeaders,
      authorization: "Bearer wrong",
      cookie: "mp_admin=irrelevant",
    },
  ]) {
    assert.equal(
      (await f.internal("meetings", f.input, headers)).statusCode,
      403,
    );
    assert.equal(
      (
        await f.internal(
          "authority",
          { accountId: f.accountId, version: 1, enabled: false },
          headers,
        )
      ).statusCode,
      403,
    );
  }
  assert.equal(
    (await f.create({ version: Number.MAX_SAFE_INTEGER + 1 })).statusCode,
    400,
  );
  assert.equal(
    (await f.create({ meeting: { ...settings, accountId: f.accountId } }))
      .statusCode,
    400,
  );
  assert.equal((await f.store.all()).length, 0);
});

test("concurrent creation retries bind one operation and return only its original unused capability", async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all([f.create(), f.create()]);
  for (const response of responses)
    assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(responses[0].json(), responses[1].json());
  const created = responses[0].json();
  assert.equal((await f.store.all()).length, 1);
  const stored = (await f.store.get(created.code))!;
  assert.equal(stored.hosted?.accountId, f.accountId);
  assert.ok(!JSON.stringify(stored).includes(created.hostToken));
  assert.ok(!JSON.stringify(stored).includes(settings.password));
  assert.equal(
    (await f.create({ meeting: { ...settings, title: "Changed" } })).statusCode,
    409,
  );
  const upper = await f.create({
    accountId: f.accountId.toUpperCase(),
    operationId: f.input.operationId.toUpperCase(),
  });
  assert.deepEqual(upper.json(), created);
  assert.equal(
    f.store.auditEvents.filter(
      (e) => e.code === created.code && e.action === "meeting.create",
    ).length,
    1,
  );
  assert.ok(!JSON.stringify(f.store.auditEvents).includes(created.hostToken));
  await f.exchange(created.code, created.hostToken);
  const consumed = await f.create();
  assert.equal(consumed.statusCode, 409);
  assert.equal(consumed.json().code, "MEETING_OPERATION_UNAVAILABLE");
  assert.equal(
    (
      await f.browser(`/api/meetings/${created.code}/host`, {
        token: created.hostToken,
      })
    ).statusCode,
    403,
  );
});

test("expired and ended invitations cannot be reissued through a create retry", async (t) => {
  const f = await fixture(t);
  const first = (await f.create()).json();
  await f.store.change(first.code, (m) => {
    m.hostTokenExpiresAt = Date.now() - 1;
  });
  assert.equal((await f.create()).statusCode, 409);
  const operationId = randomUUID();
  const second = (await f.create({ operationId })).json();
  await f.store.change(second.code, (m) => {
    m.ended = true;
  });
  assert.equal((await f.create({ operationId })).statusCode, 409);
});

test("monotonic authority blocks stale/newer creation and never revives old invitations on reapproval", async (t) => {
  const f = await fixture(t);
  const first = (await f.create()).json();
  assert.equal((await f.authority(2, false)).statusCode, 200);
  assert.equal((await f.create()).statusCode, 409);
  assert.equal(
    (await f.create({ version: 3, operationId: randomUUID() })).statusCode,
    409,
  );
  const stale = await f.authority(1, true);
  assert.deepEqual(stale.json(), {
    ok: true,
    version: 2,
    cleanupPending: false,
  });
  assert.equal((await f.authority(2, true)).statusCode, 409);
  assert.equal((await f.authority(3, true)).statusCode, 200);
  assert.equal(
    (
      await f.browser(`/api/meetings/${first.code}/host`, {
        token: first.hostToken,
      })
    ).statusCode,
    410,
  );
  assert.equal(
    (await f.create({ version: 3, operationId: randomUUID() })).statusCode,
    200,
  );
  const another = randomUUID();
  assert.equal(
    (
      await f.internal("authority", {
        accountId: another,
        version: 2,
        enabled: false,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.create({ accountId: another, operationId: randomUUID() }))
      .statusCode,
    409,
  );
});

test("revocation invalidates exchanged host/guest cookies, signed media and recording credentials", async (t) => {
  const f = await fixture(t);
  const created = (await f.create()).json();
  const host = await f.exchange(created.code, created.hostToken);
  const joined = await f.browser(`/api/meetings/${created.code}/join`, {
    name: "Guest",
    password: settings.password,
  });
  const guest = joined.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  const guestId = joined.json().participantId;
  assert.equal(
    (
      await f.browser(
        `/api/meetings/${created.code}/participants/${guestId}/action`,
        { action: "admit" },
        host,
      )
    ).statusCode,
    200,
  );
  const issued = await f.browser(
    `/api/meetings/${created.code}/media`,
    {},
    guest,
  );
  assert.equal(issued.statusCode, 200, issued.body);
  await f.media.authorize(issued.json().token);
  await f.store.change(created.code, (m) =>
    m.recordings.push({
      id: randomUUID(),
      status: "ready",
      createdAt: Date.now(),
      tokenHash: "issued",
      passwordHash: "issued",
      expiresAt: Date.now() + 60000,
    }),
  );
  assert.equal((await f.authority(2, false)).statusCode, 200);
  for (const cookie of [host, guest]) {
    assert.equal(
      (
        await f.browser(
          `/api/meetings/${created.code}/state`,
          undefined,
          cookie,
        )
      ).statusCode,
      401,
    );
    assert.equal(
      (await f.browser(`/api/meetings/${created.code}/media`, {}, cookie))
        .statusCode,
      410,
    );
  }
  assert.equal(
    (await f.browser(`/api/meetings/${created.code}/recordings`, {}, host))
      .statusCode,
    410,
  );
  assert.equal(
    (
      await f.browser(
        `/api/meetings/${created.code}/download`,
        { token: "old", password: "old" },
        host,
      )
    ).statusCode,
    401,
  );
  await assert.rejects(f.media.authorize(issued.json().token));
  const m = (await f.store.get(created.code))!;
  assert.ok(m.participants.every((p) => !p.tokenHash && p.status === "left"));
  assert.ok(!m.recordings[0].tokenHash && !m.recordings[0].passwordHash);
  assert.ok(f.media.ended.includes(created.code));
  const service = new RecordingService(f.config, f.store, {} as never);
  assert.equal(await service.findToken("old", created.code), null);
});

test("authority returns durable pending status before any remote cleanup", async (t) => {
  const f = await fixture(t);
  const created = (await f.create()).json();
  const response = await f.internal("authority", {
    accountId: f.accountId,
    version: 2,
    enabled: false,
  });
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), {
    ok: true,
    version: 2,
    cleanupPending: true,
  });
  assert.equal((await f.store.get(created.code))!.ended, true);
  assert.equal(f.media.ended.length, 0);
  await f.tick();
  const completed = await f.internal("authority", {
    accountId: f.accountId,
    version: 2,
    enabled: false,
  });
  assert.equal(completed.statusCode, 200);
  assert.equal(completed.json().cleanupPending, false);
});

test("cleanup failure preserves revocation and identical/stale authority deliveries retry cleanup", async (t) => {
  const f = await fixture(t);
  const created = (await f.create()).json();
  f.media.failEnd = true;
  assert.equal((await f.authority(2, false)).statusCode, 202);
  assert.equal((await f.store.get(created.code))!.ended, true);
  assert.equal((await f.create()).statusCode, 409);
  f.media.failEnd = false;
  const retried = await f.authority(1, true);
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().version, 2);
  assert.equal(f.media.ended.filter((c) => c === created.code).length, 2);
  const before = (await f.store.get(created.code))!.revision;
  assert.equal((await f.authority(2, false)).statusCode, 200);
  assert.equal((await f.store.get(created.code))!.revision, before);
  assert.equal(f.media.ended.filter((c) => c === created.code).length, 2);
  assert.equal(
    f.store.auditEvents.filter(
      (e) => e.code === created.code && e.action === "hosted.revoke",
    ).length,
    1,
  );
});

test("missing media control cannot acknowledge remote cleanup", async (t) => {
  const f = await fixture(t);
  const created = (await f.create()).json();
  f.media.available = false;
  assert.equal((await f.authority(2, false)).statusCode, 202);
  assert.ok(
    (await f.store.get(created.code))!.participants[0].enforcementPending,
  );
  assert.equal(f.media.ended.length, 0);
  f.media.available = true;
  assert.equal((await f.authority(2, false)).statusCode, 200);
});

test("a busy recording owner prevents cleanup acknowledgment until its job is terminal", async (t) => {
  const f = await fixture(t);
  const created = (await f.create()).json();
  const id = randomUUID();
  await f.store.change(created.code, (m) =>
    m.recordings.push({
      id,
      status: "recording",
      createdAt: Date.now(),
      egressId: "owned-test-job",
    }),
  );
  await f.store.withRecordingLock(created.code, id, async () => {
    assert.equal((await f.authority(2, false)).statusCode, 202);
    assert.equal(
      (await f.store.get(created.code))!.recordings[0].status,
      "stopping",
    );
  });
  await f.store.change(created.code, (m) => {
    m.recordings[0].status = "failed";
  });
  assert.equal((await f.authority(2, false)).statusCode, 200);
});

test("legacy batches bind only unowned meetings and reject another account atomically", async (t) => {
  const f = await fixture(t);
  const legacy = async () =>
    (await f.browser("/api/meetings", { ...settings, creationKey })).json();
  const one = await legacy(),
    two = await legacy();
  assert.equal(
    (await f.authority(1, true, { legacyCodes: [one.code] })).statusCode,
    200,
  );
  assert.equal(
    (await f.authority(1, true, { legacyCodes: [two.code] })).statusCode,
    200,
  );
  for (const code of [one.code, two.code])
    assert.deepEqual((await f.store.get(code))!.hosted, {
      accountId: f.accountId,
      version: 0,
      revoked: true,
      cleanupConfirmed: true,
    });
  const current = (await f.create()).json();
  assert.equal(
    (await f.authority(1, true, { legacyCodes: [current.code] })).statusCode,
    200,
  );
  assert.equal((await f.store.get(current.code))!.ended, false);
  const foreign = (
    await f.create({ accountId: randomUUID(), operationId: randomUUID() })
  ).json();
  const three = await legacy();
  assert.equal(
    (await f.authority(2, false, { legacyCodes: [three.code, foreign.code] }))
      .statusCode,
    409,
  );
  assert.equal((await f.store.get(three.code))!.ended, false);
  assert.equal((await f.store.get(foreign.code))!.ended, false);
  assert.equal(f.store.hostedAuthorities.get(f.accountId)!.version, 1);
});

test("revoked phone credentials permit ended heartbeat and teardown only, retaining capacity until leave", async (t) => {
  const f = await fixture(t);
  const created = (await f.create()).json();
  const host = await f.exchange(created.code, created.hostToken);
  const access = (
    await f.browser(`/api/meetings/${created.code}/phone`, {}, host)
  ).json();
  const callId = randomUUID();
  const called = await f.gateway("calls", {
    locator: access.locator,
    pin: access.pin,
    callId,
    trunkId: "fixture",
  });
  assert.equal(called.statusCode, 200, called.body);
  const call = called.json();
  const path = `calls/${created.code}/${call.participantId}`;
  assert.equal((await f.authority(2, false)).statusCode, 202);
  assert.equal(await f.store.hasPhoneReservations(created.code), true);
  const laterLegacy = (
    await f.browser("/api/meetings", { ...settings, creationKey })
  ).json();
  const nextBatch = await f.authority(2, false, {
    legacyCodes: [laterLegacy.code],
  });
  assert.equal(nextBatch.statusCode, 202);
  assert.equal(nextBatch.json().cleanupPending, true);
  assert.equal((await f.store.get(laterLegacy.code))!.ended, true);
  for (const action of ["poll", "toggle-mute", "toggle-hand"]) {
    const response = await f.gateway(path, {
      callId,
      sessionToken: call.sessionToken,
      action,
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().state, "ended");
    assert.equal(response.json().grant, undefined);
  }
  assert.equal(
    (
      await f.gateway(path, {
        callId: randomUUID(),
        sessionToken: call.sessionToken,
        action: "leave",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.gateway(path, {
        callId,
        sessionToken: "incorrect-token-at-least-32-characters",
        action: "leave",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.browser(
        `/api/meetings/${created.code}/state`,
        undefined,
        `mp_${created.code}=${call.sessionToken}`,
      )
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await f.gateway("calls", {
        locator: access.locator,
        pin: access.pin,
        callId: randomUUID(),
        trunkId: "fixture",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.gateway(path, {
        callId,
        sessionToken: call.sessionToken,
        action: "leave",
      })
    ).statusCode,
    200,
  );
  assert.equal(await f.store.hasPhoneReservations(created.code), false);
  assert.equal((await f.authority(2, false)).statusCode, 200);
});

test("self-hosted creation is unchanged and cannot invoke hosted authority interfaces", async (t) => {
  const f = await fixture(t, "self-hosted");
  assert.equal((await f.create()).statusCode, 403);
  assert.equal((await f.authority(1, true)).statusCode, 403);
  const created = await f.browser("/api/meetings", {
    ...settings,
    creationKey,
    customCode: "SELFHOSTEDTEST",
  });
  assert.equal(created.statusCode, 200, created.body);
  assert.equal(created.json().code, "SELFHOSTEDTEST");
  await f.exchange(created.json().code, created.json().hostToken);
  assert.equal((await f.store.get("SELFHOSTEDTEST"))!.hosted, undefined);
});

test("encoded hosted internal paths still require machine credentials despite a valid host cookie", async (t) => {
  const f = await fixture(t);
  const created = (await f.create()).json();
  const cookie = await f.exchange(created.code, created.hostToken);
  const headers = { origin, "x-requested-with": "MeetingPlatform", cookie };
  for (const prefix of [
    "/%61pi/internal/hosted",
    "/api/%69nternal/hosted",
    "/api/internal/%68osted",
  ]) {
    const deniedCreate = await f.app.inject({
      method: "POST",
      url: `${prefix}/meetings`,
      headers,
      payload: { ...f.input, operationId: randomUUID() },
    });
    assert.equal(deniedCreate.statusCode, 403, deniedCreate.body);
    const deniedRevoke = await f.app.inject({
      method: "POST",
      url: `${prefix}/authority`,
      headers,
      payload: { accountId: f.accountId, version: 2, enabled: false },
    });
    assert.equal(deniedRevoke.statusCode, 403, deniedRevoke.body);
  }
  assert.equal((await f.store.get(created.code))!.ended, false);
  const accepted = await f.app.inject({
    method: "POST",
    url: "/%61pi/internal/hosted/meetings",
    headers: machineHeaders,
    payload: { ...f.input, operationId: randomUUID() },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
});

test("encoded phone internal paths cannot replace gateway authentication with browser headers", async (t) => {
  const f = await fixture(t);
  const created = (await f.create()).json();
  const cookie = await f.exchange(created.code, created.hostToken);
  const access = (
    await f.browser(`/api/meetings/${created.code}/phone`, {}, cookie)
  ).json();
  const payload = {
    locator: access.locator,
    pin: access.pin,
    callId: randomUUID(),
    trunkId: "fixture",
  };
  for (const url of [
    "/%61pi/internal/phone/calls",
    "/api/%69nternal/phone/calls",
    "/api/internal/%70hone/calls",
  ]) {
    const response = await f.app.inject({
      method: "POST",
      url,
      headers: { origin, "x-requested-with": "MeetingPlatform", cookie },
      payload,
    });
    assert.equal(response.statusCode, 403, response.body);
  }
  assert.equal(await f.store.hasPhoneReservations(created.code), false);
  const accepted = await f.app.inject({
    method: "POST",
    url: "/%61pi/internal/phone/calls",
    headers: {
      authorization: `Bearer ${gatewayKey}`,
      "x-requested-with": "CovemeetPhone",
    },
    payload,
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
});

test("self-hosted portal origin authorization uses the matched route for encoded paths and queries", async (t) => {
  const portalOrigin = "http://localhost:5190";
  const f = await fixture(t, "self-hosted", portalOrigin);
  const headers = {
    origin: portalOrigin,
    "x-requested-with": "MeetingPlatform",
  };
  const created = await f.app.inject({
    method: "POST",
    url: "/%61pi/meetings?source=portal",
    headers,
    payload: { ...settings, creationKey },
  });
  assert.equal(created.statusCode, 200);
  const exchanged = await f.app.inject({
    method: "POST",
    url: `/%61pi/meetings/${created.json().code}/host`,
    headers,
    payload: { token: created.json().hostToken },
  });
  assert.equal(exchanged.statusCode, 403);
});
