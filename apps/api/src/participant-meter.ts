import type { Meeting, Participant, Recording } from "./store.js";
import { fenceParticipantMedia } from "./media-identity.js";
import {
  endMeeting,
  meetingAllowed,
  meetingDeadline,
  type HostedEntitlement,
} from "./meeting-limits.js";
import { HttpError } from "./security.js";
import { recordingStorageView } from "./recording-storage-quota.js";

export const PARTICIPANT_PREPAY_MS = 30_000;
export const PARTICIPANT_PRESENCE_MS = 15_000;
export const RECORDING_PREPAY_MS = 30_000;
export type RecordingTimeReservation = {
  billingOwnerId: string;
  reservedFrom: number;
  fundedUntil: number;
  egressId?: string;
  startedAt?: number;
  settled?: { startedAt: number; endedAt: number };
};
export type RecordingTimeObservation =
  | { egressId: string; terminal: false; startedAt?: number }
  | { egressId: string; terminal: true; startedAt: number; endedAt: number };
export type ParticipantMeter = {
  connectionId: string;
  mediaVersion: number;
  phase: "connecting" | "active" | "closing";
  accountedAt: number;
  fundedUntil: number;
  presenceUntil: number;
  connectedAt?: number;
};
export type MeetingMeter = Pick<
  ParticipantMeter,
  "phase" | "accountedAt" | "fundedUntil" | "connectedAt"
>;
export type UsageLedger = {
  anchorAt: number;
  metering?: "meeting";
  windows: {
    start: number;
    end: number;
    usedMs: number;
    meetingUsedMs?: number;
    recordingDownloadBytesUsed?: number;
    recordingUsedMs?: number;
  }[];
};
export type MeterAction = "claim" | "connected" | "heartbeat";
export type MeterInput = {
  participantId: string;
  mediaVersion: number;
  connectionId: string;
  action: MeterAction;
};

// Clamp from the original UTC anniversary, never from the previous short month.
export function usageWindow(anchorAt: number, at: number) {
  const anchor = new Date(anchorAt),
    date = new Date(at);
  const boundary = (month: number) => {
    const first = new Date(Date.UTC(anchor.getUTCFullYear(), month, 1));
    const days = new Date(
      Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0),
    ).getUTCDate();
    return Date.UTC(
      first.getUTCFullYear(),
      first.getUTCMonth(),
      Math.min(anchor.getUTCDate(), days),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    );
  };
  let month =
    (date.getUTCFullYear() - anchor.getUTCFullYear()) * 12 + date.getUTCMonth();
  if (boundary(month) > at) month--;
  return { start: boundary(month), end: boundary(month + 1) };
}

function intervals(anchor: number, from: number, to: number) {
  const result: { start: number; end: number; ms: number }[] = [];
  while (from < to) {
    const window = usageWindow(anchor, from);
    const end = Math.min(to, window.end);
    result.push({ ...window, ms: end - from });
    from = end;
  }
  return result;
}

function windowRow(ledger: UsageLedger, start: number, end: number) {
  let row = ledger.windows.find((w) => w.start === start);
  if (!row) ledger.windows.push((row = { start, end, usedMs: 0 }));
  return row;
}

function account(
  ledger: UsageLedger,
  meter: MeetingMeter,
  through: number,
  mode: "participant" | "meeting" = "participant",
) {
  if (meter.connectedAt === undefined) return;
  const to = Math.min(through, meter.fundedUntil);
  for (const part of intervals(ledger.anchorAt, meter.accountedAt, to)) {
    const row = windowRow(ledger, part.start, part.end);
    if (mode === "meeting")
      row.meetingUsedMs = (row.meetingUsedMs ?? 0) + part.ms;
    else row.usedMs += part.ms;
  }
  meter.accountedAt = Math.max(meter.accountedAt, to);
}

function held(
  ledger: UsageLedger,
  meetings: Meeting[],
  start: number,
  mode: "participant" | "meeting" = ledger.metering ?? "participant",
) {
  let ms = 0;
  for (const m of meetings) {
    const meters =
      mode === "meeting"
        ? [m.meetingMeter]
        : m.meetingMeter
          ? []
          : m.participants.map((p) => p.meter);
    for (const meter of meters)
      if (meter)
        for (const part of intervals(
          ledger.anchorAt,
          meter.accountedAt,
          meter.fundedUntil,
        ))
          if (part.start === start) ms += part.ms;
  }
  return ms;
}

