import { useEffect, useRef, useState } from "react";
import {
  createAudioAnalyser,
  createLocalAudioTrack,
  createLocalVideoTrack,
  type LocalAudioTrack,
  type LocalVideoTrack,
} from "livekit-client";
import { Icon } from "./icons";

// getUserMedia has no abort API. An abandoned request must close its late track.
export async function acquirePreviewTrack<
  T extends { stop(): void; detach(): unknown },
>(create: () => Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return;
  let track: T;
  try {
    track = await create();
  } catch (error) {
    if (!signal.aborted) throw error;
    return;
  }
  const stop = () => {
    track.stop();
    track.detach();
  };
  if (signal.aborted) {
    stop();
    return;
  }
  signal.addEventListener("abort", stop, { once: true });
  return track;
}

export function deviceError(error: unknown, kind: "audio" | "video") {
  const name = kind === "audio" ? "Microphone" : "Camera";
  switch (error instanceof Error ? error.name : "") {
    case "NotAllowedError":
    case "SecurityError":
      return `${name} permission was denied. Allow access in your browser and try again.`;
    case "NotFoundError":
    case "DevicesNotFoundError":
      return `No ${name.toLowerCase()} was found. Connect one and try again.`;
    case "NotReadableError":
    case "TrackStartError":
      return `${name} is unavailable or in use by another app.`;
    case "OverconstrainedError":
      return `Selected ${name.toLowerCase()} is unavailable. Choose another device.`;
    default:
      return `${name} could not start. Check your browser and device settings.`;
  }
}

function useTestDevice(kind: "audio" | "video") {
  const [track, setTrack] = useState<LocalAudioTrack | LocalVideoTrack>();
  const [pending, setPending] = useState<false | "starting" | "stopping">(
    false,
  );
  const [error, setError] = useState("");
  const owner = useRef<
    { controller: AbortController; pending: boolean } | undefined
  >(undefined);
  useEffect(
    () => () => {
      owner.current?.controller.abort();
      owner.current = undefined;
    },
    [],
  );
  function stop() {
    owner.current?.controller.abort();
    if (owner.current?.pending) setPending("stopping");
    setTrack(undefined);
    setError("");
  }
  async function start(deviceId: string) {
    if (owner.current?.pending) return;
    stop();
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Device tests require HTTPS and a supported browser.");
      return;
    }
    const attempt = { controller: new AbortController(), pending: true };
    owner.current = attempt;
    setPending("starting");
    try {
      const device = deviceId ? { deviceId: { exact: deviceId } } : {};
      const acquired = await acquirePreviewTrack<
        LocalAudioTrack | LocalVideoTrack
      >(
        () =>
          kind === "audio"
            ? createLocalAudioTrack(device)
            : createLocalVideoTrack({
                ...device,
                resolution: { width: 640, height: 360, frameRate: 15 },
              }),
        attempt.controller.signal,
      );
      if (
        !acquired ||
        attempt.controller.signal.aborted ||
        owner.current !== attempt
      )
        return;
      acquired.mediaStreamTrack.addEventListener(
        "ended",
        () => {
          stop();
          setError(
            `${kind === "audio" ? "Microphone" : "Camera"} disconnected. Choose a device and try again.`,
          );
        },
        { once: true, signal: attempt.controller.signal },
      );
      setTrack(acquired);
    } catch (error) {
      if (!attempt.controller.signal.aborted)
        setError(deviceError(error, kind));
    } finally {
      attempt.pending = false;
      if (owner.current === attempt) setPending(false);
    }
  }
  return {
    track,
    pending,
    error,
    start,
    stop,
    stopping: pending === "stopping",
  };
}

