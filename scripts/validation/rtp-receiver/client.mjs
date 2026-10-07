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

export function validateSnapshot(message) {
  keys(message, "type,id,rows,cpuMicros,rssBytes");
  check(message.type === "snapshot" && count(message.id) && message.id > 0 && count(message.cpuMicros) && count(message.rssBytes), "rtp-protocol-resources");
  check(Array.isArray(message.rows) && message.rows.length === 2, "rtp-protocol-peers");
  for (const [index, row] of message.rows.entries()) {
    keys(row, "index,streams,bytesReceived,packetsReceived,receivedFrames,packetsLost,lossMetric,receivePayloadBytes,subscriber");
    check(row.index === index + 18 && row.lossMetric === "unusable-packet-gaps", "rtp-protocol-identity");
    for (const key of ["bytesReceived", "packetsReceived", "receivedFrames", "packetsLost", "receivePayloadBytes"]) check(count(row[key]), "rtp-protocol-counter");
    check(row.receivePayloadBytes >= row.bytesReceived && Array.isArray(row.streams) && row.streams.length <= 9, "rtp-protocol-streams");
    let prior = -1;
    for (const stream of row.streams) {
      keys(stream, "publisher,bytes,packets,frames,unusablePacketGaps");
      check(Number.isInteger(stream.publisher) && stream.publisher > prior && stream.publisher < 9, "rtp-protocol-source"); prior = stream.publisher;
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

export function startReceiver(config, binary, fault, offline = false) {
  check(isAbsolute(binary), "rtp-binary-absolute-path");
  const args = offline ? [fileURLToPath(import.meta.url), "--offline-child"] : [];
  const child = spawn(binary, args, { env: { PATH: process.env.PATH }, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map(); let sequence = 0, closing = false, finished = false, failed = false, buffered = "";
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
    if (buffered.length > 65536) { fail("rtp-output-too-large"); child.kill("SIGTERM"); return; }
    while (buffered.includes("\n")) {
      const offset = buffered.indexOf("\n"), line = buffered.slice(0, offset); buffered = buffered.slice(offset + 1);
      try {
        const message = JSON.parse(line);
        if (message.type === "connected") {
          keys(message, "type,indices"); check(message.indices?.join() === "18,19", "rtp-protocol-connected"); resolveConnected();
        } else if (message.type === "snapshot") {
          validateSnapshot(message); const wait = pending.get(message.id); check(wait, "rtp-protocol-response-id"); pending.delete(message.id); wait.resolve(message);
        } else if (message.type === "finished") {
          keys(message, "type,peersClosed"); check(closing && message.peersClosed === true, "rtp-protocol-cleanup"); finished = true;
        } else if (message.type === "fault") fail("rtp-receiver-fault");
        else throw new Error("rtp-protocol-type");
      } catch { fail("rtp-protocol-invalid"); child.kill("SIGTERM"); }
    }
  });
  child.stdin.write(JSON.stringify(config) + "\n");
  return {
    pid: child.pid,
    connected: timeout(connected, 18000, "rtp-connect-timeout"),
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
      if (!child.stdin.destroyed) child.stdin.end(JSON.stringify({ type: "stop", id: ++sequence }) + "\n");
      let result;
      try { result = await timeout(exited, 8000, "rtp-exit-timeout"); }
      catch { child.kill("SIGKILL"); await timeout(exited, 2000, "rtp-kill-timeout"); throw new Error("rtp-forced-exit"); }
      check(finished && result.code === 0 && result.signal === null, "rtp-cleanup-incomplete");
    },
  };
}

async function offlineCheck() {
  const faults = [], receiver = startReceiver({}, process.execPath, label => faults.push(label), true);
  try {
    await receiver.connected;
    const first = await receiver.snapshot(), second = await receiver.snapshot();
    assert.equal(second.id, first.id + 1); assert.equal(first.rows.length, 2);
    for (const mutate of [x => { x.rows[0].index = 19; }, x => { x.rows[0].token = "private"; }, x => { x.rows[0].streams[0].bytes = -1; }, x => { x.rows[0].packetsReceived++; }, x => { x.rssBytes = Infinity; }, x => { x.rows[0].subscriber.srtpAuthenticated = false; }]) {
      const invalid = structuredClone(first); mutate(invalid); assert.throws(() => validateSnapshot(invalid), /rtp-protocol/);
    }
  } finally { await receiver.close(); }
  assert.deepEqual(faults, []);
  assert.throws(() => process.kill(receiver.pid, 0), error => error.code === "ESRCH");
  console.log("PASS receiver process protocol, strict counters/transport, secret-field rejection and graceful cleanup; simulated child only, no Go/SDK/network");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--offline-check") await offlineCheck();
  else if (process.argv[2] === "--offline-child") {
    let prepared = false;
    for await (const line of createInterface({ input: process.stdin })) {
      const message = JSON.parse(line);
      if (!prepared) { prepared = true; console.log(JSON.stringify({ type: "connected", indices: [18, 19] })); continue; }
      if (message.type === "stop") { console.log(JSON.stringify({ type: "finished", peersClosed: true })); break; }
      const subscriber = { dtlsConnected: true, remoteCertificatePresent: true, candidateType: "host", protocol: "udp", srtpAuthenticated: true, srtpEvidence: "pion-srtp-read", dtlsCipher: null, srtpCipher: null };
      const rows = [18, 19].map(index => ({ index, streams: Array.from({ length: 9 }, (_, publisher) => ({ publisher, bytes: 1, packets: 1, frames: 1, unusablePacketGaps: 0 })), bytesReceived: 9, packetsReceived: 9, receivedFrames: 9, packetsLost: 0, lossMetric: "unusable-packet-gaps", receivePayloadBytes: 9, subscriber }));
      console.log(JSON.stringify({ type: "snapshot", id: message.id, rows, cpuMicros: 1, rssBytes: 1 }));
    }
  } else throw new Error("offline-check-argument-required");
}
