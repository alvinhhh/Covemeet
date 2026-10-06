import {
  completeMediaFence,
  fenceParticipantMedia,
  gatewayPresenceExpired,
  mediaIdentity,
} from "./media-identity.js";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import staticFiles from "@fastify/static";
import { existsSync } from "node:fs";
import { randomUUID, randomInt } from "node:crypto";
import { createMailBudget, createMailTransport } from "@meeting-platform/mail";
import { z } from "zod";
import { whiteboardInput } from "./whiteboard.js";
import type { Config } from "./config.js";
import type { Meeting, Participant, Store } from "./store.js";
import type { Media } from "./media.js";
import { LiveMedia } from "./media.js";
import {
  checkPassword,
  digest,
  HttpError,
  keyedDigest,
  meetingCode,
  normalizeCode,
  passwordHash,
  randomToken,
  safeEqual,
  signedDevice,
  verifyDevice,
} from "./security.js";
import { RecordingService } from "./recordings.js";
import { PhoneService, revokePhoneParticipants } from "./phone.js";
import { PhoneDialogService } from "./phone-dialogs.js";
import {
  endMeeting,
  entitlementSchema,
  meetingAllowed,
  participantLimit,
  occupiesMeetingSeat,
  requireWebinarViewerSeat,
  webinarViewerLimit,
  requireMeetingAccess,
  requireMeetingSeat,
} from "./meeting-limits.js";

const name = z.string().trim().min(1).max(80),
  password = z.string().min(1).max(256);
const meetingInput = z
  .object({
    title: name,
    hostName: name,
    password,
    mode: z.enum(["meeting", "webinar"]),
  })
  .strict();
const hostedUuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const hostedVersion = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const webinarPresenterLimit = 10;
const occupiesSeat = (p: Participant) =>
  (p.status === "admitted" || p.status === "waiting") &&
  p.expiresAt > Date.now();
const imageUrl = z
  .string()
  .max(400)
  .refine(
    (s) => s === "" || /^\/api\/assets\/[a-f0-9]{64}$/.test(s),
    "Upload an image through the asset endpoint",
  );
const webUrl = z
  .string()
  .max(500)
  .refine((s) => {
    try {
      return s === "" || new URL(s).protocol === "https:";
    } catch {
      return false;
    }
  }, "Use an HTTPS URL");
export const brandingSchema = z
  .object({
    brandName: name,
    headline: z.string().max(120),
    description: z.string().max(500),
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    font: z.enum(["sans", "serif", "system"]),
    borderRadius: z.enum(["square", "rounded", "pill"]),
    logoUrl: imageUrl.optional(),
    backgroundUrl: imageUrl.optional(),
    supportUrl: webUrl.optional(),
    supportLabel: z.string().max(50).optional(),
    footerText: z.string().max(150).optional(),
    showHostButton: z.boolean(),
  })
  .strict();
