import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ScreenShareViewer } from "../src/screen-share-viewer.tsx";

test("shared screen starts fitted with keyboard-accessible viewport and labelled zoom controls", () => {
  const markup = renderToStaticMarkup(
    createElement(ScreenShareViewer, {
      children: createElement("video", { "data-track": "screen" }),
    }),
  );
  assert.match(markup, /tabindex="0" role="region" aria-label="Shared screen"/);
  assert.match(markup, /width:100%;height:100%/);
  assert.match(markup, /<video data-track="screen"/);
  assert.match(markup, /aria-label="Zoom out" disabled=""/);
  assert.match(markup, /aria-label="Zoom level">100%<\/output>/);
  assert.match(markup, /aria-label="Zoom in"/);
  assert.match(markup, />Fit<\/button>/);
});
