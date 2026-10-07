import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  SipSupervisor,
  type SupervisorAri,
  type SupervisorConfig,
  type SupervisedMedia,
  type SetupDiagnostic,
} from "../src/supervisor.js";
import type { AriChannel } from "../src/ari.js";
import type {
  Authority,
  CallPolicy,
  JoinInput,
  PhoneSession,
} from "../src/authority.js";
import type { AudioBridge } from "../src/relay.js";
import type { CallJournal, PhoneDialog } from "../src/journal.js";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Supervisor fixture condition timed out");
}
const configuration: SupervisorConfig = {
  inboundContext: "covemeet-inbound",
  inboundExtension: "7000",
  inboundEndpoint: "fixture-phone",
  trunkId: "configured-trunk",
  credentialTimeoutMs: 3000,
  maxCallMs: 10000,
};
function fixture(t: TestContext, config: Partial<SupervisorConfig> = {}) {
  const log: string[] = [];
  const diagnostics: SetupDiagnostic[] = [];
  const joins: JoinInput[] = [];
  const live = new Map<string, AriChannel>();
  const plays: { channelId: string; id: string; sound: string }[] = [];
  const pendingPrompts = new Set<string>();
  const session: PhoneSession = {
    code: "A".repeat(26),
    participantId: randomUUID(),
    sessionToken: "s".repeat(48),
    expiresAt: Date.now() + 60000,
  };
  let policy: Partial<CallPolicy> = {};
  const bridge: AudioBridge = {
    silence() {
      log.push("silence");
    },
    async meeting(grant) {
      log.push(grant ? "meeting:admitted" : "meeting:waiting");
    },
    async close() {
      log.push("rtc:closed");
    },
  };
  const media: SupervisedMedia = {
    async open() {
      log.push("media:open");
      return bridge;
    },
    async close() {
      log.push("native:closed");
    },
  };
  const ari: SupervisorAri = {
    async answer(id) {
      log.push(`answer:${id}`);
    },
    async getChannelVariable(_id, variable) {
      return variable === "CHANNEL(endpoint)"
        ? configuration.inboundEndpoint
        : "1";
    },
    async hangup(id) {
      log.push(`hangup:${id}`);
      live.delete(id);
    },
    async getChannel(id) {
      return live.get(id);
    },
    async play(channelId, id, sound) {
      plays.push({ channelId, id, sound });
      log.push(`play:${sound}`);
      return {
        id,
        state: pendingPrompts.has(sound) ? "playing" : "done",
        target_uri: `channel:${channelId}`,
      };
    },
    async stopPlayback(id) {
      log.push(`stop-playback:${id}`);
    },
  };
  const authority: Authority = {
    async join(input) {
      joins.push(structuredClone(input));
      log.push("authority:join");
      return session;
    },
    async action(_session, _id, action) {
      log.push(`authority:${action}`);
      return {
        state: action === "leave" ? "ended" : "waiting",
        mediaVersion: 0,
        muted: true,
        handRaised: false,
        audioAllowed: true,
        leaseExpiresAt: Date.now() + 10000,
        expiresAt: Date.now() + 60000,
        ...policy,
      };
    },
  };
  let constructionFails = false;
  const ownerId = randomUUID();
  let outcome: CallJournal["createOutcome"] = "unattempted";
  let uncertain = false;
  let playbackRevision = 0;
  const journal: CallJournal = {
    ownerId,
    get createOutcome() {
      return outcome;
    },
    async reserve() {
      log.push("journal:reserve");
      outcome = "reserved";
    },
    async mutate(operation, action) {
      log.push(`journal:begin:${operation}`);
      const result = await action({
        playbackId: `cm-play-${randomUUID()}-${++playbackRevision}`,
      } as PhoneDialog);
      log.push(`journal:confirmed:${operation}`);
      return result;
    },
    async holding() {},
    async uncertain() {
      uncertain = true;
      log.push("journal:uncertain");
    },
    async stop() {
      log.push("journal:stop");
    },
    async finish(proof) {
      assert(Object.values(proof).every((value) => value === true));
      if (uncertain) throw new Error("synthetic unresolved allocation");
      log.push("journal:finish");
    },
  };
  const supervisor = new SipSupervisor(
    { ...configuration, ...config },
    ari,
    authority,
    () => {
      if (constructionFails) throw new Error("synthetic allocation failure");
      return media;
    },
    { forCall: () => journal },
    (diagnostic) => diagnostics.push(diagnostic),
  );
  t.after(async () => {
    await supervisor.stop().catch(() => {});
  });
  function channel(id = `in-${randomUUID()}`): AriChannel {
    return {
      id,
      name: `PJSIP/fixture-${id}`,
      state: "Up",
      caller: { name: "Synthetic", number: "+15555550123" },
      dialplan: {
        context: configuration.inboundContext,
        exten: configuration.inboundExtension,
        priority: 1,
      },
    };
  }
  function start(c = channel(), args = ["inbound"]) {
    live.set(c.id, c);
    supervisor.onEvent({ type: "StasisStart", channel: c, args });
    return c;
  }
  function digits(c: AriChannel, value: string) {
    for (const digit of value)
      supervisor.onEvent({
        type: "ChannelDtmfReceived",
        channel: c,
        digit,
        duration_ms: 60,
      });
  }
  async function credentials(
    c: AriChannel,
    code = "123456789012",
    pin = "12345678",
  ) {
    await until(() =>
      plays.some((p) => p.channelId === c.id && p.sound === "covemeet-code"),
    );
    digits(c, `${code}#${pin}#`);
  }
  function complete(sound: string, state = "done", target?: string) {
    const play = plays.findLast((p) => p.sound === sound)!;
    assert.ok(play, `Expected ${sound} prompt`);
    supervisor.onEvent({
      type: "PlaybackFinished",
      playback: {
        id: play.id,
        state,
        target_uri: target ?? `channel:${play.channelId}`,
      },
    });
  }
  return {
    supervisor,
    ari,
    authority,
    media,
    bridge,
    log,
    diagnostics,
    plays,
    joins,
    pendingPrompts,
    live,
    start,
    channel,
    digits,
    credentials,
    complete,
    constructionFails() {
      constructionFails = true;
    },
    policy(value: Partial<CallPolicy>) {
      policy = { ...policy, ...value };
    },
    journal,
    setCreateOutcome(value: CallJournal["createOutcome"]) {
      outcome = value;
    },
    grant: {
      token: "t".repeat(64),
      url: "wss://meet.localhost:8443",
      cookie: `mp_${session.code}=${session.sessionToken}`,
      subscribeParticipantIds: [],
    },
  };
}

