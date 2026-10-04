#!/usr/bin/env node
// Disposable S3 compatibility fixture. No real media, cloud credentials or production data.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = resolve(root, "runtime/storage-test");
const envFile = resolve(directory, ".env");
const command = process.argv[2];
if (!["setup", "start", "stop"].includes(command)) {
  console.error("node scripts/storage-test.mjs setup|start|stop");
  process.exit(1);
}
await mkdir(directory, { recursive: true, mode: 0o700 });
await chmod(directory, 0o700);
const config = {
  TEST_S3_ENDPOINT: "http://127.0.0.1:19000",
  TEST_S3_REGION: "us-east-1",
  TEST_S3_ACCESS_KEY: randomBytes(18).toString("hex"),
  TEST_S3_SECRET_KEY: randomBytes(32).toString("hex"),
};
try {
  await writeFile(
    envFile,
    Object.entries(config)
      .map(([key, value]) => `${key}=${value}`)
      .join("\n") + "\n",
    { flag: "wx", mode: 0o600 },
  );
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
await chmod(envFile, 0o600);
if (command === "setup") {
  console.log("Protected synthetic storage test configuration is ready.");
} else {
  const child = spawn(
    "docker",
    [
      "compose",
      "--env-file",
      envFile,
      "-f",
      "infra/compose.storage-test.yaml",
      ...(command === "start"
        ? ["up", "--build", "-d"]
        : ["down", "--timeout", "15"]),
    ],
    { cwd: root, stdio: "inherit" },
  );
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
  });
}