function usedTime(ledger: UsageLedger, start: number) {
  const row = ledger.windows.find((w) => w.start === start);
  return ledger.metering === "meeting"
    ? (row?.meetingUsedMs ?? 0)
    : (row?.usedMs ?? 0);
}

export function setMetering(
  ledger: UsageLedger,
  grant: HostedEntitlement,
  meetings: Meeting[],
) {
  if (!grant.quota) return;
  if (ledger.metering === "meeting" && grant.quota.metering !== "meeting")
    throw new HttpError(
      409,
      "Meeting metering cannot revert to participant metering",
    );
  if (grant.quota.metering === "meeting" && ledger.metering !== "meeting") {
    // One-way upgrade: retain historical participant usage and every uncertain
    // reservation. Drain old paid sessions; never relabel them as meeting time.
    for (const m of meetings)
      if (!m.meetingMeter && m.participants.some((p) => p.meter)) endMeeting(m);
    ledger.metering = "meeting";
  }
}

export function usageBlocked(
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
  now: number,
) {
  return (
    !grant?.enabled ||
    !grant.quota ||
    grant.validUntil <= now ||
    meetings.some(
      (m) =>
        m.meetingMeter?.phase === "closing" ||
        m.participants.some((p) => p.meter?.phase === "closing"),
    )
  );
}

export function sweepParticipantMeters(
  ledger: UsageLedger,
  meetings: Meeting[],
  now: number,
) {
  for (const m of meetings) {
    if (m.meetingMeter) {
      const shared = m.meetingMeter;
      if (shared.fundedUntil <= now && !m.ended) endMeeting(m);
      for (const p of m.participants) {
        const meter = p.meter;
        if (!meter || meter.phase === "closing") continue;
        if (
          !meetingAllowed(m, now) ||
          p.status !== "admitted" ||
          p.enforcementPending ||
          shared.fundedUntil <= now ||
          meter.presenceUntil <= now
        ) {
          meter.phase = "closing";
          if (!p.enforcementPending) fenceParticipantMedia(m, p);
        }
      }
      if (!m.participants.some((p) => p.meter && p.meter.phase !== "closing"))
        shared.phase = "closing";
      else if (shared.phase === "active")
        account(ledger, shared, now, "meeting");
      continue;
    }
    for (const p of m.participants) {
      const meter = p.meter;
      if (!meter || meter.phase === "closing") continue;
      if (
        !meetingAllowed(m, now) ||
        p.status !== "admitted" ||
        p.enforcementPending ||
        meter.fundedUntil <= now ||
        meter.presenceUntil <= now
      ) {
        // No expiry is a refund. Fence first; settle only after physical cleanup.
        meter.phase = "closing";
        if (meter.fundedUntil <= now && p.role === "host" && !m.ended)
          endMeeting(m);
        if (!p.enforcementPending) {
          fenceParticipantMedia(m, p);
        }
      } else if (meter.phase === "active") account(ledger, meter, now);
    }
  }
}

export function usageView(
  ledger: UsageLedger,
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
  now: number,
) {
  const window = usageWindow(ledger.anchorAt, now);
  const used = usedTime(ledger, window.start);
  const reserved = held(ledger, meetings, window.start);
  const limit = (grant?.quota?.participantSecondsPerMonth ?? 0) * 1000;
  const downloadLimit = grant?.quota?.downloadBytesPerMonth ?? 0;
  const downloadUsed =
    ledger.windows.find((w) => w.start === window.start)
      ?.recordingDownloadBytesUsed ?? 0;
  return {
    ok: true as const,
    metering: ledger.metering ?? "participant",
    window,
    participantSeconds: {
      limit: limit / 1000,
      used: Math.ceil(used / 1000),
      reserved: Math.ceil(reserved / 1000),
      available: Math.floor(Math.max(0, limit - used - reserved) / 1000),
    },
    recordingDownloadBytes: {
      limit: downloadLimit,
      used: downloadUsed,
      available: Math.max(0, downloadLimit - downloadUsed),
    },
    recordingSeconds: recordingTimeView(ledger, grant, meetings, now),
    recordingStorageBytes: recordingStorageView(grant, meetings),
    asOf: now,
    blocked: usageBlocked(grant, meetings, now) || used + reserved > limit,
  };
}

