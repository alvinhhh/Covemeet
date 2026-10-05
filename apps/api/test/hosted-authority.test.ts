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
  const foreignAccountId = randomUUID();
  const billingOwnerId = randomUUID();
  const grant = {
    billingOwnerId,
    revision: 1,
    validUntil: Date.now() + 300000,
    enabled: true,
    quota: {
      anchorAt: Date.UTC(2026, 0, 31),
      participantSecondsPerMonth: 360000,
    },
    hostAccountIds: [accountId, foreignAccountId],
    limits: { participants: 100, durationSeconds: 7200, concurrentMeetings: 2 },
  };
  await store.setHostedEntitlement(grant);
  const input = {
    accountId,
    billingOwnerId,
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
    foreignAccountId,
    billingOwnerId,
    grant,
    tick,
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

test("scheduled codes are machine-assigned and replay only their unchanged unused host bootstrap", async (t) => {
  const f = await fixture(t),
    scheduledCode = randomUUID().replaceAll("-", "").toUpperCase() + "AB";
  const denied = await f.app.inject({
    method: "POST",
    url: "/api/internal/hosted/meetings",
    headers: { origin, "x-requested-with": "MeetingPlatform" },
    payload: { ...f.input, scheduledCode },
  });
  assert.equal(denied.statusCode, 403);
  const publicCode = await f.browser("/api/meetings", {
    ...settings,
    creationKey,
    scheduledCode,
  });
  assert.equal(publicCode.statusCode, 400);
  const first = await f.create({ scheduledCode });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.json().code, scheduledCode);
  const row = (await f.store.get(scheduledCode))!;
  assert(row.hostTokenExpiresAt <= Date.now() + 30 * 60000);
  assert.deepEqual((await f.create({ scheduledCode })).json(), first.json());
  assert.equal(
    (await f.create({ scheduledCode: "F".repeat(34) })).statusCode,
    409,
  );
  await f.exchange(scheduledCode, first.json().hostToken);
  const consumed = await f.create({ scheduledCode });
  assert.equal(consumed.statusCode, 409);
  assert.equal(consumed.json().code, "MEETING_OPERATION_UNAVAILABLE");
});

test("usage remains machine-only and only the owning meeting host sees aggregate allowance", async (t) => {
  const f = await fixture(t);
  for (const url of [
    "/api/internal/hosted/usage",
    "/%61pi/internal/hosted/usage",
  ])
    for (const headers of [
      {},
      { origin, "x-requested-with": "MeetingPlatform" },
    ]) {
      const denied = await f.app.inject({
        method: "POST",
        url,
        headers,
        payload: { billingOwnerId: f.billingOwnerId },
      });
      assert.equal(denied.statusCode, 403);
    }
  const usage = await f.internal("usage", { billingOwnerId: f.billingOwnerId });
  assert.equal(usage.statusCode, 200, usage.body);
  assert.equal(usage.json().participantSeconds.limit, 360000);
  assert.equal(usage.json().billingOwnerId, undefined);
  const unavailable = await f.internal("usage", {
    billingOwnerId: randomUUID(),
  });
  assert.equal(unavailable.statusCode, 404);
  assert.equal(unavailable.json().code, "USAGE_UNAVAILABLE");
  const { code, hostToken } = (await f.create()).json();
  const cookie = await f.exchange(code, hostToken);
  const hostState = (
    await f.browser(`/api/meetings/${code}/state`, undefined, cookie)
  ).json();
  assert.equal(hostState.meeting.usage.participantSeconds.used, 0);
  const joined = await f.browser(`/api/meetings/${code}/join`, {
    name: "Guest",
    password: settings.password,
  });
  const guestCookie = joined.cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const guestState = (
    await f.browser(`/api/meetings/${code}/state`, undefined, guestCookie)
  ).json();
  assert.equal(guestState.meeting.usage, undefined);
  const unmetered = await f.browser("/api/meetings", {
    ...settings,
    creationKey,
  });
  assert.equal(unmetered.statusCode, 200, unmetered.body);
  const legacy = unmetered.json();
  const legacyCookie = await f.exchange(legacy.code, legacy.hostToken);
  const legacyState = (
    await f.browser(
      `/api/meetings/${legacy.code}/state`,
      undefined,
      legacyCookie,
    )
  ).json();
  assert.equal(legacyState.meeting.usage, undefined);
});

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
    await f.create({ accountId: f.foreignAccountId, operationId: randomUUID() })
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

