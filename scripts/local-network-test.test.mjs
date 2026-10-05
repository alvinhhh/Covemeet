import assert from "node:assert/strict";
import test from "node:test";
import { inspectBoundary } from "./local-network-test.mjs";

test("local network validation rejects published backends, broad binds and extra network attachments", () => {
  const project = "covemeet-local-tls";
  const published = {
    edge: { "8443/tcp": [{ HostIp: "127.0.0.1", HostPort: "8443" }] },
    livekit: {
      "17881/tcp": [{ HostIp: "127.0.0.1", HostPort: "17881" }],
      "17882/udp": [{ HostIp: "127.0.0.1", HostPort: "17882" }],
    },
    mailpit: { "8025/tcp": [{ HostIp: "127.0.0.1", HostPort: "18025" }] },
  };
  const rows = ["edge", "core", "livekit", "postgres", "redis", "mailpit"].map(
    (service, i) => ({
      id: String(i),
      service,
      project,
      running: true,
      networkMode: project,
      networks: { [project]: { IPAddress: `172.19.0.${i + 2}` } },
      ports: published[service] ?? {},
    }),
  );
  const network = {
    Name: project,
    Driver: "bridge",
    Containers: Object.fromEntries(rows.map(({ id }) => [id, {}])),
  };
  assert.equal(inspectBoundary(rows, network).length, 5);
  const hosted = structuredClone(rows);
  for (const [service, id] of [["portal", "6"], ["portal-postgres", "7"]])
    hosted.push({ ...structuredClone(rows[1]), service, id });
  assert.equal(inspectBoundary(hosted, network).length, 7);
  assert.throws(() => inspectBoundary(hosted.slice(0, -1), network));
  hosted[7].ports["5432/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "5432" }];
  assert.throws(() => inspectBoundary(hosted, network));
  const withTurn = structuredClone(rows);
  withTurn[2].ports["13478/udp"] = [{ HostIp: "127.0.0.1", HostPort: "13478" }];
  withTurn[2].ports["15349/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "15349" }];
  assert.equal(inspectBoundary(withTurn, network).length, 5);
  withTurn[2].ports["13478/udp"][0].HostIp = "0.0.0.0";
  assert.throws(() => inspectBoundary(withTurn, network));
  for (const mutate of [
    (copy) => {
      copy[1].ports["4100/tcp"] = [{ HostIp: "127.0.0.1", HostPort: "4100" }];
    },
    (copy) => {
      copy[0].ports["8443/tcp"][0].HostIp = "0.0.0.0";
    },
    (copy) => {
      copy[1].networks.bridge = { IPAddress: "172.17.0.2" };
    },
    (copy) => {
      copy[1].networkMode = "host";
    },
    (copy) => {
      copy[1].project = "other";
    },
  ]) {
    const copy = structuredClone(rows);
    mutate(copy);
    assert.throws(() => inspectBoundary(copy, network));
  }
  assert.throws(() =>
    inspectBoundary(rows, {
      ...network,
      Containers: { ...network.Containers, foreign: {} },
    }),
  );
  assert.throws(() => inspectBoundary(rows.slice(1), network));
});
