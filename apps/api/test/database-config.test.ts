import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { PgStore } from "../src/store.js";

const env = {
  SESSION_SECRET: "database-config-fixture-secret-over-32-characters",
  SITE_ORIGIN: "https://meet.example.test",
};
const url = "postgresql://fixture:fixture@localhost/covemeet_database_test";

test("production database options require verified TLS; development remains plaintext", async () => {
  const production = loadConfig({
    ...env,
    NODE_ENV: "production",
    DATABASE_URL: url,
  });
  const store = new PgStore(production.databaseUrl, {
    tls: production.production,
    ca: production.databaseCa,
  });
  try {
    assert.deepEqual(store.pool.options.ssl, {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
    assert.equal(store.pool.options.connectionString, url);
    assert.equal(store.pool.options.connectionTimeoutMillis, 5000);
    assert.equal(store.pool.options.statement_timeout, undefined);
  } finally {
    await store.close();
  }
  const development = loadConfig({ ...env, NODE_ENV: "development" });
  const local = new PgStore(development.databaseUrl, {
    tls: development.production,
    ca: development.databaseCa,
  });
  try {
    assert.equal(local.pool.options.ssl, false);
    // The existing local default is retained; production still applies TLS to it.
    assert.equal(
      loadConfig({ ...env, NODE_ENV: "production" }).databaseUrl,
      development.databaseUrl,
    );
  } finally {
    await local.close();
  }
});

test("database URL cannot replace certificate verification or its CA settings", async () => {
  for (const options of [
    "sslmode=disable",
    "sslmode=allow",
    "sslmode=prefer",
    "sslmode=require",
    "sslmode=verify-ca",
    "sslmode=no-verify",
    "ssl=false",
    "ssl=true",
    "sslrootcert=/tmp/other-ca",
    "sslcert=/tmp/other-cert",
    "sslkey=/tmp/other-key",
    "sslmode=verify-full&sslmode=no-verify",
    "uselibpqcompat=true",
  ]) {
    assert.throws(
      () => new PgStore(`${url}?${options}`, { tls: true }),
      /may not override verified TLS/,
    );
  }
  const store = new PgStore(`${url}?sslmode=verify-full`, {
    ca: "fixture-private-ca",
  });
  try {
    assert.deepEqual(store.pool.options.ssl, {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ca: "fixture-private-ca",
    });
    assert.equal(store.pool.options.connectionString, url);
  } finally {
    await store.close();
  }
  const explicit = new PgStore(`${url}?sslmode=verify-full`);
  try {
    assert.deepEqual(explicit.pool.options.ssl, {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
    });
  } finally {
    await explicit.close();
  }
});

test("configured CA files fail closed on missing or empty files and enable verified TLS", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "covemeet-database-ca-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "fixture-ca.pem");
  assert.throws(
    () => loadConfig({ ...env, DATABASE_CA_FILE: file }),
    /DATABASE_CA_FILE could not be read or is empty/,
  );
  assert.throws(
    () => loadConfig({ ...env, DATABASE_CA_FILE: directory }),
    /DATABASE_CA_FILE could not be read or is empty/,
  );
  await writeFile(file, " \n", { mode: 0o600 });
  assert.throws(
    () => loadConfig({ ...env, DATABASE_CA_FILE: file }),
    /DATABASE_CA_FILE could not be read or is empty/,
  );
  await writeFile(file, "fixture-private-ca", { mode: 0o600 });
  const config = loadConfig({ ...env, DATABASE_CA_FILE: file });
  const store = new PgStore(url, { ca: config.databaseCa });
  try {
    assert.deepEqual(store.pool.options.ssl, {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ca: "fixture-private-ca",
    });
  } finally {
    await store.close();
  }
  assert.throws(
    () => new PgStore(url, { tls: true, ca: "\n" }),
    /CA must not be empty/,
  );
});

test("invalid database URLs fail without exposing credentials", () => {
  for (const input of [
    "invalid private-password-marker",
    "http://fixture:private-password-marker@localhost/db",
    "postgresql:///db",
  ]) {
    assert.throws(
      () => new PgStore(input),
      (error: Error) => {
        assert.equal(error.message, "Invalid database URL");
        assert.equal(error.message.includes("private-password-marker"), false);
        return true;
      },
    );
  }
});
