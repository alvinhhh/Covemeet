#!/usr/bin/env node
// Checks the local Docker boundary without credentials, devices, or service changes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const project = "covemeet-local-tls";
const ports = {
  edge: { "8443/tcp": "8443" },
  livekit: {
    "17881/tcp": "17881",
    "17882/udp": "17882",
    "13478/udp": "13478",
    "15349/tcp": "15349",
  },
  mailpit: { "8025/tcp": "18025" },
};
const listeners = {
  core: 4100,
  portal: 4200,
  "portal-postgres": 5432,
  livekit: 7880,
  postgres: 5432,
  redis: 6379,
  mailpit: 1025,
};

export function inspectBoundary(containers, network) {
  assert.equal(network.Name, project, "Unexpected project network");
  assert.equal(network.Driver, "bridge", "Local network must use a bridge");
  assert.equal(
    network.Options?.["com.docker.network.bridge.gateway_mode_ipv4"] ?? "nat",
    "nat",
    "Routed bridge mode is outside this local boundary",
  );
  for (const service of [
    "edge",
    "core",
    "livekit",
    "postgres",
    "redis",
    "mailpit",
    ...(containers.some((row) => row.service === "portal")
      ? ["portal", "portal-postgres"]
      : []),
  ])
    assert.equal(
      containers.filter((row) => row.service === service).length,
      1,
      `Expected one running ${service}`,
    );
  const targets = [];
  for (const row of containers) {
    assert.equal(row.project, project, "Unexpected project container");
    assert.equal(row.running, true, `${row.service} is not running`);
    assert.equal(
      row.networkMode,
      project,
      `${row.service} bypasses the project bridge`,
    );
    assert.deepEqual(
      Object.keys(row.networks),
      [project],
      `${row.service} has another network attachment`,
    );
    for (const [port, bindings] of Object.entries(row.ports ?? {})) {
      for (const binding of bindings ?? []) {
        assert.equal(
          binding.HostIp,
          "127.0.0.1",
          `${row.service} publishes outside IPv4 loopback`,
        );
        assert.equal(
          binding.HostPort,
          ports[row.service]?.[port],
          `${row.service} has an unexpected host port`,
        );
      }
    }
    for (const [port, hostPort] of Object.entries(ports[row.service] ?? {})) {
      if (["13478/udp", "15349/tcp"].includes(port) && !row.ports?.[port])
        continue; // Optional local TURN overlay.
      assert.deepEqual(
        row.ports?.[port],
        [{ HostIp: "127.0.0.1", HostPort: hostPort }],
        `${row.service} expected listener is missing`,
      );
    }
    if (listeners[row.service]) {
      const host = row.networks[project].IPAddress;
      assert.equal(isIP(host), 4, `${row.service} has no IPv4 address`);
      assert(
        !row.networks[project].GlobalIPv6Address,
        "IPv6 bridge probes are not implemented",
      );
      targets.push({
        service: row.service,
        host,
        port: listeners[row.service],
      });
    }
  }
  for (const id of Object.keys(network.Containers ?? {}))
    assert(
      containers.some((row) => row.id === id),
      "A foreign container is attached to the trusted bridge",
    );
  return targets;
}

const exec = promisify(execFile);
async function docker(args) {
  try {
    return (
      await exec("docker", args, { timeout: 30_000, maxBuffer: 1024 * 1024 })
    ).stdout;
  } catch {
    // Docker error output may include command arguments; keep failure evidence bounded.
    throw new Error(`Docker ${args[0]} failed; isolation is unverified.`);
  }
}

const probeCode = `
  const net = require("node:net");
  Promise.all(JSON.parse(process.argv[1]).map(target => new Promise(resolve => {
    const socket = net.connect({host: target.host, port: target.port});
    const finish = outcome => { socket.destroy(); resolve({...target, outcome}); };
    socket.setTimeout(2000, () => finish("timeout"));
    socket.once("connect", () => finish("connected"));
    socket.once("error", error => finish(error.code || "error"));
  }))).then(rows => console.log(JSON.stringify(rows)));
`;

async function probe(network, image, targets) {
  return JSON.parse(
    await docker([
      "run",
      "--rm",
      "--pull",
      "never",
      "--network",
      network,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--user",
      "1000:1000",
      "--memory",
      "96m",
      "--cpus",
      "0.25",
      "--pids-limit",
      "32",
      "--entrypoint",
      "node",
      image,
      "-e",
      probeCode,
      JSON.stringify(targets),
    ]),
  );
}

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const reportPath = resolve(root, "test-results/local-network.json");
  await mkdir(dirname(reportPath), { recursive: true });
  const report = {
    startedAt: new Date().toISOString(),
    result: "running",
    scope:
      "Local Docker bridge isolation and exact loopback publications; no host-admin, LAN, UDP, TURN, media or capacity claim",
    containers: [],
  };
  try {
    const ids = (
      await docker([
        "ps",
        "-q",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ])
    )
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    assert(ids.length > 0, "The isolated local stack is not running");
    // Select only non-secret fields. Never load container environment variables.
    const format =
      '{"id":{{json .Id}},"image":{{json .Image}},"service":{{json (index .Config.Labels "com.docker.compose.service")}},"project":{{json (index .Config.Labels "com.docker.compose.project")}},"running":{{json .State.Running}},"networkMode":{{json .HostConfig.NetworkMode}},"ports":{{json .HostConfig.PortBindings}},"networks":{{json .NetworkSettings.Networks}}}';
    const containers = (await docker(["inspect", "--format", format, ...ids]))
      .trim()
      .split("\n")
      .map((row) => JSON.parse(row));
    const [network] = JSON.parse(await docker(["network", "inspect", project]));
    const targets = inspectBoundary(containers, network);
    report.containers = containers.map(({ service, image }) => ({
      service,
      image,
    }));
    report.exactLoopbackPublications = true;
    report.privateNetworkAttachments = true;
    const image = containers.find((row) => row.service === "core").image;
    report.trustedBridge = await probe(project, image, targets);
    assert(
      report.trustedBridge.every((row) => row.outcome === "connected"),
      "Positive control failed: a private listener is not reachable on its own bridge",
    );
    report.unrelatedBridge = await probe("bridge", image, targets);
    assert.equal(report.unrelatedBridge.length, targets.length);
    assert(
      report.unrelatedBridge.every((row) =>
        ["timeout", "EHOSTUNREACH", "ENETUNREACH", "ECONNREFUSED"].includes(
          row.outcome,
        ),
      ),
      "A private listener is reachable from the unrelated Docker bridge",
    );
    report.result = "passed";
    console.log(
      `PASS: ${targets.length} private TCP listeners reachable on the trusted bridge and blocked from the unrelated bridge; published ports are loopback only.`,
    );
  } catch (error) {
    report.result = "failed";
    report.failure = error.message;
    process.exitCode = 1;
    console.error(error.message);
  } finally {
    report.finishedAt = new Date().toISOString();
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(`Evidence: ${reportPath}`);
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
