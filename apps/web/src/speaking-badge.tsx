import type { AudioSignal } from "./audio-signal";

export function SpeakingBadge({
  signal,
  surface,
}: {
  signal?: AudioSignal;
  surface: "tile" | "list" | "dock";
}) {
  if (!signal?.speaking) return null;
  return (
    <span
      className={`speaking-badge ${surface}`}
      role={surface === "dock" ? "status" : undefined}
      aria-hidden={surface === "tile" ? true : undefined}
    >
      Speaking
    </span>
  );
}