export function debitDownloadBytes(
  ledger: UsageLedger,
  grant: HostedEntitlement,
  plaintextBytes: number,
  now: number,
) {
  if (!Number.isSafeInteger(plaintextBytes) || plaintextBytes < 0)
    throw new HttpError(503, "Recording size is unavailable");
  const window = usageWindow(ledger.anchorAt, now);
  const used =
    ledger.windows.find((w) => w.start === window.start)
      ?.recordingDownloadBytesUsed ?? 0;
  const limit = grant.quota?.downloadBytesPerMonth ?? 0;
  if (plaintextBytes > Math.max(0, limit - used))
    throw new HttpError(
      409,
      "Recording download allowance is unavailable",
      "RECORDING_DOWNLOAD_QUOTA_UNAVAILABLE",
    );
  // Debit the full declared file size before streaming. Retries consume
  // another full debit; socket failure and cancellation do not refund it.
  windowRow(ledger, window.start, window.end).recordingDownloadBytesUsed =
    used + plaintextBytes;
}

export function quotaOverdrawn(
  ledger: UsageLedger,
  grant: HostedEntitlement,
  meetings: Meeting[],
  now: number,
) {
  const window = usageWindow(ledger.anchorAt, now);
  const used = usedTime(ledger, window.start);
  return (
    used + held(ledger, meetings, window.start) >
    (grant.quota?.participantSecondsPerMonth ?? 0) * 1000
  );
}

export function requireUsage(
  ledger: UsageLedger,
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
  now: number,
  participant?: Participant,
  meeting?: Meeting,
) {
  // Unknown recording inventory blocks capture and its usage display, not an
  // independently funded meeting or its existing media connections.
  const window = usageWindow(ledger.anchorAt, now);
  const available =
    (grant?.quota?.participantSecondsPerMonth ?? 0) * 1000 -
    usedTime(ledger, window.start) -
    held(ledger, meetings, window.start);
  const meter =
    ledger.metering === "meeting" ? meeting?.meetingMeter : participant?.meter;
  const prepaid = meter && meter.phase !== "closing" && meter.fundedUntil > now;
  const continuing = prepaid && meter.phase === "active";
  if (
    !grant?.enabled ||
    !grant.quota ||
    grant.validUntil <= now ||
    quotaOverdrawn(ledger, grant, meetings, now) ||
    (usageBlocked(grant, meetings, now) && !continuing) ||
    (!prepaid && available < 1000)
  )
    throw new HttpError(
      409,
      "Meeting access allowance is unavailable",
      "PARTICIPANT_QUOTA_UNAVAILABLE",
    );
}

function fund(
  ledger: UsageLedger,
  grant: HostedEntitlement,
  meetings: Meeting[],
  meter: MeetingMeter,
  to: number,
) {
  const limit = grant.quota!.participantSecondsPerMonth * 1000;
  for (const part of intervals(ledger.anchorAt, meter.fundedUntil, to)) {
    const used = usedTime(ledger, part.start);
    const available = Math.max(
      0,
      limit - used - held(ledger, meetings, part.start),
    );
    const add = Math.min(part.ms, available);
    meter.fundedUntil += add;
    if (add < part.ms) break;
  }
}