export function DeviceCheck() {
  const camera = useTestDevice("video");
  const microphone = useTestDevice("audio");
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [cameraId, setCameraId] = useState("");
  const [microphoneId, setMicrophoneId] = useState("");
  const [level, setLevel] = useState(0);
  const [paused, setPaused] = useState(false);
  const [meterError, setMeterError] = useState("");
  const video = useRef<HTMLVideoElement>(null);
  const context = useRef<AudioContext | undefined>(undefined);

  useEffect(() => {
    let active = true;
    const media = navigator.mediaDevices;
    const refresh = () =>
      void media
        ?.enumerateDevices()
        .then((value) => {
          if (active)
            setDevices(
              value.filter(
                (device) => device.kind !== "audiooutput" && device.deviceId,
              ),
            );
        })
        .catch(() => {
          /* Default inputs remain usable if enumeration is unavailable. */
        });
    refresh();
    media?.addEventListener("devicechange", refresh);
    return () => {
      active = false;
      media?.removeEventListener("devicechange", refresh);
    };
  }, [camera.track, microphone.track]);

  useEffect(() => {
    if (!camera.track || !video.current) return;
    const element = video.current;
    camera.track.attach(element);
    return () => {
      camera.track?.detach(element);
    };
  }, [camera.track]);

  useEffect(() => {
    setLevel(0);
    setPaused(false);
    if (!microphone.track) return;
    setMeterError("");
    let meter: ReturnType<typeof createAudioAnalyser>;
    try {
      meter = createAudioAnalyser(microphone.track as LocalAudioTrack, {
        cloneTrack: false,
      });
    } catch {
      microphone.stop();
      setMeterError("Microphone level is unavailable in this browser.");
      return;
    }
    context.current = meter.analyser.context as AudioContext;
    const update = () => {
      setLevel(meter.calculateVolume());
      setPaused(meter.analyser.context.state === "suspended");
    };
    update();
    const interval = setInterval(update, 100);
    return () => {
      clearInterval(interval);
      context.current = undefined;
      void meter.cleanup().catch(() => {});
    };
  }, [microphone.track]);

  return (
    <section className="device-check" aria-label="Camera and microphone test">
      <div className="camera-preview">
        <video
          ref={video}
          muted
          autoPlay
          playsInline
          aria-label="Camera preview"
          hidden={!camera.track}
        />
        {!camera.track && (
          <>
            <div className="camera-ring">
              <Icon name="camera-off" size={42} />
            </div>
            <h2>
              {camera.pending ? "Waiting for camera permission…" : "Camera off"}
            </h2>
          </>
        )}
      </div>
      <div className="device-check-controls">
        <label className="field">
          <span>Camera</span>
          <select
            aria-label="Camera"
            value={cameraId}
            disabled={!!camera.pending}
            onChange={(event) => {
              setCameraId(event.target.value);
              if (camera.track) void camera.start(event.target.value);
            }}
          >
            <option value="">Default camera</option>
            {devices
              .filter((device) => device.kind === "videoinput")
              .map((device, i) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${i + 1}`}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          className="button"
          disabled={camera.stopping}
          onClick={() =>
            camera.track || camera.pending
              ? camera.stop()
              : void camera.start(cameraId)
          }
        >
          <Icon name={camera.track ? "camera-off" : "video"} size={18} />
          {camera.stopping
            ? "Permission request pending…"
            : camera.track || camera.pending
              ? "Stop camera"
              : "Test camera"}
        </button>
        {camera.error && (
          <p className="device-check-error" role="alert">
            {camera.error}
          </p>
        )}
        <label className="field">
          <span>Microphone</span>
          <select
            aria-label="Microphone"
            value={microphoneId}
            disabled={!!microphone.pending}
            onChange={(event) => {
              setMicrophoneId(event.target.value);
              if (microphone.track) void microphone.start(event.target.value);
            }}
          >
            <option value="">Default microphone</option>
            {devices
              .filter((device) => device.kind === "audioinput")
              .map((device, i) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Microphone ${i + 1}`}
                </option>
              ))}
          </select>
        </label>
        <button
          type="button"
          className="button"
          disabled={microphone.stopping}
          onClick={() =>
            microphone.track || microphone.pending
              ? microphone.stop()
              : void microphone.start(microphoneId)
          }
        >
          <Icon name={microphone.track ? "mic-off" : "mic"} size={18} />
          {microphone.stopping
            ? "Permission request pending…"
            : microphone.track || microphone.pending
              ? "Stop microphone"
              : "Test microphone"}
        </button>
        <div className="microphone-check-level">
          <meter min={0} max={1} value={level} aria-label="Microphone level" />
          <span>
            {microphone.track
              ? "Speak to check the level."
              : microphone.pending
                ? "Waiting for microphone permission…"
                : "Microphone off"}
          </span>
          {paused && (
            <button
              type="button"
              className="button"
              onClick={() =>
                void context.current
                  ?.resume()
                  .catch(() =>
                    setMeterError(
                      "Microphone test could not resume. Try starting it again.",
                    ),
                  )
              }
            >
              Resume microphone test
            </button>
          )}
        </div>
        {(microphone.error || meterError) && (
          <p className="device-check-error" role="alert">
            {microphone.error || meterError}
          </p>
        )}
      </div>
      <p className="device-check-note">
        Local preview only. Tests stop when you enter the meeting.
      </p>
    </section>
  );
}
