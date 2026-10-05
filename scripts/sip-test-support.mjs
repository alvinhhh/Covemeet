import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const PROJECT = "covemeet-sip-test";
export const GENERATED_INPUTS = [
  "fixture.env",
  "phone-runtime.json",
  "phone-old-runtime.json",
  "client-password",
  "livekit.yaml",
  "sip.yaml",
  "asterisk",
  "certs",
];
const label = `com.docker.compose.project=${PROJECT}`;
const resources = [
  ["container", "containersAbsent"],
  ["network", "networksAbsent"],
  ["volume", "volumesAbsent"],
];
const phases = new Set([
  "preparing",
  "build-client",
  "build-services",
  "start-services",
  "readiness",
  "tls-preflight",
  "native-validation",
  "managed-recovery",
  "diagnostics",
  "cleanup",
  "complete",
]);

export async function writeEvidence(file, value, { shared = false } = {}) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  // Only sanitized manager reports opt in: their root container and host runner
  // have different owners on Linux. chmod is explicit because umask strips mode.
  if (shared) await chmod(temporary, 0o644);
  await rename(temporary, file);
}

// Only fixed labels and numeric process results enter this artifact. In particular,
// never store command arguments, environment, stdout/stderr, or exception messages.
export function executionEvidence(file) {
  const report = {
    project: PROJECT,
    startedAt: new Date().toISOString(),
    phase: "preparing",
    status: "running",
    validationPassed: false,
    interrupted: false,
    interruptionSignal: null,
    runner: null,
    commands: [],
    cleanup: {
      composeDownSucceeded: null,
      containersAbsent: null,
      networksAbsent: null,
      volumesAbsent: null,
      generatedInputsRemoved: null,
      lockRemoved: null,
    },
  };
  return {
    report,
    save: () => writeEvidence(file, report),
    async phase(value) {
      if (!phases.has(value)) throw new Error("Invalid SIP fixture phase");
      report.phase = value;
      await writeEvidence(file, report);
    },
    command(code, signal) {
      const result = {
        phase: report.phase,
        exitCode: Number.isInteger(code) ? code : null,
        signal:
          typeof signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(signal)
            ? signal
            : null,
      };
      report.commands.push(result);
      if (report.phase === "native-validation") report.runner = result;
    },
    interrupt(signal) {
      report.interrupted = true;
      report.interruptionSignal = signal === "SIGTERM" ? "SIGTERM" : "SIGINT";
    },
    fail() {
      report.failedPhase ??= report.phase;
      report.status = report.interrupted ? "interrupted" : "failed";
    },
    async finish(clean) {
      const verified =
        clean &&
        allAbsent(report.cleanup) &&
        report.cleanup.generatedInputsRemoved === true &&
        report.cleanup.lockRemoved === true;
      if (
        !verified ||
        !report.validationPassed ||
        report.status === "failed" ||
        report.interrupted
      ) {
        report.failedPhase ??= report.phase;
        report.status = report.interrupted ? "interrupted" : "failed";
      } else report.status = "passed";
      report.phase = "complete";
      report.finishedAt = new Date().toISOString();
      await writeEvidence(file, report);
    },
  };
}

async function selected(run, kind) {
  const { stdout } = await run([
    kind,
    "ls",
    ...(kind === "container" ? ["--all"] : []),
    "--quiet",
    "--filter",
    `label=${label}`,
  ]);
  const ids = stdout.trim().split(/\s+/).filter(Boolean);
  if (
    ids.length > 32 ||
    ids.some((id) => !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id))
  )
    throw new Error("Invalid scoped SIP resource list");
  return ids;
}

export async function verifyProjectAbsent(run) {
  const result = {};
  for (const [kind, flag] of resources) {
    try {
      result[flag] = (await selected(run, kind)).length === 0;
    } catch {
      result[flag] = null;
    }
  }
  return result;
}

export const allAbsent = (result) =>
  resources.every(([, flag]) => result[flag] === true);

// Recovery only: exact project-label selection, then re-check ownership before
// each mutation. Never prune or remove by prefix. Any failed query/removal remains
// a failure even if a later observation happens to show no resources.
export async function recoverProject(run) {
  const result = {
    selectionErrors: 0,
    removalErrors: 0,
    ownershipMismatches: 0,
  };
  for (const [kind] of resources) {
    let ids;
    try {
      ids = await selected(run, kind);
    } catch {
      result.selectionErrors++;
      continue;
    }
    for (const id of ids) {
      try {
        const field = kind === "container" ? ".Config.Labels" : ".Labels";
        const { stdout } = await run([
          kind,
          "inspect",
          id,
          "--format",
          `{{index ${field} "com.docker.compose.project"}}`,
        ]);
        if (stdout.trim() !== PROJECT) {
          result.ownershipMismatches++;
          continue;
        }
        await run([
          kind,
          "rm",
          ...(kind === "container" ? ["--force"] : []),
          id,
        ]);
      } catch {
        result.removalErrors++;
      }
    }
  }
  result.cleanup = await verifyProjectAbsent(run);
  result.complete =
    allAbsent(result.cleanup) &&
    result.selectionErrors === 0 &&
    result.removalErrors === 0 &&
    result.ownershipMismatches === 0;
  return result;
}

async function absent(file) {
  try {
    await lstat(file);
    return false;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

export async function removeGeneratedInputs(runtime) {
  try {
    const stat = await lstat(runtime);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  } catch (error) {
    return error.code === "ENOENT";
  }
  let complete = true;
  for (const name of GENERATED_INPUTS) {
    const file = path.join(runtime, name);
    try {
      await rm(file, { recursive: true, force: true });
    } catch {
      complete = false;
    }
    if (!(await absent(file))) complete = false;
  }
  return complete;
}

export async function removeFixtureLock(runtime) {
  const file = path.join(runtime, "running");
  try {
    await rm(file, { force: true });
  } catch {
    return false;
  }
  return absent(file);
}
