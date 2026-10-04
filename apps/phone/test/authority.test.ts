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
