import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { openGateway } from "../src/gateway.js";

// Uses only ephemeral loopback sockets and synthetic capabilities.
test("gateway preserves cookie scope, renews initial token, and forwards SDK refresh for real validation", async (t) => {
  const initial = "initial-token-".repeat(5),
    renewed = "renewed-token-".repeat(5),
    sdk = "sdk-refreshed-".repeat(5);
  const cookie = `mp_SELFHOST123=${"s".repeat(48)}`;
  const sockets = new Set<WebSocket>();
  const upstream = createServer((req, res) => {
    const token = new URL(req.url!, "http://localhost").searchParams.get(
      "access_token",
    );
    res
      .writeHead([initial, renewed, sdk].includes(token ?? "") ? 200 : 403)
      .end();
  });
  const wss = new WebSocketServer({ noServer: true });
  upstream.on("upgrade", (req, socket, head) => {
    const token = new URL(req.url!, "http://localhost").searchParams.get(
      "access_token",
    );
    if (
      ![initial, renewed, sdk].includes(token ?? "") ||
      req.headers.cookie !== cookie
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.once("close", () => sockets.delete(ws));
      ws.send(
        JSON.stringify({
          token,
          cookie: req.headers.cookie,
          origin: req.headers.origin,
        }),
      );
    });
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const grant = {
    token: initial,
    url: origin.replace(/^http/, "ws"),
    cookie,
    subscribeParticipantIds: [],
  };
  const proxy = await openGateway(grant, origin, true);
  t.after(async () => {
    await proxy.close();
    for (const ws of sockets) ws.terminate();
    wss.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  });
  async function request(token: string) {
    const ws = new WebSocket(`${proxy.url}/rtc`, {
      headers: { Authorization: `Bearer ${token}` },
      handshakeTimeout: 1000,
    });
    try {
      const [message] = await once(ws, "message");
      return JSON.parse(String(message));
    } finally {
      ws.terminate();
    }
  }
  assert.deepEqual(await request(initial), { token: initial, cookie, origin });
  proxy.updateGrant({ ...grant, token: renewed });
  assert.equal((await request(initial)).token, renewed);
  assert.equal(
    (await request(sdk)).token,
    sdk,
    "SDK-issued refresh must not be replaced with a stale authority token",
  );
  assert.throws(
    () => proxy.updateGrant({ ...grant, cookie: cookie + "changed" }),
    /scope/,
  );
  const validate = new URL("/rtc/validate", proxy.url.replace(/^ws/, "http"));
  assert.equal(
    (await fetch(validate, { headers: { Authorization: `Bearer ${initial}` } }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(validate, {
        headers: { Authorization: `Bearer ${"forged-".repeat(8)}` },
      })
    ).status,
    403,
  );
  assert.equal((await fetch(validate)).status, 404);
  assert.equal(
    (
      await fetch(new URL("/other", validate), {
        headers: { Authorization: `Bearer ${initial}` },
      })
    ).status,
    404,
  );
});

test("gateway rejects grant destination substitution before opening a listener", async () => {
  await assert.rejects(
    openGateway(
      {
        token: "t".repeat(40),
        url: "wss://other.example",
        cookie: `mp_SELFHOST123=${"s".repeat(40)}`,
        subscribeParticipantIds: [],
      },
      "https://meet.example",
    ),
    /configured gateway/,
  );
});
