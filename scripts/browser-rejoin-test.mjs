import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access, chmod, mkdir, mkdtemp, rm, stat, writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Builds and pulls are intentionally separate from this disposable fixture.
process.umask(0o077);
const root = fileURLToPath(new URL("..", import.meta.url));
const run = promisify(execFile);
const dockerEnv = { ...process.env };
for (const name of Object.keys(dockerEnv))
  if (name.startsWith("BROWSER_REJOIN_")) delete dockerEnv[name];
const image = process.env.BROWSER_REJOIN_IMAGE;
const livekit = process.env.BROWSER_REJOIN_LIVEKIT_IMAGE;
const browser = process.env.BROWSER_EXECUTABLE;
assert.match(image || "", /^sha256:[a-f0-9]{64}$/);
assert.match(livekit || "", /^sha256:[a-f0-9]{64}$/);
assert.ok(
  browser && path.isAbsolute(browser),
  "BROWSER_EXECUTABLE must be an installed browser's absolute path",
);
await access(browser, constants.X_OK);
await access(
  path.join(
    root,
    "scripts/validation/node_modules/playwright-core/package.json",
  ),
);
async function docker(args, timeout = 10000) {
  return (
    await run("docker", args, {
      cwd: root,
      env: dockerEnv,
      timeout,
      maxBuffer: 1024 * 1024,
    })
  ).stdout.trim();
}
for (const id of [image, livekit])
  assert.equal(
    await docker(["image", "inspect", "--format", "{{.Id}}", id]),
    id,
  );
const postgres = await docker([
  "image",
  "inspect",
  "--format",
  "{{.Id}}",
  "postgres:17.11-alpine3.23",
]);
assert.match(postgres, /^sha256:[a-f0-9]{64}$/);
const requestedPort = Number(process.env.BROWSER_REJOIN_PORT || 0);
assert.ok(
  Number.isInteger(requestedPort) &&
    requestedPort >= 0 &&
    requestedPort <= 65535,
);
const probe = createServer();
await new Promise((resolve, reject) => {
  probe.once("error", reject);
  probe.listen(requestedPort, "127.0.0.1", resolve);
});
const port = probe.address().port;
await new Promise((resolve, reject) =>
  probe.close((error) => (error ? reject(error) : resolve())),
);
await mkdir(path.join(root, "runtime"), { recursive: true });
const directory = await mkdtemp(path.join(root, "runtime/browser-rejoin-"));
assert.equal(
  (await stat(directory)).mode & 0o777,
  0o700,
  "Fixture runtime directory must remain private",
);
const project = `covemeet-browser-rejoin-${randomBytes(6).toString("hex")}`;
const results = path.join(root, "test-results/browser-rejoin", project);
await mkdir(results, { recursive: true });
const secret = () => randomBytes(32).toString("hex");
const key = secret(),
  livekitKey = randomBytes(12).toString("hex"),
  livekitSecret = secret();
const envFile = path.join(directory, "fixture.env");
const keyFile = path.join(directory, "creation-key");
await writeFile(keyFile, key + "\n", { mode: 0o600 });
await writeFile(
  envFile,
  Object.entries({
    BROWSER_REJOIN_IMAGE: image,
    BROWSER_REJOIN_LIVEKIT_IMAGE: livekit,
    BROWSER_REJOIN_POSTGRES_IMAGE: postgres,
    BROWSER_REJOIN_DIRECTORY: directory,
    BROWSER_REJOIN_PORT: port,
    BROWSER_REJOIN_DB_PASSWORD: secret(),
    BROWSER_REJOIN_SESSION_SECRET: secret(),
    BROWSER_REJOIN_CREATION_KEY: key,
    BROWSER_REJOIN_LIVEKIT_KEY: livekitKey,
    BROWSER_REJOIN_LIVEKIT_SECRET: livekitSecret,
  })
    .map(([name, value]) => `${name}=${value}`)
    .join("\n") + "\n",
  { mode: 0o600 },
);
await writeFile(
  path.join(directory, "livekit.yaml"),
  [
    "port: 7880",
    "bind_addresses: [0.0.0.0]",
    "rtc:",
    "  tcp_port: 7881",
    "  udp_port: 7882",
    "  use_external_ip: false",
    "keys:",
    `  ${livekitKey}: ${livekitSecret}`,
    "logging:",
    "  level: error",
    "",
  ].join("\n"),
  { mode: 0o600 },
);
// Only this file is mounted; the private parent prevents other host users reading it.
// Container root has no DAC override capability and may not own the Linux bind file.
await chmod(path.join(directory, "livekit.yaml"), 0o444);
const owner = {
  project,
  image,
  livekit,
  postgres,
  port,
  createdAt: new Date().toISOString(),
};
await writeFile(
  path.join(directory, "owner.json"),
  JSON.stringify(owner, null, 2) + "\n",
  { mode: 0o600 },
);
const compose = [
  "compose",
  "--project-name",
  project,
  "--env-file",
  envFile,
  "-f",
  path.join(root, "infra/compose.browser-rejoin-test.yaml"),
];
let passed = false,
  gone = false,
  attempted = false,
  startupComplete = false,
  failure;
