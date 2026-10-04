import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  PhoneRelay,
  AudioBridgeOpenError,
  type AudioBridge,
} from "../src/relay.js";
import {
  PhoneActionDenied,
  type Authority,
  type CallPolicy,
  type MeetingGrant,
  type PhoneSession,
} from "../src/authority.js";
import { FrameQueue } from "../src/audio.js";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function until(predicate: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Test condition timed out");
}
function fixture() {
  const callId = randomUUID(),
    session: PhoneSession = {
      code: "A".repeat(26),
      participantId: randomUUID(),
      sessionToken: "s".repeat(48),
      expiresAt: Date.now() + 10000,
    };
  const grant: MeetingGrant = {
    token: "t".repeat(64),
    url: "wss://meet.localhost:8443",
    cookie: `mp_${session.code}=${session.sessionToken}`,
    subscribeParticipantIds: [randomUUID()],
  };
  let policy: CallPolicy = {
    state: "waiting",
    mediaVersion: 0,
    muted: true,
    handRaised: false,
    audioAllowed: true,
    expiresAt: Date.now() + 30000,
    leaseExpiresAt: Date.now() + 1000,
  };
  const events: string[] = [],
    meetings: (MeetingGrant | undefined)[] = [],
    refreshes: MeetingGrant[] = [];
  const bridge: AudioBridge = {
    needsReconnect: false,
    silence() {
      events.push("gate");
    },
    async meeting(g) {
      meetings.push(g);
      events.push(g ? "meeting" : "waiting");
    },
    refreshGrant(g) {
      refreshes.push(g);
    },
    async close() {
      events.push("bridge-closed");
    },
  };
  const authority: Authority = {
    async join() {
      events.push("join");
      return session;
    },
    async action(_session, _callId, action) {
      events.push(action);
      return structuredClone(policy);
    },
  };
  let terminated = 0,
    dtmf!: (digit: string) => void;
  const deps = {
    authority,
    async openBridge(_fail: () => void, handler: (digit: string) => void) {
      dtmf = handler;
      return bridge;
    },
    async terminateNative() {
      terminated++;
      events.push("native-closed");
    },
  };
  const relay = new PhoneRelay(
    { locator: "123456789012", pin: "12345678", callId, trunkId: "local-test" },
    deps,
  );
  return {
    relay,
    session,
    grant,
    events,
    meetings,
    refreshes,
    bridge,
    authority,
    deps,
    setPolicy(value: Partial<CallPolicy>) {
      policy = { ...policy, ...value };
    },
    getPolicy() {
      return policy;
    },
    terminated: () => terminated,
    dtmf: (digit: string) => dtmf(digit),
  };
}

test("waiting has no meeting grant; admission installs granted scope; same policy refreshes token without reconnect", async () => {
  const f = fixture(),
    run = f.relay.run();
  await until(() => f.events.includes("waiting"));
  assert.deepEqual(f.meetings, [undefined]);
  f.setPolicy({ state: "admitted", mediaVersion: 1, grant: f.grant });
  await f.relay.action("poll");
  assert.equal(f.meetings.length, 2);
  assert.deepEqual(f.meetings[1], f.grant);
  const refreshed = { ...f.grant, token: "renewed".repeat(20) };
  f.setPolicy({ grant: refreshed });
  await f.relay.action("poll");
  assert.equal(f.meetings.length, 2);
  assert.deepEqual(f.refreshes.at(-1), refreshed);
  await f.relay.stop();
  await run;
});

test("permission generation reconnect clears queues first and retains native caller", async () => {
  const f = fixture();
  f.setPolicy({ state: "admitted", grant: f.grant });
  const run = f.relay.run();
  await until(() => f.meetings.length === 1);
  f.events.length = 0;
  f.setPolicy({ mediaVersion: 2, audioAllowed: false });
  await f.relay.action("poll");
  assert(f.events.indexOf("gate") < f.events.indexOf("meeting"));
  assert.equal(f.terminated(), 0);
  await f.relay.stop();
  await run;
});

test("capacity release follows both successful closures; public leave cannot bypass teardown", async () => {
  const f = fixture(),
    bridgeClosed = deferred(),
    nativeClosed = deferred();
  f.bridge.close = async () => {
    await bridgeClosed.promise;
    f.events.push("bridge-closed");
  };
  f.deps.terminateNative = async () => {
    await nativeClosed.promise;
    f.events.push("native-closed");
  };
  const run = f.relay.run();
  await until(() => f.events.includes("waiting"));
  const stopped = f.relay.action("leave");
  await delay(10);
  assert(!f.events.includes("leave"));
  bridgeClosed.resolve();
  await delay(10);
  assert(!f.events.includes("leave"));
  nativeClosed.resolve();
  await stopped;
  await run;
  assert(f.events.indexOf("leave") > f.events.indexOf("native-closed"));
  assert(f.events.indexOf("leave") > f.events.indexOf("bridge-closed"));
});

