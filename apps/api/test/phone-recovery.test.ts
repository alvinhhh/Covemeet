import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { MemoryStore } from "../src/store.js";
import { loadConfig } from "../src/config.js";
import {
  PhoneDialogService,
  type PhoneSupervisorInput,
} from "../src/phone-dialogs.js";
import {
  PhoneDockerManager,
  PhoneRecoveryError,
  phonePbxEpoch,
  recoverManagedPhone,
} from "../src/phone-recovery.js";

async function fixture() {
  const store = new MemoryStore();
  const before = "2026-10-01T00:00:00.000000000Z",
    after = "2026-10-02T00:00:00.000000000Z";
  const input = (offset: number, started: string): PhoneSupervisorInput => ({
    ownerId: randomUUID(),
    pbxId: "managed-test",
    pbxEpoch: phonePbxEpoch(String(offset + 1).repeat(64), started),
    runtime: {
      daemonId: "daemon-test",
      project: "covemeet-phone-test",
      supervisor: String(offset).repeat(64),
      pbx: String(offset + 1).repeat(64),
      sip: String(offset + 2).repeat(64),
    },
  });
  const old = input(1, before),
    next = input(4, after);
  const containers = new Map<string, any>();
  for (const [claim, started] of [
    [old, before],
    [next, after],
  ] as const)
    for (const role of ["supervisor", "pbx", "sip"] as const)
      containers.set(claim.runtime![role], {
        Id: claim.runtime![role],
        Config: {
          Labels: {
            "com.docker.compose.project": claim.runtime!.project,
            "io.covemeet.phone.pbx": claim.pbxId,
            "io.covemeet.phone.owner": claim.ownerId,
            "io.covemeet.phone.role": role,
          },
        },
        State: { Running: true, Restarting: false, StartedAt: started },
      });
  const mutations: string[] = [];
  let daemon = "daemon-test",
    failDelete = false;
  const manager = new PhoneDockerManager(async (method, path, body) => {
    if (path === "/info") return { ID: daemon };
    const id = path.split("/")[2]!.split("?")[0]!;
    if (method === "GET") return structuredClone(containers.get(id));
    mutations.push(`${method}:${id}`);
    if (method === "POST")
      assert.deepEqual(body, {
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
      });
    if (method === "DELETE") {
      assert(path.endsWith("?force=true&v=false"));
      if (failDelete) throw new Error("unknown delete");
      containers.delete(id);
    }
    return {};
  });
  const claim = await store.claimPhoneSupervisor(old);
  const config = loadConfig({
    NODE_ENV: "test",
    SESSION_SECRET: "x".repeat(40),
    PHONE_ENABLED: "true",
    PHONE_GATEWAY_KEY: "y".repeat(40),
    PHONE_TRUNK_ID: "trunk",
    PHONE_SIP_ADDRESS: "sips:test.example",
  });
  const service = new PhoneDialogService(config, store, {
    available: true,
    token: async () => "",
    remove: async () => {},
    end: async () => {},
    close() {},
  });
  const { runtime, ...fields } = old;
  let dialog = await store.createPhoneDialog(
    {
      ...fields,
      callId: randomUUID(),
      callerChannelId: "caller",
      trunkId: "trunk",
      inboundEndpoint: "in",
      outboundEndpoint: "out",
      sipTrunkId: "ST_test",
      sipRuleId: "SDR_test",
    },
    20,
  );
  dialog = await store.changePhoneDialog(
    dialog.callId,
    old.ownerId,
    dialog.revision,
    { type: "begin", operation: "answer" },
  );
  dialog = await store.changePhoneDialog(
    dialog.callId,
    old.ownerId,
    dialog.revision,
    { type: "settle", operation: "answer", outcome: "confirmed" },
  );
  const rooms: any = {
    listRooms: async () => [],
    listParticipants: async () => [],
    removeParticipant: async () => {},
  };
  return {
    store,
    old,
    next,
    claim,
    dialog,
    manager,
    mutations,
    containers,
    rooms,
    service,
    recover: () =>
      recoverManagedPhone(store, service, rooms, manager, next, old.ownerId),
    wrongDaemon() {
      daemon = "other-host";
    },
    failDelete() {
      failDelete = true;
    },
  };
}

