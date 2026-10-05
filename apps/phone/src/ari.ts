import WebSocket from "ws";
import { z } from "zod";

// Endpoint semantics: official Asterisk ARI Channels, Bridges, Events, and
// Playbacks REST API documentation. Only the supervisor may authorize IDs.
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const absentResource = Symbol("ARI confirmed missing resource");
const text = z.string().max(256);
const channelSchema = z.object({
  id,
  name: text,
  state: text,
  caller: z.object({ name: text, number: text }).optional(),
  dialplan: z
    .object({
      context: text,
      exten: text,
      priority: z.number().int(),
      app_name: text.optional(),
      app_data: z.string().max(1024).optional(),
    })
    .optional(),
});
const playbackSchema = z.object({ id, state: text, target_uri: text });
const bridgeSchema = z.object({
  id,
  channels: z.array(id).max(256).default([]),
});
const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("StasisStart"),
    channel: channelSchema,
    args: z.array(text).max(16),
  }),
  z.object({
    type: z.enum([
      "StasisEnd",
      "ChannelDestroyed",
      "ChannelStateChange",
      "ChannelHangupRequest",
    ]),
    channel: channelSchema,
    cause: z.number().int().min(0).max(255).optional(),
  }),
  z.object({
    type: z.literal("ChannelDtmfReceived"),
    channel: channelSchema,
    digit: z.string().regex(/^[0-9A-D*#]$/),
    duration_ms: z.number().int().min(0).max(60000),
  }),
  z.object({
    type: z.enum(["PlaybackFinished", "PlaybackContinuing", "PlaybackStarted"]),
    playback: playbackSchema,
  }),
  z.object({ type: z.literal("BridgeDestroyed"), bridge: bridgeSchema }),
]);
const eventTypes = new Set([
  "StasisStart",
  "StasisEnd",
  "ChannelDestroyed",
  "ChannelStateChange",
  "ChannelHangupRequest",
  "ChannelDtmfReceived",
  "PlaybackFinished",
  "PlaybackContinuing",
  "PlaybackStarted",
  "BridgeDestroyed",
]);
export type AriChannel = z.infer<typeof channelSchema>;
export type AriPlayback = z.infer<typeof playbackSchema>;
export type AriBridge = z.infer<typeof bridgeSchema>;
export type AriEvent = z.infer<typeof eventSchema>;
export type AriChannelVariable =
  | "CHANNEL(endpoint)"
  | "CHANNEL(pjsip,secure)"
  | "CHANNEL(rtp,secure)";
const variables = new Set<AriChannelVariable>([
  "CHANNEL(endpoint)",
  "CHANNEL(pjsip,secure)",
  "CHANNEL(rtp,secure)",
]);

/** Unknown means the server may still complete a mutation; never release its
 * reservation merely because an immediate read subsequently returns 404. */
export class AriRequestError extends Error {
  constructor(
    public readonly outcome: "rejected" | "unknown",
    public readonly status?: number,
  ) {
    super(
      status
        ? `ARI request failed (${status})`
        : "ARI request outcome unavailable",
    );
    this.name = "AriRequestError";
  }
}
export interface AriConfig {
  /** Fixed operator-configured private management origin, without /ari. */
  baseUrl: string;
  username: string;
  password: string;
  app: string;
  development?: boolean;
  requestTimeoutMs?: number;
  heartbeatMs?: number;
  onEvent(event: AriEvent): void | Promise<void>;
  /** Invoked synchronously after connected=false; must immediately gate admission. */
  onFailure(error: Error): void;
}
export interface AriOriginate {
  channelId: string;
  /** Trusted supervisor configuration, never a caller-supplied dial string. */
  endpoint: string;
  appArgs?: string[];
  timeoutSeconds?: number;
}
function parameter<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error("Invalid ARI parameter");
  return parsed.data;
}

export class AriClient {
  private readonly config: AriConfig;
  private readonly base: URL;
  private readonly auth: string;
  private readonly timeout: number;
  private readonly heartbeatMs: number;
  private socket?: WebSocket;
  private heartbeat?: ReturnType<typeof setInterval>;
  private connecting?: Promise<void>;
  private closePromise?: Promise<void>;
  private failed = false;
  private closed = false;
  private ready = false;
  private pong = true;
  get connected() {
    return this.ready && !this.failed && !this.closed;
  }