for (const variable of [
  "CHANNEL(endpoint)",
  "CHANNEL(pjsip,secure)",
  "CHANNEL(rtp,secure)",
] as const)
  test(`supervisor rejects an untrusted ${variable} before credentials or media`, async (t) => {
    const f = fixture(t),
      original = f.ari.getChannelVariable;
    f.ari.getChannelVariable = async (id, name) =>
      name === variable ? "wrong" : original(id, name);
    const c = f.start();
    await until(() => f.log.includes(`hangup:${c.id}`));
    await until(() => f.supervisor.status.calls === 0);
    assert.equal(f.joins.length, 0);
    assert.equal(f.plays.length, 0);
    assert.equal(f.log.includes("media:open"), false);
    if (variable === "CHANNEL(endpoint)")
      assert.equal(f.log.includes(`answer:${c.id}`), false);
  });

test("failed SRTP check emits only redacted setup state and closes the call", async (t) => {
  const f = fixture(t);
  const original = f.ari.getChannelVariable;
  f.ari.getChannelVariable = (id, name) =>
    name === "CHANNEL(rtp,secure)" ? Promise.resolve("0") : original(id, name);
  const c = f.start();
  await until(() => f.supervisor.status.calls === 0);
  assert.deepEqual(f.diagnostics, [
    { stage: "security", signaling: "1", media: "0", ended: false },
  ]);
  assert(f.log.includes(`hangup:${c.id}`));
  assert.equal(f.plays.length, 0);
  assert.equal(f.joins.length, 0);
  assert(f.log.includes("journal:finish"));
});

