import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  AccessToken,
  RoomServiceClient,
  TrackSource as ServerSource,
} from "livekit-server-sdk";
import { createApp } from "../../apps/api/dist/server.js";
import { loadConfig } from "../../apps/api/dist/config.js";
import { PgStore } from "../../apps/api/dist/store.js";
import { LiveMedia } from "../../apps/api/dist/media.js";
import {
  HttpAuthority,
  PhoneRelay,
  openRtcBridge,
} from "../../apps/phone/dist/index.js";
import { openGateway } from "../../apps/phone/dist/gateway.js";

// Isolated, programmatic audio only. This file never opens a device, browser,
// player, audio output, carrier connection, or raw-audio file.
process.umask(0o077);
process.env.RUST_LOG = "error";
const {
  Room,
  RoomEvent,
  TrackKind,
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  TrackPublishOptions,
  TrackSource,
  dispose,
} = await import("@livekit/rtc-node");
const databaseUrl = new URL(
  process.env.PHONE_TEST_DATABASE_URL || "http://invalid",
);
assert(
  ["phone-postgres", "127.0.0.1", "localhost"].includes(databaseUrl.hostname),
  "Disposable database required",
);
assert.equal(
  databaseUrl.pathname,
  "/covemeet_phone_test",
  "Wrong disposable database",
);
const sfuUrl = new URL(process.env.LIVEKIT_URL || "http://invalid");
assert(
  ["livekit", "phone-livekit", "127.0.0.1", "localhost"].includes(
    sfuUrl.hostname,
  ),
  "Private fixture SFU required",
);
assert(["http:", "https:"].includes(sfuUrl.protocol));
assert(
  process.env.LIVEKIT_API_KEY && process.env.LIVEKIT_API_SECRET,
  "Fixture credentials required",
);
const holdingUrl = new URL(sfuUrl);
holdingUrl.protocol = sfuUrl.protocol === "https:" ? "wss:" : "ws:";
const runId = randomUUID(),
  callId = randomUUID();
const reportPath = path.resolve(
  process.env.PHONE_VALIDATION_REPORT || "test-results/phone/phone-media.json",
);
const report = {
  runId,
  startedAt: new Date().toISOString(),
  result: "running",
  scope:
    "Isolated PostgreSQL + LiveKit RTC stand-in for SIP holding; real application admission and audio relay",
  safety: {
    physicalDevices: false,
    browser: false,
    speakerPlayback: false,
    rawAudioSaved: false,
    isolatedProgrammaticPcm: true,
  },
  limitations: [
    "RTC peers stand in for native SIP: no SIP, carrier, IVR prompts, TLS/SRTP trunk negotiation, or production capacity is established.",
  ],
  checks: [],
  cleanup: {},
};
await mkdir(path.dirname(reportPath), { recursive: true });
const save = () =>
  writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
