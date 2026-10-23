import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cameraOptions,
  changeBackground,
  validateBackgroundDimensions,
  readBackgroundImage,
  validateBackgroundFile,
} from "../src/background";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BackgroundControls } from "../src/background-controls";
import type { LocalVideoTrack } from "livekit-client";

test("camera options allocate no browser resources, including unsupported saved effects", async () => {
  assert.equal(cameraOptions("", { mode: "none" }).processor, undefined);
  const stopped = new Set<number>();
  for (const [index, background] of [
    { mode: "blur" } as const,
    { mode: "image", image: "data:image/jpeg;base64,AA==" } as const,
  ].entries()) {
    const processor = cameraOptions("selected", background).processor!;
    assert.equal(processor.processedTrack, undefined);
    await assert.rejects(
      processor.init({
        kind: "video",
        track: {
          stop() {
            stopped.add(index);
          },
        },
      } as never),
      /unavailable/,
    );
    await processor.destroy();
  }
  assert.equal(stopped.size, 2);
});

test("background file admission rejects SVG, oversized and empty input", () => {
  for (const type of ["image/jpeg", "image/png", "image/webp"])
    validateBackgroundFile({ type, size: 100 });
  for (const file of [
    { type: "image/svg+xml", size: 100 },
    { type: "image/png", size: 0 },
    { type: "image/jpeg", size: 5242881 },
  ])
    assert.throws(() => validateBackgroundFile(file));
});

function fakeTrack(failure = "", existing = false) {
  const events: string[] = [];
  const step = async (name: string) => {
    events.push(name);
    if (failure === name) throw Error(name + " failed");
  };
  const processor = {
    name: "covemeet-background",
    switchTo: () => step("switch"),
  };
  const source = { enabled: true, readyState: "live" };
  const track = {
    mediaStreamTrack: source,
    isMuted: false,
    async pauseUpstream() {
      assert.equal(source.enabled, false);
      await step("pause");
    },
    resumeUpstream: () => step("resume"),
    getProcessor() {
      return existing ? processor : undefined;
    },
    setProcessor: () => step("attach"),
    stop() {
      source.readyState = "ended";
      events.push("stop");
    },
    async mute() {
      this.isMuted = true;
      await step("mute");
      return this;
    },
  };
  return { events, source, track: track as unknown as LocalVideoTrack };
}
const make = () =>
  ({ async destroy() {} }) as ReturnType<typeof cameraOptions>["processor"] & {
    switchTo(): Promise<void>;
  };

test("live effect gates source before pause and resumes only the current camera", async () => {
  const { track, events } = fakeTrack();
  assert.equal(
    await changeBackground(track, { mode: "blur" }, () => true, make),
    true,
  );
  assert.deepEqual(events, ["pause", "attach", "resume"]);
});
test("None on an existing effect keeps its owned output without raw SDK replacement", async () => {
  const { track, events } = fakeTrack("", true);
  await changeBackground(track, { mode: "none" }, () => true);
  assert.deepEqual(events, ["pause", "switch", "resume"]);
});
for (const failure of ["pause", "attach", "resume", "switch"]) {
  test(`${failure} rejection stops the source and mutes without restoring a raw processor`, async () => {
    const { track, events, source } = fakeTrack(failure, failure === "switch");
    await assert.rejects(
      changeBackground(track, { mode: "blur" }, () => true, make),
      new RegExp(failure + " failed"),
    );
    assert.equal(source.readyState, "ended");
    assert.deepEqual(events.slice(-2), ["stop", "mute"]);
  });
}
test("cleanup rejection preserves the initial failure and stopped source", async () => {
  const { track, source } = fakeTrack("attach");
  track.mute = async () => {
    throw Error("cleanup failed");
  };
  const rejectedCleanup = () =>
    ({
      async destroy() {
        throw Error("destroy failed");
      },
    }) as ReturnType<typeof make>;
  await assert.rejects(
    changeBackground(track, { mode: "blur" }, () => true, rejectedCleanup),
    /attach failed/,
  );
  assert.equal(source.readyState, "ended");
});
test("revoked ownership before apply never attaches a processor", async () => {
  const { track, events } = fakeTrack();
  assert.equal(
    await changeBackground(track, { mode: "blur" }, () => false, make),
    false,
  );
  assert.deepEqual(events, ["pause", "stop", "mute"]);
});
test("revocation while attaching stops immediately and cannot resume after settling", async () => {
  const { track, events, source } = fakeTrack();
  const controller = new AbortController();
  let release!: () => void;
  track.setProcessor = () =>
    new Promise<void>((resolve) => {
      release = resolve;
    });
  const operation = changeBackground(
    track,
    { mode: "blur" },
    () => true,
    make,
    controller.signal,
  );
  while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  assert.equal(source.readyState, "ended");
  release();
  assert.equal(await operation, false);
  assert(!events.includes("resume"));
});
test("a user-muted camera remains muted after effect completion", async () => {
  const { track, events } = fakeTrack();
  track.isMuted = true;
  await changeBackground(track, { mode: "blur" }, () => true, make);
  assert.deepEqual(events, ["pause", "attach"]);
});

