#!/usr/bin/env bash
set -euo pipefail

# Scan images already built by this job; never pull or rebuild a scan target.
readonly version=0.120.1
readonly checksum=0a9ee97ef5ae2ee953b0a80098105052e846cdbe319a57d808b519c33cd1343d
readonly url="https://github.com/anchore/grype/releases/download/v${version}/grype_${version}_linux_amd64.tar.gz"
readonly output=security-results/images
[[ $# -gt 0 ]] || { echo 'Supply name=local-image pairs.' >&2; exit 1; }
mkdir -p "$output"
revision=$(git rev-parse HEAD)
printf '{"revision":"%s","scannerVersion":"%s","scannerArchiveSha256":"%s"}\n' \
  "$revision" "$version" "$checksum" > "$output/scan.json"
temporary=$(mktemp -d)
trap 'rm -rf -- "$temporary"' EXIT
curl --fail --location --retry 1 --connect-timeout 15 --max-time 120 \
  "$url" --output "$temporary/grype.tar.gz"
printf '%s  %s\n' "$checksum" "$temporary/grype.tar.gz" | sha256sum --check --strict
tar -xzf "$temporary/grype.tar.gz" -C "$temporary" grype

status=0
for target in "$@"; do
  name=${target%%=*}
  reference=${target#*=}
  [[ "$target" == *=* && "$name" =~ ^[a-z0-9-]+$ && "$reference" =~ ^[A-Za-z0-9./:_@-]+$ ]] || exit 1
  if ! image=$(docker image inspect --format '{{.Id}}' "$reference") || [[ ! "$image" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    printf '{"reference":"%s","error":"image-unavailable"}\n' "$reference" > "$output/$name.image.json"
    status=1
    continue
  fi
  result=0
  "$temporary/grype" "docker:$image" --output json --fail-on high \
    > "$output/$name.grype.json" || result=$?
  printf '{"reference":"%s","imageId":"%s","scannerExitCode":%s}\n' \
    "$reference" "$image" "$result" > "$output/$name.image.json"
  node - "$name" "$output/$name.grype.json" <<'NODE' || status=1
try {
  const report = JSON.parse(require("node:fs").readFileSync(process.argv[3], "utf8"));
  for (const { vulnerability: v, artifact: a } of report.matches ?? [])
    if (["High", "Critical"].includes(v.severity))
      console.log(JSON.stringify({ image: process.argv[2], id: v.id, severity: v.severity, artifact: { name: a.name, version: a.version }, fix: { versions: v.fix?.versions ?? [] } }));
} catch { console.error(`${process.argv[2]}: scan report unavailable`); process.exitCode = 1; }
NODE
  if [[ $result -ne 0 ]]; then status=1; fi
done
exit "$status"
