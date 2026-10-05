import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { RoomEvent, TrackKind, TrackSource } from "@livekit/rtc-node";
import {
  RtcBridge,
  openRtcBridge,
  eligibleAudio,
  type RtcResources,
} from "../src/rtc.js";
import type { CallPolicy, MeetingGrant } from "../src/authority.js";
import { AudioBridgeOpenError } from "../src/relay.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await delay(2);
  }
  throw new Error("Condition did not become true");
}
const grant: MeetingGrant = {
  token: "t".repeat(64),
  cookie: `mp_CUSTOMCODE=${"s".repeat(48)}`,
  url: "wss://meet.example.test",
  subscribeParticipantIds: [],
};
const policy: CallPolicy = {
  state: "admitted",
  mediaVersion: 1,
  muted: false,
  handRaised: false,
  audioAllowed: true,
  leaseExpiresAt: Date.now() + 10000,
  expiresAt: Date.now() + 60000,
  grant,
};
function fixture(openHolding = false) {
  const roomName = "phone-hold-1234567890123456";
  const events: string[] = [],
    opening = deferred(),
    publishing = deferred(),
    holdingClosing = deferred(),
    capture = deferred();
  let gateOpening = false,
    gatePublishing = false,
    gateHoldingClose = false,
    gateCapture = false,
    failTrackCloses = 0,
    failDisconnects = 0,
    rooms = 0;
  class FakeSource {
    disposed = false;
    clearQueue() {
      if (this.disposed) {
        events.push("flush-disposed");
        throw new Error("AudioSource handle disposed");
      }
      events.push("flush");
    }
    async captureFrame() {
      events.push("capture-start");
      if (gateCapture) await capture.promise;
      if (this.disposed) {
        events.push("capture-disposed");
        throw new Error("AudioSource handle disposed during capture");
      }
      events.push("capture-end");
    }
    async close() {
      this.disposed = true;
      events.push("source-close");
    }
  }
  class FakeRoom extends EventEmitter {
    name = "m_synthetic";
    remoteParticipants = new Map();
    localParticipant = {
      identity: "phone-app-id",
      publishTrack: async () => {
        events.push("publish-start");
        if (gatePublishing) await publishing.promise;
        events.push("publish-end");
      },
    };
    async connect() {
      events.push("connect");
    }
    async disconnect() {
      events.push("disconnect");
      if (failDisconnects > 0) {
        failDisconnects--;
        throw new Error("uncertain disconnect");
      }
    }
  }
  const holding = new FakeRoom(),
    meeting = new FakeRoom();
  if (openHolding) holding.name = roomName;
  const proxy = {
    url: "ws://127.0.0.1:1234",
    updateGrant() {},
    async close() {
      events.push("proxy-close");
    },
  };
  const resources = {
    room: () => {
      rooms++;
      return rooms === 1 ? holding : meeting;
    },
    source: () => new FakeSource(),
    track: (name: string, source: FakeSource) => ({
      async close(disposeSource: boolean) {
        events.push("track-close");
        if (disposeSource) source.disposed = true;
        if (name === "phone-return") {
          events.push("holding-track-close");
          if (gateHoldingClose) await holdingClosing.promise;
        }
        if (failTrackCloses > 0) {
          failTrackCloses--;
          throw new Error("uncertain track close");
        }
      },
    }),
    mixer: () => ({
      addStream() {
        events.push("mixer-active");
      },
      removeStream() {},
      async aclose() {
        events.push("mixer-close");
      },
      async *[Symbol.asyncIterator]() {},
    }),
    async gateway() {
      events.push("gateway-start");
      if (gateOpening) await opening.promise;
      events.push("gateway-end");
      return proxy;
    },
  } as unknown as RtcResources;
  let failures = 0;
  const bridge = new RtcBridge(
    {
      holding: {
        url: "wss://private.example.test",
        token: openHolding
          ? `header.${Buffer.from(JSON.stringify({ sub: "relay", video: { room: roomName } })).toString("base64url")}.signature`
          : "placeholder",
        roomName,
        participantIdentity: "native",
      },
      meetingOrigin: "https://meet.example.test",
    },
    () => {
      failures++;
    },
    () => {},
    resources,
  );
  return {
    resources,
    bridge,
    events,
    opening,
    publishing,
    holdingClosing,
    capture,
    meeting,
    setOpening() {
      gateOpening = true;
    },
    setPublishing() {
      gatePublishing = true;
    },
    setHoldingClose() {
      gateHoldingClose = true;
    },
    setCapture() {
      gateCapture = true;
    },
    failTrackClose(n: number) {
      failTrackCloses = n;
    },
    failDisconnect(n: number) {
      failDisconnects = n;
    },
    failures: () => failures,
  };
}

