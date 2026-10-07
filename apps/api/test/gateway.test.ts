import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "../src/config.js";
import { LiveMedia } from "../src/media.js";
import { MemoryStore, type Meeting } from "../src/store.js";
import { digest } from "../src/security.js";
import { createApp } from "../src/server.js";

test("gateway requires the meeting cookie, preserves signaling order, and disconnects an expired live session", async (t) => {
  const upstream = createServer();
  const wss = new WebSocketServer({ server: upstream });
  wss.on("connection", (ws) => {
    ws.send("join");
    ws.send("refresh");
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const config = loadConfig({
    SESSION_SECRET: "test-gateway-secret-over-thirty-two-chars",
    LIVEKIT_API_KEY: "test",
    LIVEKIT_API_SECRET: "test-livekit-secret-over-thirty-two-chars",
    LIVEKIT_URL: `http://127.0.0.1:${(upstream.address() as any).port}`,
  });
  const store = new MemoryStore();
  const m: Meeting = {
    id: "meeting",
    code: "GATEWAYSESSIONTEST",
    room: "room",
    title: "Gateway test",
    mode: "meeting",
    locked: false,
    ended: false,
    recordingAllowed: false,
    createdAt: Date.now(),
    revision: 1,
    passwordHash: "unused",
    hostTokenExpiresAt: 0,
    bans: { ip: [], device: [] },
    breakouts: [],
    messages: [],
    recordings: [],
    participants: [
      {
        id: "participant",
        name: "Guest",
        role: "participant",
        status: "admitted",
        audioAllowed: true,
        videoAllowed: true,
        mediaVersion: 1,
        tokenHash: digest("session-cookie"),
        expiresAt: Date.now() + 1200,
        ipHash: "",
        deviceHash: "",
        breakoutId: null,
      },
    ],
  };
  await store.create(m);
  const media = new LiveMedia(config, store);
  let removals = 0;
  media.client.removeParticipant = async () => {
    removals++;
  };
  const app = await createApp(config, store, media);
  await app.listen({ host: "127.0.0.1", port: 0 });
  config.origin = `http://127.0.0.1:${(app.server.address() as any).port}`;
  t.after(async () => {
    media.close();
    for (const ws of wss.clients) ws.terminate();
    wss.close();
    upstream.close();
    await app.close();
  });
  const token = await media.token(m, m.participants[0]!);
  const url = `${config.origin.replace("http", "ws")}/rtc?access_token=${token}`;
  const rejected = new WebSocket(url, { headers: { Origin: config.origin } });
  const rejection = await new Promise<Error>((resolve) =>
    rejected.once("error", resolve),
  );
  assert.match(rejection.message, /403/);
  const ws = new WebSocket(url, {
    headers: { Origin: config.origin, Cookie: `mp_${m.code}=session-cookie` },
  });
  const messages: string[] = [];
  ws.on("message", (data) => messages.push(data.toString()));
  const closed = once(ws, "close");
  await once(ws, "open");
  await Promise.race([
    closed,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("Expired media session remained open")),
        3000,
      ).unref(),
    ),
  ]);
  assert.deepEqual(messages, ["join", "refresh"]);
  assert.equal(removals, 1);
});

test("media validation scopes valid tokens by participant and keeps invalid tokens IP-limited", async (t) => {
  const config = loadConfig({
    SESSION_SECRET: "test-validation-secret-over-thirty-two-chars",
    LIVEKIT_API_KEY: "test",
    LIVEKIT_API_SECRET: "test-livekit-secret-over-thirty-two-chars",
  });
  const store = new MemoryStore();
  const meeting: Meeting = {
    id: "validation-budget",
    code: "VALIDATIONBUDGET",
    room: "validation-room",
    title: "Validation",
    mode: "meeting",
    locked: false,
    ended: false,
    recordingAllowed: false,
    createdAt: Date.now(),
    revision: 1,
    passwordHash: "unused",
    hostTokenExpiresAt: 0,
    bans: { ip: [], device: [] },
    breakouts: [],
    messages: [],
    recordings: [],
    participants: [0, 1].map((i) => ({
      id: `participant-${i}`,
      name: "Guest",
      role: "participant",
      status: "admitted",
      audioAllowed: true,
      videoAllowed: true,
      mediaVersion: 1,
      tokenHash: digest(`session-${i}`),
      expiresAt: Date.now() + 60000,
      ipHash: "",
      deviceHash: "",
      breakoutId: null,
    })),
  };
  await store.create(meeting);
  const media = new LiveMedia(config, store),
    app = await createApp(config, store, media);
  await app.ready();
  t.after(() => app.close());
  const tokens = await Promise.all(
    meeting.participants.map((p) => media.token(meeting, p)),
  );
  const validate = (token: string, ip = "198.51.100.40") =>
    app.inject({
      method: "GET",
      url: `/rtc/validate?access_token=${encodeURIComponent(token)}`,
      remoteAddress: ip,
    });
  for (let i = 0; i < 70; i++)
    for (const token of tokens)
      assert.equal((await validate(token)).statusCode, 200);
  for (let i = 0; i < 50; i++)
    assert.equal((await validate(tokens[0]!)).statusCode, 200);
  assert.equal((await validate(tokens[0]!)).statusCode, 429);
  assert.equal((await validate(tokens[1]!)).statusCode, 200);
  const authorization = t.mock.method(media, "authorize");
  for (let i = 0; i < 120; i++)
    assert.equal(
      (await validate(`invalid-${i}`, "198.51.100.41")).statusCode,
      403,
    );
  const before = authorization.mock.callCount();
  assert.equal((await validate(tokens[1]!, "198.51.100.41")).statusCode, 429);
  assert.equal(authorization.mock.callCount(), before);
});
