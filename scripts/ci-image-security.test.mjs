import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, copyFile, access } from "node:fs/promises";
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

test("reviewed source fingerprints match the declared file sets", () => {
  const repo = fileURLToPath(new URL("..", import.meta.url));
  for (const [files, expected] of [
    [".dockerignore Dockerfile package.json package-lock.json apps/api packages", "8e6cc9337b78c5e8b5fe0592796608798d7f9083ea4216ad59e676840613e983"],
    [".dockerignore infra/sip.Dockerfile infra/sip/entrypoint.sh infra/compose.sip-test.yaml", "09544f2da8f2be7875acfe1f38c9e368c69bc5cab47b7e436e1e692d4b31f35f"],
    [".dockerignore infra/asterisk.Dockerfile infra/asterisk infra/compose.sip-test.yaml", "4dd014d6b3e1511dc416d62fbb1ee7fc069f3c2f1766f5ee039627a8fa174d5e"],
  ]) {
    const digest = spawnSync("bash", ["-c",
      `git ls-files -z -- ${files} | xargs -0 sha256sum | sha256sum`],
      { cwd: repo, encoding: "utf8" });
    assert.equal(digest.status, 0, digest.stderr);
    assert.equal(digest.stdout.split(" ")[0], expected);
  }

});

test("reviewed image VEX requires unchanged source and binaries; new findings still fail", async (t) => {
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
    assert.equal(vex.statements.length, name === "sip" ? 14 : 18);
    assert.ok(vex.statements.every((statement) =>
      statement.status === "not_affected" && statement.products[0]["@id"] === product));
    if (name !== "sip") {
      const identifiers = ["CVE-2026-84243", "CVE-2026-119373", "CVE-2026-119374", "CVE-2026-119379"];
      const additions = vex.statements.filter((statement) =>
        identifiers.includes(statement.vulnerability.name));
      assert.deepEqual(additions.map((statement) => statement.vulnerability.name).sort(), identifiers.sort());
      assert.ok(additions.every((statement) => statement.justification === "vulnerable_code_not_in_execute_path"));
    }
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
if [ "$#" -gt 0 ] && [ "$PWD" != "\${PWD%/modules}" ]; then
  for file do printf '%064d  %s\\n' 0 "$file"; done
  exit 0
fi
if [ "$#" -gt 0 ]; then
  [ "\${HASH_FAIL:-}" != "\${1##*/}" ] || exit 6
  case "\${1##*/}" in
      livekit-sip) digest=a459cf3a47ad39d3f957a2dfc3a083543e2a55576f6697a625d8bd576b0b8d8b;;
      covemeet-sip-entrypoint) digest=a90205500fbd60bed950af82c7d798853365898b863efd132fa6259bf1e14a86;;
      libc.so.6) digest=9792e3cbb541c8f44c7acf5f14f4022ea62998ecc787d326bed4d8b6547dfd92;;
      libz.so.1) digest=85590dd58edf5445e18bc7193e5ebc01ac5841f1ae187e97705a662e90c6421e;;
      libstdc++.so.6) digest=972bb2a18b71140dab0240f8a1f68ab3fb1d56bcd4c4f824a91b70888faf5a00;;
      libssl.so.3) digest=9592038e92d1f41affcbb625334d0b6e788714c889104fa6d5b107cf9fd657f2;;
      libcrypto.so.3) digest=8ae56f0a9481280a68c19f59809cd242a07a91ad7142944d21a878221992244b;;
      libpcre2-8.so.0) digest=92e9b4167f9bbc237ca8f5526d82ee99ec9f8dbd0270ef1dd0ab24e2217f48e3;;
      libasteriskssl.so.1) digest=3fd6eb6dabc170527b79cfcf67b0097bc7beef8cd6f98f1866323750ae496520;;
      libasteriskpj.so.2) digest=6f6a1356880c1b3b8bcf18a47954e1ade48a1014fea60568f11d8db5fcac9aff;;
      libxml2.so.16) digest=621fb67b4f6f9acc78c7777d1937ce6baf7104be4a7726b28321c5c6f6e05c3a;;
      libedit.so.2) digest=4cde661dc336a1a835e605532086c629f6279a312374c91795215b8489ad4bcf;;
      libncurses.so.6) digest=7f7c057d4a04af01365ebf056a59521499ab4454783c4f7b74bce9f53b80b471;;
      status)
        case "$KIND" in
          asterisk) digest=72b9f22b0f3d4d4998c70f7533d44b2379eb14be47224c4050dfb60eb4f8256e;;
          *) digest=6267f2b1ca9c8fe84bef85c2069944c964c6f269f5dd8b903bc8639c3ea8c9f2;;
        esac;;
      *) exit 9;;
  esac
  if [ "\${BINARY_MISMATCH:-0}" = 1 ]; then digest=$(printf '%064d' 0); fi
  printf '%s  %s\\n' "$digest" "$1"
  exit 0
