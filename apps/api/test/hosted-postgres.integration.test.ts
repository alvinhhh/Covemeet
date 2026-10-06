import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import pg from "pg";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { PgStore, type Meeting, type Participant } from "../src/store.js";
import { LiveMedia, type Media } from "../src/media.js";
import {
  completeMediaFence,
  fenceParticipantMedia,
  mediaIdentity,
} from "../src/media-identity.js";

const databaseUrl = process.env.PHONE_TEST_DATABASE_URL;
const origin = "http://localhost:5173";
const creationKey = "hosted-pg-fixture-creation-key-over-32-characters";
const internalHeaders = {
  authorization: `Bearer ${creationKey}`,
  "x-requested-with": "MeetingPlatformHosted",
};
const browserHeaders = { origin, "x-requested-with": "MeetingPlatform" };
const meeting = {
  title: "Authority fixture",
  hostName: "Synthetic host",
  password: "synthetic-meeting-passphrase",
  mode: "meeting",
};

class CleanupMedia implements Media {
  available = true;
  failing = false;
  async token(_meeting: Meeting, participant: Participant) {
    return `fixture-${participant.id}`;
  }
  async remove() {
    if (this.failing) throw new Error("Synthetic cleanup failure");
  }
  async end() {
    if (this.failing) throw new Error("Synthetic cleanup failure");
  }
  close() {}
}

async function fixture(t: TestContext) {
  const url = new URL(databaseUrl!);
  assert.ok(
    ["127.0.0.1", "localhost", "phone-postgres"].includes(url.hostname),
  );
  assert.equal(
    url.pathname,
    "/covemeet_phone_test",
    "Disposable database required",
  );
  const config = loadConfig({
    NODE_ENV: "test",
    EDITION: "hosted",
    SITE_ORIGIN: origin,
    SESSION_SECRET: "hosted-pg-fixture-session-secret-over-32-characters",
    CREATION_KEY: creationKey,
    DATABASE_URL: databaseUrl,
    LIVEKIT_API_KEY: "fixture-key",
    LIVEKIT_API_SECRET: "hosted-pg-fixture-media-secret-over-32-characters",
    RECORDING_ENABLED: "false",
  });
  const stores = [
    new PgStore(databaseUrl!),
    new PgStore(databaseUrl!),
  ] as const;
  const media = [new CleanupMedia(), new CleanupMedia()] as const;
  const accounts: string[] = [];
  // Initialize sequentially; the behavior under test is concurrent application
  // transactions, not concurrent schema bootstrap.
  for (const store of stores) await store.init();
  const apps = await Promise.all(
    stores.map((store, i) => createApp(config, store, media[i]!)),
  );
  t.after(async () => {
    await Promise.all(apps.map((app) => app.close()));
    const cleanup = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await cleanup.query(
        "DELETE FROM audit_events WHERE meeting_code IN (SELECT code FROM meetings WHERE data->'hosted'->>'accountId'=ANY($1::text[]))",
        [accounts],
      );
      await cleanup.query(
        "DELETE FROM meetings WHERE data->'hosted'->>'accountId'=ANY($1::text[])",
        [accounts],
      );
      await cleanup.query(
        "DELETE FROM hosted_usage WHERE billing_owner_id=ANY($1::uuid[])",
        [accounts],
      );
      await cleanup.query(
        "DELETE FROM hosted_entitlements WHERE billing_owner_id=ANY($1::uuid[])",
        [accounts],
      );
      await cleanup.query(
        "DELETE FROM hosted_authorities WHERE account_id=ANY($1::uuid[])",
        [accounts],
      );
    } finally {
      await cleanup.end();
    }
  });
  const account = () => {
    const id = randomUUID();
    accounts.push(id);
    return id;
  };
  const provisioned = new Map<string, Promise<unknown>>();
  const create = async (
    index: number,
    accountId: string,
    operationId: string,
    version = 1,
    settings = meeting,
  ) => {
    const owner = accountId.toLowerCase();
    if (!provisioned.has(owner))
      provisioned.set(
        owner,
        stores[0].setHostedEntitlement({
          billingOwnerId: owner,
          revision: 1,
          validUntil: Date.now() + 300000,
          enabled: true,
          quota: {
            anchorAt: Date.UTC(2026, 0, 31),
            participantSecondsPerMonth: 360000,
          },
          hostAccountIds: [owner],
          limits: {
            participants: 100,
            durationSeconds: 7200,
            concurrentMeetings: 1,
          },
        }),
      );
    await provisioned.get(owner);
    return apps[index]!.inject({
      method: "POST",
      url: "/api/internal/hosted/meetings",
      headers: internalHeaders,
      payload: {
        accountId,
        billingOwnerId: owner,
        version,
        operationId,
        meeting: settings,
      },
    });
  };
  const authority = (
    index: number,
    accountId: string,
    version: number,
    enabled: boolean,
  ) =>
    apps[index]!.inject({
      method: "POST",
      url: "/api/internal/hosted/authority",
      headers: internalHeaders,
      payload: { accountId, version, enabled },
    });
  return { stores, media, apps, account, create, authority, config };
}

