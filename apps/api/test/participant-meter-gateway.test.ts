import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { WebSocket, WebSocketServer } from "ws";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/server.js";
import { LiveMedia } from "../src/media.js";
import { MemoryStore, type Meeting } from "../src/store.js";
import { entitlementFor } from "../src/meeting-limits.js";
import { digest } from "../src/security.js";

test(
  "real gateway replacement fences stale sockets without removing its successor; rejected upstream spends zero",
  { timeout: 10000 },
  async (t) => {
    const upstreamServer = createServer(),
      upstreamSockets: WebSocket[] = [];
    const clients: WebSocket[] = [];
    let app: Awaited<ReturnType<typeof createApp>> | undefined;
    const wss = new WebSocketServer({ noServer: true });
    t.after(async () => {
      for (const peer of [...clients, ...upstreamSockets]) peer.terminate();
      await app?.close();
      wss.close();
      await new Promise<void>((resolve) =>
        upstreamServer.close(() => resolve()),
      );
    });
    let reject = false;
    upstreamServer.on("upgrade", (request, socket, head) => {
      if (reject) {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(request, socket, head, (peer) => {
        upstreamSockets.push(peer);
        peer.send("connected");
      });
    });
    await new Promise<void>((resolve) =>
      upstreamServer.listen(0, "127.0.0.1", resolve),
    );
    const upstreamPort = (upstreamServer.address() as { port: number }).port;
    const config = loadConfig({
      NODE_ENV: "test",
      EDITION: "hosted",
      SITE_ORIGIN: "http://localhost:5173",
      SESSION_SECRET: "gateway-meter-fixture-secret-at-least32chars",
      CREATION_KEY: "gateway-meter-fixture-creation-at-least32chars",
      LIVEKIT_API_KEY: "fixture",
      LIVEKIT_API_SECRET: "gateway-meter-fixture-livekit-at-least32chars",
      LIVEKIT_URL: `http://127.0.0.1:${upstreamPort}`,
      RECORDING_ENABLED: "false",
    });
    const store = new MemoryStore(),
      media = new LiveMedia(config, store);
    const removals: string[] = [];
    media.client.removeParticipant = async (_room, identity) => {
      removals.push(identity);
    };
    media.client.deleteRoom = async () => {};
    const owner = randomUUID(),
      at = Date.now();
    const grant = {
      billingOwnerId: owner,
      revision: 1,
      validUntil: at + 300000,
      enabled: true,
      quota: { anchorAt: at, participantSecondsPerMonth: 120 },
      hostAccountIds: [owner],
      limits: {
        participants: 100,
        durationSeconds: 7200,
        concurrentMeetings: 1,
      },
    };
    await store.setHostedEntitlement(grant);
    const session = "fixture-gateway-cookie-at-least32characters";
    const participant = {
      id: randomUUID(),
      name: "Host",
      role: "host" as const,
      status: "admitted" as const,
      audioAllowed: true,
      videoAllowed: true,
      mediaVersion: 1,
      tokenHash: digest(session),
      expiresAt: at + 7200000,
      ipHash: "fixture",
      deviceHash: "fixture",
      breakoutId: null,
    };
    const m: Meeting = {
      code: "METERGATEWAYFIXTURE",
      id: randomUUID(),
      room: randomUUID(),
      title: "Synthetic gateway fixture",
      mode: "meeting",
      hosted: {
        accountId: owner,
        billingOwnerId: owner,
        version: 1,
        entitlement: entitlementFor(grant, owner),
      },
      lifecycle: { startedAt: at, deadlineAt: at + 7200000 },
      locked: false,
      ended: false,
      recordingAllowed: false,
      createdAt: at,
      revision: 1,
      passwordHash: "fixture",
      hostTokenExpiresAt: at,
      participants: [participant],
      bans: { ip: [], device: [] },
      breakouts: [],
      messages: [],
      recordings: [],
    };
    await store.create(m);
    app = await createApp(config, store, media);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const port = (app.server.address() as { port: number }).port;
    const token = await media.token(m, participant);
    const open = async () => {
      const client = new WebSocket(
        `ws://127.0.0.1:${port}/rtc?access_token=${encodeURIComponent(token)}`,
        {
          headers: { Origin: config.origin, Cookie: `mp_${m.code}=${session}` },
        },
      );
      clients.push(client);
      await once(client, "message");
      return client;
    };
    const first = await open();
    const firstGeneration = (await store.get(m.code))!.participants[0]!.meter!
      .connectionId;
    const second = await open();
    const secondGeneration = (await store.get(m.code))!.participants[0]!.meter!
      .connectionId;
    assert.notEqual(secondGeneration, firstGeneration);
    const firstClosed = once(first, "close");
    // A message on the stale SFU socket exercises the destructive-error branch,
    // while its ensuing close callback also races the new owner's heartbeat.
    upstreamSockets[0]!.send("stale");
    await firstClosed;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(second.readyState, WebSocket.OPEN);
    assert.deepEqual(removals, []);
    assert.equal(
      (await store.get(m.code))!.participants[0]!.meter!.connectionId,
      secondGeneration,
    );
    assert.equal(
      (await store.get(m.code))!.participants[0]!.enforcementPending,
      undefined,
    );

    // Separate logical participant, so a failed upstream cannot inherit active usage.
    const guest = {
      ...participant,
      id: randomUUID(),
      name: "Guest",
      role: "participant" as const,
    };
    await store.change(m.code, (state) => {
      state.participants.push(guest);
    });
    reject = true;
    const guestToken = await media.token((await store.get(m.code))!, guest);
    const failed = new WebSocket(
      `ws://127.0.0.1:${port}/rtc?access_token=${encodeURIComponent(guestToken)}`,
      { headers: { Origin: config.origin, Cookie: `mp_${m.code}=${session}` } },
    );
    clients.push(failed);
    failed.on("error", () => {});
    await once(failed, "close");
    const pending = (await store.get(m.code))!.participants.find(
      (p) => p.id === guest.id,
    )!;
    assert.equal(pending.meter!.phase, "connecting");
    assert.equal(pending.meter!.connectedAt, undefined);
    assert.equal(
      pending.meter!.fundedUntil - pending.meter!.accountedAt,
      30000,
    );
    // A failed handshake still holds its reserve until explicit cleanup proof.
    await store.change(m.code, (state) => {
      const p = state.participants.find((p) => p.id === guest.id)!;
      p.mediaVersion++;
      p.enforcementPending = true;
    });
    const before = store.usageLedgers
      .get(owner)!
      .windows.reduce((sum, window) => sum + window.usedMs, 0);
    await store.settleParticipantMeter(m.code, guest.id, 2, pending.meter);
    assert.equal(
      (await store.get(m.code))!.participants.find((p) => p.id === guest.id)!
        .meter,
      undefined,
    );
    const after = store.usageLedgers
      .get(owner)!
      .windows.reduce((sum, window) => sum + window.usedMs, 0);
    // Only the still-connected host can add elapsed usage during that transaction.
    assert.ok(after - before < 1000);
    assert.deepEqual(removals, []);
  },
);