test("atomic non-expiring PBX claim permits one writer across concurrent starts", async () => {
  const store = new MemoryStore();
  const inputs = Array.from({ length: 20 }, () => ({
    pbxId: "shared-pbx",
    ownerId: randomUUID(),
    pbxEpoch: "boot",
  }));
  const results = await Promise.allSettled(
    inputs.map((input) => store.claimPhoneSupervisor(input)),
  );
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const winner = (
    results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>
  ).value;
  assert.deepEqual(
    await store.claimPhoneSupervisor(
      inputs.find((i) => i.ownerId === winner.ownerId)!,
    ),
    winner,
  );
  await assert.rejects(
    store.claimPhoneSupervisor({
      ...inputs[1]!,
      ownerId: randomUUID(),
      pbxEpoch: "later-boot",
    }),
  );
});

test("physical runtime fencing precedes orphan finish and ownership transfer", async () => {
  const f = await fixture();
  const finish = f.service.finish.bind(f.service);
  f.service.finish = async (...args) => {
    for (const role of ["supervisor", "pbx", "sip"] as const)
      assert.equal(f.containers.has(f.old.runtime![role]), false);
    return finish(...args);
  };
  const next = await f.recover();
  assert.equal(next.ownerId, f.next.ownerId);
  assert.equal(
    (await f.store.queryPhoneDialogs({ callId: f.dialog.callId }))[0]!.state,
    "closed",
  );
  assert.equal(f.mutations.length, 6);
  assert.equal(f.mutations[0], `POST:${f.old.runtime!.supervisor}`);
  await assert.rejects(
    f.recover(),
    /unresolved/,
    "stale recovery must not fence the replacement",
  );
  assert.equal(f.containers.size, 3);
});

for (const kind of ["daemon", "label", "delete", "boot"] as const)
  test(`${kind} mismatch or uncertainty prevents recovery completion`, async () => {
    const f = await fixture();
    if (kind === "daemon") f.wrongDaemon();
    if (kind === "label")
      f.containers.get(f.old.runtime!.sip)!.Config.Labels[
        "io.covemeet.phone.owner"
      ] = randomUUID();
    if (kind === "delete") f.failDelete();
    if (kind === "boot") f.next.pbxEpoch = "unverified-label";
    await assert.rejects(f.recover());
    assert.equal(
      (await f.store.getPhoneSupervisor(f.old.pbxId))!.ownerId,
      f.old.ownerId,
    );
    assert.notEqual(
      (await f.store.queryPhoneDialogs({ callId: f.dialog.callId }))[0]!.state,
      "closed",
    );
    if (kind === "daemon" || kind === "label")
      assert.equal(f.mutations.length, 0);
  });

for (const state of ["pending", "unknown", "uncertain"] as const)
  test(`${state} orphan stays reserved even after its runtime is destroyed`, async () => {
    const f = await fixture(),
      d = f.store.phoneDialogs.get(f.dialog.callId)!;
    if (state === "uncertain") d.uncertain = true;
    else d.operations.play = state;
    await assert.rejects(f.recover());
    assert.equal(
      (await f.store.queryPhoneDialogs({ callId: d.callId }))[0]!.state,
      "stopping",
    );
    assert.equal(
      (await f.store.getPhoneSupervisor(f.old.pbxId))!.state,
      "fencing",
    );
    await assert.rejects(f.service.claim(f.next));
  });

test("fenced old owner cannot reserve, join, or begin another native operation", async () => {
  const f = await fixture();
  await f.store.fencePhoneSupervisor(f.claim);
  await assert.rejects(
    f.store.changePhoneDialog(
      f.dialog.callId,
      f.old.ownerId,
      f.dialog.revision,
      { type: "begin", operation: "play" },
    ),
    /ownership/,
  );
  const { runtime, ...identity } = f.old;
  await assert.rejects(
    f.store.createPhoneDialog(
      {
        ...identity,
        callId: randomUUID(),
        callerChannelId: "new",
        trunkId: "trunk",
        inboundEndpoint: "in",
        outboundEndpoint: "out",
        sipTrunkId: "ST_test",
        sipRuleId: "SDR_test",
      },
      20,
    ),
    /ownership/,
  );
  await assert.rejects(
    f.store.reservePhone(
      "MISSING",
      f.dialog.callId,
      randomUUID(),
      20,
      () => {},
      f.old.ownerId,
    ),
  );
});

