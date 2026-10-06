export type Viewport = { x: number; y: number; scale: number };

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

export function sampleStroke(points: [number, number][], limit = 100) {
  if (points.length <= limit) return points;
  return Array.from(
    { length: limit },
    (_, i) => points[Math.round((i * (points.length - 1)) / (limit - 1))]!,
  );
}
