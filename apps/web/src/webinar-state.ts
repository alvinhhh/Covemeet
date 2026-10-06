import type { Participant } from "./api";

export function participantRoomScope(
  mode: "meeting" | "webinar",
  participant: Pick<Participant, "breakoutId" | "webinarBackstage">,
) {
  if (participant.breakoutId) return `breakout:${participant.breakoutId}`;
  return mode === "webinar" && participant.webinarBackstage
    ? "webinar:backstage"
    : "main";
}

export function participantMediaAllowed(
  participant: Pick<Participant, "mediaAllowed" | "enforcementPending">,
) {
  return participant.mediaAllowed !== false && !participant.enforcementPending;
}
