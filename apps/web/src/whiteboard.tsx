import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import { api, meetingPath, messageOf } from "./api";
import { Icon } from "./icons";
import {
  applyBoardPage,
  applyBoardWrite,
  initialBoardState,
  initialViewport,
  sampleStroke,
  savedViewport,
  worldPoint,
  zoomAt,
  type BoardEvent,
  type Viewport,
} from "./whiteboard-state";

type Tool = "pen" | "text" | "pan" | "eraser";
type Page = {
  events: BoardEvent[];
  cursor: number;
  hasMore: boolean;
  readOnly: boolean;
  epoch: number;
};
type Write =
  | { kind: "stroke"; id: string; points: [number, number][] }
  | { kind: "text"; id: string; x: number; y: number; text: string }
  | { kind: "delete"; targetId: string }
  | { kind: "clear" }
  | { kind: "policy"; readOnly: boolean };

export function Whiteboard({
  code,
  host,
  scope,
  viewportStore,
}: {
  code: string;
  host: boolean;
  scope: string;
  viewportStore: Map<string, Viewport>;
}) {
  const [board, setBoard] = useState(initialBoardState);
  const { items, readOnly } = board;
  const epochRef = useRef(0);
  const [tool, setTool] = useState<Tool>("pen");
  const [viewport, setViewport] = useState<Viewport>(() =>
    savedViewport(viewportStore, scope),
  );
  const [stroke, setStroke] = useState<[number, number][]>([]);
  const [textAt, setTextAt] = useState<{
    x: number;
    y: number;
    screenX: number;
    screenY: number;
  }>();
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const canvas = useRef<SVGSVGElement>(null);
  const gesture = useRef<
    | { kind: "pen"; points: [number, number][] }
    | { kind: "pan"; x: number; y: number; viewport: Viewport }
    | undefined
  >(undefined);
  const editable = host || !readOnly;
  const canErase = editable && tool === "eraser";
  useLayoutEffect(() => {
    viewportStore.set(scope, viewport);
  }, [scope, viewport, viewportStore]);
  function zoomCentered(factor: number) {
    const rect = canvas.current?.getBoundingClientRect();
    setViewport((view) =>
      zoomAt(view, (rect?.width ?? 500) / 2, (rect?.height ?? 400) / 2, factor),
    );
  }

  useEffect(() => {
    const controller = new AbortController();
    let cursor = 0;
    let timeout: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        let more: boolean;
        do {
          const page = await api<Page>(
            `${meetingPath(code, "/whiteboard")}?after=${cursor}`,
            undefined,
            undefined,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          if (page.epoch < epochRef.current) break;
          epochRef.current = page.epoch;
          setBoard((current) => applyBoardPage(current, page));
          cursor = Math.max(cursor, page.cursor);
          more = page.hasMore;
        } while (more);
        setError("");
      } catch (cause) {
        if (!controller.signal.aborted) setError(messageOf(cause));
      }
      if (!controller.signal.aborted) timeout = setTimeout(poll, 2000);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timeout);
    };
  }, [code]);

  async function write(input: Write) {
    try {
      const { event } = await api<{ event: BoardEvent }>(
        meetingPath(code, "/whiteboard"),
        { ...input, epoch: epochRef.current },
      );
      if (event.epoch < epochRef.current) return;
      epochRef.current = event.epoch;
      setBoard((current) => applyBoardWrite(current, event));
      setError("");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }
  function point(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }
  function pointerDown(event: PointerEvent<SVGSVGElement>) {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const { x, y } = point(event);
    const activeTool = editable ? tool : "pan";
    if (activeTool === "text") {
      const [worldX, worldY] = worldPoint(viewport, x, y);
      setTextAt({ x: worldX, y: worldY, screenX: x, screenY: y });
      setText("");
      return;
    }
    if (activeTool === "eraser") return;
    event.currentTarget.setPointerCapture(event.pointerId);
    if (activeTool === "pan") gesture.current = { kind: "pan", x, y, viewport };
    else {
      const points: [number, number][] = [worldPoint(viewport, x, y)];
      gesture.current = { kind: "pen", points };
      setStroke(points);
    }
  }
  function pointerMove(event: PointerEvent<SVGSVGElement>) {
    const current = gesture.current;
    if (!current) return;
    const { x, y } = point(event);
    if (current.kind === "pan") {
      setViewport({
        ...current.viewport,
        x: current.viewport.x + x - current.x,
        y: current.viewport.y + y - current.y,
      });
    } else {
      const next = worldPoint(viewport, x, y);
      const last = current.points.at(-1)!;
      if (Math.hypot(next[0] - last[0], next[1] - last[1]) < 2 / viewport.scale)
        return;
      current.points.push(next);
      if (current.points.length > 5000)
        current.points = sampleStroke(current.points, 2500);
      setStroke([...current.points]);
    }
  }
  function pointerUp(event: PointerEvent<SVGSVGElement>) {
    const current = gesture.current;
    gesture.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setStroke([]);
    if (current?.kind !== "pen") return;
    const points = sampleStroke(
      current.points.length === 1
        ? [current.points[0]!, current.points[0]!]
        : current.points,
    ).map(
      ([x, y]) =>
        [Math.round(x * 10) / 10, Math.round(y * 10) / 10] as [number, number],
    );
    void write({ kind: "stroke", id: crypto.randomUUID(), points });
  }
  function submitText(event: FormEvent) {
    event.preventDefault();
    if (textAt && text.trim())
      void write({
        kind: "text",
        id: crypto.randomUUID(),
        x: textAt.x,
        y: textAt.y,
        text: text.trim(),
      });
    setTextAt(undefined);
  }
  function addTextAtCenter() {
    if (!editable) return;
    const rect = canvas.current?.getBoundingClientRect();
    const screenX = (rect?.width ?? 500) / 2;
    const screenY = (rect?.height ?? 400) / 2;
    const [x, y] = worldPoint(viewport, screenX, screenY);
    setTextAt({ x, y, screenX, screenY });
    setText("");
  }
  function removeItem(event: PointerEvent, id: string) {
    if (!canErase) return;
    event.stopPropagation();
    void write({ kind: "delete", targetId: id });
  }
  function removeItemWithKey(event: KeyboardEvent, id: string) {
    if (!canErase) return;
    if (!["Enter", " ", "Backspace", "Delete"].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    void write({ kind: "delete", targetId: id });
  }
  function downloadView() {
    const svg = canvas.current;
    if (!svg) return;
    const copy = svg.cloneNode(true) as SVGSVGElement;
    const rect = svg.getBoundingClientRect();
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    copy.setAttribute("width", String(Math.round(rect.width)));
    copy.setAttribute("height", String(Math.round(rect.height)));
    const url = URL.createObjectURL(
      new Blob([new XMLSerializer().serializeToString(copy)], {
        type: "image/svg+xml",
      }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `whiteboard-${code}.svg`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  const controls: { tool: Tool; label: string; icon: ReactNode }[] = [
    { tool: "pen", label: "Pen", icon: <Icon name="pen" size={18} /> },
    {
      tool: "text",
      label: "Text",
      icon: <span className="whiteboard-text-icon">T</span>,
    },
    { tool: "pan", label: "Pan", icon: <Icon name="screen" size={18} /> },
    { tool: "eraser", label: "Eraser", icon: <Icon name="close" size={18} /> },
  ];
  return (
    <section className="whiteboard" aria-label="Whiteboard">
      <div className="whiteboard-toolbar">
        <strong>Whiteboard</strong>
        <div
          className="whiteboard-tools"
          role="toolbar"
          aria-label="Whiteboard tools"
        >
          {controls.map(({ tool: option, label, icon }) => (
            <button
              key={option}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={tool === option}
              className={tool === option ? "selected" : ""}
              disabled={!editable && option !== "pan"}
              onClick={() => setTool(option)}
            >
              {icon}
              <span>{label}</span>
            </button>
          ))}
          <button type="button" disabled={!editable} onClick={addTextAtCenter}>
            Add text
          </button>
        </div>
        <div className="whiteboard-view-controls">
          <button
            type="button"
            onClick={() => zoomCentered(0.8)}
            aria-label="Zoom out"
          >
            −
          </button>
          <span>{Math.round(viewport.scale * 100)}%</span>
          <button
            type="button"
            onClick={() => zoomCentered(1.25)}
            aria-label="Zoom in"
          >
            +
          </button>
          <button type="button" onClick={() => setViewport(initialViewport)}>
            Reset view
          </button>
          <button type="button" onClick={downloadView}>
            Download view
          </button>
        </div>
        {host && (
          <div className="whiteboard-host-controls">
            <button
              type="button"
              onClick={() =>
                void write({ kind: "policy", readOnly: !readOnly })
              }
            >
              {readOnly ? "Allow editing" : "Host only"}
            </button>
            <button
              type="button"
              onClick={() => {
                if (window.confirm("Clear the whiteboard for everyone?"))
                  void write({ kind: "clear" });
              }}
            >
              Clear
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="whiteboard-error" role="alert">
          {error}
        </p>
      )}
      <div className="whiteboard-canvas-wrap">
        <svg
          ref={canvas}
          className="whiteboard-canvas"
          role="group"
          aria-label="Shared whiteboard canvas"
          style={{
            cursor:
              !editable || tool === "pan"
                ? "grab"
                : tool === "eraser"
                  ? "crosshair"
                  : "crosshair",
          }}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={() => {
            gesture.current = undefined;
            setStroke([]);
          }}
          onWheel={(event) => {
            event.preventDefault();
            const rect = event.currentTarget.getBoundingClientRect();
            setViewport((view) =>
              zoomAt(
                view,
                event.clientX - rect.left,
                event.clientY - rect.top,
                event.deltaY < 0 ? 1.1 : 1 / 1.1,
              ),
            );
          }}
        >
          <rect width="100%" height="100%" fill="#fff" pointerEvents="none" />
          <g
            transform={`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`}
          >
            {items.map((item, index) =>
              item.kind === "stroke" ? (
                <path
                  key={item.id}
                  role={canErase ? "button" : undefined}
                  aria-label={
                    canErase ? `Erase stroke ${index + 1}` : undefined
                  }
                  aria-hidden={!canErase}
                  tabIndex={canErase ? 0 : -1}
                  d={item.points
                    .map(([x, y], index) => `${index ? "L" : "M"}${x} ${y}`)
                    .join(" ")}
                  fill="none"
                  stroke="#171717"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  onPointerDown={(event) => removeItem(event, item.id)}
                  onKeyDown={(event) => removeItemWithKey(event, item.id)}
                />
              ) : (
                <text
                  key={item.id}
                  role={canErase ? "button" : undefined}
                  aria-label={canErase ? `Erase text: ${item.text}` : undefined}
                  aria-hidden={!canErase}
                  tabIndex={canErase ? 0 : -1}
                  x={item.x}
                  y={item.y}
                  fill="#171717"
                  fontSize="24"
                  onPointerDown={(event) => removeItem(event, item.id)}
                  onKeyDown={(event) => removeItemWithKey(event, item.id)}
                >
                  {item.text}
                </text>
              ),
            )}
            {stroke.length > 0 && (
              <path
                d={stroke
                  .map(([x, y], index) => `${index ? "L" : "M"}${x} ${y}`)
                  .join(" ")}
                fill="none"
                stroke="#171717"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            )}
          </g>
        </svg>
        {textAt && (
          <form
            className="whiteboard-text-entry"
            style={{ left: textAt.screenX, top: textAt.screenY }}
            onSubmit={submitText}
          >
            <label className="sr-only" htmlFor="whiteboard-text">
              Whiteboard text
            </label>
            <input
              id="whiteboard-text"
              autoFocus
              maxLength={500}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setTextAt(undefined);
              }}
              onBlur={() => setTextAt(undefined)}
            />
          </form>
        )}
      </div>
    </section>
  );
}
