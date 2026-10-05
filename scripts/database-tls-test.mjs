import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  mkdtemp,
  readFile,
  writeFile,
  mkdir,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";

// Disposable loopback PostgreSQL only. Never uses the installation's DB or CA.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const id = randomUUID();
const label = "io.covemeet.database-tls-fixture";
const image = "postgres:17.11-alpine3.23";
const password = randomBytes(24).toString("hex");
process.umask(0o077);
const fixture = await mkdtemp(resolve(tmpdir(), "covemeet-db-tls-"));
const report = {
  startedAt: new Date().toISOString(),
  checks: [],
  cleanup: false,
  passed: false,
};
let containerName;
let phase = "certificates";

async function command(bin, args, options = {}) {
  return (
    await run(bin, args, {
      cwd: root,
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      ...options,
    })
  ).stdout.trim();
}
async function openssl(args) {
  return command("openssl", args, { cwd: fixture });
}
async function docker(args) {
  return command("docker", args);
}
async function removeContainer() {
  if (!containerName) return;
  const found = await docker([
    "ps",
    "-aq",
    "--filter",
    `name=^/${containerName}$`,
  ]);
  if (found) {
    const info = JSON.parse(
      await docker(["inspect", "--format", "{{json .}}", found]),
    );
    assert.equal(info.Config.Labels[label], id);
    assert.equal(info.Name, `/${containerName}`);
    await docker(["rm", "--force", "--volumes", info.Id]);
  }
  containerName = undefined;
}
async function database(mode) {
  await removeContainer();
  containerName = `covemeet-db-tls-${id}-${mode}`;
  const args = [
    "run",
    "--detach",
    "--name",
    containerName,
    "--label",
    `${label}=${id}`,
    "--publish",
    "127.0.0.1::5432",
    "--memory",
    "256m",
    "--cpus",
    "1",
    "--pids-limit",
    "128",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,nosuid,size=128m",
    "--env",
    "POSTGRES_USER=tls_test",
    "--env",
    "POSTGRES_DB=covemeet_tls_test",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
  ];
  if (mode === "plain") args.push(image, "postgres", "-c", "ssl=off");
  else {
    const cert = mode === "hostname" ? "wrong" : "server";
    for (const [from, to] of [
      [`${cert}.crt`, "server.crt"],
      [`${cert}.key`, "server.key"],
      ["pg_hba.conf", "pg_hba.conf"],
    ])
      args.push(
        "--mount",
        `type=bind,source=${resolve(fixture, from)},target=/input/${to},readonly`,
      );
    args.push(
      "--entrypoint",
      "sh",
      image,
      "-c",
      "cp /input/server.key /tmp/server.key && chown postgres:postgres /tmp/server.key && chmod 600 /tmp/server.key && exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/input/server.crt -c ssl_key_file=/tmp/server.key -c ssl_min_protocol_version=TLSv1.2 -c hba_file=/input/pg_hba.conf",
    );
  }
  await docker(args);
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      await docker([
        "exec",
        containerName,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "tls_test",
        "-d",
        "covemeet_tls_test",
      ]);
      ready = true;
      break;
    } catch {
      await delay(500);
    }
  }
  assert(ready, "fixture database did not become ready");
  const info = JSON.parse(
    await docker(["inspect", "--format", "{{json .}}", containerName]),
  );
  assert.equal(info.Config.Labels[label], id);
  const ports = info.NetworkSettings.Ports["5432/tcp"];
  assert.equal(ports.length, 1);
  assert.equal(ports[0].HostIp, "127.0.0.1");
  report.image = info.Image;
  return `postgres://tls_test:${password}@127.0.0.1:${ports[0].HostPort}/covemeet_tls_test`;
}
async function probe(url, mode) {
  const result = await command(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      String.raw`
    import assert from 'node:assert/strict';
    import { readFileSync } from 'node:fs';
    import { PgStore } from './apps/api/src/store.ts';
    const mode=process.env.FIXTURE_MODE;
    const ca=readFileSync(process.env.FIXTURE_CA,'utf8');
    const store=new PgStore(process.env.FIXTURE_URL, mode==='plaintext-client'?{}:{tls:true,...(mode==='untrusted'?{}:{ca})});
    try {
      if(mode==='valid') {
        await store.init();
        const row=(await store.pool.query('SELECT ssl,version FROM pg_stat_ssl WHERE pid=pg_backend_pid()')).rows[0];
        assert.equal(row.ssl,true); assert(['TLSv1.2','TLSv1.3'].includes(row.version));
        console.log(JSON.stringify({mode,passed:true,protocol:row.version}));
      } else {
        let failure;try{await store.pool.query('SELECT 1')}catch(e){failure=e}
        assert(failure,'connection unexpectedly succeeded');
        if(mode==='hostname')assert.equal(failure.code,'ERR_TLS_CERT_ALTNAME_INVALID');
        if(mode==='untrusted')assert(['SELF_SIGNED_CERT_IN_CHAIN','UNABLE_TO_VERIFY_LEAF_SIGNATURE','UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(failure.code));
        if(mode==='plaintext-client')assert.equal(failure.code,'28000');
        if(mode==='plain')assert.match(failure.message,/does not support SSL/);
        console.log(JSON.stringify({mode,passed:true}));
      }
    } finally {await store.close()}
  `,
    ],
    {
      env: {
        ...process.env,
        FIXTURE_URL: url,
        FIXTURE_CA: resolve(fixture, "ca.crt"),
        FIXTURE_MODE: mode,
      },
    },
  );
  const evidence = JSON.parse(result);
  assert.equal(evidence.passed, true);
  report.checks.push(evidence);
}
try {
  await writeFile(
    resolve(fixture, "ca.conf"),
    "[req]\ndistinguished_name=dn\nx509_extensions=ca\n[dn]\n[ca]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\n",
  );
  await openssl([
    "req",
    "-new",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "2",
    "-subj",
    "/CN=Covemeet disposable DB test CA",
    "-config",
    "ca.conf",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
  ]);
  for (const name of ["server", "wrong"]) {
    await openssl([
      "req",
      "-new",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-subj",
      `/CN=${name}`,
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.csr`,
    ]);
    await writeFile(
      resolve(fixture, `${name}.ext`),
      `basicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=${name === "server" ? "IP:127.0.0.1,DNS:postgres" : "DNS:wrong.invalid"}\n`,
    );
    await openssl([
      "x509",
      "-req",
      "-in",
      `${name}.csr`,
      "-CA",
      "ca.crt",
      "-CAkey",
      "ca.key",
      "-CAcreateserial",
      "-days",
      "2",
      "-extfile",
      `${name}.ext`,
      "-out",
      `${name}.crt`,
    ]);
    await chmod(resolve(fixture, `${name}.crt`), 0o444);
  }
  await writeFile(
    resolve(fixture, "pg_hba.conf"),
    await readFile(resolve(root, "infra/postgres.production.hba")),
  );
  await chmod(resolve(fixture, "pg_hba.conf"), 0o444);
  phase = "verified-tls";
  let url = await database("valid");
  await probe(url, "valid");
  await probe(url, "untrusted");
  await probe(url, "plaintext-client");
  phase = "hostname-rejection";
  url = await database("hostname");
  await probe(url, "hostname");
  phase = "no-tls-rejection";
  url = await database("plain");
  await probe(url, "plain");
  report.passed = true;
} catch {
  report.failure = phase;
  process.exitCode = 1;
} finally {
  try {
    await removeContainer();
    await rm(fixture, { recursive: true, force: true });
    report.cleanup = true;
  } catch {
    report.passed = false;
    report.cleanup = false;
    process.exitCode = 1;
  }
  report.completedAt = new Date().toISOString();
  await mkdir(resolve(root, "test-results"), { recursive: true });
  await writeFile(
    resolve(root, "test-results/database-tls.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
