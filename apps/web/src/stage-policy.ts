type StageMember = {
  id: string;
  role: "host" | "participant" | "viewer";
  status: string;
  breakoutId: string | null;
  transport?: "browser" | "phone";
};
export type StageCandidate = {
  key: string;
  participantId: string;
  source: "camera" | "screen_share";
};

export const VIDEO_TILE_LIMIT = 16;
const PINNED_SCREEN_LIMIT = 2;

export function selectStage<T extends StageCandidate>(
  candidates: T[],
  members: StageMember[],
  context: {
    localId: string;
    mode: "meeting" | "webinar";
    breakoutId: string | null;
  },
  requestedPage: number,
) {
  const eligible = members.filter(
    (member) =>
      member.status === "admitted" &&
      member.breakoutId === context.breakoutId &&
      (context.mode !== "webinar" || member.role !== "viewer"),
  );
  const roles = new Map(eligible.map((member) => [member.id, member.role]));
  const phoneIds = new Set(
    eligible
      .filter((member) => member.transport === "phone")
      .map((member) => member.id),
  );
  const tracks = [
    ...new Map(
      candidates
        .filter(
          (track) =>
            roles.has(track.participantId) &&
            !(track.source === "camera" && phoneIds.has(track.participantId)),
        )
        .map((track) => [track.key, track]),
    ).values(),
  ];
  tracks.sort((a, b) => {
    const priority = (track: T) =>
      (track.source === "screen_share" ? 0 : 2) +
      (roles.get(track.participantId) === "host" ? 0 : 1);
    return priority(a) - priority(b) || a.key.localeCompare(b.key);
  });
  const pinned = tracks
    .filter((track) => track.source === "screen_share")
    .slice(0, PINNED_SCREEN_LIMIT);
  const selfCamera = tracks.find(
    (track) =>
      track.participantId === context.localId && track.source === "camera",
  );
  if (selfCamera) pinned.push(selfCamera);
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
    page,
    pageCount,
    total: tracks.length,
  };
}
