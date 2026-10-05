import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import { AriClient, AriRequestError, type AriEvent } from "../src/ari.js";

const password = "synthetic-ari-test-password-123456789";
const channel = {
  id: "test-channel.1",
  name: "PJSIP/fixture-0001",
  state: "Up",
  caller: { name: "Synthetic", number: "+15555550123" },
};
const playback = {
  id: "playback-1",
  state: "done",
  target_uri: `channel:${channel.id}`,
};
const bridge = { id: "bridge-1", channels: [channel.id] };
function json(res: ServerResponse, value: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Fixture condition timed out");
    await delay(5);
  }
}
async function fixture(
  t: TestContext,
  handler?: (req: IncomingMessage, res: ServerResponse) => void,
  autoPong = true,
) {
  const requests: {
    method: string;
    url: string;
    auth?: string;
    body: string;
  }[] = [];
  const upgrades: IncomingMessage[] = [];
  const events: AriEvent[] = [];
  const failures: Error[] = [];
  const peers: WebSocket[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method!,
      url: req.url!,
      auth: req.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    });
    if (handler) return handler(req, res);
    const url = new URL(req.url!, "http://fixture.invalid");
    if (
      req.method === "DELETE" ||
      url.pathname.endsWith("/answer") ||
      url.pathname.endsWith("/addChannel")
    ) {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname === "/ari/channels") return json(res, [channel]);
    if (url.pathname.endsWith("/variable")) return json(res, { value: "1" });
    if (url.pathname.includes("/play/")) return json(res, playback);
    if (url.pathname.startsWith("/ari/bridges/")) return json(res, bridge);
    return json(res, channel);
  });
  const wss = new WebSocketServer({ noServer: true, autoPong });
  server.on("upgrade", (req, socket, head) => {
    upgrades.push(req);
    wss.handleUpgrade(req, socket, head, (ws) => {
      peers.push(ws);
      wss.emit("connection", ws, req);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let client: AriClient;
  client = new AriClient({
    baseUrl,
    username: "fixture",
    password,
    app: "covemeet",
    development: true,
    requestTimeoutMs: 150,
    heartbeatMs: 100,
    onEvent: (event) => {
      events.push(event);
    },
    onFailure: (error) => {
      assert.equal(client.connected, false);
      failures.push(error);
    },
  });
  t.after(async () => {
    await client.close();
    for (const peer of peers) peer.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { client, requests, upgrades, events, failures, peers, baseUrl };
}

test("ARI rejects unpinned/insecure origins and invalid Basic credentials", () => {
  const config = {
    baseUrl: "https://ari.internal",
    username: "fixture",
    password,
    app: "covemeet",
    onEvent() {},
    onFailure() {},
  };
  for (const baseUrl of [
    "http://ari.internal",
    "https://user:pass@ari.internal",
    "https://ari.internal/ari",
    "https://ari.internal/?api_key=secret",
    "https://ari.internal/#x",
  ])
    assert.throws(() => new AriClient({ ...config, baseUrl }));
  assert.throws(
    () => new AriClient({ ...config, baseUrl: "https://user:secret@[broken" }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Invalid ARI management origin",
  );
  assert.throws(() => new AriClient({ ...config, username: "user:password" }));
  assert.throws(() => new AriClient({ ...config, password: "short" }));
  assert.throws(
    () => new AriClient({ ...config, password: `${password}\nsecret` }),
  );
  assert.throws(() => new AriClient({ ...config, app: "covemeet,other" }));
  assert.throws(
    () =>
      new AriClient({
        ...config,
        development: true,
        baseUrl: "http://public.example",
      }),
  );
  assert.doesNotThrow(() => new AriClient(config));
  assert.doesNotThrow(
    () =>
      new AriClient({
        ...config,
        development: true,
        baseUrl: "http://asterisk:8088",
      }),
  );
});

test("ARI authenticates HTTP and WS only in headers and exposes exact scoped operations", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.client.answer(channel.id), /gate is closed/);
  await f.client.connect();
  assert.equal(f.client.connected, true);
  assert.equal(
    f.upgrades[0].headers.authorization,
    `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}`,
  );
  assert.equal(
    f.upgrades[0].url,
    "/ari/events?app=covemeet&subscribeAll=false",
  );
  await f.client.answer(channel.id);
  assert.deepEqual(await f.client.getChannel(channel.id), channel);
  assert.deepEqual(await f.client.listChannels(), [channel]);
  assert.equal(
    await f.client.getChannelVariable(channel.id, "CHANNEL(pjsip,secure)"),
    "1",
  );
  assert.deepEqual(
    await f.client.originate({
      channelId: channel.id,
      endpoint: "PJSIP/room-1@livekit-holding",
      appArgs: ["holding", "call-1"],
    }),
    channel,
  );
  assert.deepEqual(
    await f.client.play(channel.id, playback.id, "covemeet/waiting"),
    playback,
  );
  assert.deepEqual(await f.client.createBridge(bridge.id), bridge);
  await f.client.addChannel(bridge.id, channel.id);
  await f.client.stopPlayback(playback.id);
  await f.client.destroyBridge(bridge.id);
  await f.client.hangup(channel.id);
  for (const req of f.requests) {
    assert.equal(req.auth, f.upgrades[0].headers.authorization);
    assert.equal(req.url.includes("api_key"), false);
    assert.equal(req.url.includes(password), false);
  }
  const originate = f.requests.find(
    (r) => r.method === "POST" && r.url === `/ari/channels/${channel.id}`,
  )!;
  assert.deepEqual(JSON.parse(originate.body), {
    endpoint: "PJSIP/room-1@livekit-holding",
    app: "covemeet",
    appArgs: "holding,call-1",
    timeout: 30,
  });
  assert.ok(
    f.requests.some(
      (r) =>
        r.url ===
        `/ari/bridges/${bridge.id}?type=mixing%2Cproxy_media%2Cdtmf_events`,
    ),
  );
  await assert.rejects(f.client.answer(".."), /Invalid ARI parameter/);
  await assert.rejects(
    f.client.answer("channel/other"),
    /Invalid ARI parameter/,
  );
  await assert.rejects(
    f.client.play(channel.id, playback.id, "sound:../../secret"),
    /Invalid ARI parameter/,
  );
  await assert.rejects(
    f.client.play(channel.id, playback.id, "https://example.test/prompt"),
    /Invalid ARI parameter/,
  );
  await assert.rejects(
    f.client.getChannelVariable(channel.id, "SHELL(secret)" as never),
    /Invalid ARI variable/,
  );
  assert.equal(f.failures.length, 0);
});

test("ARI delivers bounded typed application events and gates synchronously on disconnect", async (t) => {
  const f = await fixture(t);
  await f.client.connect();
  const send = (event: object) =>
    f.peers[0].send(JSON.stringify({ application: "covemeet", ...event }));
  send({ type: "StasisStart", channel, args: ["inbound"] });
  send({ type: "ChannelDtmfReceived", channel, digit: "6", duration_ms: 100 });
  send({ type: "PlaybackFinished", playback });
  send({
    type: "PlaybackContinuing",
    playback: { ...playback, state: "continuing" },
  });
  send({ type: "BridgeDestroyed", bridge });
  send({ type: "UnneededFutureEvent", payload: "ignored" });
  await waitFor(() => f.events.length === 5);
  assert.equal(f.events[0].type, "StasisStart");
  f.peers[0].close();
  await waitFor(() => f.failures.length === 1);
  assert.equal(f.client.connected, false);
  await assert.rejects(f.client.answer(channel.id), /gate is closed/);
  await f.client.hangup(channel.id); // Cleanup remains available after event loss.
  await assert.rejects(f.client.connect(), /terminal/);
  await f.client.close();
  assert.equal(f.failures.length, 1);
  assert.equal(f.failures[0].message, "ARI control connection unavailable");
});

for (const [name, event] of [
  ["malformed JSON", "not-json-secret"],
  [
    "wrong application",
    JSON.stringify({
      type: "StasisStart",
      application: "another",
      channel,
      args: [],
    }),
  ],
  [
    "invalid DTMF",
    JSON.stringify({
      type: "ChannelDtmfReceived",
      application: "covemeet",
      channel,
      digit: "secret-digits",
      duration_ms: 100,
    }),
  ],
  [
    "application replacement",
    JSON.stringify({ type: "ApplicationReplaced", application: "covemeet" }),
  ],
  ["oversized event", "x".repeat(70000)],
] as const)
  test(`ARI fails closed on ${name} without reflecting payload`, async (t) => {
    const f = await fixture(t);
    await f.client.connect();
    f.peers[0].send(event);
    await waitFor(() => f.failures.length === 1);
    assert.equal(f.events.length, 0);
    assert.equal(f.client.connected, false);
    assert.equal(f.failures[0].message, "ARI control connection unavailable");
  });

test("ARI missed pong closes admission, intentional close does not signal failure", async (t) => {
  const f = await fixture(t, undefined, false);
  await f.client.connect();
  await waitFor(() => f.failures.length === 1);
  assert.equal(f.client.connected, false);
  const clean = await fixture(t);
  await clean.client.connect();
  await clean.client.close();
  assert.equal(clean.failures.length, 0);
});

test("ARI treats only confirmed 404 as absent or idempotent deletion", async (t) => {
  let status = 404;
  const f = await fixture(t, (_req, res) =>
    json(res, { message: "synthetic-private-server-detail" }, status),
  );
  await f.client.connect();
  assert.equal(await f.client.getChannel(channel.id), undefined);
  await f.client.hangup(channel.id);
  await f.client.stopPlayback(playback.id);
  await f.client.destroyBridge(bridge.id);
  await assert.rejects(
    f.client.answer(channel.id),
    (error: unknown) =>
      error instanceof AriRequestError &&
      error.status === 404 &&
      error.outcome === "rejected",
  );
  status = 409;
  await assert.rejects(
    f.client.originate({
      channelId: channel.id,
      endpoint: "PJSIP/room@holding",
    }),
    (error: unknown) =>
      error instanceof AriRequestError &&
      error.status === 409 &&
      error.outcome === "rejected" &&
      !error.message.includes("private"),
  );
  assert.equal(f.client.connected, true);
});

for (const scenario of [
  "timeout",
  "oversized",
  "redirect",
  "server-error",
  "invalid-success",
  "empty-success",
] as const)
  test(`ARI ${scenario} retains unknown mutation outcome without retry`, async (t) => {
    const f = await fixture(t, (_req, res) => {
      if (scenario === "timeout") return;
      if (scenario === "oversized") {
        res.writeHead(200).end("x".repeat(270000));
        return;
      }
      if (scenario === "redirect") {
        res.writeHead(307, { Location: "/ari/channels/redirected" }).end();
        return;
      }
      if (scenario === "server-error") {
        json(res, { message: "private detail" }, 503);
        return;
      }
      if (scenario === "empty-success") {
        res.writeHead(200).end();
        return;
      }
      json(res, { ...channel, id: "wrong-channel" });
    });
    await f.client.connect();
    await assert.rejects(
      f.client.originate({
        channelId: channel.id,
        endpoint: "PJSIP/room@holding",
      }),
      (error: unknown) =>
        error instanceof AriRequestError &&
        error.outcome === "unknown" &&
        !error.message.includes("private"),
    );
    assert.equal(f.requests.length, 1);
    assert.equal(f.failures.length, 1);
    assert.equal(f.client.connected, false);
  });
