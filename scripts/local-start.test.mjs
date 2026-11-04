import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const dockerShim = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const log = event => appendFileSync(process.env.STARTUP_TEST_TRACE, JSON.stringify(event) + "\\n");
if (args[0] === "ps") process.exit(0);
if (args[0] === "inspect") {
  console.log(JSON.stringify([{ NetworkSettings: { Networks: {
    "covemeet-local-tls": { IPAddress: "172.19.0.2" }
  } } }]));
  process.exit(0);
}
if (args[0] !== "compose") throw Error("Unexpected command");
const index = args.findIndex(arg => ["config", "build", "up", "cp", "ps"].includes(arg));
const action = args[index];
if (action === "config") process.exit(0);
if (action === "build") {
  log({ operation: "explicit-build" });
  process.exit(1);
}
if (action === "ps") {
  console.log("startup-fixture-edge");
  process.exit(0);
}
if (action === "cp") {
  // Startup must fail before certificate validation or any HTTPS request.
  writeFileSync(args.at(-1), "unused fixture certificate\\n");
  process.exit(0);
}
if (action !== "up") throw Error("Unexpected Compose action");
const service = args.includes("--no-deps") ? "edge" : "core";
log({ operation: "up", service, args: args.slice(index) });
if (service === process.env.STARTUP_TEST_MISSING_IMAGE) {
  if (!args.includes("--no-build")) log({ operation: "implicit-build" });
  const pull = args.indexOf("--pull");
  if (pull === -1 || args[pull + 1] !== "never") log({ operation: "network-pull" });
  log({ operation: "missing-image", service });
  console.error("Missing local fixture image: " + service);
  process.exit(1);
}
`;

for (const missingImage of ["edge", "core"]) {
  test(
    `start --no-build fails without building or pulling when ${missingImage} is missing`,
    { timeout: 10_000, skip: process.platform === "win32" },
    async (t) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), "covemeet-local-start-"),
      );
      t.after(() => rm(directory, { recursive: true, force: true }));
      const bin = path.join(directory, "bin");
      const scripts = path.join(directory, "scripts");
      const traceFile = path.join(directory, "commands.jsonl");
      await mkdir(bin);
      await mkdir(scripts);
      await copyFile(
        new URL("./local.mjs", import.meta.url),
        path.join(scripts, "local.mjs"),
      );
      await writeFile(path.join(bin, "docker"), dockerShim, { mode: 0o700 });
      const result = spawnSync(
        process.execPath,
        [
          path.join(scripts, "local.mjs"),
          "start",
          "--self-hosted",
          "--recording",
          "--no-build",
        ],
        {
          cwd: directory,
          env: {
            PATH: [bin, path.dirname(process.execPath)].join(path.delimiter),
            HOME: directory,
            STARTUP_TEST_TRACE: traceFile,
            STARTUP_TEST_MISSING_IMAGE: missingImage,
          },
          encoding: "utf8",
          timeout: 5_000,
          killSignal: "SIGKILL",
          maxBuffer: 64 * 1024,
        },
      );
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1);
      assert.match(
        result.stderr,
        new RegExp(`Missing local fixture image: ${missingImage}`),
      );
      const trace = (await readFile(traceFile, "utf8"))
        .trim()
        .split("\n")
        .map(JSON.parse);
      assert.equal(
        trace.some(({ operation }) =>
          ["explicit-build", "implicit-build", "network-pull"].includes(operation),
        ),
        false,
      );
      const starts = trace.filter(({ operation }) => operation === "up");
      assert.deepEqual(
        starts.map(({ service }) => service),
        missingImage === "edge" ? ["edge"] : ["edge", "core"],
      );
      for (const { args } of starts) {
        assert.ok(args.includes("--no-build"));
        assert.equal(args[args.indexOf("--pull") + 1], "never");
      }
      assert.deepEqual(trace.at(-1), {
        operation: "missing-image",
        service: missingImage,
      });
    },
  );
}