test(
  "PostgreSQL host re-entry serializes revision replacement and preserves one start reservation",
  { skip: !databaseUrl, timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const owner = f.account();
    const made = await f.create(0, owner, randomUUID());
    assert.equal(made.statusCode, 200, made.body);
    const { code, hostToken } = made.json();
    const path = `/api/internal/hosted/meetings/${code}/host-reentry`;
    const issue = (
      index: number,
      requestId: string,
      expectedRevision: number,
    ) =>
      f.apps[index]!.inject({
        method: "POST",
        url: path,
        headers: internalHeaders,
        payload: {
          accountId: owner,
          version: 1,
          billingOwnerId: owner,
          requestId,
          expectedRevision,
        },
      });
    const requests = [randomUUID(), randomUUID()];
    const first = await Promise.all(
      requests.map((requestId, index) => issue(index, requestId, 0)),
    );
    assert.deepEqual(first.map((r) => r.statusCode).sort(), [200, 409]);
    const winner = first.findIndex((r) => r.statusCode === 200);
    const replaced = await issue(1 - winner, randomUUID(), 1);
    assert.equal(replaced.statusCode, 200, replaced.body);
    assert.equal((await issue(winner, requests[winner]!, 0)).statusCode, 409);
    const host = (index: number, token: string) =>
      f.apps[index]!.inject({
        method: "POST",
        url: `/api/meetings/${code}/host`,
        headers: browserHeaders,
        payload: { token },
      });
    assert.equal((await host(0, hostToken)).statusCode, 403);
    assert.equal(
      (await host(winner, first[winner]!.json().hostToken)).statusCode,
      403,
    );
    const started = await host(1 - winner, replaced.json().hostToken);
    assert.equal(started.statusCode, 200, started.body);
    const before = (await f.stores[0].get(code))!;
    assert.equal(before.hostReentryRevision, 2);
    assert.equal(before.hostReentry?.phase, "consumed");
    const other = await f.create(1, owner, randomUUID());
    assert.equal(other.statusCode, 200, other.body);
    assert.equal(
      (
        await f.apps[1].inject({
          method: "POST",
          url: `/api/meetings/${other.json().code}/host`,
          headers: browserHeaders,
          payload: { token: other.json().hostToken },
        })
      ).statusCode,
      409,
    );
    const reentry = await issue(0, randomUUID(), 2);
    assert.equal(reentry.statusCode, 200, reentry.body);
    assert.equal((await host(1, reentry.json().hostToken)).statusCode, 200);
    const after = (await f.stores[1].get(code))!;
    assert.equal(after.lifecycle?.startedAt, before.lifecycle?.startedAt);
    assert.equal(after.participants.length, before.participants.length);
    assert.equal(after.hostReentryRevision, 3);
    const staleAuthority = await issue(0, randomUUID(), 3);
    assert.equal(staleAuthority.statusCode, 200, staleAuthority.body);
    const revoked = await f.authority(1, owner, 2, false);
    assert.ok([200, 202].includes(revoked.statusCode), revoked.body);
    assert.notEqual(
      (await host(0, staleAuthority.json().hostToken)).statusCode,
      200,
    );
    assert.notEqual((await issue(1, randomUUID(), 4)).statusCode, 200);

    const otherOwner = f.account();
    const otherMade = await f.create(0, otherOwner, randomUUID());
    assert.equal(otherMade.statusCode, 200, otherMade.body);
    const otherCode = otherMade.json().code;
    assert.equal(
      (
        await f.apps[0].inject({
          method: "POST",
          url: `/api/meetings/${otherCode}/host`,
          headers: browserHeaders,
          payload: { token: otherMade.json().hostToken },
        })
      ).statusCode,
      200,
    );
    const otherPath = `/api/internal/hosted/meetings/${otherCode}/host-reentry`;
    const pending = await f.apps[1].inject({
      method: "POST",
      url: otherPath,
      headers: internalHeaders,
      payload: {
        accountId: otherOwner,
        version: 1,
        billingOwnerId: otherOwner,
        requestId: randomUUID(),
        expectedRevision: 0,
      },
    });
    assert.equal(pending.statusCode, 200, pending.body);
    const grant = (
      await f.stores[1].pool.query(
        "SELECT data FROM hosted_entitlements WHERE billing_owner_id=$1",
        [otherOwner],
      )
    ).rows[0].data;
    await f.stores[1].setHostedEntitlement({
      ...grant,
      revision: 2,
      enabled: false,
    });
    assert.notEqual(
      (
        await f.apps[0].inject({
          method: "POST",
          url: `/api/meetings/${otherCode}/host`,
          headers: browserHeaders,
          payload: { token: pending.json().hostToken },
        })
      ).statusCode,
      200,
    );
  },
);