  constructor(config: AriConfig) {
    this.config = { ...config };
    try {
      this.base = new URL(config.baseUrl);
    } catch {
      throw new Error("Invalid ARI management origin");
    }
    const local =
      ["127.0.0.1", "localhost", "[::1]", "asterisk"].includes(
        this.base.hostname,
      ) || this.base.hostname.endsWith(".localhost");
    if (
      this.base.username ||
      this.base.password ||
      this.base.search ||
      this.base.hash ||
      !["", "/"].includes(this.base.pathname) ||
      !(
        this.base.protocol === "https:" ||
        (config.development && local && this.base.protocol === "http:")
      ) ||
      process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
    )
      throw new Error("ARI requires a fixed origin with verified TLS");
    parameter(z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/), config.username);
    parameter(
      z
        .string()
        .min(32)
        .max(512)
        .regex(/^[^\x00-\x1f\x7f]+$/),
      config.password,
    );
    parameter(z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), config.app);
    this.timeout = parameter(
      z.number().int().min(100).max(10000),
      config.requestTimeoutMs ?? 4000,
    );
    this.heartbeatMs = parameter(
      z.number().int().min(100).max(5000),
      config.heartbeatMs ?? 3000,
    );
    this.auth = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  }

  private fail() {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.ready = false;
    clearInterval(this.heartbeat);
    this.socket?.terminate();
    // Never forward a transport error, response body, URI, caller identity or DTMF.
    try {
      this.config.onFailure(new Error("ARI control connection unavailable"));
    } catch {
      /* Gate callback must not escape an event handler. */
    }
  }
  connect(): Promise<void> {
    if (this.failed || this.closed)
      return Promise.reject(new Error("ARI client is terminal"));
    if (this.connecting) return this.connecting;
    const url = new URL("/ari/events", this.base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("app", this.config.app);
    url.searchParams.set("subscribeAll", "false");
    this.connecting = new Promise<void>((resolve, reject) => {
      const socket = (this.socket = new WebSocket(url, {
        headers: { Authorization: this.auth },
        rejectUnauthorized: true,
        followRedirects: false,
        handshakeTimeout: this.timeout,
        maxPayload: 65536,
        perMessageDeflate: false,
      }));
      const failure = () => {
        this.fail();
        reject(new Error("ARI event connection unavailable"));
      };
      socket.once("open", () => {
        if (this.closed || this.failed) {
          socket.terminate();
          reject(new Error("ARI client is terminal"));
          return;
        }
        this.ready = true;
        this.heartbeat = setInterval(() => {
          if (!this.pong || socket.readyState !== WebSocket.OPEN) {
            failure();
            return;
          }
          this.pong = false;
          socket.ping();
        }, this.heartbeatMs);
        this.heartbeat.unref();
        resolve();
      });
      socket.on("pong", () => {
        this.pong = true;
      });
      socket.on("error", failure);
      socket.on("close", failure);
      socket.on("message", (data, binary) => {
        if (!this.connected) return;
        try {
          if (binary) throw new Error();
          const body = JSON.parse(data.toString());
          const envelope = z
            .object({
              type: z.string().min(1).max(80),
              application: z.literal(this.config.app),
            })
            .parse(body);
          if (envelope.type === "ApplicationReplaced") throw new Error();
          if (!eventTypes.has(envelope.type)) return;
          const event = eventSchema.parse(body);
          const result = this.config.onEvent(event);
          if (result) void result.catch(() => this.fail());
        } catch {
          this.fail();
        }
      });
    });
    return this.connecting;
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.ready = false;
    clearInterval(this.heartbeat);
    this.closePromise = new Promise<void>((resolve) => {
      if (!this.socket || this.socket.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      this.socket.once("close", () => resolve());
      this.socket.terminate();
    });
    return this.closePromise;
  }
  private admitting() {
    if (!this.connected) throw new Error("ARI admission gate is closed");
  }
  private async request(
    method: "GET" | "POST" | "DELETE",
    path: string,
    query?: Record<string, string>,
    body?: unknown,
    absent = false,
  ): Promise<unknown> {
    if (this.closed) throw new AriRequestError("rejected");
    const url = new URL(`/ari${path}`, this.base);
    for (const [key, value] of Object.entries(query ?? {}))
      url.searchParams.set(key, value);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          Authorization: this.auth,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeout),
        redirect: "manual",
      });
      if (response.status === 404 && absent) {
        await response.body?.cancel();
        return absentResource;
      }
      if (!response.ok) {
        await response.body?.cancel();
        const uncertain =
          response.status < 400 ||
          response.status >= 500 ||
          response.status === 408;
        if (uncertain) this.fail();
        throw new AriRequestError(
          uncertain ? "unknown" : "rejected",
          response.status,
        );
      }
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        if (reader)
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > 262144) {
              await reader.cancel();
              throw new Error();
            }
            chunks.push(part.value);
          }
      } finally {
        reader?.releaseLock();
      }
      if (!size) return undefined;
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (error) {
      if (error instanceof AriRequestError) throw error;
      this.fail();
      throw new AriRequestError("unknown");
    }
  }
  private result<T>(schema: z.ZodType<T>, value: unknown): T {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      this.fail();
      throw new AriRequestError("unknown");
    }
    return parsed.data;
  }
  private channel(idValue: string) {
    return `/channels/${parameter(id, idValue)}`;
  }
  async listChannels(): Promise<AriChannel[]> {
    return this.result(
      z.array(channelSchema).max(256),
      await this.request("GET", "/channels"),
    );
  }
  async getChannel(channelId: string): Promise<AriChannel | undefined> {
    const result = await this.request(
      "GET",
      this.channel(channelId),
      undefined,
      undefined,
      true,
    );
    if (result === absentResource) return undefined;
    return this.result(
      channelSchema.extend({ id: z.literal(channelId) }),
      result,
    );
  }
  async getChannelVariable(
    channelId: string,
    variable: AriChannelVariable,
  ): Promise<string | undefined> {
    if (!variables.has(variable)) throw new Error("Invalid ARI variable");
    const result = await this.request(
      "GET",
      `${this.channel(channelId)}/variable`,
      { variable },
      undefined,
      true,
    );
    return result === absentResource
      ? undefined
      : this.result(z.object({ value: text }), result).value;
  }
  async answer(channelId: string): Promise<void> {
    this.admitting();
    await this.request("POST", `${this.channel(channelId)}/answer`);
  }
  async hangup(channelId: string): Promise<void> {
    await this.request(
      "DELETE",
      this.channel(channelId),
      undefined,
      undefined,
      true,
    );
  }
  async originate(input: AriOriginate): Promise<AriChannel> {
    this.admitting();
    const endpoint = parameter(
      z
        .string()
        .max(256)
        .regex(/^PJSIP\/[A-Za-z0-9_.:@/-]+$/),
      input.endpoint,
    );
    const args = parameter(
      z.array(z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/)).max(8),
      input.appArgs ?? [],
    );
    const body = {
      endpoint,
      app: this.config.app,
      appArgs: args.join(","),
      timeout: parameter(
        z.number().int().min(1).max(60),
        input.timeoutSeconds ?? 30,
      ),
    };
    return this.result(
      channelSchema.extend({ id: z.literal(input.channelId) }),
      await this.request(
        "POST",
        this.channel(input.channelId),
        undefined,
        body,
      ),
    );
  }
  async play(
    channelId: string,
    playbackId: string,
    sound: string,
  ): Promise<AriPlayback> {
    this.admitting();
    const name = parameter(
      z
        .string()
        .max(128)
        .regex(/^(?:sound:)?[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/),
      sound,
    ).replace(/^sound:/, "");
    return this.result(
      playbackSchema.extend({
        id: z.literal(playbackId),
        target_uri: z.literal(`channel:${channelId}`),
      }),
      await this.request(
        "POST",
        `${this.channel(channelId)}/play/${parameter(id, playbackId)}`,
        { media: `sound:${name}` },
      ),
    );
  }
  async stopPlayback(playbackId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/playbacks/${parameter(id, playbackId)}`,
      undefined,
      undefined,
      true,
    );
  }
  async createBridge(bridgeId: string): Promise<AriBridge> {
    this.admitting();
    return this.result(
      bridgeSchema.extend({ id: z.literal(bridgeId) }),
      await this.request("POST", `/bridges/${parameter(id, bridgeId)}`, {
        type: "mixing,proxy_media,dtmf_events",
      }),
    );
  }
  async getBridge(bridgeId: string): Promise<AriBridge | undefined> {
    const result = await this.request(
      "GET",
      `/bridges/${parameter(id, bridgeId)}`,
      undefined,
      undefined,
      true,
    );
    return result === absentResource
      ? undefined
      : this.result(bridgeSchema.extend({ id: z.literal(bridgeId) }), result);
  }
  async addChannel(bridgeId: string, channelId: string): Promise<void> {
    this.admitting();
    await this.request(
      "POST",
      `/bridges/${parameter(id, bridgeId)}/addChannel`,
      { channel: parameter(id, channelId) },
    );
  }
  async destroyBridge(bridgeId: string): Promise<void> {
    await this.request(
      "DELETE",
      `/bridges/${parameter(id, bridgeId)}`,
      undefined,
      undefined,
      true,
    );
  }
}
