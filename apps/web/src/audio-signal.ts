import {
  RoomEvent,
  Track,
  createAudioAnalyser,
  type LocalAudioTrack,
  type LocalTrack,
} from "livekit-client";

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
  localParticipant: Speaker & {
    getTrackPublication?(
      source: Track.Source,
    ): { track?: LocalTrack } | undefined;
  };
  remoteParticipants: ReadonlyMap<string, Speaker>;
  on(event: RoomEvent, listener: () => void): unknown;
  off(event: RoomEvent, listener: () => void): unknown;
};

export function observeAudioSignals(
  room: AudioRoom,
  eligible: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
  changed: (signals: Map<string, AudioSignal>) => void,
  analyse = createAudioAnalyser,
) {
  let track: LocalAudioTrack | undefined;
  let streamTrack: MediaStreamTrack | undefined;
  let meter: ReturnType<typeof createAudioAnalyser> | undefined;
  let samples = new Float32Array(256);
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastVoice = -Infinity;
  let previous = new Map<string, AudioSignal>();
  const release = () => {
    void meter?.cleanup().catch(() => {});
    meter = undefined;
    lastVoice = -Infinity;
  };
  const update = (localOnly = false) => {
    const local = room.localParticipant;
    const publication = local.getTrackPublication?.(Track.Source.Microphone);
    const nextTrack =
      room.state === "connected" &&
      eligible.has(local.identity) &&
      allowed.has(local.identity) &&
      local.isMicrophoneEnabled &&
      publication?.track?.kind === Track.Kind.Audio &&
      !publication.track.isUpstreamPaused &&
      publication.track.mediaStreamTrack.enabled &&
      publication.track.mediaStreamTrack.readyState === "live"
        ? (publication.track as LocalAudioTrack)
        : undefined;
    // Device switches can replace the underlying stream without replacing the SDK track.
    if (nextTrack !== track || nextTrack?.mediaStreamTrack !== streamTrack) {
      release();
      track = nextTrack;
      streamTrack = track?.mediaStreamTrack;
      if (track) {
        // Keep watching through the stopped-stream gap during a device switch.
        timer ??= setInterval(() => update(true), 80);
        try {
          // Analyse the published track only; no device request or playback connection.
          meter = analyse(track, { fftSize: 256, smoothingTimeConstant: 0 });
          samples = new Float32Array(meter.analyser.fftSize);
        } catch {
          // Keep server speech updates when Web Audio is unavailable.
        }
      }
    }
    let localLevel: number | undefined;
    if (meter?.analyser.context.state === "running") {
      try {
        meter.analyser.getFloatTimeDomainData(samples);
        const rms = Math.sqrt(
          samples.reduce((sum, sample) => sum + sample * sample, 0) /
            samples.length,
        );
        if (rms >= 0.01) lastVoice = performance.now();
        localLevel = Math.round(Math.min(1, rms * 5) * 16) / 16;
      } catch {
        release();
      }
    }
    const entries = (
      localOnly ? [local] : [local, ...room.remoteParticipants.values()]
    )
      .filter((participant) => eligible.has(participant.identity))
      .map(
        (participant) =>
          [
            participant.identity,
            audioSignal({
              connected: room.state === "connected",
              allowed: allowed.has(participant.identity),
              microphoneEnabled:
                participant === local && publication?.track
                  ? Boolean(nextTrack)
                  : participant.isMicrophoneEnabled,
              isSpeaking:
                participant === local && localLevel !== undefined
                  ? performance.now() - lastVoice < 120
                  : participant.isSpeaking,
              audioLevel:
                participant === local && localLevel !== undefined
                  ? localLevel
                  : participant.audioLevel,
            }),
          ] as const,
      );
    if (
      (!localOnly && entries.length !== previous.size) ||
      entries.some(([id, value]) => {
        const before = previous.get(id);
        return (
          !before ||
          before.microphoneOn !== value.microphoneOn ||
          before.speaking !== value.speaking ||
          before.level !== value.level
        );
      })
    ) {
      const signals = new Map(localOnly ? previous : undefined);
      for (const [id, value] of entries) signals.set(id, value);
      previous = signals;
      changed(signals);
    }
  };
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
  const refresh = () => update();
  for (const event of events) room.on(event, refresh);
  refresh();
  return () => {
    clearInterval(timer);
    release();
    for (const event of events) room.off(event, refresh);
  };
}
