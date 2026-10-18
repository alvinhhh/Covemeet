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
import { entitlementFor } from "../src/meeting-limits.js";

async function fixture(t: TestContext, metered = false) {
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
    ...(metered
      ? {
          EDITION: "hosted",
          CREATION_KEY: "generation-creation-at-least32characters",
        }
      : {}),
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
  if (metered) {
    const owner = randomUUID();
    const grant = {
      billingOwnerId: owner,
      revision: 1,
      validUntil: Date.now() + 300000,
      enabled: true,
      quota: { anchorAt: Date.now(), participantSecondsPerMonth: 120 },
      hostAccountIds: [owner],
      limits: {
        participants: 100,
        durationSeconds: 7200,
        concurrentMeetings: 1,
      },
    };
    await store.setHostedEntitlement(grant);
    m.hosted = {
      accountId: owner,
      billingOwnerId: owner,
      version: 1,
      entitlement: entitlementFor(grant, owner),
    };
    m.lifecycle = { startedAt: Date.now(), deadlineAt: Date.now() + 60000 };
  }
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

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function holdRead(f: Awaited<ReturnType<typeof fixture>>, stale = false) {
  const entered = gate(),
    released = gate(),
    read = f.store.get.bind(f.store);
  let first = true,
    failure: Error | undefined;
  f.store.get = async (code) => {
    if (!first) return read(code);
    first = false;
    const snapshot = stale ? await read(code) : undefined;
    entered.resolve();
    await released.promise;
    if (failure) throw failure;
    return stale ? snapshot! : read(code);
  };
  return {
    entered: entered.promise,
    release: released.resolve,
    reject() {
      failure = new Error("Synthetic DB unavailable");
      released.resolve();
    },
  };
}

for (const opening of [false, true])
  test(
    `normal SFU close drains ordered binary and text packets ${opening ? "during opening authorization" : "after opening"}`,
    { timeout: 6000 },
    async (t) => {
      const f = await fixture(t);
      let held: ReturnType<typeof holdRead> | undefined;
      if (opening)
        f.onUpstream(() => {
          held = holdRead(f);
        });
      const client = f.open(),
        messages: { text: string; binary: boolean }[] = [];
      client.on("message", (data, binary) =>
        messages.push({ text: data.toString(), binary }),
      );
      const closed = once(client, "close");
      if (opening) {
        await once(client, "open");
        while (!held) await flush();
      } else {
        await once(client, "message");
        held = holdRead(f);
      }
      const gateway = [...f.media.sockets.values()][0]!.values().next().value!;
      const gatewayClosed = once(gateway, "close");
      f.upstreams[0]!.send(Buffer.from("binary"));
      f.upstreams[0]!.send("final");
      const upstreamClosed = once(f.upstreams[0]!, "close");
      f.upstreams[0]!.close(1000);
      await held!.entered;
      await upstreamClosed;
      assert.equal(client.readyState, WebSocket.OPEN);
      held!.release();
      const [code] = await closed;
      assert.equal(code, 1000);
      assert.deepEqual(messages, [
        { text: "connected", binary: false },
        { text: "binary", binary: true },
        { text: "final", binary: false },
      ]);
      assert.deepEqual(f.removals, []);
      await gatewayClosed;
      assert.equal(f.media.sockets.size, 0);
    },
  );

for (const action of [
  "revoke",
  "dispose",
  "client-close",
  "client-error",
] as const)
  test(
    `normal drain is canceled by ${action} even when a held read returns an old authorized snapshot`,
    { timeout: 6000 },
    async (t) => {
      const f = await fixture(t),
        client = f.open();
      await once(client, "message");
      const gateway = [...f.media.sockets.values()][0]!.values().next().value!;
      const messages: string[] = [];
      client.on("message", (data) => messages.push(data.toString()));
      const held = holdRead(f, true),
        closed = once(client, "close");
      f.upstreams[0]!.send("must not escape");
      f.upstreams[0]!.close(1000);
      await held.entered;
      await once(f.upstreams[0]!, "close");
      if (action === "revoke") await f.media.remove(f.m, f.m.participants[0]!);
      if (action === "dispose") f.media.close();
      if (action === "client-close") client.close();
      if (action === "client-error")
        gateway.emit("error", new Error("Synthetic transport error"));
      await closed;
      const changes = t.mock.method(f.store, "change"),
        timers = t.mock.method(globalThis, "setTimeout");
      held.release();
      await flush();
      await flush();
      assert.deepEqual(messages, []);
      assert.equal(changes.mock.callCount(), 0);
      assert.equal(timers.mock.callCount(), 0);
      assert.equal(f.media.sockets.size, 0);
    },
  );

for (const condition of [
  "participant-expired",
  "meeting-ended",
  "version",
  "identity",
  "successor",
  "presence-expired",
  "meter-successor",
  "meter-closing",
  "meter-unfunded",
  "meter-presence-expired",
] as const)
  test(
    `queued final frame is denied by fresh ${condition} authority`,
    { timeout: 6000 },
    async (t) => {
      const metered = condition.startsWith("meter-"),
        f = await fixture(t, metered),
        client = f.open();
      await once(client, "message");
      const messages: string[] = [];
      client.on("message", (data) => messages.push(data.toString()));
      const held = holdRead(f),
        closed = once(client, "close");
      f.upstreams[0]!.send("denied");
      f.upstreams[0]!.close(1000);
      await held.entered;
      await f.store.change(f.m.code, (m) => {
        const p = m.participants[0]!;
        if (condition === "participant-expired") p.expiresAt = Date.now() - 1;
        if (condition === "meeting-ended") m.ended = true;
        if (condition === "version") p.mediaVersion++;
        if (condition === "identity") p.mediaIdentity = randomUUID();
        if (condition === "successor") p.gatewayConnectionId = randomUUID();
        if (condition === "presence-expired")
          p.gatewayPresenceUntil = Date.now() - 1;
        if (condition === "meter-successor")
          p.meter!.connectionId = randomUUID();
        if (condition === "meter-closing") p.meter!.phase = "closing";
        if (condition === "meter-unfunded")
          p.meter!.fundedUntil = Date.now() - 1;
        if (condition === "meter-presence-expired")
          p.meter!.presenceUntil = Date.now() - 1;
      });
      held.release();
      assert.notEqual((await closed)[0], 1000);
      await flush();
      assert.deepEqual(messages, []);
      if (["version", "identity", "successor"].includes(condition) || metered)
        assert.deepEqual(f.removals, []);
    },
  );

for (const failure of [
  "abnormal-close",
  "upstream-error",
  "read-rejection",
  "send-rejection",
] as const)
  test(
    `${failure} cancels queued signaling without a successful normal close`,
    { timeout: 6000 },
    async (t) => {
      const f = await fixture(t),
        client = f.open();
      await once(client, "message");
      const messages: string[] = [];
      client.on("message", (data) => messages.push(data.toString()));
      const gateway = [...f.media.sockets.values()][0]!.values().next().value!;
      if (failure === "send-rejection")
        t.mock.method(
          gateway,
          "send",
          (
            _data: unknown,
            _options: unknown,
            callback: (error: Error) => void,
          ) => callback(new Error("Synthetic send failure")),
        );
      const held = holdRead(f),
        closed = once(client, "close");
      f.upstreams[0]!.send("discarded");
      await held.entered;
      if (failure === "abnormal-close") f.upstreams[0]!.close(1008, "Denied");
      else if (failure === "upstream-error") f.upstreams[0]!.terminate();
      else f.upstreams[0]!.close(1000);
      await once(f.upstreams[0]!, "close");
      if (failure === "abnormal-close" || failure === "upstream-error")
        await closed;
      if (failure === "read-rejection") held.reject();
      else held.release();
      assert.notEqual((await closed)[0], 1000);
      assert.deepEqual(messages, []);
    },
  );

test(
  "a hung final read cannot outlive the total drain deadline or recreate work after release",
  { timeout: 6000 },
  async (t) => {
    const f = await fixture(t),
      client = f.open();
    await once(client, "message");
    const messages: string[] = [];
    client.on("message", (data) => messages.push(data.toString()));
    const held = holdRead(f),
      closed = once(client, "close"),
      started = performance.now();
    f.upstreams[0]!.send("late");
    f.upstreams[0]!.close(1000);
    await held.entered;
    assert.equal((await closed)[0], 1006);
    assert(performance.now() - started < 1800);
    const timers = t.mock.method(globalThis, "setTimeout"),
      changes = t.mock.method(f.store, "change");
    held.release();
    await flush();
    await flush();
    assert.deepEqual(messages, []);
    assert.equal(timers.mock.callCount(), 0);
    assert.equal(changes.mock.callCount(), 0);
    assert.deepEqual(f.removals, []);
  },
);

test(
  "a downstream that cannot acknowledge close is terminated within the same total deadline",
  { timeout: 6000 },
  async (t) => {
    const f = await fixture(t),
      client = f.open();
    await once(client, "message");
    const gateway = [...f.media.sockets.values()][0]!.values().next().value!;
    client.pause();
    const closed = once(gateway, "close"),
      started = performance.now();
    f.upstreams[0]!.send("final");
    f.upstreams[0]!.close(1000);
    await closed;
    assert(performance.now() - started < 1800);
    assert.equal(f.media.sockets.size, 0);
    client.resume();
  },
);

test(
  "an expiry read released after disposal cannot extend presence or recreate its timer",
  { timeout: 6000 },
  async (t) => {
    const f = await fixture(t);
    await f.store.change(f.m.code, (m) => {
      m.participants[0]!.expiresAt = Date.now() + 500;
    });
    const client = f.open();
    await once(client, "message");
    const held = holdRead(f, true);
    await held.entered;
    const closed = once(client, "close");
    f.media.close();
    await closed;
    const changes = t.mock.method(f.store, "change"),
      timers = t.mock.method(globalThis, "setTimeout");
    held.release();
    await flush();
    await flush();
    assert.equal(changes.mock.callCount(), 0);
    assert.equal(timers.mock.callCount(), 0);
    assert.deepEqual(f.removals, []);
  },
);

test(
  "a final read completed beyond the drain deadline cannot send before the timer runs",
  { timeout: 6000 },
  async (t) => {
    const f = await fixture(t),
      client = f.open();
    await once(client, "message");
    const messages: string[] = [];
    client.on("message", (data) => messages.push(data.toString()));
    const held = holdRead(f),
      closed = once(client, "close"),
      draining = gate();
    const now = Date.now,
      timeout = setTimeout;
    let advance = 0;
    t.mock.method(Date, "now", () => now() + advance);
    t.mock.method(
      globalThis,
      "setTimeout",
      (
        callback: (...args: unknown[]) => void,
        delay: number,
        ...args: unknown[]
      ) => {
        if (delay <= 1000) draining.resolve();
        return timeout(callback, delay, ...args);
      },
    );
    f.upstreams[0]!.send("past deadline");
    f.upstreams[0]!.close(1000);
    await held.entered;
    await draining.promise;
    advance = 2000;
    held.release();
    assert.equal((await closed)[0], 1006);
    assert.deepEqual(messages, []);
    assert.deepEqual(f.removals, []);
  },
);
