import { useEffect, useState } from "react";
import { RoomAudioRenderer, useRoomContext } from "@livekit/components-react";
import { supportsAudioOutputSelection, type Room } from "livekit-client";
import {
  CallDeviceSelect,
  DeviceSelect,
  observeCallDevice,
  switchCallDevice,
} from "./device-select";

export function canSelectAudioOutput() {
  return typeof document !== "undefined" && supportsAudioOutputSelection();
}

export const audioOutputError =
  "Speaker unavailable. Choose another speaker or the default.";

export async function restoreAudioOutput(
  room: Pick<Room, "getActiveDevice" | "switchActiveDevice">,
  deviceId: string,
) {
  const active = room.getActiveDevice("audiooutput");
  if ((active === "default" ? "" : (active ?? "")) !== deviceId)
    await switchCallDevice(room, "audiooutput", deviceId);
}

export function CallAudioRenderer({ speakerId }: { speakerId: string }) {
  const room = useRoomContext();
  const [ready, setReady] = useState<{ room: Room; speakerId: string }>();
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setError("");
    const stop = observeCallDevice(room, "audiooutput", (selected) => {
      if (active && selected === speakerId) {
        setError("");
        setReady({ room, speakerId });
      }
    });
    const routing = canSelectAudioOutput()
      ? restoreAudioOutput(room, speakerId)
      : Promise.resolve();
    void routing.then(
      () => {
        if (active) setReady({ room, speakerId });
      },
      () => {
        if (active) setError(audioOutputError);
      },
    );
    return () => {
      active = false;
      stop();
    };
  }, [room, speakerId]);
  // Restore the chosen output before attaching playback after a media reconnect.
  return (
    <>
      {error && (
        <span className="device-error" role="alert">
          {error}
        </span>
      )}
      {ready?.room === room && ready.speakerId === speakerId && (
        <RoomAudioRenderer />
      )}
    </>
  );
}

export function CallSpeakerSelect({
  value,
  onSelect,
  onError,
}: {
  value: string;
  onSelect: (deviceId: string) => void;
  onError: (error: unknown) => void;
}) {
  if (!canSelectAudioOutput())
    return (
      <div className="call-device-select">
        <DeviceSelect
          kind="audiooutput"
          devices={[]}
          value=""
          disabled
          onSelect={() => {}}
        />
        <small>Choose speakers in system sound settings.</small>
      </div>
    );
  return (
    <CallDeviceSelect
      kind="audiooutput"
      value={value}
      disabled={false}
      onSelect={onSelect}
      onError={onError}
    />
  );
}
