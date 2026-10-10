import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { isAbsolute, resolve } from "node:path";

const check = (ok, label) => { if (!ok) throw new Error(label); };
const timeout = (promise, ms, label) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer));
};
const keys = (value, names) => check(value && Object.keys(value).sort().join() === names.split(",").sort().join(), "rtp-protocol-fields");
const count = value => Number.isSafeInteger(value) && value >= 0;
const MAX_PEERS = 982, FIRST_PEER = 18, WEBINAR_VIEWERS = 1000, WEBINAR_STAGE = 10, MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const GO_FAULTS = new Set([
  "receiver-input", "receiver-command", "receiver-disconnected", "receiver-reconnecting",
  "receiver-subscription-failed", "receiver-unexpected-source", "receiver-codec",
  "receiver-duplicate-source", "receiver-read-deadline", "receiver-rtp-stopped",
  "receiver-sequence-discontinuity", "receiver-connect-timeout",
  "receiver-connect-failed", "receiver-grant-timeout", "receiver-invalid-grant", "receiver-resources",
]);
const outputLimit = peers => 1024 + peers * 4096;
const connectLimit = peers => Math.min(Math.ceil(peers / 20) * 15000, 90000) + 3000;

function inputIndices(config) {
  const webinar = config?.profile === "webinar";
  keys(config, webinar ? "peers,profile,publishers" : "peers,publishers");
  check(Array.isArray(config.peers) && (webinar ? config.peers.length === WEBINAR_VIEWERS : config.peers.length >= 2 && config.peers.length <= MAX_PEERS), "rtp-input-peers");
  const publisherCount = webinar ? WEBINAR_STAGE : 9;
  check(Array.isArray(config.publishers) && config.publishers.length === publisherCount && new Set(config.publishers).size === publisherCount && config.publishers.every(value => typeof value === "string" && value.length && Buffer.byteLength(value) <= 256), "rtp-input-publishers");
  return config.peers.map((peer, index) => {
    keys(peer, webinar ? "index,url" : "index,url,token");
    const port = typeof peer.url === "string" && /^ws:\/\/127\.0\.0\.1:([0-9]{1,5})$/.exec(peer.url)?.[1];
    check(peer.index === FIRST_PEER + index && Number(port) >= 1 && Number(port) <= 65535 &&
      (webinar || typeof peer.token === "string" && peer.token.length > 0 && Buffer.byteLength(peer.token) <= 8192), "rtp-input-peer");
    return peer.index;
  });
}

function viewerGrant(token, publishers, seen, room) {
  check(typeof token === "string" && token.length > 0 && Buffer.byteLength(token) <= 8192, "rtp-grant-invalid");
  const parts = token.split(".");
  let claims;
  try { if (parts.length === 3) claims = JSON.parse(Buffer.from(parts[1], "base64url")); } catch {}
  check(typeof claims?.sub === "string" && claims.sub.length > 0 && !publishers.has(claims.sub) && !seen.has(claims.sub) &&
    Number.isSafeInteger(claims.exp) && claims.exp > Math.floor(Date.now() / 1000) + 15 && claims.exp <= Math.floor(Date.now() / 1000) + 180 &&
    typeof claims.video?.room === "string" && claims.video.room.length > 0 && (!room.value || room.value === claims.video.room) &&
    claims.video.roomJoin === true && claims.video.canSubscribe === true && claims.video.hidden === true &&
    claims.video.canPublish === false && claims.video.canPublishData === false, "rtp-grant-invalid");
  seen.add(claims.sub); room.value = claims.video.room;
}

