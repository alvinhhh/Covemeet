import { fenceParticipantMedia, webinarBackstage } from "./media-identity.js";
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
    metering?: "meeting";
    participantSecondsPerMonth: number | null;
    downloadBytesPerMonth?: number;
    recordingSecondsPerMonth?: number | null;
    storageBytes?: number;
  } | null;
  hostAccountIds: string[];
  limits: {
    participants: number;
    webinarParticipants?: number;
    durationSeconds: number;
    groupDurationSeconds?: number;
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
        metering: z.literal("meeting").optional(),
        participantSecondsPerMonth: z
          .number()
          .int()
          .positive()
          .max(36000000)
          .nullable(),
        downloadBytesPerMonth: z
          .number()
          .int()
          .nonnegative()
          .max(2e12)
          .optional(),
        recordingSecondsPerMonth: z
          .number()
          .int()
          .nonnegative()
          .max(360000)
          .nullable()
          .optional(),
        storageBytes: z
          .number()
          .int()
          .nonnegative()
          .max(1_000_000_000_000)
          .optional(),
      })
      .strict()
      .refine(
        (quota) =>
          quota.participantSecondsPerMonth !== null ||
          quota.metering === "meeting",
        "Uncapped meeting time requires meeting metering",
      )
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
        webinarParticipants: z
          .union([z.literal(100), z.literal(1010)])
          .optional(),
        durationSeconds: z.union([
          z.literal(0),
          z.literal(7200),
          z.literal(28800),
          z.literal(86400),
          z.literal(108000),
        ]),
        groupDurationSeconds: z.literal(10800).optional(),
        concurrentMeetings: z.number().int().min(1).max(100),
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
  )
  .refine(
    (grant) =>
      (grant.limits.durationSeconds === 0) ===
      (grant.limits.groupDurationSeconds === 10800),
    "Conditional group duration requires an uncapped two-person meeting",
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
      grant.quota?.metering ?? "participant",
      grant.quota?.participantSecondsPerMonth ?? null,
      grant.quota?.downloadBytesPerMonth ?? 0,
      grant.quota?.recordingSecondsPerMonth === undefined
        ? 0
        : grant.quota.recordingSecondsPerMonth,
      grant.quota?.storageBytes ?? 0,
      [...grant.hostAccountIds].sort(),
      grant.limits.participants,
      grant.limits.webinarParticipants ?? grant.limits.participants,
      grant.limits.durationSeconds,
      grant.limits.groupDurationSeconds ?? null,
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
    const previous = m.hosted!.entitlement?.limits;
    if (
      m.lifecycle &&
      previous &&
      !previous.groupDurationSeconds &&
      grant.limits.groupDurationSeconds
    ) {
      // A paid room cannot inherit its old deadline after losing paid access.
      endMeeting(m);
      continue;
    }
    m.hosted!.entitlement = entitlementFor(grant, m.hosted!.accountId);
    if (
      m.lifecycle &&
      !grant.limits.groupDurationSeconds &&
      previous?.durationSeconds !== grant.limits.durationSeconds
    )
      m.lifecycle.deadlineAt =
        m.lifecycle.startedAt + grant.limits.durationSeconds * 1000;
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

export function meetingDeadline(m: Meeting, now = Date.now()) {
  return Math.min(
    m.lifecycle?.deadlineAt ?? Infinity,
    controllerAbsenceDeadline(m, now),
    m.hosted?.billingOwnerId
      ? (m.hosted.entitlement?.validUntil ?? 0)
      : Infinity,
  );
}

export function meetingAllowed(m: Meeting, now = Date.now()) {
  return (
    !m.ended &&
    meetingDeadline(m, now) > now &&
    (!m.hosted?.billingOwnerId ||
      !!(
        m.hosted.entitlement?.enabled &&
        m.hosted.entitlement.allowed &&
        m.hosted.entitlement.quota
      ))
  );
}

export function participantMediaAllowed(
  m: Meeting,
  p: Participant,
  now = Date.now(),
) {
  return (
    meetingAllowed(m, now) &&
    p.status === "admitted" &&
    !p.enforcementPending &&
    p.expiresAt > now &&
    (!p.phone || p.phone.leaseExpiresAt > now) &&
    !(
      m.mode === "webinar" &&
      m.webinar &&
      ((p.role === "viewer" && m.webinar.phase !== "live") ||
        (m.webinar.starting && webinarBackstage(m, p)))
    )
  );
}

export function requireMeetingAccess(m: Meeting) {
  if (!meetingAllowed(m))
    throw new HttpError(410, "Meeting ended or hosting plan unavailable");
}

// Control presence is independent of camera/microphone or a media reconnect.
export const HOST_CONTROL_PRESENCE_MS = 30_000;
export function meetingController(m: Meeting, now = Date.now()) {
  const handoff = m.hostControl?.handoff;
  const p = handoff
    ? m.participants.find(
        (p) =>
          p.id === handoff.participantId &&
          p.moderator?.revision === handoff.grantRevision,
      )
    : m.participants.find((p) => p.role === "host");
  return p &&
    p.transport !== "phone" &&
    p.status === "admitted" &&
    p.expiresAt > now
    ? p
    : undefined;
}
export function controllerPresent(m: Meeting, now = Date.now()) {
  const p = meetingController(m, now);
  if (!m.hostControl) return !!p && !p.enforcementPending;
  return (
    !!p &&
    !p.enforcementPending &&
    Math.max(
      (m.hostControl?.lastSeenAt ?? 0) + HOST_CONTROL_PRESENCE_MS,
      p.meter?.phase === "active" ? p.meter.presenceUntil : 0,
      p.gatewayPresenceUntil ?? 0,
    ) > now
  );
}
export function refreshHostPresence(
  m: Meeting,
  p: Participant,
  now = Date.now(),
) {
  const control = m.hostControl;
  if (
    !control ||
    !m.lifecycle ||
    !meetingAllowed(m, now) ||
    meetingController(m, now)?.id !== p.id ||
    p.enforcementPending ||
    (control.lastSeenAt > now - 10_000 && control.absentSince === undefined)
  )
    return;
  control.lastSeenAt = now;
  delete control.absentSince;
}
function controllerAbsenceDeadline(m: Meeting, now: number) {
  const control = m.hostControl;
  if (!m.lifecycle || !control || controllerPresent(m, now)) return Infinity;
  const p = meetingController(m, now);
  const latestPresence = Math.max(
    control.lastSeenAt + HOST_CONTROL_PRESENCE_MS,
    p?.meter?.presenceUntil ?? 0,
    p?.gatewayPresenceUntil ?? 0,
  );
  return (control.absentSince ?? latestPresence) + control.graceSeconds * 1000;
}
export function reclaimHostControl(
  m: Meeting,
  graceSeconds: number,
  now = Date.now(),
) {
  m.hostControl = {
    revision: (m.hostControl?.revision ?? 0) + 1,
    graceSeconds: m.hostControl?.graceSeconds ?? graceSeconds,
    lastSeenAt: now,
  };
}
export function reconcileHostAbsence(
  m: Meeting,
  graceSeconds: number,
  now = Date.now(),
) {
  if (!m.lifecycle || m.ended) return false;
  if (!m.hostControl) {
    // Existing occurrences get one adoption grace; restart never resets it.
    reclaimHostControl(m, graceSeconds, now);
    return true;
  }
  const control = m.hostControl;
  if (controllerPresent(m, now)) {
    if (control.absentSince === undefined) return false;
    delete control.absentSince;
    return true;
  }
  const p = meetingController(m, now);
  const since = Math.min(
    now,
    Math.max(
      control.lastSeenAt + HOST_CONTROL_PRESENCE_MS,
      p?.meter?.presenceUntil ?? 0,
      p?.gatewayPresenceUntil ?? 0,
    ),
  );
  const changed = control.absentSince === undefined;
  control.absentSince ??= since;
  if (now >= control.absentSince + control.graceSeconds * 1000) {
    endMeeting(m);
    return true;
  }
  return changed;
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

export function occupiesRoomSeat(m: Meeting, p: Participant) {
  return (
    occupiesMeetingSeat(p) ||
    (p.role === "host" &&
      (!!m.hosted?.billingOwnerId || !!m.hostControl?.handoff) &&
      !m.ended &&
      !m.lifecycle?.cleanupConfirmed)
  );
}

export function participantLimit(m: Meeting) {
  if (m.mode === "webinar" && m.hosted?.entitlement?.limits.webinarParticipants)
    return m.hosted.entitlement.limits.webinarParticipants;
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
  if (
    m.participants.filter((p) => occupiesRoomSeat(m, p)).length >=
    participantLimit(m)
  )
    throw new HttpError(409, "Meeting is full");
  if (m.mode === "webinar") requireWebinarViewerSeat(m);
}

export function applyGroupDuration(m: Meeting, now = Date.now()) {
  const seconds = m.hosted?.entitlement?.limits.groupDurationSeconds;
  if (!seconds || !m.lifecycle || m.lifecycle.deadlineAt) return;
  if (m.participants.filter((p) => p.status === "admitted").length < 3) return;
  const deadline = m.lifecycle.startedAt + seconds * 1000;
  if (deadline <= now)
    throw new HttpError(
      409,
      "This free meeting cannot add a third person after three hours",
    );
  m.lifecycle.deadlineAt = deadline;
}

export function recordingIncluded(m: Meeting) {
  if (!m.hosted?.billingOwnerId) return true;
  const quota = m.hosted.entitlement?.quota;
  return !!(
    quota?.storageBytes &&
    (quota.recordingSecondsPerMonth === null ||
      (quota.recordingSecondsPerMonth ?? 0) > 0)
  );
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
  m.endedAt = Date.now();
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

export function startMeetingReservation(
  m: Meeting,
  meetings: Meeting[],
  freeMeetingLimit = 1,
  freeMeetings = meetings,
) {
  requireMeetingAccess(m);
  if (m.lifecycle) return;
  if (m.hosted?.entitlement?.limits.groupDurationSeconds) {
    const activeFree = freeMeetings.filter(
      (other) =>
        other.code !== m.code &&
        other.hosted?.entitlement?.limits.groupDurationSeconds &&
        holdsMeetingReservation(other),
    );
    if (activeFree.length >= freeMeetingLimit)
      throw new HttpError(
        503,
        "Free meeting capacity is full; try again later",
      );
  }
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
