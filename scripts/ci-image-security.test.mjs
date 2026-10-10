import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile } from "node:fs/promises";
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

test("reviewed image VEX requires unchanged source and binaries; new findings still fail", async (t) => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  for (const [files, expected] of [
    [".dockerignore Dockerfile package.json package-lock.json apps/api packages", "8d4e14375c73976021b4b05f6859d825dcc9bf09faab259284b2960c78b96911"],
    [".dockerignore infra/sip.Dockerfile infra/sip/entrypoint.sh infra/compose.sip-test.yaml", "09544f2da8f2be7875acfe1f38c9e368c69bc5cab47b7e436e1e692d4b31f35f"],
    [".dockerignore infra/asterisk.Dockerfile infra/asterisk infra/compose.sip-test.yaml", "4dd014d6b3e1511dc416d62fbb1ee7fc069f3c2f1766f5ee039627a8fa174d5e"],
  ]) {
    const digest = spawnSync("bash", ["-c",
      `git ls-files -z -- ${files} | xargs -0 sha256sum | sha256sum`],
      { cwd: repo, encoding: "utf8" });
    assert.equal(digest.status, 0, digest.stderr);
    assert.equal(digest.stdout.split(" ")[0], expected);
  }

  const root = await mkdtemp(path.join(tmpdir(), "covemeet-core-vex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await mkdir(path.join(root, "security"));
  for (const [name, product] of [
    ["core", "covemeet-core:generation-test"],
    ["sip", "covemeet-sip:local"],
    ["asterisk", "covemeet-asterisk:local"],
  ]) {
    const vexFile = fileURLToPath(new URL(`../security/${name}-image.vex.json`, import.meta.url));
    await copyFile(vexFile, path.join(root, `security/${name}-image.vex.json`));
    const vex = JSON.parse(await readFile(vexFile, "utf8"));
    assert.equal(vex.statements.length, 14);
    assert.ok(vex.statements.every((statement) =>
      statement.status === "not_affected" && statement.products[0]["@id"] === product));
  }

  const stubs = {
    curl: "exit 0",
    tar: 'cp "$STUB_GRYPE" "$4/grype"',
    git: 'case "$1" in rev-parse) printf "%040d\\n" 1;; ls-files) exit 0;; esac',
    sha256sum: `if [ "\${1:-}" = "--check" ]; then
  cat >/dev/null
  if [ "\${3:-}" = "--status" ]; then exit "\${BINARY_MISMATCH:-0}"; fi
  exit 0
fi
case "$PWD" in
  */modules)
    if [ "$#" -gt 0 ]; then
      for file do printf '%064d  %s\\n' 0 "$file"; done
      exit 0
    fi
    contents=$(cat)
    case "$contents" in
      *'  ./mod1.so'*) printf '%s  -\\n' 'df3f803bc4f92b7128a1519d1021ceffbe52bf8211b937fb318fdda1d0cc690e';;
      *) printf '%s  -\\n' '5a7d51791c588f57ffeb5199c1b7173a54c374f23cb45860d40ec6421cb4e347';;
    esac;;
  *) printf '%s  -\\n' "\${SOURCE_DIGEST}";;
esac`,
    readelf: `case "$1" in -h) printf '%s\\n' 'Machine: Advanced Micro Devices X86-64';; -d) printf '%s\\n' 'NEEDED [libc.so.6]';; *) exit 1;; esac`,
    nm: `if [ "\${NATIVE_IMPORT_MISMATCH:-0}" = 1 ]; then printf '%s\\n' 'U strfmon@GLIBC_2.2.5'; fi`,
    docker: `case "$1" in
  image)
    case "$4" in
      *Architecture*)
        case "\${KIND:-core}" in
          sip) printf '%s\\n' 'amd64||["/bin/sh","/usr/local/bin/covemeet-sip-entrypoint"]|null';;
          asterisk) printf '%s\\n' 'amd64|10001:10001|["/usr/sbin/asterisk","-f","-n","-C","/etc/asterisk/asterisk.conf"]|null';;
          *) printf '%s\\n' 'amd64|node|["node","apps/api/dist/index.js"]|["docker-entrypoint.sh"]';;
        esac;;
      *) printf 'sha256:%064d\\n' 1;;
    esac;;
  create) printf '%s\\n' fixture-container;;
  cp)
    case "$3" in
      *:/usr/lib/asterisk/modules)
        mkdir -p "$4"
        i=1
        while [ "$i" -le 303 ]; do : > "$4/mod$i.so"; i=$((i+1)); done
        : > "$4/func_version.so";;
      *) : > "$4";;
    esac;;
  rm) exit 0;;
  *) exit 1;;
esac`,
    grype: `printf '%s\\n' "$*" >> "$SCAN_LOG"
case " $* " in
  *" --vex "*)
    if [ "\${NEW_HIGH:-0}" = 1 ]; then
      printf '%s\\n' '{"matches":[{"vulnerability":{"id":"CVE-NEW","severity":"High"},"artifact":{"name":"new","version":"1"}}],"ignoredMatches":[{"vulnerability":{"id":"CVE-2026-85091"}}]}'
      exit 2
    fi
    printf '%s\\n' '{"matches":[],"ignoredMatches":[{"vulnerability":{"id":"CVE-2026-85091"}}]}'
    exit 0;;
  *)
    printf '%s\\n' '{"matches":[{"vulnerability":{"id":"CVE-2026-85091","severity":"High"},"artifact":{"name":"zlib","version":"1"}}]}'
    exit 2;;
esac`,
  };
  for (const [name, source] of Object.entries(stubs))
    await writeFile(path.join(bin, name), `#!/bin/sh\n${source}\n`, { mode: 0o700 });
  const script = fileURLToPath(new URL("./ci-image-security.sh", import.meta.url));
  const log = path.join(root, "scans.txt");
  const env = {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, STUB_GRYPE: path.join(bin, "grype"),
    SCAN_LOG: log,
    SOURCE_DIGEST: "8d4e14375c73976021b4b05f6859d825dcc9bf09faab259284b2960c78b96911",
  };
  const run = (extra = {}, target = "core=covemeet-core:generation-test") => spawnSync("bash", [script, target],
    { cwd: root, env: { ...env, ...extra }, encoding: "utf8" });

  const reviewed = run();
  assert.equal(reviewed.status, 0, reviewed.stderr);
  assert.match(await readFile(log, "utf8"), /--vex security\/core-image\.vex\.json/);
  assert.equal(JSON.parse(await readFile(path.join(root, "security-results/images/core.image.json"), "utf8")).vexApplied, true);

  const changedSource = run({ SOURCE_DIGEST: "0".repeat(64) });
  assert.equal(changedSource.status, 1);
  assert.match(changedSource.stderr, /review is required/);
  assert.equal(JSON.parse(await readFile(path.join(root, "security-results/images/core.image.json"), "utf8")).vexApplied, false);

  const changedBinary = run({ BINARY_MISMATCH: "1" });
  assert.equal(changedBinary.status, 1);
  assert.equal(JSON.parse(await readFile(path.join(root, "security-results/images/core.image.json"), "utf8")).vexApplied, false);

  const newHigh = run({ NEW_HIGH: "1" });
  assert.equal(newHigh.status, 1);
  assert.match(newHigh.stdout, /CVE-NEW/);
  assert.equal(JSON.parse(await readFile(path.join(root, "security-results/images/core.image.json"), "utf8")).vexApplied, true);

  for (const [name, digest] of [
    ["sip", "09544f2da8f2be7875acfe1f38c9e368c69bc5cab47b7e436e1e692d4b31f35f"],
    ["asterisk", "4dd014d6b3e1511dc416d62fbb1ee7fc069f3c2f1766f5ee039627a8fa174d5e"],
  ]) {
    const result = run({ KIND: name, SOURCE_DIGEST: digest }, `${name}=covemeet-${name}:local`);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(path.join(root, `security-results/images/${name}.image.json`), "utf8")).vexApplied, true);
    const changed = run({ KIND: name, SOURCE_DIGEST: digest, BINARY_MISMATCH: "1" },
      `${name}=covemeet-${name}:local`);
    assert.equal(changed.status, 1);
    assert.equal(JSON.parse(await readFile(path.join(root, `security-results/images/${name}.image.json`), "utf8")).vexApplied, false);
    if (name === "asterisk") {
      const newNativeImport = run({ KIND: name, SOURCE_DIGEST: digest, NATIVE_IMPORT_MISMATCH: "1" },
        `${name}=covemeet-${name}:local`);
      assert.equal(newNativeImport.status, 1);
      assert.equal(JSON.parse(await readFile(path.join(root, `security-results/images/${name}.image.json`), "utf8")).vexApplied, false);
    }
  }
});
