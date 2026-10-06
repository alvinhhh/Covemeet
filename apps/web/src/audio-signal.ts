import { RoomEvent } from "livekit-client";

export type AudioSignal = {
  microphoneOn: boolean;
  speaking: boolean;
  level: number;
  bars: number;
};

export function offscreenSpeakers<
  T extends { id: string; mediaIdentity?: string; audioAllowed: boolean },
>(
  participants: T[],
  signals: ReadonlyMap<string, AudioSignal>,
  eligible: ReadonlySet<string>,
  visibleIds: ReadonlySet<string>,
  boardOpen: boolean,
  selfId: string,
): T[] {
  return participants.filter((participant) => {
    const identity = participant.mediaIdentity ?? participant.id;
    return (
      participant.id !== selfId &&
      eligible.has(identity) &&
      participant.audioAllowed &&
      signals.get(identity)?.speaking &&
      (boardOpen || !visibleIds.has(identity))
    );
  });
}

// SDK speech state can briefly outlive a mute or reconnect. Never display that
// stale signal when the microphone, room connection or host permission is off.
export function audioSignal(input: {
  connected: boolean;
  allowed: boolean;
  microphoneEnabled: boolean;
  isSpeaking: boolean;
  audioLevel: number;
}): AudioSignal {
  const microphoneOn =
    input.connected && input.allowed && input.microphoneEnabled;
  const measuredLevel = Number.isFinite(input.audioLevel)
    ? Math.min(1, Math.max(0, input.audioLevel))
    : 0;
  const speaking = microphoneOn && (input.isSpeaking || measuredLevel >= 0.08);
  const level = speaking ? measuredLevel : 0;
  return {
    microphoneOn,
    speaking,
    level,
    bars: Math.ceil(Math.sqrt(level) * 4),
  };
}

type Speaker = {
  identity: string;
  isMicrophoneEnabled: boolean;
  isSpeaking: boolean;
  audioLevel: number;
};
type AudioRoom = {
  state: string;
  localParticipant: Speaker;
  remoteParticipants: ReadonlyMap<string, Speaker>;
  on(event: RoomEvent, listener: () => void): unknown;
  off(event: RoomEvent, listener: () => void): unknown;
};

export function observeAudioSignals(
  room: AudioRoom,
  eligible: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  changed: (signals: Map<string, AudioSignal>) => void,
) {
  const update = () =>
    changed(
      new Map(
        [room.localParticipant, ...room.remoteParticipants.values()]
          .filter((participant) => eligible.has(participant.identity))
          .map((participant) => [
            participant.identity,
            audioSignal({
              connected: room.state === "connected",
              allowed: allowed.has(participant.identity),
              microphoneEnabled: participant.isMicrophoneEnabled,
              isSpeaking: participant.isSpeaking,
              audioLevel: participant.audioLevel,
            }),
          ]),
      ),
    );
  // This event includes level changes during an utterance, not just the start
  // and end of speech. The other events clear stale SDK state immediately.
  const events = [
    RoomEvent.ActiveSpeakersChanged,
    RoomEvent.ConnectionStateChanged,
    RoomEvent.TrackMuted,
    RoomEvent.TrackUnmuted,
    RoomEvent.TrackPublished,
    RoomEvent.TrackUnpublished,
    RoomEvent.LocalTrackPublished,
    RoomEvent.LocalTrackUnpublished,
    RoomEvent.ParticipantConnected,
    RoomEvent.ParticipantDisconnected,
  ];
  for (const event of events) room.on(event, update);
  update();
  return () => {
    for (const event of events) room.off(event, update);
  };
}
