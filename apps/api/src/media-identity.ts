import { randomUUID } from "node:crypto";
import type { Meeting, Participant } from "./store.js";

export const GATEWAY_PRESENCE_MS = 15_000;

// Rows predating physical identities retain their existing SFU identity until fenced.
export const mediaIdentity = (p: Participant) => p.mediaIdentity ?? p.id;
export const retiredMediaIdentity = (p: Participant) =>
  p.previousMediaIdentity ?? mediaIdentity(p);

// Legacy webinars without lifecycle metadata remain on their existing live room.
export function webinarBackstage(m: Meeting, p: Participant) {
  return !!(
    m.mode === "webinar" &&
    m.webinar &&
    !p.breakoutId &&
    p.role !== "viewer" &&
    (m.webinar.phase === "backstage" || p.webinarLocation !== "stage")
  );
}
export function participantRoom(m: Meeting, p: Participant) {
  if (p.breakoutId)
    return m.breakouts.find((b) => b.id === p.breakoutId)?.room ?? m.room;
  return webinarBackstage(m, p) ? m.webinar!.backstageRoom : m.room;
}
export const participantDataScope = (m: Meeting, p: Participant) =>
  p.breakoutId ?? (webinarBackstage(m, p) ? "@backstage" : "");

export function fenceParticipantMedia(m: Meeting, p: Participant) {
  // Pending cleanup owns this immutable target even if another restriction arrives.
  p.previousMediaIdentity ??= mediaIdentity(p);
  p.previousRoom ??= participantRoom(m, p);
  p.mediaIdentity = randomUUID();
  p.mediaVersion++;
  p.enforcementPending = true;
  delete p.gatewayConnectionId;
  delete p.gatewayPresenceUntil;
}

export function completeMediaFence(p: Participant, snapshot: Participant) {
  if (
    !p.enforcementPending ||
    p.mediaVersion !== snapshot.mediaVersion ||
    retiredMediaIdentity(p) !== retiredMediaIdentity(snapshot) ||
    p.previousRoom !== snapshot.previousRoom
  )
    return false;
  // An old process may have persisted a pending fence before identities existed.
  // Migrate atomically with completion, before any successor can reuse the old target.
  if (!p.mediaIdentity) {
    p.mediaIdentity = randomUUID();
    p.mediaVersion++;
    delete p.gatewayConnectionId;
    delete p.gatewayPresenceUntil;
  }
  p.enforcementPending = false;
  delete p.previousMediaIdentity;
  delete p.previousRoom;
  return true;
}

export const gatewayPresenceExpired = (p: Participant, now = Date.now()) =>
  !!p.gatewayConnectionId && (p.gatewayPresenceUntil ?? 0) <= now;

export function ownsGatewayConnection(
  p: Participant,
  snapshot: Participant,
  connectionId: string,
) {
  return (
    p.gatewayConnectionId === connectionId &&
    p.mediaVersion === snapshot.mediaVersion &&
    mediaIdentity(p) === mediaIdentity(snapshot) &&
    !p.enforcementPending
  );
}
