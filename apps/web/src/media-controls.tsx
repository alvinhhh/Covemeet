import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { TrackToggle, useLocalParticipant } from "@livekit/components-react";
import { Track, type LocalVideoTrack } from "livekit-client";
import { BackgroundControls } from "./background-controls";
import {
  cameraOptions,
  changeBackground,
  stopBackgroundCamera,
} from "./background";
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
  const cameraOwner = useMemo(
    () => new AbortController(),
    [localParticipant, videoAllowed],
  );
  const [cameraBusy, setCameraBusy] = useState(false);
  const owner = useRef({ mounted: true, videoAllowed });
  owner.current.videoAllowed = videoAllowed;
  useEffect(() => {
    owner.current.mounted = true;
    return () => {
      owner.current.mounted = false;
      cameraOwner.abort();
    };
  }, [cameraOwner]);
  useEffect(() => {
    cameraChanged(isCameraEnabled, false);
  }, [isCameraEnabled, cameraChanged]);
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const [backgroundFailed, setBackgroundFailed] = useState(false);
  const backgroundFailure = useRef(0);
  function backgroundError() {
    backgroundFailure.current++;
    cameraChanged(false, true);
    setBackgroundFailed(true);
    setError(
      "Camera stopped because the background could not be applied. Choose a background again before starting video.",
    );
  }
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
      <fieldset
        className="media-control-guard"
        disabled={
          !videoAllowed || backgroundBusy || cameraBusy || backgroundFailed
        }
      >
        <button
          type="button"
          className="button media-toggle"
          aria-pressed={isCameraEnabled}
          onClick={async () => {
            if (cameraBusy || backgroundBusy || !videoAllowed) return;
            setCameraBusy(true);
            const enabled = !isCameraEnabled;
            const failure = backgroundFailure.current;
            if (!enabled) cameraChanged(false, true);
            try {
              await localParticipant.setCameraEnabled(
                enabled,
                cameraOptions(inputDevices.cameraId, inputDevices.background, {
                  signal: cameraOwner.signal,
                  current: () =>
                    owner.current.mounted &&
                    owner.current.videoAllowed &&
                    failure === backgroundFailure.current,
                  onError: backgroundError,
                }),
              );
              if (
                !owner.current.mounted ||
                !owner.current.videoAllowed ||
                cameraOwner.signal.aborted ||
                failure !== backgroundFailure.current
              ) {
                const track = localParticipant.getTrackPublication(
                  Track.Source.Camera,
                )?.track as LocalVideoTrack | undefined;
                if (track) await stopBackgroundCamera(track);
                return;
              }
              cameraChanged(enabled, true);
            } catch (error) {
              cameraChanged(false, true);
              if (owner.current.mounted && failure === backgroundFailure.current)
                setError(deviceError(error, "video"));
            } finally {
              if (owner.current.mounted) setCameraBusy(false);
            }
          }}
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
        </button>
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
            <BackgroundControls
              value={inputDevices.background}
              disabled={!videoAllowed || backgroundBusy || cameraBusy}
              onChange={async (background) => {
                setBackgroundBusy(true);
                const failure = backgroundFailure.current;
                const track = localParticipant.getTrackPublication(
                  Track.Source.Camera,
                )?.track as LocalVideoTrack | undefined;
                try {
                  if (track?.isMuted)
                    await localParticipant.unpublishTrack(track, true);
                  else if (
                    track &&
                    !(await changeBackground(
                      track,
                      background,
                      () =>
                        owner.current.mounted &&
                        owner.current.videoAllowed &&
                        failure === backgroundFailure.current &&
                        localParticipant.getTrackPublication(
                          Track.Source.Camera,
                        )?.track === track,
                      undefined,
                      cameraOwner.signal,
                      backgroundError,
                    ))
                  )
                    return;
                  if (
                    owner.current.mounted &&
                    failure === backgroundFailure.current
                  ) {
                    setInputDevices((current) => ({ ...current, background }));
                    setBackgroundFailed(false);
                    setError("");
                  }
                } catch (error) {
                  cameraChanged(false, true);
                  if (owner.current.mounted) setBackgroundFailed(true);
                  throw new Error(
                    "Camera stopped because the background could not be applied. Choose a background again before starting video.",
                  );
                } finally {
                  if (owner.current.mounted) setBackgroundBusy(false);
                }
              }}
            />
            <CallDeviceSelect
              kind="videoinput"
              value={inputDevices.cameraId}
              disabled={!videoAllowed || backgroundBusy || cameraBusy}
              onSelect={(cameraId) => {
                setInputDevices((current) => ({ ...current, cameraId }));
                setError("");
              }}
              onChanging={setCameraBusy}
              onError={(error) => setError(deviceError(error, "video"))}
            />
          </>,
          deviceTarget,
        )}
    </>
  );
}
