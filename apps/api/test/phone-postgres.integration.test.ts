import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { PgStore, type Meeting, type Participant } from "../src/store.js";
import type { Media } from "../src/media.js";

// Opt-in against a disposable database only; the runner removes its container.
// Two independent pools/API instances must share the same reservation limit.
const databaseUrl = process.env.PHONE_TEST_DATABASE_URL;
test(
  "phone reservations serialize across PostgreSQL-backed API instances",
  {
    skip: !databaseUrl,
  },
  async (t) => {
    const url = new URL(databaseUrl!);
    assert.ok(
      ["127.0.0.1", "localhost", "phone-postgres"].includes(url.hostname),
    );
    assert.equal(url.pathname, "/covemeet_phone_test");
    const origin = "http://localhost:5173";
    const creationKey = "phone-test-creation-key-over-32-characters";
    const gatewayKey = "phone-test-gateway-key-over-32-characters";
    const config = loadConfig({
      NODE_ENV: "test",
      EDITION: "hosted",
      SITE_ORIGIN: origin,
      SESSION_SECRET: "phone-test-session-secret-over-32-characters",
      CREATION_KEY: creationKey,
      DATABASE_URL: databaseUrl,
      PHONE_ENABLED: "true",
      PHONE_GATEWAY_KEY: gatewayKey,
      PHONE_TRUNK_ID: "local-test",
      PHONE_SIP_ADDRESS: "sip:meet@phone.example.test",
      PHONE_MAX_CALLS: "2",
      PHONE_LOBBY_SECONDS: "300",
      PHONE_MAX_DURATION_SECONDS: "7200",
    });
    const media: Media = {
      available: true,
      token: async (_m: Meeting, p: Participant) => `test-${p.id}`,
      remove: async () => {},
      end: async () => {},
      close() {},
    };
    const stores = [new PgStore(databaseUrl!), new PgStore(databaseUrl!)];
    await stores[0]!.init();
    await stores[1]!.init();
    const apps = await Promise.all(
      stores.map((store) => createApp(config, store, media)),
    );
    t.after(async () => {
      await Promise.all(apps.map((app) => app.close()));
    });
    const browserHeaders = { origin, "x-requested-with": "MeetingPlatform" };
    const gatewayHeaders = {
      authorization: `Bearer ${gatewayKey}`,
      "x-requested-with": "CovemeetPhone",
    };
    async function meeting(index: number) {
      const app = apps[index % 2]!;
      const created = await app.inject({
        method: "POST",
        url: "/api/meetings",
        headers: browserHeaders,
        payload: {
          title: `Phone reservation ${randomUUID()}`,
          hostName: "Test host",
          mode: "meeting",
          password: "local-fixture-password",
          creationKey,
        },
      });
      assert.equal(created.statusCode, 200, created.body);
      const { code, hostToken } = created.json();
      const signedIn = await app.inject({
        method: "POST",
        url: `/api/meetings/${code}/host`,
        headers: browserHeaders,
        payload: { token: hostToken },
      });
      assert.equal(signedIn.statusCode, 200, signedIn.body);
      const cookie = signedIn.cookies
        .map((c) => `${c.name}=${c.value}`)
        .join("; ");
      const issued = await app.inject({
        method: "POST",
        url: `/api/meetings/${code}/phone`,
        headers: { ...browserHeaders, cookie },
        payload: {},
      });
      assert.equal(issued.statusCode, 200, issued.body);
      const access = issued.json();
      assert.match(access.locator, /^\d{12}$/);
      assert.match(access.pin, /^\d{8}$/);
      return { app, code, cookie, ...access };
    }
    const meetings = await Promise.all([0, 1, 2].map(meeting));
    const requests = meetings.map((m, i) => ({
      locator: m.locator,
      pin: m.pin,
      callId: randomUUID(),
      trunkId: "local-test",
      callerId: `+1202555010${i}`,
    }));
    const responses = await Promise.all(
      requests.map((payload, i) =>
        apps[i % 2]!.inject({
          method: "POST",
          url: "/api/internal/phone/calls",
          headers: gatewayHeaders,
          payload,
        }),
      ),
    );
    assert.equal(
      responses.filter((r) => r.statusCode === 200).length,
      2,
      "Concurrent API instances must share the installation-wide reservation cap",
    );
    assert.equal(
      responses.filter((r) => r.statusCode >= 400 && r.statusCode < 500).length,
      1,
    );
    const acceptedIndex = responses.findIndex((r) => r.statusCode === 200);
    const call = responses[acceptedIndex]!.json();
    const acceptedMeeting = meetings[acceptedIndex]!;
    const removed = await acceptedMeeting.app.inject({
      method: "POST",
      url: `/api/meetings/${call.code}/participants/${call.participantId}/action`,
      headers: { ...browserHeaders, cookie: acceptedMeeting.cookie },
      payload: { action: "kick" },
    });
    assert.equal(removed.statusCode, 200, removed.body);
    const deniedIndex = responses.findIndex((r) => r.statusCode !== 200);
    const stillReserved = await apps[1]!.inject({
      method: "POST",
      url: "/api/internal/phone/calls",
      headers: gatewayHeaders,
      payload: { ...requests[deniedIndex], callId: randomUUID() },
    });
    assert.ok(
      stillReserved.statusCode >= 400 && stillReserved.statusCode < 500,
      "Revocation must not free capacity before the trusted relay confirms teardown",
    );
    const finished = await apps[1]!.inject({
      method: "POST",
      url: `/api/internal/phone/calls/${call.code}/${call.participantId}`,
      headers: gatewayHeaders,
      payload: {
        callId: requests[acceptedIndex]!.callId,
        sessionToken: call.sessionToken,
        action: "leave",
      },
    });
    assert.equal(finished.statusCode, 200, finished.body);
    const replayInOtherMeeting = await apps[1]!.inject({
      method: "POST",
      url: "/api/internal/phone/calls",
      headers: gatewayHeaders,
      payload: {
        ...requests[deniedIndex],
        callId: requests[acceptedIndex]!.callId,
      },
    });
    assert.ok(
      replayInOtherMeeting.statusCode >= 400 &&
        replayInOtherMeeting.statusCode < 500,
      "A call ID must never be rebound to another meeting after teardown",
    );
    const fresh = await apps[1]!.inject({
      method: "POST",
      url: "/api/internal/phone/calls",
      headers: gatewayHeaders,
      payload: { ...requests[deniedIndex], callId: randomUUID() },
    });
    assert.equal(fresh.statusCode, 200, fresh.body);
  },
);
