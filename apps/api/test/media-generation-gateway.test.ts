import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { LiveMedia } from "../src/media.js";
import { mediaIdentity } from "../src/media-identity.js";
import { MemoryStore, type Meeting } from "../src/store.js";
import { digest } from "../src/security.js";

async function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const upstream = createServer(),
    wss = new WebSocketServer({ server: upstream });
  const upstreams: WebSocket[] = [],
    clients: WebSocket[] = [];
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let onUpstream = () => {};
  t.after(async () => {
    for (const peer of [...clients, ...upstreams]) peer.terminate();
    await app?.close();
    wss.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  wss.on("connection", (peer) => {
    upstreams.push(peer);
    onUpstream();
    peer.send("connected");
  });
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const config = loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "generation-gateway-secret-at-least32characters",
    LIVEKIT_API_KEY: "fixture",
    LIVEKIT_API_SECRET: "generation-livekit-secret-at-least32characters",
    LIVEKIT_URL: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
    RECORDING_ENABLED: "false",
  });
  const store = new MemoryStore(),
    media = new LiveMedia(config, store);
  const m: Meeting = {
    id: randomUUID(),
    code: "GENERATIONGATEWAYFIXTURE",
    room: randomUUID(),
    title: "Synthetic gateway",
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
        id: randomUUID(),
        name: "Guest",
        role: "participant",
        status: "admitted",
        audioAllowed: true,
        videoAllowed: true,
        mediaVersion: 1,
        tokenHash: digest("synthetic-session"),
        expiresAt: Date.now() + 60000,
        ipHash: "",
        deviceHash: "",
        breakoutId: null,
      },
    ],
  };
  await store.create(m);
  const removals: string[] = [];
  media.client.removeParticipant = async (_room, identity) => {
    removals.push(identity);
  };
  app = await createApp(config, store, media);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const token = await media.token(m, m.participants[0]!);
  const open = () => {
    const peer = new WebSocket(
      `ws://127.0.0.1:${(app!.server.address() as { port: number }).port}/rtc?access_token=${encodeURIComponent(token)}`,
      {
        headers: {
          Origin: config.origin,
          Cookie: `mp_${m.code}=synthetic-session`,
        },
      },
    );
    clients.push(peer);
    return peer;
  };
  return {
    token,
    store,
    media,
    m,
    open,
    removals,
    upstreams,
    onUpstream: (fn: () => void) => {
      onUpstream = fn;
    },
  };
}

async function flush() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test(
  "unmetered stale callback cannot remove a same-version successor, but current expiry still removes media",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      id = f.m.participants[0]!.id;
    const first = f.open();
    await once(first, "message");
    const oldOwner = (await f.store.get(f.m.code))!.participants[0]!
      .gatewayConnectionId;
    const second = f.open();
    await once(second, "message");
    const owner = (await f.store.get(f.m.code))!.participants[0]!
      .gatewayConnectionId;
    assert.notEqual(owner, oldOwner);
    const closed = once(first, "close");
    f.upstreams[0]!.send("late old gateway message");
    await closed;
    await flush();
    assert.equal(second.readyState, WebSocket.OPEN);
    assert.deepEqual(f.removals, []);
    assert.equal(
      (await f.store.get(f.m.code))!.participants[0]!.gatewayConnectionId,
      owner,
    );

    await f.store.change(f.m.code, (m) => {
      m.participants[0]!.expiresAt = Date.now() - 1;
    });
    const secondClosed = once(second, "close");
    f.upstreams[1]!.send("expired current gateway message");
    await secondClosed;
    await flush();
    assert.deepEqual(f.removals, [id]);
    const ended = (await f.store.get(f.m.code))!.participants[0]!;
    assert.notEqual(mediaIdentity(ended), id);
    assert.equal(ended.gatewayConnectionId, undefined);
    assert.equal(ended.enforcementPending, false);
  },
);

test(
  "unmetered failed DB cleanup retains durable presence; existing worker fences and retries physical cleanup",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t),
      id = f.m.participants[0]!.id;
    const read = f.store.get.bind(f.store),
      change = f.store.change.bind(f.store);
    let databaseFailure = false;
    f.store.get = async (code) => {
      if (databaseFailure) throw new Error("Synthetic DB unavailable");
      return read(code);
    };
    f.store.change = async (code, fn) => {
      if (databaseFailure) throw new Error("Synthetic DB unavailable");
      return change(code, fn);
    };
    // Claim commits first; the opening callback then loses DB access before it can save a fence.
    f.onUpstream(() => {
      databaseFailure = true;
    });
    const peer = f.open();
    peer.on("error", () => {});
    await once(peer, "close");
    await flush();
    const retained = (await read(f.m.code))!.participants[0]!;
    assert.ok(retained.gatewayConnectionId);
    assert.ok(retained.gatewayPresenceUntil! > Date.now());
    assert.equal(mediaIdentity(retained), id);
    assert.deepEqual(f.removals, []);
    databaseFailure = false;
    await change(f.m.code, (m) => {
      m.participants[0]!.gatewayPresenceUntil = Date.now() - 1;
    });
    await assert.rejects(f.media.authorize(f.token), /Media access denied/);
    const expired = f.open();
    const rejection = await new Promise<Error>((resolve) =>
      expired.once("error", resolve),
    );
    assert.match(rejection.message, /403/);
    assert.equal(
      (await read(f.m.code))!.participants[0]!.gatewayConnectionId,
      retained.gatewayConnectionId,
    );
    f.media.client.removeParticipant = async () => {
      throw new Error("Synthetic SFU unavailable");
    };
    t.mock.timers.tick(5000);
    await flush();
    const pending = (await read(f.m.code))!.participants[0]!;
    assert.equal(pending.status, "admitted");
    assert.equal(pending.enforcementPending, true);
    assert.equal(pending.previousMediaIdentity, id);
    const rotated = mediaIdentity(pending);
    assert.notEqual(rotated, id);
    f.media.client.removeParticipant = async (_room, identity) => {
      f.removals.push(identity);
    };
    t.mock.timers.tick(5000);
    await flush();
    const recovered = (await read(f.m.code))!.participants[0]!;
    assert.equal(recovered.status, "admitted");
    assert.equal(recovered.enforcementPending, false);
    assert.equal(mediaIdentity(recovered), rotated);
    assert.deepEqual(f.removals, [id]);
    assert.equal(recovered.previousMediaIdentity, undefined);
  },
);
