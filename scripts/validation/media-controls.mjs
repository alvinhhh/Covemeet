import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import {
  RoomServiceClient,
  TrackSource as ServerSource,
} from "livekit-server-sdk";
import { WebSocket, WebSocketServer } from "ws";

// This process never creates an audio source, accesses a device, or plays media.
process.umask(0o077);
process.env.RUST_LOG = "error";
const {
  Room,
  VideoSource,
  VideoFrame,
  LocalVideoTrack,
  TrackPublishOptions,
  TrackSource,
  VideoBufferType,
  dispose,
} = await import("@livekit/rtc-node");
const envPath = process.env.VALIDATION_ENV_FILE || ".env";
const env = { ...parseEnv(await readFile(envPath, "utf8")), ...process.env };
const apiOrigin =
  env.VALIDATION_API_URL || env.SITE_ORIGIN || "http://localhost:5173";
const browserOrigin = env.SITE_ORIGIN || apiOrigin;
const sfuUrl =
  env.VALIDATION_LIVEKIT_URL || env.LIVEKIT_URL || "http://127.0.0.1:7880";
for (const value of [apiOrigin, browserOrigin, sfuUrl]) {
  const hostname = new URL(value).hostname;
  assert(
    ["localhost", "127.0.0.1", "[::1]", "livekit", "core"].includes(hostname) ||
      hostname.endsWith(".localhost"),
    "Validation accepts only local test endpoints",
  );
}
assert(
  env.LIVEKIT_API_KEY && (env.LIVEKIT_API_SECRET || env.LIVEKIT_SECRET),
  "Local SFU credentials are required",
);
const sfu = new RoomServiceClient(
  sfuUrl,
  env.LIVEKIT_API_KEY,
  env.LIVEKIT_API_SECRET || env.LIVEKIT_SECRET,
);
const runId = randomUUID();
const reportPath = path.resolve(
  env.VALIDATION_REPORT || `test-results/media-controls-${runId}.json`,
);
await mkdir(path.dirname(reportPath), { recursive: true });
const report = {
  runId,
  startedAt: new Date().toISOString(),
  result: "running",
  endpoints: { api: apiOrigin, gateway: browserOrigin, sfu: sfuUrl },
  safety: {
    generatedVideoOnly: true,
    audioSources: 0,
    deviceAccess: false,
    mediaPlayback: false,
  },
  scope:
    "Isolated meeting and webinar; authorization and media enforcement, not load or browser UX",
  limitations: [
    "No audio is generated. Microphone restrictions are checked against signed grants and SFU permissions; audible/audio-packet delivery is not tested.",
  ],
  checks: [],
  cleanup: {},
};
async function checkpoint(name, evidence = {}) {
  report.checks.push({
    name,
    passed: true,
    at: new Date().toISOString(),
    ...evidence,
  });
  await save();
  console.log(`PASS ${name}`);
}
async function save() {
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
}
async function until(name, work, timeout = 12_000, interval = 150) {
  const deadline = Date.now() + timeout;
  do {
    const value = await work();
    if (value) return value;
    await delay(interval);
  } while (Date.now() < deadline);
  throw new Error(`Timed out: ${name}`);
}
async function bounded(promise, label, timeout = 15_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out: ${label}`)),
          timeout,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
class Client {
  cookies = new Map();
  header() {
    return [...this.cookies]
      .map(([key, value]) => `${key}=${value}`)
      .join("; ");
  }
  async call(
    route,
    body,
    method = body === undefined ? "GET" : "POST",
    expected = 200,
  ) {
    const response = await fetch(`${apiOrigin}/api${route}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Origin: browserOrigin,
        Cookie: this.header(),
        "Content-Type": "application/json",
        "X-Requested-With": "MeetingPlatform",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0],
        index = pair.indexOf("=");
      this.cookies.set(pair.slice(0, index), pair.slice(index + 1));
    }
    const result = await response.json();
    assert.equal(
      response.status,
      expected,
      `${method} ${route.split("/").at(-1)}: ${result.error || response.status}`,
    );
    return result;
  }
}