export function validateSnapshot(message, indices, publisherCount = 9) {
  keys(message, "type,id,rows,cpuMicros,rssBytes");
  check(message.type === "snapshot" && count(message.id) && message.id > 0 && count(message.cpuMicros) && count(message.rssBytes), "rtp-protocol-resources");
  const profileSize = publisherCount === WEBINAR_STAGE ? indices?.length === WEBINAR_VIEWERS
    : publisherCount === 9 && indices?.length >= 2 && indices?.length <= MAX_PEERS;
  check(Array.isArray(indices) && profileSize && Array.isArray(message.rows) && message.rows.length === indices.length, "rtp-protocol-peers");
  for (const [index, row] of message.rows.entries()) {
    keys(row, "index,streams,bytesReceived,packetsReceived,receivedFrames,packetsLost,lossMetric,receivePayloadBytes,subscriber");
    check(row.index === indices[index] && row.lossMetric === "unusable-packet-gaps", "rtp-protocol-identity");
    for (const key of ["bytesReceived", "packetsReceived", "receivedFrames", "packetsLost", "receivePayloadBytes"]) check(count(row[key]), "rtp-protocol-counter");
    check(row.receivePayloadBytes >= row.bytesReceived && Array.isArray(row.streams) && row.streams.length <= (publisherCount === WEBINAR_STAGE ? 2 * publisherCount : publisherCount), "rtp-protocol-streams");
    const seenStreams = new Set(); let prior = -1;
    for (const stream of row.streams) {
      keys(stream, publisherCount === WEBINAR_STAGE ? "publisher,kind,bytes,packets,frames,unusablePacketGaps" : "publisher,bytes,packets,frames,unusablePacketGaps");
      check(Number.isInteger(stream.publisher) && stream.publisher >= 0 && stream.publisher < publisherCount &&
        (publisherCount !== WEBINAR_STAGE || ["audio", "video"].includes(stream.kind)), "rtp-protocol-source");
      const key = `${stream.publisher}:${stream.kind ?? "video"}`;
      check(!seenStreams.has(key), "rtp-protocol-source"); seenStreams.add(key);
      const order = publisherCount === WEBINAR_STAGE ? stream.publisher * 2 + (stream.kind === "video" ? 1 : 0) : stream.publisher;
      check(order > prior, "rtp-protocol-source"); prior = order;
      for (const key of ["bytes", "packets", "frames", "unusablePacketGaps"]) check(count(stream[key]), "rtp-protocol-counter");
    }
    for (const [aggregate, field] of [["bytesReceived", "bytes"], ["packetsReceived", "packets"], ["receivedFrames", "frames"], ["packetsLost", "unusablePacketGaps"]]) {
      check(row[aggregate] === row.streams.reduce((sum, stream) => sum + stream[field], 0), "rtp-protocol-counter-sum");
    }
    if (row.subscriber !== null) {
      keys(row.subscriber, "dtlsConnected,remoteCertificatePresent,candidateType,protocol,srtpAuthenticated,srtpEvidence,dtlsCipher,srtpCipher");
      check(row.subscriber.dtlsConnected === true && row.subscriber.remoteCertificatePresent === true && row.subscriber.srtpAuthenticated === true && row.subscriber.srtpEvidence === "pion-srtp-read", "rtp-protocol-transport");
      check(["host", "srflx", "prflx", "relay"].includes(row.subscriber.candidateType) && ["udp", "tcp"].includes(row.subscriber.protocol) && row.subscriber.dtlsCipher === null && row.subscriber.srtpCipher === null, "rtp-protocol-transport");
    }
  }
  return message;
}

export function validateFault(message) {
  keys(message, "type,failure");
  check(message.type === "fault" && GO_FAULTS.has(message.failure), "rtp-protocol-fault");
  return message.failure;
}

