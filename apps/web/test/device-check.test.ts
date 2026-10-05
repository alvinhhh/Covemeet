import assert from "node:assert/strict";
import test from "node:test";
import { acquirePreviewTrack, deviceError } from "../src/device-check.tsx";

const track = () => ({
  stops: 0,
  detaches: 0,
  stop() {
    this.stops++;
  },
  detach() {
    this.detaches++;
  },
});

test("canceled permission request closes a late track without exposing it", async () => {
  const controller = new AbortController();
  const late = track();
  let resolve!: (value: typeof late) => void;
  const result = acquirePreviewTrack(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
    controller.signal,
  );
  controller.abort();
  resolve(late);
  assert.equal(await result, undefined);
  assert.equal(late.stops, 1);
  assert.equal(late.detaches, 1);
});

test("stopping, switching or unmounting releases an acquired preview exactly once", async () => {
  const controller = new AbortController();
  const local = track();
  assert.equal(
    await acquirePreviewTrack(async () => local, controller.signal),
    local,
  );
  assert.equal(local.stops, 0);
  controller.abort();
  controller.abort();
  assert.equal(local.stops, 1);
  assert.equal(local.detaches, 1);
});

test("an abandoned test neither starts capture nor surfaces late permission errors", async () => {
  const controller = new AbortController();
  controller.abort();
  assert.equal(
    await acquirePreviewTrack(async () => {
      throw new Error("must not acquire");
    }, controller.signal),
    undefined,
  );
  const pending = new AbortController();
  let reject!: (error: Error) => void;
  const result = acquirePreviewTrack(
    () =>
      new Promise<ReturnType<typeof track>>((_resolve, fail) => {
        reject = fail;
      }),
    pending.signal,
  );
  pending.abort();
  reject(new DOMException("Private device details", "NotAllowedError"));
  assert.equal(await result, undefined);
  await assert.rejects(
    acquirePreviewTrack(async () => {
      throw new DOMException("Denied", "NotAllowedError");
    }, new AbortController().signal),
    { name: "NotAllowedError" },
  );
  assert.match(
    deviceError(
      new DOMException("Private device details", "NotAllowedError"),
      "audio",
    ),
    /Microphone permission was denied/,
  );
  assert.match(
    deviceError(
      new DOMException("Private device details", "OverconstrainedError"),
      "video",
    ),
    /Choose another device/,
  );
  assert.doesNotMatch(
    deviceError(new Error("Private device details"), "audio"),
    /Private device/,
  );
});
