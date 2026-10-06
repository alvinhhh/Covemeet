import assert from "node:assert/strict";
import test from "node:test";
import {
  applyBoardPage,
  applyBoardWrite,
  applyBoardEvents,
  initialBoardState,
  savedViewport,
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

test("reopened boards keep a separate viewport for the main room and each breakout", () => {
  const views = new Map([
    ["main", { x: -3800, y: 420, scale: 2 }],
    ["breakout-a", { x: 120, y: -850, scale: 0.5 }],
  ]);
  assert.deepEqual(savedViewport(views, "main"), views.get("main"));
  assert.deepEqual(savedViewport(views, "breakout-a"), views.get("breakout-a"));
  assert.deepEqual(savedViewport(views, "breakout-b"), {
    x: 0,
    y: 0,
    scale: 1,
  });
});

test("a delayed clear response cannot erase a later polled peer stroke", () => {
  const clear = { kind: "clear" as const, seq: 10, epoch: 1, authorId: "host" };
  const peer = {
    kind: "stroke" as const,
    id: "peer",
    points: [[1, 2]] as [number, number][],
    seq: 11,
    epoch: 1,
    authorId: "guest",
  };
  const polled = applyBoardPage(initialBoardState, {
    events: [clear, peer],
    cursor: 11,
    epoch: 1,
    readOnly: false,
  });
  assert.deepEqual(applyBoardWrite(polled, clear), polled);
  assert.deepEqual(polled.items, [peer]);
  assert.deepEqual(
    applyBoardWrite(polled, { ...peer, id: "future", seq: 13 }),
    polled,
  );
  assert.deepEqual(
    applyBoardPage(polled, {
      events: [{ ...peer, id: "next", seq: 12 }],
      cursor: 12,
      epoch: 1,
      readOnly: false,
    }).items.map((item) => item.id),
    ["peer", "next"],
  );
});
