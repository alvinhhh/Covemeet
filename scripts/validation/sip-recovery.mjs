import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { writeEvidence } from "../sip-test-support.mjs";
import { RoomServiceClient, SipClient } from "livekit-server-sdk";
import { loadConfig } from "../../apps/api/dist/config.js";
import { PgStore } from "../../apps/api/dist/store.js";
import { LiveMedia } from "../../apps/api/dist/media.js";
import { PhoneDialogService } from "../../apps/api/dist/phone-dialogs.js";
import {
  PhoneDockerManager,
  PhoneRecoveryError,
  fenceManagedPhone,
  recoverManagedPhone,
} from "../../apps/api/dist/phone-recovery.js";

// Independent, disposable fixture manager. This is the only fixture process with
// a Docker socket. It never accepts caller data or arbitrary cleanup names.
process.umask(0o077);
const old = JSON.parse(await readFile("/phone-old-runtime.json", "utf8"));
assert.equal(old.pbxId, "native-fixture");
assert.equal(old.runtime.project, "covemeet-sip-test");
const database = new URL(process.env.SIP_TEST_DATABASE_URL);
assert.equal(database.hostname, "sip-postgres");
assert.equal(database.pathname, "/covemeet_sip_test");
assert.equal(process.env.LIVEKIT_URL, "http://livekit:7880");
const config = loadConfig({
  NODE_ENV: "test",
  SESSION_SECRET: randomBytes(40).toString("hex"),
  LIVEKIT_URL: process.env.LIVEKIT_URL,
  LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
  LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET,
});
const store = new PgStore(database.href);
const media = new LiveMedia(config, store);
const manager = new PhoneDockerManager();
const report = {
  result: "failed",
  mode: process.argv[2],
  physicalDevices: false,
};
let stage = "database-init";
try {
  await store.init();
  if (report.mode === "fence") {
    stage = "find-orphan";
    const dialogs = await store.queryPhoneDialogs({ pbxId: old.pbxId });
    assert.equal(
      dialogs.length,
      1,
      "Expected the live orphan's durable reservation",
    );
    assert(dialogs[0].holding && dialogs[0].binding);
    assert.equal(dialogs[0].operations["attach-caller"], "confirmed");
    stage = "fence-runtime";
    await fenceManagedPhone(store, manager, old.pbxId, old.ownerId);
    assert.equal(
      (await store.queryPhoneDialogs({ pbxId: old.pbxId })).length,
      1,
      "Fencing alone must never release capacity",
    );
    report.oldRuntimeRemoved = true;
    report.reservationRetainedAfterFence = true;
  } else if (report.mode === "recover") {
    stage = "read-replacement";
    const replacement = JSON.parse(
      await readFile("/phone-runtime.json", "utf8"),
    );
    assert.notEqual(old.ownerId, replacement.ownerId);
    assert.notEqual(old.pbxEpoch, replacement.pbxEpoch);
    stage = "find-orphan";
    const dialogs = await store.queryPhoneDialogs({ pbxId: old.pbxId });
    assert.equal(dialogs.length, 1);
    const rooms = new RoomServiceClient(
      config.livekitUrl,
      config.livekitKey,
      config.livekitSecret,
    );
    stage = "recover-orphan";
    await recoverManagedPhone(
      store,
      new PhoneDialogService(config, store, media),
      rooms,
      manager,
      replacement,
      old.ownerId,
    );
    stage = "verify-recovery";
    const [closed] = await store.queryPhoneDialogs({
      callId: dialogs[0].callId,
    });
    assert.equal(closed.state, "closed");
    const row = await store.pool.query(
      "SELECT released FROM phone_calls WHERE call_id=$1",
      [closed.callId],
    );
    assert.equal(row.rows[0]?.released, true);
    assert.equal(
      (await store.getPhoneSupervisor(old.pbxId)).ownerId,
      replacement.ownerId,
    );
    const sip = new SipClient(
      config.livekitUrl,
      config.livekitKey,
      config.livekitSecret,
    );
    stage = "delete-old-sip-rule";
    await sip.deleteSipDispatchRule(closed.sipRuleId);
    stage = "delete-old-sip-trunk";
    await sip.deleteSipTrunk(closed.sipTrunkId);
    report.orphanReconciled = true;
    report.capacityReleasedAfterVerifiedFence = true;
    report.freshBootClaimed = true;
  } else throw new Error("Invalid recovery phase");
  report.result = "passed";
} catch (error) {
  report.failedStage = stage;
  if (error instanceof PhoneRecoveryError) {
    report.recoveryStage = error.stage;
    report.orphanFailures = error.orphanFailures;
  }
  // Fixed statuses and counts only; never persist raw errors or call bindings.
  try {
    const dialogs = await store.queryPhoneDialogs({ pbxId: old.pbxId });
    report.unresolvedDialogs = dialogs.map((dialog) => ({
      state: dialog.state,
      uncertain: dialog.uncertain,
      bound: Boolean(dialog.binding),
      holdingRecorded: Boolean(dialog.holding),
      pendingOperations: Object.values(dialog.operations).filter(
        (s) => s === "pending",
      ).length,
      unknownOperations: Object.values(dialog.operations).filter(
        (s) => s === "unknown",
      ).length,
    }));
    report.supervisorState = (await store.getPhoneSupervisor(old.pbxId))?.state;
  } catch {
    report.stateUnavailable = true;
  }
  process.exitCode = 1;
} finally {
  media.close();
  await store.close();
  await writeEvidence(`/results/sip-${report.mode}.json`, report, {
    shared: true,
  });
  console.log(`Managed SIP ${report.mode}: ${report.result}`);
}