test("early channel end reports closure without setup values or credentials", async (t) => {
  const f = fixture(t);
  const pending = deferred<string>();
  f.ari.getChannelVariable = () => pending.promise;
  const c = f.start();
  f.supervisor.onEvent({ type: "ChannelDestroyed", channel: c });
  pending.resolve(configuration.inboundEndpoint);
  await until(() => f.supervisor.status.calls === 0);
  assert.deepEqual(f.diagnostics, [
    {
      stage: "channel-ended",
      signaling: "unavailable",
      media: "unavailable",
      ended: true,
    },
  ]);
  assert.equal(f.plays.length, 0);
});

test("supervisor accepts exact string credentials, preserves leading zeros, and fixes trunk identity", async (t) => {
  const f = fixture(t),
    c = f.start();
  await f.credentials(c, "000123456789", "00123456");
  await until(() => f.log.includes("meeting:waiting"));
  assert.equal(f.joins.length, 1);
  assert.equal(f.joins[0].locator, "000123456789");
  assert.equal(f.joins[0].pin, "00123456");
  assert.equal(f.joins[0].trunkId, "configured-trunk");
  assert.equal(f.joins[0].callerId, "+15555550123");
  assert.match(f.joins[0].callId, /^[0-9a-f-]{36}$/);
  assert(f.log.indexOf("play:covemeet-waiting") < f.log.indexOf("media:open"));
});

for (const [name, value] of [
  ["short locator", "123#"],
  ["long locator", "1234567890123"],
  ["short PIN", "123456789012#123#"],
  ["long PIN", "123456789012#123456789"],
])
  test(`supervisor rejects ${name} without an authority request`, async (t) => {
    const f = fixture(t),
      c = f.start();
    await until(() => f.plays.length === 1);
    f.digits(c, value);
    await until(() => f.supervisor.status.calls === 0);
    assert.equal(f.joins.length, 0);
    assert(f.log.includes(`hangup:${c.id}`));
  });

test("supervisor bounds queued DTMF and retains local cap while cleanup is uncertain", async (t) => {
  const f = fixture(t, { maxCalls: 2 }),
    a = f.start(),
    b = f.start(),
    rejected = f.start();
  await until(() => f.log.includes(`hangup:${rejected.id}`));
  assert.equal(f.supervisor.status.calls, 2);
  await until(() => f.plays.length === 2);
  f.media.close = async () => {
    throw new Error("unconfirmed cleanup");
  };
  f.digits(a, "1".repeat(33));
  await until(() => f.supervisor.status.unresolved === 1);
  assert.equal(f.supervisor.status.calls, 2);
  const next = f.start();
  await until(() => f.log.includes(`hangup:${next.id}`));
  assert.equal(f.joins.length, 0);
  assert(f.live.has(b.id));
});

test("supervisor waits for targeted waiting and admission announcements before media", async (t) => {
  const f = fixture(t),
    c = f.start();
  f.pendingPrompts.add("covemeet-waiting");
  f.pendingPrompts.add("covemeet-admitted");
  f.policy({ state: "admitted", mediaVersion: 1, grant: f.grant });
  await f.credentials(c);
  await until(() => f.plays.some((p) => p.sound === "covemeet-waiting"));
  assert.equal(f.log.includes("media:open"), false);
  f.complete("covemeet-waiting", "done", "channel:unrelated");
  await delay(10);
  assert.equal(f.log.includes("media:open"), false);
  f.complete("covemeet-waiting");
  await until(() => f.plays.some((p) => p.sound === "covemeet-admitted"));
  assert.equal(f.log.includes("meeting:admitted"), false);
  f.complete("covemeet-admitted");
  await until(() => f.log.includes("meeting:admitted"));
});

test("a failed mandatory announcement closes native call without opening RTC and releases after confirmed cleanup", async (t) => {
  const f = fixture(t),
    c = f.start();
  f.pendingPrompts.add("covemeet-waiting");
  await f.credentials(c);
  await until(() => f.plays.some((p) => p.sound === "covemeet-waiting"));
  f.complete("covemeet-waiting", "failed");
  await until(() => f.supervisor.status.calls === 0);
  assert.equal(f.log.includes("media:open"), false);
  assert(f.log.indexOf("authority:leave") > f.log.indexOf("native:closed"));
  assert(f.log.indexOf("authority:leave") > f.log.indexOf(`hangup:${c.id}`));
});

