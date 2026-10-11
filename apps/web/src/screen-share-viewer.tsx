import { useRef, useState, type ReactNode } from "react";

export function ScreenShareViewer({ children }: { children: ReactNode }) {
  const [zoom, setZoom] = useState(1);
  const viewport = useRef<HTMLDivElement>(null);
  return (
    <div className="screen-viewer">
      <div
        className="screen-viewport"
        ref={viewport}
        tabIndex={0}
        role="region"
        aria-label="Shared screen"
      >
        <div
          className="screen-content"
          style={{ width: `${zoom * 100}%`, height: `${zoom * 100}%` }}
        >
          {children}
        </div>
      </div>
      <div className="screen-zoom" role="group" aria-label="Shared screen zoom">
        <button
          type="button"
          aria-label="Zoom out"
          disabled={zoom === 1}
          onClick={() => setZoom((value) => Math.max(1, value - 0.25))}
        >
          −
        </button>
        <output aria-live="polite" aria-label="Zoom level">
          {zoom * 100}%
        </output>
        <button
          type="button"
          aria-label="Zoom in"
          disabled={zoom === 3}
          onClick={() => setZoom((value) => Math.min(3, value + 0.25))}
        >
          +
        </button>
        <button
          type="button"
          onClick={() => {
            setZoom(1);
            viewport.current?.scrollTo({ left: 0, top: 0 });
          }}
        >
          Fit
        </button>
      </div>
    </div>
  );
}