test("oversized encoded dimensions reject before browser decoding", async () => {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  bytes.set([73, 72, 68, 82], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, 8193);
  view.setUint32(20, 1);
  let decoded = false;
  const saved = globalThis.createImageBitmap;
  globalThis.createImageBitmap = (() => {
    decoded = true;
    throw Error("decode must not run");
  }) as typeof createImageBitmap;
  try {
    await assert.rejects(
      readBackgroundImage(
        new File([bytes], "oversized.png", { type: "image/png" }),
      ),
      /8192/,
    );
    assert.equal(decoded, false);
    view.setUint32(16, 640);
    view.setUint32(20, 360);
    validateBackgroundDimensions(bytes, "image/png");
    assert.throws(() =>
      validateBackgroundDimensions(new Uint8Array([1, 2, 3]), "image/jpeg"),
    );
  } finally {
    globalThis.createImageBitmap = saved;
  }
});

test("capture allocation rejection closes input and failed restart clears active intent", async () => {
  const names = [
    "document",
    "OffscreenCanvas",
    "VideoFrame",
    "createImageBitmap",
  ] as const;
  const original = names.map((name) =>
    Object.getOwnPropertyDescriptor(globalThis, name),
  );
  const gl = {
    getExtension() {
      return { loseContext() {} };
    },
  };
  Object.assign(globalThis, {
    document: {
      createElement(name: string) {
        return name === "canvas"
          ? {
              getContext() {
                return gl;
              },
              captureStream() {
                throw Error("capture allocation failed");
              },
            }
          : {};
      },
    },
    OffscreenCanvas: class {
      getContext() {
        return gl;
      }
    },
    VideoFrame: class {},
    createImageBitmap() {},
  });
  const source = {
    readyState: "live",
    stop() {
      this.readyState = "ended";
    },
    getSettings() {
      return { width: 640, height: 360 };
    },
  };
  try {
    let failures = 0;
    const processor = cameraOptions(
      "",
      { mode: "blur" },
      {
        onError: () => {
          failures++;
        },
      },
    ).processor!;
    await assert.rejects(
      processor.init({ track: source, kind: "video" } as never),
      /capture allocation failed/,
    );
    assert.equal(failures, 0);
    source.readyState = "live";
    await assert.rejects(
      processor.restart({ track: source, kind: "video" } as never),
      /capture allocation failed/,
    );
    assert.equal(failures, 1);
    await processor.destroy();
    assert.equal(source.readyState, "ended");
  } finally {
    names.forEach((name, index) => {
      if (original[index])
        Object.defineProperty(globalThis, name, original[index]!);
      else Reflect.deleteProperty(globalThis, name);
    });
  }
});

test("unsupported saved effects keep the None recovery action available", () => {
  const markup = renderToStaticMarkup(
    createElement(BackgroundControls, {
      value: { mode: "blur" },
      onChange() {},
    }),
  );
  assert.match(markup, /<fieldset class="background-controls">/);
  assert.match(markup, /<button[^>]*aria-pressed="false"[^>]*>None/);
  assert.match(markup, /<button[^>]*disabled=""[^>]*>Blur/);
});
