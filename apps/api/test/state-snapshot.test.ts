import assert from "node:assert/strict";
import test from "node:test";
import { PgStore, type Meeting } from "../src/store.js";

function meeting(): Meeting {
  return {
    id: "state-cache",
    code: "STATECACHE",
    room: "state-cache-room",
    title: "State cache",
    mode: "meeting",
    locked: false,
    ended: false,
    recordingAllowed: false,
    createdAt: Date.now(),
    revision: 1,
    passwordHash: "unused",
    hostTokenExpiresAt: 0,
    bans: { ip: [], device: [] },
    breakouts: [],
    messages: [],
    recordings: [],
    participants: [
      {
        id: "viewer",
        name: "Viewer",
        role: "participant",
        status: "admitted",
        audioAllowed: true,
        videoAllowed: true,
        mediaVersion: 1,
        tokenHash: "session-hash",
        expiresAt: Date.now() + 60_000,
        ipHash: "",
        deviceHash: "",
        breakoutId: null,
      },
    ],
  };
}

function database() {
  const store = new PgStore("postgres://meeting:meeting@127.0.0.1/meeting");
  const row = { data: meeting(), version: 1, present: true };
  const reads = { version: 0, full: 0 };
  store.pool = {
    async query(sql: string) {
      if (!sql.includes("FROM meetings WHERE code=$1"))
        throw new Error("Unexpected query");
      if (sql.startsWith("SELECT data,")) {
        reads.full++;
        // Match pg's JSONB parser: each full read returns a new object.
        await new Promise<void>((resolve) => setImmediate(resolve));
        return {
          rows: row.present
            ? [{
                data: structuredClone(row.data),
                version: String(row.version),
                location: `(0,${row.version})`,
              }]
            : [],
        };
      }
      if (sql.startsWith("SELECT xmin::text")) {
        reads.version++;
        return {
          rows: row.present
            ? [{ version: String(row.version), location: `(0,${row.version})` }]
            : [],
        };
      }
      throw new Error("Unexpected query");
    },
    async end() {},
  } as unknown as PgStore["pool"];
  return { store, row, reads };
}

test("state polls check the row version and share one immutable full read", async () => {
  const { store, row, reads } = database();
  const first = await store.getState(row.data.code, "session-hash");
  assert.ok(first);
  const later = await Promise.all(
    Array.from({ length: 20 }, () => store.getState(row.data.code, "session-hash")),
  );
  assert.equal(reads.version, 21);
  assert.equal(reads.full, 1);
  assert.ok(later.every((state) => state?.meeting === first.meeting));
  assert.deepEqual(first.candidates.map((p) => p.id), ["viewer"]);
  assert.ok(Object.isFrozen(first.meeting.participants[0]));
  assert.throws(() => {
    first.meeting.participants[0]!.status = "kicked";
  }, TypeError);
  assert.equal(row.data.participants[0]!.status, "admitted");
});

test("concurrent cache misses coalesce for one observed row version", async () => {
  const { store, row, reads } = database();
  const states = await Promise.all(
    Array.from({ length: 20 }, () => store.getState(row.data.code, "session-hash")),
  );
  assert.equal(reads.version, 20);
  assert.equal(reads.full, 1);
  assert.ok(states.every((state) => state?.meeting === states[0]?.meeting));
});

test("a newer row version does not wait for an older full read", async () => {
  const store = new PgStore("postgres://meeting:meeting@127.0.0.1/meeting");
  const row = { data: meeting(), version: 1 };
  let releaseOld!: () => void;
  let oldReadStarted!: () => void;
  const oldReadGate = new Promise<void>((resolve) => (releaseOld = resolve));
  const oldStarted = new Promise<void>((resolve) => (oldReadStarted = resolve));
  store.pool = {
    async query(sql: string) {
      if (sql.startsWith("SELECT xmin::text"))
        return {
          rows: [{ version: String(row.version), location: `(0,${row.version})` }],
        };
      if (!sql.startsWith("SELECT data,")) throw new Error("Unexpected query");
      const selected = {
        data: structuredClone(row.data),
        version: String(row.version),
        location: `(0,${row.version})`,
      };
      if (row.version === 1) {
        oldReadStarted();
        await oldReadGate;
      }
      return { rows: [selected] };
    },
    async end() {},
  } as unknown as PgStore["pool"];

  const oldRequest = store.getState(row.data.code, "session-hash");
  await oldStarted;
  row.version = 2;
  row.data.participants[0]!.status = "kicked";
  let timeout!: ReturnType<typeof setTimeout>;
  try {
    const fresh = await Promise.race([
      store.getState(row.data.code, "session-hash"),
      new Promise<never>((_, reject) =>
        (timeout = setTimeout(
          () => reject(new Error("New version joined the old read")),
          1000,
        )),
      ),
    ]);
    assert.equal(fresh?.candidates[0]?.status, "kicked");
  } finally {
    clearTimeout(timeout);
    releaseOld();
  }
  assert.equal((await oldRequest)?.candidates[0]?.status, "admitted");
  assert.equal(
    (await store.getState(row.data.code, "session-hash"))?.candidates[0]?.status,
    "kicked",
  );
});

test("direct moderation updates and deletion invalidate state without a meeting revision bump", async () => {
  const { store, row, reads } = database();
  const initial = await store.getState(row.data.code, "session-hash");
  assert.equal(initial?.candidates[0]?.status, "admitted");

  row.data.participants[0]!.status = "kicked";
  row.version++;
  const kicked = await store.getState(row.data.code, "session-hash");
  assert.equal(kicked?.candidates[0]?.status, "kicked");
  assert.equal(kicked?.meeting.revision, 1);
  assert.equal(initial?.candidates[0]?.status, "admitted");

  row.data.participants[0]!.status = "banned";
  row.data.bans.device.push("device-hash");
  row.version++;
  const banned = await store.getState(row.data.code, "session-hash");
  assert.equal(banned?.candidates[0]?.status, "banned");
  assert.deepEqual(banned?.meeting.bans.device, ["device-hash"]);
  assert.equal(reads.full, 3);

  row.present = false;
  assert.equal(await store.getState(row.data.code, "session-hash"), null);
  row.present = true;
  row.version++;
  row.data.participants[0]!.tokenHash = "new-session";
  const replacement = await store.getState(row.data.code, "session-hash");
  assert.deepEqual(replacement?.candidates, []);
  assert.equal((await store.getState(row.data.code, "new-session"))?.candidates[0]?.id, "viewer");
  assert.equal(reads.full, 4);
});

test("token buckets preserve candidate order when hashes are duplicated", async () => {
  const { store, row } = database();
  const expired = row.data.participants[0]!;
  expired.expiresAt = Date.now() - 1;
  row.data.participants.push({
    ...structuredClone(expired),
    id: "current",
    expiresAt: Date.now() + 60_000,
  });
  const state = await store.getState(row.data.code, "session-hash");
  assert.deepEqual(state?.candidates.map((p) => p.id), ["viewer", "current"]);
});
