import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { LiveMedia } from "../src/media.js";
import { MemoryStore, type Meeting, type Participant } from "../src/store.js";
import { RecordingService } from "../src/recordings.js";
import { usageWindow } from "../src/participant-meter.js";

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
  removed: string[] = [];
  failEnd = false;
  failRemove = false;
  onRemove?: () => Promise<void>;
  override async end(m: Meeting) {
    this.ended.push(m.code);
    if (this.failEnd) throw new Error("SFU unavailable");
  }
  override async remove(_m: Meeting, p: Participant) {
    this.removed.push(p.previousMediaIdentity ?? p.mediaIdentity ?? p.id);
    if (this.failRemove) throw new Error("SFU unavailable");
    await this.onRemove?.();
  }
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

test("background cleanup isolates room failures and retries them next pass", async (t) => {
  for (const failure of ["read", "change", "capture"] as const)
    await t.test(failure, async (t) => {
      const f = await fixture(t);
      const first = (await f.create()).json();
      await f.exchange(first.code, first.hostToken);
      const second = (
        await f.create({
          accountId: f.foreignAccountId,
          operationId: randomUUID(),
        })
      ).json();
      await f.exchange(second.code, second.hostToken);
      for (const code of failure === "capture"
        ? [second.code]
        : [first.code, second.code])
        await f.store.change(code, (m) => {
          m.lifecycle!.deadlineAt = Date.now() - 1;
        });

      let failing = true;
      const get = f.store.get.bind(f.store);
      const change = f.store.change.bind(f.store);
      t.mock.method(f.store, "get", async (code: string) => {
        if (failing && code === first.code && failure === "read")
          throw new Error("Room read unavailable");
        return get(code);
      });
      t.mock.method(f.store, "change", async (code, callback) => {
        if (failing && code === first.code && failure === "change")
          throw new Error("Room update unavailable");
        return change(code, callback);
      });
      const reconciled: string[] = [];
      t.mock.method(
        RecordingService.prototype,
        "reconcile",
        async (m, phase) => {
          if (
            failing &&
            m.code === first.code &&
            (phase === "files" || failure === "capture")
          )
            throw new Error("Recording reconciliation unavailable");
          reconciled.push(`${m.code}:${phase}`);
        },
      );

      for (let pass = 0; pass < 2; pass++) {
        await f.tick();
        const closed = (await get(second.code))!;
        assert.equal(closed.ended, true);
        assert.equal(closed.cleanupPending, false);
        assert.equal(closed.lifecycle?.cleanupConfirmed, true);
        assert(f.media.ended.includes(second.code));
        assert(reconciled.includes(`${second.code}:files`));
        assert.notEqual(
          (await get(first.code))!.lifecycle?.cleanupConfirmed,
          true,
        );
      }
      failing = false;
      await f.tick();
      assert(reconciled.includes(`${first.code}:capture`));
      assert(reconciled.includes(`${first.code}:files`));
      if (failure !== "capture")
        assert.equal(
          (await get(first.code))!.lifecycle?.cleanupConfirmed,
          true,
        );
    });
});