export function updateMeter(
  ledger: UsageLedger,
  grant: HostedEntitlement,
  meetings: Meeting[],
  meeting: Meeting,
  input: MeterInput,
  now: number,
) {
  const p = meeting.participants.find((x) => x.id === input.participantId);
  if (
    !p ||
    !meetingAllowed(meeting, now) ||
    p.status !== "admitted" ||
    p.enforcementPending ||
    p.mediaVersion !== input.mediaVersion
  )
    throw new HttpError(403, "Media access denied");
  let meter = p.meter;
  if (
    input.action !== "claim" &&
    (!meter ||
      meter.connectionId !== input.connectionId ||
      meter.mediaVersion !== input.mediaVersion)
  )
    throw new HttpError(409, "Media connection changed");
  const blocked = usageBlocked(grant, meetings, now);
  if (input.action === "claim" && blocked)
    throw new HttpError(
      409,
      "Participant-minute allowance is unavailable",
      "PARTICIPANT_QUOTA_UNAVAILABLE",
    );
  requireUsage(ledger, grant, meetings, now, p, meeting);
  if (ledger.metering === "meeting") {
    const shared = (meeting.meetingMeter ??= {
      phase: "connecting",
      accountedAt: now,
      fundedUntil: now,
    });
    if (input.action === "claim") {
      meter = p.meter ??= {
        connectionId: input.connectionId,
        mediaVersion: input.mediaVersion,
        phase: "connecting",
        accountedAt: now,
        fundedUntil: shared.fundedUntil,
        presenceUntil: now + PARTICIPANT_PRESENCE_MS,
      };
      meter.connectionId = input.connectionId;
      meter.mediaVersion = input.mediaVersion;
    }
    if (meter!.phase === "closing" || shared.phase === "closing")
      throw new HttpError(409, "Media cleanup is pending");
    if (input.action === "connected") {
      if (shared.connectedAt === undefined) {
        shared.connectedAt = now;
        shared.accountedAt = now;
        shared.phase = "active";
      }
      meter!.connectedAt ??= now;
      meter!.phase = "active";
    }
    // One logical meeting interval covers all peers, phone legs and breakouts.
    // Successful signaling opens allowance, including setup and presence grace.
    if (shared.phase === "active") account(ledger, shared, now, "meeting");
    meter!.presenceUntil = now + PARTICIPANT_PRESENCE_MS;
    if (!blocked && shared.fundedUntil - now <= 10_000)
      fund(
        ledger,
        grant,
        meetings,
        shared,
        Math.min(now + PARTICIPANT_PREPAY_MS, meetingDeadline(meeting)),
      );
    for (const member of meeting.participants)
      if (member.meter && member.meter.phase !== "closing")
        member.meter.fundedUntil = shared.fundedUntil;
    if (shared.fundedUntil <= now)
      throw new HttpError(
        409,
        "Meeting allowance is exhausted",
        "PARTICIPANT_QUOTA_UNAVAILABLE",
      );
    return;
  }
  if (input.action === "claim") {
    meter = p.meter ??= {
      connectionId: input.connectionId,
      mediaVersion: input.mediaVersion,
      phase: "connecting",
      accountedAt: now,
      fundedUntil: now,
      presenceUntil: now + PARTICIPANT_PRESENCE_MS,
    };
    meter.connectionId = input.connectionId;
    meter.mediaVersion = input.mediaVersion;
  }
  if (meter!.phase === "closing")
    throw new HttpError(409, "Media cleanup is pending");
  if (input.action === "connected" && meter!.connectedAt === undefined) {
    meter!.connectedAt = now;
    // Allowance covers successful signaling access, including setup and reconnect
    // grace. It is not measured RTP time. A never-opened upstream uses zero.
    meter!.accountedAt = now;
    meter!.phase = "active";
  }
  if (meter!.phase === "active") account(ledger, meter!, now);
  meter!.presenceUntil = now + PARTICIPANT_PRESENCE_MS;
  if (!blocked && meter!.fundedUntil - now <= 10_000)
    fund(
      ledger,
      grant,
      meetings,
      meter!,
      Math.min(now + PARTICIPANT_PREPAY_MS, meetingDeadline(meeting)),
    );
  if (meter!.fundedUntil <= now)
    throw new HttpError(
      409,
      "Participant-minute allowance is exhausted",
      "PARTICIPANT_QUOTA_UNAVAILABLE",
    );
}

export function settleMeter(
  ledger: UsageLedger,
  m: Meeting,
  p: Participant,
  now: number,
) {
  if (!p.meter) return;
  if (m.meetingMeter) account(ledger, m.meetingMeter, now, "meeting");
  else account(ledger, p.meter, now);
  delete p.meter;
  if (m.meetingMeter && !m.participants.some((member) => member.meter))
    delete m.meetingMeter;
}

export function canSettleMeter(m: Meeting, p: Participant, now: number) {
  // Moderation removes only the shared-meeting leg. Its confirmed removal may
  // reopen the same live phone dialog; terminal teardown still needs both legs.
  return (
    !p.phone ||
    p.phone.closed ||
    (meetingAllowed(m, now) &&
      p.status === "admitted" &&
      p.phone.leaseExpiresAt > now &&
      !!p.meter &&
      p.meter.mediaVersion < p.mediaVersion)
  );
}

const recordingActive = (r: Recording) =>
  ["starting", "recording", "stopping"].includes(r.status);

function recordingHeld(
  ledger: UsageLedger,
  meetings: Meeting[],
  start: number,
  now: number,
) {
  let ms = 0;
  for (const m of meetings)
    for (const r of m.recordings) {
      const reservation = r.timeReservation;
      if (!reservation || reservation.settled) continue;
      // An overdue recorder may still be running. Its uncertain time stays held
      // across window changes until exact terminal evidence settles it.
      for (const part of intervals(
        ledger.anchorAt,
        reservation.startedAt ?? reservation.reservedFrom,
        Math.max(reservation.fundedUntil, now),
      ))
        if (part.start === start) ms += part.ms;
    }
  return ms;
}