export function startReceiver(config, binary, fault, offline = false, grantProvider) {
  const indices = inputIndices(config), input = JSON.stringify(config);
  const webinar = config.profile === "webinar";
  check(webinar ? typeof grantProvider === "function" : grantProvider === undefined, "rtp-grant-provider");
  check(Buffer.byteLength(input) <= MAX_CONFIG_BYTES, "rtp-input-too-large");
  check(isAbsolute(binary), "rtp-binary-absolute-path");
  const args = offline ? [fileURLToPath(import.meta.url), "--offline-child"] : [];
  const child = spawn(binary, args, { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map(); let sequence = 0, closing = false, finished = false, failed = false, buffered = "", joined = false;
  const requested = new Set(), seen = new Set(), room = { value: "" }, publishers = new Set(config.publishers);
  let resolveConnected, rejectConnected;
  const connected = new Promise((resolve, reject) => { resolveConnected = resolve; rejectConnected = reject; }); connected.catch(() => {});
  const fail = label => {
    if (failed) return; failed = true;
    rejectConnected(new Error(label));
    for (const wait of pending.values()) wait.reject(new Error(label)); pending.clear();
    if (!closing) fault(label);
  };
  const exited = new Promise(resolve => {
    child.once("close", (code, signal) => { if (!closing || !finished) fail("rtp-process-exited"); resolve({ code, signal }); });
    child.once("error", () => { fail("rtp-process-error"); resolve({ code: null, signal: null }); });
  });
  child.stdin.on("error", () => fail("rtp-input-closed"));
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffered += chunk;
    while (buffered.includes("\n")) {
      const offset = buffered.indexOf("\n"), line = buffered.slice(0, offset); buffered = buffered.slice(offset + 1);
      if (Buffer.byteLength(line) > outputLimit(indices.length)) { fail("rtp-output-too-large"); child.kill("SIGTERM"); return; }
      try {
        const message = JSON.parse(line);
        if (message.type === "grant-request") {
          keys(message, "type,index");
          check(webinar && !joined && indices.includes(message.index) && !requested.has(message.index), "rtp-protocol-grant-request");
          if (closing) continue;
          requested.add(message.index);
          Promise.resolve().then(() => grantProvider(message.index)).then(token => {
            if (closing || failed) return;
            viewerGrant(token, publishers, seen, room);
            child.stdin.write(JSON.stringify({ type: "grant", index: message.index, token }) + "\n");
          }).catch(() => { if (!closing && !failed) { fail("rtp-grant-provider-failed"); child.kill("SIGTERM"); } });
        } else if (message.type === "connected") {
          keys(message, "type,indices"); check(!joined && (!webinar || requested.size === WEBINAR_VIEWERS && seen.size === WEBINAR_VIEWERS) && Array.isArray(message.indices) && message.indices.length === indices.length && message.indices.every((value, index) => value === indices[index]), "rtp-protocol-connected"); joined = true; resolveConnected();
        } else if (message.type === "snapshot") {
          validateSnapshot(message, indices, config.publishers.length); const wait = pending.get(message.id); check(wait, "rtp-protocol-response-id"); pending.delete(message.id); wait.resolve(message);
        } else if (message.type === "finished") {
          keys(message, "type,peersClosed"); check(closing && message.peersClosed === true, "rtp-protocol-cleanup"); finished = true;
        } else if (message.type === "fault") fail(validateFault(message));
        else throw new Error("rtp-protocol-type");
      } catch { fail("rtp-protocol-invalid"); child.kill("SIGTERM"); }
    }
    if (Buffer.byteLength(buffered) > outputLimit(indices.length)) { fail("rtp-output-too-large"); child.kill("SIGTERM"); }
  });
  child.stdin.write(input + "\n");
  return {
    pid: child.pid,
    connected: timeout(connected, webinar ? 183_000 : connectLimit(indices.length), "rtp-connect-timeout"),
    async snapshot() {
      check(!closing && !failed, "rtp-process-unavailable");
      const id = ++sequence;
      const answer = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(JSON.stringify({ type: "snapshot", id }) + "\n");
      try { return await timeout(answer, 5000, "rtp-snapshot-timeout"); }
      finally { pending.delete(id); }
    },
    async close() {
      closing = true;
      rejectConnected(new Error("rtp-process-closed"));
      for (const wait of pending.values()) wait.reject(new Error("rtp-process-closed")); pending.clear();
      if (!child.stdin.destroyed) child.stdin.end(JSON.stringify({ type: "stop", id: ++sequence }) + "\n");
      let result;
      try { result = await timeout(exited, webinar ? 50_000 : 8000, "rtp-exit-timeout"); }
      catch { child.kill("SIGKILL"); await timeout(exited, 2000, "rtp-kill-timeout"); throw new Error("rtp-forced-exit"); }
      check(finished && result.code === 0 && result.signal === null, "rtp-cleanup-incomplete");
    },
  };
}