test("hanging up during late endpoint verification prevents answer and prompts", async (t) => {
  const f = fixture(t),
    pending = deferred<string>();
  f.ari.getChannelVariable = () => pending.promise;
  const c = f.start();
  const stopping = f.supervisor.stop();
  await delay(5);
  assert.equal(
    f.log.some((item) => item.startsWith("answer:")),
    false,
  );
  pending.resolve(configuration.inboundEndpoint);
  await stopping;
  assert.equal(f.plays.length, 0);
  assert.equal(f.log.includes("media:open"), false);
  assert(f.log.includes(`hangup:${c.id}`));
});

test("hanging up during waiting announcement prevents late media opening", async (t) => {
  const f = fixture(t),
    c = f.start();
  f.pendingPrompts.add("covemeet-waiting");
  await f.credentials(c);
  await until(() => f.plays.some((p) => p.sound === "covemeet-waiting"));
  f.supervisor.onEvent({ type: "ChannelDestroyed", channel: c });
  await until(() => f.supervisor.status.calls === 0);
  assert.equal(f.log.includes("media:open"), false);
  f.complete("covemeet-waiting");
  await delay(5);
  assert.equal(f.log.includes("media:open"), false);
});

test("authority-ended calls close both legs and acknowledge leave", async (t) => {
  const f = fixture(t),
    c = f.start();
  await f.credentials(c);
  await until(() => f.log.includes("meeting:waiting"));
  f.policy({ state: "ended" });
  f.digits(c, "*9");
  await until(() => f.supervisor.status.calls === 0);
  assert(f.log.includes("authority:toggle-hand"));
  assert(f.log.includes("rtc:closed"));
  assert(f.log.includes(`hangup:${c.id}`));
  assert(f.log.indexOf("authority:leave") > f.log.indexOf("rtc:closed"));
});

test("unknown application channels are hung up; failed media construction retains its reservation", async (t) => {
  const f = fixture(t);
  const wrongContext = f.channel();
  wrongContext.dialplan!.context = "other-context";
  f.start(wrongContext);
  const wrongArgs = f.start(f.channel(), ["unexpected"]);
  f.constructionFails();
  const allocation = f.start();
  await until(() =>
    [wrongContext, wrongArgs, allocation].every((c) =>
      f.log.includes(`hangup:${c.id}`),
    ),
  );
  assert.equal(f.supervisor.status.calls, 1);
  assert.equal(f.supervisor.status.unresolved, 1);
  assert.equal(f.log.includes("journal:finish"), false);
  assert.equal(f.joins.length, 0);
});

test("early DTMF waits for late prompt creation before cancelling and starting the PIN prompt", async (t) => {
  const f = fixture(t),
    pending = deferred<void>();
  const original = f.ari.play;
  let codePlayback = "";
  f.ari.play = async (channelId, id, sound) => {
    if (sound === "covemeet-code") {
      codePlayback = id;
      f.log.push("code:requested");
      await pending.promise;
      f.log.push("code:created");
    }
    return original(channelId, id, sound);
  };
  const c = f.start();
  await until(() => f.log.includes("code:requested"));
  f.digits(c, "123456789012#");
  await delay(10);
  assert.equal(
    f.log.some((item) => item.startsWith("stop-playback:")),
    false,
    "Cancellation must not accept a 404 before the pending prompt POST settles",
  );
  assert.equal(
    f.plays.some((p) => p.sound === "covemeet-pin"),
    false,
  );
  pending.resolve();
  await until(() => f.plays.some((p) => p.sound === "covemeet-pin"));
  assert(
    f.log.indexOf("code:created") <
      f.log.indexOf(`stop-playback:${codePlayback}`),
  );
  assert(
    f.log.indexOf(`stop-playback:${codePlayback}`) <
      f.log.indexOf("play:covemeet-pin"),
  );
  assert.equal(f.joins.length, 0);
});

