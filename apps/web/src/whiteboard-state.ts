export type Viewport = { x: number; y: number; scale: number };

export const initialViewport: Viewport = { x: 0, y: 0, scale: 1 };

export function savedViewport(
  views: ReadonlyMap<string, Viewport>,
  scope: string,
): Viewport {
  return views.get(scope) ?? initialViewport;
}

export function worldPoint(
  viewport: Viewport,
  x: number,
  y: number,
): [number, number] {
  return [(x - viewport.x) / viewport.scale, (y - viewport.y) / viewport.scale];
}

export function zoomAt(
  viewport: Viewport,
  x: number,
  y: number,
  factor: number,
) {
  const scale = Math.max(0.1, Math.min(8, viewport.scale * factor));
  const [worldX, worldY] = worldPoint(viewport, x, y);
  return { x: x - worldX * scale, y: y - worldY * scale, scale };
}

export type BoardEvent = {
  seq: number;
  epoch: number;
  authorId: string;
} & (
  | { kind: "stroke"; id: string; points: [number, number][] }
  | { kind: "text"; id: string; x: number; y: number; text: string }
  | { kind: "delete"; targetId: string }
  | { kind: "clear" }
  | { kind: "policy"; readOnly: boolean }
);

export type BoardItem = Extract<BoardEvent, { kind: "stroke" | "text" }>;
export type BoardState = {
  items: BoardItem[];
  seq: number;
  epoch: number;
  readOnly: boolean;
};

export const initialBoardState: BoardState = {
  items: [],
  seq: 0,
  epoch: 0,
  readOnly: false,
};

export function applyBoardEvents(items: BoardItem[], events: BoardEvent[]) {
  const next = new Map(items.map((item) => [item.id, item]));
  for (const event of events) {
    if (event.kind === "clear") next.clear();
    else if (event.kind === "delete") next.delete(event.targetId);
    else if (event.kind === "stroke" || event.kind === "text")
      next.set(event.id, event);
  }
  return [...next.values()].sort((a, b) => a.seq - b.seq);
}

export function applyBoardPage(
  state: BoardState,
  page: {
    events: BoardEvent[];
    cursor: number;
    epoch: number;
    readOnly: boolean;
  },
): BoardState {
  if (page.epoch < state.epoch || page.cursor < state.seq) return state;
  return {
    items: applyBoardEvents(
      state.items,
      page.events.filter((event) => event.seq > state.seq),
    ),
    seq: page.cursor,
    epoch: page.epoch,
    readOnly: page.readOnly,
  };
}

export function applyBoardWrite(
  state: BoardState,
  event: BoardEvent,
): BoardState {
  if (event.seq <= state.seq || event.epoch < state.epoch) return state;
  // A clear supersedes missing events. Every other write waits for polling to
  // fill any gap, including policy changes that are not stored as events.
  if (event.kind !== "clear" && event.seq !== state.seq + 1) return state;
  return {
    items: applyBoardEvents(state.items, [event]),
    seq: event.seq,
    epoch: event.epoch,
    readOnly: event.kind === "policy" ? event.readOnly : state.readOnly,
  };
}

export function sampleStroke(points: [number, number][], limit = 100) {
  if (points.length <= limit) return points;
  return Array.from(
    { length: limit },
    (_, i) => points[Math.round((i * (points.length - 1)) / (limit - 1))]!,
  );
}
