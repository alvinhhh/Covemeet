import {
  completeMediaFence,
  fenceParticipantMedia,
  mediaIdentity,
  participantRoom,
} from "./media-identity.js";
import {
  meetingAllowed,
  participantMediaAllowed,
  meetingDeadline,
  requireMeetingSeat,
} from "./meeting-limits.js";
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Media } from "./media.js";
import type { Meeting, Participant, Store } from "./store.js";
import {
  checkPassword,
  digest,
  HttpError,
  keyedDigest,
  passwordHash,
  randomToken,
  safeEqual,
} from "./security.js";

export const PHONE_LEASE_MS = 10_000;
export const activePhone = (p: Participant) =>
  p.transport === "phone" &&
  (["waiting", "admitted"].includes(p.status) || !!p.enforcementPending);
export const recordingInProgress = (m: Meeting) =>
  m.recordings.some((r) =>
    ["starting", "recording", "stopping"].includes(r.status),
  );
export const phoneCallSchema = z
  .object({
    locator: z.string().regex(/^\d{12}$/),
    pin: z.string().regex(/^\d{8}$/),
    callId: z.string().uuid(),
    ownerId: z.string().uuid().optional(),
    trunkId: z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/),
    callerId: z
      .string()
      .regex(/^\+[1-9]\d{6,14}$/)
      .optional(),
  })
  .strict();
export const phonePollSchema = z
  .object({
    callId: z.string().uuid(),
    sessionToken: z.string().min(32).max(128),
    action: z.enum(["poll", "leave", "toggle-mute", "toggle-hand"]),
  })
  .strict();

export function revokePhoneParticipants(m: Meeting) {
  const revoked: Participant[] = [];
  for (const p of m.participants)
    if (p.transport === "phone" && ["waiting", "admitted"].includes(p.status)) {
      p.status = "left";
      fenceParticipantMedia(m, p);
      p.phone!.leaseExpiresAt = 0;
      revoked.push(structuredClone(p));
    }
  return revoked;
}