test(
  "PostgreSQL pooled participant claims serialize across APIs and retain unknown media after process restart",
  { skip: !databaseUrl, timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      owner = f.account();
    const created = await f.create(0, owner, randomUUID());
    assert.equal(created.statusCode, 200, created.body);
    const { code, hostToken } = created.json();
    const grant = (
      await f.stores[0].pool.query(
        "SELECT data FROM hosted_entitlements WHERE billing_owner_id=$1",
        [owner],
      )
    ).rows[0].data;
    await f.stores[0].setHostedEntitlement({
      ...grant,
      revision: 2,
      quota: { ...grant.quota, participantSecondsPerMonth: 30 },
    });
    const started = await f.apps[0].inject({
      method: "POST",
      url: `/api/meetings/${code}/host`,
      headers: browserHeaders,
      payload: { token: hostToken },
    });
    assert.equal(started.statusCode, 200, started.body);
    const guestId = randomUUID();
    await f.stores[0].change(code, (m) => {
      m.participants.push({
        ...m.participants[0]!,
        id: guestId,
        name: "Guest",
        role: "participant",
      });
    });
    const hostId = started.json().participantId;
    const claims = await Promise.allSettled(
      [hostId, guestId].map((participantId, i) =>
        f.stores[i]!.updateParticipantMeter(code, {
          participantId,
          mediaVersion: 1,
          connectionId: `fixture-${i}`,
          action: "claim",
        }),
      ),
    );
    assert.equal(claims.filter((r) => r.status === "fulfilled").length, 1);
    assert.deepEqual(
      (await f.stores[0].hostedUsage(owner)).participantSeconds,
      { limit: 30, used: 0, reserved: 30, available: 0 },
    );
    const current = (await f.stores[0].get(code)) as Meeting;
    const winner = current.participants.find((p) => p.meter)!;
    await f.stores[0].updateParticipantMeter(code, {
      participantId: winner.id,
      mediaVersion: 1,
      connectionId: winner.meter!.connectionId,
      action: "connected",
    });
    await f.stores[0].change(code, (m) => {
      m.participants.find((p) => p.id === winner.id)!.meter!.presenceUntil =
        Date.now() - 1;
    });
    const restarted = new PgStore(databaseUrl!);
    t.after(() => restarted.close());
    await restarted.reconcileParticipantMeters(code);
    const pending = await restarted.hostedUsage(owner);
    assert.equal(pending.blocked, true);
    assert.ok(pending.participantSeconds.reserved > 0);
    await assert.rejects(
      f.stores[1].updateParticipantMeter(code, {
        participantId: winner.id === hostId ? guestId : hostId,
        mediaVersion: 1,
        connectionId: "late",
        action: "claim",
      }),
      /allowance is unavailable/,
    );
    const fenced = ((await restarted.get(code)) as Meeting).participants.find(
      (p) => p.id === winner.id,
    )!;
    await restarted.settleParticipantMeter(
      code,
      fenced.id,
      fenced.mediaVersion,
      fenced.meter,
    );
    const released = await f.stores[1].hostedUsage(owner);
    assert.equal(released.participantSeconds.reserved, 0);
    assert.equal(released.blocked, false);
    await assert.rejects(
      restarted.setHostedEntitlement({
        ...grant,
        revision: 3,
        quota: { ...grant.quota, anchorAt: grant.quota.anchorAt + 1 },
      }),
      /anniversary cannot change/,
    );
  },
);

test(
  "PostgreSQL meeting reservations serialize per room across pools and survive a process restart",
  { skip: !databaseUrl, timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      owner = f.account(),
      member = f.account();
    const first = (await f.create(0, owner, randomUUID())).json();
    const grant = (
      await f.stores[0].pool.query(
        "SELECT data FROM hosted_entitlements WHERE billing_owner_id=$1",
        [owner],
      )
    ).rows[0].data;
    await f.stores[0].setHostedEntitlement({
      ...grant,
      revision: 2,
      hostAccountIds: [owner, member],
      quota: {
        ...grant.quota,
        metering: "meeting",
        participantSecondsPerMonth: 45,
      },
      limits: { ...grant.limits, concurrentMeetings: 2 },
    });
    const secondReply = await f.apps[1].inject({
      method: "POST",
      url: "/api/internal/hosted/meetings",
      headers: internalHeaders,
      payload: {
        accountId: member,
        billingOwnerId: owner,
        version: 1,
        operationId: randomUUID(),
        meeting,
      },
    });
    assert.equal(secondReply.statusCode, 200, secondReply.body);
    const second = secondReply.json();
    for (const [i, row] of [first, second].entries()) {
      const started = await f.apps[i]!.inject({
        method: "POST",
        url: `/api/meetings/${row.code}/host`,
        headers: browserHeaders,
        payload: { token: row.hostToken },
      });
      assert.equal(started.statusCode, 200, started.body);
    }
    await f.stores[0].change(first.code, (m) => {
      m.participants.push({
        ...m.participants[0]!,
        id: randomUUID(),
        name: "Guest",
        role: "participant",
      });
    });
    const peers = (
      await Promise.all(
        [first, second].map(async ({ code }) => {
          const m = (await f.stores[0].get(code))!;
          return m.participants.map((p) => ({
            code,
            participantId: p.id,
            mediaVersion: p.mediaVersion,
            connectionId: randomUUID(),
          }));
        }),
      )
    ).flat();
    const claimed = await Promise.allSettled(
      peers.map((p, i) =>
        f.stores[i % 2]!.updateParticipantMeter(p.code, {
          ...p,
          action: "claim",
        }),
      ),
    );
    assert.equal(claimed.filter((r) => r.status === "fulfilled").length, 3);
    const before = await f.stores[1].hostedUsage(owner);
    assert.equal(before.metering, "meeting");
    assert.deepEqual(before.participantSeconds, {
      limit: 45,
      used: 0,
      reserved: 45,
      available: 0,
    });
    for (const p of peers)
      await f.stores[0].updateParticipantMeter(p.code, {
        ...p,
        action: "connected",
      });
    for (const { code } of [first, second])
      await f.stores[0].change(code, (m) => {
        for (const p of m.participants) p.meter!.presenceUntil = Date.now() - 1;
      });
    const restarted = new PgStore(databaseUrl!);
    t.after(() => restarted.close());
    for (const { code } of [first, second])
      await restarted.reconcileParticipantMeters(code);
    const held = await restarted.hostedUsage(owner);
    assert.equal(held.blocked, true);
    assert.ok(held.participantSeconds.reserved > 0);
    for (const { code } of [first, second]) {
      const m = (await restarted.get(code))!;
      for (const p of m.participants)
        await restarted.settleParticipantMeter(
          code,
          p.id,
          p.mediaVersion,
          p.meter,
        );
      assert.equal((await restarted.get(code))!.meetingMeter, undefined);
    }
    const released = await f.stores[1].hostedUsage(owner);
    assert.equal(released.blocked, false);
    assert.equal(released.participantSeconds.reserved, 0);
    const ledger = (
      await f.stores[0].pool.query(
        "SELECT data FROM hosted_usage WHERE billing_owner_id=$1",
        [owner],
      )
    ).rows[0].data;
    assert.ok(
      ledger.windows.every(
        (w: { usedMs: number; meetingUsedMs?: number }) =>
          w.usedMs === 0 && (w.meetingUsedMs ?? 0) <= 45000,
      ),
    );
  },
);

