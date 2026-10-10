import assert from "node:assert/strict";
import test from "node:test";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  Room,
  RoomEvent,
  Track,
  type LocalTrackPublication,
} from "livekit-client";
import { DeviceCheck, deviceError } from "../src/device-check.tsx";
import {
  captureDevice,
  DeviceSelect,
  observeCallDevice,
  switchCallDevice,
} from "../src/device-select.tsx";

const device = (kind: MediaDeviceKind, deviceId: string, label = "") =>
  ({ kind, deviceId, label, groupId: "", toJSON() {} }) as MediaDeviceInfo;

test("prejoin and waiting previews retain the meeting's chosen inputs across remounts", () => {
  const inputDevices = { cameraId: "camera-b", microphoneId: "microphone-b" };
  const props = { inputDevices, setInputDevices: () => {} };
  for (let mount = 0; mount < 2; mount++) {
    const markup = renderToStaticMarkup(createElement(DeviceCheck, props));
    assert.match(markup, /value="camera-b" selected=""/);
    assert.match(markup, /value="microphone-b" selected=""/);
    assert.match(markup, /Camera off/);
    assert.match(markup, /Microphone off/);
  }
  assert.deepEqual(captureDevice(inputDevices.cameraId), {
    deviceId: { exact: "camera-b" },
  });
  assert.deepEqual(captureDevice(inputDevices.microphoneId), {
    deviceId: { exact: "microphone-b" },
  });
  assert.deepEqual(captureDevice(""), { deviceId: "" });
});

test("device selector is labelled, filters inputs and preserves an unavailable selection", () => {
  const props = {
    kind: "audioinput" as const,
    devices: [
      device("audioinput", "mic-a", "Desk microphone"),
      device("audioinput", "mic-b"),
      device("videoinput", "camera"),
      device("audiooutput", "speaker"),
    ],
    value: "missing-mic",
    disabled: true,
    onSelect: (_id: string) => {},
  };
  const markup = renderToStaticMarkup(createElement(DeviceSelect, props));
  assert.match(markup, /aria-label="Microphone" disabled=""/);
  assert.match(markup, /value="missing-mic" selected="">Selected microphone/);
  assert.match(markup, /Desk microphone/);
  assert.match(markup, /Microphone 2/);
  assert.doesNotMatch(markup, /value="camera"|value="speaker"/);
  const selected: string[] = [];
  const element = DeviceSelect({
    ...props,
    disabled: false,
    onSelect: (id) => selected.push(id),
  });
  const select = element.props.children[1] as ReactElement<{
    onChange: (event: { target: { value: string } }) => void;
  }>;
  select.props.onChange({ target: { value: "mic-b" } });
  select.props.onChange({ target: { value: "" } });
  assert.deepEqual(selected, ["mic-b", ""]);
});

test("choosing call inputs while devices are off changes SDK defaults without starting capture", async () => {
  const room = new Room();
  room.localParticipant.setMicrophoneEnabled = async () => {
    throw new Error("must not enable microphone");
  };
  room.localParticipant.setCameraEnabled = async () => {
    throw new Error("must not enable camera");
  };
  await switchCallDevice(room, "audioinput", "mic-b");
  await switchCallDevice(room, "videoinput", "camera-b");
  assert.deepEqual(room.options.audioCaptureDefaults?.deviceId, {
    exact: "mic-b",
  });
  assert.deepEqual(room.options.videoCaptureDefaults?.deviceId, {
    exact: "camera-b",
  });
  assert.equal(room.getActiveDevice("audioinput"), "mic-b");
  assert.equal(room.getActiveDevice("videoinput"), "camera-b");
  assert.equal(room.localParticipant.trackPublications.size, 0);
  await switchCallDevice(room, "videoinput", "");
  assert.equal(room.options.videoCaptureDefaults?.deviceId, "");
});

test("live switch updates the matching SDK input and leaves screen sharing untouched", async () => {
  const room = new Room();
  const changes: [string, ConstrainDOMString][] = [];
  function publication(source: Track.Source, name: string, isMuted: boolean) {
    const track = {
      isMuted,
      setDeviceId: async (id: ConstrainDOMString) => {
        changes.push([name, id]);
        return true;
      },
    };
    return {
      source,
      track,
      audioTrack: track,
      videoTrack: track,
    } as unknown as LocalTrackPublication;
  }
  room.localParticipant.audioTrackPublications.set(
    "mic",
    publication(Track.Source.Microphone, "mic", true),
  );
  room.localParticipant.videoTrackPublications.set(
    "camera",
    publication(Track.Source.Camera, "camera", false),
  );
  room.localParticipant.videoTrackPublications.set(
    "screen",
    publication(Track.Source.ScreenShare, "screen", false),
  );
  await switchCallDevice(room, "audioinput", "new-mic");
  await switchCallDevice(room, "videoinput", "new-camera");
  assert.deepEqual(changes, [
    ["mic", { exact: "new-mic" }],
    ["camera", { exact: "new-camera" }],
  ]);
  assert.equal(
    room.localParticipant.audioTrackPublications.get("mic")?.track?.isMuted,
    true,
  );
});

test("failed explicit switches surface recovery errors; default selection permits a resolved physical ID", async () => {
  const room = { switchActiveDevice: async () => false };
  await assert.rejects(switchCallDevice(room, "videoinput", "missing"), {
    name: "OverconstrainedError",
  });
  await switchCallDevice(room, "videoinput", "");
  const denied = new DOMException("Private device details", "NotAllowedError");
  await assert.rejects(
    switchCallDevice(
      {
        switchActiveDevice: async () => {
          throw denied;
        },
      },
      "audioinput",
      "mic",
    ),
    denied,
  );
  assert.match(deviceError(denied, "audio"), /Allow access in your browser/);
  assert.doesNotMatch(deviceError(denied, "audio"), /Private device/);
});

test("SDK device changes update the matching selection after unplug/fallback and detach on room change", () => {
  const room = new Room();
  const changes: string[] = [];
  const stop = observeCallDevice(room, "audioinput", (id) => changes.push(id));
  assert.deepEqual(changes, [], "mount must not overwrite a prejoin selection");
  room.emit(RoomEvent.ActiveDeviceChanged, "videoinput", "camera-b");
  room.emit(RoomEvent.ActiveDeviceChanged, "audioinput", "replacement-mic");
  room.emit(RoomEvent.ActiveDeviceChanged, "audioinput", "default");
  assert.deepEqual(changes, ["replacement-mic", ""]);
  stop();
  room.emit(RoomEvent.ActiveDeviceChanged, "audioinput", "old-room-mic");
  assert.deepEqual(changes, ["replacement-mic", ""]);
});
