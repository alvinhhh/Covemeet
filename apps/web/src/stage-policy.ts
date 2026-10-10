import { participantMediaIdentity } from "./api";

type StageMember = {
  id: string;
  mediaIdentity?: string;
  role: "host" | "participant" | "viewer";
  status: string;
  breakoutId: string | null;
  webinarBackstage?: boolean;
  transport?: "browser" | "phone";
};
export type StageCandidate = {
  key: string;
  mediaIdentity: string;
  source: "camera" | "screen_share";
};

export const VIDEO_TILE_LIMIT = 16;
const PINNED_SCREEN_LIMIT = 2;
export type StageView = {
  pinnedParticipantId?: string | null;
  hideSelfView?: boolean;
};

export function selectStage<T extends StageCandidate>(
  candidates: T[],
  members: StageMember[],
  context: {
    localId: string;
    mode: "meeting" | "webinar";
    breakoutId: string | null;
    webinarBackstage?: boolean;
  },
  requestedPage: number,
  view: StageView = {},
) {
  const eligible = members.filter(
    (member) =>
      member.status === "admitted" &&
      member.breakoutId === context.breakoutId &&
      (context.mode !== "webinar" ||
        context.webinarBackstage === undefined ||
        (member.webinarBackstage === true) ===
          (context.webinarBackstage === true)) &&
      (context.mode !== "webinar" || member.role !== "viewer"),
  );
  const roles = new Map(
    eligible.map((member) => [participantMediaIdentity(member), member.role]),
  );
  const phoneIds = new Set(
    eligible
      .filter((member) => member.transport === "phone")
      .map(participantMediaIdentity),
  );
  const localMember = eligible.find((member) => member.id === context.localId);
  const localIdentity = localMember && participantMediaIdentity(localMember);
  const pinnedMember = eligible.find(
    (member) => member.id === view.pinnedParticipantId,
  );
  const pinnedIdentity = pinnedMember && participantMediaIdentity(pinnedMember);
  const tracks = [
    ...new Map(
      candidates
        .filter(
          (track) =>
            roles.has(track.mediaIdentity) &&
            !(track.source === "camera" && phoneIds.has(track.mediaIdentity)) &&
            !(
              view.hideSelfView &&
              track.source === "camera" &&
              track.mediaIdentity === localIdentity
            ),
        )
        .map((track) => [track.key, track]),
    ).values(),
  ];
  tracks.sort((a, b) => {
    const priority = (track: T) =>
      (track.source === "screen_share" ? 0 : 2) +
      (roles.get(track.mediaIdentity) === "host" ? 0 : 1);
    return priority(a) - priority(b) || a.key.localeCompare(b.key);
  });
  const pinned = tracks
    .filter((track) => track.source === "screen_share")
    .slice(0, PINNED_SCREEN_LIMIT);
  const pinnedCamera = tracks.find(
    (track) =>
      track.mediaIdentity === pinnedIdentity && track.source === "camera",
  );
  if (pinnedCamera) pinned.push(pinnedCamera);
  const selfCamera = tracks.find(
    (track) =>
      track.mediaIdentity === localIdentity && track.source === "camera",
  );
  if (selfCamera && selfCamera !== pinnedCamera) pinned.push(selfCamera);
  const pinnedKeys = new Set(pinned.map((track) => track.key));
  const remaining = tracks.filter((track) => !pinnedKeys.has(track.key));
  const pageSize = VIDEO_TILE_LIMIT - pinned.length;
  const pageCount = Math.max(1, Math.ceil(remaining.length / pageSize));
  const page = Math.min(
    Math.max(0, Math.floor(requestedPage) || 0),
    pageCount - 1,
  );
  return {
    visible: [
      ...pinned,
      ...remaining.slice(page * pageSize, (page + 1) * pageSize),
    ],
    eligibleIds: new Set(roles.keys()),
    pinnedParticipantId: pinnedCamera ? pinnedMember!.id : null,
    selfViewAvailable: !!localMember && localMember.transport !== "phone",
    page,
    pageCount,
    total: tracks.length,
  };
}