fi
contents=$(cat)
case "$contents" in
  *'  ./mod1.so'*)
    if [ "\${MODULE_DIGEST_MISMATCH:-0}" = 1 ]; then printf '%064d  -\\n' 0; else printf '%s  -\\n' 'df3f803bc4f92b7128a1519d1021ceffbe52bf8211b937fb318fdda1d0cc690e'; fi;;
  *'./mod1.so'*)
    if [ "\${MODULE_NAMES_MISMATCH:-0}" = 1 ]; then printf '%064d  -\\n' 0; else printf '%s  -\\n' '5a7d51791c588f57ffeb5199c1b7173a54c374f23cb45860d40ec6421cb4e347'; fi;;
  *'secret-fixture'*) printf '%064d  -\\n' 0;;
  *) printf '%s  -\\n' "\${SOURCE_DIGEST}";;
esac`,
    readelf: `case "$1" in
  -h) if [ "\${NATIVE_ARCH_MISMATCH:-0}" = 1 ]; then printf '%s\\n' 'Machine: AArch64'; else printf '%s\\n' 'Machine: Advanced Micro Devices X86-64'; fi;;
  -d) if [ "\${NATIVE_DEP_MISMATCH:-0}" = 1 ]; then printf '%s\\n' 'NEEDED [libacl.so.1]'; else printf '%s\\n' 'NEEDED [libc.so.6]'; fi;;
  *) exit 1;;
esac`,
    nm: `[ "\${NATIVE_TOOL_FAIL:-0}" = 0 ] || exit 7
