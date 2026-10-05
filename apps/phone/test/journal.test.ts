import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  JournalRegistry,
  phoneDialogSchema,
  type JournalAuthority,
  type PhoneDialog,
  type PhoneCleanupProof,
} from "../src/journal.js";
import { AriRequestError } from "../src/ari.js";
import { PhoneAuthorityRejected } from "../src/authority.js";

const proof: PhoneCleanupProof = {
  allocationsStopped: true,
  callerAbsent: true,
  outboundAbsent: true,
  bridgeAbsent: true,
  nativeAbsent: true,
  holdingRelayAbsent: true,
  rtcClosed: true,
};
const clone = <T>(value: T) => structuredClone(value);
async function fixture() {
  const config = {
    ownerId: randomUUID(),
    pbxId: "pbx-fixture",
    pbxEpoch: "epoch-fixture",
    outboundEndpoint: "livekit",
    sipTrunkId: "ST_fixture",
    sipRuleId: "SDR_fixture",
  };
  let dialog: PhoneDialog | undefined;
  const log: string[] = [];
  const authority: JournalAuthority = {
    async journalClaim(input) {
      if (input.ownerId !== config.ownerId)
        throw new PhoneAuthorityRejected(409);
      return { ...input, state: "active", revision: 1 };
    },
    async journalCreate(input) {
      log.push("create");
      dialog = {
        ...input,
        state: "open",
        revision: 1,
        operations: {},
        uncertain: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      return clone(dialog);
    },
    async journalQuery(query) {
      log.push("query");
      return {
        dialogs:
          dialog && ("pbxId" in query || dialog.callId === query.callId)
            ? [clone(dialog)]
            : [],
      };
    },
    async journalChange(callId, ownerId, revision, change) {
      assert.equal(callId, dialog?.callId);
      assert.equal(ownerId, dialog?.ownerId);
      assert.equal(
        revision,
        dialog?.revision,
        "journal changes must refresh the revision after atomic join binding",
      );
      assert(dialog);
      log.push(
        `change:${change.type}${"operation" in change ? `:${change.operation}` : ""}`,
      );
      dialog.revision++;
      if (change.type === "begin") {
        dialog.operations[change.operation] = "pending";
        if (change.operation === "play")
          dialog.playbackId = `cm-play-${callId}-${dialog.revision}`;
      } else if (change.type === "settle") {
        dialog.operations[change.operation] = change.outcome;
        if (change.outcome === "unknown") dialog.uncertain = true;
      } else if (change.type === "uncertain") dialog.uncertain = true;
      else {
        const { type: _, ...binding } = change;
        dialog.holding = binding;
      }
      return clone(dialog);
    },
    async journalStop(callId, ownerId, revision) {
      assert.equal(callId, dialog?.callId);
      assert.equal(ownerId, dialog?.ownerId);
      assert.equal(revision, dialog?.revision);
      assert(dialog);
      log.push("stop");
      dialog.state = "stopping";
      dialog.revision++;
      return clone(dialog);
    },
    async journalFinish(callId, ownerId, revision, sent) {
      assert.equal(callId, dialog?.callId);
      assert.equal(ownerId, dialog?.ownerId);
      assert.equal(revision, dialog?.revision);
      assert.deepEqual(sent, proof);
      assert(dialog);
      assert.equal(dialog.uncertain, false);
      assert(
        !Object.values(dialog.operations).some((state) =>
          ["pending", "unknown"].includes(state),
        ),
      );
      log.push("finish");
      dialog.state = "closed";
      dialog.revision++;
      return clone(dialog);
    },
  };
  const registry = new JournalRegistry(authority, config);
  assert.throws(() =>
    registry.forCall(randomUUID(), "caller", "inbound", "trunk"),
  );
  await registry.initialize();
  const journal = registry.forCall(randomUUID(), "caller", "inbound", "trunk");
  return {
    config,
    authority,
    registry,
    journal,
    log,
    get dialog() {
      return dialog;
    },
  };
}

test("journal reserves before mutation, refreshes after join binding, and persists playback identity", async () => {
  const f = await fixture();
  await f.journal.reserve();
  await f.journal.mutate("answer", async (dialog) => {
    assert.equal(dialog.operations.answer, "pending");
    f.log.push("answer");
  });
  assert(f.log.indexOf("change:begin:answer") < f.log.indexOf("answer"));
  f.dialog!.binding = { code: "A".repeat(26), participantId: randomUUID() };
  f.dialog!.revision++;
  await f.journal.mutate("play", async (dialog) => {
    assert.equal(dialog.playbackId, f.dialog!.playbackId);
    assert.equal(dialog.operations.play, "pending");
  });
  await f.journal.stop();
  await f.journal.finish(proof);
  assert.equal(f.dialog!.state, "closed");
});

test("another process cannot adopt an unresolved journal even after changing its PBX epoch", async () => {
  const f = await fixture();
  await f.journal.reserve();
  const replacement = new JournalRegistry(f.authority, {
    ...f.config,
    ownerId: randomUUID(),
    pbxEpoch: "new-operator-label",
  });
  await assert.rejects(replacement.initialize());
  assert.throws(() =>
    replacement.forCall(randomUUID(), "new-caller", "inbound", "trunk"),
  );
  assert.equal(f.log.includes("stop"), false);
  assert.equal(f.log.includes("finish"), false);
});

test("a definitive create denial differs from a lost create response", async () => {
  const denied = await fixture();
  denied.authority.journalCreate = async () => {
    throw new PhoneAuthorityRejected(429);
  };
  await assert.rejects(denied.journal.reserve());
  assert.equal(denied.journal.createOutcome, "rejected");
  await denied.journal.stop();
  assert.equal(denied.log.includes("stop"), false);

  const lost = await fixture(),
    create = lost.authority.journalCreate;
  lost.authority.journalCreate = async (input) => {
    await create(input);
    throw new Error("lost response");
  };
  await assert.rejects(lost.journal.reserve());
  assert.equal(lost.journal.createOutcome, "unknown");
  await lost.journal.stop();
  assert.equal(lost.dialog!.state, "stopping");
  assert.equal(lost.dialog!.uncertain, true);
  await assert.rejects(lost.journal.finish(proof));
  assert.equal(lost.log.includes("finish"), false);
});

for (const outcome of ["rejected", "unknown"] as const)
  test(`${outcome} ARI result is durably settled and only definitive rejection can finish`, async () => {
    const f = await fixture();
    await f.journal.reserve();
    await assert.rejects(
      f.journal.mutate("answer", async () => {
        throw new AriRequestError(
          outcome,
          outcome === "rejected" ? 409 : undefined,
        );
      }),
    );
    assert.equal(f.dialog!.operations.answer, outcome);
    await f.journal.stop();
    if (outcome === "rejected") await f.journal.finish(proof);
    else {
      await assert.rejects(f.journal.finish(proof));
      assert.equal(f.dialog!.uncertain, true);
      assert.equal(f.log.includes("finish"), false);
    }
  });

test("unknown begin response cannot launch a native mutation", async () => {
  const f = await fixture(),
    change = f.authority.journalChange;
  await f.journal.reserve();
  f.authority.journalChange = async (...args) => {
    const result = await change(...args);
    if (args[3].type === "begin") throw new Error("lost begin response");
    return result;
  };
  let ran = false;
  await assert.rejects(
    f.journal.mutate("answer", async () => {
      ran = true;
    }),
  );
  assert.equal(ran, false);
  await f.journal.stop();
  await assert.rejects(f.journal.finish(proof));
  assert.equal(f.dialog!.operations.answer, "pending");
});

test("unknown settlement response remains uncertain after a successful native mutation", async () => {
  const f = await fixture(),
    change = f.authority.journalChange;
  await f.journal.reserve();
  f.authority.journalChange = async (...args) => {
    const result = await change(...args);
    if (args[3].type === "settle") throw new Error("lost settlement response");
    return result;
  };
  let ran = false;
  await assert.rejects(
    f.journal.mutate("answer", async () => {
      ran = true;
    }),
  );
  assert.equal(ran, true);
  assert.equal(f.dialog!.operations.answer, "confirmed");
  await f.journal.stop();
  assert.equal(f.dialog!.uncertain, true);
  await assert.rejects(f.journal.finish(proof));
});

test("stop prevents a late begin acknowledgment from allocating resources", async () => {
  const f = await fixture(),
    change = f.authority.journalChange;
  await f.journal.reserve();
  let release!: () => void, began!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    began = resolve;
  });
  f.authority.journalChange = async (...args) => {
    const result = await change(...args);
    if (args[3].type === "begin") {
      began();
      await pending;
    }
    return result;
  };
  let ran = false;
  const mutation = f.journal.mutate("answer", async () => {
    ran = true;
  });
  const rejected = assert.rejects(mutation);
  await entered;
  const stopping = f.journal.stop();
  release();
  await rejected;
  await stopping;
  assert.equal(ran, false);
  assert.equal(f.dialog!.operations.answer, "rejected");
  await f.journal.finish(proof);
});

test("a response for a different owner is never used for cleanup", async () => {
  const f = await fixture();
  await f.journal.reserve();
  f.dialog!.ownerId = randomUUID();
  await assert.rejects(f.journal.stop());
  assert.equal(f.log.includes("stop"), false);
});

test("journal response rejects unbounded operations, wrong playback binding, and hidden extra fields", async () => {
  const f = await fixture();
  await f.journal.reserve();
  assert.equal(
    phoneDialogSchema.safeParse({ ...f.dialog, credential: "secret" }).success,
    false,
  );
  assert.equal(
    phoneDialogSchema.safeParse({
      ...f.dialog,
      operations: { arbitrary: "pending" },
    }).success,
    false,
  );
  assert.equal(
    phoneDialogSchema.safeParse({
      ...f.dialog,
      playbackId: `cm-play-${randomUUID()}-10`,
    }).success,
    false,
  );
});

test("a failed readiness refresh removes registry admission permission", async () => {
  const f = await fixture();
  await f.journal.reserve();
  await assert.rejects(f.registry.initialize());
  assert.throws(() =>
    f.registry.forCall(randomUUID(), "new-caller", "inbound", "trunk"),
  );
});
