import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  useMediaDeviceSelect,
  useRoomContext,
} from "@livekit/components-react";
import { RoomEvent, type Room } from "livekit-client";

export type InputDevices = { cameraId: string; microphoneId: string };
export type InputDeviceProps = {
  inputDevices: InputDevices;
  setInputDevices: Dispatch<SetStateAction<InputDevices>>;
};
type InputKind = "audioinput" | "videoinput";

export function captureDevice(deviceId: string) {
  return { deviceId: deviceId ? { exact: deviceId } : "" };
}

export function DeviceSelect({
  kind,
  devices,
  value,
  disabled,
  onSelect,
}: {
  kind: InputKind;
  devices: MediaDeviceInfo[];
  value: string;
  disabled: boolean;
  onSelect: (deviceId: string) => void;
}) {
  const label = kind === "audioinput" ? "Microphone" : "Camera";
  const inputs = devices.filter(
    (device) => device.kind === kind && device.deviceId,
  );
  return (
    <label className="field">
      <span>{label}</span>
      <select
        aria-label={label}
        value={value}
        disabled={disabled}
        onChange={(event) => onSelect(event.target.value)}
      >
        <option value="">Default {label.toLowerCase()}</option>
        {value && !inputs.some((device) => device.deviceId === value) && (
          <option value={value}>Selected {label.toLowerCase()}</option>
        )}
        {inputs.map((device, index) => (
          <option key={device.deviceId} value={device.deviceId}>
            {device.label || `${label} ${index + 1}`}
          </option>
        ))}
      </select>
    </label>
  );
}

export async function switchCallDevice(
  room: Pick<Room, "switchActiveDevice">,
  kind: InputKind,
  deviceId: string,
) {
  const switched = await room.switchActiveDevice(kind, deviceId, !!deviceId);
  // An unconstrained default resolves to a physical ID, so SDK equality may be false.
  if (!switched && deviceId)
    throw new DOMException(
      "Selected device is unavailable",
      "OverconstrainedError",
    );
}

export function observeCallDevice(
  room: Pick<Room, "on" | "off">,
  kind: InputKind,
  onSelect: (deviceId: string) => void,
) {
  const changed = (changedKind: MediaDeviceKind, deviceId: string) => {
    if (changedKind === kind) onSelect(deviceId === "default" ? "" : deviceId);
  };
  room.on(RoomEvent.ActiveDeviceChanged, changed);
  return () => {
    room.off(RoomEvent.ActiveDeviceChanged, changed);
  };
}

export function CallDeviceSelect({
  kind,
  value,
  disabled,
  onSelect,
  onError,
}: {
  kind: InputKind;
  value: string;
  disabled: boolean;
  onSelect: (deviceId: string) => void;
  onError: (error: unknown) => void;
}) {
  const room = useRoomContext();
  const { devices } = useMediaDeviceSelect({ kind, requestPermissions: false });
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  useEffect(
    () =>
      observeCallDevice(room, kind, (deviceId) => {
        if (!pending.current) onSelect(deviceId);
      }),
    [room, kind, onSelect],
  );
  async function select(deviceId: string) {
    if (disabled || pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await switchCallDevice(room, kind, deviceId);
      onSelect(deviceId);
    } catch (error) {
      onError(error);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="call-device-select" aria-busy={busy}>
      <DeviceSelect
        kind={kind}
        devices={devices}
        value={value}
        disabled={disabled || busy}
        onSelect={(deviceId) => void select(deviceId)}
      />
    </div>
  );
}