if [ "\${NATIVE_IMPORT_MISMATCH:-0}" = 1 ]; then printf '%s\\n' 'U strfmon@GLIBC_2.2.5'; fi`,
    docker: `case "$1" in
  image)
    case "$4" in
      *Architecture*)
        [ "\${INSPECT_FAIL:-0}" = 0 ] || exit 8
        if [ "\${CONFIG_MISMATCH:-0}" = 1 ]; then printf '%s\\n' 'secret-fixture'; exit 0; fi
        case "\${KIND:-core}" in
          sip) printf '%s\\n' 'amd64||["/bin/sh","/usr/local/bin/covemeet-sip-entrypoint"]|null';;
          asterisk) printf '%s\\n' 'amd64|10001:10001|["/usr/sbin/asterisk","-f","-n","-C","/etc/asterisk/asterisk.conf"]|null';;
          *) printf '%s\\n' 'amd64|node|["node","apps/api/dist/index.js"]|["docker-entrypoint.sh"]';;
        esac;;
      *) printf 'sha256:%064d\\n' 1;;
    esac;;
  create) printf '%s\\n' fixture-container;;
  cp)
    [ "$3" != "fixture-container:\${COPY_FAIL:-}" ] || exit 9
    case "$3" in
      *:/usr/lib/asterisk/modules)
        mkdir -p "$4"
        i=1
        while [ "$i" -le 303 ]; do : > "$4/mod$i.so"; i=$((i+1)); done
        : > "$4/func_version.so"
        if [ "\${MODULE_COUNT_MISMATCH:-0}" = 1 ]; then rm "$4/mod303.so"; fi;;
      *:/var/lib/dpkg/status) printf '%s\\n' 'Package: fixture-package' 'Version: 1.2.3' 'Description: secret-fixture' > "$4";;
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
    SOURCE_DIGEST: "8e6cc9337b78c5e8b5fe0592796608798d7f9083ea4216ad59e676840613e983",
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
  const diagnosticPath = path.join(root, "security-results/images/asterisk.vex-gate.tsv");
  const diagnosticRows = async () => new Map((await readFile(diagnosticPath, "utf8")).trim().split("\n").slice(1)
    .map(line => { const [name, expected, actual, passed] = line.split("\t"); return [name, { expected, actual, passed }]; }));
  const asteriskEnv = { KIND: "asterisk", SOURCE_DIGEST: "4dd014d6b3e1511dc416d62fbb1ee7fc069f3c2f1766f5ee039627a8fa174d5e" };
  assert.equal(run(asteriskEnv, "asterisk=covemeet-asterisk:local").status, 0);
  const validRows = await diagnosticRows();
  assert.equal(validRows.get("module-count").actual, "304");
  assert.equal(validRows.get("module-binaries-sha256").passed, "true");
  assert.equal(validRows.get("sha256:/var/lib/dpkg/status").passed, "true");
  assert.equal(await readFile(path.join(root, "security-results/images/asterisk.packages.tsv"), "utf8"), "fixture-package\t1.2.3\n");
  assert.equal((await readFile(path.join(root, "security-results/images/asterisk.module-names.txt"), "utf8")).trim().split("\n").length, 304);
  assert.equal((await readFile(path.join(root, "security-results/images/asterisk.module-sha256.txt"), "utf8")).trim().split("\n").length, 303);
  for (const [extra, predicate, actual] of [
    [{ SOURCE_DIGEST: "0".repeat(64) }, "source-sha256", "0".repeat(64)],
    [{ CONFIG_MISMATCH: "1" }, "launch-config-sha256", "0".repeat(64)],
    [{ INSPECT_FAIL: "1" }, "image-inspect-exit", "8"],
    [{ COPY_FAIL: "/var/lib/dpkg/status" }, "copy:/var/lib/dpkg/status", "9"],
    [{ HASH_FAIL: "libc.so.6" }, "hash-exit:/usr/lib/x86_64-linux-gnu/libc.so.6", "6"],
    [{ BINARY_MISMATCH: "1" }, "sha256:/var/lib/dpkg/status", "0".repeat(64)],
    [{ MODULE_COUNT_MISMATCH: "1" }, "module-count", "303"],
    [{ MODULE_NAMES_MISMATCH: "1" }, "module-names-sha256", "0".repeat(64)],
    [{ MODULE_DIGEST_MISMATCH: "1" }, "module-binaries-sha256", "0".repeat(64)],
    [{ NATIVE_ARCH_MISMATCH: "1" }, "amd64:asterisk", "1"],
    [{ NATIVE_TOOL_FAIL: "1" }, "nm:asterisk", "7"],
    [{ NATIVE_IMPORT_MISMATCH: "1" }, "forbidden-imports:func_version.so", "present"],
    [{ NATIVE_DEP_MISMATCH: "1" }, "forbidden-dependencies:func_version.so", "0"],
  ]) {
    const failed = run({ ...asteriskEnv, ...extra }, "asterisk=covemeet-asterisk:local");
    assert.equal(failed.status, 1, `${predicate}: ${failed.stderr}`);
    const rows = await diagnosticRows();
    assert.equal(rows.get(predicate)?.actual, actual, predicate);
    assert.equal(rows.get(predicate)?.passed, "false", predicate);
    if (predicate === "source-sha256") {
      await assert.rejects(access(path.join(root, "security-results/images/asterisk.packages.tsv")), { code: "ENOENT" });
      await assert.rejects(access(path.join(root, "security-results/images/asterisk.module-sha256.txt")), { code: "ENOENT" });
    }
    assert.doesNotMatch(await readFile(diagnosticPath, "utf8"), /secret-fixture/);
    assert.equal(JSON.parse(await readFile(path.join(root, "security-results/images/asterisk.image.json"), "utf8")).vexApplied, false);
    assert.doesNotMatch((await readFile(log, "utf8")).trim().split("\n").at(-1), /--vex/);
  }
  assert.match(await readFile(path.join(root, "security-results/images/asterisk.asterisk.dependencies.txt"), "utf8"), /libacl/);
  assert.match(await readFile(path.join(root, "security-results/images/asterisk.func_version.so.dependencies.txt"), "utf8"), /libacl/);

});
