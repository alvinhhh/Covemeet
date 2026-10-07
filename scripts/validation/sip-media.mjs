import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  RoomServiceClient,
  SipClient as SipService,
  ServerError,
} from "livekit-server-sdk";
import {
  RoomConfiguration,
  SIPMediaConfig,
  SIPMediaEncryption,
  SIPHeaderOptions,
} from "@livekit/protocol";
import { createApp } from "../../apps/api/dist/server.js";
import { loadConfig } from "../../apps/api/dist/config.js";
import { PgStore } from "../../apps/api/dist/store.js";
import { LiveMedia } from "../../apps/api/dist/media.js";
import { HttpAuthority } from "../../apps/phone/dist/authority.js";
import { AriClient, AriRequestError } from "../../apps/phone/dist/ari.js";
import { SipSupervisor } from "../../apps/phone/dist/supervisor.js";
import { SipHolding } from "../../apps/phone/dist/sip-holding.js";
import { JournalRegistry } from "../../apps/phone/dist/journal.js";
import { openGateway } from "../../apps/phone/dist/gateway.js";
import { SipClient } from "./sip-client.mjs";

// Disposable native SIP test. No carrier, browser, physical sound device or audio file.
process.umask(0o077);
process.env.RUST_LOG = "error";
const { Room, dispose } = await import("@livekit/rtc-node");
const { observe, publish, bounded } = await import("./rtc-fixture.mjs");
const database = new URL(process.env.SIP_TEST_DATABASE_URL || "http://invalid");
assert.equal(database.hostname, "sip-postgres");
assert.equal(database.pathname, "/covemeet_sip_test");
assert.equal(process.env.LIVEKIT_URL, "http://livekit:7880");
assert.equal(process.env.SIP_ARI_URL, "http://asterisk:8088");
assert.match(process.env.SIP_PBX_IP || "", /^172\.\d+\.\d+\.\d+$/);
for (const name of [
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
  "SIP_ARI_PASSWORD",
  "SIP_TRUNK_PASSWORD",
  "SIP_PASSWORD_FILE",
  "SIP_CA_FILE",
  "SIP_BAD_CA_FILE",
])
  assert(process.env[name], `Missing fixture setting ${name}`);
const reportPath = path.resolve(
  process.env.SIP_VALIDATION_REPORT || "test-results/sip/sip-media.json",
);
const report = {
  runId: randomUUID(),
  startedAt: new Date().toISOString(),
  result: "running",
  scope:
    "Native PJSIP client → Asterisk ARI IVR → LiveKit SIP randomized holding → authorized meeting relay",
  safety: {
    physicalDevices: false,
    speakerPlayback: false,
    carrier: false,
    rawAudioSaved: false,
    hostPorts: false,
  },
  limitations: [
    "Private local fixture; no carrier/PSTN quality, public deployment, production capacity, end-to-end encryption or certification established. Internal ARI and SFU control use isolated development HTTP/WS.",
  ],
  checks: [],
  cleanup: {},
  journalCleanup: [],
  holdingCleanup: [],
};
await mkdir(path.dirname(reportPath), { recursive: true });
const save = () =>
  writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
const check = async (name, evidence = {}) => {
  report.checks.push({ name, passed: true, ...evidence });
  await save();
  console.log(`PASS ${name}`);
};
let cleaning = false,
  ariFailed = false;
