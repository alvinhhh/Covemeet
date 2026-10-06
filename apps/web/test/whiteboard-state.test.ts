import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBoardEvents,
  sampleStroke,
  worldPoint,
  zoomAt,
} from "../src/whiteboard-state.js";

test("whiteboard zoom keeps the pointer on the same world coordinate", () => {
  const before = { x: 120, y: -50, scale: 1.5 };
  const point = worldPoint(before, 400, 280);
  const after = zoomAt(before, 400, 280, 1.25);
  assert.deepEqual(worldPoint(after, 400, 280), point);
  assert.equal(zoomAt(after, 0, 0, 100).scale, 8);
  assert.equal(zoomAt(after, 0, 0, 0.00001).scale, 0.1);
});

test("whiteboard replay applies deletion and clear; long strokes stay bounded", () => {
  const stroke = {
    kind: "stroke" as const,
    id: "one",
    points: [
      [0, 0],
      [1, 1],
    ] as [number, number][],
    authorId: "a",
    seq: 1,
    epoch: 0,
  };
  assert.deepEqual(
    applyBoardEvents(
      [],
      [
        stroke,
        { kind: "delete", targetId: "one", authorId: "b", seq: 2, epoch: 0 },
      ],
    ),
    [],
  );
  assert.deepEqual(
    applyBoardEvents(
      [stroke],
      [{ kind: "clear", authorId: "host", seq: 3, epoch: 1 }],
    ),
    [],
  );
  const points = Array.from(
    { length: 1001 },
    (_, i) => [i, i] as [number, number],
  );
  const sampled = sampleStroke(points);
  assert.equal(sampled.length, 100);
  assert.deepEqual(sampled[0], points[0]);
  assert.deepEqual(sampled.at(-1), points.at(-1));
});
