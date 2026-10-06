import type { AudioSignal } from "./audio-signal";
import { Icon } from "./icons";

export function SpeakingBadge({
  signal,
  surface,
  name,
}: {
  signal?: AudioSignal;
  surface: "tile" | "list" | "dock";
  name: string;
}) {
  const status = signal?.speaking
    ? "Speaking"
    : signal?.microphoneOn
      ? "Microphone on"
      : "Microphone off";
  return (
    <span
      className={`speaking-badge ${surface}${signal?.speaking ? " is-speaking" : ""}`}
      role="img"
      aria-label={`${name}: ${status}`}
      aria-hidden={surface !== "tile" && !signal?.speaking ? true : undefined}
      title={status}
    >
      {signal?.speaking ? (
        <span className="audio-level" aria-hidden="true">
          {[1, 2, 3, 4].map((bar) => (
            <i key={bar} className={bar <= signal.bars ? "active" : ""} />
          ))}
        </span>
      ) : (
        <Icon name={signal?.microphoneOn ? "mic" : "mic-off"} size={17} />
      )}
    </span>
  );
}
