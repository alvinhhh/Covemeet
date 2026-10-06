import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import {
  RoomEvent,
  Track,
  type LocalTrack,
  type createAudioAnalyser,
} from "livekit-client";
import { participantMediaIdentity } from "../src/api.ts";
import {
  audioSignal,
  offscreenSpeakers,
  observeAudioSignals,
  type AudioSignal,
} from "../src/audio-signal.ts";

const active = {
  connected: true,
  allowed: true,
  microphoneEnabled: true,
  isSpeaking: true,
  audioLevel: 0.25,
};

test("speaking indication follows real SDK speech and bounded audio levels", () => {
  assert.deepEqual(audioSignal(active), {
    microphoneOn: true,
    speaking: true,
    level: 0.25,
    bars: 2,
  });
  assert.deepEqual(
    audioSignal({ ...active, isSpeaking: false, audioLevel: 0.03 }),
    {
      microphoneOn: true,
      speaking: false,
      level: 0,
      bars: 0,
    },
  );
  assert.equal(audioSignal({ ...active, isSpeaking: false }).speaking, true);
  assert.equal(audioSignal({ ...active, audioLevel: 0 }).bars, 0);
  assert.equal(audioSignal({ ...active, audioLevel: 9 }).bars, 4);
  for (const audioLevel of [-1, NaN, Infinity])
    assert.equal(audioSignal({ ...active, audioLevel }).bars, 0);
});

test("remote active speaker is named while the whiteboard hides camera tiles", () => {
  const local = {
    identity: "self",
    isMicrophoneEnabled: true,
    isSpeaking: false,
    audioLevel: 0,
  };
  const remote = { ...local, identity: "guest", isSpeaking: false };
  const room = Object.assign(new EventEmitter(), {
    state: "connected",
    localParticipant: local,
    remoteParticipants: new Map([[remote.identity, remote]]),
  });
  const people = [
    { id: "self", name: "Me", audioAllowed: true },
    { id: "guest", name: "Guest", audioAllowed: true },
  ];
  const eligible = new Set(["self", "guest"]);
  let signals = new Map<string, AudioSignal>();
  const stop = observeAudioSignals(room, eligible, eligible, (value) => {
    signals = value;
  });
  remote.isSpeaking = true;
  remote.audioLevel = 0.3;
  room.emit(RoomEvent.ActiveSpeakersChanged, [remote]);
  const visible = new Set(["self", "guest"]);
  assert.deepEqual(
    offscreenSpeakers(people, signals, eligible, visible, false, "self"),
    [],
  );
  assert.deepEqual(
    offscreenSpeakers(people, signals, eligible, visible, true, "self").map(
      (person) => person.name,
    ),
    ["Guest"],
  );
  stop();
});

test("mute, host block, and disconnect suppress stale local or remote speech signals", () => {
  for (const gate of ["connected", "allowed", "microphoneEnabled"] as const) {
    assert.deepEqual(audioSignal({ ...active, [gate]: false }), {
      microphoneOn: false,
      speaking: false,
      level: 0,
      bars: 0,
    });
  }
});

test("room events refresh ongoing speech, remove departed peers, and detach on room change", () => {
  const local = {
    identity: "self",
    isMicrophoneEnabled: true,
    isSpeaking: true,
    audioLevel: 0.1,
  };
  const remote = { ...local, identity: "guest" };
  const room = Object.assign(new EventEmitter(), {
    state: "connected",
    localParticipant: local,
    remoteParticipants: new Map([
      [remote.identity, remote],
      ["other-room", { ...remote, identity: "other-room" }],
    ]),
  });
  let signals = new Map<string, AudioSignal>();
  const eligible = new Set(["self", "guest"]);
  const stop = observeAudioSignals(room, eligible, eligible, (value) => {
    signals = value;
  });
  assert.deepEqual(signals.get("self"), signals.get("guest"));
  assert.equal(signals.has("other-room"), false);
  const before = signals.get("guest")!.bars;
  remote.audioLevel = 0.9; // isSpeaking remains true through this update.
  room.emit(RoomEvent.ActiveSpeakersChanged, [remote]);
  assert(signals.get("guest")!.bars > before);
  remote.isMicrophoneEnabled = false;
  room.emit(RoomEvent.TrackMuted);
  assert.equal(signals.get("guest")!.speaking, false);
  room.remoteParticipants.delete("guest");
  room.emit(RoomEvent.ParticipantDisconnected, remote);
  assert.equal(signals.has("guest"), false);
  room.state = "reconnecting";
  room.emit(RoomEvent.ConnectionStateChanged);
  assert.equal(signals.get("self")!.bars, 0);
  stop();
  assert.equal(room.eventNames().length, 0);
  const detached = signals;
  room.state = "connected";
  room.emit(RoomEvent.ActiveSpeakersChanged, [local]);
  assert.equal(signals, detached);
});

