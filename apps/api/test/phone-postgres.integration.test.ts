import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { PgStore, type Meeting, type Participant } from "../src/store.js";
import type { Media } from "../src/media.js";
import type { PhoneDialogInput } from "../src/phone-dialogs.js";

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
    const freshCallId = randomUUID();
    const fresh = await apps[1]!.inject({
      method: "POST",
      url: "/api/internal/phone/calls",
      headers: gatewayHeaders,
      payload: { ...requests[deniedIndex], callId: freshCallId },
    });
    assert.equal(fresh.statusCode, 200, fresh.body);

    // Clear only the calls created above, then exercise durable pre-IVR slots
    // through the same two pools. No table reset or unrelated state deletion.
    const legacy = responses.flatMap((response, index) =>
      response.statusCode === 200
        ? [{ ...response.json(), callId: requests[index]!.callId }]
        : [],
    );
    legacy.push({ ...fresh.json(), callId: freshCallId });
    for (const call of legacy) {
      const leave = await apps[0]!.inject({
        method: "POST",
        url: `/api/internal/phone/calls/${call.code}/${call.participantId}`,
        headers: gatewayHeaders,
        payload: {
          callId: call.callId,
          sessionToken: call.sessionToken,
          action: "leave",
        },
      });
      assert.equal(leave.statusCode, 200, leave.body);
    }
    const owners = [randomUUID(), randomUUID()];
    const starts = await Promise.allSettled(
      stores.map((store, index) =>
        store.claimPhoneSupervisor({
          pbxId: "postgres-fixture",
          ownerId: owners[index]!,
          pbxEpoch: "boot-1",
        }),
      ),
    );
    assert.equal(
      starts.filter((result) => result.status === "fulfilled").length,
      1,
      "Exactly one PBX owner must win across independent PostgreSQL pools",
    );
    const ownerId =
      owners[starts.findIndex((result) => result.status === "fulfilled")]!;
    await assert.rejects(
      stores[1]!.claimPhoneSupervisor({
        pbxId: "postgres-fixture",
        ownerId: randomUUID(),
        pbxEpoch: "new-label",
      }),
      /ownership/,
    );
    const dialogInput = (): PhoneDialogInput => ({
      callId: randomUUID(),
      ownerId,
      pbxId: "postgres-fixture",
      pbxEpoch: "boot-1",
      callerChannelId: `caller-${randomUUID()}`,
      trunkId: "local-test",
      inboundEndpoint: "inbound",
      outboundEndpoint: "outbound",
      sipTrunkId: "ST_test",
      sipRuleId: "SDR_test",
    });
    const claims = await Promise.allSettled(
      [0, 1, 2].map((index) =>
        stores[index % 2]!.createPhoneDialog(dialogInput(), 2),
      ),
    );
    const claimed = claims.flatMap((r) =>
      r.status === "fulfilled" ? [r.value] : [],
    );
    assert.equal(
      claimed.length,
      2,
      "Pre-IVR slots must serialize across API pools",
    );
    let dialog = claimed[0]!;
    dialog = await stores[1]!.changePhoneDialog(
      dialog.callId,
      dialog.ownerId,
      dialog.revision,
      { type: "begin", operation: "answer" },
    );
    dialog = await stores[1]!.changePhoneDialog(
      dialog.callId,
      dialog.ownerId,
      dialog.revision,
      { type: "settle", operation: "answer", outcome: "confirmed" },
    );
    const bound = await apps[0]!.inject({
      method: "POST",
      url: "/api/internal/phone/calls",
      headers: gatewayHeaders,
      payload: {
        ...requests[deniedIndex],
        callId: dialog.callId,
        ownerId: dialog.ownerId,
      },
    });
    assert.equal(
      bound.statusCode,
      200,
      "Binding an existing final slot must not count it twice",
    );
    const persisted = (
      await stores[1]!.queryPhoneDialogs({ callId: dialog.callId })
    )[0]!;
    assert.equal(persisted.binding?.participantId, bound.json().participantId);
    await stores[1]!.releasePhone(
      dialog.callId,
      persisted.binding!.code,
      persisted.binding!.participantId,
    );
    await assert.rejects(
      stores[0]!.createPhoneDialog(dialogInput(), 2),
      /capacity/,
    );
    const stopped = await apps[1]!.inject({
      method: "POST",
      url: `/api/internal/phone/dialogs/${dialog.callId}/stop`,
      headers: gatewayHeaders,
      payload: { ownerId: dialog.ownerId, revision: persisted.revision },
    });
    assert.equal(stopped.statusCode, 200, stopped.body);
    const finishedDialog = await apps[1]!.inject({
      method: "POST",
      url: `/api/internal/phone/dialogs/${dialog.callId}/finish`,
      headers: gatewayHeaders,
      payload: {
        ownerId: dialog.ownerId,
        revision: stopped.json().revision,
        proof: {
          allocationsStopped: true,
          callerAbsent: true,
          outboundAbsent: true,
          bridgeAbsent: true,
          nativeAbsent: true,
          holdingRelayAbsent: true,
          rtcClosed: true,
        },
      },
    });
    assert.equal(finishedDialog.statusCode, 200, finishedDialog.body);
    assert.equal(finishedDialog.json().state, "closed");
    await stores[0]!.createPhoneDialog(dialogInput(), 2);
  },
);
