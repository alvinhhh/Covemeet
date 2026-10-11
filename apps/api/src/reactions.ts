import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  mediaIdentity,
  participantDataScope,
  participantRoom,
} from "./media-identity.js";
import { participantMediaAllowed } from "./meeting-limits.js";
import { HttpError } from "./security.js";
import type { Meeting, Participant } from "./store.js";

export const REACTION_TOPIC = "covemeet.reaction.v1";
export const REACTION_TTL_MS = 6000;
export const REACTION_COOLDOWN_MS = 2000;
export const reactionInput = z
  .object({
    kind: z.enum([
      "like",
      "applause",
      "love",
      "laugh",
      "surprised",
      "celebrate",
    ]),
    scope: z.string().max(80),
    mediaVersion: z.number().int().nonnegative(),
  })
  .strict();
export type Reaction = {
  id: string;
  participantId: string;
  mediaIdentity: string;
  mediaVersion: number;
  scope: string;
  kind: z.infer<typeof reactionInput>["kind"];
  createdAt: number;
  expiresAt: number;
};

export function reactionAllowed(m: Meeting, p: Participant, now = Date.now()) {
  return (
    p.transport !== "phone" &&
    participantMediaAllowed(m, p, now) &&
    (!p.breakoutId || m.breakouts.some((room) => room.id === p.breakoutId))
  );
}

export function currentReaction(m: Meeting, p: Participant, now = Date.now()) {
  const r = p.reaction;
  return r &&
    r.expiresAt > now &&
    reactionAllowed(m, p, now) &&
    r.participantId === p.id &&
    r.mediaIdentity === mediaIdentity(p) &&
    r.mediaVersion === p.mediaVersion &&
    r.scope === participantDataScope(m, p)
    ? r
    : undefined;
}

export function canReceiveReaction(
  m: Meeting,
  self: Participant,
  sender: Participant,
  now = Date.now(),
) {
  return (
    reactionAllowed(m, self, now) &&
    reactionAllowed(m, sender, now) &&
    participantDataScope(m, self) === participantDataScope(m, sender) &&
    // Match the room roster's audience privacy, including a current co-host.
    !(
      m.mode === "webinar" &&
      self.role === "viewer" &&
      !self.moderator &&
      sender.role === "viewer" &&
      sender.id !== self.id
    )
  );
}

export function roomReactions(m: Meeting, self: Participant, now = Date.now()) {
  return {
    serverTime: now,
    items: m.participants.flatMap((p) => {
      const reaction = currentReaction(m, p, now);
      return reaction && canReceiveReaction(m, self, p, now) ? [reaction] : [];
    }),
  };
}

export function acceptReaction(
  m: Meeting,
  p: Participant,
  input: z.infer<typeof reactionInput>,
  now = Date.now(),
) {
  if (!reactionAllowed(m, p, now))
    throw new HttpError(403, "Participant session is inactive");
  if (
    input.scope !== participantDataScope(m, p) ||
    input.mediaVersion !== p.mediaVersion
  )
    throw new HttpError(409, "Room access changed. Try again.");
  if ((p.reactionNotBefore ?? 0) > now)
    throw new HttpError(429, "Wait a moment before sending another reaction.");
  p.reactionNotBefore = now + REACTION_COOLDOWN_MS;
  p.reaction = {
    id: randomUUID(),
    participantId: p.id,
    mediaIdentity: mediaIdentity(p),
    mediaVersion: p.mediaVersion,
    scope: input.scope,
    kind: input.kind,
    createdAt: now,
    expiresAt: now + REACTION_TTL_MS,
  };
  return { reaction: p.reaction, serverTime: now, revision: m.revision + 1 };
}

export function clearStaleReactions(m: Meeting, now = Date.now()) {
  let changed = false;
  for (const p of m.participants) {
    if (p.reaction && !currentReaction(m, p, now)) {
      delete p.reaction;
      changed = true;
    }
    // Keep the cooldown through a room move or moderation fence.
    if (p.reactionNotBefore !== undefined && p.reactionNotBefore <= now) {
      delete p.reactionNotBefore;
      changed = true;
    }
  }
  return changed;
}

export function reactionDelivery(m: Meeting, id: string, now = Date.now()) {
  const sender = m.participants.find((p) => p.reaction?.id === id);
  const reaction = sender && currentReaction(m, sender, now);
  if (!sender || !reaction) return;
  const room = participantRoom(m, sender);
  const destinationIdentities = [
    ...new Set(
      m.participants
        .filter(
          (p) =>
            canReceiveReaction(m, p, sender, now) &&
            participantRoom(m, p) === room,
        )
        .map(mediaIdentity),
    ),
  ];
  // An empty SDK destination list means broadcast. Never issue that request.
  if (!destinationIdentities.length) return;
  return {
    room,
    destinationIdentities,
    packet: { version: 1, code: m.code, reaction, serverTime: now },
  };
}
