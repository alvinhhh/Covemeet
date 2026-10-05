import assert from "node:assert/strict";
import {
  copyFile,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  allAbsent,
  executionEvidence,
  PROJECT,
  recoverProject,
  removeGeneratedInputs,
  verifyProjectAbsent,
} from "./sip-test-support.mjs";

function fakeDocker({
  failRemoval = false,
  removeThenFail = false,
  failListing = false,
  contaminateSelection = false,
} = {}) {
  const rows = [
    { kind: "container", id: "a123", label: PROJECT },
    { kind: "network", id: "b123", label: PROJECT },
    { kind: "volume", id: "fixture-volume", label: PROJECT },
    { kind: "container", id: "unrelated", label: "covemeet-local-tls" },
  ];
  const mutations = [];
  const run = async (args) => {
    const [kind, verb] = args;
    assert(["container", "network", "volume"].includes(kind));
    if (verb === "ls") {
      assert(args.includes(`label=com.docker.compose.project=${PROJECT}`));
      if (failListing && kind === "container")
        throw new Error("private diagnostic must not leak");
      return {
        stdout: rows
          .filter(
            (r) =>
              r.kind === kind &&
              (r.label === PROJECT ||
                (contaminateSelection && kind === "container")),
          )
          .map((r) => r.id)
          .join("\n"),
      };
    }
    if (verb === "inspect") {
      assert(args[4].includes('"com.docker.compose.project"'));
      return {
        stdout: rows.find((r) => r.kind === kind && r.id === args[2]).label,
      };
    }
    assert.equal(verb, "rm");
    const id = args.at(-1),
      index = rows.findIndex((r) => r.kind === kind && r.id === id);
    assert.equal(
      rows[index].label,
      PROJECT,
      "must never delete another project",
    );
    mutations.push(id);
    if (kind === "container" && failRemoval)
      throw new Error("private error must not leak");
    rows.splice(index, 1);
    if (kind === "container" && removeThenFail)
      throw new Error("uncertain command outcome");
    return { stdout: "" };
  };
  return { run, rows, mutations };
}

test("recovery removes only exact project resources and verifies all three kinds", async () => {
  const docker = fakeDocker();
  const result = await recoverProject(docker.run);
  assert.equal(result.complete, true);
  assert.equal(allAbsent(result.cleanup), true);
  assert.deepEqual(docker.mutations, ["a123", "b123", "fixture-volume"]);
  assert.equal(docker.rows[0].label, "covemeet-local-tls");
});

test("ownership re-check prevents foreign removal even if selection is contaminated", async () => {
  const docker = fakeDocker({ contaminateSelection: true });
  const result = await recoverProject(docker.run);
  assert.equal(result.complete, false);
  assert.equal(result.ownershipMismatches, 1);
  assert(!docker.mutations.includes("unrelated"));
});

test("failed removal or unknown listing can never report successful cleanup", async () => {
  for (const options of [
    { failRemoval: true },
    { failListing: true },
    { removeThenFail: true },
  ]) {
    const result = await recoverProject(fakeDocker(options).run);
    assert.equal(result.complete, false);
    assert(!JSON.stringify(result).includes("private"));
  }
  const result = await verifyProjectAbsent(
    fakeDocker({ failListing: true }).run,
  );
  assert.equal(result.containersAbsent, null);
  assert.equal(allAbsent(result), false);
});

