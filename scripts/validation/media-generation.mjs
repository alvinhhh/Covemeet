import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { RoomServiceClient } from "livekit-server-sdk";
import { WebSocket } from "ws";
import { loadConfig } from "../../apps/api/dist/config.js";
import { createApp } from "../../apps/api/dist/server.js";
import { PgStore } from "../../apps/api/dist/store.js";
import { LiveMedia } from "../../apps/api/dist/media.js";
import { openGateway } from "../../apps/phone/dist/gateway.js";

// Isolated two-instance regression. No devices, audio, browser, existing runtime,
// provider account, direct database edits, or unscoped SFU removal.
process.umask(0o077);
process.env.RUST_LOG = "error";
const require = createRequire(import.meta.url);
const sdk = require("@livekit/rtc-node");
require(
  join(dirname(require.resolve("@livekit/rtc-node")), "log.cjs"),
).log.level = "silent";
const {
  Room,
  RoomEvent,
  VideoSource,
  VideoStream,
  VideoFrame,
  LocalVideoTrack,
  TrackPublishOptions,
  TrackSource,
  TrackKind,
  VideoBufferType,
  dispose,
} = sdk;
const report = {
  startedAt: new Date().toISOString(),
  passed: false,
  checks: [],
  variants: [],
  cleanup: {},
  scope: {
    disposablePostgresAndSfu: true,
    independentApiPools: 2,
    inProcessDatabaseLoss: true,
    processKillExercised: false,
    tlsDeploymentExercised: false,
    physicalDevices: false,
    audioTracks: false,
    playback: false,
    existingInstallationTouched: false,
  },
};
const reportPath = resolve(
  process.env.MEDIA_GENERATION_REPORT || "/tmp/media-generation.json",
);
let stage = "preflight";
const instances = [],
  fixtures = [];
