import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Whiteboard } from "../src/whiteboard.tsx";

test("whiteboard exposes keyboard text placement and a navigable canvas", () => {
  const viewportStore = new Map([["main", { x: -3800, y: 420, scale: 2 }]]);
  const markup = renderToStaticMarkup(
    createElement(Whiteboard, {
      code: "test-room",
      host: true,
      scope: "main",
      viewportStore,
    }),
  );
  assert.match(markup, /<button[^>]*>Add text<\/button>/);
  assert.match(markup, /<svg[^>]*role="group"/);
  assert.match(markup, /aria-label="Shared whiteboard canvas"/);
  assert.match(markup, /transform="translate\(-3800 420\) scale\(2\)"/);
});