test("terminal close waits for a late gateway and never starts a late room", async () => {
  const f = fixture();
  f.setOpening();
  const joining = f.bridge.meeting(grant, policy);
  const rejected = assert.rejects(joining, /closed during gateway/);
  await until(() => f.events.includes("gateway-start"));
  let closed = false;
  const closing = f.bridge.close().then(() => {
    closed = true;
  });
  await delay(5);
  assert.equal(closed, false);
  f.opening.resolve();
  await rejected;
  await closing;
  assert(!f.events.includes("connect"));
  assert(!f.events.includes("mixer-active"));
  assert(f.events.includes("proxy-close"));
  assert.equal(f.bridge.needsReconnect, true);
});

test("terminal close waits for publishing and cannot reactivate the retired leg", async () => {
  const f = fixture();
  f.setPublishing();
  const joining = f.bridge.meeting(grant, policy);
  const rejected = assert.rejects(joining, /closed during publish/);
  await until(() => f.events.includes("publish-start"));
  let closed = false;
  const closing = f.bridge.close().then(() => {
    closed = true;
  });
  await delay(5);
  assert.equal(closed, false);
  f.publishing.resolve();
  await rejected;
  await closing;
  assert(!f.events.includes("mixer-active"));
  assert(f.events.indexOf("disconnect") > f.events.indexOf("publish-end"));
  assert.equal(f.bridge.needsReconnect, true);
});

test("failed meeting teardown stays reachable and terminal close retries it", async () => {
  const f = fixture();
  await f.bridge.meeting(grant, policy);
  f.failDisconnect(1);
  await assert.rejects(
    f.bridge.meeting(undefined, { ...policy, state: "waiting" }),
    /cleanup failed/,
  );
  const before = f.events.filter((v) => v === "disconnect").length;
  await f.bridge.close();
  assert.equal(f.events.filter((v) => v === "disconnect").length, before + 2);
  assert.equal(f.bridge.needsReconnect, true);
});

test("uncertain repeated teardown rejects final close instead of acknowledging release", async () => {
  const f = fixture();
  await f.bridge.meeting(grant, policy);
  f.failDisconnect(10);
  await assert.rejects(
    f.bridge.meeting(undefined, { ...policy, state: "waiting" }),
    /cleanup failed/,
  );
  await assert.rejects(f.bridge.close(), /cleanup failed/);
});

test("late gates after terminal close never flush disposed sources or publish again", async () => {
  const f = fixture();
  await f.bridge.meeting(grant, policy);
  await f.bridge.close();
  const published = f.events.filter(
    (event) => event === "publish-start",
  ).length;
  const opened = f.events.filter((event) => event === "gateway-start").length;
  assert.doesNotThrow(() => f.bridge.silence());
  await Promise.resolve().then(() => f.bridge.silence());
  await f.bridge.meeting(grant, policy);
  await f.bridge.close();
  assert.equal(f.events.includes("flush-disposed"), false);
  assert.equal(
    f.events.filter((event) => event === "publish-start").length,
    published,
  );
  assert.equal(
    f.events.filter((event) => event === "gateway-start").length,
    opened,
  );
  assert.equal(f.bridge.needsReconnect, true);
  assert.equal(f.failures(), 0);
});

test("late gates while native track disposal is pending remain safe and cannot restart media", async () => {
  const f = fixture();
  await f.bridge.meeting(grant, policy);
  f.setHoldingClose();
  const closing = f.bridge.close();
  await until(() => f.events.includes("holding-track-close"));
  const published = f.events.filter(
    (event) => event === "publish-start",
  ).length;
  assert.doesNotThrow(() => f.bridge.silence());
  await Promise.resolve().then(() => f.bridge.silence());
  const lateMeeting = f.bridge.meeting(grant, policy);
  f.holdingClosing.resolve();
  await Promise.all([closing, lateMeeting]);
  assert.equal(f.events.includes("flush-disposed"), false);
  assert.equal(
    f.events.filter((event) => event === "publish-start").length,
    published,
  );
  assert.equal(f.bridge.needsReconnect, true);
});

