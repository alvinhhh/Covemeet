import { useEffect, useRef, useState } from "react";
import {
  noBackground,
  readBackgroundImage,
  supportsBackgroundProcessors,
  type Background,
} from "./background";

export function BackgroundControls({
  value = noBackground,
  onChange,
  disabled = false,
}: {
  value?: Background;
  onChange: (value: Background) => Promise<void> | void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const supported = supportsBackgroundProcessors();
  async function select(load: () => Promise<Background> | Background) {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const next = await load();
      if (mounted.current) await onChange(next);
    } catch (error) {
      if (mounted.current)
        setError(
          error instanceof Error
            ? error.message
            : "Background could not be applied. Try again.",
        );
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return (
    <fieldset className="background-controls" disabled={disabled || busy}>
      <legend>Background</legend>
      <div className="background-options">
        <button
          type="button"
          className="button"
          aria-pressed={value.mode === "none"}
          onClick={() => void select(() => noBackground)}
        >
          None
        </button>
        <button
          type="button"
          className="button"
          disabled={!supported}
          aria-pressed={value.mode === "blur"}
          onClick={() => void select(() => ({ mode: "blur" }))}
        >
          Blur
        </button>
        <label className="background-file">
          <span>
            {value.mode === "image" ? "Change image" : "Choose image"}
          </span>
          <input
            type="file"
            disabled={!supported}
            aria-label="Background image"
            accept="image/jpeg,image/png,image/webp"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              if (file)
                void select(async () => ({
                  mode: "image",
                  image: await readBackgroundImage(file),
                }));
            }}
          />
        </label>
      </div>
      {value.mode === "image" && (
        <img
          className="background-thumbnail"
          src={value.image}
          alt="Selected background"
        />
      )}
      {busy && <p role="status">Applying background…</p>}
      {!supported && <p>Background effects are unavailable in this browser.</p>}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