test(
  "PostgreSQL duplicate hosted creation returns one unused capability across pools",
  { skip: !databaseUrl, timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      accountId = f.account(),
      operationId = randomUUID();
    const replies = await Promise.all([
      f.create(0, accountId, operationId),
      f.create(1, accountId, operationId),
    ]);
    for (const reply of replies)
      assert.equal(reply.statusCode, 200, reply.body);
    const first = replies[0]!.json();
    assert.equal(replies[1]!.json().code, first.code);
    assert.equal(replies[1]!.json().hostToken, first.hostToken);
    const rows = await f.stores[0].pool.query(
      "SELECT data FROM meetings WHERE data->'hosted'->>'accountId'=$1",
      [accountId],
    );
    assert.equal(rows.rowCount, 1);
    assert.ok(
      !JSON.stringify(rows.rows[0]).includes(first.hostToken),
      "Capability is never persisted in plaintext",
    );
    assert.ok(
      !JSON.stringify(rows.rows[0]).includes(meeting.password),
      "Meeting password is never persisted in plaintext",
    );
    const aliased = await f.create(
      1,
      accountId.toUpperCase(),
      operationId.toUpperCase(),
    );
    assert.ok([200, 400].includes(aliased.statusCode), aliased.body);
    if (aliased.statusCode === 200) {
      assert.equal(
        aliased.json().code,
        first.code,
        "UUID spelling cannot create another operation",
      );
      assert.equal(aliased.json().hostToken, first.hostToken);
    }
    assert.equal(
      (
        await f.create(1, accountId, operationId, 1, {
          ...meeting,
          title: "Changed request",
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (await f.create(1, accountId, randomUUID(), 2)).statusCode,
      409,
      "Creation cannot advance an existing authority",
    );
    const exchanges = await Promise.all(
      f.apps.map((app) =>
        app.inject({
          method: "POST",
          url: `/api/meetings/${first.code}/host`,
          headers: browserHeaders,
          payload: { token: first.hostToken },
        }),
      ),
    );
    assert.equal(
      exchanges.filter((r) => r.statusCode === 200).length,
      1,
      "Host exchange is single-use across pools",
    );
    assert.equal(
      exchanges.filter((r) => r.statusCode >= 400 && r.statusCode < 500).length,
      1,
    );
    const consumed = await f.create(0, accountId, operationId);
    assert.equal(consumed.statusCode, 409);
    assert.ok(!consumed.body.includes(first.hostToken));
  },
);

test(
  "PostgreSQL revocation commits before cleanup and retry cannot restore old sessions",
  { skip: !databaseUrl, timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      accountId = f.account(),
      operationId = randomUUID();
    const created = await f.create(0, accountId, operationId);
    assert.equal(created.statusCode, 200, created.body);
    const { code, hostToken } = created.json();
    const exchanged = await f.apps[0]!.inject({
      method: "POST",
      url: `/api/meetings/${code}/host`,
      headers: browserHeaders,
      payload: { token: hostToken },
    });
    assert.equal(exchanged.statusCode, 200, exchanged.body);
    const cookie = exchanged.cookies
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    const live = new LiveMedia(f.config, f.stores[1]);
    t.after(() => live.close());
    const before = (await f.stores[0].get(code))!;
    const jwt = await live.token(
      before,
      before.participants.find((p) => p.role === "host")!,
    );
    await live.authorize(jwt);
    f.media.forEach((m) => {
      m.failing = true;
    });
    const pending = await f.authority(1, accountId, 2, false);
    assert.equal(
      pending.statusCode,
      202,
      "Restriction is committed while cleanup remains pending",
    );
    assert.equal(pending.json().cleanupPending, true);
    const revoked = (await f.stores[0].get(code))!;
    assert.equal(revoked.ended, true);
    assert.equal(revoked.hosted?.revoked, true);
    assert.equal(revoked.hostTokenHash, undefined);
    assert.ok(revoked.participants.every((p) => p.tokenHash === ""));
    await assert.rejects(live.authorize(jwt), /denied/i);
    const oldHost = await f.apps[0]!.inject({
      method: "POST",
      url: `/api/meetings/${code}/media`,
      headers: { ...browserHeaders, cookie },
      payload: {},
    });
    assert.ok(
      oldHost.statusCode >= 400 && oldHost.statusCode < 500,
      oldHost.body,
    );
    assert.equal((await f.create(0, accountId, operationId)).statusCode, 409);
    assert.equal(
      (await f.create(0, accountId, randomUUID(), 2)).statusCode,
      409,
    );
    assert.equal((await f.authority(0, accountId, 2, true)).statusCode, 409);
    f.media.forEach((m) => {
      m.failing = false;
    });
    let repeated = await f.authority(0, accountId, 2, false);
    const deadline = Date.now() + 12000;
    while (repeated.statusCode === 202 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      repeated = await f.authority(0, accountId, 2, false);
    }
    assert.equal(repeated.statusCode, 200, repeated.body);
    assert.equal(repeated.json().version, 2);
    assert.equal(repeated.json().cleanupPending, false);
    const enabled = await f.authority(1, accountId, 3, true);
    assert.equal(enabled.statusCode, 200, enabled.body);
    const stale = await f.authority(0, accountId, 2, false);
    assert.equal(stale.statusCode, 200, stale.body);
    assert.equal(
      stale.json().version,
      3,
      "Stale delivery reports current authority without rolling it back",
    );
    assert.equal(
      (await f.create(0, accountId, operationId, 3)).statusCode,
      409,
      "Old operation never becomes reusable after reapproval",
    );
    assert.equal(
      (await f.create(1, accountId, randomUUID(), 3)).statusCode,
      200,
    );
    await assert.rejects(live.authorize(jwt), /denied/i);
  },
);

test(
  "PostgreSQL create and authority races retain the highest version and disabled tombstone",
  { skip: !databaseUrl, timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      accountId = f.account(),
      operationId = randomUUID();
    const [created, disabled] = await Promise.all([
      f.create(0, accountId, operationId),
      f.authority(1, accountId, 2, false),
    ]);
    assert.ok([200, 409].includes(created.statusCode), created.body);
    assert.ok([200, 202].includes(disabled.statusCode), disabled.body);
    const rows = (
      await f.stores[0].pool.query(
        "SELECT data FROM meetings WHERE data->'hosted'->>'accountId'=$1",
        [accountId],
      )
    ).rows;
    assert.ok(
      rows.every(({ data }) => data.ended && data.hosted.revoked),
      "A racing create cannot survive suspension",
    );
    assert.equal(
      (await f.create(0, accountId, operationId)).statusCode,
      409,
      "Persisted tombstone blocks stale initialization",
    );
    const replies = await Promise.all([
      f.authority(0, accountId, 3, true),
      f.authority(1, accountId, 4, false),
    ]);
    assert.ok(replies.every((r) => [200, 202].includes(r.statusCode)));
    const authority = (
      await f.stores[0].pool.query(
        "SELECT version,enabled FROM hosted_authorities WHERE account_id=$1",
        [accountId],
      )
    ).rows[0];
    assert.equal(Number(authority.version), 4);
    assert.equal(authority.enabled, false);
    const equal = await Promise.all([
      f.authority(0, accountId, 5, true),
      f.authority(1, accountId, 5, false),
    ]);
    assert.equal(
      equal.filter((r) => [200, 202].includes(r.statusCode)).length,
      1,
    );
    assert.equal(equal.filter((r) => r.statusCode === 409).length, 1);
  },
);

test(
  "PostgreSQL pool and named-host start reservations serialize across two pools and retain unknown cleanup",
  { skip: !databaseUrl, timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const billingOwnerId = f.account(),
      firstHost = f.account(),
      secondHost = f.account();
    await f.stores[0].setHostedEntitlement({
      billingOwnerId,
      revision: 1,
      validUntil: Date.now() + 300000,
      enabled: true,
      quota: {
        anchorAt: Date.UTC(2026, 0, 31),
        participantSecondsPerMonth: 360000,
      },
      hostAccountIds: [firstHost, secondHost],
      limits: {
        participants: 100,
        durationSeconds: 7200,
        concurrentMeetings: 1,
      },
    });
    const make = async (index: number, accountId: string) => {
      const r = await f.apps[index]!.inject({
        method: "POST",
        url: "/api/internal/hosted/meetings",
        headers: internalHeaders,
        payload: {
          accountId,
          billingOwnerId,
          version: 1,
          operationId: randomUUID(),
          meeting,
        },
      });
      assert.equal(r.statusCode, 200, r.body);
      return r.json();
    };
    const one = await make(0, firstHost),
      two = await make(1, secondHost);
    const start = (index: number, made: { code: string; hostToken: string }) =>
      f.apps[index]!.inject({
        method: "POST",
        url: `/api/meetings/${made.code}/host`,
        headers: browserHeaders,
        payload: { token: made.hostToken },
      });
    const replies = await Promise.all([start(0, one), start(1, two)]);
    assert.deepEqual(replies.map((r) => r.statusCode).sort(), [200, 409]);
    const winner = replies.findIndex((r) => r.statusCode === 200),
      loser = 1 - winner;
    const rows = [one, two];
    const live = (await f.stores[1].get(rows[winner].code))!;
    assert.equal(
      live.lifecycle!.deadlineAt! - live.lifecycle!.startedAt,
      7200000,
    );
    f.media.forEach((m) => {
      m.failing = true;
    });
    const cookie = replies[winner]!.cookies.map(
      (c) => `${c.name}=${c.value}`,
    ).join("; ");
    await f.apps[0]!.inject({
      method: "POST",
      url: `/api/meetings/${rows[winner].code}/end`,
      headers: { ...browserHeaders, cookie },
      payload: {},
    });
    assert.equal((await start(loser, rows[loser])).statusCode, 409);
    assert.equal(
      (await f.stores[0].get(rows[winner].code))!.lifecycle!.cleanupConfirmed,
      undefined,
    );
    f.media.forEach((m) => {
      m.failing = false;
    });
    const until = Date.now() + 12000;
    while (
      !(await f.stores[0].get(rows[winner].code))!.lifecycle!
        .cleanupConfirmed &&
      Date.now() < until
    )
      await new Promise((r) => setTimeout(r, 100));
    assert.equal(
      (await f.stores[0].get(rows[winner].code))!.lifecycle!.cleanupConfirmed,
      true,
    );
    assert.equal((await start(loser, rows[loser])).statusCode, 200);
    // Raising the pool cap cannot let one named host reserve two meetings.
    await f.stores[0].setHostedEntitlement({
      billingOwnerId,
      revision: 2,
      validUntil: Date.now() + 300000,
      enabled: true,
      quota: {
        anchorAt: Date.UTC(2026, 0, 31),
        participantSecondsPerMonth: 360000,
      },
      hostAccountIds: [firstHost, secondHost],
      limits: {
        participants: 100,
        durationSeconds: 7200,
        concurrentMeetings: 2,
      },
    });
    const duplicateHost = await make(0, [firstHost, secondHost][loser]!);
    assert.equal((await start(0, duplicateHost)).statusCode, 409);
  },
);

test(
  "PostgreSQL entitlement restrictions win start races and stale allowed-host lists never restore access",
  { skip: !databaseUrl, timeout: 30000 },
  async (t) => {
    const f = await fixture(t);
    const billingOwnerId = f.account(),
      accountId = f.account();
    const grant = {
      billingOwnerId,
      revision: 1,
      validUntil: Date.now() + 300000,
      enabled: true,
      quota: {
        anchorAt: Date.UTC(2026, 0, 31),
        participantSecondsPerMonth: 360000,
      },
      hostAccountIds: [accountId],
      limits: {
        participants: 100,
        durationSeconds: 7200,
        concurrentMeetings: 1,
      },
    };
    await f.stores[0].setHostedEntitlement(grant);
    const payload = {
      accountId,
      billingOwnerId,
      version: 1,
      operationId: randomUUID(),
      meeting,
    };
    const made = await f.apps[0]!.inject({
      method: "POST",
      url: "/api/internal/hosted/meetings",
      headers: internalHeaders,
      payload,
    });
    assert.equal(made.statusCode, 200, made.body);
    const { code, hostToken } = made.json();
    const [started] = await Promise.all([
      f.apps[0]!.inject({
        method: "POST",
        url: `/api/meetings/${code}/host`,
        headers: browserHeaders,
        payload: { token: hostToken },
      }),
      f.stores[1].setHostedEntitlement({
        ...grant,
        revision: 2,
        hostAccountIds: [],
      }),
    ]);
    assert.ok([200, 410].includes(started.statusCode), started.body);
    assert.equal((await f.stores[0].get(code))!.ended, true);
    const stale = await f.stores[0].setHostedEntitlement(grant);
    assert.equal(stale.revision, 2);
    await f.authority(1, accountId, 1, true);
    const denied = await f.apps[0]!.inject({
      method: "POST",
      url: "/api/internal/hosted/meetings",
      headers: internalHeaders,
      payload: { ...payload, operationId: randomUUID() },
    });
    assert.equal(denied.statusCode, 403, denied.body);
    const results = await Promise.allSettled([
      f.stores[0].setHostedEntitlement({ ...grant, revision: 3 }),
      f.stores[1].setHostedEntitlement({
        ...grant,
        revision: 3,
        enabled: false,
      }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(results.filter((r) => r.status === "rejected").length, 1);
    assert.equal(
      (await f.stores[1].get(code))!.ended,
      true,
      "Renewal never revives an ended occurrence",
    );
  },
);

test(
  "PostgreSQL retired identity remains fenced across API ownership loss and delayed physical removal",
  { skip: !databaseUrl, timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      owner = f.account();
    const created = await f.create(0, owner, randomUUID());
    assert.equal(created.statusCode, 200, created.body);
    const { code, hostToken } = created.json();
    const started = await f.apps[0].inject({
      method: "POST",
      url: `/api/meetings/${code}/host`,
      headers: browserHeaders,
      payload: { token: hostToken },
    });
    assert.equal(started.statusCode, 200, started.body);
    const id = started.json().participantId;
    const firstConnection = randomUUID();
    await f.stores[0].updateParticipantMeter(code, {
      participantId: id,
      mediaVersion: 1,
      connectionId: firstConnection,
      action: "claim",
    });
    const retired = await f.stores[0].change(code, (m) => {
      fenceParticipantMedia(m, m.participants[0]!);
      return structuredClone(m);
    });
    const snapshot = (await f.stores[1].get(code))!;
    assert.equal(snapshot.participants[0]!.previousMediaIdentity, id);
    const mediaA = new LiveMedia(f.config, f.stores[0]),
      mediaB = new LiveMedia(f.config, f.stores[1]);
    t.after(() => {
      mediaA.close();
      mediaB.close();
    });
    const peers = new Set([id]);
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requested = new Promise<void>((resolve) => {
      entered = resolve;
    });
    t.after(release);
    mediaA.client.removeParticipant = async (_room, identity) => {
      peers.delete(identity);
    };
    mediaB.client.removeParticipant = async (_room, identity) => {
      entered();
      await gate;
      peers.delete(identity);
    };
    const delayed = mediaB.remove(snapshot, snapshot.participants[0]!);
    await requested;
    // Closing this API's DB pool cannot cancel a request already accepted by the provider.
    await f.apps[1].close();
    await mediaA.remove(retired, retired.participants[0]!);
    const old = retired.participants[0]!;
    await f.stores[0].settleParticipantMeter(
      code,
      id,
      old.mediaVersion,
      old.meter,
    );
    await f.stores[0].change(code, (m) => {
      assert.equal(completeMediaFence(m.participants[0]!, old), true);
    });
    const nextConnection = randomUUID();
    const current = await f.stores[0].updateParticipantMeter(code, {
      participantId: id,
      mediaVersion: old.mediaVersion,
      connectionId: nextConnection,
      action: "claim",
    });
    const successor = current.participant;
    peers.add(mediaIdentity(successor));
    release();
    await delayed;
    assert.deepEqual([...peers], [mediaIdentity(successor)]);
    // Old accounting proof also cannot release the replacement's reservation.
    await f.stores[0].settleParticipantMeter(
      code,
      id,
      old.mediaVersion,
      old.meter,
    );
    const preserved = (await f.stores[0].get(code))!.participants[0]!;
    assert.equal(preserved.meter!.connectionId, nextConnection);
    assert.equal(preserved.enforcementPending, false);
    assert.equal(
      preserved.meter!.fundedUntil - preserved.meter!.accountedAt,
      30000,
    );
  },
);

test(
  "PostgreSQL recording starts share an immutable owner pool across rooms, retries and restarts",
  { skip: !databaseUrl, timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      owner = f.account(),
      otherOwner = f.account();
    const first = await f.create(0, owner, randomUUID());
    const second = await f.create(1, owner, randomUUID());
    const other = await f.create(0, otherOwner, randomUUID());
    for (const response of [first, second, other])
      assert.equal(response.statusCode, 200, response.body);
    const codes = [first.json().code, second.json().code];
    const grants = await f.stores[0].pool.query(
      "SELECT data FROM hosted_entitlements WHERE billing_owner_id=ANY($1::uuid[])",
      [[owner, otherOwner]],
    );
    for (const { data: grant } of grants.rows)
      await f.stores[0].setHostedEntitlement({
        ...grant,
        revision: 2,
        enabled: false,
        validUntil: Date.now() - 1,
        quota: { ...grant.quota, downloadBytesPerMonth: 100 },
      });
    const starts = await Promise.allSettled(
      codes.map((code, i) =>
        f.stores[i]!.debitRecordingDownload(code, 60, (m) => {
          assert.equal(m.ended, true);
          assert.equal(m.hosted!.billingOwnerId, owner);
        }),
      ),
    );
    assert.equal(
      starts.filter((result) => result.status === "fulfilled").length,
      1,
    );
    assert.deepEqual(
      (await f.stores[1].hostedUsage(owner)).recordingDownloadBytes,
      { limit: 100, used: 60, available: 40 },
    );
    const restarted = new PgStore(databaseUrl!);
    t.after(() => restarted.close());
    await restarted.debitRecordingDownload(codes[0], 40, () => {});
    await assert.rejects(
      f.stores[0].debitRecordingDownload(codes[1], 1, () => {}),
      { code: "RECORDING_DOWNLOAD_QUOTA_UNAVAILABLE" },
    );
    assert.deepEqual(
      (await restarted.hostedUsage(owner)).recordingDownloadBytes,
      { limit: 100, used: 100, available: 0 },
    );
    assert.deepEqual(
      (await restarted.hostedUsage(otherOwner)).recordingDownloadBytes,
      { limit: 100, used: 0, available: 100 },
    );
    await f.stores[0].change(other.json().code, (m) => {
      m.hosted!.revoked = true;
    });
    await assert.rejects(
      restarted.debitRecordingDownload(other.json().code, 1, () => {}),
      /Recording access denied/,
    );
    assert.equal(
      (await restarted.hostedUsage(otherOwner)).recordingDownloadBytes.used,
      0,
    );
  },
);

test(
  "PostgreSQL recording time reuses its reserved connection and retains pooled unknown jobs across restart",
  { skip: !databaseUrl, timeout: 30000 },
  async (t) => {
    const at = Date.now();
    t.mock.timers.enable({ apis: ["Date"], now: at });
    const f = await fixture(t),
      owner = f.account();
    const first = await f.create(0, owner, randomUUID());
    const second = await f.create(1, owner, randomUUID());
    for (const response of [first, second])
      assert.equal(response.statusCode, 200, response.body);
    const codes = [first.json().code, second.json().code];
    const grant = (
      await f.stores[0].pool.query(
        "SELECT data FROM hosted_entitlements WHERE billing_owner_id=$1",
        [owner],
      )
    ).rows[0]!.data;
    await f.stores[0].setHostedEntitlement({
      ...grant,
      revision: 2,
      quota: {
        ...grant.quota,
        recordingSecondsPerMonth: 30,
        storageBytes: 1000,
      },
    });
    for (const code of codes)
      await f.stores[0].change(code, (m) => {
        m.recordingAllowed = true;
      });

    const narrow = async () => {
      const store = new PgStore(databaseUrl!);
      await store.pool.end();
      store.pool = new pg.Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 1000,
      });
      t.after(() => store.close());
      return store;
    };
    const stores = await Promise.all([narrow(), narrow()]);
    const ids = [randomUUID(), randomUUID()];
    const starts = await Promise.allSettled(
      stores.map((store, index) =>
        store.withRecordingLock(codes[index], ids[index]!, (lock) =>
          lock.reserveRecording(
            { id: ids[index]!, status: "starting", createdAt: at },
            (m) => {
              assert.equal(m.hosted!.billingOwnerId, owner);
            },
            { maxBytes: 100, copies: 1 },
          ),
        ),
      ),
    );
    assert.equal(starts.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(starts.filter((r) => r.status === "rejected").length, 1);
    assert.deepEqual((await f.stores[0].hostedUsage(owner)).recordingSeconds, {
      limit: 30,
      used: 0,
      reserved: 30,
      available: 0,
    });
    const winner = starts.findIndex((r) => r.status === "fulfilled"),
      code = codes[winner],
      id = ids[winner]!;
    const restarted = await narrow();
    t.mock.timers.tick(45000);
    const checked = await restarted.withRecordingLock(code, id, (lock) =>
      lock.checkRecordingTime(),
    );
    assert.equal(checked.acquired && checked.value.mustStop, true);
    assert.deepEqual((await restarted.hostedUsage(owner)).recordingSeconds, {
      limit: 30,
      used: 0,
      reserved: 45,
      available: 0,
    });
    const proof = {
      egressId: "restart-recovered-job",
      terminal: true as const,
      startedAt: at,
      endedAt: at + 12345,
    };
    await restarted.withRecordingLock(code, id, (lock) =>
      lock.observeRecordingTime(proof),
    );
    // A different API sees the terminal tombstone before the service changes file state.
    const replay = await stores[1]!.withRecordingLock(
      code,
      id,
      async (lock) => {
        assert.equal((await lock.checkRecordingTime()).mustStop, true);
        return lock.observeRecordingTime(proof);
      },
    );
    assert.equal(replay.acquired && replay.value.mustStop, false);
    await assert.rejects(
      stores[0]!.withRecordingLock(code, id, (lock) =>
        lock.observeRecordingTime({ ...proof, endedAt: at + 12000 }),
      ),
      /settlement changed/,
    );
    assert.deepEqual((await restarted.hostedUsage(owner)).recordingSeconds, {
      limit: 30,
      used: 13,
      reserved: 0,
      available: 17,
    });
    const ledger = (
      await restarted.pool.query(
        "SELECT data FROM hosted_usage WHERE billing_owner_id=$1",
        [owner],
      )
    ).rows[0]!.data;
    assert.equal(
      ledger.windows.reduce(
        (sum: number, row: { recordingUsedMs?: number }) =>
          sum + (row.recordingUsedMs ?? 0),
        0,
      ),
      12345,
    );
  },
);

test(
  "PostgreSQL storage reserves once across pools and keeps uncertain copies across restart and downgrade",
  { skip: !databaseUrl, timeout: 30000 },
  async (t) => {
    const f = await fixture(t),
      owner = f.account(),
      otherOwner = f.account();
    const created = await Promise.all([
      f.create(0, owner, randomUUID()),
      f.create(1, owner, randomUUID()),
      f.create(0, otherOwner, randomUUID()),
    ]);
    for (const response of created)
      assert.equal(response.statusCode, 200, response.body);
    const codes = created.map((r) => r.json().code);
    const grant = (
      await f.stores[0].pool.query(
        "SELECT data FROM hosted_entitlements WHERE billing_owner_id=$1",
        [owner],
      )
    ).rows[0]!.data;
    await f.stores[0].setHostedEntitlement({
      ...grant,
      revision: 2,
      quota: {
        ...grant.quota,
        storageBytes: 1000,
        recordingSecondsPerMonth: 3600,
      },
    });
    for (const code of codes)
      await f.stores[0].change(code, (m) => {
        m.recordingAllowed = true;
      });
    const narrow = async () => {
      const store = new PgStore(databaseUrl!);
      await store.pool.end();
      store.pool = new pg.Pool({
        connectionString: databaseUrl,
        max: 1,
        connectionTimeoutMillis: 1000,
      });
      t.after(() => store.close());
      return store;
    };
    const stores = await Promise.all([narrow(), narrow()]),
      ids = [randomUUID(), randomUUID()];
    const starts = await Promise.allSettled(
      stores.map((store, i) =>
        store.withRecordingLock(codes[i], ids[i]!, (lock) =>
          lock.reserveRecording(
            { id: ids[i]!, status: "starting", createdAt: Date.now() },
            () => {},
            { maxBytes: 1000, copies: 1 },
          ),
        ),
      ),
    );
    assert.equal(starts.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(starts.filter((r) => r.status === "rejected").length, 1);
    const index = starts.findIndex((r) => r.status === "fulfilled"),
      code = codes[index]!,
      id = ids[index]!;
    assert.deepEqual(
      (await f.stores[0].hostedUsage(owner)).recordingStorageBytes,
      { limit: 1000, used: 0, reserved: 1000, available: 0 },
    );
    const current = (await f.stores[0].get(code))!,
      slot = current.recordings[0]!.storage!.attempts[0]!;
    const metadata = {
      version: 1 as const,
      context: {
        tenantId: "installation",
        meetingId: current.id,
        recordingId: id,
      },
      recordingKeyId: randomUUID(),
      wrappedKey: {
        provider: "fixture",
        keyId: "fixture",
        ciphertext: "wrapped",
      },
      plaintextBytes: 1,
      encryptedBytes: 400,
    };
    await stores[index]!.withRecordingLock(code, id, (lock) =>
      lock.prepareRecordingStorage(slot.id, { kind: "local", metadata }),
    );
    const restarted = await narrow();
    await restarted.setHostedEntitlement({
      ...grant,
      revision: 3,
      enabled: false,
      quota: {
        ...grant.quota,
        storageBytes: 300,
        recordingSecondsPerMonth: 3600,
      },
    });
    assert.deepEqual(
      (await restarted.hostedUsage(owner)).recordingStorageBytes,
      { limit: 300, used: 0, reserved: 1000, available: 0 },
    );
    await assert.rejects(
      restarted.withRecordingLock(code, id, (lock) =>
        lock.releaseRecordingStorage(slot.id, { kind: "unused" }),
      ),
      /attempt changed/,
    );
    await restarted.withRecordingLock(code, id, async (lock) => {
      const receipt = { version: 1 as const, published: true, bytes: 400 };
      await lock.retainRecordingStorage(slot.id, {
        kind: "local",
        metadata,
        receipt,
      });
      await lock.removeRecordingStorage(slot.id);
      await lock.releaseRecordingStorage(slot.id, {
        kind: "local",
        metadata,
        receipt,
        removed: true,
      });
      await lock.releaseRecordingStorage(slot.id, {
        kind: "local",
        metadata,
        receipt,
        removed: true,
      });
    });
    assert.deepEqual(
      (await f.stores[1].hostedUsage(owner)).recordingStorageBytes,
      { limit: 300, used: 0, reserved: 0, available: 300 },
    );
    assert.deepEqual(
      (await f.stores[0].hostedUsage(otherOwner)).recordingStorageBytes,
      { limit: 0, used: 0, reserved: 0, available: 0 },
    );
  },
);