test("supervisor reserves before answer and finishes only after journal revocation and both media paths close", async (t) => {
  const f = fixture(t),
    c = f.start();
  await f.credentials(c);
  await until(() => f.log.includes("meeting:waiting"));
  await f.supervisor.stop();
  assert.equal(f.joins[0].ownerId, f.journal.ownerId);
  assert(f.log.indexOf("journal:reserve") < f.log.indexOf(`answer:${c.id}`));
  assert(
    f.log.indexOf("journal:begin:answer") < f.log.indexOf(`answer:${c.id}`),
  );
  assert(f.log.indexOf("journal:stop") < f.log.indexOf("rtc:closed"));
  assert(f.log.indexOf("journal:stop") < f.log.indexOf("native:closed"));
  assert(f.log.indexOf("journal:finish") > f.log.indexOf("authority:leave"));
  assert(f.log.indexOf("journal:finish") > f.log.indexOf(`hangup:${c.id}`));
});

test("definitively rejected reservation releases local slot only after caller closure", async (t) => {
  const f = fixture(t);
  f.journal.reserve = async () => {
    f.setCreateOutcome("rejected");
    throw new Error("denied");
  };
  const c = f.start();
  await until(() => f.supervisor.status.calls === 0);
  assert(f.log.includes(`hangup:${c.id}`));
  assert.equal(f.log.includes(`answer:${c.id}`), false);
  assert.equal(f.log.includes("journal:finish"), false);
});

test("unknown reservation outcome retains local slot even after caller cleanup", async (t) => {
  const f = fixture(t);
  f.journal.reserve = async () => {
    f.setCreateOutcome("unknown");
    throw new Error("lost create response");
  };
  const c = f.start();
  await until(() => f.log.includes(`hangup:${c.id}`));
  await assert.rejects(f.supervisor.stop());
  assert.equal(f.supervisor.status.calls, 1);
  assert.equal(f.supervisor.status.unresolved, 1);
  assert.equal(f.log.includes(`answer:${c.id}`), false);
  assert.equal(f.log.includes("journal:finish"), false);
});

test("lost join response still stops its journal before native teardown", async (t) => {
  const f = fixture(t),
    c = f.start();
  f.authority.join = async () => {
    f.log.push("binding:created");
    throw new Error("join response lost");
  };
  await f.credentials(c);
  await until(() => f.supervisor.status.calls === 0);
  assert(f.log.indexOf("journal:stop") > f.log.indexOf("binding:created"));
  assert(f.log.indexOf("journal:stop") < f.log.indexOf("native:closed"));
  assert(f.log.includes("journal:finish"));
  assert.equal(f.log.includes("authority:leave"), false);
});

test("failed journal stop does not prevent caller cleanup and cannot release reservation", async (t) => {
  const f = fixture(t),
    c = f.start();
  await f.credentials(c);
  await until(() => f.log.includes("meeting:waiting"));
  f.journal.stop = async () => {
    throw new Error("revoke unavailable");
  };
  await assert.rejects(f.supervisor.stop());
  assert(f.log.includes(`hangup:${c.id}`));
  assert(f.log.includes("rtc:closed"));
  assert(f.log.includes("native:closed"));
  assert.equal(f.log.includes("journal:finish"), false);
  assert.equal(f.supervisor.status.calls, 1);
});

for (const operation of ["answer", "play"] as const)
  test(`late ${operation} journal acknowledgment cannot issue ARI after local termination`, async (t) => {
    const f = fixture(t),
      entered = deferred(),
      pending = deferred();
    const mutate = f.journal.mutate;
    f.journal.mutate = async (name, action) => {
      if (name === operation) {
        entered.resolve();
        await pending.promise;
      }
      return mutate(name, action);
    };
    const c = f.start();
    await entered.promise;
    const stopping = f.supervisor.stop();
    pending.resolve();
    await stopping;
    if (operation === "answer")
      assert.equal(f.log.includes(`answer:${c.id}`), false);
    assert.equal(f.plays.length, 0);
    assert(f.log.includes(`hangup:${c.id}`));
    assert.equal(f.supervisor.status.calls, 0);
  });