async function check(name, evidence = {}) {
  report.checks.push({ name, passed: true, ...evidence });
  await save();
  console.log(`PASS ${name}`);
}
async function bounded(promise, label, ms = 12_000) {
  if (!cleaning) report.pendingOperation = label;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
let relayFailure,
  cleaning = false;
async function until(label, fn, ms = 12_000) {
  const end = Date.now() + ms;
  do {
    if (relayFailure && !cleaning)
      throw new Error("Relay failed before validation completed");
    const result = await bounded(
      Promise.resolve().then(fn),
      label,
      Math.min(4000, ms),
    );
    if (result) return result;
    await delay(150);
  } while (Date.now() < end);
  throw new Error(`Timed out: ${label}`);
}
const watchdog = setTimeout(() => {
  report.result = "failed";
  report.failure = "Global 180-second validation deadline exceeded";
  void save().finally(() => process.exit(1));
}, 180_000);
const config = loadConfig({
  NODE_ENV: "test",
  EDITION: "hosted",
  SITE_ORIGIN: "http://127.0.0.1:1",
  SESSION_SECRET: randomBytes(40).toString("hex"),
  CREATION_KEY: randomBytes(40).toString("hex"),
  DATABASE_URL: databaseUrl.href,
  LIVEKIT_URL: sfuUrl.href,
  LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
  PHONE_ENABLED: "true",
  PHONE_GATEWAY_KEY: randomBytes(40).toString("hex"),
  PHONE_TRUNK_ID: `fixture-${runId}`,
  PHONE_SIP_ADDRESS: "sip:fixture@phone.example.test",
  PHONE_MAX_CALLS: "20",
  PHONE_LOBBY_SECONDS: "300",
  PHONE_MAX_DURATION_SECONDS: "300",
  RECORDING_ENABLED: "false",
  STATIC_DIR: "/tmp/no-phone-fixture-static",
});
const store = new PgStore(databaseUrl.href),
  media = new LiveMedia(config, store);
const sfu = new RoomServiceClient(
  sfuUrl.href,
  config.livekitKey,
  config.livekitSecret,
);
const holdingRoom = `phone-hold-${runId}`,
  nativeIdentity = `fixture-native-${runId}`,
  relayIdentity = `fixture-relay-${runId}`;
let app,
  host,
  meeting,
  hostRoom,
  nativeRoom,
  hostGateway,
  phoneRelay,
  relayRun,
  phoneSession,
  lastPolicy;
let phoneMediaIdentity;
const phoneMediaIdentities = new Set();
let nativeTerminated = false;
let releaseAfterTeardown = false;
const publishers = [],
  sinks = [];

class BrowserSession {
  cookies = new Map();
  async call(route, body, method = body === undefined ? "GET" : "POST") {
    const response = await fetch(`${config.origin}/api${route}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        Origin: config.origin,
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        "Content-Type": "application/json",
        "X-Requested-With": "MeetingPlatform",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(";", 1)[0],
        at = pair.indexOf("=");
      this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(
        `Fixture browser API rejected ${method} (${response.status})`,
      );
    }
    return response.json();
  }
}
async function scopedToken(identity) {
  const token = new AccessToken(config.livekitKey, config.livekitSecret, {
    identity,
    name: "Synthetic phone fixture",
    ttl: 300,
  });
  token.addGrant({
    room: holdingRoom,
    roomJoin: true,
    canSubscribe: true,
    canPublish: true,
    canPublishSources: [ServerSource.MICROPHONE],
    canPublishData: identity === nativeIdentity,
    canUpdateOwnMetadata: false,
  });
  return token.toJwt();
}
function observe(room, acceptsIdentity) {
  const stats = { frames: 0, nonzeroFrames: 0, peak: 0 };
  const readers = new Map(),
    tasks = [];
  let stopped = false;
  const cancel = (sid) => {
    const reader = readers.get(sid);
    readers.delete(sid);
    void reader?.cancel().catch(() => {});
  };
  const subscribed = (track, publication, participant) => {
    if (
      stopped ||
      !acceptsIdentity(participant.identity) ||
      track.kind !== TrackKind.KIND_AUDIO ||
      !publication.sid
    )
      return;
    cancel(publication.sid);
    const reader = new AudioStream(track, {
      sampleRate: 48000,
      numChannels: 1,
      frameSizeMs: 20,
    }).getReader();
    readers.set(publication.sid, reader);
    tasks.push(
      (async () => {
        try {
          while (!stopped) {
            const { done, value } = await reader.read();
            if (done || stopped) break;
            let peak = 0;
            for (const sample of value.data)
              peak = Math.max(peak, Math.abs(sample));
            stats.frames++;
            if (peak > 32) stats.nonzeroFrames++;
            stats.peak = Math.max(stats.peak, peak);
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      })().catch(() => {}),
    );
  };
  const unsubscribed = (_track, publication) => cancel(publication.sid);
  room.on(RoomEvent.TrackSubscribed, subscribed);
  room.on(RoomEvent.TrackUnsubscribed, unsubscribed);
  const sink = {
    stats,
    async close() {
      stopped = true;
      room.off(RoomEvent.TrackSubscribed, subscribed);
      room.off(RoomEvent.TrackUnsubscribed, unsubscribed);
      await Promise.allSettled(
        [...readers.values()].map((reader) => reader.cancel()),
      );
      await Promise.allSettled(tasks);
      readers.clear();
    },
  };
  sinks.push(sink);
  return sink;
}
async function publish(room, frequency) {
  const source = new AudioSource(48000, 1, 100),
    track = LocalAudioTrack.createAudioTrack("isolated-generated-pcm", source);
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_MICROPHONE;
  await bounded(
    room.localParticipant.publishTrack(track, options),
    "synthetic audio publish",
  );
  let stopping = false,
    sampleIndex = 0;
  const abort = new AbortController();
  const task = (async () => {
    while (!stopping) {
      const frame = AudioFrame.create(48000, 1, 960);
      for (let i = 0; i < frame.data.length; i++)
        frame.data[i] = Math.round(
          800 * Math.sin((2 * Math.PI * frequency * sampleIndex++) / 48000),
        );
      await source.captureFrame(frame);
      await delay(20, undefined, { signal: abort.signal }).catch(() => {});
    }
  })().catch(() => {});
  const publisher = {
    async close() {
      stopping = true;
      abort.abort();
      source.clearQueue();
      await track.close(true);
      await task;
    },
  };
  publishers.push(publisher);
  return publisher;
}
async function list(room) {
  try {
    return await sfu.listParticipants(room);
  } catch (error) {
    if (/not found|does not exist/i.test(String(error))) return [];
    throw new Error("Fixture SFU participant query failed");
  }
}
const storedPhone = async () =>
  (await store.get(meeting.code))?.participants.find(
    (p) => p.id === phoneSession?.participantId,
  );
async function hostAction(action) {
  await host.call(
    `/meetings/${meeting.code}/participants/${phoneSession.participantId}/action`,
    { action },
  );
}
async function phoneDtmf(digit) {
  await nativeRoom.localParticipant.publishDtmf(10, "*");
  await delay(80);
  await nativeRoom.localParticipant.publishDtmf(Number(digit), digit);
}
async function noUplink(sink, label) {
  await delay(600);
  const before = sink.stats.nonzeroFrames;
  await delay(1200);
  assert.equal(
    sink.stats.nonzeroFrames - before,
    0,
    `${label}: unexpected non-silent caller frames`,
  );
  return {
    observedMs: 1200,
    nonSilentFrameDelta: sink.stats.nonzeroFrames - before,
  };
}
async function run() {
  await store.init();
  await until(
    "SFU startup",
    async () => {
      try {
        await sfu.listRooms();
        return true;
      } catch {
        return false;
      }
    },
    20_000,
  );
  app = await createApp(config, store, media);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert(address && typeof address !== "string");
  config.origin = config.portalOrigin = `http://127.0.0.1:${address.port}`;
  host = new BrowserSession();
  meeting = await host.call("/meetings", {
    title: `Phone media fixture ${runId}`,
    hostName: "Synthetic host",
    mode: "meeting",
    password: randomBytes(24).toString("hex"),
    creationKey: config.creationKey,
  });
  await host.call(`/meetings/${meeting.code}/host`, {
    token: meeting.hostToken,
  });
  delete meeting.hostToken;
  const hostGrant = await host.call(`/meetings/${meeting.code}/media`, {});
  hostGateway = await openGateway(
    {
      ...hostGrant,
      cookie: `mp_${meeting.code}=${host.cookies.get(`mp_${meeting.code}`)}`,
      subscribeParticipantIds: [],
    },
    config.origin,
    true,
  );
  hostRoom = new Room();
  const hostSink = observe(hostRoom, (id) => phoneMediaIdentities.has(id));
  await bounded(
    hostRoom.connect(hostGateway.url, hostGrant.token, {
      autoSubscribe: true,
      dynacast: false,
    }),
    "host gateway connect",
  );
  await publish(hostRoom, 307);
  const meetingRow = await store.get(meeting.code);
  assert(meetingRow);
  assert.equal(hostRoom.name, meetingRow.room);
  const phoneAccess = await host.call(`/meetings/${meeting.code}/phone`, {});
  await sfu.createRoom({ name: holdingRoom, maxParticipants: 2 });
  nativeRoom = new Room();
  const nativeSink = observe(nativeRoom, (id) => id === relayIdentity);
  await bounded(
    nativeRoom.connect(holdingUrl.href, await scopedToken(nativeIdentity), {
      autoSubscribe: true,
      dynacast: false,
    }),
    "native holding connect",
  );
  await publish(nativeRoom, 601);
  const authority = new HttpAuthority(
    config.origin,
    config.phoneGatewayKey,
    true,
  );
  const observedAuthority = {
    async join(input) {
      phoneSession = await authority.join(input);
      return phoneSession;
    },
    async action(session, id, action) {
      if (action === "leave") {
        assert(
          nativeTerminated,
          "Private leave must follow native termination",
        );
        assert.equal(
          (await list(holdingRoom)).length,
          0,
          "Private leave must follow holding teardown",
        );
        assert(
          !(await list(meetingRow.room)).some((participant) =>
            phoneMediaIdentities.has(participant.identity),
          ),
          "Private leave must follow meeting-media teardown",
        );
        releaseAfterTeardown = true;
      }
      lastPolicy = await authority.action(session, id, action);
      if (lastPolicy.grant) {
        phoneMediaIdentity = JSON.parse(
          Buffer.from(
            lastPolicy.grant.token.split(".")[1],
            "base64url",
          ).toString(),
        ).sub;
        assert.equal(typeof phoneMediaIdentity, "string");
        phoneMediaIdentities.add(phoneMediaIdentity);
      }
      return lastPolicy;
    },
  };
  const holdingToken = await scopedToken(relayIdentity);
  phoneRelay = new PhoneRelay(
    {
      locator: phoneAccess.locator,
      pin: phoneAccess.pin,
      callId,
      trunkId: config.phoneTrunkId,
    },
    {
      authority: observedAuthority,
      openBridge: (failure, dtmf) =>
        openRtcBridge(
          {
            holding: {
              url: holdingUrl.href,
              token: holdingToken,
              roomName: holdingRoom,
              participantIdentity: nativeIdentity,
            },
            meetingOrigin: config.origin,
            development: true,
          },
          failure,
          dtmf,
        ),
      async terminateNative() {
        await sfu.removeParticipant(holdingRoom, nativeIdentity);
        nativeTerminated = true;
      },
      pollIntervalMs: 2000,
    },
  );
  phoneAccess.pin = "";
  relayRun = phoneRelay.run().catch((error) => {
    relayFailure = error;
  });
  await until(
    "waiting phone and holding silence",
    () => lastPolicy?.state === "waiting" && nativeSink.stats.frames > 20,
  );
  assert.equal(lastPolicy.grant, undefined);
  assert.equal((await list(meetingRow.room)).length, 1);
  assert.equal(nativeSink.stats.nonzeroFrames, 0);
  assert.equal(hostSink.stats.nonzeroFrames, 0);
  await check(
    "unadmitted caller has holding silence and no meeting participant or media",
    {
      holdingFrames: nativeSink.stats.frames,
      callerNonSilentFrames: 0,
      meetingParticipants: 1,
    },
  );

  await hostAction("admit");
  await until(
    "receive-only admitted relay",
    () =>
      lastPolicy?.state === "admitted" && nativeSink.stats.nonzeroFrames > 15,
  );
  const mutedParticipant = await until("muted phone present at SFU", async () =>
    (await list(meetingRow.room)).find(
      (p) => p.identity === phoneMediaIdentity,
    ),
  );
  assert.equal(mutedParticipant.permission?.canPublish, false);
  assert.equal(lastPolicy.muted, true);
  await check("admitted caller hears meeting audio but starts muted", {
    hostToCallerNonSilentFrames: nativeSink.stats.nonzeroFrames,
    hostToCallerPeak: nativeSink.stats.peak,
    ...(await noUplink(hostSink, "default mute")),
  });

  await phoneDtmf("6");
  await until(
    "DTMF unmute produces actual caller PCM at host",
    () => hostSink.stats.nonzeroFrames > 15,
  );
  assert.equal((await storedPhone()).phone.muted, false);
  await check(
    "DTMF star6 enables caller PCM only after admission and speaking permission",
    {
      callerToHostFrames: hostSink.stats.nonzeroFrames,
      callerToHostPeak: hostSink.stats.peak,
    },
  );

  await phoneDtmf("9");
  await until(
    "raised hand stored",
    async () => (await storedPhone()).phone.handRaised,
  );
  const hostState = await host.call(`/meetings/${meeting.code}/state`);
  assert.equal(
    hostState.participants.find((p) => p.id === phoneSession.participantId)
      .phone.handRaised,
    true,
  );
  await delay(550);
  await phoneDtmf("9");
  await until(
    "hand lowered",
    async () => !(await storedPhone()).phone.handRaised,
  );
  await check("DTMF star9 toggles hand and host state exposes it");

  await hostAction("block-audio");
  await until("blocked receive-only phone reconnect", async () => {
    const p = (await list(meetingRow.room)).find(
      (p) => p.identity === phoneMediaIdentity,
    );
    return (
      lastPolicy?.audioAllowed === false && p?.permission?.canPublish === false
    );
  });
  const blockProof = await noUplink(hostSink, "host block");
  await phoneDtmf("6");
  await delay(1000);
  const blocked = await storedPhone();
  assert.equal(blocked.audioAllowed, false);
  assert.equal(blocked.phone.muted, true);
  await check("host block stops PCM and star6 cannot override", {
    ...blockProof,
    ...(await noUplink(hostSink, "blocked keypad")),
  });

  await hostAction("allow-audio");
  await until(
    "allow preserves self mute",
    () => lastPolicy?.audioAllowed === true && lastPolicy?.muted === true,
  );
  await check(
    "allow speaking does not automatically unmute",
    await noUplink(hostSink, "allow keeps mute"),
  );
  const resumed = hostSink.stats.nonzeroFrames;
  await phoneDtmf("6");
  await until(
    "explicit unmute resumes caller PCM",
    () => hostSink.stats.nonzeroFrames > resumed + 15,
  );
  await check("caller explicitly resumes after host restores speaking", {
    resumedFrameDelta: hostSink.stats.nonzeroFrames - resumed,
  });

  await hostAction("kick");
  await until(
    "both relay legs and native participant removed",
    async () =>
      nativeTerminated &&
      !(await list(meetingRow.room)).some((p) =>
        phoneMediaIdentities.has(p.identity),
      ) &&
      (await list(holdingRoom)).length === 0,
  );
  await bounded(relayRun, "relay completion");
  const reserved = await store.pool.query(
    "SELECT released FROM phone_calls WHERE call_id=$1 AND meeting_code=$2",
    [callId, meeting.code],
  );
  assert.equal(reserved.rows[0]?.released, true);
  await check(
    "kick removes native and relay media and private leave releases reservation",
    {
      nativeTerminated,
      holdingParticipants: 0,
      callReservationReleased: true,
      releaseAfterTeardown,
      ...(await noUplink(hostSink, "after kick")),
    },
  );
  assert(
    !relayFailure,
    "Relay reported a failure during normal host moderation",
  );
  report.result = "passed";
}
try {
  await save();
  await bounded(run(), "phone media validation", 150_000);
} catch (error) {
  report.result = "failed";
  // Assertion messages and our fixed diagnostics contain no capability or PCM.
  report.failure =
    error instanceof assert.AssertionError
      ? error.message.split("\n", 1)[0]
      : /^Timed out:|^Fixture |^Relay /.test(error?.message || "")
        ? error.message
        : "Phone media validation failed; inspect the last passing checkpoint";
  console.error(`FAIL ${report.failure}`);
} finally {
  cleaning = true;
  const cleanup = async (name, fn) => {
    try {
      await bounded(Promise.resolve().then(fn), name, 7000);
      report.cleanup[name] = true;
    } catch {
      report.cleanup[name] = false;
      report.result = "failed";
    }
  };
  await cleanup("relayStopped", async () => {
    await phoneRelay?.stop();
    await relayRun;
  });
  await cleanup("audioSinksClosed", () =>
    Promise.all(sinks.map((sink) => sink.close())),
  );
  await cleanup("generatedAudioClosed", () =>
    Promise.all(publishers.map((publisher) => publisher.close())),
  );
  await cleanup("nativePeersDisconnected", () =>
    Promise.all([hostRoom?.disconnect(), nativeRoom?.disconnect()]),
  );
  await cleanup("hostGatewayClosed", () => hostGateway?.close());
  await cleanup("ownMeetingEnded", async () => {
    if (meeting && host) await host.call(`/meetings/${meeting.code}/end`, {});
  });
  await cleanup("ownHoldingRoomDeleted", async () => {
    try {
      await sfu.deleteRoom(holdingRoom);
    } catch (error) {
      if (!/not found|does not exist/i.test(String(error))) throw error;
    }
  });
  await cleanup("applicationClosed", async () => {
    if (app) await app.close();
    else {
      media.close();
      await store.close();
    }
  });
  await cleanup("rtcDisposed", () => dispose());
  report.finishedAt = new Date().toISOString();
  if (report.result === "passed") delete report.pendingOperation;
  await save();
  clearTimeout(watchdog);
}
process.exit(report.result === "passed" ? 0 : 1);