export async function createApp(config: Config, store: Store, media: Media) {
  const app = Fastify({
    logger: false,
    trustProxy: config.trustProxy,
    bodyLimit: 3 * 1024 * 1024,
  });
  await app.register(cookie);
  await app.register(rateLimit, { max: 120, timeWindow: "1 minute" });
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string", bodyLimit: 8192 },
    (_req, body, done) => {
      const fields = new URLSearchParams(body as string);
      if ([...fields.keys()].length !== new Set(fields.keys()).size)
        return done(new HttpError(400, "Duplicate form fields"));
      done(null, Object.fromEntries(fields));
    },
  );
  const mailBudget =
    config.mailTransport === "ses" ? createMailBudget(config) : undefined;
  const mail = createMailTransport(config, { budget: mailBudget });
  const recordings = new RecordingService(config, store, mail);
  const phone = new PhoneService(config, store, media);
  const phoneDialogs = new PhoneDialogService(config, store, media);
  const defaults = {
    brandName: config.brandName,
    headline: "Meetings",
    description: "",
    accentColor: "#171717",
    backgroundColor: "#f5f5f5",
    font: "sans",
    borderRadius: "rounded",
    logoUrl: "",
    backgroundUrl: "",
    supportUrl: "",
    supportLabel: "Support",
    footerText: "",
    showHostButton: true,
  };
  const isDownloadForm = (req: FastifyRequest) =>
    req.method === "POST" &&
    req.routeOptions.url === "/api/meetings/:code/download" &&
    String(req.headers["content-type"] ?? "")
      .split(";", 1)[0]
      ?.trim() === "application/x-www-form-urlencoded";
  app.addHook("onSend", async (req, reply, payload) => {
    // Form navigation needs a document error response; JSON API calls stay JSON.
    if (
      isDownloadForm(req) &&
      reply.statusCode >= 400 &&
      typeof payload === "string"
    ) {
      reply.type("text/html; charset=utf-8");
      return `<!doctype html><meta charset="utf-8"><title>Download failed</title><pre>${payload.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</pre>`;
    }
    return payload;
  });
  app.addHook("onRequest", async (req, reply) => {
    reply
      .header("Cache-Control", "no-store")
      .header("Referrer-Policy", "same-origin")
      .header("X-Content-Type-Options", "nosniff");
    reply.header(
      "Permissions-Policy",
      "camera=(self), microphone=(self), display-capture=(self), geolocation=()",
    );
    if (config.production)
      reply.header(
        "Content-Security-Policy",
        `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' wss:${config.edition === "hosted" ? ` ${config.portalOrigin}` : ""}; worker-src 'self' blob:; frame-ancestors 'self'; base-uri 'none'; object-src 'none'`,
      );
    // Security dispatch must use the matched route, including decoded static segments.
    const route = req.routeOptions.url;
    if (["POST", "PATCH", "DELETE", "PUT"].includes(req.method)) {
      if (route?.startsWith("/api/internal/phone/")) {
        phone.authenticate(req.headers);
        if (
          !String(req.headers["content-type"] ?? "").startsWith(
            "application/json",
          )
        )
          throw new HttpError(415, "JSON required");
        return;
      }
      const machine =
        req.headers["x-requested-with"] === "MeetingPlatformHosted" &&
        !!config.creationKey &&
        safeEqual(
          String(req.headers.authorization ?? ""),
          `Bearer ${config.creationKey}`,
        ) &&
        !req.headers.origin;
      if (
        route?.startsWith("/api/internal/hosted/") &&
        (!machine ||
          config.edition !== "hosted" ||
          req.headers.origin !== undefined)
      )
        throw new HttpError(403, "Hosted service authentication required");
      // Native attachment downloads cannot set custom headers. This exact route
      // requires the configured Origin plus the existing host cookie and secrets.
      const formDownload =
        route === "/api/meetings/:code/download" &&
        req.headers.origin === config.origin &&
        String(req.headers["content-type"] ?? "")
          .split(";", 1)[0]
          ?.trim() === "application/x-www-form-urlencoded";
      if (
        !machine &&
        !formDownload &&
        req.headers["x-requested-with"] !== "MeetingPlatform"
      )
        throw new HttpError(403, "Request verification failed");
      const portalAction =
        config.edition === "self-hosted" &&
        (route === "/api/meetings" || route?.startsWith("/api/admin/"));
      if (
        req.headers.origin &&
        req.headers.origin !== config.origin &&
        !(portalAction && req.headers.origin === config.portalOrigin)
      )
        throw new HttpError(403, "Origin not allowed");
      if (
        !formDownload &&
        !String(req.headers["content-type"] ?? "").startsWith(
          "application/json",
        )
      )
        throw new HttpError(415, "JSON required");
    }
  });
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof z.ZodError)
      return reply
        .code(400)
        .send({ error: error.issues[0]?.message ?? "Invalid request" });
    if (error instanceof HttpError)
      return reply.code(error.status).send({
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      });
    const status = (error as any).statusCode;
    if (status === 429)
      return reply
        .code(429)
        .send({ error: "Too many attempts. Try again shortly." });
    if (status && status < 500)
      return reply.code(status).send({ error: "Invalid request" });
    req.log.error({ name: (error as Error).name }, "Request failed");
    return reply.code(503).send({ error: "Service unavailable. Try again." });
  });
  const cookieOpts = {
    httpOnly: true,
    secure: config.origin.startsWith("https:"),
    sameSite: "strict" as const,
    path: "/",
    maxAge: 43200,
  };
  const authCookie = (code: string) => `mp_${code}`;
  function actor(req: FastifyRequest, m: Meeting, host = false) {
    const token = req.cookies[authCookie(m.code)] ?? "";
    const p = m.participants.find(
      (x) => safeEqual(x.tokenHash, digest(token)) && x.expiresAt > Date.now(),
    );
    if (!p) throw new HttpError(401, "Join this meeting first");
    if (p.transport === "phone")
      throw new HttpError(403, "Phone sessions use the phone gateway");
    if (host && p.role !== "host")
      throw new HttpError(403, "Host permission required");
    if (host && p.status !== "admitted")
      throw new HttpError(403, "Host session is inactive");
    return p;
  }
  function active(m: Meeting) {
    requireMeetingAccess(m);
  }
  function whiteboardAccess(req: FastifyRequest, m: Meeting) {
    active(m);
    const p = actor(req, m);
    if (p.status !== "admitted") throw new HttpError(403, "Admission required");
    return {
      scope: p.breakoutId ?? "",
      authorId: p.id,
      host: p.role === "host",
    };
  }
  const codeOf = (req: FastifyRequest) =>
    normalizeCode((req.params as any).code ?? "");
  async function find(req: FastifyRequest) {
    const m = await store.get(codeOf(req));
    if (!m) throw new HttpError(404, "Meeting unavailable");
    return m;
  }
  function identity(req: FastifyRequest, reply: FastifyReply, code: string) {
    let device = verifyDevice(config.secret, req.cookies.mp_device);
    if (!device) {
      const signed = signedDevice(config.secret);
      device = signed.split(".")[0];
      reply.setCookie("mp_device", signed, {
        ...cookieOpts,
        maxAge: 30 * 86400,
      });
    }
    return {
      ipHash: keyedDigest(config.secret, `ip:${code}:${req.ip}`),
      deviceHash: keyedDigest(config.secret, `device:${code}:${device}`),
    };
  }
  function admin(req: FastifyRequest) {
    if (!config.creationKey)
      throw new HttpError(503, "Set a creation key to enable administration");
    const bearer = String(req.headers.authorization ?? "").replace(
      /^Bearer /,
      "",
    );
    if (safeEqual(bearer, config.creationKey)) return;
    const value = req.cookies.mp_admin ?? "";
    const [expiry, sig] = value.split(".");
    if (
      !expiry ||
      Number(expiry) < Date.now() ||
      !safeEqual(sig ?? "", keyedDigest(config.secret, `admin:${expiry}`))
    )
      throw new HttpError(401, "Administrator sign-in required");
  }
  async function enforce(m: Meeting, ps: Participant[]) {
    let failed = false;
    for (const p of ps) {
      try {
        if (p.meter && !media.available)
          throw new Error("Media cleanup is unavailable");
        await media.remove(m, p);
        await store.settleParticipantMeter(
          m.code,
          p.id,
          p.mediaVersion,
          p.meter,
        );
        await store.change(m.code, (state) => {
          const live = state.participants.find((x) => x.id === p.id);
          if (live) completeMediaFence(live, p);
        });
      } catch {
        failed = true;
      }
    }
    if (failed)
      throw new HttpError(
        503,
        "Restriction saved; media disconnect is pending. Retry or end the meeting.",
      );
  }
  app.get("/api/health", async () => ({ ok: true }));
  app.get("/api/config", async () => ({
    phoneAvailable: config.phoneEnabled,
    edition: config.edition,
    portalOrigin: config.portalOrigin,
    meetingOrigin: config.origin,
    brandName: config.brandName,
    branding: (await store.getSettings()) ?? defaults,
    recordingAvailable: recordings.available,
    mediaAvailable: media.available,
    creationRequiresKey: !!config.creationKey,
  }));
  app.post(
    "/api/internal/phone/calls",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req) => {
      phone.authenticate(req.headers);
      return phone.create(req.body);
    },
  );
  // All active calls share the gateway IP. Caller-driven controls must not
  // exhaust a shared HTTP quota needed for journal settlement or teardown.
  // Gateway authentication, admission limits and supervisor bounds still apply.
  app.post(
    "/api/internal/phone/calls/:code/:id",
    { config: { rateLimit: false } },
    async (req) => {
      phone.authenticate(req.headers);
      return phone.update(codeOf(req), (req.params as any).id, req.body);
    },
  );
  app.post(
    "/api/internal/phone/supervisors/claim",
    { config: { rateLimit: false } },
    async (req) => {
      phone.authenticate(req.headers);
      return phoneDialogs.claim(req.body);
    },
  );
  app.post(
    "/api/internal/phone/dialogs",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (req) => {
      phone.authenticate(req.headers);
      return phoneDialogs.create(req.body);
    },
  );
  app.post(
    "/api/internal/phone/dialogs/query",
    { config: { rateLimit: false } },
    async (req) => {
      phone.authenticate(req.headers);
      return phoneDialogs.query(req.body);
    },
  );
  for (const action of ["change", "stop", "finish"] as const) {
    const suffix = action === "change" ? "" : `/${action}`;
    app.post(
      `/api/internal/phone/dialogs/:callId${suffix}`,
      { config: { rateLimit: false } },
      async (req) => {
        phone.authenticate(req.headers);
        return phoneDialogs[action](
          (req.params as { callId: string }).callId,
          req.body,
        );
      },
    );
  }
  app.get("/api/meetings/:code/phone", async (req) => {
    const m = await find(req);
    actor(req, m, true);
    return phone.settings(m);
  });
  app.post(
    "/api/meetings/:code/phone",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      z.object({}).strict().parse(req.body);
      const initial = await find(req);
      active(initial);
      actor(req, initial, true);
      const credentials = await phone.credentials();
      let revoked: Participant[] = [];
      const m = await store.change(codeOf(req), (m) => {
        active(m);
        actor(req, m, true);
        revoked = revokePhoneParticipants(m);
        m.phoneAccess = {
          enabled: true,
          locator: credentials.locator,
          pinHash: credentials.pinHash,
        };
        return structuredClone(m);
      });
      await enforce(m, revoked);
      await store.audit(m.code, "host", "phone.rotate");
      return { ...phone.settings(m), pin: credentials.pin };
    },
  );
  app.delete("/api/meetings/:code/phone", async (req) => {
    z.object({}).strict().parse(req.body);
    let revoked: Participant[] = [];
    const m = await store.change(codeOf(req), (m) => {
      active(m);
      actor(req, m, true);
      if (m.phoneAccess) m.phoneAccess.enabled = false;
      revoked = revokePhoneParticipants(m);
      return structuredClone(m);
    });
    await enforce(m, revoked);
    await store.audit(m.code, "host", "phone.disable");
    return { ok: true };
  });
  app.post(
    "/api/admin/session",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const { creationKey } = z
        .object({ creationKey: z.string().max(256) })
        .parse(req.body);
      if (!config.creationKey || !safeEqual(creationKey, config.creationKey))
        throw new HttpError(401, "Invalid creation key");
      const expiry = String(Date.now() + 3600000);
      reply.setCookie(
        "mp_admin",
        `${expiry}.${keyedDigest(config.secret, `admin:${expiry}`)}`,
        { ...cookieOpts, maxAge: 3600 },
      );
      return { ok: true };
    },
  );
  app.patch("/api/admin/branding", async (req) => {
    admin(req);
    const branding = brandingSchema.parse(req.body);
    await store.setSettings(branding);
    await store.audit("installation", "operator", "branding.update");
    return { ok: true, branding };
  });
  app.post(
    "/api/admin/meetings/:code/recordings/:id/rotate-key",
    async (req) => {
      admin(req);
      z.object({}).strict().parse(req.body);
      const id = z
        .string()
        .uuid()
        .parse((req.params as { id: string }).id);
      await recordings.rotateKey(await find(req), id);
      return { ok: true };
    },
  );
  app.post("/api/admin/assets", async (req) => {
    admin(req);
    const body = z
      .object({
        mime: z.enum(["image/png", "image/jpeg", "image/webp"]),
        data: z.string().max(2800000),
      })
      .strict()
      .parse(req.body);
    const data = Buffer.from(body.data, "base64");
    if (data.length > 2 * 1024 * 1024 || data.length < 12)
      throw new HttpError(400, "Image must be under 2 MB");
    const valid =
      body.mime === "image/png"
        ? data.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))
        : body.mime === "image/jpeg"
          ? data[0] === 255 && data[1] === 216 && data[2] === 255
          : data.subarray(0, 4).toString() === "RIFF" &&
            data.subarray(8, 12).toString() === "WEBP";
    if (!valid) throw new HttpError(400, "Image format does not match");
    const id = digest(data.toString("base64"));
    await store.setAsset(id, body.mime, data.toString("base64"));
    return { url: `/api/assets/${id}` };
  });
  app.get("/api/assets/:id", async (req, reply) => {
    const id = z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .parse((req.params as any).id);
    const asset = await store.getAsset(id);
    if (!asset) throw new HttpError(404, "Image unavailable");
    return reply
      .type(asset.mime)
      .header("Cache-Control", "public, max-age=86400, immutable")
      .send(Buffer.from(asset.data, "base64"));
  });
  async function buildMeeting(
    body: z.infer<typeof meetingInput> & { customCode?: string },
    hostToken: string,
    assignedCode = false,
  ): Promise<Meeting> {
    const code = body.customCode
      ? normalizeCode(
          z
            .string()
            .regex(/^[a-zA-Z0-9-]{6,48}$/)
            .parse(body.customCode),
        )
      : meetingCode();
    if (!/^[A-Z0-9]{6,48}$/.test(code))
      throw new HttpError(
        400,
        "Meeting code must contain 6 to 48 letters or digits",
      );
    if (!assignedCode && (await store.get(code)))
      throw new HttpError(409, "Meeting code unavailable");
    const m: Meeting = {
      id: randomUUID(),
      code,
      room: `m_${randomUUID()}`,
      title: body.title,
      mode: body.mode,
      locked: false,
      ended: false,
      recordingAllowed: false,
      createdAt: Date.now(),
      revision: 1,
      passwordHash: await passwordHash(body.password),
      hostTokenHash: digest(hostToken),
      hostTokenExpiresAt: Date.now() + 30 * 60000,
      limits: {
        participants:
          body.mode === "meeting"
            ? config.meetingParticipantLimit
            : config.webinarParticipantLimit,
        durationSeconds: config.meetingDurationSeconds,
      },
      participants: [],
      bans: { ip: [], device: [] },
      breakouts: [],
      messages: [],
      recordings: [],
    };
    // Host display name is bound to the one-use invitation without making it an authority token.
    m.participants.push({
      id: randomUUID(),
      name: body.hostName,
      role: "host",
      status: "waiting",
      audioAllowed: true,
      videoAllowed: true,
      mediaVersion: 1,
      tokenHash: "",
      expiresAt: Date.now() + 43200000,
      ipHash: "",
      deviceHash: "",
      breakoutId: null,
    });
    return m;
  }
  app.post("/api/internal/hosted/meetings", async (req) => {
    const body = z
      .object({
        accountId: hostedUuid,
        billingOwnerId: hostedUuid,
        version: hostedVersion,
        operationId: hostedUuid,
        scheduledCode: z
          .string()
          .regex(/^[A-F0-9]{34}$/)
          .optional(),
        meeting: meetingInput,
      })
      .strict()
      .parse(req.body);
    const hostToken = keyedDigest(
      config.secret,
      JSON.stringify([
        "hosted-host-invitation-v1",
        body.accountId,
        body.version,
        body.operationId,
      ]),
    );
    const requestHash = keyedDigest(
      config.secret,
      JSON.stringify([
        "hosted-create-request-v1",
        body.billingOwnerId,
        body.accountId,
        body.version,
        body.operationId,
        body.meeting.title,
        body.meeting.hostName,
        body.meeting.password,
        body.meeting.mode,
        ...(body.scheduledCode ? [body.scheduledCode] : []),
      ]),
    );
    // Only this machine-authenticated route accepts a preassigned scheduled
    // code. createHosted still atomically checks operation replay and uniqueness.
    const candidate = await buildMeeting(
      { ...body.meeting, customCode: body.scheduledCode },
      hostToken,
      Boolean(body.scheduledCode),
    );
    candidate.hosted = {
      accountId: body.accountId,
      billingOwnerId: body.billingOwnerId,
      version: body.version,
      operationId: body.operationId,
      requestHash,
    };
    const m = await store.createHosted(candidate);
    if (!safeEqual(m.hostTokenHash ?? "", digest(hostToken)))
      throw new HttpError(
        409,
        "Meeting invitation is no longer available",
        "MEETING_OPERATION_UNAVAILABLE",
      );
    return {
      code: m.code,
      hostToken,
      guestUrl: `${config.origin}/join/${m.code}`,
    };
  });
  app.post("/api/internal/hosted/meetings/status", async (req) => {
    const { accountId, version } = z
      .object({ accountId: hostedUuid, version: hostedVersion })
      .strict()
      .parse(req.body);
    const meetings = await store.hostedMeetings(accountId);
    return {
      meetings: meetings
        .filter(
          (m) =>
            m.hosted &&
            m.hosted.version <= version &&
            m.lifecycle &&
            !m.lifecycle.cleanupConfirmed,
        )
        .map((m) => ({
          code: m.code,
          status: m.ended
            ? "ending"
            : m.participants.find((p) => p.role === "host")?.status === "left"
              ? "orphaned"
              : "active",
        })),
    };
  });
  app.post("/api/internal/hosted/meetings/:code/end", async (req, reply) => {
    const { accountId, version } = z
      .object({
        accountId: hostedUuid,
        version: hostedVersion,
      })
      .strict()
      .parse(req.body);
    const m = await store.change(codeOf(req), (m) => {
      if (
        m.hosted?.accountId !== accountId ||
        m.hosted.version > version ||
        !m.lifecycle
      )
        throw new HttpError(
          409,
          "Meeting ownership changed or has not started",
        );
      endMeeting(m);
      return structuredClone(m);
    });
    const complete = await cleanupMeeting(m);
    await store.audit(m.code, `hosted:${accountId}`, "meeting.end");
    return reply
      .code(complete ? 200 : 202)
      .send({ ok: true, cleanupPending: !complete });
  });
  async function cleanupMeeting(m: Meeting) {
    let failed = false;
    try {
      await store.purgeWhiteboard(m.code);
    } catch {
      failed = true;
    }
    try {
      await recordings.stopAll(m);
    } catch {
      failed = true;
    }
    try {
      if (!media.available) throw new Error("Media cleanup is unavailable");
      await media.end(m);
      for (const p of m.participants)
        await store.settleParticipantMeter(
          m.code,
          p.id,
          p.mediaVersion,
          p.meter,
        );
      await store.change(m.code, (state) => {
        if (!state.ended) throw new Error("Meeting completion changed");
        for (const p of state.participants) {
          p.enforcementPending = false;
          delete p.previousRoom;
          delete p.previousMediaIdentity;
        }
      });
    } catch {
      failed = true;
    }
    await recordings.reconcile(m, "capture");
    const current = await store.get(m.code);
    if (
      !current ||
      current.recordings.some((r) =>
        ["starting", "recording", "stopping"].includes(r.status),
      ) ||
      (await store.hasPhoneReservations(m.code))
    )
      failed = true;
    if (!failed)
      await store.change(m.code, (state) => {
        if (!state.ended) throw new Error("Meeting completion changed");
        state.cleanupPending = false;
        if (state.hosted?.revoked) state.hosted.cleanupConfirmed = true;
        if (state.lifecycle) state.lifecycle.cleanupConfirmed = true;
      });
    return !failed;
  }
  app.post("/api/internal/hosted/entitlements", async (req) => {
    const grant = await store.setHostedEntitlement(
      entitlementSchema.parse(req.body),
    );
    return { ok: true, revision: grant.revision };
  });
  app.post("/api/internal/hosted/usage", async (req) => {
    const { billingOwnerId } = z
      .object({ billingOwnerId: hostedUuid })
      .strict()
      .parse(req.body);
    return store.hostedUsage(billingOwnerId);
  });
  app.post("/api/internal/hosted/authority", async (req, reply) => {
    const body = z
      .object({
        accountId: hostedUuid,
        billingOwnerId: hostedUuid.optional(),
        version: hostedVersion,
        enabled: z.boolean(),
        legacyCodes: z
          .array(z.string().regex(/^[A-Z0-9]{6,48}$/))
          .max(100)
          .optional(),
      })
      .strict()
      .parse(req.body);
    const result = await store.setHostedAuthority(body);
    const complete = result.meetings.length === 0;
    return reply.code(complete ? 200 : 202).send({
      ok: true,
      version: result.authority.version,
      cleanupPending: !complete,
    });
  });
  app.post(
    "/api/meetings",
    { config: { rateLimit: { max: 10, timeWindow: "1 minute" } } },
    async (req) => {
      const body = z
        .object({
          title: name,
          hostName: name,
          password,
          mode: z.enum(["meeting", "webinar"]),
          customCode: z.string().max(64).optional(),
          creationKey: z.string().max(256).optional(),
        })
        .strict()
        .parse(req.body);
      if (
        config.creationKey &&
        !safeEqual(body.creationKey ?? "", config.creationKey)
      )
        throw new HttpError(401, "Creation key required");
      if (config.edition === "hosted" && body.customCode !== undefined)
        throw new HttpError(
          400,
          "Hosted meeting codes are generated automatically",
        );
      const hostToken = randomToken();
      const m = await buildMeeting(body, hostToken);
      const code = m.code;
      await store.create(m);
      await store.audit(code, "creator", "meeting.create");
      return { code, hostToken, guestUrl: `${config.origin}/join/${code}` };
    },
  );
  app.post("/api/meetings/:code/host", async (req, reply) => {
    const { token } = z.object({ token: z.string().max(256) }).parse(req.body);
    await store.checkUsage(codeOf(req));
    const session = randomToken();
    const id = await store.startMeeting(codeOf(req), (m) => {
      active(m);
      if (
        !m.hostTokenHash ||
        !safeEqual(m.hostTokenHash, digest(token)) ||
        m.hostTokenExpiresAt < Date.now()
      )
        throw new HttpError(403, "Host link is invalid or already used");
      delete m.hostTokenHash;
      const p = m.participants.find((x) => x.role === "host")!;
      p.status = "admitted";
      p.tokenHash = digest(session);
      Object.assign(p, identity(req, reply, m.code));
      return p.id;
    });
    reply.setCookie(authCookie(codeOf(req)), session, cookieOpts);
    return { participantId: id };
  });
  app.post(
    "/api/meetings/:code/join",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const body = z
        .object({ name, password: z.string().max(256) })
        .parse(req.body);
      const session = randomToken();
      const code = codeOf(req);
      const id = await store.change(code, async (m) => {
        active(m);
        if (m.locked) throw new HttpError(403, "Meeting is locked");
        if (!(await checkPassword(m.passwordHash, body.password)))
          throw new HttpError(403, "Meeting credentials are invalid");
        const ids = identity(req, reply, code);
        if (
          m.bans.device.includes(ids.deviceHash) ||
          m.bans.ip.includes(ids.ipHash)
        )
          throw new HttpError(403, "Entry is blocked for this meeting");
        requireMeetingSeat(m);
        const p: Participant = {
          id: randomUUID(),
          name: body.name,
          role: m.mode === "webinar" ? "viewer" : "participant",
          status: "waiting",
          audioAllowed: m.mode === "meeting",
          videoAllowed: m.mode === "meeting",
          mediaVersion: 1,
          tokenHash: digest(session),
          expiresAt: Date.now() + 43200000,
          ...ids,
          breakoutId: null,
        };
        m.participants.push(p);
        return p.id;
      });
      reply.setCookie(authCookie(code), session, cookieOpts);
      return { participantId: id };
    },
  );
  app.get(
    "/api/meetings/:code/state",
    {
      config: {
        rateLimit: {
          max: 90,
          timeWindow: "1 minute",
          keyGenerator: (req: FastifyRequest) =>
            digest(req.cookies[authCookie(codeOf(req))] ?? req.ip),
        },
      },
    },
    async (req) => {
      const m = await find(req),
        p = actor(req, m);
      const pub = (x: Participant) => ({
        transport: x.transport ?? "browser",
        ...(x.phone
          ? {
              phone: {
                muted: x.phone.muted,
                handRaised: x.phone.handRaised,
                canBanCallerId: !!x.phone.callerHash,
              },
            }
          : {}),
        id: x.id,
        name: x.name,
        role: x.role,
        status: x.status,
        audioAllowed: x.audioAllowed,
        videoAllowed: x.videoAllowed,
        mediaVersion: x.mediaVersion,
        mediaIdentity: mediaIdentity(x),
        breakoutId: x.breakoutId,
        enforcementPending: !!x.enforcementPending,
      });
      const canSee = p.status === "admitted";
      const usage =
        p.role === "host" && m.hosted?.billingOwnerId
          ? await store.hostedUsage(m.hosted.billingOwnerId).catch(() => null)
          : undefined;
      return {
        meeting: {
          code: m.code,
          title: m.title,
          mode: m.mode,
          webinar:
            m.mode === "webinar"
              ? {
                  presenters: m.participants.filter(
                    (x) => occupiesSeat(x) && x.role !== "viewer",
                  ).length,
                  viewers: m.participants.filter(
                    (x) => occupiesSeat(x) && x.role === "viewer",
                  ).length,
                  presenterLimit: webinarPresenterLimit,
                  viewerLimit: Math.min(
                    webinarViewerLimit,
                    participantLimit(m) - 1,
                  ),
                }
              : undefined,
          locked: m.locked,
          ended: !meetingAllowed(m),
          cleanupPending: !!m.cleanupPending,
          participantLimit: participantLimit(m),
          startedAt: m.lifecycle?.startedAt,
          deadlineAt: m.lifecycle?.deadlineAt,
          usage,
          recordingAllowed: m.recordingAllowed,
          createdAt: m.createdAt,
          hostEmailVerified:
            p.role === "host" ? !!m.hostEmailVerified : undefined,
          breakouts: m.breakouts.map(({ id, name }) => ({ id, name })),
          recordingActive: m.recordings.some((r) =>
            ["starting", "recording", "stopping"].includes(r.status),
          ),
        },
        me: pub(p),
        participants: m.participants
          .filter(
            (x) =>
              x.id === p.id ||
              p.role === "host" ||
              (canSee &&
                x.status === "admitted" &&
                x.breakoutId === p.breakoutId),
          )
          .map(pub),
        messages: canSee
          ? m.messages
              .filter((x) => x.broadcast || x.breakoutId === p.breakoutId)
              .slice(-100)
          : [],
        recordings:
          p.role === "host"
            ? m.recordings.map(
                ({ id, status, createdAt, expiresAt, error }) => ({
                  id,
                  status,
                  createdAt,
                  expiresAt,
                  error,
                }),
              )
            : [],
        revision: m.revision,
      };
    },
  );
  app.post("/api/meetings/:code/participants/:id/action", async (req) => {
    const body = z
      .object({
        action: z.enum([
          "admit",
          "kick",
          "ban",
          "allow-audio",
          "block-audio",
          "allow-video",
          "block-video",
          "promote",
          "demote",
          "rename",
        ]),
        banIp: z.boolean().optional(),
        banDevice: z.boolean().optional(),
        banCallerId: z.boolean().optional(),
        name: name.optional(),
      })
      .strict()
      .parse(req.body);
    const target = (req.params as any).id;
    if (body.action === "admit") await store.checkUsage(codeOf(req));
    let changed!: Participant;
    const m = await store.change(codeOf(req), (m) => {
      active(m);
      actor(req, m, true);
      const p = m.participants.find((x) => x.id === target);
      if (!p || p.role === "host")
        throw new HttpError(400, "Select a guest participant");
      if (!occupiesSeat(p))
        throw new HttpError(409, "Participant session is inactive");
      if (p.transport === "phone") {
        if (body.banIp || body.banDevice)
          throw new HttpError(
            400,
            "Phone callers do not have browser IP or device bans",
          );
        if (body.action === "allow-video" || body.action === "block-video")
          throw new HttpError(400, "Phone callers use audio only");
        if (body.banCallerId && !p.phone?.callerHash)
          throw new HttpError(400, "Caller identity is unavailable");
      } else if (body.banCallerId)
        throw new HttpError(400, "Select a phone caller");
      if (body.action === "rename" && !body.name)
        throw new HttpError(400, "Participant name is required");
      if (
        (body.action === "allow-audio" || body.action === "allow-video") &&
        p.role === "viewer"
      )
        throw new HttpError(
          409,
          "Invite the viewer to stage before allowing devices",
        );
      if (body.action === "promote" || body.action === "demote") {
        if (m.mode !== "webinar" || p.status !== "admitted")
          throw new HttpError(
            409,
            "Stage changes require an admitted webinar participant",
          );
        const expectedRole =
          body.action === "promote" ? "viewer" : "participant";
        if (p.role !== expectedRole)
          throw new HttpError(409, "Participant already has this role");
        const occupied = m.participants.filter(occupiesMeetingSeat);
        if (
          body.action === "promote" &&
          occupied.filter((x) => x.role !== "viewer").length >=
            webinarPresenterLimit
        )
          throw new HttpError(
            409,
            "Webinar stage is full (10 including the host)",
          );
        if (body.action === "demote") requireWebinarViewerSeat(m);
      }
      if (body.action === "admit") {
        if (p.status !== "waiting")
          throw new HttpError(409, "Participant is not waiting");
        if (m.locked)
          throw new HttpError(403, "Unlock the meeting before admitting");
        p.status = "admitted";
        if (p.phone) {
          if (p.phone.leaseExpiresAt <= Date.now())
            throw new HttpError(409, "Phone call is no longer active");
          p.expiresAt = p.phone.callExpiresAt;
        }
      } else {
        fenceParticipantMedia(m, p);
        if (body.action === "kick" || body.action === "ban") {
          p.status = body.action === "ban" ? "banned" : "kicked";
          if (body.action === "ban") {
            if (body.banIp) m.bans.ip.push(p.ipHash);
            if (body.banDevice) m.bans.device.push(p.deviceHash);
            if (body.banCallerId && p.phone?.callerHash)
              (m.bans.caller ??= []).push(p.phone.callerHash);
          }
        }
        if (body.action === "allow-audio") p.audioAllowed = true;
        if (body.action === "block-audio") {
          p.audioAllowed = false;
          if (p.phone) p.phone.muted = true;
        }
        if (body.action === "allow-video") p.videoAllowed = true;
        if (body.action === "block-video") p.videoAllowed = false;
        if (body.action === "promote") {
          p.role = "participant";
          p.audioAllowed = true;
          p.videoAllowed = p.transport !== "phone";
        }
        if (body.action === "demote") {
          p.role = "viewer";
          p.audioAllowed = false;
          p.videoAllowed = false;
          if (p.phone) p.phone.muted = true;
        }
        if (body.action === "rename") p.name = body.name!;
      }
      changed = structuredClone(p);
      return structuredClone(m);
    });
    await store.audit(m.code, actor(req, m, true).id, body.action, target);
    if (changed.enforcementPending) await enforce(m, [changed]);
    return { ok: true };
  });
  app.patch("/api/meetings/:code", async (req) => {
    const body = z
      .object({
        locked: z.boolean().optional(),
        recordingAllowed: z.boolean().optional(),
      })
      .strict()
      .parse(req.body);
    const m = await store.change(codeOf(req), (m) => {
      active(m);
      actor(req, m, true);
      Object.assign(m, body);
      if (body.recordingAllowed === false)
        for (const r of m.recordings)
          if (["starting", "recording", "stopping"].includes(r.status))
            r.status = "stopping";
      return structuredClone(m);
    });
    if (body.recordingAllowed === false) await recordings.stopAll(m);
    await store.audit(m.code, actor(req, m, true).id, "meeting.policy");
    return { ok: true };
  });
  app.post("/api/meetings/:code/end", async (req, reply) => {
    const m = await store.change(codeOf(req), (m) => {
      actor(req, m, true);
      endMeeting(m);
      return structuredClone(m);
    });
    const complete = await cleanupMeeting(m);
    await store.audit(m.code, "host", "meeting.end");
    return reply
      .code(complete ? 200 : 202)
      .send({ ok: true, cleanupPending: !complete });
  });
  app.post("/api/meetings/:code/leave", async (req, reply) => {
    let who!: Participant;
    const m = await store.change(codeOf(req), (m) => {
      const p = actor(req, m);
      if (p.role === "host") {
        p.status = "left";
        endMeeting(m);
      } else {
        p.status = "left";
        fenceParticipantMedia(m, p);
      }
      who = structuredClone(p);
      return structuredClone(m);
    });
    if (who.role === "host") {
      const complete = await cleanupMeeting(m);
      await store.audit(m.code, "host", "meeting.end");
      return reply
        .code(complete ? 200 : 202)
        .send({ ok: true, cleanupPending: !complete });
    }
    await enforce(m, [who]);
    return { ok: true };
  });
  app.post("/api/meetings/:code/media", async (req) => {
    const m = await find(req);
    active(m);
    const p = actor(req, m);
    if (p.status !== "admitted" || p.enforcementPending)
      throw new HttpError(403, "Admission required");
    await store.checkUsage(m.code, p.id);
    return {
      token: await media.token(m, p),
      mediaIdentity: mediaIdentity(p),
      url: config.origin.replace(/^http/, "ws"),
    };
  });
  for (const broadcast of [false, true])
    app.post(
      `/api/meetings/:code/${broadcast ? "broadcast" : "messages"}`,
      async (req) => {
        const { text } = z
          .object({ text: z.string().trim().min(1).max(2000) })
          .parse(req.body);
        await store.change(codeOf(req), (m) => {
          active(m);
          const p = actor(req, m, broadcast);
          if (p.status !== "admitted")
            throw new HttpError(403, "Admission required");
          m.messages.push({
            id: randomUUID(),
            senderId: p.id,
            name: p.name,
            text,
            createdAt: Date.now(),
            breakoutId: p.breakoutId,
            broadcast,
          });
          m.messages = m.messages.slice(-500);
        });
        return { ok: true };
      },
    );
  const whiteboardRateKey = (req: FastifyRequest) => {
    return verifyDevice(config.secret, req.cookies.mp_device) ?? req.ip;
  };
  app.get(
    "/api/meetings/:code/whiteboard",
    {
      config: {
        rateLimit: {
          max: 90,
          timeWindow: "1 minute",
          keyGenerator: whiteboardRateKey,
        },
      },
    },
    async (req) => {
      const { after } = z
        .object({
          after: z.coerce
            .number()
            .int()
            .min(0)
            .max(Number.MAX_SAFE_INTEGER)
            .default(0),
        })
        .parse(req.query);
      return store.readWhiteboard(codeOf(req), after, (m) =>
        whiteboardAccess(req, m),
      );
    },
  );
  app.post(
    "/api/meetings/:code/whiteboard",
    {
      config: {
        rateLimit: {
          max: 120,
          timeWindow: "1 minute",
          keyGenerator: whiteboardRateKey,
        },
      },
      bodyLimit: 8192,
    },
    async (req) => {
      const input = whiteboardInput.parse(req.body);
      const event = await store.writeWhiteboard(codeOf(req), input, (m) =>
        whiteboardAccess(req, m),
      );
      return { event };
    },
  );
  app.post("/api/meetings/:code/breakouts", async (req) => {
    const { name: roomName } = z.object({ name }).parse(req.body);
    await store.change(codeOf(req), (m) => {
      active(m);
      actor(req, m, true);
      if (m.breakouts.length >= 20)
        throw new HttpError(409, "Maximum 20 breakout rooms");
      m.breakouts.push({
        id: randomUUID(),
        name: roomName,
        room: `b_${randomUUID()}`,
      });
    });
    return { ok: true };
  });
  for (const route of ["move", "return-main", "close-breakouts"])
    app.post(`/api/meetings/:code/${route}`, async (req) => {
      const body =
        route === "move"
          ? z
              .object({
                participantId: z.string(),
                breakoutId: z.string().nullable(),
              })
              .parse(req.body)
          : null;
      const moved: Participant[] = [];
      const m = await store.change(codeOf(req), (m) => {
        active(m);
        const self = actor(req, m, route !== "return-main");
        if (
          body?.breakoutId &&
          !m.breakouts.some((b) => b.id === body.breakoutId)
        )
          throw new HttpError(404, "Breakout room unavailable");
        const targets =
          route === "close-breakouts"
            ? m.participants.filter(
                (p) => p.breakoutId && p.status === "admitted",
              )
            : [
                m.participants.find(
                  (p) => p.id === (body?.participantId ?? self.id),
                ),
              ];
        for (const p of targets) {
          if (!p || p.status !== "admitted")
            throw new HttpError(400, "Participant is not admitted");
          if (p.transport === "phone")
            throw new HttpError(
              409,
              "Phone breakout transfers are not available",
            );
          if (p.enforcementPending)
            throw new HttpError(
              409,
              "Wait for the previous room transfer to complete",
            );
          fenceParticipantMedia(m, p);
          p.breakoutId = body?.breakoutId ?? null;
          moved.push(structuredClone(p));
        }
        if (route === "close-breakouts") m.breakouts = [];
        return structuredClone(m);
      });
      await enforce(m, moved);
      await store.audit(m.code, "host", `breakout.${route}`);
      return { ok: true };
    });
  app.post(
    "/api/meetings/:code/host-email",
    { config: { rateLimit: { max: 3, timeWindow: "10 minutes" } } },
    async (req) => {
      if (!mail) throw new HttpError(503, "Email is not configured");
      const { email } = z.object({ email: z.email().max(254) }).parse(req.body);
      const m = await find(req);
      actor(req, m, true);
      const otp = String(randomInt(100000, 1000000));
      const otpHash = keyedDigest(config.secret, `${m.code}:${otp}`);
      const expiresAt = Date.now() + 600000;
      await store.change(m.code, (m) => {
        m.hostEmail = email;
        m.hostEmailVerified = false;
        m.emailOtpHash = otpHash;
        m.emailOtpExpiresAt = expiresAt;
        m.emailOtpAttempts = 0;
      });
      try {
        await mail.sendMail({
          from: config.smtpFrom,
          to: email,
          subject: "Verify recording email",
          text: `Verification code: ${otp}\nExpires in 10 minutes.`,
        });
      } catch {
        await store.change(m.code, (state) => {
          if (
            state.hostEmail === email &&
            state.emailOtpHash === otpHash &&
            state.emailOtpExpiresAt === expiresAt
          ) {
            delete state.emailOtpHash;
            delete state.emailOtpExpiresAt;
            delete state.emailOtpAttempts;
          }
        });
        throw new HttpError(503, "Verification email failed. Try again.");
      }
      return { ok: true };
    },
  );
  app.post(
    "/api/meetings/:code/verify-email",
    { config: { rateLimit: { max: 5, timeWindow: "10 minutes" } } },
    async (req) => {
      const { otp } = z
        .object({ otp: z.string().regex(/^\d{6}$/) })
        .parse(req.body);
      const ok = await store.change(codeOf(req), (m) => {
        actor(req, m, true);
        m.emailOtpAttempts = (m.emailOtpAttempts ?? 0) + 1;
        if (
          m.emailOtpAttempts > 5 ||
          !m.emailOtpHash ||
          (m.emailOtpExpiresAt ?? 0) < Date.now() ||
          !safeEqual(
            m.emailOtpHash,
            keyedDigest(config.secret, `${m.code}:${otp}`),
          )
        )
          return false;
        m.hostEmailVerified = true;
        delete m.emailOtpHash;
        return true;
      });
      if (!ok) throw new HttpError(403, "Code is invalid or expired");
      return { ok: true };
    },
  );
  app.post("/api/meetings/:code/recordings", async (req) => {
    const m = await find(req);
    active(m);
    actor(req, m, true);
    await store.checkUsage(m.code);
    await recordings.start(m);
    return { ok: true };
  });
  app.post("/api/meetings/:code/recordings/:id/stop", async (req) => {
    const m = await find(req);
    actor(req, m, true);
    await recordings.stop(m, (req.params as any).id);
    return { ok: true };
  });
  app.post("/api/meetings/:code/recordings/:id/link", async (req, reply) => {
    const m = await find(req);
    const p = actor(req, m, true);
    const link = await recordings.link(m, (req.params as any).id);
    await store.change(m.code, (state) => {
      const host = state.participants.find((x) => x.id === p.id)!;
      host.expiresAt = Math.max(host.expiresAt, link.expiresAt);
    });
    reply.setCookie(authCookie(m.code), req.cookies[authCookie(m.code)]!, {
      ...cookieOpts,
      maxAge: 86400,
    });
    return link;
  });
  app.post("/api/meetings/:code/recordings/:id/revoke", async (req) => {
    const m = await find(req);
    actor(req, m, true);
    await recordings.revoke(m, (req.params as any).id);
    return { ok: true };
  });
  app.post(
    "/api/meetings/:code/download",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } } },
    async (req, reply) => {
      const controller = new AbortController();
      const cleanup = () => {
        reply.raw.off("close", closed);
        reply.raw.off("finish", cleanup);
      };
      const closed = () => {
        if (!reply.raw.writableFinished) controller.abort();
        cleanup();
      };
      reply.raw.once("close", closed);
      reply.raw.once("finish", cleanup);
      if (reply.raw.destroyed) closed();
      try {
        controller.signal.throwIfAborted();
        const { password, token } = z
          .object({ password: z.string().max(256), token: z.string().max(128) })
          .strict()
          .parse(req.body);
        const meeting = await find(req);
        actor(req, meeting, true);
        const found = await recordings.findToken(token, meeting.code);
        if (!found) throw new HttpError(403, "Download unavailable");
        const stream = await recordings.download(
          found.m,
          found.r,
          token,
          password,
          (state) => {
            actor(req, state, true);
          },
          controller.signal,
        );
        reply
          .type("video/mp4")
          .header(
            "Content-Disposition",
            `attachment; filename="recording-${found.r.id}.mp4"`,
          );
        return reply.send(stream);
      } catch (error) {
        cleanup();
        throw error;
      }
    },
  );
  if (media instanceof LiveMedia) media.attach(app);
  if (existsSync(config.staticDir)) {
    await app.register(staticFiles, { root: config.staticDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Not found" })
        : reply.sendFile("index.html"),
    );
  }
  let controlPass: Promise<void> | undefined;
  let filesPass: Promise<void> | undefined;
  let closing = false;
  const timer = setInterval(() => {
    if (controlPass || closing) return;
    controlPass = (async () => {
      for (let m of await store.all()) {
        if (m.hosted?.billingOwnerId) {
          await store.reconcileParticipantMeters(m.code).catch(() => {});
          m = (await store.get(m.code))!;
        }
        if (!m.ended && !meetingAllowed(m)) {
          m = await store.change(m.code, (state) => {
            if (!meetingAllowed(state)) endMeeting(state);
            return structuredClone(state);
          });
        }
        if (
          m.cleanupPending ||
          (m.hosted?.revoked && !m.hosted.cleanupConfirmed)
        ) {
          await cleanupMeeting(m).catch(() => {});
          continue;
        }
        if (
          m.participants.some(
            (p) =>
              ["admitted", "waiting"].includes(p.status) &&
              (p.expiresAt <= Date.now() ||
                (p.phone && p.phone.leaseExpiresAt <= Date.now())),
          )
        )
          m = await store.change(m.code, (state) => {
            for (const p of state.participants)
              if (
                ["admitted", "waiting"].includes(p.status) &&
                (p.expiresAt <= Date.now() ||
                  (p.phone && p.phone.leaseExpiresAt <= Date.now()))
              ) {
                p.status = "left";
                fenceParticipantMedia(state, p);
              }
            return structuredClone(state);
          });
        if (m.participants.some((p) => gatewayPresenceExpired(p)))
          m = await store.change(m.code, (state) => {
            for (const p of state.participants)
              if (gatewayPresenceExpired(p)) fenceParticipantMedia(state, p);
            return structuredClone(state);
          });
        for (const p of m.participants.filter((p) => p.enforcementPending))
          await enforce(m, [p]).catch(() => {});
        await recordings.reconcile(m, "capture");
      }
    })()
      .catch(() => {})
      .finally(() => {
        controlPass = undefined;
        // File I/O has its own single-flight pass so it cannot hold up capture
        // deadlines in other rooms. Both use the same per-recording ownership.
        if (!closing && !filesPass)
          filesPass = (async () => {
            for (const m of await store.all())
              await recordings.reconcile(m, "files");
          })()
            .catch(() => {})
            .finally(() => {
              filesPass = undefined;
            });
      });
  }, 5000);
  timer.unref();
  app.addHook("onClose", async () => {
    closing = true;
    clearInterval(timer);
    media.close();
    await Promise.all([controlPass, filesPass]);
    try {
      await mail?.close();
    } finally {
      try {
        await mailBudget?.close();
      } finally {
        await store.close();
      }
    }
  });
  return app;
}