test("failed meeting disconnect retains cleanup ownership without touching its disposed audio source", async () => {
  const f = fixture();
  await f.bridge.meeting(grant, policy);
  f.failDisconnect(1);
  await assert.rejects(
    f.bridge.meeting(undefined, { ...policy, state: "waiting" }),
    /cleanup failed/,
  );
  assert(f.events.includes("track-close"));
  assert.doesNotThrow(() => f.bridge.silence());
  const disconnects = f.events.filter((event) => event === "disconnect").length;
  await f.bridge.close();
  assert.equal(f.events.includes("flush-disposed"), false);
  assert.equal(
    f.events.filter((event) => event === "disconnect").length,
    disconnects + 2,
  );
});

test("source-safe late gating does not turn failed track cleanup into a successful close", async () => {
  const f = fixture();
  await f.bridge.meeting(grant, policy);
  f.failTrackClose(2);
  const closing = f.bridge.close();
  await assert.rejects(closing, /cleanup failed/);
  assert.doesNotThrow(() => f.bridge.silence());
  await assert.rejects(f.bridge.close(), /cleanup failed/);
  assert.equal(f.events.includes("flush-disposed"), false);
  assert.equal(f.bridge.needsReconnect, true);
});

test("terminal close waits for the last holding capture before disposing its source", async () => {
  const f = fixture(true);
  f.setCapture();
  await f.bridge.open();
  await until(() => f.events.includes("capture-start"));
  let closed = false;
  const closing = f.bridge.close().then(() => {
    closed = true;
  });
  try {
    await delay(5);
    assert.equal(closed, false);
    assert.equal(f.events.includes("holding-track-close"), false);
    assert.doesNotThrow(() => f.bridge.silence());
  } finally {
    f.capture.resolve();
    await closing;
  }
  assert.equal(f.events.includes("capture-disposed"), false);
  assert.equal(f.events.includes("flush-disposed"), false);
  assert(
    f.events.indexOf("capture-end") < f.events.indexOf("holding-track-close"),
  );
  assert.equal(f.events.filter((event) => event === "capture-start").length, 1);
  const connects = f.events.filter((event) => event === "connect").length;
  await assert.rejects(f.bridge.open(), /already closed/);
  assert.equal(
    f.events.filter((event) => event === "connect").length,
    connects,
  );
  assert.equal(f.failures(), 0);
});

test("expected meeting disconnect gates and retires only the meeting leg", async () => {
  const f = fixture();
  await f.bridge.meeting(grant, policy);
  f.meeting.emit(RoomEvent.Disconnected);
  assert.equal(f.bridge.needsReconnect, true);
  await until(() => f.events.includes("proxy-close"));
  assert.equal(f.failures(), 0);
  await f.bridge.meeting(grant, policy);
  assert.equal(f.bridge.needsReconnect, false);
  await f.bridge.close();
});

test("only specifically authorized peer audio is eligible", () => {
  const ids = new Set(["allowed"]);
  assert.equal(
    eligibleAudio(
      TrackKind.KIND_AUDIO,
      TrackSource.SOURCE_MICROPHONE,
      "allowed",
      ids,
    ),
    true,
  );
  assert.equal(
    eligibleAudio(
      TrackKind.KIND_AUDIO,
      TrackSource.SOURCE_SCREENSHARE_AUDIO,
      "allowed",
      ids,
    ),
    true,
  );
  assert.equal(
    eligibleAudio(
      TrackKind.KIND_VIDEO,
      TrackSource.SOURCE_CAMERA,
      "allowed",
      ids,
    ),
    false,
  );
  assert.equal(
    eligibleAudio(
      TrackKind.KIND_AUDIO,
      TrackSource.SOURCE_MICROPHONE,
      "other",
      ids,
    ),
    false,
  );
});

test("RTC factory preserves a holding bridge whose initial cleanup failed", async () => {
  const f = fixture();
  f.failDisconnect(10);
  const roomName = "phone-hold-1234567890123456";
  const token =
    "header." +
    Buffer.from(
      JSON.stringify({ sub: "relay", video: { room: roomName } }),
    ).toString("base64url") +
    ".signature";
  const error = await openRtcBridge(
    {
      holding: {
        url: "wss://private.example.test",
        token,
        roomName,
        participantIdentity: "native",
      },
      meetingOrigin: "https://meet.example.test",
    },
    () => {},
    () => {},
    f.resources,
  ).catch((error) => error);
  assert(error instanceof AudioBridgeOpenError);
  await assert.rejects(error.bridge.close(), /cleanup failed/);
});