test("pool grants require machine authentication, bounded freshness and exact monotonic revisions", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.internal("entitlements", f.grant, {
        origin,
        "x-requested-with": "MeetingPlatform",
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.internal("entitlements", {
        ...f.grant,
        validUntil: Date.now() + 400000,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.internal("entitlements", {
        ...f.grant,
        hostAccountIds: [f.accountId, f.accountId.toUpperCase()],
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.internal("entitlements", {
        ...f.grant,
        hostAccountIds: [...f.grant.hostAccountIds].reverse(),
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.internal("entitlements", { ...f.grant, enabled: false }))
      .statusCode,
    409,
  );
  assert.equal(
    (
      await f.internal("entitlements", {
        ...f.grant,
        revision: 2,
        enabled: false,
      })
    ).statusCode,
    200,
  );
  const stale = await f.internal("entitlements", f.grant);
  assert.equal(stale.json().revision, 2);
  assert.equal((await f.create()).statusCode, 403);
});

test("new customer creation requires an allowed host and persisted fresh pool; initial owner binding cannot be replaced", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.create({ billingOwnerId: randomUUID() })).statusCode,
    403,
  );
  assert.equal((await f.create({ accountId: randomUUID() })).statusCode, 403);
  assert.equal((await f.authority(1, true)).statusCode, 200);
  assert.equal((await f.create()).statusCode, 200);
  assert.equal(
    (await f.authority(1, true, { billingOwnerId: randomUUID() })).statusCode,
    409,
  );
  assert.equal(
    f.store.hostedAuthorities.get(f.accountId)?.billingOwnerId,
    f.billingOwnerId,
  );
  await f.internal("entitlements", {
    ...f.grant,
    revision: 2,
    validUntil: Date.now() - 1,
  });
  assert.equal((await f.create({ operationId: randomUUID() })).statusCode, 403);
});

test("host exchange atomically reserves one slot per host, and closing media retains that slot", async (t) => {
  const f = await fixture(t);
  const one = (await f.create()).json();
  const two = (await f.create({ operationId: randomUUID() })).json();
  const before = (await f.store.get(one.code))!;
  assert.equal(before.lifecycle, undefined);
  const starts = await Promise.all(
    [one, two].map((row) =>
      f.browser(`/api/meetings/${row.code}/host`, { token: row.hostToken }),
    ),
  );
  assert.deepEqual(starts.map((r) => r.statusCode).sort(), [200, 409]);
  const index = starts.findIndex((r) => r.statusCode === 200);
  const first = [one, two][index]!;
  const second = [one, two][1 - index]!;
  const cookie = starts[index]!.cookies.map((c) => `${c.name}=${c.value}`).join(
    "; ",
  );
  const started = (await f.store.get(first.code))!.lifecycle!;
  assert.equal(started.deadlineAt! - started.startedAt, 7200000);
  f.media.failEnd = true;
  const ended = await f.browser(`/api/meetings/${first.code}/end`, {}, cookie);
  assert.equal(ended.statusCode, 202);
  assert.deepEqual(ended.json(), { ok: true, cleanupPending: true });
  const closing = await f.browser(
    `/api/meetings/${first.code}/state`,
    undefined,
    cookie,
  );
  assert.equal(closing.json().meeting.ended, true);
  assert.equal(closing.json().meeting.cleanupPending, true);
  assert.equal(
    (
      await f.browser(`/api/meetings/${second.code}/host`, {
        token: second.hostToken,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (await f.store.get(first.code))!.lifecycle?.cleanupConfirmed,
    undefined,
  );
  f.media.failEnd = false;
  await f.tick();
  assert.equal(
    (await f.store.get(first.code))!.lifecycle?.cleanupConfirmed,
    true,
  );
  const completed = await f.browser(
    `/api/meetings/${first.code}/end`,
    {},
    cookie,
  );
  assert.equal(completed.statusCode, 200);
  assert.deepEqual(completed.json(), { ok: true, cleanupPending: false });
  assert.equal(
    (
      await f.browser(`/api/meetings/${second.code}/host`, {
        token: second.hostToken,
      })
    ).statusCode,
    200,
  );
});

test("a one-slot pool serializes different hosts and a pool decrease ends every affected active room", async (t) => {
  const f = await fixture(t);
  await f.internal("entitlements", {
    ...f.grant,
    revision: 2,
    limits: { ...f.grant.limits, concurrentMeetings: 1 },
  });
  const one = (await f.create()).json();
  const two = (
    await f.create({ accountId: f.foreignAccountId, operationId: randomUUID() })
  ).json();
  const starts = await Promise.all(
    [one, two].map((row) =>
      f.browser(`/api/meetings/${row.code}/host`, { token: row.hostToken }),
    ),
  );
  assert.deepEqual(starts.map((r) => r.statusCode).sort(), [200, 409]);
  await f.internal("entitlements", { ...f.grant, revision: 3 });
  const waiting = [one, two][starts.findIndex((r) => r.statusCode === 409)]!;
  await f.exchange(waiting.code, waiting.hostToken);
  await f.internal("entitlements", {
    ...f.grant,
    revision: 4,
    limits: { ...f.grant.limits, concurrentMeetings: 1 },
  });
  assert.ok((await f.store.get(one.code))!.ended);
  assert.ok((await f.store.get(two.code))!.ended);
});

test("allowed-host removal overrides stale authority and denies existing media while another member remains active", async (t) => {
  const f = await fixture(t);
  const one = (await f.create()).json();
  const two = (
    await f.create({ accountId: f.foreignAccountId, operationId: randomUUID() })
  ).json();
  const host = await f.exchange(one.code, one.hostToken);
  await f.exchange(two.code, two.hostToken);
  const token = (
    await f.browser(`/api/meetings/${one.code}/media`, {}, host)
  ).json().token;
  await f.media.authorize(token);
  await f.internal("entitlements", {
    ...f.grant,
    revision: 2,
    hostAccountIds: [f.foreignAccountId],
  });
  assert.equal((await f.store.get(one.code))!.ended, true);
  assert.equal((await f.store.get(two.code))!.ended, false);
  assert.equal((await f.authority(1, true)).json().version, 1);
  assert.equal((await f.create({ operationId: randomUUID() })).statusCode, 403);
  await assert.rejects(f.media.authorize(token));
});

test("grant renewal never extends the meeting deadline; expiry blocks tokens and phone renewal before the worker", async (t) => {
  const f = await fixture(t);
  const made = (await f.create()).json();
  const cookie = await f.exchange(made.code, made.hostToken);
  const deadline = (await f.store.get(made.code))!.lifecycle!.deadlineAt;
  await f.internal("entitlements", {
    ...f.grant,
    revision: 2,
    validUntil: Date.now() + 310000,
  });
  assert.equal((await f.store.get(made.code))!.lifecycle!.deadlineAt, deadline);
  const access = (
    await f.browser(`/api/meetings/${made.code}/phone`, {}, cookie)
  ).json();
  const callId = randomUUID();
  const call = (
    await f.gateway("calls", {
      callId,
      trunkId: "fixture",
      locator: access.locator,
      pin: access.pin,
    })
  ).json();
  const jwt = (
    await f.browser(`/api/meetings/${made.code}/media`, {}, cookie)
  ).json().token;
  await f.store.change(made.code, (m) => {
    m.lifecycle!.deadlineAt = Date.now() - 1;
    m.recordingAllowed = true;
    m.hostEmailVerified = true;
  });
  assert.equal(
    (await f.browser(`/api/meetings/${made.code}/media`, {}, cookie))
      .statusCode,
    410,
  );
  assert.equal(
    (
      await f.browser(`/api/meetings/${made.code}/join`, {
        name: "Late",
        password: settings.password,
      })
    ).statusCode,
    410,
  );
  await assert.rejects(f.media.authorize(jwt));
  const polled = await f.gateway(`calls/${made.code}/${call.participantId}`, {
    callId,
    sessionToken: call.sessionToken,
    action: "poll",
  });
  assert.equal(polled.json().state, "ended");
  assert.equal(polled.json().grant, undefined);
  assert.equal(await f.store.hasPhoneReservations(made.code), true);
  await f.tick();
  assert.equal((await f.store.get(made.code))!.ended, true);
  assert.equal(
    (await f.store.get(made.code))!.lifecycle?.cleanupConfirmed,
    undefined,
  );
});

test("hosted webinar uses 100 total places including host, pending removal and phone callers", async (t) => {
  const f = await fixture(t);
  const made = (
    await f.create({ meeting: { ...settings, mode: "webinar" } })
  ).json();
  const cookie = await f.exchange(made.code, made.hostToken);
  const access = (
    await f.browser(`/api/meetings/${made.code}/phone`, {}, cookie)
  ).json();
  await f.store.change(made.code, (m) => {
    const sample = m.participants[0]!;
    for (let i = 0; i < 99; i++)
      m.participants.push({
        ...sample,
        id: randomUUID(),
        role: "viewer",
        status: i === 98 ? "left" : "waiting",
        tokenHash: "",
        enforcementPending: i === 98,
      });
  });
  assert.equal(
    (
      await f.browser(`/api/meetings/${made.code}/join`, {
        name: "Extra",
        password: settings.password,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.gateway("calls", {
        callId: randomUUID(),
        trunkId: "fixture",
        locator: access.locator,
        pin: access.pin,
      })
    ).statusCode,
    409,
  );
  const state = await f.browser(
    `/api/meetings/${made.code}/state`,
    undefined,
    cookie,
  );
  assert.equal(state.json().meeting.participantLimit, 100);
  await f.store.change(made.code, (m) => {
    m.participants.at(-1)!.enforcementPending = false;
  });
  assert.equal(
    (
      await f.browser(`/api/meetings/${made.code}/join`, {
        name: "Last place",
        password: settings.password,
      })
    ).statusCode,
    200,
  );
});

test("Teams grants preserve 100-person meetings, 1000 webinar viewers and an eight-hour fixed deadline", async (t) => {
  const f = await fixture(t);
  const grant = {
    ...f.grant,
    revision: 2,
    quota: {
      ...f.grant.quota,
      metering: "meeting",
      recordingSecondsPerMonth: null,
      storageBytes: 1_000_000_000_000,
      downloadBytesPerMonth: 2_000_000_000_000,
    },
    limits: {
      participants: 100,
      webinarParticipants: 1010,
      durationSeconds: 28800,
      concurrentMeetings: 100,
    },
  };
  assert.equal((await f.internal("entitlements", grant)).statusCode, 200);
  const made = (
    await f.create({ meeting: { ...settings, mode: "webinar" } })
  ).json();
  const cookie = await f.exchange(made.code, made.hostToken);
  const m = (await f.store.get(made.code))!;
  assert.equal(m.lifecycle!.deadlineAt! - m.lifecycle!.startedAt, 28800000);
  const state = (
    await f.browser(`/api/meetings/${made.code}/state`, undefined, cookie)
  ).json();
  assert.equal(state.meeting.participantLimit, 1010);
  const phone = (
    await f.browser(`/api/meetings/${made.code}/phone`, {}, cookie)
  ).json();
  await f.store.change(made.code, (current) => {
    for (let i = 0; i < 1000; i++)
      current.participants.push({
        ...current.participants[0]!,
        id: randomUUID(),
        role: "viewer",
        tokenHash: "",
        status: "admitted",
      });
  });
  assert.equal(
    (
      await f.browser(`/api/meetings/${made.code}/join`, {
        name: "Extra",
        password: settings.password,
      })
    ).statusCode,
    409,
  );
  assert.equal(
    (
      await f.gateway("calls", {
        callId: randomUUID(),
        trunkId: "fixture",
        locator: phone.locator,
        pin: phone.pin,
      })
    ).statusCode,
    409,
  );
  const other = (
    await f.create({ accountId: f.foreignAccountId, operationId: randomUUID() })
  ).json();
  const otherCookie = await f.exchange(other.code, other.hostToken);
  assert.equal(
    (
      await f.browser(
        `/api/meetings/${other.code}/state`,
        undefined,
        otherCookie,
      )
    ).json().meeting.participantLimit,
    100,
  );
  for (const changed of [
    { limits: { ...grant.limits, concurrentMeetings: 101 } },
    { limits: { ...grant.limits, durationSeconds: 28801 } },
    { limits: { ...grant.limits, webinarParticipants: 1011 } },
    { quota: { ...grant.quota, storageBytes: 1_000_000_000_001 } },
    { quota: { ...grant.quota, downloadBytesPerMonth: 2_000_000_000_001 } },
  ])
    assert.equal(
      (await f.internal("entitlements", { ...grant, ...changed, revision: 3 }))
        .statusCode,
      400,
    );
  assert.equal(
    (
      await f.internal("entitlements", {
        ...grant,
        quota: { ...grant.quota, recordingSecondsPerMonth: 0 },
      })
    ).statusCode,
    409,
  );
});

test("ordinary completion retains finished recording credentials and cannot release a busy recorder slot", async (t) => {
  const f = await fixture(t);
  const made = (await f.create()).json();
  const cookie = await f.exchange(made.code, made.hostToken);
  const id = randomUUID();
  await f.store.change(made.code, (m) => {
    m.recordings.push({
      id: "finished",
      status: "ready",
      createdAt: Date.now(),
      tokenHash: "retained-download",
      passwordHash: "retained-password",
    });
    m.recordings.push({
      id,
      status: "recording",
      createdAt: Date.now(),
      egressId: "owned-job",
    });
  });
  await f.store.withRecordingLock(made.code, id, async () => {
    const ended = await f.browser(`/api/meetings/${made.code}/end`, {}, cookie);
    assert.equal(ended.statusCode, 202);
    assert.equal(ended.json().cleanupPending, true);
  });
  const stopped = (await f.store.get(made.code))!;
  assert.equal(stopped.recordings[0]!.tokenHash, "retained-download");
  assert.equal(stopped.recordings[0]!.passwordHash, "retained-password");
  assert.equal(stopped.hosted?.revoked, undefined);
  assert.equal(stopped.lifecycle?.cleanupConfirmed, undefined);
  await f.store.change(made.code, (m) => {
    m.recordings[1]!.status = "failed";
  });
  await f.tick();
  assert.equal(
    (await f.store.get(made.code))!.lifecycle?.cleanupConfirmed,
    true,
  );
});

test("new plan bindings and pool expiry leave old unbound operator rooms unchanged", async (t) => {
  const f = await fixture(t);
  const legacy = (
    await f.browser("/api/meetings", { ...settings, creationKey })
  ).json();
  const host = await f.exchange(legacy.code, legacy.hostToken);
  await f.authority(1, true, { billingOwnerId: f.billingOwnerId });
  await f.internal("entitlements", { ...f.grant, revision: 2, enabled: false });
  await f.tick();
  assert.equal((await f.store.get(legacy.code))!.ended, false);
  assert.equal(
    (await f.browser(`/api/meetings/${legacy.code}/media`, {}, host))
      .statusCode,
    200,
  );
});

test("self-hosted numeric limits need no hosted entitlement and keep a fixed configured duration", async (t) => {
  const f = await fixture(t, "self-hosted");
  f.config.meetingParticipantLimit = 2;
  f.config.meetingDurationSeconds = 60;
  const made = (
    await f.browser("/api/meetings", { ...settings, creationKey })
  ).json();
  await f.exchange(made.code, made.hostToken);
  const m = (await f.store.get(made.code))!;
  assert.equal(m.hosted, undefined);
  assert.equal(m.lifecycle!.deadlineAt! - m.lifecycle!.startedAt, 60000);
  assert.equal(
    (
      await f.browser(`/api/meetings/${made.code}/join`, {
        name: "Guest",
        password: settings.password,
      })
    ).statusCode,
    200,
  );
  assert.equal(
    (
      await f.browser(`/api/meetings/${made.code}/join`, {
        name: "Extra",
        password: settings.password,
      })
    ).statusCode,
    409,
  );
  assert.throws(() =>
    loadConfig({
      SESSION_SECRET: "x".repeat(32),
      MEETING_DURATION_SECONDS: "-1",
    }),
  );
  assert.throws(() =>
    loadConfig({
      SESSION_SECRET: "x".repeat(32),
      MEETING_PARTICIPANT_LIMIT: "1.5",
    }),
  );
});

test("breakout and reconnect grants preserve the original start reservation and deadline", async (t) => {
  const f = await fixture(t);
  const made = (await f.create()).json();
  const cookie = await f.exchange(made.code, made.hostToken);
  const initial = (await f.store.get(made.code))!;
  await f.browser(
    `/api/meetings/${made.code}/breakouts`,
    { name: "Side room" },
    cookie,
  );
  const room = (await f.store.get(made.code))!.breakouts[0]!;
  assert.equal(
    (
      await f.browser(
        `/api/meetings/${made.code}/move`,
        { participantId: initial.participants[0]!.id, breakoutId: room.id },
        cookie,
      )
    ).statusCode,
    200,
  );
  for (let i = 0; i < 2; i++)
    assert.equal(
      (await f.browser(`/api/meetings/${made.code}/media`, {}, cookie))
        .statusCode,
      200,
    );
  const moved = (await f.store.get(made.code))!;
  assert.deepEqual(moved.lifecycle, initial.lifecycle);
  assert.equal(moved.participants.length, 1);
  assert.equal(moved.participants[0]!.id, initial.participants[0]!.id);
});
