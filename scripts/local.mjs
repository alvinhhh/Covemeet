#!/usr/bin/env node
// Project-local HTTPS lifecycle. Never installs a CA, disables TLS checks, or deletes volumes.
import { randomBytes, X509Certificate } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import https from "node:https";
import { dirname, resolve } from "node:path";
import { checkServerIdentity } from "node:tls";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtime = resolve(root, "runtime/local-tls");
const envPath = resolve(runtime, ".env");
const statePath = resolve(runtime, "state.json");
const certificatePath = resolve(runtime, "trust/root.crt");
const command = process.argv[2] ?? "help";
const flags = new Set(process.argv.slice(3));
const allowedFlags = new Set([
  "--hosted",
  "--self-hosted",
  "--recording",
  "--no-recording",
  "--no-build",
]);
for (const flag of flags)
  if (!allowedFlags.has(flag)) throw new Error(`Unknown option: ${flag}`);
if (flags.has("--hosted") && flags.has("--self-hosted"))
  throw new Error("Select one local edition.");
if (flags.has("--recording") && flags.has("--no-recording"))
  throw new Error("Select one recording mode.");
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function run(
  program,
  args,
  { quiet = false, env = process.env, allowFailure = false } = {},
) {
  return await new Promise((done, reject) => {
    const child = spawn(program, args, {
      cwd: root,
      env,
      stdio: quiet
        ? ["ignore", "pipe", "pipe"]
        : ["ignore", "inherit", "inherit"],
    });
    const chunks = [];
    if (quiet) child.stdout.on("data", (chunk) => chunks.push(chunk));
    // Quiet failures are reported without command output: rendered configuration may contain secrets.
    if (quiet) child.stderr.on("data", () => {});
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0 && !allowFailure)
        reject(
          new Error(
            `${program} ${args[0] ?? ""} failed (exit ${code}); no secret output was retained.`,
          ),
        );
      else done({ code, text: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

async function setup() {
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await chmod(runtime, 0o700);
  await mkdir(resolve(runtime, "trust"), { recursive: true, mode: 0o755 });
  await chmod(resolve(runtime, "trust"), 0o755); // Public CA only; readable by non-root containers.
  const secret = () => randomBytes(32).toString("base64url");
  const generated = {
    POSTGRES_PASSWORD: secret(),
    REDIS_PASSWORD: secret(),
    SESSION_SECRET: secret(),
    CREATION_KEY: secret(),
    LIVEKIT_API_KEY: `CM${randomBytes(12).toString("hex")}`,
    LIVEKIT_API_SECRET: randomBytes(48).toString("base64url"),
    RECORDING_KEK: randomBytes(32).toString("base64"),
    HOSTED_ADMIN_KEY: secret(),
    HOSTED_SESSION_SECRET: secret(),
  };
  try {
    await writeFile(
      envPath,
      Object.entries(generated)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.log(
      "Created isolated local secrets; existing development configuration is unchanged.",
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  await chmod(envPath, 0o600);
  const env = parseEnv(await readFile(envPath, "utf8"));
  for (const key of Object.keys(generated)) {
    if (!env[key] || !/^[A-Za-z0-9_+/=-]+$/.test(env[key]))
      throw new Error(`Invalid ${key} in local configuration.`);
  }
  for (const key of [
    "SESSION_SECRET",
    "CREATION_KEY",
    "LIVEKIT_API_SECRET",
    "HOSTED_ADMIN_KEY",
    "HOSTED_SESSION_SECRET",
  ]) {
    if (env[key].length < 32)
      throw new Error(`${key} must contain at least 32 random characters.`);
  }
  if (Buffer.from(env.RECORDING_KEK, "base64").length !== 32)
    throw new Error("Local recording key must contain 32 bytes.");
  if (env.SESSION_SECRET === env.HOSTED_SESSION_SECRET)
    throw new Error("Portal and core session secrets must differ.");
  const publicValues = {
    SITE_ORIGIN: "https://meet.localhost:8443",
    PORTAL_ORIGIN: "https://portal.localhost:8443",
    LIVEKIT_URL: "http://livekit:7880",
  };
  const missing = [];
  for (const [key, value] of Object.entries(publicValues)) {
    if (env[key] && env[key] !== value)
      throw new Error(
        `${key} does not match the fixed local TLS installation.`,
      );
    if (!env[key]) missing.push(`${key}=${value}`);
    env[key] = value;
  }
  if (missing.length)
    await writeFile(
      envPath,
      (await readFile(envPath, "utf8")).trimEnd() +
        "\n" +
        missing.join("\n") +
        "\n",
      { mode: 0o600 },
    );
  const yaml = `# Generated project-local configuration. Do not commit.\nport: 7880\nbind_addresses: [0.0.0.0]\nrtc:\n  tcp_port: 17881\n  udp_port: 17882\n  node_ip: 127.0.0.1\n  use_external_ip: false\n  advertise_internal_ip: true\n  enable_loopback_candidate: true\nredis:\n  address: redis:6379\n  password: ${JSON.stringify(env.REDIS_PASSWORD)}\nkeys:\n  ${JSON.stringify(env.LIVEKIT_API_KEY)}: ${JSON.stringify(env.LIVEKIT_API_SECRET)}\nlogging:\n  level: warn\n`;
  await writeFile(resolve(runtime, "livekit.yaml"), yaml, { mode: 0o600 });
  await chmod(resolve(runtime, "livekit.yaml"), 0o600);
  return env;
}

async function projectContainers(service) {
  const filters = [
    "ps",
    "--filter",
    "label=com.docker.compose.project=covemeet-local-tls",
  ];
  if (service)
    filters.push("--filter", `label=com.docker.compose.service=${service}`);
  const result = await run("docker", [...filters, "--format", "{{.ID}}"], {
    quiet: true,
  });
  return result.text.trim().split(/\s+/).filter(Boolean);
}

async function stopContainers(ids) {
  if (ids.length) await run("docker", ["stop", "--timeout", "30", ...ids]);
}

async function configuration() {
  let state = { hosted: false, recording: false };
  try {
    state = JSON.parse(await readFile(statePath, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (["start", "setup"].includes(command)) {
    state.hosted =
      flags.has("--hosted") || (!flags.has("--self-hosted") && state.hosted);
    state.recording =
      flags.has("--recording") ||
      (!flags.has("--no-recording") && state.recording);
  }
  const secrets = await setup();
  const hostedSource = resolve(
    process.env.HOSTED_SOURCE_DIR ?? resolve(root, "../MeetingPlatformHosted"),
  );
  if (state.hosted && ["start", "setup"].includes(command))
    await readFile(resolve(hostedSource, "Dockerfile"), "utf8");
  const env = {
    ...process.env,
    ...secrets,
    HOSTED_SOURCE_DIR: hostedSource,
    LOCAL_EDITION: state.hosted ? "hosted" : "self-hosted",
    LOCAL_RECORDING_ENABLED: state.recording ? "true" : "false",
    CADDY_TRUSTED_IP: state.caddyIp ?? "",
  };
  const args = [
    "compose",
    "--project-name",
    "covemeet-local-tls",
    "--env-file",
    envPath,
    "-f",
    "infra/compose.local-tls.yaml",
  ];
  if (state.hosted) args.push("-f", "infra/compose.local-hosted.yaml");
  if (state.recording) args.push("--profile", "recording");
  const compose = (extra, options = {}) =>
    run("docker", [...args, ...extra], { env, ...options });
  return { state, env, compose };
}

async function certificate() {
  const pem = await readFile(certificatePath);
  const cert = new X509Certificate(pem);
  if (!cert.ca)
    throw new Error("Exported local trust certificate is not a CA.");
  console.log(`Local CA: ${cert.subject.replaceAll("\n", ", ")}`);
  console.log(`SHA-256: ${cert.fingerprint256}`);
  console.log(`Certificate: ${certificatePath}`);
  console.log("This command does not change system or browser trust settings.");
  return pem;
}

async function request(
  ca,
  hostname,
  path,
  { method = "GET", headers = {} } = {},
) {
  return await new Promise((done, reject) => {
    const req = https.request(
      {
        hostname: "127.0.0.1",
        port: 8443,
        servername: hostname,
        method,
        path,
        ca,
        rejectUnauthorized: true,
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        checkServerIdentity: (_host, cert) =>
          checkServerIdentity(hostname, cert),
        headers: { host: `${hostname}:8443`, ...headers },
        timeout: 5000,
      },
      (response) => {
        const chunks = [];
        let bytes = 0;
        response.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes > 1024 * 1024)
            req.destroy(new Error("Health response exceeded limit."));
          else chunks.push(chunk);
        });
        response.on("end", () =>
          done({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            protocol: response.socket?.getProtocol?.(),
          }),
        );
      },
    );
    req.on("upgrade", (_response, socket) => {
      socket.destroy();
      reject(new Error("Unauthenticated signaling upgrade was accepted."));
    });
    req.on("timeout", () =>
      req.destroy(new Error("Local HTTPS health request timed out.")),
    );
    req.on("error", reject);
    req.end();
  });
}

async function health(config) {
  const ca = await readFile(certificatePath);
  const meeting = await request(ca, "meet.localhost", "/api/health");
  const portal = await request(
    ca,
    "portal.localhost",
    config.state.hosted ? "/health" : "/api/health",
  );
  if (meeting.status !== 200 || portal.status !== 200)
    throw new Error("Portal or meeting HTTPS endpoint is unhealthy.");
  const settings = await request(ca, "meet.localhost", "/api/config");
  const parsed = JSON.parse(settings.body);
  if (
    parsed.meetingOrigin !== "https://meet.localhost:8443" ||
    parsed.portalOrigin !== "https://portal.localhost:8443"
  )
    throw new Error("Unexpected public origins in API configuration.");
  const signaling = await request(ca, "meet.localhost", "/rtc", {
    headers: {
      origin: "https://meet.localhost:8443",
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": randomBytes(16).toString("base64"),
    },
  });
  if (![401, 403].includes(signaling.status))
    throw new Error(
      `Expected unauthenticated signaling rejection, got ${signaling.status}.`,
    );
  const management = await request(
    ca,
    "meet.localhost",
    "/twirp/livekit.RoomService/ListRooms",
    { method: "POST" },
  );
  if (management.status === 200)
    throw new Error("Raw media management route unexpectedly succeeded.");
  const ids = await projectContainers();
  if (!ids.length) throw new Error("No local containers are running.");
  const containers = JSON.parse(
    (await run("docker", ["inspect", ...ids], { quiet: true })).text,
  );
  const allowed = {
    edge: ["8443/tcp"],
    livekit: ["17881/tcp", "17882/udp"],
    mailpit: ["8025/tcp"],
  };
  for (const container of containers) {
    const service = container.Config.Labels["com.docker.compose.service"];
    for (const [port, mappings] of Object.entries(
      container.HostConfig.PortBindings ?? {},
    )) {
      for (const mapping of mappings ?? []) {
        if (!allowed[service]?.includes(port) || mapping.HostIp !== "127.0.0.1")
          throw new Error(`Unexpected published port on local ${service}.`);
      }
    }
  }
  await writeFile(
    resolve(runtime, "health.json"),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        scope: "local HTTPS and published-port checks only",
        portalOrigin: "https://portal.localhost:8443",
        meetingOrigin: "https://meet.localhost:8443",
        caSha256: new X509Certificate(ca).fingerprint256,
        checks: {
          caAndHostnameValidation: true,
          tls13: true,
          anonymousGatewayRejected: true,
          rawSignalNotPublished: true,
          onlyLoopbackPortsPublished: true,
        },
        containers: containers.map((container) => ({
          service: container.Config.Labels["com.docker.compose.service"],
          image: container.Image,
        })),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(
    "PASS: both HTTPS origins validate against the project CA using TLS 1.3.",
  );
  console.log(
    "PASS: anonymous signaling is rejected; raw SFU/API/database ports have no host publication.",
  );
  console.log("PASS: every published local port is bound to 127.0.0.1.");
  console.log(
    "Media transport, moderation, recording, browser trust and capacity require their separate validation gates.",
  );
}

async function main() {
  if (command === "help") {
    console.log(
      "node scripts/local.mjs setup|start|health|status|stop|certificate [--hosted|--self-hosted] [--recording|--no-recording] [--no-build]",
    );
    console.log(
      "Start preserves the selected edition and recording mode unless changed explicitly. Stop preserves data and certificates. No command installs certificate trust.",
    );
    return;
  }
  if (
    !["setup", "start", "health", "status", "stop", "certificate"].includes(
      command,
    )
  )
    throw new Error("Unknown local lifecycle command.");
  if (command === "certificate") {
    await certificate();
    return;
  }
  if (command === "stop") {
    // Include optional/orphaned project services even after an edition switch or source removal.
    await stopContainers(await projectContainers());
    console.log(
      "Stopped this local installation. Its database, encrypted recordings and CA are preserved.",
    );
    return;
  }
  const config = await configuration();
  await config.compose(["config", "--quiet"], { quiet: true });
  if (command === "setup") {
    await writeFile(statePath, JSON.stringify(config.state, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(
      "Local Compose configuration is valid. No containers were started.",
    );
    return;
  }
  if (command === "status") {
    await config.compose(["ps"]);
    return;
  }
  if (command === "health") {
    await health(config);
    return;
  }
  if (!flags.has("--no-build")) await config.compose(["build"]);
  if (!config.state.hosted)
    await stopContainers(await projectContainers("portal"));
  await config.compose(["up", "-d", "--no-deps", "edge"]);
  let copied = false;
  const pendingCertificate = `${certificatePath}.pending`;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = await config.compose(
      [
        "cp",
        "edge:/data/caddy/pki/authorities/local/root.crt",
        pendingCertificate,
      ],
      { quiet: true, allowFailure: true },
    );
    if (result.code === 0) {
      copied = true;
      break;
    }
    await sleep(1000);
  }
  if (!copied)
    throw new Error(
      "Local CA was not generated. Inspect the Caddy configuration; no trust setting was changed.",
    );
  await chmod(pendingCertificate, 0o644);
  await rename(pendingCertificate, certificatePath);
  const edgeId = (
    await config.compose(["ps", "-q", "edge"], { quiet: true })
  ).text.trim();
  const edge = JSON.parse(
    (await run("docker", ["inspect", edgeId], { quiet: true })).text,
  )[0];
  const caddyIp =
    edge.NetworkSettings.Networks["covemeet-local-tls"]?.IPAddress;
  if (!caddyIp) throw new Error("Caddy network identity is unavailable.");
  config.env.CADDY_TRUSTED_IP = caddyIp;
  config.state.caddyIp = caddyIp;
  await writeFile(statePath, JSON.stringify(config.state, null, 2) + "\n", {
    mode: 0o600,
  });
  if (!config.state.recording)
    await config.compose([
      "--profile",
      "recording",
      "stop",
      "--timeout",
      "30",
      "egress",
    ]);
  await config.compose(["up", "-d", "--wait", "--wait-timeout", "120"]);
  await health(config);
  await certificate();
  console.log("Portal: https://portal.localhost:8443");
  console.log("Meeting: https://meet.localhost:8443");
  console.log("Test email: http://127.0.0.1:18025 (local test capture only)");
  console.log(
    "For trusted browser access, follow docs/local-https.md. Do not bypass certificate warnings.",
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