function recordingTimeView(
  ledger: UsageLedger,
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
  now: number,
) {
  if (grant?.quota?.recordingSecondsPerMonth === null) return null;
  const window = usageWindow(ledger.anchorAt, now);
  const used =
    ledger.windows.find((w) => w.start === window.start)?.recordingUsedMs ?? 0;
  const reserved = recordingHeld(ledger, meetings, window.start, now);
  const limit = (grant?.quota?.recordingSecondsPerMonth ?? 0) * 1000;
  return {
    limit: limit / 1000,
    used: Math.ceil(used / 1000),
    reserved: Math.ceil(reserved / 1000),
    available: Math.floor(Math.max(0, limit - used - reserved) / 1000),
  };
}

function recordingOverdrawn(
  ledger: UsageLedger,
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
  now: number,
) {
  if (grant?.quota?.recordingSecondsPerMonth === null) return false;
  const window = usageWindow(ledger.anchorAt, now);
  return (
    (ledger.windows.find((w) => w.start === window.start)?.recordingUsedMs ??
      0) +
      recordingHeld(ledger, meetings, window.start, now) >
    (grant?.quota?.recordingSecondsPerMonth ?? 0) * 1000
  );
}

function recordingPending(meetings: Meeting[], now: number) {
  return meetings.some((m) =>
    m.recordings.some((r) => {
      const held = r.timeReservation;
      return held
        ? !held.settled && (r.status === "stopping" || held.fundedUntil <= now)
        : recordingActive(r);
    }),
  );
}

function recordingEligible(
  grant: HostedEntitlement | undefined,
  m: Meeting,
  now: number,
) {
  return (
    !!grant?.enabled &&
    grant.validUntil > now &&
    (grant.quota?.recordingSecondsPerMonth === null ||
      (grant.quota?.recordingSecondsPerMonth ?? 0) > 0) &&
    !m.hosted?.revoked &&
    grant.hostAccountIds.includes(m.hosted!.accountId) &&
    meetingAllowed(m, now) &&
    m.recordingAllowed
  );
}

export function checkRecordingTime(
  ledger: UsageLedger | undefined,
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
  m: Meeting,
  r: Recording,
  now: number,
) {
  if (!recordingActive(r)) return false;
  if (r.timeReservation?.settled) {
    // Settlement may commit before the service persists its file-processing
    // state. Keep retrying the exact job stop; never fund it again.
    r.status = "stopping";
    return true;
  }
  if (!m.hosted?.billingOwnerId) {
    const stop =
      r.status === "stopping" || !meetingAllowed(m, now) || !m.recordingAllowed;
    if (stop) r.status = "stopping";
    return stop;
  }
  // Upgrading an already-running bound recording cannot grant it free capture.
  // Hold its uncertain interval and stop; terminal proof can settle it later.
  if (!r.timeReservation) {
    r.timeReservation = {
      billingOwnerId: m.hosted.billingOwnerId,
      reservedFrom: r.createdAt,
      fundedUntil: now,
      ...(r.egressId ? { egressId: r.egressId } : {}),
    };
    r.status = "stopping";
  }
  if (r.timeReservation.billingOwnerId !== m.hosted.billingOwnerId)
    throw new HttpError(409, "Recording allowance owner changed");
  const stop =
    r.status === "stopping" ||
    r.timeReservation.fundedUntil <= now ||
    !ledger ||
    !recordingEligible(grant, m, now) ||
    recordingOverdrawn(ledger, grant, meetings, now);
  if (stop) r.status = "stopping";
  return stop;
}

export function sweepRecordingTimes(
  ledger: UsageLedger | undefined,
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
  now: number,
) {
  for (const m of meetings)
    for (const r of m.recordings)
      checkRecordingTime(ledger, grant, meetings, m, r, now);
}

function fundRecordingTime(
  ledger: UsageLedger,
  grant: HostedEntitlement,
  meetings: Meeting[],
  reservation: RecordingTimeReservation,
  to: number,
  now: number,
) {
  // Uncapped monthly recording still needs a short control lease, paid access,
  // storage reservation and exact terminal proof before releasing an old job.
  if (grant.quota?.recordingSecondsPerMonth === null) {
    reservation.fundedUntil = Math.max(reservation.fundedUntil, to);
    return;
  }
  const limit = (grant.quota?.recordingSecondsPerMonth ?? 0) * 1000;
  for (const part of intervals(ledger.anchorAt, reservation.fundedUntil, to)) {
    const used =
      ledger.windows.find((w) => w.start === part.start)?.recordingUsedMs ?? 0;
    const available = Math.max(
      0,
      limit - used - recordingHeld(ledger, meetings, part.start, now),
    );
    const add = Math.min(part.ms, available);
    reservation.fundedUntil += add;
    if (add < part.ms) break;
  }
}