async function until(label, fn, ms = 12000) {
  report.pendingOperation = label;
  const deadline = Date.now() + ms;
  do {
    if (ariFailed && !cleaning) throw new Error("ARI event stream failed");
    const result = await bounded(Promise.resolve().then(fn), label, 4000);
    if (result) return result;
    await delay(120);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${label}`);
}
const config = loadConfig({
  NODE_ENV: "test",
  EDITION: "hosted",
  SITE_ORIGIN: "http://core:4100",
  SESSION_SECRET: randomBytes(40).toString("hex"),
  CREATION_KEY: randomBytes(40).toString("hex"),
  DATABASE_URL: database.href,
  LIVEKIT_URL: process.env.LIVEKIT_URL,
  LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
  PHONE_ENABLED: "true",
  PHONE_GATEWAY_KEY: randomBytes(40).toString("hex"),
  PHONE_TRUNK_ID: `fixture-${report.runId}`,
  PHONE_SIP_ADDRESS: "sip:7000@phone.example.test",
  PHONE_MAX_CALLS: "20",
  PHONE_LOBBY_SECONDS: "300",
  PHONE_MAX_DURATION_SECONDS: "300",
  RECORDING_ENABLED: "false",
  STATIC_DIR: "/tmp/no-sip-fixture-static",
});
const store = new PgStore(database.href),
  media = new LiveMedia(config, store);
const sfu = new RoomServiceClient(
  config.livekitUrl,
  config.livekitKey,
  config.livekitSecret,
  { requestTimeout: 4, failover: false },
);
const sipService = new SipService(
  config.livekitUrl,
  config.livekitKey,
  config.livekitSecret,
  { requestTimeout: 4, failover: false },
);
let app,
  ari,
  supervisor,
  trunk,
  rule,
  host,
  meeting,
  hostGateway,
  hostRoom,
  phoneSession,
  lastPolicy;
let phoneMediaIdentity;
const phoneMediaIdentities = new Set();
let joinedCount = 0,
  releaseAfterTeardown = false;
const clients = [],
  holdings = [],
  sinks = [],
  publishers = [],
  playbacks = new Set(),
  promptNames = [];
const transport = { inbound: {}, outbound: {} };
const outboundEvents = [];
const controlEvents = [];
const keypadProof = [];
let expectedKeypad = "",
  keypadObservation;
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
      throw new Error(`Fixture API rejected (${response.status})`);
    }
    return response.json();
  }
}
async function participants(room) {
  try {
    return await sfu.listParticipants(room);
  } catch (error) {
    if (error instanceof ServerError && error.code === "not_found") return [];
    throw error;
  }
}
const storedPhone = async () =>
  (await store.get(meeting.code))?.participants.find(
    (p) => p.id === phoneSession?.participantId,
  );
const hostAction = (action) =>
  host.call(
    `/meetings/${meeting.code}/participants/${phoneSession.participantId}/action`,
    { action },
  );
async function quietHost(sink, label) {
  await delay(600);
  const before = sink.stats.nonzeroFrames;
  await delay(1200);
  assert.equal(
    sink.stats.nonzeroFrames - before,
    0,
    `${label}: unexpected caller audio`,
  );
  return { observedMs: 1200, callerNonSilentFrameDelta: 0 };
}
async function quietCaller(client) {
  await until(
    "IVR completed before caller silence sample",
    () => playbacks.size === 0,
  );
  await delay(700);
  const before = await client.stats();
  await delay(1200);
  const after = await client.stats();
  assert(
    after.rxPackets > before.rxPackets,
    "Caller silence interval needs received RTP",
  );
  assert(
    after.receivedFrames > before.receivedFrames,
    "Caller silence interval needs actual frames",
  );
  assert.equal(
    after.nonSilentFrames - before.nonSilentFrames,
    0,
    "Unadmitted caller received non-silent media",
  );
  return {
    observedMs: 1200,
    receivedFrames: after.receivedFrames - before.receivedFrames,
    nonSilentFrameDelta: 0,
  };
}
async function startClient(env = {}) {
  const client = new SipClient({ env });
  clients.push(client);
  return client;
}
async function connected(client) {
  await client.waitFor((e) => e.event === "call" && e.connected, {
    timeoutMs: 10000,
  });
  return until("negotiated verified TLS and SRTP", async () => {
    const stats = await client.stats();
    return (
      stats.tlsVerified &&
      stats.srtpActive &&
      stats.srtpSuiteConfirmed &&
      stats.receivedFrames > 3 &&
      stats
    );
  });
}
async function inputCredentials(client, access) {
  await until(
    "code prompt ready",
    () => promptNames.at(-1) === "covemeet-code",
  );
  expectedKeypad = `${access.locator}#`;
  keypadObservation = {
    field: "code",
    expectedCount: expectedKeypad.length,
    receivedCount: 0,
    numericCount: 0,
    terminatorCount: 0,
    sequenceMatchesExpected: true,
  };
  keypadProof.push(keypadObservation);
  report.pendingOperation = `${keypadObservation.field} DTMF transmission`;
  await client.dtmf(expectedKeypad);
  await until("PIN prompt ready", () => promptNames.at(-1) === "covemeet-pin");
  expectedKeypad = `${access.pin}#`;
  keypadObservation = {
    field: "pin",
    expectedCount: expectedKeypad.length,
    receivedCount: 0,
    numericCount: 0,
    terminatorCount: 0,
    sequenceMatchesExpected: true,
  };
  keypadProof.push(keypadObservation);
  report.pendingOperation = `${keypadObservation.field} DTMF transmission`;
  await client.dtmf(expectedKeypad);
  await until(
    "PIN terminator received",
    () => keypadObservation.receivedCount >= keypadObservation.expectedCount,
  );
  expectedKeypad = "";
}
async function rejectedTransport(name, env) {
  const before = joinedCount;
  const client = await startClient({ SIP_DEADLINE_MS: "6000", ...env });
  await client.waitFor(
    (e) => (e.event === "call" && e.disconnected) || e.event === "stopped",
    { timeoutMs: 9000 },
  );
  await client.close();
  assert(
    !client.events.some((e) => e.event === "call" && e.connected),
    `${name}: insecure call connected`,
  );
  if (env.SIP_CA_FILE || env.SIP_TEST_HOST)
    assert(
      client.events.some(
        (e) => e.event === "tls" && !e.verified && e.verificationErrors > 0,
      ),
      `${name}: missing certificate rejection evidence`,
    );
  if (env.SIP_TEST_MODE === "without-srtp") {
    assert(
      client.events.some((e) => e.event === "tls" && e.verified),
      "No-SRTP test did not establish verified TLS",
    );
    assert(
      client.events.some((e) => e.event === "call" && e.status === 488),
      "No-SRTP test needs an SDP/media rejection",
    );
  }
  assert.equal(joinedCount, before, `${name}: created phone admission`);
  assert.equal(
    (await ari.listChannels()).length,
    0,
    `${name}: left PBX channel`,
  );
  await check(name, { confirmedCalls: 0, newPhoneAdmissions: 0 });
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
    20000,
  );
  app = await createApp(config, store, media);
  await app.listen({ host: "0.0.0.0", port: 4100 });
  trunk = await sipService.createSipInboundTrunk(
    "Covemeet private fixture",
    [],
    {
      allowedAddresses: [`${process.env.SIP_PBX_IP}/32`],
      authUsername: "covemeet-pbx",
      authPassword: process.env.SIP_TRUNK_PASSWORD,
      includeHeaders: SIPHeaderOptions.SIP_NO_HEADERS,
      media: new SIPMediaConfig({
        encryption: SIPMediaEncryption.SIP_MEDIA_ENCRYPT_REQUIRE,
      }),
      ringingTimeout: 6,
    },
  );
  rule = await sipService.createSipDispatchRule(
    { type: "callee", roomPrefix: "", randomize: true },
    {
      name: "Per-dialog private holding",
      trunkIds: [trunk.sipTrunkId],
      hidePhoneNumber: true,
      roomConfig: new RoomConfiguration({
        maxParticipants: 2,
        emptyTimeout: 30,
        departureTimeout: 10,
      }),
    },
  );
  assert.equal(
    trunk.media?.encryption,
    SIPMediaEncryption.SIP_MEDIA_ENCRYPT_REQUIRE,
  );
  const authority = new HttpAuthority(
    config.origin,
    config.phoneGatewayKey,
    true,
  );
  for (const method of ["journalStop", "journalFinish"]) {
    const original = authority[method].bind(authority);
    authority[method] = async (...args) => {
      try {
        const result = await original(...args);
        if (report.journalCleanup.length < 40)
          report.journalCleanup.push({
            method,
            result: "completed",
            state: result.state,
          });
        return result;
      } catch (error) {
        if (report.journalCleanup.length < 40)
          report.journalCleanup.push({
            method,
            result: "failed",
            httpStatus: Number.isInteger(error?.status) ? error.status : null,
          });
        throw error;
      }
    };
  }
  const observedAuthority = {
    async join(input) {
      phoneSession = await authority.join(input);
      joinedCount++;
      return phoneSession;
    },
    async action(session, callId, action) {
      if (action === "leave") {
        assert.equal(
          (await ari.listChannels()).length,
          0,
          "Leave before PBX channels ended",
        );
        for (const holding of holdings) {
          for (const room of (await sfu.listRooms()).filter((r) =>
            r.name.startsWith(`${holding.destination}_`),
          ))
            assert.equal(
              (await participants(room.name)).length,
              0,
              "Leave before holding ended",
            );
        }
        const row = await store.get(meeting.code);
        assert(
          !(await participants(row.room)).some((p) =>
            phoneMediaIdentities.has(p.identity),
          ),
          "Leave before meeting relay ended",
        );
        releaseAfterTeardown = true;
      }
      lastPolicy = await authority.action(session, callId, action);
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
  await until(
    "PBX ARI startup",
    async () => {
      try {
        const response = await fetch(
          `${process.env.SIP_ARI_URL}/ari/channels`,
          {
            headers: {
              Authorization: `Basic ${Buffer.from(`covemeet-supervisor:${process.env.SIP_ARI_PASSWORD}`).toString("base64")}`,
            },
            redirect: "error",
            signal: AbortSignal.timeout(2000),
          },
        );
        await response.body?.cancel();
        return response.ok;
      } catch {
        return false;
      }
    },
    15000,
  );
  ari = new AriClient({
    baseUrl: process.env.SIP_ARI_URL,
    username: "covemeet-supervisor",
    password: process.env.SIP_ARI_PASSWORD,
    app: "covemeet",
    development: true,
    onEvent(event) {
      if (
        event.type === "ChannelDtmfReceived" &&
        !event.channel.id.startsWith("cm-out-") &&
        expectedKeypad &&
        keypadObservation
      ) {
        keypadObservation.sequenceMatchesExpected &&=
          expectedKeypad[keypadObservation.receivedCount] === event.digit;
        keypadObservation.receivedCount++;
        if (/^[0-9]$/.test(event.digit)) keypadObservation.numericCount++;
        if (event.digit === "#") keypadObservation.terminatorCount++;
      }
      if ("channel" in event && controlEvents.length < 128)
        controlEvents.push({
          event: event.type,
          leg: event.channel.id.startsWith("cm-out-") ? "outbound" : "inbound",
          state: event.channel.state,
          ...("cause" in event ? { cause: event.cause } : {}),
        });
      if (
        "channel" in event &&
        event.channel.id.startsWith("cm-out-") &&
        outboundEvents.length < 32
      )
        outboundEvents.push({
          event: event.type,
          state: event.channel.state,
          ...("cause" in event ? { cause: event.cause } : {}),
        });
      if (event.type === "PlaybackFinished")
        playbacks.delete(event.playback.id);
      supervisor?.onEvent(event);
    },
    onFailure() {
      ariFailed = true;
      void supervisor?.stop().catch(() => {});
    },
  });
  const originalPlay = ari.play.bind(ari),
    originalVariable = ari.getChannelVariable.bind(ari);
  const originalOriginate = ari.originate.bind(ari);
  ari.originate = async (input) => {
    try {
      const result = await originalOriginate(input);
      outboundEvents.push({ event: "originate-returned", state: result.state });
      return result;
    } catch (error) {
      outboundEvents.push({
        event: "originate-rejected",
        status: error.status,
        outcome: error.outcome,
      });
      throw error;
    }
  };
  ari.play = async (channel, id, sound) => {
    playbacks.add(id);
    promptNames.push(sound);
    const playback = await originalPlay(channel, id, sound);
    if (["done", "failed"].includes(playback.state)) playbacks.delete(id);
    return playback;
  };
  const originalStop = ari.stopPlayback.bind(ari);
  ari.stopPlayback = async (id) => {
    try {
      await originalStop(id);
    } catch (error) {
      controlEvents.push({
        event: "stop-playback-failed",
        status: error.status,
        outcome: error.outcome,
      });
      throw error;
    }
    playbacks.delete(id);
  };
  ari.getChannelVariable = async (id, variable) => {
    const value = await originalVariable(id, variable);
    if (variable !== "CHANNEL(endpoint)")
      transport[id.startsWith("cm-out-") ? "outbound" : "inbound"][variable] =
        value === "1";
    return value;
  };
  const managed = process.env.PHONE_RUNTIME_FILE
    ? JSON.parse(await readFile(process.env.PHONE_RUNTIME_FILE, "utf8"))
    : {
        ownerId: randomUUID(),
        pbxId: "native-fixture",
        pbxEpoch: report.runId,
      };
  const registry = new JournalRegistry(authority, {
    ...managed,
    outboundEndpoint: "covemeet-livekit",
    sipTrunkId: trunk.sipTrunkId,
    sipRuleId: rule.sipDispatchRuleId,
  });
  await registry.initialize();
  supervisor = new SipSupervisor(
    {
      inboundContext: "covemeet-inbound",
      inboundExtension: "7000",
      inboundEndpoint: "syntheticclient",
      trunkId: config.phoneTrunkId,
      maxCallMs: 240000,
    },
    ari,
    observedAuthority,
    (callId, callerChannelId, journal) => {
      const holding = new SipHolding(
        {
          callId,
          callerChannelId,
          outboundEndpoint: "covemeet-livekit",
          sipTrunkId: trunk.sipTrunkId,
          sipRuleId: rule.sipDispatchRuleId,
          livekitWsUrl: "ws://livekit:7880",
          apiKey: config.livekitKey,
          apiSecret: config.livekitSecret,
          meetingOrigin: config.origin,
          development: true,
        },
        ari,
        sfu,
        journal,
      );
      const closeHolding = holding.close.bind(holding);
      holding.close = async () => {
        try {
          await closeHolding();
        } catch (error) {
          const known = [
            "SIP outbound leg remains",
            "SIP bridge remains",
            "SIP holding participant remains",
            "SIP cleanup requires reconciliation",
            "Unowned SIP holding resources require reconciliation",
            "Invalid cleanup namespace",
          ];
          if (report.holdingCleanup.length < 40)
            report.holdingCleanup.push({
              ...(error?.message === "SIP holding participant remains" &&
              error.cleanupCounts
                ? {
                    cleanupCounts: Object.fromEntries(
                      Object.entries(error.cleanupCounts).filter(
                        ([key, value]) =>
                          (["native", "relay", "total"].includes(key) &&
                            Number.isSafeInteger(value) &&
                            value >= 0 &&
                            value <= 10000) ||
                          ([
                            "nativeRemovalAttempted",
                            "relayDisconnectAttempted",
                          ].includes(key) &&
                            typeof value === "boolean"),
                      ),
                    ),
                  }
                : {}),
              message: known.includes(error?.message)
                ? error.message
                : "Holding cleanup failed",
              kind:
                error instanceof AriRequestError
                  ? "ari"
                  : error instanceof ServerError
                    ? "livekit"
                    : error instanceof TypeError
                      ? "type"
                      : "other",
              status: Number.isInteger(error?.status)
                ? error.status
                : undefined,
              code: [
                "not_found",
                "permission_denied",
                "unauthenticated",
                "unavailable",
                "internal",
              ].includes(error?.code)
                ? error.code
                : undefined,
              sites:
                error instanceof Error
                  ? (
                      error.stack?.match(
                        /(?:sip-holding|rtc|ari)\.(?:ts|js):\d+:\d+/g,
                      ) ?? []
                    ).slice(0, 4)
                  : [],
            });
          throw error;
        }
      };
      holdings.push(holding);
      return holding;
    },
    registry,
  );
  assert.equal(
    (await ari.listChannels()).length,
    0,
    "Fresh fixture contains unexpected calls",
  );
  await ari.connect();
  host = new BrowserSession();
  meeting = await host.call("/meetings", {
    title: "Native SIP validation",
    hostName: "Synthetic host",
    mode: "meeting",
    password: randomBytes(24).toString("hex"),
    creationKey: config.creationKey,
  });
  await host.call(`/meetings/${meeting.code}/host`, {
    token: meeting.hostToken,
  });
  delete meeting.hostToken;
  const grant = await host.call(`/meetings/${meeting.code}/media`, {});
  hostGateway = await openGateway(
    {
      ...grant,
      cookie: `mp_${meeting.code}=${host.cookies.get(`mp_${meeting.code}`)}`,
      subscribeParticipantIds: [],
    },
    config.origin,
    true,
  );
  hostRoom = new Room();
  const hostSink = observe(hostRoom, (id) => phoneMediaIdentities.has(id));
  sinks.push(hostSink);
  await hostRoom.connect(hostGateway.url, grant.token, {
    autoSubscribe: true,
    dynacast: false,
  });
  const hostAudio = await publish(hostRoom, 307);
  publishers.push(hostAudio);
  const row = await store.get(meeting.code);
  const access = await host.call(`/meetings/${meeting.code}/phone`, {});
  const client = await startClient();
  const negotiated = await connected(client);
  const preEntryDialogs = await store.queryPhoneDialogs({
    pbxId: "native-fixture",
  });
  assert.equal(preEntryDialogs.length, 1);
  assert.equal(preEntryDialogs[0].state, "open");
  assert.equal(preEntryDialogs[0].binding, undefined);
  assert(
    ["pending", "confirmed"].includes(preEntryDialogs[0].operations.answer),
  );
  await check("native call owns durable capacity before credential entry", {
    activeDialogs: 1,
    meetingBindingPresent: false,
    answerIntentPersisted: true,
  });
  assert.equal(negotiated.verificationErrors, 0);
  assert(
    negotiated.tlsAllowedProtocols > 0 &&
      (negotiated.tlsAllowedProtocols & ~48) === 0,
    "Only TLS1.2 or TLS1.3 may be enabled",
  );
  await inputCredentials(client, access);
  await until(
    "native caller waiting with authorized holding relay",
    () => lastPolicy?.state === "waiting",
    15000,
  );
  assert.equal((await participants(row.room)).length, 1);
  assert.equal(hostSink.stats.nonzeroFrames, 0);
  const nativeRooms = (await sfu.listRooms()).filter((r) =>
    r.name.startsWith("phone-hold-"),
  );
  assert.equal(nativeRooms.length, 1);
  assert.equal(nativeRooms[0].maxParticipants, 2);
  const peers = await participants(nativeRooms[0].name);
  assert.equal(peers.length, 2);
  assert(
    peers.some((p) => p.kind === 3 && p.identity === "sip_0278c3fed86ac9f4"),
  );
  assert.equal(transport.inbound["CHANNEL(pjsip,inbound_tls)"], true);
  assert.equal(transport.outbound["CHANNEL(pjsip,secure)"], true);
  for (const leg of [transport.inbound, transport.outbound]) {
    assert.equal(leg["CHANNEL(rtp,secure)"], true);
  }
  await check("native call verifies TLS and requires SRTP on both PBX legs", {
    client: {
      tlsAllowedProtocols: negotiated.tlsAllowedProtocols,
      tlsCipher: negotiated.tlsCipher,
      verificationErrors: negotiated.verificationErrors,
      srtpActive: negotiated.srtpActive,
      srtpSuiteConfirmed: negotiated.srtpSuiteConfirmed,
    },
    pbx: transport,
    holdingRooms: 1,
    holdingParticipants: 2,
  });
  await check(
    "unadmitted native caller hears no meeting audio after IVR",
    await quietCaller(client),
  );
  if (process.env.SIP_RECOVERY_PROBE === "true") {
    access.pin = "";
    report.result = "passed";
    await check(
      "replacement supervisor accepts a fresh native call after orphan recovery",
    );
    return;
  }
  await client.tone(true);
  await hostAction("admit");
  await until(
    "admitted IVR and receive-only meeting relay",
    async () =>
      lastPolicy?.state === "admitted" &&
      promptNames.includes("covemeet-admitted") &&
      (await participants(row.room)).some(
        (p) =>
          p.identity === phoneMediaIdentity &&
          p.permission?.canPublish === false,
      ),
  );
  await until("admission notice completed", () => playbacks.size === 0);
  hostAudio.setEnabled(false);
  await quietCaller(client);
  hostAudio.setEnabled(true);
  await delay(700);
  const beforeDownlink = await client.stats();
  await delay(1200);
  const afterDownlink = await client.stats();
  assert.equal(playbacks.size, 0, "IVR overlaps downlink evidence");
  assert(
    afterDownlink.nonSilentFrames > beforeDownlink.nonSilentFrames + 15,
    "Caller did not hear meeting audio",
  );
  await check("host admission delivers audio while caller starts muted", {
    receivedNonSilentFrameDelta:
      afterDownlink.nonSilentFrames - beforeDownlink.nonSilentFrames,
    ...(await quietHost(hostSink, "default mute")),
  });
  await client.dtmf("*6");
  await until(
    "native keypad unmute reaches actual host PCM",
    () => hostSink.stats.nonzeroFrames > 15,
  );
  assert.equal((await storedPhone()).phone.muted, false);
  await check("RFC4733 star6 enables caller audio through authorized relay", {
    callerNonSilentFrames: hostSink.stats.nonzeroFrames,
    peak: hostSink.stats.peak,
  });
  await client.dtmf("*9");
  await until(
    "native keypad hand raise",
    async () => (await storedPhone()).phone.handRaised,
  );
  await check("RFC4733 star9 raises the caller hand in host state");
  await hostAction("block-audio");
  await until(
    "host block reaches phone media",
    async () =>
      lastPolicy?.audioAllowed === false &&
      (await participants(row.room)).some(
        (p) =>
          p.identity === phoneMediaIdentity &&
          p.permission?.canPublish === false,
      ),
  );
  const blocked = await quietHost(hostSink, "host block");
  await client.dtmf("*6");
  await delay(1000);
  assert.equal((await storedPhone()).audioAllowed, false);
  assert.equal((await storedPhone()).phone.muted, true);
  await check(
    "host speaking block stops native PCM and cannot be overridden by keypad",
    { ...blocked, ...(await quietHost(hostSink, "blocked keypad")) },
  );
  await hostAction("kick");
  await until("kick closes PBX channels and native media", async () => {
    const pbxChannels = (await ari.listChannels()).length;
    const holdingParticipants = (await participants(nativeRooms[0].name))
      .length;
    report.kickCleanup = {
      ...supervisor.status,
      pbxChannels,
      holdingParticipants,
    };
    return (
      supervisor.status.calls === 0 &&
      pbxChannels === 0 &&
      holdingParticipants === 0
    );
  });
  const reserve = await store.pool.query(
    "SELECT released FROM phone_calls WHERE participant_id=$1",
    [phoneSession.participantId],
  );
  assert.equal(reserve.rows[0]?.released, true);
  assert.equal(
    (await store.queryPhoneDialogs({ pbxId: "native-fixture" })).length,
    0,
  );
  const [finishedDialog] = await store.queryPhoneDialogs({
    callId: preEntryDialogs[0].callId,
  });
  assert.equal(finishedDialog.state, "closed");
  assert.equal(finishedDialog.uncertain, false);
  assert.equal(
    finishedDialog.binding.participantId,
    phoneSession.participantId,
  );
  assert(releaseAfterTeardown);
  await check(
    "kick removes native and meeting media before releasing reserved capacity",
    { pbxChannels: 0, holdingParticipants: 0, releaseAfterTeardown },
  );
  await client.close();

  await rejectedTransport(
    "untrusted certificate authority prevents SIP admission",
    { SIP_CA_FILE: process.env.SIP_BAD_CA_FILE },
  );
  await rejectedTransport(
    "certificate hostname mismatch prevents SIP admission",
    { SIP_TEST_HOST: "asterisk-wrong-name" },
  );
  await rejectedTransport("TLS with unencrypted RTP is rejected", {
    SIP_TEST_MODE: "without-srtp",
  });
  await rejectedTransport("plaintext SIP transport cannot connect", {
    SIP_TEST_MODE: "cleartext",
  });
  const clearNative = await new Promise((resolve) => {
    const socket = net.createConnection({ host: "sip", port: 5060 });
    const finish = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
  assert.equal(clearNative, false);
  await check(
    "native SIP plaintext TCP listener is unreachable from the private fixture network",
  );
  const invalid = await startClient();
  await connected(invalid);
  const count = joinedCount;
  const invalidPin = access.pin === "00000000" ? "11111111" : "00000000";
  await inputCredentials(invalid, {
    ...access,
    pin: invalidPin,
  });
  await until(
    "wrong PIN ends call without admission",
    () => supervisor.status.calls === 0,
  );
  assert.equal(promptNames.at(-1), "covemeet-invalid");
  assert.equal(joinedCount, count);
  assert.equal((await ari.listChannels()).length, 0);
  await invalid.close();
  await check("wrong meeting PIN yields generic IVR failure and no admission");
  for (const [index, locator] of [
    "000000000000",
    "111111111111",
    "121212121212",
    "012345678901",
  ].entries()) {
    const entry = await startClient();
    await connected(entry);
    const before = joinedCount;
    await inputCredentials(entry, { locator, pin: invalidPin });
    await until(
      "synthetic keypad entry completes with generic credential rejection",
      () => supervisor.status.calls === 0,
    );
    assert.equal(promptNames.at(-1), "covemeet-invalid");
    assert.equal(joinedCount, before);
    for (const proof of keypadProof.slice(-2)) {
      assert.equal(
        proof.receivedCount,
        proof.expectedCount,
        "Keypad field event count mismatch",
      );
      assert.equal(
        proof.sequenceMatchesExpected,
        true,
        "Keypad field sequence mismatch",
      );
      assert.equal(proof.terminatorCount, 1);
    }
    await entry.close();
    await check(
      `numeric keypad entry pattern ${index + 1} reaches credential checking`,
      { fields: keypadProof.slice(-2) },
    );
  }
  assert.equal(ariFailed, false);
  assert.equal(
    (await store.queryPhoneDialogs({ pbxId: "native-fixture" })).length,
    0,
  );
  report.result = "passed";
  if (process.env.SIP_MANAGED_RECOVERY === "true") {
    const orphan = await startClient();
    await connected(orphan);
    await inputCredentials(orphan, access);
    access.pin = "";
    await until("orphan caller waiting", () => lastPolicy?.state === "waiting");
    await hostAction("admit");
    await until("orphan native dialog fully settled", async () => {
      const dialogs = await store.queryPhoneDialogs({
        pbxId: "native-fixture",
      });
      return (
        lastPolicy?.state === "admitted" &&
        playbacks.size === 0 &&
        dialogs.length === 1 &&
        dialogs[0].operations["attach-caller"] === "confirmed" &&
        dialogs[0].holding &&
        dialogs[0].binding &&
        !dialogs[0].uncertain &&
        !Object.values(dialogs[0].operations).some((state) =>
          ["pending", "unknown"].includes(state),
        )
      );
    });
    report.orphanReady = true;
    await save();
    // The independent manager must kill this process and both native processors.
    // No finally handler, voluntary leave or locally supplied cleanup proof runs.
    await new Promise(() => {});
  }
  access.pin = "";
}
const watchdog = setTimeout(() => {
  report.result = "failed";
  report.failure = "Native SIP validation deadline exceeded";
  void save().finally(() => process.exit(1));
}, 240000);
try {
  await save();
  await run();
} catch (error) {
  report.result = "failed";
  // SipClient.events contains only its explicit scalar allowlist, never native logs.
  report.diagnostics = {
    outboundEvents,
    controlEvents,
    keypadProof,
    clients: clients.map((c) => c.events),
    supervisor: supervisor?.status,
    lastPrompt: promptNames.at(-1),
    policyState: lastPolicy?.state,
    transport,
  };
  report.failure =
    error instanceof assert.AssertionError
      ? error.message.split("\n", 1)[0]
      : /^(Timed out:|Fixture API|ARI event stream|SIP event deadline|SIP client |SIP controller )/.test(
            error?.message || "",
          )
        ? error.message
        : "Native SIP validation failed; inspect last checkpoint";
  // Counts and fixed state fields make cleanup failures diagnosable without
  // printing identities, PINs, tokens, request bodies or raw upstream errors.
  const dialogs = await store
    .queryPhoneDialogs({ pbxId: "native-fixture" })
    .catch(() => undefined);
  report.cleanupState = {
    kick: report.kickCleanup,
    journals: dialogs?.map((dialog) => ({
      state: dialog.state,
      uncertain: dialog.uncertain,
      operations: dialog.operations,
      hasMeeting: !!dialog.binding,
      hasHolding: !!dialog.holding,
    })),
    journalRequests: report.journalCleanup,
    holdingErrors: report.holdingCleanup,
  };
  console.error(`FAIL ${report.failure}`);
  console.error(`CLEANUP_STATE ${JSON.stringify(report.cleanupState)}`);
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
  await cleanup("clientsClosed", () =>
    Promise.all(clients.map((c) => c.close())),
  );
  await cleanup("supervisorStopped", () => supervisor?.stop());
  await cleanup("ariClosed", () => ari?.close());
  await cleanup("audioSinksClosed", () =>
    Promise.all(sinks.map((s) => s.close())),
  );
  await cleanup("generatedAudioClosed", () =>
    Promise.all(publishers.map((p) => p.close())),
  );
  await cleanup("hostDisconnected", () => hostRoom?.disconnect());
  await cleanup("hostGatewayClosed", () => hostGateway?.close());
  await cleanup(
    "ownMeetingEnded",
    () => meeting && host.call(`/meetings/${meeting.code}/end`, {}),
  );
  await cleanup(
    "dispatchRuleRemoved",
    () => rule && sipService.deleteSipDispatchRule(rule.sipDispatchRuleId),
  );
  await cleanup(
    "sipTrunkRemoved",
    () => trunk && sipService.deleteSipTrunk(trunk.sipTrunkId),
  );
  await cleanup("applicationClosed", async () => {
    if (app) await app.close();
    else {
      media.close();
      await store.close();
    }
  });
  await cleanup("rtcDisposed", () => dispose());
  report.finishedAt = new Date().toISOString();
  report.keypadProof = keypadProof;
  if (report.result === "passed") delete report.pendingOperation;
  await save();
  console.log(`CLEANUP_RESULTS ${JSON.stringify(report.cleanup)}`);
  clearTimeout(watchdog);
}
process.exit(report.result === "passed" ? 0 : 1);
