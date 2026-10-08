import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { createMailBudget, MailBudgetExhausted } from "../src/budget.js";

const config = {
  production: false,
  mailDatabaseUrl: "postgresql://fixture:fixture@127.0.0.1/covemeet_mail_test",
};
const scope = { accountId: "123456789012", region: "us-east-1" };

test("budget validates TLS options without opening a database connection", async (t) => {
  t.mock.method(pg.Pool.prototype, "connect", () => {
    throw new Error("Must not connect");
  });
  for (const query of [
    "sslmode=disable",
    "sslmode=require",
    "ssl=false",
    "host=other",
    "options=-c%20statement_timeout=0",
  ]) {
    assert.throws(
      () =>
        createMailBudget({
          ...config,
          mailDatabaseUrl: `${config.mailDatabaseUrl}?${query}`,
        }),
      /may not override verified TLS/,
    );
  }
  assert.throws(
    () => createMailBudget({ production: false }),
    /Invalid mail database URL/,
  );
  const budget = createMailBudget({ ...config, production: true });
  await budget.close();
  await budget.close();
  await assert.rejects(
    budget.reserve({ ...scope, signal: new AbortController().signal }),
    /closed/,
  );
});

test("already aborted requests and invalid scopes never connect", async (t) => {
  t.mock.method(pg.Pool.prototype, "connect", () => {
    throw new Error("Must not connect");
  });
  const budget = createMailBudget(config);
  const controller = new AbortController();
  const reason = new Error("Synthetic operation deadline");
  controller.abort(reason);
  await assert.rejects(
    budget.reserve({ ...scope, signal: controller.signal }),
    reason,
  );
  for (const invalid of [
    { ...scope, accountId: "not-an-account" },
    { ...scope, region: "twilio-email" },
    { ...scope, accountId: `AC${"a".repeat(32)}` },
    { accountId: `AC${"a".repeat(31)}`, region: "twilio-email" },
    { accountId: `AC${"g".repeat(32)}`, region: "twilio-email" },
  ]) {
    await assert.rejects(
      budget.reserve({ ...invalid, signal: new AbortController().signal }),
      /Invalid mail budget/,
    );
  }
  await budget.close();
});

test("Twilio permits keep the shared ledger and canonicalize account casing", async (t) => {
  const statements: string[] = [];
  const scopes: unknown[][] = [];
  let attempts = ["95000"],
    now = 100000;
  const client = {
    async query(sql: string, values?: unknown[]) {
      statements.push(sql);
      if (sql.startsWith("SELECT attempts")) {
        scopes.push(values!);
        return { rows: [{ attempts }] };
      }
      if (sql.includes("clock_timestamp()"))
        return { rows: [{ now_ms: String(now) }] };
      if (sql.startsWith("UPDATE public.mail_send_budget"))
        attempts = (values![2] as number[]).map(String);
      return { rows: [] };
    },
    release() {},
  } as unknown as pg.PoolClient;
  t.mock.method(pg.Pool.prototype, "connect", async () => client);
  t.mock.method(pg.Pool.prototype, "end", async () => {});
  const budget = createMailBudget(config);
  try {
    for (const hex of ["AB".repeat(16), "ab".repeat(16)]) {
      await budget.reserve({
        accountId: `AC${hex}`,
        region: "twilio-email",
        signal: new AbortController().signal,
      });
      now += 1000;
    }
    assert.deepEqual(attempts, ["95000", "100000", "101000"]);
    assert.deepEqual(
      scopes,
      Array(2).fill([`AC${"ab".repeat(16)}`, "twilio-email"]),
    );
    const lock = statements.findIndex((sql) =>
      sql.includes("pg_advisory_xact_lock"),
    );
    const migration = statements.findIndex((sql) =>
      sql.includes(
        "DROP CONSTRAINT IF EXISTS mail_send_budget_account_id_check",
      ),
    );
    assert(lock >= 0 && migration > lock);
    assert(statements[migration]!.includes("region='twilio-email'"));
    assert.equal(statements.filter((sql) => sql.startsWith("DO $$")).length, 1);
    assert.equal(
      statements.some((sql) => /TRUNCATE|DROP TABLE|DELETE FROM/.test(sql)),
      false,
    );
  } finally {
    await budget.close();
  }
});