function check(value, reason) {
  if (!value) throw Object.assign(new Error(reason), { safeReason: reason });
}
async function bounded(promise, reason, ms = 12000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(Object.assign(new Error(reason), { safeReason: reason })),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(operation, reason, ms = 15000) {
  const deadline = Date.now() + ms;
  do {
    const value = await operation();
    if (value) return value;
    await delay(150);
  } while (Date.now() < deadline);
  check(false, reason);
}
async function save() {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
}
async function proof(name, evidence = {}) {
  report.checks.push({ name, ...evidence });
  await save();
  console.log(`PASS ${name}`);
}
function claims(grant) {
  const c = JSON.parse(Buffer.from(grant.token.split(".")[1], "base64url"));
  check(
    /^[a-f0-9-]{36}$/.test(c.sub) && /^m_[a-f0-9-]{36}$/.test(c.video?.room),
    "unexpected-media-binding",
  );
  return c;
}
const databaseUrl = new URL(
  process.env.MEDIA_GENERATION_DATABASE_URL || "http://invalid",
);
check(
  databaseUrl.protocol === "postgresql:" &&
    databaseUrl.hostname === "media-postgres" &&
    databaseUrl.pathname === "/covemeet_media_generation_test" &&
    !databaseUrl.search,
  "disposable-database-required",
);
const sfuUrl = new URL(process.env.LIVEKIT_URL || "http://invalid");
check(sfuUrl.href === "http://media-livekit:7880/", "disposable-sfu-required");
check(
  /^[a-f0-9]{24}$/.test(process.env.LIVEKIT_API_KEY || "") &&
    /^[a-f0-9]{64}$/.test(process.env.LIVEKIT_API_SECRET || ""),
  "generated-sfu-credentials-required",
);
check(
  /^sha256:[a-f0-9]{64}$/.test(process.env.MEDIA_GENERATION_IMAGE || ""),
  "reviewed-image-required",
);
report.image = process.env.MEDIA_GENERATION_IMAGE;
const sessionSecret = randomBytes(40).toString("hex"),
  creationKey = randomBytes(40).toString("hex");
const sfu = new RoomServiceClient(
  sfuUrl.href,
  process.env.LIVEKIT_API_KEY,
  process.env.LIVEKIT_API_SECRET,
);

async function apiInstance() {
  const config = loadConfig({
    NODE_ENV: "test",
    EDITION: "hosted",
    SITE_ORIGIN: "http://127.0.0.1:1",
    SESSION_SECRET: sessionSecret,
    CREATION_KEY: creationKey,
    DATABASE_URL: databaseUrl.href,
    LIVEKIT_URL: sfuUrl.href,
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
    PHONE_ENABLED: "false",
    RECORDING_ENABLED: "false",
    STATIC_DIR: "/tmp/no-media-generation-static",
  });
  const store = new PgStore(databaseUrl.href);
  let closed = false;
  const close = store.close.bind(store);
  // The lost-DB variant closes this pool early. Normal app teardown stays idempotent.
  store.close = async () => {
    if (!closed) {
      closed = true;
      await close();
    }
  };
  const instance = {
    config,
    store,
    media: new LiveMedia(config, store),
    app: undefined,
  };
  instances.push(instance);
  await store.init();
  instance.app = await createApp(config, store, instance.media);
  await instance.app.listen({ host: "127.0.0.1", port: 0 });
  const port = instance.app.server.address().port;
  config.origin = `http://127.0.0.1:${port}`;
  config.portalOrigin = config.origin;
  config.mediaUrl = `ws://127.0.0.1:${port}`;
  return instance;
}
class Session {
  cookies = new Map();
  cookie(code) {
    check(/^[A-Z0-9]{26}$/.test(code), "invalid-fixture-code");
    const value = this.cookies.get(`mp_${code}`);
    check(typeof value === "string", "session-cookie-missing");
    return `mp_${code}=${value}`;
  }
  async call(api, path, body, expected = [200]) {
    const response = await fetch(api.config.origin + path, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(45000),
      headers: {
        Origin: api.config.origin,
        "X-Requested-With": "MeetingPlatform",
        "Content-Type": "application/json",
        Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const raw of response.headers.getSetCookie()) {
      const pair = raw.split(";", 1)[0],
        at = pair.indexOf("=");
      if (at > 0) this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
    }
    const data = await response.json();
    check(expected.includes(response.status), "unexpected-fixture-api-status");
    return { status: response.status, data };
  }
}
async function machine(api, path, body) {
  check(
    ["entitlements", "meetings", "authority"].includes(path),
    "invalid-private-fixture-route",
  );
  const response = await fetch(
    `${api.config.origin}/api/internal/hosted/${path}`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(12000),
      headers: {
        "X-Requested-With": "MeetingPlatformHosted",
        "Content-Type": "application/json",
        Authorization: `Bearer ${creationKey}`,
      },
      body: JSON.stringify(body),
    },
  );
  check([200, 202].includes(response.status), "private-fixture-api-failed");
  return { status: response.status, data: await response.json() };
}
async function peersIn(f) {
  check(
    /^[A-Z0-9]{26}$/.test(f.code) && /^m_[a-f0-9-]{36}$/.test(f.room),
    "invalid-scoped-room",
  );
  try {
    return await bounded(sfu.listParticipants(f.room), "sfu-list-timeout");
  } catch (error) {
    if (error?.code === "not_found") return [];
    throw error;
  }
}
async function exactState(f) {
  const m = await f.a.store.get(f.code);
  check(
    m &&
      m.hosted?.billingOwnerId === f.owner &&
      m.hosted.accountId === f.owner &&
      m.title === f.title &&
      m.room === f.room,
    "fixture-state-scope-changed",
  );
  return m;
}
async function peer(api, grant, cookie, publisherIdentity) {
  const bridge = await openGateway(
    { ...grant, cookie, subscribeParticipantIds: [] },
    api.config.origin,
    true,
  );
  const room = new Room(),
    readers = new Set();
  const p = {
    room,
    bridge,
    decoded: 0,
    disconnected: 0,
    reconnecting: 0,
    closing: undefined,
  };
  room.on(RoomEvent.Disconnected, () => p.disconnected++);
  room.on(RoomEvent.Reconnecting, () => p.reconnecting++);
  if (publisherIdentity)
    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (
        track.kind !== TrackKind.KIND_VIDEO ||
        participant.identity !== publisherIdentity
      )
        return;
      const reader = new VideoStream(track).getReader();
      readers.add(reader);
      void (async () => {
        try {
          for (;;) {
            const value = await reader.read();
            if (value.done) break;
            p.decoded++;
          }
        } finally {
          readers.delete(reader);
          await reader.cancel().catch(() => {});
        }
      })().catch(() => {});
    });
  p.close = () =>
    (p.closing ??= (async () => {
      await bounded(
        Promise.all([...readers].map((r) => r.cancel())),
        "reader-close-timeout",
      );
      await bounded(room.disconnect(), "peer-close-timeout");
      await bounded(bridge.close(), "bridge-close-timeout");
      check(!room.isConnected, "peer-remained-connected");
    })());
  try {
    await bounded(
      room.connect(bridge.url, grant.token, {
        autoSubscribe: true,
        dynacast: false,
      }),
      "peer-connect-timeout",
    );
  } catch (error) {
    await p.close().catch(() => {});
    throw error;
  }
  return p;
}
async function video(room) {
  const source = new VideoSource(160, 90),
    track = LocalVideoTrack.createVideoTrack(
      "Silent generation fixture",
      source,
    );
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_CAMERA;
  let timer,
    generated = 0,
    closing;
  const close = () =>
    (closing ??= (async () => {
      clearInterval(timer);
      await bounded(track.close(), "video-track-close-timeout");
      await bounded(source.close(), "video-source-close-timeout");
    })());
  try {
    await bounded(
      room.localParticipant.publishTrack(track, options),
      "video-publish-timeout",
    );
    timer = setInterval(() => {
      const value = (generated++ * 13) % 255,
        data = new Uint8Array(160 * 90 * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = data[i + 1] = data[i + 2] = value;
        data[i + 3] = 255;
      }
      try {
        source.captureFrame(
          new VideoFrame(data, 160, 90, VideoBufferType.RGBA),
        );
      } catch {}
    }, 100);
    return { close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
function holdOneRemoval(media, room, identity) {
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const original = media.client.removeParticipant.bind(media.client);
  const state = {
    captured: false,
    attempted: false,
    completed: false,
    outcome: undefined,
    entered,
    release,
  };
  media.client.removeParticipant = async (targetRoom, targetIdentity) => {
    if (targetRoom !== room || targetIdentity !== identity || state.captured)
      return original(targetRoom, targetIdentity);
    state.captured = true;
    enter();
    await bounded(gate, "held-old-removal-expired", 30000);
    state.attempted = true;
    try {
      const result = await original(targetRoom, targetIdentity);
      state.outcome = "removed";
      return result;
    } catch (error) {
      state.outcome = error?.code === "not_found" ? "already-absent" : "failed";
      throw error;
    } finally {
      state.completed = true;
    }
  };
  return state;
}
async function denied(api, grant, cookie) {
  const statuses = [];
  for (const path of ["/rtc", "/rtc/v1"]) {
    const status = await bounded(
      new Promise((resolveStatus, reject) => {
        const ws = new WebSocket(
          `${api.config.mediaUrl}${path}?access_token=${encodeURIComponent(grant.token)}`,
          {
            headers: { Origin: api.config.origin, Cookie: cookie },
            handshakeTimeout: 4000,
          },
        );
        ws.on("open", () => {
          ws.terminate();
          reject(
            Object.assign(new Error("old-token-accepted"), {
              safeReason: "old-token-accepted",
            }),
          );
        });
        ws.on("unexpected-response", (_request, response) => {
          response.resume();
          resolveStatus(response.statusCode);
          ws.terminate();
        });
        ws.on("error", reject);
      }),
      "old-token-probe-timeout",
    );
    check(status === 403, "old-token-not-denied");
    statuses.push(status);
  }
  return statuses;
}
async function runVariant(a, b, loseDatabase) {
  const label = loseDatabase
    ? "late-removal-after-database-loss"
    : "late-removal-with-successor-on-same-api";
  stage = label;
  const owner = randomUUID(),
    title = `Media generation fixture ${randomBytes(12).toString("hex")}`;
  const f = {
    a,
    owner,
    title,
    peers: [],
    gate: undefined,
    late: undefined,
    cleaned: false,
  };
  fixtures.push(f);
  f.grant = {
    billingOwnerId: owner,
    revision: 1,
    validUntil: Date.now() + 300000,
    enabled: true,
    hostAccountIds: [owner],
    limits: { participants: 100, durationSeconds: 7200, concurrentMeetings: 1 },
    quota: { anchorAt: Date.now() - 60000, participantSecondsPerMonth: 6000 },
  };
  await machine(a, "entitlements", f.grant);
  const password = randomBytes(24).toString("base64url");
  const made = (
    await machine(a, "meetings", {
      accountId: owner,
      billingOwnerId: owner,
      version: 1,
      operationId: randomUUID(),
      meeting: {
        title,
        hostName: "Synthetic publisher",
        password,
        mode: "meeting",
      },
    })
  ).data;
  check(/^[A-Z0-9]{26}$/.test(made.code), "generated-room-required");
  f.code = made.code;
  f.room = (await a.store.get(f.code))?.room;
  await exactState(f);
  const host = new Session(),
    guest = new Session();
  await host.call(a, `/api/meetings/${f.code}/host`, { token: made.hostToken });
  const guestId = (
    await guest.call(a, `/api/meetings/${f.code}/join`, {
      name: "Synthetic receiver",
      password,
    })
  ).data.participantId;
  await host.call(a, `/api/meetings/${f.code}/participants/${guestId}/action`, {
    action: "admit",
  });
  const hostGrant = (await host.call(a, `/api/meetings/${f.code}/media`, {}))
    .data;
  const oldGrant = (await guest.call(b, `/api/meetings/${f.code}/media`, {}))
    .data;
  const hostIdentity = claims(hostGrant).sub,
    oldIdentity = claims(oldGrant).sub;
  check(claims(oldGrant).video.room === f.room, "issued-room-binding-changed");
  const initial = await exactState(f),
    original = initial.participants.find((p) => p.id === guestId);
  check(
    original &&
      (original.mediaIdentity ?? original.id) === oldIdentity &&
      oldGrant.mediaIdentity === oldIdentity,
    "physical-generation-not-in-source",
  );
  const hostPeer = await peer(a, hostGrant, host.cookie(f.code));
  f.peers.push(hostPeer);
  const oldPeer = await peer(b, oldGrant, guest.cookie(f.code), hostIdentity);
  f.peers.push(oldPeer);
  f.video = await video(hostPeer.room);
  await until(async () => oldPeer.decoded >= 5, "initial-video-not-decoded");
  const initialSfu = await peersIn(f);
  check(
    initialSfu.length === 2 &&
      initialSfu.every((p) => p.tracks.every((t) => t.type !== 0)),
    "unexpected-initial-sfu-peers",
  );
  const hostSid = initialSfu.find((p) => p.identity === hostIdentity)?.sid;
  f.gate = holdOneRemoval(b.media, f.room, oldIdentity);
  // This is a real route/enforcement call; only the exact SDK removal is delayed.
  f.late = host
    .call(
      b,
      `/api/meetings/${f.code}/participants/${guestId}/action`,
      { action: "block-video" },
      [200, 503],
    )
    .then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
  await bounded(f.gate.entered, "old-removal-not-held");
  const fenced = await exactState(f),
    fencedGuest = fenced.participants.find((p) => p.id === guestId);
  check(
    fencedGuest.previousMediaIdentity === oldIdentity &&
      fencedGuest.enforcementPending,
    "retiring-generation-not-persisted",
  );
  if (loseDatabase) {
    await bounded(b.store.close(), "old-api-database-close-timeout");
  }
  // Repeated permission change exercises preservation of the first retired identity.
  await host.call(a, `/api/meetings/${f.code}/participants/${guestId}/action`, {
    action: "block-audio",
  });
  const ready = await exactState(f),
    current = ready.participants.find((p) => p.id === guestId);
  check(
    !current.enforcementPending && current.mediaIdentity !== oldIdentity,
    "successor-generation-not-ready",
  );
  await until(
    async () => !oldPeer.room.isConnected,
    "retired-native-peer-remains",
  );
  await oldPeer.close();
  const successorApi = loseDatabase ? a : b;
  const newGrant = (
    await guest.call(successorApi, `/api/meetings/${f.code}/media`, {})
  ).data;
  const successorIdentity = claims(newGrant).sub;
  check(
    successorIdentity === current.mediaIdentity &&
      successorIdentity !== oldIdentity,
    "successor-token-identity-mismatch",
  );
  const successor = await peer(
    successorApi,
    newGrant,
    guest.cookie(f.code),
    hostIdentity,
  );
  f.peers.push(successor);
  await until(
    async () => successor.decoded >= 5,
    "successor-video-not-decoded",
  );
  const beforeSfu = await peersIn(f),
    before = await exactState(f),
    beforeGuest = before.participants.find((p) => p.id === guestId);
  const successorSid = beforeSfu.find(
    (p) => p.identity === successorIdentity,
  )?.sid;
  check(
    beforeSfu.length === 2 &&
      successorSid &&
      beforeSfu.find((p) => p.identity === hostIdentity)?.sid === hostSid &&
      beforeGuest.meter?.connectionId &&
      before.participants.filter((p) => p.meter).length === 2,
    "successor-baseline-invalid",
  );
  const usedBefore = (await a.store.hostedUsage(owner)).participantSeconds.used;
  const at = Date.now(),
    decoded = successor.decoded;
  if (!loseDatabase) {
    // SDK gating occurs after remove() closes local sockets. Invoke an additional
    // stale remove after replacement, proving the socket-map lookup is fenced too.
    await bounded(
      b.media.remove(fenced, fencedGuest),
      "stale-remove-invocation-timeout",
    );
  }
  f.gate.release();
  const late = await bounded(f.late, "delayed-enforcement-completion-timeout");
  check(
    !late.error && late.value.status === (loseDatabase ? 503 : 200),
    "late-enforcement-result-unexpected",
  );
  check(
    f.gate.attempted &&
      f.gate.completed &&
      ["removed", "already-absent"].includes(f.gate.outcome),
    "real-old-sfu-request-not-executed",
  );
  await delay(2000);
  const afterSfu = await peersIn(f),
    after = await exactState(f),
    afterGuest = after.participants.find((p) => p.id === guestId);
  check(
    successor.room.isConnected &&
      successor.disconnected === 0 &&
      successor.reconnecting === 0 &&
      successor.decoded > decoded + 5,
    "late-removal-interrupted-successor",
  );
  check(
    hostPeer.room.isConnected &&
      hostPeer.disconnected === 0 &&
      hostPeer.reconnecting === 0 &&
      afterSfu.length === 2 &&
      afterSfu.find((p) => p.identity === successorIdentity)?.sid ===
        successorSid &&
      afterSfu.find((p) => p.identity === hostIdentity)?.sid === hostSid &&
      !afterSfu.some((p) => p.identity === oldIdentity),
    "late-removal-changed-physical-session",
  );
  check(
    !afterGuest.enforcementPending &&
      afterGuest.mediaIdentity === successorIdentity &&
      afterGuest.meter?.connectionId === beforeGuest.meter.connectionId &&
      afterGuest.meter.connectedAt === beforeGuest.meter.connectedAt &&
      after.participants.filter((p) => p.meter).length === 2,
    "late-cleanup-changed-successor-meter",
  );
  const usedAfter = (await a.store.hostedUsage(owner)).participantSeconds.used;
  check(
    usedAfter >= usedBefore &&
      usedAfter - usedBefore <= Math.ceil(((Date.now() - at) * 2) / 1000) + 3,
    "late-cleanup-changed-usage-rate",
  );
  check(
    claims(oldGrant).exp * 1000 > Date.now() + 5000,
    "old-token-expired-before-denial-proof",
  );
  const oldStatuses = await denied(a, oldGrant, guest.cookie(f.code));
  if (!loseDatabase)
    oldStatuses.push(...(await denied(b, oldGrant, guest.cookie(f.code))));
  const result = {
    name: label,
    passed: true,
    initialDecodedFrames: oldPeer.decoded,
    successorDecodedFrames: successor.decoded,
    framesAfterLateRemoval: successor.decoded - decoded,
    physicalSuccessorSidUnchanged: true,
    hostSidUnchanged: true,
    successorReconnections: 0,
    successorMeterUnchanged: true,
    activeMeters: 2,
    oldIdentityAbsent: true,
    oldTokenStatuses: oldStatuses,
    staleLocalRemoveAfterSuccessor: !loseDatabase,
    heldRealSfuRemovalExecuted: true,
    lateEnforcementStatus: late.value.status,
    databasePoolClosedBeforeSuccessor: loseDatabase,
    processKillExercised: false,
    audioTracks: 0,
  };
  report.variants.push(result);
  await proof(label, result);
  await cleanupFixture(f);
}
async function cleanupFixture(f) {
  if (f.cleaned) return;
  f.gate?.release();
  if (f.late)
    await bounded(f.late, "cleanup-held-removal-timeout").catch(() => {});
  const errors = [];
  let owned = [];
  if (f.grant)
    try {
      await machine(f.a, "entitlements", {
        ...f.grant,
        revision: 2,
        validUntil: Date.now() + 60000,
        enabled: false,
      });
      await until(
        async () => {
          const r = await machine(f.a, "authority", {
            accountId: f.owner,
            billingOwnerId: f.owner,
            version: 2,
            enabled: false,
          });
          return r.status === 200 && r.data.cleanupPending === false;
        },
        "fixture-authority-cleanup-timeout",
        30000,
      );
      // Include a room whose successful creation response may have been lost.
      const discovered = (await f.a.store.all()).filter(
        (m) => m.hosted?.billingOwnerId === f.owner,
      );
      check(
        discovered.every(
          (m) =>
            m.title === f.title &&
            m.hosted.accountId === f.owner &&
            /^[A-Z0-9]{26}$/.test(m.code) &&
            /^m_[a-f0-9-]{36}$/.test(m.room),
        ),
        "cleanup-owner-scope-changed",
      );
      owned = discovered;
      for (const m of owned) {
        check(
          m.ended &&
            !m.cleanupPending &&
            (!m.lifecycle || m.lifecycle.cleanupConfirmed) &&
            m.participants.every((p) => !p.meter),
          "fixture-reservations-remain",
        );
      }
    } catch {
      errors.push("authority-or-reservation-cleanup");
    }
  try {
    await f.video?.close();
  } catch {
    errors.push("video-cleanup");
  }
  const closed = await Promise.allSettled(f.peers.map((p) => p.close()));
  if (closed.some((x) => x.status !== "fulfilled")) errors.push("peer-cleanup");
  for (const room of new Set([
    ...owned.map((m) => m.room),
    ...(f.room ? [f.room] : []),
  ]))
    try {
      check(/^m_[a-f0-9-]{36}$/.test(room), "invalid-fixture-room");
      await bounded(sfu.deleteRoom(room), "fixture-sfu-delete-timeout").catch(
        (error) => {
          if (error?.code !== "not_found") throw error;
        },
      );
      const code = owned.find((m) => m.room === room)?.code ?? f.code;
      check(
        (await peersIn({ code, room })).length === 0,
        "fixture-sfu-peers-remain",
      );
    } catch {
      errors.push("sfu-cleanup");
    }
  check(errors.length === 0, "fixture-cleanup-incomplete");
  f.cleaned = true;
}
const watchdog = setTimeout(() => {
  report.passed = false;
  report.failure = "fixture-global-timeout";
  // The parent runner still tears down this entire disposable Compose project.
  void save().finally(() => process.exit(1));
}, 180000);
try {
  const a = await apiInstance(),
    b = await apiInstance();
  check((await a.store.all()).length === 0, "disposable-database-not-empty");
  await until(async () => {
    try {
      await sfu.listRooms();
      return true;
    } catch {
      return false;
    }
  }, "fixture-sfu-unavailable");
  check((await sfu.listRooms()).length === 0, "disposable-sfu-not-empty");
  await runVariant(a, b, false);
  await runVariant(a, b, true);
  report.passed = true;
} catch (error) {
  report.failedStage = stage;
  report.failure = error?.safeReason || "fixture-operation-failed";
  process.exitCode = 1;
} finally {
  for (const f of fixtures)
    try {
      await cleanupFixture(f);
    } catch {
      report.cleanup.fixtureFailed = true;
      report.passed = false;
      process.exitCode = 1;
    }
  const apps = await Promise.allSettled(
    instances.map(async (api) => {
      if (api.app) await bounded(api.app.close(), "api-close-timeout");
      else await api.store.close();
    }),
  );
  if (apps.some((x) => x.status !== "fulfilled")) {
    report.cleanup.apiFailed = true;
    report.passed = false;
    process.exitCode = 1;
  }
  try {
    await bounded(
      Promise.resolve().then(() => dispose()),
      "native-sdk-dispose-timeout",
    );
    report.cleanup.nativeSdkDisposed = true;
  } catch {
    report.cleanup.nativeSdkDisposed = false;
    report.passed = false;
    process.exitCode = 1;
  }
  report.cleanup.allFixturesReleased =
    fixtures.length === 2 && fixtures.every((f) => f.cleaned);
  report.cleanup.apiInstancesClosed = apps.every(
    (x) => x.status === "fulfilled",
  );
  report.cleanup.existingInstallationTouched = false;
  report.completedAt = new Date().toISOString();
  clearTimeout(watchdog);
  await save();
  console.log(JSON.stringify(report, null, 2));
}
