import { spawn } from "node:child_process";
for (const args of [
  [
    "--import",
    "tsx",
    "--test",
    "--test-concurrency=1",
    "apps/api/test/phone-postgres.integration.test.ts",
    "apps/api/test/recording-postgres.integration.test.ts",
    "apps/api/test/hosted-postgres.integration.test.ts",
  ],
  ["scripts/validation/phone-media.mjs"],
]) {
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
  if (status !== 0) process.exit(status);
}
