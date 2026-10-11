import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TrackToggle, useLocalParticipant } from "@livekit/components-react";
import { Track } from "livekit-client";
import { messageOf, type Participant } from "./api";
import { Icon } from "./icons";
import { deviceError } from "./device-check";
import { CallSpeakerSelect, audioOutputError } from "./audio-output";
import {
  CallDeviceSelect,
  captureDevice,
  type InputDeviceProps,
} from "./device-select";

export function MediaControls({
  me,
  inputDevices,
  setInputDevices,
  cameraChanged,
  deviceTarget,
}: {
  me: Participant;
  deviceTarget: HTMLDivElement | null;
  cameraChanged: (enabled: boolean, userInitiated: boolean) => void;
} & InputDeviceProps) {
  const {
    localParticipant,
    isMicrophoneEnabled,
    isCameraEnabled,
    isScreenShareEnabled,
  } = useLocalParticipant();
  const [error, setError] = useState("");
  const audioAllowed = me.role !== "viewer" && me.audioAllowed;
  const videoAllowed = me.role !== "viewer" && me.videoAllowed;
  const screenShareAllowed = me.screenShareAllowed;
  const microphoneAction = !audioAllowed
    ? "Microphone blocked by host"
    : isMicrophoneEnabled
      ? "Mute microphone"
      : "Unmute microphone";
  const cameraAction = !videoAllowed
    ? "Camera blocked by host"
    : isCameraEnabled
      ? "Turn camera off"
      : "Turn camera on";
  const shareAction = !screenShareAllowed
    ? "Screen sharing blocked by host"
    : isScreenShareEnabled
      ? "Stop sharing"
      : "Share screen";
  useEffect(() => {
    if (!audioAllowed)
      void localParticipant
        .setMicrophoneEnabled(false)
        .catch((e) => setError(messageOf(e)));
  }, [localParticipant, audioAllowed]);
  useEffect(() => {
    if (!videoAllowed)
      void localParticipant
        .setCameraEnabled(false)
        .catch((e) => setError(messageOf(e)));
  }, [localParticipant, videoAllowed]);
  useEffect(() => {
    if (!screenShareAllowed)
      void localParticipant
        .setScreenShareEnabled(false)
        .catch((e) => setError(messageOf(e)));
  }, [localParticipant, screenShareAllowed]);
  return (
    <>
      {error && (
        <span className="device-error" role="alert">
          {error}
        </span>
      )}
      <fieldset className="media-control-guard" disabled={!audioAllowed}>
        <TrackToggle
          className="button media-toggle"
          source={Track.Source.Microphone}
          captureOptions={captureDevice(inputDevices.microphoneId)}
          showIcon={false}
          onDeviceError={(e) => setError(e.message)}
          title={microphoneAction}
          aria-label={microphoneAction}
        >
          <Icon
            name={audioAllowed && isMicrophoneEnabled ? "mic" : "mic-off"}
          />
          <span>
            {!audioAllowed
              ? "Mic blocked"
              : isMicrophoneEnabled
                ? "Mute"
                : "Unmute"}
          </span>
        </TrackToggle>
      </fieldset>
      <fieldset className="media-control-guard" disabled={!videoAllowed}>
        <TrackToggle
          className="button media-toggle"
          source={Track.Source.Camera}
          captureOptions={captureDevice(inputDevices.cameraId)}
          onChange={cameraChanged}
          onClick={() => {
            if (isCameraEnabled) cameraChanged(false, true);
          }}
          showIcon={false}
          onDeviceError={(e) => setError(e.message)}
          title={cameraAction}
          aria-label={cameraAction}
        >
          <Icon
            name={videoAllowed && isCameraEnabled ? "video" : "camera-off"}
          />
          <span>
            {!videoAllowed
              ? "Camera blocked"
              : isCameraEnabled
                ? "Stop video"
                : "Start video"}
          </span>
        </TrackToggle>
      </fieldset>
      <fieldset className="media-control-guard" disabled={!screenShareAllowed}>
        <TrackToggle
          className="button media-toggle"
          source={Track.Source.ScreenShare}
          showIcon={false}
          onDeviceError={(e) => setError(e.message)}
          title={shareAction}
          aria-label={shareAction}
        >
          <Icon name="screen" />
          <span>{isScreenShareEnabled ? "Stop sharing" : "Share screen"}</span>
        </TrackToggle>
      </fieldset>
      {deviceTarget &&
        createPortal(
          <>
            <CallDeviceSelect
              kind="audioinput"
              value={inputDevices.microphoneId}
              disabled={!audioAllowed}
              onSelect={(microphoneId) => {
                setInputDevices((current) => ({ ...current, microphoneId }));
                setError("");
              }}
              onError={(error) => setError(deviceError(error, "audio"))}
            />
            <CallSpeakerSelect
              value={inputDevices.speakerId ?? ""}
              onSelect={(speakerId) => {
                setInputDevices((current) => ({ ...current, speakerId }));
                setError("");
              }}
              onError={() => setError(audioOutputError)}
            />
            <CallDeviceSelect
              kind="videoinput"
              value={inputDevices.cameraId}
              disabled={!videoAllowed}
              onSelect={(cameraId) => {
                setInputDevices((current) => ({ ...current, cameraId }));
                setError("");
              }}
              onError={(error) => setError(deviceError(error, "video"))}
            />
          </>,
          deviceTarget,
        )}
    </>
  );
}
