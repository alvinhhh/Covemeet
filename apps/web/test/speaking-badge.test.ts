import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RoomEvent } from "livekit-client";
import { observeAudioSignals, type AudioSignal } from "../src/audio-signal.js";
import { SpeakingBadge } from "../src/speaking-badge.js";

test("an active speaker event shows a cue on tiles, roster and dock", () => {
  const local = {
    identity: "self",
    isMicrophoneEnabled: true,
    isSpeaking: false,
    audioLevel: 0.01,
  };
  const room = Object.assign(new EventEmitter(), {
    state: "connected",
    localParticipant: local,
    remoteParticipants: new Map(),
  });
  let signals = new Map<string, AudioSignal>();
  const stop = observeAudioSignals(
    room,
    new Set(["self"]),
    new Set(["self"]),
    (next) => {
      signals = next;
    },
  );
  const cue = (surface: "tile" | "list" | "dock") =>
    renderToStaticMarkup(
      createElement(SpeakingBadge, { surface, signal: signals.get("self") }),
    );
  assert.equal(cue("tile"), "");
  local.audioLevel = 0.2;
  room.emit(RoomEvent.ActiveSpeakersChanged, [local]);
  for (const surface of ["tile", "list", "dock"] as const)
    assert.match(
      cue(surface),
      new RegExp(`speaking-badge ${surface}[^>]*>Speaking`),
    );
  local.audioLevel = 0.01;
  room.emit(RoomEvent.ActiveSpeakersChanged, []);
  assert.equal(cue("tile"), "");
  assert.equal(cue("list"), "");
  stop();
});