export function reserveRecordingTime(
  ledger: UsageLedger,
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
  m: Meeting,
  r: Recording,
  now: number,
) {
  if (
    !recordingEligible(grant, m, now) ||
    recordingPending(meetings, now) ||
    recordingOverdrawn(ledger, grant, meetings, now)
  )
    throw new HttpError(
      409,
      "Recording-time allowance is unavailable",
      "RECORDING_TIME_QUOTA_UNAVAILABLE",
    );
  const reservation: RecordingTimeReservation = {
    billingOwnerId: m.hosted!.billingOwnerId!,
    reservedFrom: now,
    fundedUntil: now,
  };
  fundRecordingTime(
    ledger,
    grant!,
    meetings,
    reservation,
    Math.min(
      now + RECORDING_PREPAY_MS,
      grant!.validUntil,
      m.lifecycle?.deadlineAt ?? Infinity,
    ),
    now,
  );
  if (reservation.fundedUntil <= now)
    throw new HttpError(
      409,
      "Recording-time allowance is unavailable",
      "RECORDING_TIME_QUOTA_UNAVAILABLE",
    );
  r.timeReservation = reservation;
}

export function observeRecordingTime(
  ledger: UsageLedger | undefined,
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
  m: Meeting,
  r: Recording,
  input: RecordingTimeObservation,
  now: number,
) {
  const validTime = (value: number) =>
    Number.isSafeInteger(value) && value > 0 && value <= now;
  if (
    !input.egressId ||
    input.egressId.length > 256 ||
    /[\x00-\x1f\x7f]/.test(input.egressId) ||
    (r.egressId && r.egressId !== input.egressId) ||
    (r.timeReservation?.egressId &&
      r.timeReservation.egressId !== input.egressId)
  )
    throw new HttpError(409, "Recording job changed");
  if (
    (input.startedAt !== undefined && !validTime(input.startedAt)) ||
    (input.terminal &&
      (!validTime(input.startedAt) ||
        !validTime(input.endedAt) ||
        input.endedAt < input.startedAt))
  )
    throw new HttpError(409, "Recording time evidence is unavailable");
  const held = r.timeReservation;
  if (held?.settled) {
    if (
      !input.terminal ||
      held.settled.startedAt !== input.startedAt ||
      held.settled.endedAt !== input.endedAt
    )
      throw new HttpError(409, "Recording settlement changed");
    return false;
  }
  r.egressId = input.egressId;
  if (!m.hosted?.billingOwnerId)
    return input.terminal
      ? false
      : checkRecordingTime(ledger, grant, meetings, m, r, now);
  if (!ledger) throw new HttpError(409, "Recording usage is unavailable");
  checkRecordingTime(ledger, grant, meetings, m, r, now);
  const reservation = r.timeReservation;
  if (!reservation)
    throw new HttpError(409, "Recording reservation is unavailable");
  reservation.egressId = input.egressId;
  if (input.terminal) {
    // Egress can revise its provisional start timestamp. Only the exact job's
    // terminal interval becomes used time; the settled proof is immutable.
    for (const part of intervals(
      ledger.anchorAt,
      input.startedAt,
      input.endedAt,
    )) {
      const row = windowRow(ledger, part.start, part.end);
      row.recordingUsedMs = (row.recordingUsedMs ?? 0) + part.ms;
    }
    reservation.settled = {
      startedAt: input.startedAt,
      endedAt: input.endedAt,
    };
    return false;
  }
  if (input.startedAt !== undefined)
    // Keep the earliest provisional observation. A later active timestamp must
    // not release held time or move the funded deadline forward.
    reservation.startedAt = Math.min(
      reservation.startedAt ?? input.startedAt,
      input.startedAt,
    );
  if (checkRecordingTime(ledger, grant, meetings, m, r, now)) return true;
  if (input.startedAt !== undefined && !recordingPending(meetings, now))
    fundRecordingTime(
      ledger,
      grant!,
      meetings,
      reservation,
      Math.min(
        now + RECORDING_PREPAY_MS,
        grant!.validUntil,
        m.lifecycle?.deadlineAt ?? Infinity,
      ),
      now,
    );
  return checkRecordingTime(ledger, grant, meetings, m, r, now);
}
