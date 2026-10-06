import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { PgStore, type Meeting } from "../src/store.js";

const databaseUrl = process.env.PHONE_TEST_DATABASE_URL;

test(
  "PostgreSQL replays whiteboard edits across stores, compacts policy, and purges ended meetings",
  { skip: !databaseUrl, timeout: 30000 },
  async (t) => {
    const url = new URL(databaseUrl!);
    assert.ok(
      ["127.0.0.1", "localhost", "phone-postgres"].includes(url.hostname),
    );
    assert.equal(
      url.pathname,
      "/covemeet_phone_test",
      "Disposable database required",
    );
    const stores = [new PgStore(databaseUrl!), new PgStore(databaseUrl!)];
    const code = `WB${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    t.after(async () => {
      try {
        await stores[0]!.pool.query(
          "DELETE FROM whiteboard_events WHERE meeting_code=$1",
          [code],
        );
        await stores[0]!.pool.query(
          "DELETE FROM whiteboards WHERE meeting_code=$1",
          [code],
        );
        await stores[0]!.pool.query("DELETE FROM meetings WHERE code=$1", [
          code,
        ]);
      } finally {
        await Promise.all(stores.map((store) => store.close()));
      }
    });
    for (const store of stores) await store.init();
    const meeting: Meeting = {
      id: randomUUID(),
      code,
      room: `whiteboard-${code}`,
      title: "Whiteboard fixture",
      mode: "meeting",
      locked: false,
      ended: false,
      recordingAllowed: false,
      createdAt: Date.now(),
      revision: 0,
      passwordHash: "fixture",
      hostTokenExpiresAt: 0,
      participants: [],
      bans: { ip: [], device: [] },
      breakouts: [],
      messages: [],
      recordings: [],
    };
    await stores[0]!.create(meeting);
    const host = () => ({ scope: "", authorId: "host", host: true });
    const guest = () => ({ scope: "", authorId: "guest", host: false });
    const side = () => ({ scope: "side-room", authorId: "host", host: true });
    const stroke = {
      kind: "stroke" as const,
      epoch: 0,
      id: randomUUID(),
      points: [
        [0, 0],
        [10, 15],
      ] as [number, number][],
    };
    const first = await stores[0]!.writeWhiteboard(code, stroke, host);
    assert.equal(first.seq, 1);
    assert.deepEqual((await stores[1]!.readWhiteboard(code, 0, host)).events, [
      first,
    ]);
    await assert.rejects(
      stores[1]!.writeWhiteboard(code, { kind: "clear", epoch: 0 }, guest),
      { status: 403 },
    );
    for (const readOnly of [true, false, true])
      await stores[0]!.writeWhiteboard(
        code,
        { kind: "policy", epoch: 0, readOnly },
        host,
      );
    const policy = await stores[1]!.readWhiteboard(code, 1, host);
    assert.equal(policy.cursor, 4);
    assert.equal(policy.readOnly, true);
    assert.deepEqual(policy.events, []);
    assert.equal(
      Number(
        (
          await stores[1]!.pool.query(
            "SELECT count(*) AS count FROM whiteboard_events WHERE meeting_code=$1",
            [code],
          )
        ).rows[0].count,
      ),
      1,
    );
    await assert.rejects(
      stores[1]!.writeWhiteboard(
        code,
        { kind: "text", epoch: 0, id: randomUUID(), x: 1, y: 2, text: "no" },
        guest,
      ),
      { status: 403 },
    );
    const clear = await stores[0]!.writeWhiteboard(
      code,
      { kind: "clear", epoch: 0 },
      host,
    );
    assert.equal(clear.seq, 5);
    assert.equal(clear.epoch, 1);
    assert.deepEqual((await stores[1]!.readWhiteboard(code, 0, host)).events, [
      clear,
    ]);
    await assert.rejects(stores[1]!.writeWhiteboard(code, stroke, host), {
      status: 409,
    });
    const text = await stores[0]!.writeWhiteboard(
      code,
      { kind: "text", epoch: 1, id: randomUUID(), x: -7, y: 3, text: "yes" },
      host,
    );
    assert.deepEqual((await stores[1]!.readWhiteboard(code, 5, host)).events, [
      text,
    ]);
    assert.deepEqual(
      (await stores[1]!.readWhiteboard(code, 0, side)).events,
      [],
    );
    await stores[0]!.change(code, (current) => {
      current.ended = true;
    });
    await stores[1]!.purgeWhiteboard(code);
    assert.deepEqual(
      (await stores[0]!.readWhiteboard(code, 0, host)).events,
      [],
    );
    assert.equal(
      Number(
        (
          await stores[0]!.pool.query(
            "SELECT count(*) AS count FROM whiteboards WHERE meeting_code=$1",
            [code],
          )
        ).rows[0].count,
      ),
      0,
    );
  },
);
