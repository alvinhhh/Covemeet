import { fenceParticipantMedia } from "./media-identity.js";
import type { Meeting, Participant } from "./store.js";
import { HttpError } from "./security.js";
import { z } from "zod";

export type HostedEntitlement = {
  billingOwnerId: string;
  revision: number;
  validUntil: number;
  enabled: boolean;
  quota: {
    anchorAt: number;
    participantSecondsPerMonth: number;
    downloadBytesPerMonth?: number;
  } | null;
  hostAccountIds: string[];
  limits: {
    participants: number;
    durationSeconds: number;
    concurrentMeetings: number;
  };
};

export type MeetingEntitlement = Omit<
  HostedEntitlement,
  "billingOwnerId" | "hostAccountIds"
> & { allowed: boolean };

const uuid = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());
export const entitlementSchema = z
  .object({
    billingOwnerId: uuid,
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    validUntil: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    enabled: z.boolean(),
    quota: z
      .object({
        anchorAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        participantSecondsPerMonth: z.number().int().positive().max(36000000),
        downloadBytesPerMonth: z
          .number()
          .int()
          .nonnegative()
          .max(1e12)
          .optional(),
      })
      .strict()
      .nullable(),
    hostAccountIds: z
      .array(uuid)
      .max(100)
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "Host accounts must be unique",
      )
      .transform((ids) => ids.sort()),
    limits: z
      .object({
        participants: z.literal(100),
        durationSeconds: z.literal(7200),
        concurrentMeetings: z.union([z.literal(1), z.literal(2)]),
      })
      .strict(),
  })
  .strict()
  .refine(
    (grant) => grant.quota === null || grant.quota.anchorAt <= Date.now(),
    "Usage anniversary cannot be in the future",
  )
  .refine(
    (grant) =>
      !grant.enabled ||
      (grant.quota !== null && grant.quota.anchorAt <= Date.now()),
    "Enabled hosting requires a current usage allowance",
  )
  .refine(
    (grant) => !grant.enabled || grant.validUntil <= Date.now() + 360000,
    "Hosting grant exceeds its maximum lifetime",
  );

export function nextEntitlement(
  current: HostedEntitlement | undefined,
  input: HostedEntitlement,
) {
  const canonical = (grant: HostedEntitlement) =>
    JSON.stringify([
      grant.billingOwnerId,
      grant.revision,
      grant.validUntil,
      grant.enabled,
      grant.quota?.anchorAt ?? null,
      grant.quota?.participantSecondsPerMonth ?? null,
      grant.quota?.downloadBytesPerMonth ?? 0,
      [...grant.hostAccountIds].sort(),
      grant.limits.participants,
      grant.limits.durationSeconds,
      grant.limits.concurrentMeetings,
    ]);
  if (
    current?.revision === input.revision &&
    canonical(current) !== canonical(input)
  )
    throw new HttpError(409, "Hosting entitlement revision conflicts");
  return !current || input.revision > current.revision ? input : current;
}

export function applyEntitlement(
  grant: HostedEntitlement,
  meetings: Meeting[],
) {
  const affected = meetings.filter(
    (m) => m.hosted?.billingOwnerId === grant.billingOwnerId,
  );
  const overCapacity =
    affected.filter(holdsMeetingReservation).length >
    grant.limits.concurrentMeetings;
  for (const m of affected) {
    if (m.ended) continue;
    const expired = !!m.lifecycle && !meetingAllowed(m);
    m.hosted!.entitlement = entitlementFor(grant, m.hosted!.accountId);
    if (expired || !meetingAllowed(m) || (overCapacity && m.lifecycle))
      endMeeting(m);
  }
}

export function entitlementFor(
  grant: HostedEntitlement,
  accountId: string,
): MeetingEntitlement {
  const { billingOwnerId: _, hostAccountIds, ...value } = grant;
  return {
    ...structuredClone(value),
    allowed: hostAccountIds.includes(accountId),
  };
}

