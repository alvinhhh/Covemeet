import type { Meeting, Participant } from "./store.js";
import { fenceParticipantMedia } from "./media-identity.js";
import {
  endMeeting,
  meetingAllowed,
  meetingDeadline,
  type HostedEntitlement,
} from "./meeting-limits.js";
import { HttpError } from "./security.js";

export const PARTICIPANT_PREPAY_MS = 30_000;
export const PARTICIPANT_PRESENCE_MS = 15_000;
export type ParticipantMeter = {
  connectionId: string;
  mediaVersion: number;
  phase: "connecting" | "active" | "closing";
  accountedAt: number;
  fundedUntil: number;
  presenceUntil: number;
  connectedAt?: number;
};
export type UsageLedger = {
  anchorAt: number;
  windows: { start: number; end: number; usedMs: number }[];
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
  meter: ParticipantMeter,
  through: number,
) {
  if (meter.connectedAt === undefined) return;
  const to = Math.min(through, meter.fundedUntil);
  for (const part of intervals(ledger.anchorAt, meter.accountedAt, to))
    windowRow(ledger, part.start, part.end).usedMs += part.ms;
  meter.accountedAt = Math.max(meter.accountedAt, to);
}

function held(ledger: UsageLedger, meetings: Meeting[], start: number) {
  let ms = 0;
  for (const m of meetings)
    for (const p of m.participants)
      if (p.meter)
        for (const part of intervals(
          ledger.anchorAt,
          p.meter.accountedAt,
          p.meter.fundedUntil,
        ))
          if (part.start === start) ms += part.ms;
  return ms;
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
    meetings.some((m) =>
      m.participants.some((p) => p.meter?.phase === "closing"),
    )
  );
}

export function sweepParticipantMeters(
  ledger: UsageLedger,
  meetings: Meeting[],
  now: number,
) {
  for (const m of meetings)
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

export function usageView(
  ledger: UsageLedger,
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
  now: number,
) {
  const window = usageWindow(ledger.anchorAt, now);
  const used =
    ledger.windows.find((w) => w.start === window.start)?.usedMs ?? 0;
  const reserved = held(ledger, meetings, window.start);
  const limit = (grant?.quota?.participantSecondsPerMonth ?? 0) * 1000;
  return {
    ok: true as const,
    window,
    participantSeconds: {
      limit: limit / 1000,
      used: Math.ceil(used / 1000),
      reserved: Math.ceil(reserved / 1000),
      available: Math.floor(Math.max(0, limit - used - reserved) / 1000),
    },
    asOf: now,
    blocked: usageBlocked(grant, meetings, now) || used + reserved > limit,
  };
}

export function quotaOverdrawn(
  ledger: UsageLedger,
  grant: HostedEntitlement,
  meetings: Meeting[],
  now: number,
) {
  const window = usageWindow(ledger.anchorAt, now);
  const used =
    ledger.windows.find((w) => w.start === window.start)?.usedMs ?? 0;
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
) {
  const view = usageView(ledger, grant, meetings, now);
  const prepaid =
    participant?.meter &&
    participant.meter.phase !== "closing" &&
    participant.meter.fundedUntil > now;
  const continuing = prepaid && participant.meter!.phase === "active";
  if (
    !grant?.enabled ||
    !grant.quota ||
    grant.validUntil <= now ||
    quotaOverdrawn(ledger, grant, meetings, now) ||
    (view.blocked && !continuing) ||
    (!prepaid && view.participantSeconds.available <= 0)
  )
    throw new HttpError(
      409,
      "Participant-minute allowance is unavailable",
      "PARTICIPANT_QUOTA_UNAVAILABLE",
    );
}

function fund(
  ledger: UsageLedger,
  grant: HostedEntitlement,
  meetings: Meeting[],
  meter: ParticipantMeter,
  to: number,
) {
  const limit = grant.quota!.participantSecondsPerMonth * 1000;
  for (const part of intervals(ledger.anchorAt, meter.fundedUntil, to)) {
    const used =
      ledger.windows.find((w) => w.start === part.start)?.usedMs ?? 0;
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
  requireUsage(ledger, grant, meetings, now, p);
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

export function settleMeter(ledger: UsageLedger, p: Participant, now: number) {
  if (!p.meter) return;
  account(ledger, p.meter, now);
  delete p.meter;
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
