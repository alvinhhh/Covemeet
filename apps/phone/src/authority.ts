import { z } from "zod";

export const joinSchema = z
  .object({
    locator: z.string().regex(/^\d{12}$/),
    pin: z.string().regex(/^\d{8}$/),
    callId: z.string().uuid(),
    trunkId: z.string().min(1).max(128),
    callerId: z
      .string()
      .regex(/^\+[1-9]\d{1,14}$/)
      .optional(),
  })
  .strict();
export type JoinInput = z.infer<typeof joinSchema>;
export const sessionSchema = z.object({
  code: z.string().regex(/^[A-Z0-9]{6,48}$/),
  participantId: z.string().uuid(),
  sessionToken: z.string().min(32).max(512),
  expiresAt: z.number().int().positive(),
});
export type PhoneSession = z.infer<typeof sessionSchema>;
export const grantSchema = z.object({
  token: z.string().min(32).max(16384),
  url: z.string().url(),
  cookie: z.string().min(32).max(1024),
  subscribeParticipantIds: z.array(z.string().uuid()).max(1100),
});
export type MeetingGrant = z.infer<typeof grantSchema>;
export const pollSchema = z.object({
  state: z.enum(["waiting", "admitted", "ended"]),
  mediaVersion: z.number().int().nonnegative(),
  muted: z.boolean(),
  handRaised: z.boolean(),
  audioAllowed: z.boolean(),
  leaseExpiresAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().positive(),
  grant: grantSchema.optional(),
});
export type CallPolicy = z.infer<typeof pollSchema>;
export type CallAction = "poll" | "leave" | "toggle-mute" | "toggle-hand";
export interface Authority {
  join(input: JoinInput): Promise<PhoneSession>;
  action(
    session: PhoneSession,
    callId: string,
    action: CallAction,
  ): Promise<CallPolicy>;
}

export function serviceUrl(
  value: string,
  protocols: string[],
  development = false,
): URL {
  const url = new URL(value);
  if (
    !protocols.includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["", "/"].includes(url.pathname)
  )
    throw new Error("Invalid phone service endpoint");
  const local =
    ["localhost", "127.0.0.1", "[::1]", "core", "livekit"].includes(
      url.hostname,
    ) || url.hostname.endsWith(".localhost");
  if (["http:", "ws:"].includes(url.protocol) && !(development && local))
    throw new Error("Phone service requires verified TLS");
  return url;
}

export class PhoneActionDenied extends Error {}

export class HttpAuthority implements Authority {
  private readonly base: URL;
  constructor(
    url: string,
    private readonly key: string,
    development = false,
  ) {
    this.base = serviceUrl(url, ["https:", "http:"], development);
    if (key.length < 32 || /[\r\n]/.test(key))
      throw new Error("Phone gateway key required");
  }
  private async request(
    path: string,
    body: unknown,
    allowActionDenial = false,
  ): Promise<unknown> {
    const response = await fetch(new URL(path, this.base), {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(4000),
      headers: {
        Authorization: `Bearer ${this.key}`,
        "X-Requested-With": "CovemeetPhone",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (reader)
      try {
        while (true) {
          const result = await reader.read();
          if (result.done) break;
          size += result.value.length;
          if (size > 65536) {
            await reader.cancel();
            throw new Error("Phone authority response too large");
          }
          chunks.push(result.value);
        }
      } finally {
        reader.releaseLock();
      }
    const text = Buffer.concat(chunks).toString("utf8");
    // Do not include response bodies, capabilities, caller IDs, or PINs in errors/logs.
    if (!response.ok) {
      if (allowActionDenial && response.status === 403) {
        let body: any;
        try {
          body = JSON.parse(text);
        } catch {}
        if (body?.error === "Speaking permission required")
          throw new PhoneActionDenied("Speaking permission required");
      }
      throw new Error(`Phone authority rejected request (${response.status})`);
    }
    return JSON.parse(text);
  }
  async join(input: JoinInput) {
    return sessionSchema.parse(
      await this.request("/api/internal/phone/calls", joinSchema.parse(input)),
    );
  }
  async action(session: PhoneSession, callId: string, action: CallAction) {
    sessionSchema.parse(session);
    return pollSchema.parse(
      await this.request(
        `/api/internal/phone/calls/${session.code}/${session.participantId}`,
        { callId, sessionToken: session.sessionToken, action },
        action === "toggle-mute",
      ),
    );
  }
}