export function requireEntitlement(
  grant: HostedEntitlement | undefined,
  accountId: string,
  now = Date.now(),
) {
  if (
    !grant?.enabled ||
    !grant.quota ||
    grant.validUntil <= now ||
    !grant.hostAccountIds.includes(accountId)
  )
    throw new HttpError(403, "Hosting plan is unavailable");
  return grant;
}

export function meetingDeadline(m: Meeting) {
  return Math.min(
    m.lifecycle?.deadlineAt ?? Infinity,
    m.hosted?.billingOwnerId
      ? (m.hosted.entitlement?.validUntil ?? 0)
      : Infinity,
  );
}

export function meetingAllowed(m: Meeting, now = Date.now()) {
  return (
    !m.ended &&
    meetingDeadline(m) > now &&
    (!m.hosted?.billingOwnerId ||
      !!(
        m.hosted.entitlement?.enabled &&
        m.hosted.entitlement.allowed &&
        m.hosted.entitlement.quota
      ))
  );
}

export function requireMeetingAccess(m: Meeting) {
  if (!meetingAllowed(m))
    throw new HttpError(410, "Meeting ended or hosting plan unavailable");
}

export function occupiesMeetingSeat(p: Participant) {
  // An expired browser lobby session never had media. Admitted sessions and
  // pending removals retain their place; phone teardown needs its own proof.
  return (
    p.status === "admitted" ||
    (p.status === "waiting" && p.expiresAt > Date.now()) ||
    !!p.enforcementPending ||
    !!(p.phone && !p.phone.closed)
  );
}

export function participantLimit(m: Meeting) {
  return (
    m.hosted?.entitlement?.limits.participants ??
    m.limits?.participants ??
    (m.mode === "meeting" ? 100 : 1010)
  );
}

export const webinarViewerLimit = 1000;

export function requireWebinarViewerSeat(m: Meeting) {
  if (
    m.participants.filter((p) => occupiesMeetingSeat(p) && p.role === "viewer")
      .length >= webinarViewerLimit
  )
    throw new HttpError(409, "Webinar audience is full");
}

export function requireMeetingSeat(m: Meeting) {
  if (m.participants.filter(occupiesMeetingSeat).length >= participantLimit(m))
    throw new HttpError(409, "Meeting is full");
  if (m.mode === "webinar") requireWebinarViewerSeat(m);
}

export function holdsMeetingReservation(m: Meeting) {
  return (
    !!m.hosted?.billingOwnerId && !!m.lifecycle && !m.lifecycle.cleanupConfirmed
  );
}

// Ordinary completion keeps finished recordings downloadable. Account revocation is stricter.
export function endMeeting(m: Meeting) {
  if (m.ended) return false;
  m.ended = true;
  m.cleanupPending = true;
  m.locked = true;
  m.recordingAllowed = false;
  delete m.hostTokenHash;
  for (const p of m.participants) {
    fenceParticipantMedia(m, p);
  }
  for (const r of m.recordings)
    if (["starting", "recording", "stopping"].includes(r.status))
      r.status = "stopping";
  return true;
}

export function startMeetingReservation(m: Meeting, meetings: Meeting[]) {
  requireMeetingAccess(m);
  if (m.lifecycle) return;
  if (m.hosted?.billingOwnerId) {
    const held = meetings.filter(holdsMeetingReservation);
    if (held.some((x) => x.hosted?.accountId === m.hosted!.accountId))
      throw new HttpError(
        409,
        "This host already has a meeting running or closing",
      );
    if (
      held.filter((x) => x.hosted?.billingOwnerId === m.hosted!.billingOwnerId)
        .length >= m.hosted.entitlement!.limits.concurrentMeetings
    )
      throw new HttpError(
        409,
        "The hosting plan's simultaneous meeting limit is reached",
      );
  }
  const duration =
    m.hosted?.entitlement?.limits.durationSeconds ??
    m.limits?.durationSeconds ??
    0;
  const startedAt = Date.now();
  m.lifecycle = {
    startedAt,
    ...(duration ? { deadlineAt: startedAt + duration * 1000 } : {}),
  };
}