test("recovery removes only the exact recorded native SID and preserves collisions", async () => {
  for (const collision of [false, true]) {
    const f = await fixture(),
      d = f.store.phoneDialogs.get(f.dialog.callId)!;
    d.holding = {
      roomName: `phone-hold-${d.callId}_abcdefgh`,
      roomSid: "RM_original",
      nativeIdentity: `sip_${createHash("sha256").update("covemeet-pbx").digest("hex").slice(0, 16)}`,
      nativeSid: "PA_original",
    };
    f.rooms.listRooms = async () => [
      { name: d.holding!.roomName, sid: "RM_original" },
    ];
    let peers = [
      {
        identity: d.holding.nativeIdentity,
        sid: collision ? "PA_other" : "PA_original",
        kind: 3,
        attributes: { "sip.trunkID": "ST_test", "sip.ruleID": "SDR_test" },
      },
    ];
    f.rooms.listParticipants = async () => peers;
    let removed = 0;
    f.rooms.removeParticipant = async () => {
      removed++;
      peers = [];
    };
    if (collision) {
      await assert.rejects(f.recover());
      assert.equal(removed, 0);
    } else {
      await f.recover();
      assert.equal(removed, 1);
    }
  }
});

test("runtime identity retries ignore JSONB object key order", async () => {
  const f = await fixture();
  const stored = f.store.phoneSupervisors.get(f.old.pbxId)!;
  stored.runtime = Object.fromEntries(
    Object.entries(stored.runtime!).reverse(),
  ) as typeof stored.runtime;
  assert.equal(
    (await f.store.claimPhoneSupervisor(f.old)).ownerId,
    f.old.ownerId,
  );
});

test("an unknown orphan does not block cleanup of independent confirmed dialogs", async () => {
  const f = await fixture();
  const first = f.store.phoneDialogs.get(f.dialog.callId)!;
  first.uncertain = true;
  const { runtime, ...fields } = f.old;
  const second = await f.store.createPhoneDialog(
    {
      ...fields,
      callId: randomUUID(),
      callerChannelId: "second-caller",
      trunkId: "trunk",
      inboundEndpoint: "in",
      outboundEndpoint: "out",
      sipTrunkId: "ST_test",
      sipRuleId: "SDR_test",
    },
    20,
  );
  await assert.rejects(f.recover());
  assert.equal(f.store.phoneDialogs.get(first.callId)!.state, "stopping");
  assert.equal(f.store.phoneDialogs.get(second.callId)!.state, "closed");
  assert.equal(
    f.store.phoneSupervisors.get(f.old.pbxId)!.ownerId,
    f.old.ownerId,
  );
});

test("recovery diagnostics retain only the fixed failing stage", async () => {
  const f = await fixture();
  f.rooms.listRooms = async () => {
    throw new Error("private-room-name: secret-credential");
  };
  await assert.rejects(f.recover(), (error: unknown) => {
    assert(error instanceof PhoneRecoveryError);
    assert.equal(error.stage, "discover-holding");
    assert.deepEqual(error.orphanFailures, ["discover-holding"]);
    assert(!JSON.stringify(error).includes("secret-credential"));
    assert(!String(error).includes("private-room-name"));
    return true;
  });
  assert.equal(f.store.phoneDialogs.get(f.dialog.callId)!.state, "stopping");
  assert.equal(
    f.store.phoneSupervisors.get(f.old.pbxId)!.ownerId,
    f.old.ownerId,
  );
});

test("recovery waits beyond five seconds for the fenced relay without adopting its SID", async () => {
  const f = await fixture();
  const d = f.store.phoneDialogs.get(f.dialog.callId)!;
  d.holding = {
    roomName: `phone-hold-${d.callId}_abcdefgh`,
    roomSid: "RM_original",
    nativeIdentity: "sip_original",
    nativeSid: "PA_original",
  };
  f.rooms.listRooms = async () => [
    { name: d.holding!.roomName, sid: d.holding!.roomSid },
  ];
  const started = Date.now();
  let delayedReads = 0;
  f.rooms.listParticipants = async () => {
    if (delayedReads >= 60) return [];
    delayedReads++;
    assert.notEqual(f.store.phoneDialogs.get(d.callId)!.state, "closed");
    assert.equal(
      f.store.phoneSupervisors.get(f.old.pbxId)!.ownerId,
      f.old.ownerId,
    );
    return [{ identity: `cm-relay-${d.callId}`, sid: "PA_unrecorded_relay" }];
  };
  f.rooms.removeParticipant = async () => {
    assert.fail("Never delete an unrecorded relay SID");
  };
  await f.recover();
  assert(delayedReads > 50, "Exercise the prior premature failure boundary");
  assert(Date.now() - started >= 5000);
  assert.equal(f.store.phoneDialogs.get(d.callId)!.state, "closed");
  assert.equal(
    f.store.phoneSupervisors.get(f.old.pbxId)!.ownerId,
    f.next.ownerId,
  );
});