test("failed native teardown retains reserved capacity and surfaces reconciliation failure", async () => {
  const f = fixture();
  f.deps.terminateNative = async () => {
    throw new Error("offline");
  };
  const run = f.relay.run();
  const observed = run.catch((error) => error);
  await until(() => f.events.includes("waiting"));
  await assert.rejects(f.relay.stop(), /reconciliation/);
  assert(!f.events.includes("leave"));
  assert.match(String(await observed), /reconciliation/);
});

test("admitted expiry can exceed initial lobby expiry", async () => {
  const f = fixture();
  f.session.expiresAt = Date.now() + 120;
  f.setPolicy({
    state: "admitted",
    grant: f.grant,
    expiresAt: Date.now() + 3000,
    leaseExpiresAt: Date.now() + 1000,
  });
  const run = f.relay.run();
  await until(() => f.meetings.length === 1);
  await delay(170);
  assert.equal(f.terminated(), 0);
  await f.relay.action("poll");
  await f.relay.stop();
  await run;
});

test("lease watchdog gates and closes even while authority poll is stalled", async () => {
  const f = fixture();
  f.setPolicy({
    state: "admitted",
    grant: f.grant,
    leaseExpiresAt: Date.now() + 150,
  });
  const run = f.relay.run();
  const observed = run.catch((error) => error);
  await until(() => f.meetings.length === 1);
  const pending = deferred<CallPolicy>(),
    original = f.authority.action;
  f.authority.action = async (s, c, a) =>
    a === "poll" ? pending.promise : original(s, c, a);
  const poll = f.relay.action("poll");
  await until(() => f.terminated() === 1);
  assert(f.events.includes("gate"));
  assert(f.events.includes("leave"));
  pending.resolve(f.getPolicy());
  await poll;
  assert.match(String(await observed), /failure/);
});

test("unexpected cookie grant fails closed without connecting meeting", async () => {
  const f = fixture();
  f.setPolicy({
    state: "admitted",
    grant: { ...f.grant, cookie: `mp_${f.session.code}=${"wrong".repeat(10)}` },
  });
  await assert.rejects(f.relay.run(), /failure/);
  assert.equal(f.meetings.length, 0);
  assert.equal(f.terminated(), 1);
});

test("speaking denial does not end call; unknown keypad commands cannot send arbitrary authority actions", async () => {
  const f = fixture(),
    run = f.relay.run();
  await until(() => f.events.includes("waiting"));
  const original = f.authority.action;
  f.authority.action = async (s, c, a) => {
    if (a === "toggle-mute") throw new PhoneActionDenied();
    return original(s, c, a);
  };
  await f.relay.action("toggle-mute");
  assert.equal(f.terminated(), 0);
  f.dtmf("*");
  f.dtmf("0");
  f.dtmf("1");
  await delay(10);
  assert.equal(f.terminated(), 0);
  await f.relay.stop();
  await run;
});

test("late bridge opening is closed before leave acknowledgement", async () => {
  const f = fixture(),
    opening = deferred<AudioBridge>();
  f.deps.openBridge = async () => opening.promise;
  const run = f.relay.run();
  await until(() => f.events.includes("join"));
  await delay(5);
  const stopped = f.relay.stop();
  await delay(10);
  assert(!f.events.includes("leave"));
  opening.resolve(f.bridge);
  await stopped;
  await run;
  assert(f.events.indexOf("bridge-closed") < f.events.indexOf("leave"));
});

test("audio queue bounds latency and discards everything on revoke", () => {
  const queue = new FrameQueue<number>(3);
  for (let i = 0; i < 100; i++) queue.push(i);
  assert.equal(queue.size, 3);
  assert.equal(queue.shift(), 97);
  queue.clear();
  assert.equal(queue.shift(), undefined);
});

test("initial holding cleanup failure remains owned and prevents authority release", async () => {
  const f = fixture();
  let attempts = 0;
  f.bridge.close = async () => {
    attempts++;
    throw new Error("holding cleanup failed");
  };
  f.deps.openBridge = async () => {
    throw new AudioBridgeOpenError(f.bridge);
  };
  await assert.rejects(f.relay.run(), /reconciliation/);
  assert.equal(attempts, 1);
  assert.equal(f.terminated(), 1);
  assert(!f.events.includes("leave"));
});

test("failed open with confirmed cleanup releases only after both paths close", async () => {
  const f = fixture();
  f.deps.openBridge = async () => {
    throw new AudioBridgeOpenError(f.bridge);
  };
  await assert.rejects(f.relay.run(), /failure/);
  assert(f.events.indexOf("leave") > f.events.indexOf("bridge-closed"));
  assert(f.events.indexOf("leave") > f.events.indexOf("native-closed"));
});

test("unknown opening rejection retains capacity but still attempts native termination", async () => {
  const f = fixture();
  f.deps.openBridge = () => {
    throw new Error("synchronous allocation failure");
  };
  await assert.rejects(f.relay.run(), /reconciliation/);
  assert.equal(f.terminated(), 1);
  assert(!f.events.includes("leave"));
});