async function offlineCheck() {
  const fixture = peers => ({ peers: Array.from({ length: peers }, (_, index) => ({ index: FIRST_PEER + index, url: "ws://127.0.0.1:65535", token: "x".repeat(8192) })), publishers: Array.from({ length: 9 }, (_, index) => `publisher-${index}`) });
  assert.equal(connectLimit(82), 78000); assert.equal(connectLimit(982), 93000);
  assert.equal(validateFault({ type: "fault", failure: "receiver-read-deadline" }), "receiver-read-deadline");
  for (const failure of ["unknown", "receiver-read-deadline;secret", 123]) {
    assert.throws(() => validateFault({ type: "fault", failure }), /rtp-protocol-fault/);
  }
  for (const peers of [1, 983]) assert.throws(() => inputIndices(fixture(peers)), /rtp-input-peers/);
  const outOfOrder = fixture(82); outOfOrder.peers[81].index = 100; assert.throws(() => inputIndices(outOfOrder), /rtp-input-peer/);
  for (const peers of [2, 82, 982]) {
    const config = fixture(peers), indices = inputIndices(config);
    assert.ok(Buffer.byteLength(JSON.stringify(config)) <= MAX_CONFIG_BYTES);
    const faults = [], receiver = startReceiver(config, process.execPath, label => faults.push(label), true);
    try {
      await receiver.connected;
      const first = await receiver.snapshot(), second = await receiver.snapshot();
      assert.equal(second.id, first.id + 1); assert.equal(first.rows.length, peers);
      assert.ok(Buffer.byteLength(JSON.stringify(first)) < outputLimit(peers));
      if (peers === 982) assert.ok(Buffer.byteLength(JSON.stringify(first)) > 65536);
      for (const mutate of [x => { x.rows.pop(); }, x => { x.rows[0].index = 19; }, x => { x.rows[0].token = "private"; }, x => { x.rows[0].streams[0].bytes = -1; }, x => { x.rows[0].packetsReceived++; }, x => { x.rssBytes = Infinity; }, x => { x.rows[0].subscriber.srtpAuthenticated = false; }]) {
        const invalid = structuredClone(first); mutate(invalid); assert.throws(() => validateSnapshot(invalid, indices), /rtp-protocol/);
      }
    } finally { await receiver.close(); }
    assert.deepEqual(faults, []);
    assert.throws(() => process.kill(receiver.pid, 0), error => error.code === "ESRCH");
  }
  const webinar = {
    profile: "webinar",
    publishers: Array.from({ length: WEBINAR_STAGE }, (_, index) => `stage-${index}`),
    peers: Array.from({ length: WEBINAR_VIEWERS }, (_, index) => ({ index: FIRST_PEER + index, url: "ws://127.0.0.1:65535" })),
  };
  assert.ok(Buffer.byteLength(JSON.stringify(webinar)) <= MAX_CONFIG_BYTES);
  assert.equal(inputIndices(webinar).length, WEBINAR_VIEWERS);
  for (const mutate of [
    value => value.peers.pop(),
    value => value.publishers.pop(),
    value => { value.peers[0].token = "preissued-grant"; },
  ]) {
    const invalid = structuredClone(webinar); mutate(invalid);
    assert.throws(() => inputIndices(invalid), /rtp-(?:input|protocol-fields)/);
  }
  const grant = (index, hidden = true) => {
    const claims = { sub: `viewer-${index}`, exp: Math.floor(Date.now() / 1000) + 120,
      video: { room: "webinar", roomJoin: true, canSubscribe: true, canPublish: false, canPublishData: false, hidden } };
    return `e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  };
  const room = { value: "" }, seen = new Set(), publishers = new Set(webinar.publishers);
  viewerGrant(grant(18), publishers, seen, room);
  for (const invalid of [grant(18), grant(19, false), "not-a-jwt"]) assert.throws(() => viewerGrant(invalid, publishers, seen, room), /rtp-grant-invalid/);
  let grantCount = 0;
  const webinarFaults = [], webinarReceiver = startReceiver(webinar, process.execPath, label => webinarFaults.push(label), true, async index => { grantCount++; await new Promise(resolve => setTimeout(resolve, (20 - index % 20) % 20)); return grant(index); });
  try {
    await webinarReceiver.connected;
    const snapshot = await webinarReceiver.snapshot();
    assert.equal(snapshot.rows.length, WEBINAR_VIEWERS);
    assert.equal(snapshot.rows[0].streams.length, 20);
  } finally { await webinarReceiver.close(); }
  assert.equal(grantCount, WEBINAR_VIEWERS);
  assert.deepEqual(webinarFaults, []);
  let sawRequest;
  const requestSeen=new Promise(resolve=>{sawRequest=resolve;}), interruptedFaults=[];
  const interruptedReceiver=startReceiver(webinar,process.execPath,label=>interruptedFaults.push(label),true,async()=>{sawRequest();await new Promise(resolve=>setTimeout(resolve,20));throw Error("cancelled-provider");});
  const cancelledConnect=assert.rejects(interruptedReceiver.connected,/rtp-process-closed/);
  await requestSeen;await interruptedReceiver.close();await cancelledConnect;
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.deepEqual(interruptedFaults,[]);
  console.log("PASS meeting 2/82/982 and webinar 10-stage/1000-hidden-viewer receiver protocol; simulated children only, no Go/SDK/network");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--offline-check") await offlineCheck();
  else if (process.argv[2] === "--offline-child") {
    let indices, webinar = false, granted = 0, requested = 0;
    const answered = new Set();
    const request = () => { while (requested < indices.length && requested - granted < 20) console.log(JSON.stringify({ type: "grant-request", index: indices[requested++] })); };
    for await (const line of createInterface({ input: process.stdin })) {
      const message = JSON.parse(line);
      if (!indices) { indices = inputIndices(message); webinar = message.profile === "webinar"; if (webinar) request(); else console.log(JSON.stringify({ type: "connected", indices })); continue; }
      if (message.type === "grant" && webinar) { assert.ok(indices.slice(0,requested).includes(message.index) && !answered.has(message.index)); answered.add(message.index); assert.ok(message.token); granted++; if (granted === indices.length) console.log(JSON.stringify({ type: "connected", indices })); else request(); continue; }
      if (message.type === "stop") { console.log(JSON.stringify({ type: "finished", peersClosed: true })); break; }
      const subscriber = { dtlsConnected: true, remoteCertificatePresent: true, candidateType: "host", protocol: "udp", srtpAuthenticated: true, srtpEvidence: "pion-srtp-read", dtlsCipher: null, srtpCipher: null };
      const rows = indices.map(index => ({ index, streams: Array.from({ length: webinar ? 20 : 9 }, (_, slot) => ({ publisher: webinar ? Math.floor(slot / 2) : slot, ...(webinar ? { kind: slot % 2 ? "video" : "audio" } : {}), bytes: 1, packets: 1, frames: 1, unusablePacketGaps: 0 })), bytesReceived: webinar ? 20 : 9, packetsReceived: webinar ? 20 : 9, receivedFrames: webinar ? 20 : 9, packetsLost: 0, lossMetric: "unusable-packet-gaps", receivePayloadBytes: webinar ? 20 : 9, subscriber }));
      console.log(JSON.stringify({ type: "snapshot", id: message.id, rows, cpuMicros: 1, rssBytes: 1 }));
    }
  } else throw new Error("offline-check-argument-required");
}