try {
  assert.equal(
    await docker([
      "ps",
      "-aq",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ]),
    "",
  );
  assert.equal(
    await docker([
      "network",
      "ls",
      "-q",
      "--filter",
      `label=com.docker.compose.project=${project}`,
    ]),
    "",
  );
  attempted = true;
  await docker(
    [
      ...compose,
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "90",
      "--no-build",
      "--pull",
      "never",
    ],
    100000,
  );
  const core = await docker([...compose, "ps", "-q", "core"]);
  const bindings = JSON.parse(
    await docker([
      "inspect",
      "--format",
      "{{json .NetworkSettings.Ports}}",
      core,
    ]),
  );
  assert.deepEqual(bindings["4100/tcp"], [
    { HostIp: "127.0.0.1", HostPort: String(port) },
  ]);
  const base = `http://127.0.0.1:${port}`;
  const config = await fetch(`${base}/api/config`, {
    signal: AbortSignal.timeout(5000),
    redirect: "error",
  }).then((r) => r.json());
  assert.equal(config.meetingOrigin, base);
  startupComplete = true;
  let output;
  try {
    output = await run(
      process.execPath,
      ["--test", "scripts/validation/browser-rejoin.test.mjs"],
      {
        cwd: root,
        timeout: 115000,
        maxBuffer: 1024 * 1024,
        env: {
          ...process.env,
          BASE_URL: base,
          BROWSER_EXECUTABLE: browser,
          BROWSER_REJOIN_CREATION_KEY_FILE: keyFile,
        },
      },
    );
  } catch (error) {
    output = error;
    throw new Error("Browser regression failed; see its sanitized test log");
  } finally {
    if (output)
      await writeFile(
        path.join(results, "test.log"),
        (output.stdout || "") + (output.stderr || ""),
        { mode: 0o600 },
      );
  }
  passed = true;
} catch (error) {
  failure = error;
} finally {
  if (attempted) {
    if (!startupComplete) {
      let diagnostic = {};
      const redact = (text) => text
        .replaceAll(livekitKey, "[redacted key]")
        .replaceAll(livekitSecret, "[redacted secret]");
      try {
        const id = await docker([...compose, "ps", "--all", "-q", "livekit"]);
        assert.match(id, /^[a-f0-9]{64}$/);
        const state = JSON.parse(await docker([
          "inspect", "--format",
          '{"status":{{json .State.Status}},"exitCode":{{json .State.ExitCode}},"oomKilled":{{json .State.OOMKilled}},"error":{{json .State.Error}}}',
          id,
        ]));
        diagnostic = { ...state, error: redact(state.error).slice(0, 2000) };
        const logs = await run("docker", ["logs", "--timestamps", "--tail", "100", id], {
          cwd: root,
          env: dockerEnv,
          timeout: 5000,
          maxBuffer: 65536,
        });
        diagnostic.log = redact(logs.stdout + logs.stderr).slice(0, 16000);
      } catch {
        diagnostic.collectionError = "LiveKit startup diagnostics unavailable";
      }
      try {
        await writeFile(
          path.join(results, "livekit-startup.json"),
          JSON.stringify(diagnostic, null, 2) + "\n",
          { mode: 0o600 },
        );
      } catch {
        // Evidence storage failure must not prevent owned-resource cleanup.
      }
    }
    try {
      await docker(
        [...compose, "down", "--volumes", "--remove-orphans"],
        60000,
      );
    } catch {
      /* Verify exact ownership below. */
    }
    try {
      gone =
        (await docker([
          "ps",
          "-aq",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ])) === "" &&
        (await docker([
          "network",
          "ls",
          "-q",
          "--filter",
          `label=com.docker.compose.project=${project}`,
        ])) === "";
    } catch {
      gone = false;
    }
  } else gone = true;
  await writeFile(
    path.join(results, "result.json"),
    JSON.stringify(
      {
        ...owner,
        projectStartAttempted: attempted,
        passed: passed && gone,
        cleanupConfirmed: gone,
      },
      null,
      2,
    ) + "\n",
  );
  if (gone) await rm(directory, { recursive: true });
  else
    failure = new Error(
      `Fixture cleanup is unconfirmed; recover only the project in ${path.join(directory, "owner.json")}`,
    );
}
console.log(`Browser regression evidence: ${results}`);
if (failure) throw failure;
