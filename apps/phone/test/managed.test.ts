import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AriClient } from "../src/ari.js";
import { JournalRegistry } from "../src/journal.js";
import { SipSupervisor } from "../src/supervisor.js";
import {
  loadManagedPhoneConfig,
  readManagedPhoneRuntime,
  runManagedPhone,
} from "../src/managed.js";

const ownerId = "1c58eb99-7fe4-4cdc-918a-806a4c3ebbe6";
const env = {
  NODE_ENV: "production",
  PHONE_ENABLED: "true",
  PHONE_AUTHORITY_URL: "https://phone.example",
  PHONE_ARI_URL: "https://phone.example:9445",
  LIVEKIT_URL: "https://phone.example",
  PHONE_LIVEKIT_WS_URL: "wss://phone.example",
  SITE_ORIGIN: "https://meeting.example",
  PHONE_GATEWAY_KEY: "g".repeat(64),
  PHONE_ARI_USERNAME: "covemeet-supervisor",
  PHONE_ARI_PASSWORD: "a".repeat(64),
  LIVEKIT_API_KEY: "fixture",
  LIVEKIT_API_SECRET: "s".repeat(64),
  PHONE_PBX_ID: "production",
  PHONE_OWNER_ID: ownerId,
  PHONE_TRUNK_ID: "TKfixture",
  PHONE_SIP_TRUNK_ID: "ST_fixture",
  PHONE_SIP_RULE_ID: "SDR_fixture",
  PHONE_MANAGED_FILE: "/runtime.json",
};
const runtime = {
  pbxId: "production",
  ownerId,
  pbxEpoch: "e".repeat(64),
  runtime: {
    daemonId: "daemon",
    project: "covemeet-pilot",
    supervisor: "a".repeat(64),
    pbx: "b".repeat(64),
    sip: "c".repeat(64),
  },
};

test("managed phone requires production TLS, bounded calls and a private exact runtime", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "phone-managed-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "runtime.json");
  const config = loadManagedPhoneConfig({ ...env, PHONE_MANAGED_FILE: file });
  assert.equal(config.maxCalls, 2);
  assert.equal(config.maxCallMs, 7200000);
  for (const override of [
    { NODE_ENV: "development" },
    { PHONE_ENABLED: "false" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { PHONE_AUTHORITY_URL: "http://core:4100" },
    { PHONE_ARI_URL: "https://phone.example/ari" },
    { PHONE_LIVEKIT_WS_URL: "ws://livekit:7880" },
    { PHONE_MAX_CALLS: "21" },
    { PHONE_MAX_DURATION_SECONDS: "7201" },
  ])
    assert.throws(() => loadManagedPhoneConfig({ ...env, ...override }));
  await writeFile(file, JSON.stringify(runtime), { mode: 0o600 });
  assert.deepEqual(await readManagedPhoneRuntime(config), runtime);
  await chmod(file, 0o644);
  await assert.rejects(readManagedPhoneRuntime(config), /private owned/);
  await chmod(file, 0o600);
  await assert.rejects(
    readManagedPhoneRuntime({
      ...config,
      ownerId: "536bbd1e-c6b9-412a-b6b5-30c90e139b65",
    }),
    /does not match/,
  );
  const link = join(directory, "link.json");
  await symlink(file, link);
  await assert.rejects(
    readManagedPhoneRuntime({ ...config, runtimeFile: link }),
  );
  await writeFile(file, JSON.stringify({ ...runtime, runtime: undefined }));
  await assert.rejects(readManagedPhoneRuntime(config));
});

test("managed phone claims before ARI and closes calls even if readiness cleanup fails", async (t) => {
  const order: string[] = [];
  const controller = new AbortController();
  t.mock.method(JournalRegistry.prototype, "initialize", async () => {
    order.push("claim");
  });
  t.mock.method(AriClient.prototype, "connect", async () => {
    order.push("connect");
  });
  t.mock.method(AriClient.prototype, "close", async () => {
    order.push("close");
  });
  t.mock.method(SipSupervisor.prototype, "stop", async () => {
    order.push("stop");
  });
  let started = false;
  await assert.rejects(
    runManagedPhone(
      loadManagedPhoneConfig(env),
      runtime,
      controller.signal,
      async (ready) => {
        order.push(ready ? "ready" : "unready");
        if (ready) {
          started = true;
          controller.abort();
        } else if (started) throw new Error("readiness cleanup failed");
      },
    ),
    /readiness cleanup failed/,
  );
  assert.deepEqual(order.slice(0, 4), ["unready", "claim", "connect", "ready"]);
  assert.deepEqual(order.slice(-2), ["stop", "close"]);
});

test("aborting a pending managed claim never connects ARI or reports ready", async (t) => {
  const controller = new AbortController();
  t.mock.method(JournalRegistry.prototype, "initialize", async () => {
    controller.abort();
  });
  const connect = t.mock.method(AriClient.prototype, "connect", async () => {});
  const close = t.mock.method(AriClient.prototype, "close", async () => {});
  const stop = t.mock.method(SipSupervisor.prototype, "stop", async () => {});
  const states: boolean[] = [];
  await assert.rejects(
    runManagedPhone(
      loadManagedPhoneConfig(env),
      runtime,
      controller.signal,
      async (ready) => {
        states.push(ready);
      },
    ),
    { name: "AbortError" },
  );
  assert.equal(connect.mock.callCount(), 0);
  assert.equal(close.mock.callCount(), 1);
  assert.ok(stop.mock.callCount() >= 1);
  assert.deepEqual(states, [false, false]);
});
