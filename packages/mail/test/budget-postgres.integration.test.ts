import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import test from "node:test";
import pg from "pg";
import { createMailBudget } from "../src/budget.js";

const databaseUrl = process.env.MAIL_TEST_DATABASE_URL;
const signal = () => AbortSignal.timeout(10_000);

test(
  "shared mail budget serializes two pools, survives restart, and prunes the rolling day",
  { skip: !databaseUrl },
  async (t) => {
    const url = new URL(databaseUrl!);
    assert.ok(
      ["127.0.0.1", "localhost", "mail-postgres"].includes(url.hostname),
    );
    assert.equal(
      url.pathname,
      "/covemeet_mail_test",
      "Disposable mail database required",
    );
    const config = { production: false, mailDatabaseUrl: databaseUrl };
    const scope = {
      accountId: String(randomInt(100_000_000_000, 999_999_999_999)),
      region: "us-east-1",
    };
    const first = createMailBudget(config);
    const second = createMailBudget(config);
    const restarted = createMailBudget(config);
    const admin = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    t.after(async () => {
      await Promise.all([first.close(), second.close(), restarted.close()]);
      try {
        await admin.query(
          "DELETE FROM public.mail_send_budget WHERE account_id=$1",
          [scope.accountId],
        );
      } finally {
        await admin.end();
      }
    });
    const read = async () =>
      (
        await admin.query<{ attempts: string[] }>(
          "SELECT attempts FROM public.mail_send_budget WHERE account_id=$1 AND region=$2",
          [scope.accountId, scope.region],
        )
      ).rows[0]!.attempts.map(Number);
    const seed = async (count: number, age: string) => {
      await admin.query(
        `UPDATE public.mail_send_budget SET attempts=ARRAY(
      SELECT floor(extract(epoch FROM clock_timestamp() - $3::interval) * 1000)::bigint
      FROM generate_series(1, $4::integer)
    ) WHERE account_id=$1 AND region=$2`,
        [scope.accountId, scope.region, age, count],
      );
    };

    // Includes simultaneous schema bootstrap on a fresh disposable database.
    await Promise.all([
      first.reserve({ ...scope, signal: signal() }),
      second.reserve({ ...scope, signal: signal() }),
    ]);
    let attempts = await read();
    assert.equal(attempts.length, 2);
    assert.ok(
      attempts[1]! - attempts[0]! >= 1000,
      "All instances share permit spacing",
    );
    await first.close();
    await restarted.reserve({ ...scope, signal: signal() });
    attempts = await read();
    assert.equal(attempts.length, 3);
    assert.ok(
      attempts[2]! - attempts[1]! >= 1000,
      "Process restart retains the last permit",
    );

    // Waiting requests must abort without consuming another recipient allowance.
    await seed(3, "-3 seconds");
    await assert.rejects(
      second.reserve({ ...scope, signal: AbortSignal.timeout(50) }),
      (error: Error) => ["AbortError", "TimeoutError"].includes(error.name),
    );
    assert.equal((await read()).length, 3);
    await admin.query("BEGIN");
    try {
      await admin.query("SET LOCAL lock_timeout='200ms'");
      await admin.query(
        "SELECT 1 FROM public.mail_send_budget WHERE account_id=$1 AND region=$2 FOR UPDATE",
        [scope.accountId, scope.region],
      );
      await assert.rejects(
        second.reserve({ ...scope, signal: AbortSignal.timeout(50) }),
        (error: Error) => ["AbortError", "TimeoutError"].includes(error.name),
      );
    } finally {
      await admin.query("ROLLBACK");
    }
    assert.equal(
      (await read()).length,
      3,
      "Aborting a blocked DB claim consumes nothing",
    );

    // Each single-recipient attempt consumes capacity, including ambiguous sends.
    await seed(199, "2 seconds");
    const contenders = await Promise.allSettled([
      second.reserve({ ...scope, signal: signal() }),
      restarted.reserve({ ...scope, signal: signal() }),
    ]);
    assert.equal(
      contenders.filter((result) => result.status === "fulfilled").length,
      1,
    );
    const rejected = contenders.find((result) => result.status === "rejected");
    assert.equal(rejected?.status, "rejected");
    assert.match(
      (rejected as PromiseRejectedResult).reason.message,
      /daily budget exhausted/,
    );
    assert.equal((await read()).length, 200);
    await assert.rejects(
      second.reserve({ ...scope, signal: signal() }),
      /daily budget exhausted/,
    );

    // Scope is the SES account + region, not an individual portal user.
    await restarted.reserve({
      ...scope,
      region: "us-west-2",
      signal: signal(),
    });
    assert.equal((await read()).length, 200);

    // No reset or process-local timer: exact DB wall time prunes only expired rows.
    await seed(200, "24 hours 1 second");
    await second.reserve({ ...scope, signal: signal() });
    attempts = await read();
    assert.equal(attempts.length, 1);
    await seed(200, "23 hours 59 minutes");
    await assert.rejects(
      restarted.reserve({ ...scope, signal: signal() }),
      /daily budget exhausted/,
    );
  },
);
