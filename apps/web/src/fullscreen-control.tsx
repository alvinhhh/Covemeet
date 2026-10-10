import { useEffect, useState, type RefObject } from "react";
import { Icon } from "./icons";

export function observeFullscreen(
  target: HTMLElement,
  changed: (state: { active: boolean; supported: boolean }) => void,
) {
  const doc = target.ownerDocument;
  const update = () =>
    changed({
      active: doc.fullscreenElement === target,
      supported:
        !!doc.fullscreenEnabled &&
        typeof target.requestFullscreen === "function",
    });
  doc.addEventListener("fullscreenchange", update);
  update();
  return () => doc.removeEventListener("fullscreenchange", update);
}

export async function toggleFullscreen(target: HTMLElement) {
  if (target.ownerDocument.fullscreenElement === target)
    await target.ownerDocument.exitFullscreen();
  else await target.requestFullscreen();
}

export function FullscreenControl({
  target,
}: {
  target: RefObject<HTMLElement | null>;
}) {
  const [state, setState] = useState({ active: false, supported: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!target.current) return;
    return observeFullscreen(target.current, (value) => {
      setState(value);
      setError("");
    });
  }, [target]);
  const label = state.active ? "Exit fullscreen" : "Enter fullscreen";
  return (
    <div className="fullscreen-control">
      <button
        type="button"
        className="button"
        aria-label={label}
        title={
          state.supported ? label : "Fullscreen is unavailable in this browser"
        }
        disabled={!state.supported || busy}
        onClick={async () => {
          if (!target.current || busy) return;
          setBusy(true);
          setError("");
          try {
            await toggleFullscreen(target.current);
          } catch {
            setError("Could not change fullscreen. Try again.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <Icon
          name={state.active ? "fullscreen-exit" : "fullscreen"}
          size={17}
        />
        <span>{label}</span>
      </button>
      {error && (
        <span className="fullscreen-error" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
