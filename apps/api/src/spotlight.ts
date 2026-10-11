import { participantDataScope } from "./media-identity.js";
import { meetingAllowed, participantMediaAllowed } from "./meeting-limits.js";
import type { Meeting } from "./store.js";

function persistentTarget(m: Meeting, scope: string, id: string) {
  return m.participants.find(
    (p) =>
      p.id === id &&
      p.transport !== "phone" &&
      p.role !== "viewer" &&
      meetingAllowed(m) &&
      p.status === "admitted" &&
      p.expiresAt > Date.now() &&
      participantDataScope(m, p) === scope &&
      (!p.breakoutId || m.breakouts.some((room) => room.id === p.breakoutId)),
  );
}

export function spotlightTarget(m: Meeting, scope: string, id: string) {
  const p = persistentTarget(m, scope, id);
  return p && participantMediaAllowed(m, p) ? p : undefined;
}

// Read snapshots may outlive a participant lease. Never expose a stale target,
// even before the next serialized mutation removes it from persisted state.
export function roomSpotlight(m: Meeting, scope: string) {
  const selected = m.spotlights?.find((entry) => entry.scope === scope);
  return selected
    ? (spotlightTarget(m, scope, selected.participantId)?.id ?? null)
    : null;
}

export function clearStaleSpotlights(m: Meeting) {
  if (!m.spotlights) return;
  // A same-room media fence changes the publisher, not the selected human.
  // Hide it while pending, then resolve the new identity when media is ready.
  m.spotlights = m.spotlights.filter((entry) =>
    persistentTarget(m, entry.scope, entry.participantId),
  );
  if (!m.spotlights.length) delete m.spotlights;
}