export class PhoneService {
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly media: Media,
  ) {}
  requireEnabled() {
    if (!this.config.phoneEnabled)
      throw new HttpError(503, "Phone access is disabled");
  }
  authenticate(headers: Record<string, unknown>) {
    if (
      this.config.phoneGatewayKey.length < 32 ||
      headers.origin !== undefined ||
      headers["x-requested-with"] !== "CovemeetPhone" ||
      !safeEqual(
        String(headers.authorization ?? ""),
        `Bearer ${this.config.phoneGatewayKey}`,
      )
    )
      throw new HttpError(403, "Phone gateway authentication required");
  }
  async credentials() {
    this.requireEnabled();
    const locator = randomInt(0, 1_000_000_000_000)
      .toString()
      .padStart(12, "0");
    const pin = randomInt(0, 100_000_000).toString().padStart(8, "0");
    return { locator, pin, pinHash: await passwordHash(pin) };
  }
  settings(m: Meeting) {
    return {
      enabled: this.config.phoneEnabled && !!m.phoneAccess?.enabled,
      locator: m.phoneAccess?.enabled ? m.phoneAccess.locator : undefined,
      dialInNumber: this.config.phoneDialInNumber,
      sipAddress: this.config.phoneSipAddress,
    };
  }
  async create(raw: unknown) {
    this.requireEnabled();
    const body = phoneCallSchema.parse(raw);
    if (!body.ownerId && !this.config.phoneAllowUnjournaledTestCalls)
      throw new HttpError(403, "Phone dialog ownership required");
    if (body.trunkId !== this.config.phoneTrunkId)
      throw new HttpError(403, "Phone access unavailable");
    const now = Date.now();
    // Persist attempts across restarts/API instances. The trunk gate also bounds
    // the number of distinct locator counters an authenticated gateway can create.
    for (const [scope, limit] of [
      [`trunk:${body.trunkId}`, 30],
      [`locator:${body.trunkId}:${body.locator}`, 10],
    ] as const) {
      if (
        !(await this.store.phoneAttempt(
          keyedDigest(this.config.secret, `phone-attempt:${scope}`),
          limit,
          now,
        ))
      )
        throw new HttpError(429, "Phone access attempts exceeded");
    }
    const found = await this.store.byPhoneLocator(body.locator);
    if (
      !found?.phoneAccess?.enabled ||
      !(await checkPassword(found.phoneAccess.pinHash, body.pin))
    )
      throw new HttpError(403, "Phone access unavailable");
    const participantId = randomUUID(),
      sessionToken = randomToken();
    const callerHash = body.callerId
      ? keyedDigest(
          this.config.secret,
          `phone-caller:${found.id}:${body.trunkId}:${body.callerId}`,
        )
      : undefined;
    return this.store.reservePhone(
      found.code,
      body.callId,
      participantId,
      this.config.phoneMaxCalls,
      (m) => {
        if (
          !meetingAllowed(m) ||
          m.locked ||
          !m.phoneAccess?.enabled ||
          m.phoneAccess.locator !== body.locator ||
          m.phoneAccess.pinHash !== found.phoneAccess!.pinHash ||
          recordingInProgress(m)
        )
          throw new HttpError(403, "Phone access unavailable");
        if (callerHash && m.bans.caller?.includes(callerHash))
          throw new HttpError(403, "Phone access unavailable");
        requireMeetingSeat(m);
        const current = Date.now();
        const callExpiresAt = Math.min(
          current + this.config.phoneMaxDurationSeconds * 1000,
          m.lifecycle?.deadlineAt ?? Infinity,
        );
        const p: Participant = {
          id: participantId,
          name: `Phone caller ${participantId.slice(0, 4).toUpperCase()}`,
          transport: "phone",
          role: m.mode === "webinar" ? "viewer" : "participant",
          status: "waiting",
          audioAllowed: m.mode === "meeting",
          videoAllowed: false,
          mediaVersion: 1,
          tokenHash: digest(sessionToken),
          ipHash: "",
          deviceHash: "",
          breakoutId: null,
          expiresAt: Math.min(
            callExpiresAt,
            current + this.config.phoneLobbySeconds * 1000,
          ),
          phone: {
            callId: body.callId,
            trunkId: body.trunkId,
            callerHash,
            muted: true,
            handRaised: false,
            leaseExpiresAt: Math.min(
              current + PHONE_LEASE_MS,
              meetingDeadline(m),
            ),
            callExpiresAt,
          },
        };
        m.participants.push(p);
        return {
          code: m.code,
          participantId,
          sessionToken,
          expiresAt: p.expiresAt,
        };
      },
      body.ownerId,
    );
  }
  async update(code: string, id: string, raw: unknown) {
    const body = phonePollSchema.parse(raw);
    const snapshot = await this.store.change(code, (m) => {
      const p = m.participants.find((p) => p.id === id);
      if (
        !p?.phone ||
        p.transport !== "phone" ||
        p.phone.callId !== body.callId ||
        p.phone.trunkId !== this.config.phoneTrunkId ||
        !(
          safeEqual(p.tokenHash, digest(body.sessionToken)) ||
          (m.hosted?.revoked &&
            m.ended &&
            p.phone.cleanupTokenHash &&
            safeEqual(p.phone.cleanupTokenHash, digest(body.sessionToken)))
        )
      )
        throw new HttpError(403, "Phone session unavailable");
      const now = Date.now();
      const ended =
        body.action === "leave" ||
        !this.config.phoneEnabled ||
        !meetingAllowed(m) ||
        p.meter?.phase === "closing" ||
        (p.meter && p.meter.fundedUntil <= now) ||
        !m.phoneAccess?.enabled ||
        p.expiresAt <= now ||
        p.phone.leaseExpiresAt <= now ||
        !["waiting", "admitted"].includes(p.status) ||
        recordingInProgress(m);
      if (ended) {
        if (["waiting", "admitted"].includes(p.status)) {
          p.status = "left";
          fenceParticipantMedia(m, p);
        }
        p.phone.leaseExpiresAt = 0;
      } else {
        p.phone.leaseExpiresAt = Math.min(
          p.expiresAt,
          meetingDeadline(m),
          p.meter?.fundedUntil ?? Infinity,
          now + PHONE_LEASE_MS,
        );
        if (
          body.action === "toggle-mute" &&
          p.status === "admitted" &&
          !p.enforcementPending &&
          p.audioAllowed &&
          p.role !== "viewer"
        ) {
          p.phone.muted = !p.phone.muted;
          fenceParticipantMedia(m, p);
        }
        if (body.action === "toggle-hand")
          p.phone.handRaised = !p.phone.handRaised;
      }
      return {
        meeting: structuredClone(m),
        participant: structuredClone(p),
        ended,
      };
    });
    let { meeting: m, participant: p, ended } = snapshot;
    if (p.enforcementPending) {
      if (p.meter && !this.media.available)
        throw new HttpError(503, "Media cleanup is unavailable");
      await this.media.remove(m, p);
      await this.store.settleParticipantMeter(
        code,
        id,
        p.mediaVersion,
        p.meter,
      );
      const cleaned = await this.store.change(code, (state) => {
        const current = state.participants.find((x) => x.id === id)!;
        completeMediaFence(current, p);
        return {
          meeting: structuredClone(state),
          participant: structuredClone(current),
        };
      });
      m = cleaned.meeting;
      p = cleaned.participant;
      if (p.enforcementPending)
        throw new HttpError(503, "Phone media cleanup remains pending");
      ended ||=
        !meetingAllowed(m) ||
        !["waiting", "admitted"].includes(p.status) ||
        p.phone!.leaseExpiresAt <= Date.now();
    }
    if (body.action === "leave") {
      // The trusted gateway sends leave only after both audio legs are closed.
      // Lease expiry alone never releases a billable/concurrent-call reservation.
      await this.store.releasePhone(body.callId, code, id);
    }
    const admitted = !ended && participantMediaAllowed(m, p);
    if (admitted) await this.store.checkUsage(code, id);
    const grant = admitted
      ? {
          token: await this.media.token(m, p),
          url: this.config.origin.replace(/^http/, "ws"),
          cookie: `mp_${m.code}=${body.sessionToken}`,
          subscribeParticipantIds: m.participants
            .filter(
              (x) =>
                x.id !== p.id &&
                participantMediaAllowed(m, x) &&
                x.role !== "viewer" &&
                participantRoom(m, x) === participantRoom(m, p) &&
                x.expiresAt > Date.now() &&
                (!x.phone || x.phone.leaseExpiresAt > Date.now()),
            )
            .map(mediaIdentity),
        }
      : undefined;
    return {
      state: ended
        ? ("ended" as const)
        : admitted
          ? ("admitted" as const)
          : ("waiting" as const),
      mediaVersion: p.mediaVersion,
      mediaIdentity: mediaIdentity(p),
      muted: p.phone!.muted,
      handRaised: p.phone!.handRaised,
      audioAllowed: p.role !== "viewer" && p.audioAllowed,
      leaseExpiresAt: p.phone!.leaseExpiresAt,
      expiresAt: p.expiresAt,
      ...(grant ? { grant } : {}),
    };
  }
}