test("meeting branding is a machine-bound public profile, never a browser-selected tenant", async (t) => {
  const f = await fixture(t, "hosted", "https://covemeet.com");
  f.config.production = true;
  const brandingProfileId = randomUUID();
  const payload = { ...f.input, brandingProfileId };
  const denied = await f.app.inject({
    method: "POST",
    url: "/api/internal/hosted/meetings",
    headers: { origin, "x-requested-with": "MeetingPlatform" },
    payload,
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(
    (
      await f.browser("/api/meetings", {
        ...settings,
        creationKey,
        brandingProfileId,
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (await f.create({ brandingProfileId: "not-a-profile" })).statusCode,
    400,
  );
  const first = await f.create({
    brandingProfileId: brandingProfileId.toUpperCase(),
  });
  assert.equal(first.statusCode, 200, first.body);
  const code = first.json().code;
  assert.equal(
    (await f.store.get(code))!.hosted!.brandingProfileId,
    brandingProfileId,
  );
  assert.deepEqual(
    (await f.create({ brandingProfileId })).json(),
    first.json(),
  );
  assert.equal(
    (await f.create({ brandingProfileId: randomUUID() })).statusCode,
    409,
  );
  assert.equal((await f.create()).statusCode, 409);
  const branding = await f.app.inject({
    url: `/api/meetings/${code}/branding`,
  });
  assert.equal(branding.statusCode, 200);
  assert.deepEqual(branding.json(), { brandingProfileId });
  assert.equal(branding.headers["cache-control"], "no-store");
  assert.equal(branding.headers["set-cookie"], undefined);
  assert.match(
    String(branding.headers["content-security-policy"]),
    /img-src 'self' blob: data: https:\/\/covemeet\.com;/,
  );
  assert.equal(
    (await f.app.inject({ url: `/api/meetings/${"A".repeat(26)}/branding` }))
      .statusCode,
    404,
  );
  const legacy = await f.create({ operationId: randomUUID() });
  assert.equal(legacy.statusCode, 200, legacy.body);
  assert.deepEqual(
    (
      await f.app.inject({
        url: `/api/meetings/${legacy.json().code}/branding`,
      })
    ).json(),
    { brandingProfileId: null },
  );
});

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

test("machine operation lookup is bounded to requested creator IDs and survives invitation expiry and end", async (t) => {
  const f = await fixture(t);
  const owned = (await f.create()).json();
  const foreignOperationId = randomUUID();
  const foreign = await f.create({
    accountId: f.foreignAccountId,
    operationId: foreignOperationId,
  });
  assert.equal(foreign.statusCode, 200, foreign.body);
  await f.store.change(owned.code, (m) => {
    m.hostTokenExpiresAt = Date.now() - 1;
  });
  assert.equal((await f.create()).statusCode, 409);
  const path = "meeting-operations/lookup";
  const body = {
    accountId: f.accountId,
    operationIds: [f.input.operationId, foreignOperationId, randomUUID()],
  };
  assert.equal((await f.internal(path, body, {})).statusCode, 403);
  assert.equal(
    (await f.internal(path, body, { ...machineHeaders, origin })).statusCode,
    403,
  );
  assert.equal(
    (
      await f.internal(path, {
        accountId: f.accountId,
        operationIds: Array.from({ length: 21 }, () => randomUUID()),
      })
    ).statusCode,
    400,
  );
  assert.equal(
    (
      await f.internal(path, {
        accountId: f.accountId,
        operationIds: [f.input.operationId, f.input.operationId.toUpperCase()],
      })
    ).statusCode,
    400,
  );
  const response = await f.internal(path, body);
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(response.json(), {
    operations: [
      {
        accountId: f.accountId,
        operationId: f.input.operationId,
        version: 1,
        billingOwnerId: f.billingOwnerId,
        code: owned.code,
        title: settings.title,
        mode: settings.mode,
        createdAt: new Date(
          (await f.store.get(owned.code))!.createdAt,
        ).toISOString(),
        revoked: false,
      },
    ],
  });
  assert.doesNotMatch(
    response.body,
    /hostToken|passwordHash|requestHash|entitlement/,
  );
  assert.ok(!response.body.includes(owned.hostToken));
  assert.ok(!response.body.includes(settings.password));
  await f.store.change(owned.code, (m) => {
    m.ended = true;
  });
  assert.equal(
    (await f.internal(path, body)).json().operations[0].code,
    owned.code,
  );
  const secondOperationId = randomUUID();
  const second = (await f.create({ operationId: secondOperationId })).json();
  await f.store.change(second.code, (m) => {
    m.hosted!.revoked = true;
  });
  const revoked = await f.internal(path, {
    accountId: f.accountId,
    operationIds: [secondOperationId],
  });
  assert.equal(revoked.json().operations[0].revoked, true);
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
    for (const raised of [true, false])
      assert.equal(
        (
          await f.app.inject({
            method: "PUT",
            url: `/api/meetings/${created.code}/participants/${guestId}/hand`,
            payload: { raised },
            headers: { origin, "x-requested-with": "MeetingPlatform", cookie },
          })
        ).statusCode,
        410,
      );
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
  assert.ok((await f.store.get(second.code))!.hostTokenHash);
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

test("host re-entry requires exact creator authority and a current revision", async (t) => {
  const f = await fixture(t);
  const made = (await f.create()).json();
  const requestId = randomUUID();
  const request = {
    accountId: f.accountId,
    version: 1,
    billingOwnerId: f.billingOwnerId,
    requestId,
    expectedRevision: 0,
  };
  const issue = (
    body = request,
    headers: Record<string, string> = machineHeaders,
  ) => f.internal(`meetings/${made.code}/host-reentry`, body, headers);
  const oldCookie = await f.exchange(made.code, made.hostToken);
  assert.equal(
    (
      await f.internal("meetings/status", {
        accountId: f.accountId,
        version: 1,
      })
    ).json().meetings[0].hostReentryRevision,
    0,
  );
  assert.equal((await issue(request, {})).statusCode, 403);
  assert.equal(
    (await issue({ ...request, accountId: f.foreignAccountId })).statusCode,
    403,
  );
  assert.equal(
    (await issue({ ...request, billingOwnerId: randomUUID() })).statusCode,
    403,
  );
  assert.equal((await issue({ ...request, version: 2 })).statusCode, 403);
  const first = await issue();
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual((await issue()).json(), first.json());
  assert.equal(
    (await issue({ ...request, requestId: randomUUID() })).statusCode,
    409,
  );
  const replacementRequest = {
    ...request,
    requestId: randomUUID(),
    expectedRevision: 1,
  };
  const replacement = await issue(replacementRequest);
  assert.equal(replacement.statusCode, 200, replacement.body);
  assert.equal((await issue()).statusCode, 409);
  assert.equal(
    (
      await f.browser(`/api/meetings/${made.code}/host`, {
        token: first.json().hostToken,
      })
    ).statusCode,
    403,
  );
  assert.equal(
    (
      await f.internal("meetings/status", {
        accountId: f.accountId,
        version: 1,
      })
    ).json().meetings[0].hostReentryRevision,
    2,
  );
  const newCookie = await f.exchange(made.code, replacement.json().hostToken);
  assert.notEqual(oldCookie, newCookie);
  assert.equal(
    (await f.browser(`/api/meetings/${made.code}/state`, undefined, oldCookie))
      .statusCode,
    401,
  );
  assert.equal((await issue()).statusCode, 409);
  assert.equal(
    (await issue({ ...request, requestId: randomUUID(), expectedRevision: 2 }))
      .statusCode,
    200,
  );
  assert.equal((await issue()).statusCode, 409);
});

test("a lost first host link can be replaced before start without bypassing the initial reservation", async (t) => {
  const f = await fixture(t);
  const made = (await f.create()).json();
  const before = (await f.store.get(made.code))!;
  assert.equal(before.lifecycle, undefined);
  assert.deepEqual(
    (
      await f.internal("meetings/status", {
        accountId: f.accountId,
        version: 1,
      })
    ).json(),
    {
      meetings: [
        { code: made.code, hostReentryRevision: 0, status: "not-started" },
      ],
    },
  );
  const request = {
    accountId: f.accountId,
    version: 1,
    billingOwnerId: f.billingOwnerId,
    requestId: randomUUID(),
    expectedRevision: 0,
  };
  const path = `meetings/${made.code}/host-reentry`;
  const issued = await f.internal(path, request);
  assert.equal(issued.statusCode, 200, issued.body);
  assert.equal(
    (
      await f.browser(`/api/meetings/${made.code}/host`, {
        token: made.hostToken,
      })
    ).statusCode,
    403,
  );
  assert.equal((await f.store.get(made.code))!.lifecycle, undefined);
  const replay = await f.internal(path, request);
  assert.deepEqual(replay.json(), issued.json());
  await f.exchange(made.code, issued.json().hostToken);
  const started = (await f.store.get(made.code))!;
  assert.equal(started.hostReentry?.phase, "consumed");
  assert.ok(started.lifecycle?.startedAt);
  assert.equal(started.participants.length, before.participants.length);
  assert.equal((await f.internal(path, request)).statusCode, 409);
  assert.equal(
    (
      await f.internal("meetings/status", {
        accountId: f.accountId,
        version: 1,
      })
    ).json().meetings[0].status,
    "active",
  );
});

test("an expired unstarted host row can open with a fresh session after cleanup", async (t) => {
  const f = await fixture(t);
  const made = (await f.create()).json();
  await f.store.change(made.code, (m) => {
    m.hostTokenExpiresAt = Date.now() - 1;
    m.participants.find((p) => p.role === "host")!.expiresAt = Date.now() - 1;
  });
  await f.tick();
  const expired = (await f.store.get(made.code))!;
  assert.equal(expired.lifecycle, undefined);
  assert.equal(
    expired.participants.find((p) => p.role === "host")?.status,
    "left",
  );
  assert.equal(
    expired.participants.find((p) => p.role === "host")?.enforcementPending,
    false,
  );
  assert.equal(
    (
      await f.internal("meetings/status", {
        accountId: f.accountId,
        version: 1,
      })
    ).json().meetings[0].status,
    "not-started",
  );
  await f.store.change(made.code, (m) => {
    const host = m.participants.find((p) => p.role === "host")!;
    for (let index = 0; index < 99; index++)
      m.participants.push({
        ...host,
        id: randomUUID(),
        name: `Guest ${index}`,
        role: "participant",
        status: "admitted",
        tokenHash: randomUUID(),
        expiresAt: Date.now() + 60_000,
        mediaIdentity: randomUUID(),
      });
  });
  assert.equal(
    (
      await f.browser(`/api/meetings/${made.code}/join`, {
        name: "Extra guest",
        password: settings.password,
      })
    ).statusCode,
    409,
  );
  const issued = await f.internal(`meetings/${made.code}/host-reentry`, {
    accountId: f.accountId,
    version: 1,
    billingOwnerId: f.billingOwnerId,
    requestId: randomUUID(),
    expectedRevision: 0,
  });
  assert.equal(issued.statusCode, 200, issued.body);
  await f.exchange(made.code, issued.json().hostToken);
  const host = (await f.store.get(made.code))!.participants.find(
    (p) => p.role === "host",
  )!;
  assert.equal(host.status, "admitted");
  assert.ok(host.expiresAt >= Date.now() + 11 * 60 * 60_000);
  assert.equal(
    (await f.store.get(made.code))!.participants.filter(
      (p) => p.status === "admitted",
    ).length,
    100,
  );
});

test("host re-entry persists the old media fence and retries cleanup without a new reservation", async (t) => {
  const f = await fixture(t);
  const made = (await f.create()).json();
  const oldCookie = await f.exchange(made.code, made.hostToken);
  const before = (await f.store.get(made.code))!;
  const oldHost = before.participants.find((p) => p.role === "host")!;
  // A started room has already consumed its only hosted reservation.
  await f.store.setHostedEntitlement({
    ...f.grant,
    revision: 2,
    quota: { ...f.grant.quota, participantSecondsPerMonth: 1 },
  });
  f.store.usageLedgers.get(f.billingOwnerId)!.windows = [
    { ...usageWindow(f.grant.quota.anchorAt, Date.now()), usedMs: 1000 },
  ];
  await assert.rejects(f.store.checkUsage(made.code));
  const request = {
    accountId: f.accountId,
    version: 1,
    billingOwnerId: f.billingOwnerId,
    requestId: randomUUID(),
    expectedRevision: 0,
  };
  const issued = await f.internal(
    `meetings/${made.code}/host-reentry`,
    request,
  );
  assert.equal(issued.statusCode, 200, issued.body);
  const token = issued.json().hostToken;
  f.media.failRemove = true;
  const pending = await f.browser(`/api/meetings/${made.code}/host`, { token });
  assert.equal(pending.statusCode, 503, pending.body);
  assert.equal(
    pending.cookies.some((c) => c.name === `mp_${made.code}`),
    false,
  );
  const fenced = (await f.store.get(made.code))!;
  const host = fenced.participants.find((p) => p.role === "host")!;
  assert.equal(fenced.hostReentry?.phase, "fenced");
  assert.equal(host.enforcementPending, true);
  assert.notEqual(host.mediaIdentity, oldHost.mediaIdentity);
  assert.equal(
    (await f.browser(`/api/meetings/${made.code}/state`, undefined, oldCookie))
      .statusCode,
    401,
  );
  assert.equal(
    (
      await f.internal(`meetings/${made.code}/host-reentry`, {
        ...request,
        requestId: randomUUID(),
        expectedRevision: 1,
      })
    ).statusCode,
    503,
  );
  f.media.failRemove = false;
  const newCookie = await f.exchange(made.code, token);
  assert.notEqual(newCookie, oldCookie);
  const after = (await f.store.get(made.code))!;
  assert.equal(after.hostReentry?.phase, "consumed");
  assert.equal(after.participants.length, before.participants.length);
  assert.equal(after.lifecycle?.startedAt, before.lifecycle?.startedAt);
  assert.equal(
    after.participants.find((p) => p.role === "host")?.id,
    oldHost.id,
  );
  assert.ok(f.media.removed.length >= 2);
  assert.ok(f.media.removed.every((identity) => identity === oldHost.id));
});

test("host re-entry rechecks the live grant after media cleanup before issuing a cookie", async (t) => {
  const f = await fixture(t);
  const made = (await f.create()).json();
  const oldCookie = await f.exchange(made.code, made.hostToken);
  const issued = await f.internal(`meetings/${made.code}/host-reentry`, {
    accountId: f.accountId,
    version: 1,
    billingOwnerId: f.billingOwnerId,
    requestId: randomUUID(),
    expectedRevision: 0,
  });
  assert.equal(issued.statusCode, 200, issued.body);
  f.media.onRemove = async () => {
    f.media.onRemove = undefined;
    await f.store.setHostedEntitlement({
      ...f.grant,
      revision: 2,
      enabled: false,
    });
  };
  const exchanged = await f.browser(`/api/meetings/${made.code}/host`, {
    token: issued.json().hostToken,
  });
  assert.equal(exchanged.statusCode, 409, exchanged.body);
  assert.equal(
    exchanged.cookies.some((c) => c.name === `mp_${made.code}`),
    false,
  );
  assert.equal((await f.store.get(made.code))!.ended, true);
  assert.equal(
    (await f.browser(`/api/meetings/${made.code}/state`, undefined, oldCookie))
      .statusCode,
    401,
  );
});

test("a refreshed intent can take over a fenced invitation after background media cleanup", async (t) => {
  const f = await fixture(t);
  const made = (await f.create()).json();
  await f.exchange(made.code, made.hostToken);
  const request = {
    accountId: f.accountId,
    version: 1,
    billingOwnerId: f.billingOwnerId,
    requestId: randomUUID(),
    expectedRevision: 0,
  };
  const path = `meetings/${made.code}/host-reentry`;
  const first = (await f.internal(path, request)).json().hostToken;
  f.media.failRemove = true;
  assert.equal(
    (await f.browser(`/api/meetings/${made.code}/host`, { token: first }))
      .statusCode,
    503,
  );
  f.media.failRemove = false;
  await f.tick();
  assert.equal(
    (await f.store.get(made.code))!.participants.find((p) => p.role === "host")
      ?.enforcementPending,
    false,
  );
  const replacement = await f.internal(path, {
    ...request,
    requestId: randomUUID(),
    expectedRevision: 1,
  });
  assert.equal(replacement.statusCode, 200, replacement.body);
  assert.equal((await f.store.get(made.code))!.hostReentry?.phase, "fenced");
  assert.equal(
    (await f.browser(`/api/meetings/${made.code}/host`, { token: first }))
      .statusCode,
    403,
  );
  const removals = f.media.removed.length;
  await f.exchange(made.code, replacement.json().hostToken);
  assert.equal(f.media.removed.length, removals);
});

test("a started hosted room reserves the absent host seat for re-entry", async (t) => {
  const f = await fixture(t);
  const made = (await f.create()).json();
  await f.exchange(made.code, made.hostToken);
  await f.store.change(made.code, (m) => {
    const host = m.participants.find((p) => p.role === "host")!;
    host.status = "left";
    host.expiresAt = Date.now() - 1;
    for (let index = 0; index < 99; index++)
      m.participants.push({
        ...host,
        id: randomUUID(),
        name: `Guest ${index}`,
        role: "participant",
        status: "admitted",
        tokenHash: randomUUID(),
        expiresAt: Date.now() + 60_000,
      });
  });
  assert.equal(
    (
      await f.browser(`/api/meetings/${made.code}/join`, {
        name: "Extra guest",
        password: settings.password,
      })
    ).statusCode,
    409,
  );
  const issued = await f.internal(`meetings/${made.code}/host-reentry`, {
    accountId: f.accountId,
    version: 1,
    billingOwnerId: f.billingOwnerId,
    requestId: randomUUID(),
    expectedRevision: 0,
  });
  assert.equal(issued.statusCode, 200, issued.body);
  await f.exchange(made.code, issued.json().hostToken);
  const after = (await f.store.get(made.code))!;
  assert.equal(
    after.participants.filter((p) => p.status === "admitted").length,
    100,
  );
});

test("host leave ends the room and releases its start reservation after cleanup", async (t) => {
  const f = await fixture(t);
  const first = (await f.create()).json();
  const second = (await f.create({ operationId: randomUUID() })).json();
  const cookie = await f.exchange(first.code, first.hostToken);
  const left = await f.browser(`/api/meetings/${first.code}/leave`, {}, cookie);
  assert.equal(left.statusCode, 200, left.body);
  assert.deepEqual(left.json(), { ok: true, cleanupPending: false });
  assert.equal((await f.store.get(first.code))!.ended, true);
  assert.equal(
    (await f.store.get(first.code))!.lifecycle?.cleanupConfirmed,
    true,
  );
  assert.equal(
    (
      await f.browser(`/api/meetings/${second.code}/host`, {
        token: second.hostToken,
      })
    ).statusCode,
    200,
  );
});

test("current owner can end an older left-host room but not a future-version room", async (t) => {
  const f = await fixture(t);
  const first = (await f.create()).json();
  await f.exchange(first.code, first.hostToken);
  const status = () =>
    f.internal("meetings/status", { accountId: f.accountId, version: 2 });
  const end = (changes = {}) =>
    f.internal(`meetings/${first.code}/end`, {
      accountId: f.accountId,
      version: 2,
      ...changes,
    });
  assert.deepEqual((await status()).json(), {
    meetings: [{ code: first.code, hostReentryRevision: 0, status: "active" }],
  });
  await f.store.change(first.code, (m) => {
    m.participants.find((p) => p.role === "host")!.status = "left";
  });
  assert.deepEqual((await status()).json(), {
    meetings: [
      { code: first.code, hostReentryRevision: 0, status: "orphaned" },
    ],
  });
  await f.store.change(first.code, (m) => {
    m.hosted!.version = 3;
  });
  assert.deepEqual((await status()).json(), { meetings: [] });
  assert.equal((await end()).statusCode, 409);
  await f.store.change(first.code, (m) => {
    m.hosted!.version = 1;
  });
  assert.equal((await end({ accountId: f.foreignAccountId })).statusCode, 409);
  assert.equal((await end({ billingOwnerId: randomUUID() })).statusCode, 400);
  assert.equal(
    (
      await f.app.inject({
        method: "POST",
        url: `/api/internal/hosted/meetings/${first.code}/end`,
        headers: { origin, "x-requested-with": "MeetingPlatform" },
        payload: {
          accountId: f.accountId,
          version: 1,
        },
      })
    ).statusCode,
    403,
  );
  f.media.failEnd = true;
  const pending = await end();
  assert.equal(pending.statusCode, 202, pending.body);
  assert.deepEqual(pending.json(), { ok: true, cleanupPending: true });
  assert.deepEqual((await status()).json(), {
    meetings: [{ code: first.code, hostReentryRevision: 0, status: "ending" }],
  });
  assert.equal(
    (
      await f.internal("entitlements", {
        ...f.grant,
        revision: 2,
        validUntil: Date.now() - 1,
      })
    ).statusCode,
    200,
  );
  f.media.failEnd = false;
  const completed = await end();
  assert.equal(completed.statusCode, 200, completed.body);
  assert.deepEqual((await status()).json(), { meetings: [] });
});

test("current owner can end an active room when the host tab disappears", async (t) => {
  const f = await fixture(t);
  const first = (await f.create()).json();
  await f.exchange(first.code, first.hostToken);
  assert.equal(
    (await f.store.get(first.code))!.participants.find((p) => p.role === "host")
      ?.status,
    "admitted",
  );
  const ended = await f.internal(`meetings/${first.code}/end`, {
    accountId: f.accountId,
    version: 1,
  });
  assert.equal(ended.statusCode, 200, ended.body);
  assert.equal(
    (await f.store.get(first.code))!.lifecycle?.cleanupConfirmed,
    true,
  );
});

test("hosted owner can finish cleanup after the host ended a room", async (t) => {
  const f = await fixture(t);
  const first = (await f.create()).json();
  const cookie = await f.exchange(first.code, first.hostToken);
  f.media.failEnd = true;
  assert.equal(
    (await f.browser(`/api/meetings/${first.code}/end`, {}, cookie)).statusCode,
    202,
  );
  assert.deepEqual(
    (
      await f.internal("meetings/status", {
        accountId: f.accountId,
        version: 1,
      })
    ).json(),
    {
      meetings: [
        { code: first.code, hostReentryRevision: 0, status: "ending" },
      ],
    },
  );
  f.media.failEnd = false;
  const completed = await f.internal(`meetings/${first.code}/end`, {
    accountId: f.accountId,
    version: 1,
  });
  assert.equal(completed.statusCode, 200, completed.body);
  assert.equal(
    (await f.store.get(first.code))!.lifecycle?.cleanupConfirmed,
    true,
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

function freeGrant(f: Awaited<ReturnType<typeof fixture>>, revision = 2) {
  return {
    ...f.grant,
    revision,
    hostAccountIds: [f.accountId],
    quota: {
      anchorAt: f.grant.quota.anchorAt,
      metering: "meeting" as const,
      participantSecondsPerMonth: null,
      recordingSecondsPerMonth: 0,
      downloadBytesPerMonth: 0,
      storageBytes: 0,
    },
    limits: {
      participants: 100,
      webinarParticipants: 100,
      durationSeconds: 0,
      groupDurationSeconds: 10800,
      concurrentMeetings: 1,
    },
  };
}

test("Free meeting stays uncapped with two people, caps at the third admission, and renews active browser sessions", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.internal("entitlements", freeGrant(f))).statusCode,
    200,
  );
  const made = (await f.create()).json();
  const host = await f.exchange(made.code, made.hostToken);
  assert.equal(
    (await f.browser(`/api/meetings/${made.code}/recordings`, {}, host))
      .statusCode,
    403,
  );
  assert.equal(
    (
      await f.app.inject({
        method: "PATCH",
        url: `/api/meetings/${made.code}`,
        headers: {
          origin,
          "x-requested-with": "MeetingPlatform",
          cookie: host,
        },
        payload: { recordingAllowed: true },
      })
    ).statusCode,
    403,
  );
  const guest = await f.browser(`/api/meetings/${made.code}/join`, {
    name: "One",
    password: settings.password,
  });
  assert.equal(guest.statusCode, 200);
  assert.equal(
    (
      await f.browser(
        `/api/meetings/${made.code}/participants/${guest.json().participantId}/action`,
        { action: "admit" },
        host,
      )
    ).statusCode,
    200,
  );
  assert.equal(
    (await f.store.get(made.code))!.lifecycle?.deadlineAt,
    undefined,
  );
  await f.store.change(made.code, (m) => {
    m.participants.find((p) => p.role === "host")!.expiresAt =
      Date.now() + 1000;
  });
  const renewed = await f.browser(
    `/api/meetings/${made.code}/state`,
    undefined,
    host,
  );
  assert.equal(renewed.statusCode, 200);
  assert(renewed.cookies.some((cookie) => cookie.name === `mp_${made.code}`));
  assert(
    (await f.store.get(made.code))!.participants.find((p) => p.role === "host")!
      .expiresAt >
      Date.now() + 11 * 3600000,
  );
  const extra = await f.browser(`/api/meetings/${made.code}/join`, {
    name: "Two",
    password: settings.password,
  });
  assert.equal(extra.statusCode, 200);
  assert.equal(
    (
      await f.browser(
        `/api/meetings/${made.code}/participants/${extra.json().participantId}/action`,
        { action: "admit" },
        host,
      )
    ).statusCode,
    200,
  );
  const capped = (await f.store.get(made.code))!;
  assert.equal(
    capped.lifecycle!.deadlineAt! - capped.lifecycle!.startedAt,
    10800000,
  );
  await f.browser(
    `/api/meetings/${made.code}/participants/${extra.json().participantId}/action`,
    { action: "kick" },
    host,
  );
  assert.equal(
    (await f.store.get(made.code))!.lifecycle!.deadlineAt,
    capped.lifecycle!.deadlineAt,
  );
});

test("Free two-person meeting remains open after three hours but refuses a third participant", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.internal("entitlements", freeGrant(f))).statusCode,
    200,
  );
  const made = (await f.create()).json();
  const host = await f.exchange(made.code, made.hostToken);
  await f.store.change(made.code, (m) => {
    m.lifecycle!.startedAt = Date.now() - 10800001;
  });
  const guest = await f.browser(`/api/meetings/${made.code}/join`, {
    name: "One",
    password: settings.password,
  });
  assert.equal(guest.statusCode, 200);
  assert.equal(
    (
      await f.browser(
        `/api/meetings/${made.code}/participants/${guest.json().participantId}/action`,
        { action: "admit" },
        host,
      )
    ).statusCode,
    200,
  );
  await f.tick();
  assert.equal((await f.store.get(made.code))!.ended, false);
  const third = await f.browser(`/api/meetings/${made.code}/join`, {
    name: "Two",
    password: settings.password,
  });
  assert.equal(third.statusCode, 200);
  assert.equal(
    (
      await f.browser(
        `/api/meetings/${made.code}/participants/${third.json().participantId}/action`,
        { action: "admit" },
        host,
      )
    ).statusCode,
    409,
  );
  assert.equal(
    (await f.store.get(made.code))!.lifecycle!.deadlineAt,
    undefined,
  );
});

test("a phone caller admitted as the third Free participant starts the sticky group deadline", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.internal("entitlements", freeGrant(f))).statusCode,
    200,
  );
  const made = (await f.create()).json();
  const host = await f.exchange(made.code, made.hostToken);
  const guest = await f.browser(`/api/meetings/${made.code}/join`, {
    name: "Browser guest",
    password: settings.password,
  });
  assert.equal(guest.statusCode, 200);
  assert.equal(
    (
      await f.browser(
        `/api/meetings/${made.code}/participants/${guest.json().participantId}/action`,
        { action: "admit" },
        host,
      )
    ).statusCode,
    200,
  );
  const phone = (
    await f.browser(`/api/meetings/${made.code}/phone`, {}, host)
  ).json();
  const caller = await f.gateway("calls", {
    locator: phone.locator,
    pin: phone.pin,
    callId: randomUUID(),
    trunkId: "fixture",
  });
  assert.equal(caller.statusCode, 200, caller.body);
  assert.equal(
    (
      await f.browser(
        `/api/meetings/${made.code}/participants/${caller.json().participantId}/action`,
        { action: "admit" },
        host,
      )
    ).statusCode,
    200,
  );
  const room = (await f.store.get(made.code))!;
  assert.equal(
    room.lifecycle!.deadlineAt! - room.lifecycle!.startedAt,
    10800000,
  );
});

test("Free room capacity is enforced across independent owners and frees only after cleanup", async (t) => {
  const f = await fixture(t);
  f.config.freeMaxActiveRooms = 1;
  assert.equal(
    (await f.internal("entitlements", freeGrant(f))).statusCode,
    200,
  );
  const first = (await f.create()).json();
  const firstHost = await f.exchange(first.code, first.hostToken);
  const accountId = randomUUID();
  const billingOwnerId = randomUUID();
  assert.equal(
    (
      await f.internal("entitlements", {
        ...freeGrant(f),
        billingOwnerId,
        hostAccountIds: [accountId],
      })
    ).statusCode,
    200,
  );
  const secondResponse = await f.create({
    accountId,
    billingOwnerId,
    operationId: randomUUID(),
  });
  assert.equal(secondResponse.statusCode, 200);
  const second = secondResponse.json();
  const denied = await f.browser(`/api/meetings/${second.code}/host`, {
    token: second.hostToken,
  });
  assert.equal(denied.statusCode, 503);
  assert.equal((await f.store.get(second.code))!.lifecycle, undefined);
  assert(
    [200, 202].includes(
      (await f.browser(`/api/meetings/${first.code}/end`, {}, firstHost))
        .statusCode,
    ),
  );
  await f.tick();
  assert.equal(
    (await f.store.get(first.code))!.lifecycle?.cleanupConfirmed,
    true,
  );
  assert.equal(
    (
      await f.browser(`/api/meetings/${second.code}/host`, {
        token: second.hostToken,
      })
    ).statusCode,
    200,
  );
});

test("paid meeting durations update to 24/30 hours and paid-to-Free downgrade ends the room", async (t) => {
  const f = await fixture(t);
  const personal = {
    ...f.grant,
    revision: 2,
    limits: {
      participants: 100,
      durationSeconds: 86400,
      concurrentMeetings: 1,
    },
  };
  assert.equal((await f.internal("entitlements", personal)).statusCode, 200);
  const made = (await f.create()).json();
  await f.exchange(made.code, made.hostToken);
  const started = (await f.store.get(made.code))!.lifecycle!;
  assert.equal(started.deadlineAt! - started.startedAt, 86400000);
  const teams = {
    ...personal,
    revision: 3,
    limits: {
      participants: 100,
      webinarParticipants: 1010,
      durationSeconds: 108000,
      concurrentMeetings: 1,
    },
  };
  assert.equal((await f.internal("entitlements", teams)).statusCode, 200);
  assert.equal(
    (await f.store.get(made.code))!.lifecycle!.deadlineAt! - started.startedAt,
    108000000,
  );
  assert.equal(
    (await f.internal("entitlements", freeGrant(f, 4))).statusCode,
    200,
  );
  assert.equal((await f.store.get(made.code))!.ended, true);
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

test(
  "hosted creator reclaim keeps succession until final exchange and preserves one occurrence",
  { timeout: 15000 },
  async (t) => {
    const f = await fixture(t);
    const made = (await f.create()).json();
    const path = `/api/meetings/${made.code}`;
    const oldCookie = await f.exchange(made.code, made.hostToken);
    const joined = await f.browser(`${path}/join`, {
      name: "Successor",
      password: settings.password,
    });
    assert.equal(joined.statusCode, 200, joined.body);
    const guestId = joined.json().participantId;
    const guestCookie = joined.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    assert.equal(
      (
        await f.browser(
          `${path}/participants/${guestId}/action`,
          { action: "admit" },
          oldCookie,
        )
      ).statusCode,
      200,
    );
    const granted = await f.app.inject({
      method: "PUT",
      url: `${path}/participants/${guestId}/moderator`,
      headers: {
        origin,
        "x-requested-with": "MeetingPlatform",
        cookie: oldCookie,
      },
      payload: { enabled: true },
    });
    assert.equal(granted.statusCode, 200, granted.body);
    const before = (await f.store.get(made.code))!;
    const host = before.participants.find((p) => p.role === "host")!;
    const handoff = {
      participantId: guestId,
      grantRevision: before.participants.find((p) => p.id === guestId)!
        .moderator!.revision,
      expectedRevision: before.hostControl!.revision,
      requestId: randomUUID(),
    };
    assert.equal(
      (await f.browser(`${path}/handoff`, handoff, oldCookie)).statusCode,
      200,
    );
    const delegated = (await f.store.get(made.code))!.hostControl;
    assert.equal(
      (
        await f.internal("meetings/status", {
          accountId: f.accountId,
          version: 1,
        })
      ).json().meetings[0].status,
      "active",
    );
    const issued = await f.internal(`meetings/${made.code}/host-reentry`, {
      accountId: f.accountId,
      version: 1,
      billingOwnerId: f.billingOwnerId,
      requestId: randomUUID(),
      expectedRevision: 0,
    });
    assert.equal(issued.statusCode, 200, issued.body);
    assert.deepEqual((await f.store.get(made.code))!.hostControl, delegated);
    f.media.failRemove = true;
    assert.equal(
      (await f.browser(`${path}/host`, { token: issued.json().hostToken }))
        .statusCode,
      503,
    );
    assert.deepEqual((await f.store.get(made.code))!.hostControl, delegated);
    assert.equal(
      (await f.browser(`${path}/state`, undefined, guestCookie)).json().meeting
        .canEnd,
      true,
    );
    f.media.failRemove = false;
    const newCookie = await f.exchange(made.code, issued.json().hostToken);
    const after = (await f.store.get(made.code))!;
    assert.equal(after.hostControl?.handoff, undefined);
    assert.deepEqual(after.lifecycle, before.lifecycle);
    assert.deepEqual(after.hosted, before.hosted);
    assert.deepEqual(
      after.participants.filter((p) => p.role === "host").map((p) => p.id),
      [host.id],
    );
    assert.equal(after.participants.length, before.participants.length);
    assert.equal(
      after.participants.find((p) => p.id === guestId)!.status,
      "admitted",
    );
    assert.equal(
      (await f.browser(`${path}/state`, undefined, oldCookie)).statusCode,
      401,
    );
    assert.equal(
      (await f.browser(`${path}/end`, {}, guestCookie)).statusCode,
      403,
    );
    assert.equal(
      (await f.browser(`${path}/handoff`, handoff, newCookie)).statusCode,
      409,
    );
    assert.equal(f.media.removed.includes(guestId), false);
    assert.equal((await f.authority(2, false)).statusCode, 200);
    assert.equal((await f.store.get(made.code))!.ended, true);
    assert.equal(
      (await f.browser(`${path}/state`, undefined, newCookie)).statusCode,
      401,
    );
  },
);
