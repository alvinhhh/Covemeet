import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rm, access } from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This runner never builds/restarts the user's local installation.
if (!process.argv.includes("--execute-reviewed-fixture")) {
  console.log(
    "Prepared only. Set MEDIA_GENERATION_IMAGE to a reviewed core image digest and pass --execute-reviewed-fixture.",
  );
  process.exit(0);
}
const image = process.env.MEDIA_GENERATION_IMAGE;
if (!/^sha256:[a-f0-9]{64}$/.test(image || ""))
  throw new Error("An explicit reviewed core image digest is required");
process.umask(0o077);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "runtime/media-generation-test");
const resultDir = path.join(root, "test-results/media-generation");
const journalFile = path.join(runtime, "owner.json");
const run = promisify(execFile);
const found = await run(
  "docker",
  ["image", "inspect", "--format", "{{.Id}}", image],
  { timeout: 10000, maxBuffer: 4096 },
);
if (found.stdout.trim() !== image)
  throw new Error("Reviewed image is unavailable");
await access(path.join(root, "apps/phone/dist/gateway.js"));
await mkdir(runtime, { recursive: true, mode: 0o700 });
try {
  await access(journalFile);
  throw new Error(
    "An unfinished fixture owns runtime/media-generation-test/owner.json; recover its exact project first",
  );
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const lock = path.join(runtime, "running");
await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
const project = `covemeet-media-generation-test-${randomBytes(6).toString("hex")}`;
const envFile = path.join(runtime, "fixture.env");
const configFile = path.join(runtime, "livekit.yaml");
const composeArgs = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  envFile,
  "-f",
  path.join(root, "infra/compose.media-generation-test.yaml"),
];
const ownership = {
  project,
  image,
  createdAt: new Date().toISOString(),
  pid: process.pid,
};
let prepared = false,
  journalCreated = false,
  failure;
async function compose(args, timeout = 240000) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", [...composeArgs, ...args], {
      cwd: root,
      stdio: "inherit",
    });
    const timer = setTimeout(() => child.kill("SIGTERM"), timeout);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}
async function projectGone() {
  const results = await Promise.all([
    run(
      "docker",
      [
        "ps",
        "-a",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--format",
        "{{.ID}}",
      ],
      { timeout: 10000, maxBuffer: 65536 },
    ),
    run(
      "docker",
      [
        "network",
        "ls",
        "--filter",
        `label=com.docker.compose.project=${project}`,
        "--format",
        "{{.ID}}",
      ],
      { timeout: 10000, maxBuffer: 65536 },
    ),
  ]);
  return results.every((result) => result.stdout.trim() === "");
}
try {
  await writeFile(journalFile, JSON.stringify(ownership, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  journalCreated = true;
  await mkdir(resultDir, { recursive: true });
  const key = randomBytes(12).toString("hex"),
    secret = randomBytes(32).toString("hex");
  await writeFile(
    envFile,
    [
      `MEDIA_GENERATION_IMAGE=${image}`,
      `MEDIA_TEST_DB_PASSWORD=${randomBytes(24).toString("hex")}`,
      `MEDIA_TEST_LIVEKIT_KEY=${key}`,
      `MEDIA_TEST_LIVEKIT_SECRET=${secret}`,
      `MEDIA_TEST_UID=${process.getuid?.() ?? 1000}`,
      `MEDIA_TEST_GID=${process.getgid?.() ?? 1000}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(
    configFile,
    [
      "port: 7880",
      "bind_addresses: [0.0.0.0]",
      "rtc:",
      "  tcp_port: 7881",
      "  udp_port: 7882",
      "  use_external_ip: false",
      "keys:",
      `  ${key}: ${secret}`,
      "logging:",
      "  level: error",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  prepared = true;
  const status = await compose([
    "up",
    "--pull",
    "never",
    "--abort-on-container-exit",
    "--exit-code-from",
    "media-runner",
  ]);
  if (status !== 0)
    throw new Error(`Media generation fixture failed (${status})`);
  const report = JSON.parse(
    await readFile(path.join(resultDir, "media-generation.json"), "utf8"),
  );
  if (
    !report.passed ||
    !report.cleanup?.nativeSdkDisposed ||
    !report.cleanup?.allFixturesReleased
  )
    throw new Error("Media generation evidence did not confirm cleanup");
} catch (error) {
  failure = error;
} finally {
  let gone = !prepared;
  if (prepared) {
    try {
      await compose(["down", "--volumes", "--remove-orphans"], 60000);
    } catch {}
    try {
      gone = await projectGone();
    } catch {
      gone = false;
    }
  }
  if (gone) {
    // Only this invocation's exact project has been confirmed absent.
    await rm(envFile, { force: true });
    await rm(configFile, { force: true });
    if (journalCreated) await rm(journalFile, { force: true });
    await rm(lock, { force: true });
  } else {
    failure ??= new Error(
      "Fixture cleanup is incomplete; exact project and private recovery files remain in runtime/media-generation-test",
    );
    await writeFile(
      journalFile,
      JSON.stringify({ ...ownership, cleanupRequired: true }, null, 2) + "\n",
      { mode: 0o600 },
    );
  }
}
if (failure) throw failure;
console.log(
  `Media generation evidence: ${path.join(resultDir, "media-generation.json")}`,
);
