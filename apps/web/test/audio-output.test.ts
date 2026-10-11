import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  RemoteAudioTrack,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  type RemoteTrackPublication,
} from "livekit-client";
import {
  CallSpeakerSelect,
  canSelectAudioOutput,
  restoreAudioOutput,
} from "../src/audio-output.tsx";
import {
  DeviceSelect,
  observeCallDevice,
  switchCallDevice,
} from "../src/device-select.tsx";

test("speaker selector filters outputs and unsupported browsers retain system playback", () => {
  const markup = renderToStaticMarkup(
    createElement(DeviceSelect, {
      kind: "audiooutput",
      value: "headphones",
      disabled: false,
      onSelect() {},
      devices: [
        { kind: "audiooutput", deviceId: "headphones", label: "Headphones" },
        { kind: "audioinput", deviceId: "microphone", label: "Microphone" },
      ] as MediaDeviceInfo[],
    }),
  );
  assert.match(markup, /aria-label="Speaker"/);
  assert.match(markup, /value="headphones" selected="">Headphones/);
  assert.doesNotMatch(markup, /Microphone/);
  assert.equal(canSelectAudioOutput(), false);
  const fallback = renderToStaticMarkup(
    createElement(CallSpeakerSelect, {
      value: "headphones",
      onSelect() {
        assert.fail("must not change output");
      },
      onError() {
        assert.fail("unsupported output is not a call error");
      },
    }),
  );
  assert.match(fallback, /aria-label="Speaker" disabled=""/);
  assert.match(fallback, /Choose speakers in system sound settings/);
});

test("SDK speaker routing reaches microphone and screen audio without capture, unmute or volume changes", async () => {
  const room = new Room();
  const remote = new RemoteParticipant(undefined!, "remote", "guest");
  const routed: string[] = [];
  const elements: {
    muted: boolean;
    volume: number;
    setSinkId: (id: string) => Promise<void>;
  }[] = [];
  const tracks: RemoteAudioTrack[] = [];
  for (const source of [
    Track.Source.Microphone,
    Track.Source.ScreenShareAudio,
  ]) {
    const track = new RemoteAudioTrack(
      { id: source, enabled: false } as MediaStreamTrack,
      source,
      {} as RTCRtpReceiver,
    );
    track.source = source;
    const element = {
      muted: true,
      volume: 0,
      setSinkId: async (id: string) => {
        routed.push(`${source}:${id}`);
      },
    };
    elements.push(element);
    tracks.push(track);
    track.attachedElements.push(element as HTMLMediaElement);
    remote.audioTrackPublications.set(source, {
      track,
    } as RemoteTrackPublication);
  }
  room.remoteParticipants.set(remote.identity, remote);
  const forbidden = async () => {
    throw new Error("must not capture or enable playback");
  };
  room.startAudio = forbidden;
  room.localParticipant.setMicrophoneEnabled = forbidden;
  room.localParticipant.setCameraEnabled = forbidden;
  room.localParticipant.setScreenShareEnabled = forbidden;
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: () => ({ setSinkId: forbidden }) },
  });
  try {
    assert.equal(canSelectAudioOutput(), true);
    await restoreAudioOutput(room, "headphones");
    assert.deepEqual(routed, [
      "microphone:headphones",
      "screen_share_audio:headphones",
    ]);
    assert.equal(room.getActiveDevice("audiooutput"), "headphones");
    assert.equal(
      room.options.audioOutput?.deviceId,
      "headphones",
      "future remote tracks inherit the selected output",
    );
    await restoreAudioOutput(room, "headphones");
    assert.equal(
      routed.length,
      2,
      "an already applied selection is not switched again",
    );
    await switchCallDevice(room, "audiooutput", "");
    assert.deepEqual(routed.slice(2), ["microphone:", "screen_share_audio:"]);
    assert.ok(
      elements.every((element) => element.muted && element.volume === 0),
    );
    assert.ok(tracks.every((track) => !track.mediaStreamTrack.enabled));
    assert.equal(room.localParticipant.trackPublications.size, 0);
  } finally {
    if (previous) Object.defineProperty(globalThis, "document", previous);
    else Reflect.deleteProperty(globalThis, "document");
  }
});

test("output restoration preserves defaults and surfaces denied or missing destinations", async () => {
  for (const active of [undefined, "", "default"]) {
    await restoreAudioOutput(
      {
        getActiveDevice: () => active,
        switchActiveDevice: async () => {
          assert.fail("default output needs no switch");
        },
      },
      "",
    );
  }
  for (const name of ["NotAllowedError", "NotFoundError"]) {
    const error = new DOMException("Device denied", name);
    await assert.rejects(
      restoreAudioOutput(
        {
          getActiveDevice: () => undefined,
          switchActiveDevice: async () => {
            throw error;
          },
        },
        "headphones",
      ),
      error,
    );
  }
});

test("a new speaker choice waits for pending restoration, including failed restoration", async () => {
  for (const fails of [false, true]) {
    const calls: string[] = [];
    let complete!: () => void;
    let active: string | undefined;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const room = {
      getActiveDevice: () => active,
      switchActiveDevice: async (_kind: MediaDeviceKind, id: string) => {
        calls.push(id);
        if (id === "saved-speaker") {
          await pending;
          if (fails) throw new DOMException("Unavailable", "NotFoundError");
        }
        active = id;
        return true;
      },
    };
    const restored = restoreAudioOutput(room, "saved-speaker").catch(() => {});
    const chosen = switchCallDevice(room, "audiooutput", "new-speaker");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["saved-speaker"]);
    complete();
    await Promise.all([restored, chosen]);
    assert.deepEqual(calls, ["saved-speaker", "new-speaker"]);
    assert.equal(active, "new-speaker");
  }
});

test("SDK output fallback updates only speakers and removes its listener on unmount", () => {
  const room = new Room();
  const changes: string[] = [];
  const stop = observeCallDevice(room, "audiooutput", (id) => changes.push(id));
  room.emit(RoomEvent.ActiveDeviceChanged, "audioinput", "microphone");
  room.emit(RoomEvent.ActiveDeviceChanged, "audiooutput", "headphones");
  room.emit(RoomEvent.ActiveDeviceChanged, "audiooutput", "default");
  stop();
  room.emit(RoomEvent.ActiveDeviceChanged, "audiooutput", "old-room");
  assert.deepEqual(changes, ["headphones", ""]);
});