// rtc-node cannot attach a browser cookie. A loopback-only relay adds exactly
// the current test client's cookie and Origin while keeping the real gateway
// and its authorization checks in the signaling path. It never mints tokens.
async function relay(gatewayUrl, cookies, token) {
  const diagnostics = [];
  const targetFor = (requestUrl) => {
    const incoming = new URL(requestUrl, "http://localhost");
    const target = new URL(gatewayUrl);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    return target;
  };
  const server = createServer(async (req, res) => {
    const target = targetFor(req.url);
    target.protocol = target.protocol === "wss:" ? "https:" : "http:";
    diagnostics.push({ method: req.method, path: target.pathname });
    if (
      req.method !== "GET" ||
      !/^\/rtc(?:\/v1)?\/validate$/.test(target.pathname)
    ) {
      res.writeHead(404).end();
      return;
    }
    target.pathname = "/rtc/validate";
    target.searchParams.set("access_token", token);
    try {
      const response = await fetch(target, {
        headers: { Origin: browserOrigin, Cookie: cookies },
        signal: AbortSignal.timeout(8000),
      });
      res.writeHead(response.status).end(await response.text());
    } catch {
      res.writeHead(502).end();
    }
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const sockets = new Set();
  server.on("upgrade", (req, socket, head) => {
    const target = targetFor(req.url);
    // rtc-node v1 uses header auth; browser clients use this query parameter.
    target.searchParams.set("access_token", token);
    diagnostics.push({ method: "upgrade", path: target.pathname });
    if (!/^\/rtc(?:\/v1)?$/.test(target.pathname)) return socket.destroy();
    const upstream = new WebSocket(target, {
      headers: { Origin: browserOrigin, Cookie: cookies },
      maxPayload: 1024 * 1024,
      handshakeTimeout: 10_000,
    });
    sockets.add(upstream);
    upstream.on("error", () => socket.destroy());
    upstream.on("unexpected-response", (_request, response) => {
      diagnostics.push({
        path: target.pathname,
        gatewayStatus: response.statusCode,
      });
      socket.end(
        `HTTP/1.1 ${response.statusCode} Rejected\r\nConnection: close\r\n\r\n`,
      );
      response.resume();
      upstream.terminate();
    });
    upstream.on("open", () =>
      wss.handleUpgrade(req, socket, head, (client) => {
        sockets.add(client);
        client.on(
          "message",
          (data, binary) =>
            upstream.readyState === WebSocket.OPEN &&
            upstream.send(data, { binary }),
        );
        upstream.on(
          "message",
          (data, binary) =>
            client.readyState === WebSocket.OPEN &&
            client.send(data, { binary }),
        );
        const close = () => {
          client.terminate();
          upstream.terminate();
          sockets.delete(client);
          sockets.delete(upstream);
        };
        client.on("close", close);
        client.on("error", close);
        upstream.on("close", close);
      }),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    diagnostics,
    url: `ws://127.0.0.1:${server.address().port}`,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      wss.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
const peers = new Set();
const roomNames = new Set();
function claims(grant) {
  return JSON.parse(
    Buffer.from(grant.token.split(".")[1], "base64url").toString(),
  );
}
async function connect(client, grant) {
  const token = claims(grant);
  roomNames.add(token.video.room);
  const bridge = await relay(grant.url, client.header(), grant.token);
  const room = new Room();
  const peer = {
    room,
    bridge,
    id: token.sub,
    roomName: token.video.room,
    grant,
    stop: false,
    frames: 0,
    closed: false,
  };
  peers.add(peer);
  try {
    await bounded(
      room.connect(bridge.url, grant.token, {
        autoSubscribe: false,
        dynacast: false,
      }),
      "SDK connection",
    );
  } catch (error) {
    report.relayFailure = bridge.diagnostics;
    await close(peer);
    throw error;
  }
  await until("SFU participant admission", () => member(peer));
  return peer;
}
async function member(peer) {
  try {
    return (await sfu.listParticipants(peer.roomName)).find(
      (p) => p.identity === peer.id,
    );
  } catch (error) {
    if (/not found|does not exist/i.test(String(error))) return undefined;
    throw error;
  }
}
async function publish(peer) {
  const source = new VideoSource(160, 90);
  peer.track = LocalVideoTrack.createVideoTrack(
    "Silent validation video",
    source,
  );
  const options = new TrackPublishOptions();
  options.source = TrackSource.SOURCE_CAMERA;
  await bounded(
    peer.room.localParticipant.publishTrack(peer.track, options),
    "camera publication",
    8000,
  );
  peer.framesTask = (async () => {
    while (!peer.stop) {
      const data = new Uint8Array(160 * 90 * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = (peer.frames * 13) % 255;
        data[i + 1] = 120;
        data[i + 2] = 70;
        data[i + 3] = 255;
      }
      source.captureFrame(new VideoFrame(data, 160, 90, VideoBufferType.RGBA));
      peer.frames++;
      await delay(100);
    }
  })();
  const p = await until("SFU camera track", async () => {
    const value = await member(peer);
    return value?.tracks.some((t) => t.source === ServerSource.CAMERA) &&
      peer.frames >= 5
      ? value
      : false;
  });
  assert(
    p.tracks.every((track) => track.type === 1),
    "Unexpected audio track exists",
  );
  peer.transportEvidence = await until(
    "video RTP bytes and negotiated DTLS/SRTP",
    async () => {
      const stats = (await peer.room.getRtcStats()).publisherStats;
      const videoBytesSent = stats
        .filter((entry) => entry.stats.case === "outboundRtp")
        .reduce(
          (sum, entry) => sum + Number(entry.stats.value.sent?.bytesSent || 0),
          0,
        );
      const transport = stats.find(
        (entry) =>
          entry.stats.case === "transport" &&
          entry.stats.value.transport?.dtlsState === 2,
      )?.stats.value.transport;
      return videoBytesSent > 0 && transport?.srtpCipher
        ? {
            videoBytesSent,
            dtlsConnected: true,
            dtlsCipher: transport.dtlsCipher,
            srtpCipher: transport.srtpCipher,
          }
        : false;
    },
  );
  return p;
}
async function close(peer) {
  if (peer.closed) return;
  peer.closed = true;
  peer.stop = true;
  await peer.framesTask;
  await peer.track?.close().catch(() => {});
  await peer.room.disconnect().catch(() => {});
  await peer.bridge.close();
  peers.delete(peer);
}
async function removed(peer, label) {
  const start = Date.now();
  await until(`${label} SFU disconnect`, async () => !(await member(peer)));
  await delay(300);
  assert.equal(
    await member(peer),
    undefined,
    "Participant returned without new authority",
  );
  await checkpoint(label, {
    sfuParticipantRemoved: true,
    previouslyPublishedFrames: peer.frames,
    mediaTransport: peer.transportEvidence,
    observedMilliseconds: Date.now() - start,
  });
  await close(peer);
}
async function deniedGateway(client, grant, label, withCookie = true) {
  const target = new URL("/rtc", grant.url);
  target.searchParams.set("access_token", grant.token);
  const status = await bounded(
    new Promise((resolve, reject) => {
      const ws = new WebSocket(target, {
        headers: {
          Origin: browserOrigin,
          ...(withCookie ? { Cookie: client.header() } : {}),
        },
        handshakeTimeout: 8000,
      });
      ws.on("unexpected-response", (_req, response) => {
        resolve(response.statusCode);
        response.resume();
        ws.terminate();
      });
      ws.on("open", () => {
        ws.terminate();
        reject(new Error(`${label}: gateway admitted forbidden token`));
      });
      ws.on("error", reject);
    }),
    "gateway denial",
  );
  assert.equal(status, 403, label);
  await checkpoint(label, { gatewayStatus: status });
}

async function recordingCycle(client, code) {
  const mailpit = env.VALIDATION_MAILPIT_URL || "http://mailpit:8025";
  assert(
    ["mailpit", "localhost", "127.0.0.1", "[::1]"].includes(
      new URL(mailpit).hostname,
    ),
    "Recording validation requires local Mailpit",
  );
  const email = `validation-${runId}@example.test`;
  const path = (suffix = "") => `/meetings/${code}${suffix}`;
  const config = await client.call("/config");
  assert.equal(
    config.recordingAvailable,
    true,
    "Enable recording on the isolated test stack before this optional check",
  );
  const mailText = async (pattern) =>
    until(
      "local Mailpit message",
      async () => {
        const inbox = await fetch(`${mailpit}/api/v1/messages`, {
          signal: AbortSignal.timeout(8000),
        }).then((r) => r.json());
        for (const message of inbox.messages || []) {
          if (!message.To?.some((to) => to.Address === email)) continue;
          const full = await fetch(
            `${mailpit}/api/v1/message/${encodeURIComponent(message.ID)}`,
            { signal: AbortSignal.timeout(8000) },
          ).then((r) => r.json());
          const found = pattern.exec(full.Text || "");
          if (found) return found[1];
        }
        return false;
      },
      30_000,
      1000,
    );
  await client.call(path("/recordings"), {}, "POST", 403);
  await client.call(path("/host-email"), { email });
  await client.call(path("/verify-email"), {
    otp: await mailText(/Verification code: (\d{6})/),
  });
  await client.call(path(), { recordingAllowed: true }, "PATCH");
  await client.call(path("/recordings"), {});
  const row = (await client.call(path("/state"))).recordings.at(-1);
  assert(row?.id, "Recording start returned no recording state");
  await checkpoint(
    "optional recording starts only after host email verification and opt-in",
    { recordingId: row.id },
  );
  const recordingState = async (wanted) => {
    const current = (await client.call(path("/state"))).recordings.find(
      (r) => r.id === row.id,
    );
    if (current?.status === "failed")
      throw new Error(`Recorder failed: ${current.error || "unknown"}`);
    return current?.status === wanted;
  };
  await until(
    "EGRESS_ACTIVE reflected by recording status",
    () => recordingState("recording"),
    240_000,
    2000,
  );
  await checkpoint(
    "recorder is active before the thirty-second silent capture",
  );
  await delay(30_000);
  await client.call(path(`/recordings/${row.id}/stop`), {});
  await until(
    "encrypted recording ready",
    () => recordingState("ready"),
    180_000,
    2000,
  );
  const beforeLink = Date.now();
  const link = await client.call(path(`/recordings/${row.id}/link`), {});
  assert(
    link.expiresAt - beforeLink >= 86_390_000 &&
      link.expiresAt - beforeLink <= 86_410_000,
  );
  const downloadUrl = new URL(link.url);
  assert.equal(downloadUrl.pathname, `/download/${code}`);
  assert.equal(downloadUrl.search, "");
  const token = downloadUrl.hash.slice(1);
  assert(token);
  let password = await mailText(/Password: (.+)/);
  const response = await fetch(`${apiOrigin}/api${path("/download")}`, {
    method: "POST",
    signal: AbortSignal.timeout(90_000),
    headers: {
      Origin: browserOrigin,
      Cookie: client.header(),
      "Content-Type": "application/json",
      "X-Requested-With": "MeetingPlatform",
    },
    body: JSON.stringify({ token, password }),
  });
  assert.equal(response.status, 200);
  assert(
    response.headers.get("content-disposition")?.startsWith("attachment;"),
  );
  let bytes = 0,
    prefix = Buffer.alloc(0);
  const hash = createHash("sha256");
  for await (const chunk of response.body) {
    bytes += chunk.length;
    hash.update(chunk);
    if (prefix.length < 64)
      prefix = Buffer.concat([prefix, chunk]).subarray(0, 64);
  }
  assert(
    bytes > 1024 && prefix.includes(Buffer.from("ftyp")),
    "Download was not a nonempty MP4",
  );
  await client.call(
    path("/download"),
    { token, password: "incorrect-validation-password" },
    "POST",
    403,
  );
  await client.call(path(`/recordings/${row.id}/revoke`), {});
  await client.call(path("/download"), { token, password }, "POST", 403);
  password = "";
  await client.call(path(), { recordingAllowed: false }, "PATCH");
  await client.call(path("/recordings"), {}, "POST", 403);
  await checkpoint(
    "encrypted recording downloads with emailed password; wrong password, revoked link and recording-off are denied",
    {
      recordingId: row.id,
      plaintextBytes: bytes,
      decryptedSha256: hash.digest("hex"),
      linkLifetimeMilliseconds: link.expiresAt - beforeLink,
      passwordDeliveredToLocalMailpit: true,
    },
  );
}

const host = new Client(),
  guest = new Client();
const meetingPassword = `Local-${randomUUID()}`;
let code,
  ended = false;
let stage = "configuration";
const route = (suffix = "") => `/meetings/${code}${suffix}`;
const media = (client) => client.call(route("/media"), {});
const action = (id, value, extra = {}) =>
  host.call(route(`/participants/${id}/action`), { action: value, ...extra });
try {
  const config = await host.call("/config");
  assert.equal(config.mediaAvailable, true);
  assert.equal(
    new URL(config.meetingOrigin).origin,
    new URL(browserOrigin).origin,
  );
  await checkpoint("local application and SFU configuration reachable", {
    edition: config.edition,
  });
  stage = "meeting creation";
  const created = await host.call("/meetings", {
    title: `Silent validation ${runId.slice(0, 8)}`,
    hostName: "Validation host",
    password: meetingPassword,
    mode: "meeting",
    ...(env.CREATION_KEY ? { creationKey: env.CREATION_KEY } : {}),
  });
  code = created.code;
  const hostIdentity = await host.call(route("/host"), {
    token: created.hostToken,
  });
  const hostGrant = await media(host);
  roomNames.add(claims(hostGrant).video.room);
  stage = "lobby";
  const joined = await guest.call(route("/join"), {
    name: "Validation guest",
    password: meetingPassword,
  });
  let id = joined.participantId;
  assert.equal((await guest.call(route("/state"))).me.status, "waiting");
  await guest.call(route("/media"), {}, "POST", 403);
  await checkpoint("lobby blocks media credentials before host admission");
  await action(id, "admit");
  let grant = await media(guest);
  await deniedGateway(guest, grant, "gateway requires session cookie", false);
  let peer = await connect(guest, grant);
  await publish(peer);
  await checkpoint(
    "admitted guest publishes real silent video through gateway",
    { cameraTracks: 1, generatedFrames: peer.frames },
  );

  stage = "meeting lock";
  await host.call(route(), { locked: true }, "PATCH");
  await new Client().call(
    route("/join"),
    { name: "Locked entry", password: meetingPassword },
    "POST",
    403,
  );
  assert((await member(peer))?.tracks.length);
  await checkpoint("lock denies new entry and preserves admitted media");
  await host.call(route(), { locked: false }, "PATCH");

  stage = "microphone restriction";
  await action(id, "block-audio");
  await removed(peer, "microphone restriction disconnects existing publisher");
  await deniedGateway(
    guest,
    grant,
    "old media token rejected after microphone restriction",
  );
  grant = await media(guest);
  assert(!claims(grant).video.canPublishSources.includes("microphone"));
  peer = await connect(guest, grant);
  const videoAllowed = await publish(peer);
  assert(
    !videoAllowed.permission.canPublishSources.includes(
      ServerSource.MICROPHONE,
    ),
  );
  await checkpoint(
    "SFU microphone grant is absent while camera publication remains allowed",
  );

  stage = "video restriction";
  await action(id, "block-video");
  await removed(peer, "video restriction disconnects existing publisher");
  await deniedGateway(
    guest,
    grant,
    "old media token rejected after video restriction",
  );
  grant = await media(guest);
  assert.equal(claims(grant).video.canPublish, false);
  peer = await connect(guest, grant);
  assert.equal((await member(peer)).permission.canPublish, false);
  let rejected = false;
  try {
    await publish(peer);
  } catch {
    rejected = true;
  }
  assert.equal(rejected, true, "SFU accepted a prohibited video track");
  assert.equal((await member(peer)).tracks.length, 0);
  await checkpoint(
    "SFU rejects a real camera publication when audio and video are blocked",
    { cameraTracks: 0 },
  );
  await action(id, "allow-video");
  await removed(peer, "restoring video rotates the previous connection");
  grant = await media(guest);
  peer = await connect(guest, grant);
  await publish(peer);

  stage = "breakout movement";
  await guest.call(route("/messages"), { text: "main-only-validation" });
  await host.call(route("/breakouts"), { name: "Validation breakout" });
  const breakoutId = (await host.call(route("/state"))).meeting.breakouts[0].id;
  const mainRoom = peer.roomName;
  await host.call(route("/move"), { participantId: id, breakoutId });
  await removed(peer, "breakout movement removes publisher from main SFU room");
  await deniedGateway(
    guest,
    grant,
    "previous room token rejected after breakout movement",
  );
  grant = await media(guest);
  peer = await connect(guest, grant);
  await publish(peer);
  assert.notEqual(peer.roomName, mainRoom);
  assert(
    !(await guest.call(route("/state"))).messages.some(
      (m) => m.text === "main-only-validation",
    ),
  );
  await guest.call(route("/messages"), { text: "breakout-only-validation" });
  assert(
    !(await host.call(route("/state"))).messages.some(
      (m) => m.text === "breakout-only-validation",
    ),
  );
  await host.call(route("/broadcast"), { text: "broadcast-validation" });
  assert(
    (await guest.call(route("/state"))).messages.some(
      (m) => m.text === "broadcast-validation",
    ),
  );
  await checkpoint(
    "breakout has separate media room, scoped chat and host broadcast",
  );
  await guest.call(route("/return-main"), {});
  await removed(peer, "return to main removes old breakout publisher");
  await deniedGateway(guest, grant, "old breakout token rejected on return");
  grant = await media(guest);
  peer = await connect(guest, grant);
  await publish(peer);
  assert.equal(peer.roomName, mainRoom);
  await host.call(route("/move"), { participantId: id, breakoutId });
  await removed(peer, "second move removes previous main publisher");
  grant = await media(guest);
  peer = await connect(guest, grant);
  await publish(peer);
  await host.call(route("/close-breakouts"), {});
  await removed(peer, "closing breakouts disconnects breakout publishers");
  await deniedGateway(guest, grant, "closed breakout token rejected");
  grant = await media(guest);
  peer = await connect(guest, grant);
  await publish(peer);
  assert.equal(peer.roomName, mainRoom);

  stage = "kick and fresh rejoin";
  await action(id, "kick");
  await removed(peer, "kick removes actual SFU publisher");
  await deniedGateway(
    guest,
    grant,
    "kicked session cannot reconnect with previous token",
  );
  await guest.call(route("/media"), {}, "POST", 403);
  const rejoined = await guest.call(route("/join"), {
    name: "Validation guest rejoined",
    password: meetingPassword,
  });
  assert.notEqual(rejoined.participantId, id);
  id = rejoined.participantId;
  assert.equal((await guest.call(route("/state"))).me.status, "waiting");
  await action(id, "admit");
  grant = await media(guest);
  peer = await connect(guest, grant);
  await publish(peer);
  await checkpoint(
    "regular kick allows same-device fresh lobby entry and readmission",
  );

  stage = "device meeting ban";
  await action(id, "ban", { banDevice: true, banIp: false });
  await removed(peer, "device ban removes actual SFU publisher");
  await deniedGateway(guest, grant, "device-banned session cannot reconnect");
  await guest.call(
    route("/join"),
    { name: "Banned device", password: meetingPassword },
    "POST",
    403,
  );
  const otherDevice = new Client();
  const fresh = await otherDevice.call(route("/join"), {
    name: "Separate device marker",
    password: meetingPassword,
  });
  await action(fresh.participantId, "admit");
  grant = await media(otherDevice);
  peer = await connect(otherDevice, grant);
  await publish(peer);
  await checkpoint(
    "device ban blocks signed device marker but permits a new marker on the same IP",
  );

  stage = "IP meeting ban";
  await action(fresh.participantId, "ban", { banIp: true, banDevice: false });
  await removed(peer, "IP ban removes actual SFU publisher");
  await deniedGateway(otherDevice, grant, "IP-banned session cannot reconnect");
  await new Client().call(
    route("/join"),
    { name: "New device same IP", password: meetingPassword },
    "POST",
    403,
  );
  await checkpoint(
    "IP meeting ban rejects a new device marker from the same address",
  );

  stage = "meeting end";
  const finalHostGrant = await media(host);
  peer = await connect(host, finalHostGrant);
  await publish(peer);
  assert.equal(peer.id, hostIdentity.participantId);
  if (env.VALIDATION_RECORDING === "true") {
    stage = "optional encrypted recording";
    await recordingCycle(host, code);
    stage = "meeting end";
  }
  await host.call(route("/end"), {});
  ended = true;
  await removed(peer, "ending meeting disconnects actual host publisher");
  await deniedGateway(
    host,
    finalHostGrant,
    "ended meeting rejects previously valid host reconnect",
  );
  await host.call(route("/media"), {}, "POST", 410);
  await new Client().call(
    route("/join"),
    { name: "After end", password: meetingPassword },
    "POST",
    410,
  );
  await checkpoint("ended meeting rejects new entry and media credentials");

  stage = "webinar viewer restriction";
  const webinar = await host.call("/meetings", {
    title: `Silent webinar validation ${runId.slice(0, 8)}`,
    hostName: "Validation webinar host",
    password: meetingPassword,
    mode: "webinar",
    ...(env.CREATION_KEY ? { creationKey: env.CREATION_KEY } : {}),
  });
  code = webinar.code;
  ended = false;
  await host.call(route("/host"), { token: webinar.hostToken });
  const viewer = new Client();
  const audience = await viewer.call(route("/join"), {
    name: "Validation viewer",
    password: meetingPassword,
  });
  await action(audience.participantId, "admit");
  grant = await media(viewer);
  assert.equal(claims(grant).video.canPublish, false);
  peer = await connect(viewer, grant);
  let viewerPublishRejected = false;
  try {
    await publish(peer);
  } catch {
    viewerPublishRejected = true;
  }
  assert.equal(viewerPublishRejected, true);
  assert.equal((await member(peer)).tracks.length, 0);
  await host.call(
    route(`/participants/${audience.participantId}/action`),
    { action: "allow-video" },
    "POST",
    409,
  );
  await host.call(
    route(`/participants/${audience.participantId}/action`),
    { action: "allow-audio" },
    "POST",
    409,
  );
  await checkpoint(
    "webinar viewer cannot publish camera or bypass stage through device controls",
  );

  stage = "webinar stage promotion";
  await action(audience.participantId, "promote");
  await removed(peer, "stage promotion rotates the viewer connection");
  await deniedGateway(
    viewer,
    grant,
    "pre-promotion viewer token cannot reconnect",
  );
  grant = await media(viewer);
  peer = await connect(viewer, grant);
  await publish(peer);
  assert.equal((await viewer.call(route("/state"))).me.role, "participant");
  await checkpoint("promoted webinar presenter publishes real silent video");

  stage = "webinar stage demotion";
  await action(audience.participantId, "demote");
  await removed(peer, "demotion removes actual presenter publisher from SFU");
  await deniedGateway(
    viewer,
    grant,
    "demoted presenter token cannot reconnect",
  );
  grant = await media(viewer);
  peer = await connect(viewer, grant);
  assert.equal((await member(peer)).permission.canPublish, false);
  assert.equal((await viewer.call(route("/state"))).me.role, "viewer");
  await checkpoint(
    "demoted presenter reconnects with SFU publication disabled",
  );
  await host.call(route("/end"), {});
  ended = true;
  await removed(peer, "webinar end disconnects the audience connection");
  await deniedGateway(viewer, grant, "ended webinar rejects viewer reconnect");
  report.result = "passed";
} catch (error) {
  report.result = "failed";
  report.failure = {
    stage,
    message: String(error.message || error).replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[redacted token]",
    ),
  };
  console.error(`FAIL ${stage}: ${report.failure.message}`);
  process.exitCode = 1;
} finally {
  for (const peer of peers) await close(peer).catch(() => {});
  if (code && !ended) {
    try {
      await host.call(route("/end"), {});
      ended = true;
    } catch {
      /* Report incomplete cleanup below. */
    }
  }
  let roomsRemoved = true;
  for (const name of roomNames) {
    try {
      await sfu.deleteRoom(name);
    } catch (error) {
      if (!/not found|does not exist/i.test(String(error)))
        roomsRemoved = false;
    }
  }
  await dispose();
  report.cleanup = {
    meetingEnded: ended,
    sfuRoomsRemoved: roomsRemoved,
    relayClosed: peers.size === 0,
  };
  if (!ended || !roomsRemoved || peers.size) {
    report.result = "failed";
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  await save();
  console.log(
    `Result: ${report.result}; ${report.checks.length} checks; evidence ${reportPath}`,
  );
}
