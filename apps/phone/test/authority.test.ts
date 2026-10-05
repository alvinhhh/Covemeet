import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  HttpAuthority,
  serviceUrl,
  PhoneActionDenied,
} from "../src/authority.js";
const input = {
  locator: "123456789012",
  pin: "12345678",
  callId: randomUUID(),
  trunkId: "fixture",
};
const session = {
  code: "SELFHOST123",
  participantId: randomUUID(),
  sessionToken: "x".repeat(48),
  expiresAt: Date.now() + 10000,
};

test("private authority sends exact service authentication and no browser Origin", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(String(url)).pathname, "/api/internal/phone/calls");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("Origin"), null);
    assert.equal(headers.get("X-Requested-With"), "CovemeetPhone");
    assert.equal(headers.get("Authorization"), `Bearer ${"k".repeat(40)}`);
    assert.equal(init?.redirect, "error");
    return Response.json(session);
  };
  assert.deepEqual(
    await new HttpAuthority("https://core.example", "k".repeat(40)).join(input),
    session,
  );
});

test("authority streaming body limit cancels oversized responses", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  let cancelled = false;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(40000));
        },
        cancel() {
          cancelled = true;
        },
      }),
    );
  await assert.rejects(
    new HttpAuthority("https://core.example", "k".repeat(40)).join(input),
    /too large/,
  );
  assert(cancelled);
});

test("only explicit speaking denial is nonfatal; gateway authentication errors remain failures", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  globalThis.fetch = async () =>
    Response.json({ error: "Speaking permission required" }, { status: 403 });
  const authority = new HttpAuthority("https://core.example", "k".repeat(40));
  await assert.rejects(
    authority.action(session, input.callId, "toggle-mute"),
    PhoneActionDenied,
  );
  await assert.rejects(
    authority.action(session, input.callId, "poll"),
    (error) => !(error instanceof PhoneActionDenied),
  );
  globalThis.fetch = async () =>
    Response.json(
      { error: "Phone gateway authentication required" },
      { status: 403 },
    );
  await assert.rejects(
    authority.action(session, input.callId, "toggle-mute"),
    (error) => !(error instanceof PhoneActionDenied),
  );
});

test("service endpoint policy rejects plaintext production, credentials and injected routes", () => {
  for (const value of [
    "http://localhost:4100",
    "https://user:pass@core.example",
    "https://core.example/path",
    "https://core.example/?token=x",
  ])
    assert.throws(() => serviceUrl(value, ["http:", "https:"]));
  assert.equal(
    serviceUrl("http://livekit:7880", ["http:"], true).hostname,
    "livekit",
  );
  assert.throws(() => serviceUrl("http://external.example", ["http:"], true));
});

test("journal private routes validate identifiers, authenticate, and reject unexpected response fields", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const routes: string[] = [];
  const ownerId = randomUUID();
  const dialogInput = {
    callId: input.callId,
    ownerId,
    pbxId: "fixture",
    pbxEpoch: "fixture-epoch",
    callerChannelId: "caller",
    trunkId: "fixture",
    inboundEndpoint: "phone",
    outboundEndpoint: "livekit",
    sipTrunkId: "ST_fixture",
    sipRuleId: "SDR_fixture",
  };
  const dialog = {
    ...dialogInput,
    state: "open",
    revision: 1,
    operations: {},
    uncertain: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  let extra = false;
  globalThis.fetch = async (url, init) => {
    const pathname = new URL(String(url)).pathname;
    routes.push(pathname);
    const headers = new Headers(init?.headers);
    assert.equal(init?.method, "POST");
    assert.equal(init?.redirect, "error");
    assert.equal(headers.get("Authorization"), `Bearer ${"k".repeat(40)}`);
    assert.equal(headers.get("X-Requested-With"), "CovemeetPhone");
    assert.equal(headers.get("Origin"), null);
    assert(init?.signal);
    const body = JSON.parse(String(init?.body));
    if (pathname === "/api/internal/phone/dialogs/query") {
      assert.deepEqual(body, { callId: input.callId });
      return Response.json({ dialogs: [dialog] });
    }
    return Response.json({
      ...dialog,
      ...(extra ? { sessionToken: "unexpected-secret" } : {}),
    });
  };
  const authority = new HttpAuthority("https://core.example", "k".repeat(40));
  await authority.journalCreate(dialogInput);
  await authority.journalQuery({ callId: input.callId });
  await authority.journalChange(input.callId, ownerId, 1, {
    type: "begin",
    operation: "answer",
  });
  await authority.journalStop(input.callId, ownerId, 1);
  await authority.journalFinish(input.callId, ownerId, 1, {
    allocationsStopped: true,
    callerAbsent: true,
    outboundAbsent: true,
    bridgeAbsent: true,
    nativeAbsent: true,
    holdingRelayAbsent: true,
    rtcClosed: true,
  });
  assert.deepEqual(routes, [
    "/api/internal/phone/dialogs",
    "/api/internal/phone/dialogs/query",
    `/api/internal/phone/dialogs/${input.callId}`,
    `/api/internal/phone/dialogs/${input.callId}/stop`,
    `/api/internal/phone/dialogs/${input.callId}/finish`,
  ]);
  const count = routes.length;
  await assert.rejects(authority.journalStop("../other-route", ownerId, 1));
  await assert.rejects(authority.journalStop(input.callId, ownerId, 1.5));
  assert.equal(routes.length, count);
  extra = true;
  await assert.rejects(authority.journalCreate(dialogInput));
});

test("journaled join transmits its process owner with credentials", async (t) => {
  const previous = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = previous;
  });
  const ownerId = randomUUID();
  globalThis.fetch = async (_url, init) => {
    assert.equal(JSON.parse(String(init?.body)).ownerId, ownerId);
    return Response.json(session);
  };
  await new HttpAuthority("https://core.example", "k".repeat(40)).join({
    ...input,
    ownerId,
  });
});
