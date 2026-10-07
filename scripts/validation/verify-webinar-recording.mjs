import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

// Decode every frame, without rendering or playing audio. The color thresholds
// identify the two fixture publishers after video compression and grid scaling.
const width = 160, height = 90, frameBytes = width * height * 3;
function scanFrames() {
  let pending = Buffer.alloc(0), frames = 0, stageFrames = 0, privateFrames = 0;
  return {
    push(chunk) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        let stage = 0, backstage = 0;
        for (let i = 0; i < frame.length; i += 3) {
          if (frame[i + 2] > 150 && frame[i] < 100 && frame[i + 1] < 120) stage++;
          if (frame[i] > 150 && frame[i + 1] < 100 && frame[i + 2] < 100) backstage++;
        }
        frames++;
        if (stage >= width * height * 0.05) stageFrames++;
        if (backstage >= width * height * 0.005) privateFrames++;
      }
    },
    finish(minimumFrames = 480) {
      assert.equal(pending.length, 0, "Partial decoded frame");
      assert(frames >= minimumFrames, "Recording was too short");
      assert(stageFrames >= frames * 0.8, "Stage marker missing from recorded content");
      assert.equal(privateFrames, 0, "Backstage marker leaked into recorded content");
      return { frames, stageFrames, privateFrames, scannedEveryFrame: true,
        scaledWidth: width, scaledHeight: height,
        stagePixelThreshold: 0.05, backstagePixelThreshold: 0.005 };
    },
  };
}
if (process.argv.includes("--self-check")) {
  const frame = (rgb) => Buffer.from(Array.from({ length: width * height }, () => rgb).flat());
  const stage = frame([32, 64, 224]), backstage = frame([224, 32, 32]), blank = frame([0, 0, 0]);
  const pass = scanFrames();
  pass.push(stage.subarray(0, 17)); pass.push(stage.subarray(17));
  assert.equal(pass.finish(1).stageFrames, 1);
  for (const bad of [backstage, blank]) {
    const scan = scanFrames(); scan.push(bad); assert.throws(() => scan.finish(1));
  }
  const leak = scanFrames(); leak.push(stage); leak.push(backstage);
  assert.throws(() => leak.finish(1), /Backstage marker|Stage marker/);
  const partial = scanFrames(); partial.push(stage.subarray(1));
  assert.throws(() => partial.finish(1), /Partial decoded frame/);
  console.log("Webinar recording frame checks passed");
  process.exit(0);
}
assert.equal(process.argv.length, 3, "Usage: node verify-webinar-recording.mjs /absolute/report.json");
assert(path.isAbsolute(process.argv[2]), "Absolute report path required");
process.umask(0o077);
const reportPath = process.argv[2], directory = path.dirname(reportPath);
const privateFile = (info) => {
  assert(info.isFile() && info.uid === process.getuid() && (info.mode & 0o077) === 0,
    "Private owned file required");
};
const directoryInfo = await lstat(directory);
assert(directoryInfo.isDirectory() && directoryInfo.uid === process.getuid() &&
  (directoryInfo.mode & 0o077) === 0, "Private owned evidence directory required");
privateFile(await lstat(reportPath));
const report = JSON.parse(await readFile(reportPath, "utf8"));
assert(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(report.runId));
const artifact = report.webinarRecording?.artifact;
assert(artifact?.name === `webinar-${report.runId}.mp4`, "Artifact/run binding mismatch");
assert(/^[a-f0-9]{64}$/.test(artifact.sha256) && Number.isSafeInteger(artifact.bytes) &&
  artifact.bytes > 1024 && artifact.bytes <= 64 * 1024 * 1024, "Invalid recording receipt");
const videoPath = path.join(directory, artifact.name);
let input, inputIdentity, child, interrupted = false, failure;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => { interrupted = true; child?.kill("SIGKILL"); });
try {
  input = await open(videoPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const info = await input.stat(); privateFile(info);
  inputIdentity = { dev: info.dev, ino: info.ino };
  assert.equal(info.size, artifact.bytes, "Recording size changed");
  const hash = createHash("sha256");
  for await (const chunk of input.createReadStream({ autoClose: false, start: 0 })) hash.update(chunk);
  assert.equal(hash.digest("hex"), artifact.sha256, "Recording hash changed");
  assert.equal(report.result, "capture-ready", "Capture or cleanup did not complete");
  assert(!report.failure && !report.recordingCleanupFailure);
  assert(["meetingEnded", "sfuRoomsRemoved", "relayClosed"].every((key) => report.cleanup?.[key] === true));
  assert(report.webinarRecording.cleanup.exactEgressTerminal &&
    report.webinarRecording.cleanup.linkRevoked);
  assert(!interrupted, "Recording verification interrupted");
  // Open the already-verified descriptor again through /dev/fd; no URL or shell input.
  const scan = scanFrames();
  child = spawn("ffmpeg", ["-v", "error", "-nostdin", "-threads", "1",
    "-filter_threads", "1", "-protocol_whitelist", "file,pipe", "-i", "/dev/fd/3",
    "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", "scale=160:90",
    "-fps_mode", "passthrough", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1"],
    { stdio: ["ignore", "pipe", "ignore", input.fd] });
  const finished = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve() : reject(new Error("Recording decoder failed")));
  });
  // Attach rejection handling before reading stdout so a spawn failure cannot become unhandled.
  void finished.catch(() => {});
  const timer = setTimeout(() => child.kill("SIGKILL"), 90_000);
  try {
    let decodedBytes = 0;
    for await (const chunk of child.stdout) {
      decodedBytes += chunk.length;
      assert(decodedBytes <= frameBytes * 24 * 120, "Unexpected recording duration");
      scan.push(chunk);
    }
    await finished;
    assert(!interrupted, "Recording verification interrupted");
    report.webinarRecording.content = scan.finish();
    report.webinarRecording.contentVerification = "passed";
  } finally { clearTimeout(timer); child.kill("SIGKILL"); await finished.catch(() => {}); }
} catch (error) {
  failure = String(error.message || error);
  report.failure ??= { stage: "webinar recording content", message: failure };
  report.result = "failed";
  report.webinarRecording.contentVerification = "failed";
} finally {
  await input?.close().catch(() => {});
  try {
    // Reject replacement files instead of deleting an unrelated path.
    const current = await lstat(videoPath); privateFile(current);
    assert(inputIdentity && current.dev === inputIdentity.dev && current.ino === inputIdentity.ino,
      "Recording file ownership changed");
    await unlink(videoPath);
    report.webinarRecording.plaintextRemoved = true;
  } catch (error) {
    failure ??= "Recording plaintext cleanup failed";
    report.failure ??= { stage: "webinar recording plaintext cleanup", message: failure };
    report.result = "failed";
    report.webinarRecording.plaintextRemoved = false;
  }
  if (!failure) report.result = "passed";
  report.recordingVerifiedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
if (failure) { console.error(failure); process.exitCode = 1; }
else console.log(`Recording passed: ${report.webinarRecording.content.frames} decoded frames; no backstage marker; plaintext removed`);
