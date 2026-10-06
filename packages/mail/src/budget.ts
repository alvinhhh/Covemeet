import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import type { MailConfig } from "./config.js";
import type { MailBudget } from "./transport.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DAILY_RECIPIENTS = 200;
const PERMIT_INTERVAL_MS = 1000;

class DailyBudgetExhausted extends Error {
  constructor() {
    super("Mail daily budget exhausted");
  }
}

function poolOptions(
  config: Pick<
    MailConfig,
    "production" | "mailDatabaseUrl" | "mailDatabaseCaFile"
  >,
): pg.PoolConfig {
  let url: URL;
  try {
    url = new URL(config.mailDatabaseUrl ?? "");
  } catch {
    throw new Error("Invalid mail database URL");
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !url.hostname ||
    url.pathname.length < 2
  )
    throw new Error("Invalid mail database URL");
  if (
    [...url.searchParams].some(
      ([name, value]) => name !== "sslmode" || value !== "verify-full",
    )
  )
    throw new Error("Mail database URL options may not override verified TLS");
  let ca: string | undefined;
  if (config.mailDatabaseCaFile) {
    try {
      ca = readFileSync(config.mailDatabaseCaFile, "utf8");
      if (!ca.trim()) throw new Error();
    } catch {
      throw new Error("Mail database CA could not be read");
    }
  }
  const tls =
    config.production || Boolean(ca) || url.searchParams.has("sslmode");
  // pg otherwise lets connection-string SSL parameters replace this TLS object.
  url.search = "";
  return {
    connectionString: url.toString(),
    ssl: tls
      ? { rejectUnauthorized: true, minVersion: "TLSv1.2" as const, ...(ca ? { ca } : {}) }
      : false,
    max: 2,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    idle_in_transaction_session_timeout: 5000,
  };
}

// Aborting a queued connection must release any client it acquires later. Once
// connected, abort destroys the session, rolling back any uncommitted claim.
function connect(pool: pg.Pool, signal: AbortSignal): Promise<pg.PoolClient> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    let pending: Promise<pg.PoolClient>;
    try {
      pending = pool.connect();
    } catch (error) {
      signal.removeEventListener("abort", abort);
      reject(error);
      return;
    }
    pending.then(
      (client) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) {
          client.release(true);
          reject(signal.reason);
        } else resolve(client);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/**
 * Shared conservative SES sandbox budget. Both applications must use the same
 * database. Permits are spaced; process/network delays can still bunch arrivals
 * at SES. Consume immediately before dispatch and never refund an uncertain send.
 */
export function createMailBudget(
  config: Pick<
    MailConfig,
    "production" | "mailDatabaseUrl" | "mailDatabaseCaFile"
  >,
): MailBudget {
  const options = poolOptions(config);
  const closing = new AbortController();
  let pool: pg.Pool | undefined;
  let initialized = false;
  let closePromise: Promise<void> | undefined;

  async function attempt(
    accountId: string,
    region: string,
    signal: AbortSignal,
  ): Promise<number> {
    signal.throwIfAborted();
    if (!pool) {
      pool = new pg.Pool(options);
      // Driver errors may contain connection details. Callers receive only the
      // sanitized failure below; idle connection failures must not crash Node.
      pool.on("error", () => {});
    }
    const client = await connect(pool, signal);
    let released = false;
    let transaction = false;
    const release = (destroy = false) => {
      if (!released) {
        released = true;
        client.release(destroy);
      }
    };
    const abort = () => release(true);
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      if (!initialized) {
        await client.query("BEGIN");
        transaction = true;
        // CREATE TABLE IF NOT EXISTS alone can race on the first two processes.
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('meeting-platform:mail-budget-schema', 0))",
        );
        await client.query(`CREATE TABLE IF NOT EXISTS public.mail_send_budget (
          account_id text NOT NULL CHECK (account_id ~ '^[0-9]{12}$'),
          region text NOT NULL CHECK (region ~ '^[a-z]{2}-[a-z]+-[0-9]$'),
          attempts bigint[] NOT NULL DEFAULT '{}',
          PRIMARY KEY (account_id, region),
          CHECK (cardinality(attempts) <= 200 AND array_position(attempts, NULL) IS NULL)
        )`);
        signal.throwIfAborted();
        await client.query("COMMIT");
        transaction = false;
        initialized = true;
      }
      signal.throwIfAborted();
      await client.query("BEGIN");
      transaction = true;
      await client.query(
        "INSERT INTO public.mail_send_budget(account_id, region) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [accountId, region],
      );
      const row = (
        await client.query<{ attempts: string[] }>(
          "SELECT attempts FROM public.mail_send_budget WHERE account_id=$1 AND region=$2 FOR UPDATE",
          [accountId, region],
        )
      ).rows[0];
      // Read wall time AFTER acquiring the row lock, not transaction start time.
      const clock = (
        await client.query<{ now_ms: string }>(
          "SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::text AS now_ms",
        )
      ).rows[0];
      const now = Number(clock?.now_ms);
      if (
        !Number.isSafeInteger(now) ||
        now <= 0 ||
        !row ||
        !Array.isArray(row.attempts)
      )
        throw new Error("Invalid mail budget state");
      if (
        row.attempts.some(
          (value) => typeof value !== "string" || !/^\d+$/.test(value),
        )
      )
        throw new Error("Invalid mail budget state");
      const attempts = row.attempts.map((value) => Number(value));
      if (
        attempts.length > DAILY_RECIPIENTS ||
        attempts.some(
          (value, i) =>
            !Number.isSafeInteger(value) ||
            value <= 0 ||
            (i > 0 && value < attempts[i - 1]!),
        )
      )
        throw new Error("Invalid mail budget state");
      const recent = attempts.filter((time) => time > now - DAY_MS);
      if (recent.length >= DAILY_RECIPIENTS) throw new DailyBudgetExhausted();
      const wait = Math.max(0, (recent.at(-1) ?? 0) + PERMIT_INTERVAL_MS - now);
      if (wait === 0) {
        signal.throwIfAborted();
        await client.query(
          "UPDATE public.mail_send_budget SET attempts=$3::bigint[] WHERE account_id=$1 AND region=$2",
          [accountId, region, [...recent, now]],
        );
      }
      signal.throwIfAborted();
      await client.query("COMMIT");
      transaction = false;
      // An abort racing COMMIT may consume a permit; it must never allow a send.
      signal.throwIfAborted();
      return wait;
    } catch (error) {
      if (transaction && !released) {
        try {
          await client.query("ROLLBACK");
        } catch {
          release(true);
        }
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", abort);
      release(signal.aborted);
    }
  }

  return {
    async reserve(input) {
      const signal = AbortSignal.any([input.signal, closing.signal]);
      signal.throwIfAborted();
      if (
        !/^\d{12}$/.test(input.accountId) ||
        !/^[a-z]{2}-[a-z]+-\d$/.test(input.region)
      )
        throw new Error("Invalid mail budget account or region");
      for (;;) {
        let wait: number;
        try {
          wait = await attempt(input.accountId, input.region, signal);
        } catch (error) {
          signal.throwIfAborted();
          if (error instanceof DailyBudgetExhausted) throw error;
          throw new Error("Mail budget unavailable");
        }
        if (wait === 0) return;
        // Never hold a transaction or pooled connection while awaiting a permit.
        await delay(Math.min(wait, DAY_MS), undefined, { signal });
      }
    },
    close() {
      closing.abort(new Error("Mail budget closed"));
      return (closePromise ??= pool?.end() ?? Promise.resolve());
    },
  };
}
