import { randomBytes } from "node:crypto";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "runtime/phone-test");
const resultDir = path.join(root, "test-results/phone");
await mkdir(runtime, { recursive: true, mode: 0o700 });
// Exclusive lock prevents two runs from deleting each other's fixture.
const lock = path.join(runtime, "running");
await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
const composeArgs = [
  "compose",
  "--project-name",
  "covemeet-phone-test",
  "--env-file",
  path.join(runtime, "fixture.env"),
  "-f",
  path.join(root, "infra/compose.phone-test.yaml"),
];
async function compose(args, allowFailure = false) {
  const code = await new Promise((resolve, reject) => {
    const child = spawn("docker", [...composeArgs, ...args], {
      cwd: root,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  if (code !== 0 && !allowFailure)
    throw new Error(`Phone fixture command failed (${code})`);
  return code;
}
let prepared = false;
try {
  await mkdir(resultDir, { recursive: true });
  const key = randomBytes(12).toString("hex"),
    secret = randomBytes(32).toString("hex");
  await writeFile(
    path.join(runtime, "fixture.env"),
    [
      `PHONE_TEST_DB_PASSWORD=${randomBytes(24).toString("hex")}`,
      `PHONE_TEST_LIVEKIT_KEY=${key}`,
      `PHONE_TEST_LIVEKIT_SECRET=${secret}`,
      `PHONE_TEST_UID=${process.getuid?.() ?? 1000}`,
      `PHONE_TEST_GID=${process.getgid?.() ?? 1000}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(
    path.join(runtime, "livekit.yaml"),
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
  await compose(["build", "phone-livekit", "phone-runner"]);
  await compose([
    "up",
    "--abort-on-container-exit",
    "--exit-code-from",
    "phone-runner",
  ]);
  console.log(
    `Phone validation report: ${path.join(resultDir, "phone-media.json")}`,
  );
} finally {
  // This fixed, dedicated project contains synthetic records only, with no host ports.
  if (prepared) await compose(["down", "--volumes", "--remove-orphans"], true);
  await rm(path.join(runtime, "fixture.env"), { force: true });
  await rm(path.join(runtime, "livekit.yaml"), { force: true });
  await rm(lock, { force: true });
}