test("invitations stop at 150 shared recipients while transactional mail can use the final 50", async (t) => {
  const now = 100_000_000;
  let attempts = Array.from({ length: 149 }, (_, i) =>
    String(now - (149 - i) * 1000),
  );
  let updates = 0;
  const client = {
    async query(sql: string, values?: unknown[]) {
      if (sql.startsWith("SELECT attempts")) return { rows: [{ attempts }] };
      if (sql.includes("clock_timestamp()"))
        return { rows: [{ now_ms: String(now) }] };
      if (sql.startsWith("UPDATE public.mail_send_budget")) {
        attempts = (values![2] as number[]).map(String);
        updates++;
      }
      return { rows: [] };
    },
    release() {},
  } as unknown as pg.PoolClient;
  t.mock.method(pg.Pool.prototype, "connect", async () => client);
  t.mock.method(pg.Pool.prototype, "end", async () => {});
  const budget = createMailBudget(config);
  const signal = new AbortController().signal;
  try {
    await budget.reserve({ ...scope, deliveryClass: "invitation", signal });
    assert.equal(attempts.length, 150);
    await assert.rejects(
      budget.reserve({ ...scope, deliveryClass: "invitation", signal }),
      MailBudgetExhausted,
    );
    assert.equal(updates, 1, "a rejected invitation cannot consume a permit");
    // Move the last permit outside the one-second pacing interval.
    attempts[149] = String(now - 1000);
    await budget.reserve({ ...scope, signal });
    assert.equal(attempts.length, 151);
    attempts = Array.from({ length: 200 }, (_, i) =>
      String(now - (200 - i) * 1000),
    );
    await assert.rejects(budget.reserve({ ...scope, signal }), MailBudgetExhausted);
    assert.equal(updates, 2);
    attempts = Array(200).fill(String(now - 24 * 60 * 60 * 1000 - 1));
    await budget.reserve({ ...scope, deliveryClass: "invitation", signal });
    assert.equal(attempts.length, 1, "expired permits restore invitation capacity");
  } finally {
    await budget.close();
  }
});

test("abort while acquiring a connection releases its eventual client without starting a transaction", async (t) => {
  let acquired!: (client: pg.PoolClient) => void;
  let releaseCount = 0;
  const pending = new Promise<pg.PoolClient>((resolve) => {
    acquired = resolve;
  });
  t.mock.method(pg.Pool.prototype, "connect", () => pending);
  t.mock.method(pg.Pool.prototype, "end", async () => {});
  const budget = createMailBudget(config);
  const controller = new AbortController();
  const attempt = budget.reserve({ ...scope, signal: controller.signal });
  const rejection = assert.rejects(attempt, /Synthetic deadline/);
  controller.abort(new Error("Synthetic deadline"));
  await rejection;
  acquired({
    release(destroy: boolean) {
      assert.equal(destroy, true);
      releaseCount++;
    },
    query() {
      throw new Error("An aborted request must not query");
    },
  } as unknown as pg.PoolClient);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(releaseCount, 1);
  await budget.close();
});

test("permit wait releases the transaction and client, then aborts without another claim", async (t) => {
  let connects = 0;
  let released = false;
  let transaction = false;
  let claimed = false;
  let waitEntered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    waitEntered = resolve;
  });
  const client = {
    async query(sql: string) {
      if (sql === "BEGIN") transaction = true;
      if (sql === "COMMIT" || sql === "ROLLBACK") transaction = false;
      if (sql.startsWith("SELECT attempts"))
        return { rows: [{ attempts: ["100000"] }] };
      if (sql.includes("clock_timestamp()"))
        return { rows: [{ now_ms: "100000" }] };
      if (sql.startsWith("UPDATE public.mail_send_budget")) claimed = true;
      return { rows: [] };
    },
    release() {
      released = true;
      assert.equal(transaction, false);
      waitEntered();
    },
  } as unknown as pg.PoolClient;
  t.mock.method(pg.Pool.prototype, "connect", async () => {
    connects++;
    return client;
  });
  t.mock.method(pg.Pool.prototype, "end", async () => {});
  const budget = createMailBudget(config);
  const controller = new AbortController();
  const attempt = budget.reserve({ ...scope, signal: controller.signal });
  const rejection = assert.rejects(attempt, { name: "AbortError" });
  await waiting;
  assert.equal(released, true);
  assert.equal(claimed, false);
  controller.abort();
  await rejection;
  assert.equal(connects, 1);
  await budget.close();
});

test("production uses verified TLS and driver errors do not expose connection secrets", async (t) => {
  let ssl: unknown;
  t.mock.method(pg.Pool.prototype, "connect", function (this: pg.Pool) {
    ssl = this.options.ssl;
    throw new Error("database password=private-fixture-marker");
  });
  t.mock.method(pg.Pool.prototype, "end", async () => {});
  const budget = createMailBudget({ ...config, production: true });
  await assert.rejects(
    budget.reserve({ ...scope, signal: new AbortController().signal }),
    (error: Error) => {
      assert.equal(error.message, "Mail budget unavailable");
      assert.equal(error.message.includes("private-fixture-marker"), false);
      return true;
    },
  );
  assert.deepEqual(ssl, { rejectUnauthorized: true, minVersion: "TLSv1.2" });
  await budget.close();
});
