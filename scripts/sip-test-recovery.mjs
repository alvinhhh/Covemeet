import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROJECT,
  recoverProject,
  removeFixtureLock,
  removeGeneratedInputs,
  writeEvidence,
} from "./sip-test-support.mjs";

// This fallback is only for the disposable GitHub-hosted job after its validation
// step exits or times out. It is not a general local cleanup command.
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.RUNNER_ENVIRONMENT !== "github-hosted"
) {
  console.error("SIP recovery requires the disposable GitHub-hosted job");
  process.exit(1);
}
process.umask(0o077);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtime = path.join(root, "runtime/sip-test");
const file = path.join(root, "test-results/sip/recovery.json");
const report = {
  project: PROJECT,
  startedAt: new Date().toISOString(),
  status: "running",
};
const exec = promisify(execFile);
const deadline = AbortSignal.timeout(90000);
const run = (args) =>
  exec("docker", args, {
    cwd: root,
    timeout: 10000,
    signal: deadline,
    maxBuffer: 65536,
  });
try {
  await writeEvidence(file, report);
} catch {
  /* Cleanup still runs. */
}
try {
  Object.assign(report, await recoverProject(run));
} catch {
  report.complete = false;
  report.cleanup = {
    containersAbsent: null,
    networksAbsent: null,
    volumesAbsent: null,
  };
}
try {
  report.cleanup.generatedInputsRemoved = await removeGeneratedInputs(runtime);
  report.complete = report.complete && report.cleanup.generatedInputsRemoved;
  report.cleanup.lockRemoved = report.complete
    ? await removeFixtureLock(runtime)
    : false;
  report.complete = report.complete && report.cleanup.lockRemoved;
  report.status = report.complete ? "passed" : "failed";
} catch {
  report.status = "failed";
  report.complete = false;
} finally {
  report.finishedAt = new Date().toISOString();
  try {
    await writeEvidence(file, report);
  } catch {
    report.status = "failed";
  }
}
// Never rewrite execution.json or convert the validation step's exit to success.
console.log(`Scoped SIP recovery ${report.status}`);
process.exitCode = report.status === "passed" ? 0 : 1;
