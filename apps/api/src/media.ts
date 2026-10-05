import {
  AccessToken,
  RoomServiceClient,
  ServerError,
  TokenVerifier,
  TrackSource,
} from "livekit-server-sdk";
import { WebSocket, WebSocketServer } from "ws";
import type { FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import type { Meeting, Participant, Store } from "./store.js";
import { participantRoom } from "./store.js";
import { digest, safeEqual, HttpError } from "./security.js";
export interface Media {
  available: boolean;
  token(m: Meeting, p: Participant): Promise<string>;
  remove(m: Meeting, p: Participant): Promise<void>;
  end(m: Meeting): Promise<void>;
  close(): void;
}
export class LiveMedia implements Media {
  available: boolean;
  client: RoomServiceClient;
  verifier: TokenVerifier;
  sockets = new Map<string, Set<WebSocket>>();
  constructor(
    public config: Config,
    public store: Store,
  ) {
    this.available = !!config.livekitKey && !!config.livekitSecret;
    this.client = new RoomServiceClient(
      config.livekitUrl,
      config.livekitKey,
      config.livekitSecret,
    );
    this.verifier = new TokenVerifier(config.livekitKey, config.livekitSecret);
  }
  async token(m: Meeting, p: Participant) {
    if (!this.available)
      throw new HttpError(503, "Media server is not configured");
    const token = new AccessToken(
      this.config.livekitKey,
      this.config.livekitSecret,
      {
        identity: p.id,
        name: p.name,
        ttl: 120,
        metadata: JSON.stringify({ v: p.mediaVersion, code: m.code }),
      },
    );
    const sources: TrackSource[] = [];
    const audioAllowed =
      p.role !== "viewer" && p.audioAllowed && (!p.phone || !p.phone.muted);
    const videoAllowed =
      p.transport !== "phone" && p.role !== "viewer" && p.videoAllowed;
    if (audioAllowed) sources.push(TrackSource.MICROPHONE);
    if (videoAllowed)
      sources.push(TrackSource.CAMERA, TrackSource.SCREEN_SHARE);
    if (audioAllowed && videoAllowed)
      sources.push(TrackSource.SCREEN_SHARE_AUDIO);
    token.addGrant({
      room: participantRoom(m, p),
      roomJoin: true,
      canPublish: sources.length > 0,
      canPublishSources: sources,
      canSubscribe: true,
      canPublishData: false,
      canUpdateOwnMetadata: false,
    });
    return token.toJwt();
  }
  async authorize(token: string) {
    const c = await this.verifier.verify(token);
    const room = c.video?.room;
    if (!room || !c.sub || !c.video?.roomJoin)
      throw new HttpError(403, "Media access denied");
    let data: { v?: number; code?: string } = {};
    try {
      data = JSON.parse(c.metadata ?? "{}");
    } catch {}
    const m = data.code ? await this.store.get(data.code) : null;
    const p = m?.participants.find((x) => x.id === c.sub);
    if (
      !m ||
      m.ended ||
      !p ||
      p.status !== "admitted" ||
      p.enforcementPending ||
      p.expiresAt < Date.now() ||
      (p.phone && p.phone.leaseExpiresAt <= Date.now()) ||
      (p.transport === "phone" && !this.config.phoneEnabled) ||
      data.v !== p.mediaVersion ||
      room !== participantRoom(m, p)
    )
      throw new HttpError(403, "Media access denied");
    return { m, p };
  }
  async remove(m: Meeting, p: Participant) {
    for (const ws of this.sockets.get(p.id) ?? [])
      ws.close(4003, "Session changed");
    this.sockets.delete(p.id);
    if (!this.available) return;
    try {
      await this.client.removeParticipant(
        p.previousRoom ?? participantRoom(m, p),
        p.id,
      );
    } catch (e) {
      if (!(e instanceof ServerError && e.code === "not_found")) throw e;
    }
  }
  async end(m: Meeting) {
    for (const p of m.participants)
      for (const ws of this.sockets.get(p.id) ?? [])
        ws.close(4003, "Meeting ended");
    if (this.available)
      for (const room of [m.room, ...m.breakouts.map((b) => b.room)])
        try {
          await this.client.deleteRoom(room);
        } catch (e) {
          if (!(e instanceof ServerError && e.code === "not_found")) throw e;
        }
  }
  attach(app: FastifyInstance) {
    const wss = new WebSocketServer({
      noServer: true,
      maxPayload: 1024 * 1024,
    });
    app.server.on("upgrade", async (req, socket, head) => {
      const url = new URL(req.url ?? "/", this.config.origin);
      if (!/^\/rtc(?:\/v1)?$/.test(url.pathname)) {
        socket.destroy();
        return;
      }
      if (req.headers.origin && req.headers.origin !== this.config.origin) {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get("access_token") ?? "";
      try {
        const { m, p } = await this.authorize(token);
        const cookie =
          app.parseCookie(req.headers.cookie ?? "")[`mp_${m.code}`] ?? "";
        if (!safeEqual(p.tokenHash, digest(cookie)))
          throw new HttpError(403, "Media session required");
        wss.handleUpgrade(req, socket, head, (client) => {
          let closed = false;
          let expiryTimer: ReturnType<typeof setTimeout> | undefined;
          const target = new URL(this.config.livekitUrl);
          target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
          target.pathname = url.pathname;
          target.search = url.search;
          const upstream = new WebSocket(target, { maxPayload: 1024 * 1024 });
          const set = this.sockets.get(p.id) ?? new Set<WebSocket>();
          set.add(client);
          this.sockets.set(p.id, set);
          const stop = () => {
            if (closed) return;
            closed = true;
            if (expiryTimer) clearTimeout(expiryTimer);
            upstream.terminate();
            client.terminate();
            set.delete(client);
            if (!set.size) this.sockets.delete(p.id);
          };
          const checkExpiry = async () => {
            try {
              const state = await this.store.get(m.code);
              const member = state?.participants.find((x) => x.id === p.id);
              const deadline = member
                ? Math.min(
                    member.expiresAt,
                    member.phone?.leaseExpiresAt ?? Infinity,
                  )
                : 0;
              if (!state || !member || deadline <= Date.now()) {
                stop();
                await this.remove(m, p);
                return;
              }
              expiryTimer = setTimeout(
                () => void checkExpiry(),
                Math.min(deadline - Date.now(), 2147483647),
              );
              expiryTimer.unref();
            } catch {
              stop();
              await this.remove(m, p).catch(() => {});
            }
          };
          void checkExpiry();
          client.on("close", stop);
          client.on("error", stop);
          upstream.on("close", stop);
          upstream.on("error", stop);
          let authorized = false;
          const pending: { data: Buffer; binary: boolean }[] = [];
          client.on("message", (data, binary) => {
            if (!authorized || upstream.readyState !== WebSocket.OPEN) {
              if (pending.length > 32) return stop();
              pending.push({ data: Buffer.from(data as Buffer), binary });
              return;
            }
            upstream.send(data, { binary });
          });
          upstream.on("open", async () => {
            try {
              await this.authorize(token);
              if (closed) return;
              authorized = true;
              for (const item of pending)
                upstream.send(item.data, { binary: item.binary });
              pending.length = 0;
            } catch {
              stop();
              await this.remove(m, p).catch(() => {});
            }
          });
          let forwarding = Promise.resolve();
          upstream.on("message", (data, binary) => {
            forwarding = forwarding.then(async () => {
              try {
                const fresh = await this.store.get(m.code);
                const current = fresh?.participants.find((x) => x.id === p.id);
                if (
                  !fresh ||
                  fresh.ended ||
                  current?.status !== "admitted" ||
                  current.expiresAt <= Date.now() ||
                  (current.phone &&
                    current.phone.leaseExpiresAt <= Date.now()) ||
                  current.enforcementPending ||
                  current.mediaVersion !== p.mediaVersion
                ) {
                  stop();
                  await this.remove(m, p).catch(() => {});
                  return;
                }
                if (client.readyState === WebSocket.OPEN)
                  client.send(data, { binary });
              } catch {
                stop();
              }
            });
          });
        });
      } catch {
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
      }
    });
    app.get("/rtc/validate", async (req, reply) => {
      try {
        await this.authorize((req.query as any).access_token ?? "");
        return { ok: true };
      } catch {
        return reply.code(403).send({ error: "Media access denied" });
      }
    });
  }
  close() {
    for (const set of this.sockets.values())
      for (const ws of set) ws.terminate();
    this.sockets.clear();
  }
}
