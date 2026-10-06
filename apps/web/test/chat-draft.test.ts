import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { MeetingState } from "../src/api.ts";
import { Chat } from "../src/chat.tsx";

test("chat displays its retained draft on every fresh mount", () => {
  const props = {
    state: { messages: [] } as unknown as MeetingState,
    text: "Unsent message\nSecond line",
    setText: () => {},
    send: async () => true,
    busy: false,
  };
  const render = () => renderToStaticMarkup(createElement(Chat, props));
  assert.match(render(), /<textarea[^>]*>Unsent message\nSecond line<\/textarea>/);
  assert.match(render(), /<textarea[^>]*>Unsent message\nSecond line<\/textarea>/);
  // Clearing the owner-held value is reflected on subsequent mounts.
  props.text = "";
  assert.match(render(), /<textarea[^>]*><\/textarea>/);
});
