import type { Participant } from "./api";

export type CameraIntent = {
  participantId: string;
  scope: string;
  mediaVersion: number;
  cameraConsentVersion: number;
  attempt: number;
  allowed: boolean;
  enabled: boolean;
  generation: number;
};

export function cameraIntentFor(
  participant: Pick<
    Participant,
    | "id"
    | "role"
    | "status"
    | "videoAllowed"
    | "mediaVersion"
    | "cameraConsentVersion"
  >,
  scope: string,
  attempt: number,
  previous?: CameraIntent,
): CameraIntent {
  const allowed =
    participant.role !== "viewer" &&
    participant.status === "admitted" &&
    participant.videoAllowed;
  const cameraConsentVersion = participant.cameraConsentVersion ?? 0;
  if (
    previous?.participantId === participant.id &&
    previous.scope === scope &&
    previous.mediaVersion === participant.mediaVersion &&
    previous.cameraConsentVersion === cameraConsentVersion &&
    previous.attempt === attempt &&
    previous.allowed === allowed
  )
    return previous;
  return {
    participantId: participant.id,
    scope,
    mediaVersion: participant.mediaVersion,
    cameraConsentVersion,
    attempt,
    allowed,
    generation: (previous?.generation ?? 0) + 1,
    enabled: !!(
      allowed &&
      previous?.enabled &&
      previous.participantId === participant.id &&
      previous.cameraConsentVersion === cameraConsentVersion &&
      previous.scope === scope
    ),
  };
}

export function rememberCameraChoice(
  current: CameraIntent,
  source: Omit<CameraIntent, "enabled">,
  enabled: boolean,
  userInitiated: boolean,
): CameraIntent {
  if (
    !userInitiated ||
    !current.allowed ||
    current.participantId !== source.participantId ||
    current.scope !== source.scope ||
    current.mediaVersion !== source.mediaVersion ||
    current.cameraConsentVersion !== source.cameraConsentVersion ||
    current.attempt !== source.attempt ||
    current.generation !== source.generation ||
    current.allowed !== source.allowed ||
    current.enabled === enabled
  )
    return current;
  return { ...current, enabled };
}
