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
function fixture() {
  const events: string[] = [],
    opening = deferred(),
    publishing = deferred();
  let gateOpening = false,
    gatePublishing = false,
    failDisconnects = 0,
    rooms = 0;
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
    source: () => ({
      clearQueue() {
        events.push("flush");
      },
      async close() {
        events.push("source-close");
      },
    }),
    track: () => ({
      async close() {
        events.push("track-close");
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
        token: "placeholder",
        roomName: "phone-hold-1234567890123456",
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
    meeting,
    setOpening() {
      gateOpening = true;
    },
    setPublishing() {
      gatePublishing = true;
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
