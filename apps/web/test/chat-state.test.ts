import assert from "node:assert/strict";
import test from "node:test";
import { ChatUnread, sendsChatOnEnter } from "../src/chat-state.ts";

const enter = {
  key: "Enter",
  shiftKey: false,
  isComposing: false,
  keyCode: 13,
};

test("Enter submits while Shift+Enter and IME confirmation keep editing", () => {
  assert.equal(sendsChatOnEnter(enter), true);
  assert.equal(sendsChatOnEnter({ ...enter, shiftKey: true }), false);
  assert.equal(sendsChatOnEnter({ ...enter, isComposing: true }), false);
  assert.equal(sendsChatOnEnter({ ...enter, keyCode: 229 }), false);
  assert.equal(sendsChatOnEnter({ ...enter, key: "a" }), false);
});

test("unread tracks incoming IDs through polls and a rolling history window", () => {
  const unread = new ChatUnread();
  const history = Array.from({ length: 100 }, (_, index) => ({
    id: String(index),
  }));
  assert.equal(unread.update("main", history, "self", false), 0);
  const incoming = { id: "incoming", senderId: "other" };
  const rolled = [...history.slice(1), incoming];
  assert.equal(unread.update("main", rolled, "self", false), 1);
  assert.equal(unread.update("main", rolled, "self", false), 1);
  // Sending while the panel closes does not notify the sender. Names are irrelevant.
  const sent = { id: "sent", senderId: "self" };
  assert.equal(unread.update("main", [...rolled, sent], "self", false), 1);
  assert.equal(unread.update("main", [...rolled, sent], "self", true), 0);
  assert.equal(unread.update("main", [...rolled, sent], "self", false), 0);
});

test("opening another room does not clear this room's unread messages", () => {
  const unread = new ChatUnread();
  unread.update("main", [], "self", false);
  assert.equal(
    unread.update("main", [{ id: "new", senderId: "guest" }], "self", false),
    1,
  );
  assert.equal(unread.update("breakout", [{ id: "history" }], "self", true), 0);
  assert.equal(
    unread.update("main", [{ id: "new", senderId: "guest" }], "self", false),
    1,
  );
  assert.equal(
    unread.update("main", [{ id: "new", senderId: "guest" }], "self", true),
    0,
  );
  assert.equal(
    unread.update(
      "breakout",
      [{ id: "history" }, { id: "arrived", senderId: "guest" }],
      "self",
      true,
    ),
    0,
  );
});