test("execution records a native process crash without claiming application cleanup", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sip-evidence-"));
  try {
    const file = path.join(dir, "execution.json"),
      evidence = executionEvidence(file);
    await evidence.phase("native-validation");
    evidence.command(1, null);
    evidence.fail();
    await evidence.phase("cleanup");
    await evidence.finish(true);
    const report = JSON.parse(await readFile(file, "utf8"));
    assert.equal(report.status, "failed");
    assert.equal(report.failedPhase, "native-validation");
    assert.equal(report.runner.exitCode, 1);
    assert.equal(report.cleanup.containersAbsent, null);
    assert.equal(report.cleanup.generatedInputsRemoved, null);
    assert.equal(report.phase, "complete");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("interruption and unverified cleanup cannot become a passed execution", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sip-evidence-"));
  try {
    const evidence = executionEvidence(path.join(dir, "execution.json"));
    evidence.interrupt("SIGTERM");
    evidence.command(null, "SIGTERM");
    evidence.report.validationPassed = true;
    await evidence.finish(true);
    assert.equal(evidence.report.status, "interrupted");
    assert.equal(evidence.report.interruptionSignal, "SIGTERM");
    assert.equal(evidence.report.commands[0].signal, "SIGTERM");
    const unverified = executionEvidence(path.join(dir, "other.json"));
    unverified.report.validationPassed = true;
    await unverified.phase("cleanup");
    assert.equal(
      JSON.parse(await readFile(path.join(dir, "other.json"), "utf8")).status,
      "running",
    );
    await unverified.finish(false);
    assert.equal(unverified.report.status, "failed");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("generated-input removal preserves unrelated files and never follows a runtime symlink", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sip-cleanup-"));
  try {
    const runtime = path.join(dir, "runtime"),
      outside = path.join(dir, "outside");
    await mkdir(runtime);
    await mkdir(outside);
    await writeFile(path.join(outside, "keep"), "unrelated");
    await writeFile(path.join(runtime, "fixture.env"), "synthetic secret");
    await writeFile(path.join(runtime, "unrelated"), "keep");
    await symlink(outside, path.join(runtime, "asterisk"));
    assert.equal(await removeGeneratedInputs(runtime), true);
    assert.equal(
      await readFile(path.join(outside, "keep"), "utf8"),
      "unrelated",
    );
    assert.equal(
      await readFile(path.join(runtime, "unrelated"), "utf8"),
      "keep",
    );
    const link = path.join(dir, "linked-runtime");
    await symlink(outside, link);
    assert.equal(await removeGeneratedInputs(link), false);
    assert.equal(
      await readFile(path.join(outside, "keep"), "utf8"),
      "unrelated",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mocked recovery leaves execution failure unchanged and fails on unknown Docker state", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "sip-recovery-"));
  const exec = promisify(execFile);
  try {
    await mkdir(path.join(dir, "scripts"));
    await mkdir(path.join(dir, "bin"));
    await mkdir(path.join(dir, "test-results/sip"), { recursive: true });
    for (const name of ["sip-test-support.mjs", "sip-test-recovery.mjs"])
      await copyFile(
        new URL(name, import.meta.url),
        path.join(dir, "scripts", name),
      );
    // This executable never calls Docker. PATH points the recovery subprocess
    // exclusively to this controlled command stub for its Docker requests.
    await writeFile(
      path.join(dir, "bin/docker"),
      `#!/usr/bin/env node\nprocess.exit(process.env.FAKE_DOCKER_FAIL === "true" ? 1 : 0);\n`,
      { mode: 0o700 },
    );
    const original = '{"status":"failed","runner":{"exitCode":1}}\n';
    const execution = path.join(dir, "test-results/sip/execution.json");
    await writeFile(execution, original);
    for (const fail of [false, true]) {
      const runtime = path.join(dir, "runtime/sip-test");
      await mkdir(runtime, { recursive: true });
      await writeFile(path.join(runtime, "fixture.env"), "synthetic secret");
      await writeFile(path.join(runtime, "running"), "fixture-lock");
      let exitCode = 0;
      try {
        await exec(
          process.execPath,
          [path.join(dir, "scripts/sip-test-recovery.mjs")],
          {
            env: {
              ...process.env,
              PATH: `${path.join(dir, "bin")}${path.delimiter}${process.env.PATH}`,
              GITHUB_ACTIONS: "true",
              RUNNER_ENVIRONMENT: "github-hosted",
              FAKE_DOCKER_FAIL: String(fail),
            },
            timeout: 5000,
          },
        );
      } catch (error) {
        exitCode = error.code;
      }
      assert.equal(exitCode, fail ? 1 : 0);
      const recovery = JSON.parse(
        await readFile(
          path.join(dir, "test-results/sip/recovery.json"),
          "utf8",
        ),
      );
      assert.equal(recovery.status, fail ? "failed" : "passed");
      assert.equal(recovery.cleanup.generatedInputsRemoved, true);
      assert.equal(recovery.cleanup.lockRemoved, !fail);
      assert.equal(await readFile(execution, "utf8"), original);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
