import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("image scan retains every result, fails on findings/errors and verifies the download first", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "covemeet-image-security-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const finding = {
    vulnerability: { id: "CVE-2026-12345", severity: "High", fix: { versions: ["2.0.1"] } },
    artifact: { name: "example-package", version: "2.0.0" },
  };
  const report = { matches: [finding, { ...finding, vulnerability: { ...finding.vulnerability, severity: "Low" } }] };
  const stubs = {
    curl: "exit 0",
    sha256sum: "cat >/dev/null\nexit ${FAIL_CHECKSUM:-0}",
    tar: 'cp "$STUB_GRYPE" "$4/grype"',
    git: "printf '%040d\\n' 1",
    docker: 'case "$5" in first) n=1;; second) n=2;; third) n=3;; *) exit 1;; esac\nprintf "sha256:%064d\\n" "$n"',
    grype: `printf "%s\\n" "$1" >> "$SCAN_LOG"\nprintf '%s\\n' '${JSON.stringify(report)}'\ncase "$1" in *1) exit 2;; *2) exit 7;; *) exit 0;; esac`,
  };
  for (const [name, source] of Object.entries(stubs))
    await writeFile(path.join(bin, name), `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  const log = path.join(root, "scans.txt");
  const script = fileURLToPath(new URL("./ci-image-security.sh", import.meta.url));
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_GRYPE: path.join(bin, "grype"), SCAN_LOG: log };
  const run = spawnSync("bash", [script, "first=first", "second=second", "third=third"], { cwd: root, env, encoding: "utf8" });
  assert.equal(run.status, 1, run.stderr);
  const expected = [1, 2, 3].map((n) => `docker:sha256:${String(n).padStart(64, "0")}`);
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), expected);
  assert.deepEqual(run.stdout.trim().split("\n").map((line) => JSON.parse(line)),
    ["first", "second", "third"].map((image) => ({ image, id: finding.vulnerability.id, severity: "High", artifact: finding.artifact, fix: finding.vulnerability.fix })));
  for (const [i, name] of ["first", "second", "third"].entries()) {
    const directory = path.join(root, "security-results/images");
    const metadata = JSON.parse(await readFile(path.join(directory, `${name}.image.json`), "utf8"));
    assert.equal(metadata.imageId, expected[i].slice("docker:".length));
    assert.equal(metadata.scannerExitCode, [2, 7, 0][i]);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, `${name}.grype.json`), "utf8")), report);
  }
  const failed = spawnSync("bash", [script, "first=first"], { cwd: root, env: { ...env, FAIL_CHECKSUM: "1" }, encoding: "utf8" });
  assert.equal(failed.status, 1);
  assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), expected, "A failed checksum must prevent scanning");
});
