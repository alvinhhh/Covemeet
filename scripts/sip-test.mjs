import { randomBytes } from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  copyFile,
  rm,
  chmod,
  access,
} from "node:fs/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.umask(0o077);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "runtime/sip-test");
const results = path.join(root, "test-results/sip");
const exec = promisify(execFile);
await access(path.join(root, "scripts/validation/sip-media.mjs"));
await mkdir(runtime, { recursive: true, mode: 0o700 });
const lock = path.join(runtime, "running");
await writeFile(lock, String(process.pid), { flag: "wx", mode: 0o600 });
const args = [
  "compose",
  "--project-name",
  "covemeet-sip-test",
  "--env-file",
  path.join(runtime, "fixture.env"),
  "-f",
  path.join(root, "infra/compose.sip-test.yaml"),
];
let activeChild,
  interrupted = false,
  prepared = false,
  cleanupSucceeded = false,
  diagnosticsCollected = false;
const interrupt = () => {
  if (interrupted) return;
  interrupted = true;
  activeChild?.kill("SIGINT");
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
async function command(
  commandArgs,
  { allowFailure = false, cleanup = false, timeout = 900000 } = {},
) {
  if (interrupted && !cleanup) throw new Error("SIP fixture interrupted");
  const code = await new Promise((resolve, reject) => {
    const child = spawn("docker", commandArgs, {
      cwd: root,
      stdio: "inherit",
      timeout,
    });
    activeChild = child;
    child.once("error", reject);
    child.once("exit", (code) => {
      if (activeChild === child) activeChild = undefined;
      resolve(code ?? 1);
    });
  });
  if (code !== 0 && !allowFailure)
    throw new Error("SIP fixture command failed");
  return code;
}
async function compose(commandArgs, options) {
  return command([...args, ...commandArgs], options);
}
async function waitForServices() {
  for (let attempt = 0; attempt < 90; attempt++) {
    let ready = true;
    for (const [service, health] of [
      ["sip-postgres", true],
      ["sip-redis", true],
      ["asterisk", true],
      ["livekit", false],
      ["sip", false],
    ]) {
      const state = (
        await quiet("docker", [
          "inspect",
          `covemeet-sip-test-${service}-1`,
          "--format",
          "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}",
        ])
      ).stdout.trim();
      if (state.startsWith("exited") || state.startsWith("dead"))
        throw new Error(`SIP fixture service failed before call: ${service}`);
      if (state !== (health ? "running healthy" : "running")) ready = false;
    }
    if (ready) return;
    if (interrupted) throw new Error("SIP fixture interrupted");
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("SIP fixture service readiness timed out");
}
async function quiet(command, commandArgs) {
  return exec(command, commandArgs, {
    cwd: root,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
}
// Parse private service output in memory into fixed labels. Never persist or emit raw
// SIP/SDP lines, identifiers, credentials, keys, or arbitrary exception messages.
const logLabels = {
  tlsVerificationFailure:
    /certificate[^\n]*(?:fail|invalid|unknown|mismatch)|(?:fail|error)[^\n]*certificate|x509:/i,
  tlsHandshakeFailure:
    /(?:tls|ssl)[^\n]*(?:handshake|connect)[^\n]*(?:fail|error)|TLS handshake error/i,
  authenticationFailure:
    /(?:authentication|authenticate|digest)[^\n]*(?:fail|error|reject|unsupported)|(?:unauthorized|forbidden)/i,
  outboundEndpointFailure:
    /(?:endpoint|aor|contact)[^\n]*(?:not found|unavailable|invalid|unable)|Unable to create PJSIP channel/i,
  transportFailure:
    /(?:transport)[^\n]*(?:fail|error|unable|not found|unsupported)/i,
  dnsFailure:
    /(?:resolve|resolution|lookup)[^\n]*(?:fail|error|no such host)|Name or service not known/i,
  connectionRefused: /connection refused|ECONNREFUSED/i,
  mediaEncryptionFailure:
    /(?:SRTP|crypto|encryption)[^\n]*(?:fail|error|required|unsupported|reject)/i,
  codecFailure:
    /(?:codec|format)[^\n]*(?:no joint|no compatible|unsupported|not supported)|no joint capabilities/i,
  noTrunkOrDispatch:
    /(?:trunk|dispatch|rule)[^\n]*(?:not found|no match|missing|reject)/i,
  inviteFailure:
    /(?:INVITE|call setup|call attempt)[^\n]*(?:fail|error|reject)|failed to accept call/i,
  deadline: /timeout|timed out|deadline exceeded/i,
  moduleLoadFailure:
    /(?:module)[^\n]*(?:load.*fail|not found|declined|could not|unable)/i,
};
async function diagnostics() {
  const summary = {
    capturedAt: new Date().toISOString(),
    rawLogsRetained: false,
    services: {},
  };
  for (const service of ["asterisk", "sip", "livekit"]) {
    const item = { collected: false, lineCount: 0, labels: {} };
    try {
      const output = await quiet("docker", [
        "logs",
        "--tail",
        "2000",
        `covemeet-sip-test-${service}-1`,
      ]);
      const lines = `${output.stdout}\n${output.stderr}`
        .split(/\r?\n/)
        .filter(Boolean);
      item.collected = true;
      item.lineCount = lines.length;
      for (const [label, pattern] of Object.entries(logLabels))
        item.labels[label] = lines.filter((line) => pattern.test(line)).length;
    } catch {
      /* Bounded collection failure is a flag, never a raw exception. */
    }
    summary.services[service] = item;
  }
  await writeFile(
    path.join(results, "infrastructure.json"),
    JSON.stringify(summary, null, 2) + "\n",
    { mode: 0o600 },
  );
  diagnosticsCollected = true;
  console.log(
    `SIP fixture infrastructure labels: ${JSON.stringify(summary.services)}`,
  );
}
async function verifySipTls() {
  // This checks the exact PBX→SIP service path and CA/hostname before dialing.
  // -no_ign_eof plus Docker's closed stdin ends after the verified handshake.
  try {
    await quiet("docker", [
      "exec",
      "covemeet-sip-test-asterisk-1",
      "openssl",
      "s_client",
      "-connect",
      "sip:5061",
      "-servername",
      "sip",
      "-CAfile",
      "/certs/ca.crt",
      "-verify_return_error",
      "-verify_hostname",
      "sip",
      "-brief",
      "-no_ign_eof",
    ]);
    console.log("SIP fixture PBX-to-SIP CA and hostname verification passed");
  } catch {
    throw new Error("SIP fixture PBX-to-SIP verified TLS preflight failed");
  }
}
const ipNumber = (ip) =>
  ip.split(".").reduce((value, part) => (value * 256 + Number(part)) >>> 0, 0);
function interval(cidr) {
  const [ip, bits] = cidr.split("/");
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return;
  const size = 2 ** (32 - Number(bits));
  const start = Math.floor(ipNumber(ip) / size) * size;
  return [start, start + size - 1];
}
async function unusedSubnet() {
  const ids = (await quiet("docker", ["network", "ls", "-q"])).stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const ranges = [];
  for (const id of ids) {
    const config = JSON.parse(
      (
        await quiet("docker", [
          "network",
          "inspect",
          id,
          "--format",
          "{{json .IPAM.Config}}",
        ])
      ).stdout || "[]",
    );
    for (const item of config ?? []) {
      const range = item.Subnet && interval(item.Subnet);
      if (range) ranges.push(range);
    }
  }
  for (const second of [30, 29, 28])
    for (let third = 240; third < 255; third++) {
      const cidr = `172.${second}.${third}.0/24`,
        range = interval(cidr);
      if (ranges.every((r) => range[1] < r[0] || range[0] > r[1]))
        return { cidr, pbx: `172.${second}.${third}.10` };
    }
  throw new Error("No isolated fixture subnet available");
}
async function secretFile(relative, body) {
  const file = path.join(runtime, relative);
  await writeFile(file, body, { mode: 0o600 });
  await chmod(file, 0o600);
}
async function certificates() {
  const dir = path.join(runtime, "certs");
  await mkdir(dir, { mode: 0o700 });
  const file = (name) => path.join(dir, name);
  for (const name of ["ca", "bad-ca"]) {
    await quiet("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-days",
      "2",
      "-subj",
      `/CN=Covemeet isolated SIP ${name}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout",
      file(`${name}.key`),
      "-out",
      file(`${name}.crt`),
    ]);
  }
  for (const name of ["asterisk", "sip"]) {
    await quiet("openssl", [
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-sha256",
      "-subj",
      `/CN=${name}`,
      "-keyout",
      file(`${name}.key`),
      "-out",
      file(`${name}.csr`),
    ]);
    await secretFile(
      `certs/${name}.ext`,
      `basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${name}\n`,
    );
    await quiet("openssl", [
      "x509",
      "-req",
      "-in",
      file(`${name}.csr`),
      "-CA",
      file("ca.crt"),
      "-CAkey",
      file("ca.key"),
      "-set_serial",
      `0x${randomBytes(16).toString("hex")}`,
      "-days",
      "2",
      "-sha256",
      "-extfile",
      file(`${name}.ext`),
      "-out",
      file(`${name}.crt`),
    ]);
    await quiet("openssl", [
      "verify",
      "-CAfile",
      file("ca.crt"),
      "-verify_hostname",
      name,
      file(`${name}.crt`),
    ]);
    await rm(file(`${name}.csr`));
    await rm(file(`${name}.ext`));
  }
  // No root signing key is mounted into any service or needed after issuing these certificates.
  await rm(file("ca.key"));
  await rm(file("bad-ca.key"));
}
try {
  await mkdir(results, { recursive: true, mode: 0o700 });
  const subnet = await unusedSubnet();
  const secrets = {
    db: randomBytes(24).toString("hex"),
    key: randomBytes(12).toString("hex"),
    api: randomBytes(32).toString("hex"),
    ari: randomBytes(32).toString("hex"),
    trunk: randomBytes(32).toString("hex"),
    client: randomBytes(32).toString("hex"),
  };
  await secretFile(
    "fixture.env",
    [
      `SIP_TEST_DB_PASSWORD=${secrets.db}`,
      `SIP_TEST_LIVEKIT_KEY=${secrets.key}`,
      `SIP_TEST_LIVEKIT_SECRET=${secrets.api}`,
      `SIP_TEST_ARI_PASSWORD=${secrets.ari}`,
      `SIP_TEST_TRUNK_PASSWORD=${secrets.trunk}`,
      `SIP_TEST_SUBNET=${subnet.cidr}`,
      `SIP_TEST_PBX_IP=${subnet.pbx}`,
      `SIP_TEST_UID=${process.getuid?.() ?? 1000}`,
      `SIP_TEST_GID=${process.getgid?.() ?? 1000}`,
      "",
    ].join("\n"),
  );
  await secretFile("client-password", `${secrets.client}\n`);
  await secretFile(
    "livekit.yaml",
    [
      "port: 7880",
      "bind_addresses: [0.0.0.0]",
      "rtc:",
      "  tcp_port: 7881",
      "  udp_port: 7882",
      "  use_external_ip: false",
      "redis:",
      "  address: sip-redis:6379",
      "keys:",
      `  ${secrets.key}: ${secrets.api}`,
      "logging:",
      "  level: error",
      "",
    ].join("\n"),
  );
  await mkdir(path.join(runtime, "asterisk"), { mode: 0o700 });
  for (const name of [
    "asterisk.conf",
    "modules.conf",
    "extensions.conf",
    "logger.conf",
    "rtp.conf",
    "http.conf",
  ]) {
    await copyFile(
      path.join(root, "infra/asterisk", name),
      path.join(runtime, "asterisk", name),
    );
    await chmod(path.join(runtime, "asterisk", name), 0o600);
  }
  let pjsip = await readFile(
    path.join(root, "infra/asterisk/pjsip.conf.template"),
    "utf8",
  );
  pjsip = pjsip
    .replaceAll("__CLIENT_PASSWORD__", secrets.client)
    .replaceAll("__LIVEKIT_TRUNK_PASSWORD__", secrets.trunk);
  await secretFile("asterisk/pjsip.conf", pjsip);
  await secretFile(
    "asterisk/ari.conf",
    (
      await readFile(
        path.join(root, "infra/asterisk/ari.conf.template"),
        "utf8",
      )
    ).replaceAll("__ARI_PASSWORD__", secrets.ari),
  );
  await secretFile(
    "sip.yaml",
    (await readFile(path.join(root, "infra/sip/config.yaml.template"), "utf8"))
      .replaceAll("__LIVEKIT_API_KEY__", secrets.key)
      .replaceAll("__LIVEKIT_API_SECRET__", secrets.api),
  );
  await certificates();
  prepared = true;
  // Build the client first because the Node runner copies its ABI-compatible binary.
  await command([
    "build",
    "-f",
    "infra/sip-client.Dockerfile",
    "-t",
    "covemeet-sip-client:local",
    ".",
  ]);
  await compose(["build", "asterisk", "sip", "sip-runner"]);
  await compose([
    "up",
    "-d",
    "sip-postgres",
    "sip-redis",
    "livekit",
    "asterisk",
    "sip",
  ]);
  await waitForServices();
  await verifySipTls();
  const runnerExit = await compose(
    ["run", "--rm", "--no-deps", "--use-aliases", "sip-runner"],
    { allowFailure: true },
  );
  await diagnostics();
  if (runnerExit !== 0)
    throw new Error("Native SIP validation failed; sanitized reports retained");
  console.log(
    `Native SIP validation report: ${path.join(results, "sip-media.json")}`,
  );
} finally {
  if (prepared && !diagnosticsCollected) {
    try {
      await diagnostics();
    } catch {
      /* Cleanup must still run. */
    }
  }
  try {
    if (prepared)
      cleanupSucceeded =
        (await compose(["down", "--volumes", "--remove-orphans"], {
          allowFailure: true,
          cleanup: true,
        })) === 0;
    else cleanupSucceeded = true;
  } catch {
    ((cleanupSucceeded = false), (diagnosticsCollected = false));
  }
  // Remove only this script's private generated inputs, even if Docker cleanup failed.
  for (const name of [
    "fixture.env",
    "client-password",
    "livekit.yaml",
    "sip.yaml",
    "asterisk",
    "certs",
  ]) {
    await rm(path.join(runtime, name), { recursive: true, force: true });
  }
  if (cleanupSucceeded) await rm(lock, { force: true });
  else {
    console.error(
      "SIP fixture Docker cleanup incomplete; reserved fixture lock retained for inspection",
    );
    process.exitCode = 1;
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
