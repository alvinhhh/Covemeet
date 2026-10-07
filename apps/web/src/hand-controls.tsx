import type { MeetingState, Participant } from "./api";
import { Icon } from "./icons";

export type HandUpdate = { handRaised: boolean; revision: number };

export function newestMeetingState(
  current: MeetingState | undefined,
  next: MeetingState,
) {
  return current &&
    current.meeting.code === next.meeting.code &&
    current.me.id === next.me.id &&
    current.revision > next.revision
    ? current
    : next;
}

export function handRaised(participant: Participant) {
  return participant.handRaised ?? participant.phone?.handRaised ?? false;
}

export function admittedWithHandsFirst(participants: Participant[]) {
  return participants
    .filter((participant) => participant.status === "admitted")
    .sort((a, b) => Number(handRaised(b)) - Number(handRaised(a)));
}

export function applyHandUpdate(
  state: MeetingState,
  source: MeetingState,
  id: string,
  update: HandUpdate,
) {
  if (
    state.meeting.code !== source.meeting.code ||
    state.me.id !== source.me.id ||
    update.revision < state.revision
  )
    return state;
  const change = (participant: Participant) =>
    participant.id === id
      ? { ...participant, handRaised: update.handRaised }
      : participant;
  return {
    ...state,
    revision: update.revision,
    me: change(state.me),
    participants: state.participants.map(change),
  };
}

export function HandControl({
  me,
  ended,
  busy,
  pending,
  onChange,
}: {
  me: Participant;
  ended: boolean;
  busy: boolean;
  pending: boolean;
  onChange: (raised: boolean) => void;
}) {
  const raised = handRaised(me);
  const label = raised ? "Lower hand" : "Raise hand";
  return (
    <button
      type="button"
      className={`button hand-control${raised ? " selected" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={raised}
      aria-busy={pending}
      disabled={
        busy ||
        pending ||
        ended ||
        me.status !== "admitted" ||
        !!me.enforcementPending
      }
      onClick={() => onChange(!raised)}
    >
      <Icon name="hand" />
      <span>{pending ? (raised ? "Lowering…" : "Raising…") : label}</span>
    </button>
  );
}
