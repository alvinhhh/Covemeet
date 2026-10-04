import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { serviceUrl, type MeetingGrant } from "./authority.js";

export interface GatewayProxy {
  url: string;
  updateGrant(grant: MeetingGrant): void;
  close(): Promise<void>;
}
// rtc-node has no custom Cookie header. This loopback-only adapter adds exactly
// one authority-issued cookie and token to the existing application gateway.
export async function openGateway(
  grant: MeetingGrant,
  expectedOrigin: string,
  development = false,
): Promise<GatewayProxy> {
  const origin = serviceUrl(expectedOrigin, ["https:", "http:"], development);
  const upstreamBase = serviceUrl(grant.url, ["wss:", "ws:"], development);
  if (
    upstreamBase.host !== origin.host ||
    (upstreamBase.protocol === "wss:") !== (origin.protocol === "https:")
  )
    throw new Error("Meeting grant does not target the configured gateway");
  if (!/^mp_[A-Z0-9]{6,48}=[A-Za-z0-9_-]{32,512}$/.test(grant.cookie))
    throw new Error("Invalid meeting session cookie");
  const initialToken = grant.token;
  let currentToken = grant.token;
  const sockets = new Set<WebSocket>();
  const incomingSockets = new Set<import("node:net").Socket>();
  let closed = false;
  const authorize = (raw = "", authorization?: string) => {
    const u = new URL(raw, "http://127.0.0.1");
    const provided = authorization?.startsWith("Bearer ")
      ? authorization.slice(7)
      : (u.searchParams.get("access_token") ?? "");
    if (provided.length < 32 || provided.length > 16384) return null;
    const given = Buffer.from(provided),
      expected = Buffer.from(initialToken);
    // Only replace the original known capability. SDK-refreshed tokens are
    // forwarded unchanged so the real gateway verifies signature + session.
    const token =
      given.length === expected.length && timingSafeEqual(given, expected)
        ? currentToken
        : provided;
    if (!/^\/rtc(?:\/v1)?(?:\/validate)?$/.test(u.pathname)) return null;
    return { url: u, token };
  };
  const server = createServer(async (req, res) => {
    const authorized = authorize(req.url, req.headers.authorization);
    const url = authorized?.url;
    if (
      closed ||
      req.method !== "GET" ||
      !url?.pathname.endsWith("/validate")
    ) {
      res.writeHead(404).end();
      return;
    }
    const target = new URL("/rtc/validate", origin);
    target.searchParams.set("access_token", authorized!.token);
    try {
      const response = await fetch(target, {
        redirect: "error",
        signal: AbortSignal.timeout(4000),
        headers: { Origin: origin.origin, Cookie: grant.cookie },
      });
      await response.body?.cancel();
      res
        .writeHead(response.ok ? 200 : 403, {
          "Content-Type": "application/json",
        })
        .end(response.ok ? '{"ok":true}' : '{"error":"Denied"}');
    } catch {
      res.writeHead(502).end();
    }
  });
  server.on("connection", (socket) => {
    incomingSockets.add(socket);
    socket.once("close", () => incomingSockets.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.on("upgrade", (req, socket, head) => {
    const authorized = authorize(req.url, req.headers.authorization);
    const url = authorized?.url;
    if (
      closed ||
      !url ||
      url.pathname.endsWith("/validate") ||
      sockets.size >= 4
    ) {
      socket.destroy();
      return;
    }
    const target = new URL(url.pathname, upstreamBase);
    target.search = url.search;
    target.searchParams.set("access_token", authorized!.token);
    const upstream = new WebSocket(target, {
      headers: { Origin: origin.origin, Cookie: grant.cookie },
      maxPayload: 1024 * 1024,
      handshakeTimeout: 4000,
      followRedirects: false,
    });
    sockets.add(upstream);
    upstream.on("error", () => {
      socket.destroy();
      upstream.terminate();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      socket.destroy();
    });
    upstream.on("unexpected-response", (_req, response) => {
      response.resume();
      socket.destroy();
      upstream.terminate();
    });
    upstream.once("open", () => {
      if (closed || socket.destroyed) {
        upstream.terminate();
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        sockets.add(client);
        const stop = () => {
          sockets.delete(client);
          sockets.delete(upstream);
          client.terminate();
          upstream.terminate();
        };
        client.on("error", stop);
        client.on("close", stop);
        upstream.on("close", stop);
        const forward = (
          to: WebSocket,
          data: import("ws").RawData,
          binary: boolean,
        ) => {
          if (
            to.readyState !== WebSocket.OPEN ||
            to.bufferedAmount > 1024 * 1024
          ) {
            stop();
            return;
          }
          to.send(data, { binary });
        };
        client.on("message", (data, binary) => forward(upstream, data, binary));
        upstream.on("message", (data, binary) => forward(client, data, binary));
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Loopback gateway failed");
  return {
    url: `ws://127.0.0.1:${address.port}`,
    updateGrant(next) {
      if (
        next.cookie !== grant.cookie ||
        next.url !== grant.url ||
        next.token.length < 32 ||
        next.token.length > 16384
      )
        throw new Error("Gateway grant scope changed");
      currentToken = next.token;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const ws of sockets) ws.terminate();
      for (const socket of incomingSockets) socket.destroy();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