test("speaking follows only the current physical identity and its logical host permission", () => {
  const people = [
    { id: "host", mediaIdentity: "host-current", audioAllowed: true },
    { id: "guest", mediaIdentity: "guest-current", audioAllowed: false },
    { id: "legacy", audioAllowed: true },
  ];
  const speaker = (identity: string) => ({
    identity,
    isMicrophoneEnabled: true,
    isSpeaking: true,
    audioLevel: 0.5,
  });
  const room = Object.assign(new EventEmitter(), {
    state: "connected",
    localParticipant: speaker("host-current"),
    remoteParticipants: new Map(
      ["host", "host-retired", "guest-current", "guest-retired", "legacy"].map(
        (identity) => [identity, speaker(identity)],
      ),
    ),
  });
  let signals = new Map<string, AudioSignal>();
  const stop = observeAudioSignals(
    room,
    new Set(people.map(participantMediaIdentity)),
    new Set(
      people
        .filter((person) => person.audioAllowed)
        .map(participantMediaIdentity),
    ),
    (value) => {
      signals = value;
    },
  );
  assert.deepEqual(
    [...signals.keys()],
    ["host-current", "guest-current", "legacy"],
  );
  assert.equal(signals.get("host-current")!.speaking, true);
  assert.equal(signals.get("guest-current")!.speaking, false);
  assert.equal(signals.get("legacy")!.speaking, true);
  stop();
});

test("local microphone levels update without server events and release replaced or muted tracks", (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let now = 0;
  t.mock.method(performance, "now", () => now);
  let amplitude = 0.04;
  let stream = { enabled: true, readyState: "live" };
  const track = {
    kind: Track.Kind.Audio,
    isUpstreamPaused: false,
    get mediaStreamTrack() {
      return stream;
    },
  };
  const local = {
    identity: "self",
    isMicrophoneEnabled: true,
    isSpeaking: false,
    audioLevel: 0,
    getTrackPublication: () => ({ track: track as unknown as LocalTrack }),
  };
  const remote = {
    identity: "guest",
    isMicrophoneEnabled: true,
    isSpeaking: true,
    audioLevel: 0.3,
  };
  const room = Object.assign(new EventEmitter(), {
    state: "connected",
    localParticipant: local,
    remoteParticipants: new Map([[remote.identity, remote]]),
  });
  let created = 0,
    cleaned = 0,
    renders = 0;
  const analyse = (() => {
    created++;
    return {
      analyser: {
        fftSize: 256,
        context: { state: "running" },
        getFloatTimeDomainData: (samples: Float32Array) =>
          samples.fill(amplitude),
      },
      cleanup: async () => {
        cleaned++;
      },
    };
  }) as unknown as typeof createAudioAnalyser;
  let signals = new Map<string, AudioSignal>();
  const eligible = new Set(["self", "guest"]);
  const stop = observeAudioSignals(
    room,
    eligible,
    eligible,
    (next) => {
      renders++;
      signals = next;
    },
    analyse,
  );
  t.after(stop);
  const tick = () => {
    now += 80;
    t.mock.timers.tick(80);
  };
  assert.equal(signals.get("self")!.speaking, true);
  assert.equal(created, 1);
  const initialRenders = renders;
  tick();
  assert.equal(
    renders,
    initialRenders,
    "steady levels do not rerender the meeting",
  );
  local.isSpeaking = true; // Delayed server state must not hold the local indicator on.
  amplitude = 0;
  tick();
  tick();
  assert.equal(signals.get("self")!.speaking, false);
  assert.equal(signals.get("self")!.microphoneOn, true);
  assert.equal(signals.get("guest")!.speaking, true);
  stream.readyState = "ended";
  tick();
  assert.equal(signals.get("self")!.microphoneOn, false);
  assert.equal(cleaned, 1);
  stream = { enabled: true, readyState: "live" };
  amplitude = 0.04;
  tick();
  assert.equal(created, 2);
  assert.equal(cleaned, 1);
  assert.equal(signals.get("self")!.speaking, true);
  track.isUpstreamPaused = true;
  tick();
  assert.equal(signals.get("self")!.microphoneOn, false);
  assert.equal(cleaned, 2);
  track.isUpstreamPaused = false;
  tick();
  assert.equal(created, 3);
  local.isMicrophoneEnabled = false;
  room.emit(RoomEvent.TrackMuted);
  assert.equal(signals.get("self")!.speaking, false);
  assert.equal(cleaned, 3);
  stop();
  assert.equal(room.eventNames().length, 0);
  const stoppedRenders = renders;
  tick();
  assert.equal(renders, stoppedRenders);
});
