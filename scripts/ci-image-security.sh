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

# The core VEX applies only to the reviewed application source and native
# runtime. A changed source file, launch configuration, or binary needs review.
core_vex_ready() {
  local reference=$1 image=$2 container='' result=0 directory="$temporary/core-runtime"
  [[ "$reference" == covemeet-core:generation-test ]] || return 1
  [[ -z "$(git ls-files --others --exclude-standard -- .dockerignore Dockerfile package.json package-lock.json apps/api packages)" ]] || return 1
  [[ "$(git ls-files -z -- .dockerignore Dockerfile package.json package-lock.json apps/api packages | xargs -0 sha256sum | sha256sum | cut -d ' ' -f1)" == 8d4e14375c73976021b4b05f6859d825dcc9bf09faab259284b2960c78b96911 ]] || return 1
  [[ "$(docker image inspect --format '{{.Architecture}}|{{.Config.User}}|{{json .Config.Cmd}}|{{json .Config.Entrypoint}}' "$image")" == 'amd64|node|["node","apps/api/dist/index.js"]|["docker-entrypoint.sh"]' ]] || return 1
  mkdir -p "$directory"
  container=$(docker create "$image") || return 1
  docker cp -L "$container:/usr/local/bin/node" "$directory/node" || result=1
  docker cp -L "$container:/usr/lib/x86_64-linux-gnu/libc.so.6" "$directory/libc.so.6" || result=1
  docker cp -L "$container:/usr/lib/x86_64-linux-gnu/libstdc++.so.6" "$directory/libstdc++.so.6" || result=1
  docker cp -L "$container:/usr/lib/x86_64-linux-gnu/libz.so.1" "$directory/libz.so.1" || result=1
  if [[ $result -eq 0 ]]; then
    (cd "$directory" && printf '%s\n' \
      '7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c  node' \
      '9792e3cbb541c8f44c7acf5f14f4022ea62998ecc787d326bed4d8b6547dfd92  libc.so.6' \
      '972bb2a18b71140dab0240f8a1f68ab3fb1d56bcd4c4f824a91b70888faf5a00  libstdc++.so.6' \
      '85590dd58edf5445e18bc7193e5ebc01ac5841f1ae187e97705a662e90c6421e  libz.so.1' \
      | sha256sum --check --strict --status) || result=1
  fi
  docker rm "$container" >/dev/null || result=1
  return "$result"
}

phone_vex_ready() {
  local kind=$1 reference=$2 image=$3 expected_source expected_config files modules='' count=0
  local directory="$temporary/$kind-runtime" container='' result=0 hash path name
  case "$kind" in
    sip)
      [[ "$reference" == covemeet-sip:local ]] || return 1
      set -- .dockerignore infra/sip.Dockerfile infra/sip/entrypoint.sh infra/compose.sip-test.yaml
      expected_source=a39fcdf7fcf0d14fa3a40ad27aca5cc9218d649fe90d4c811fb5f92c711bca78
      expected_config='amd64||["/bin/sh","/usr/local/bin/covemeet-sip-entrypoint"]|null'
      files='c47fce23b7bda1b4267ec981ab247b9e8cc44c98407ad3512f5cd9a125e06b35 /usr/bin/livekit-sip
a90205500fbd60bed950af82c7d798853365898b863efd132fa6259bf1e14a86 /usr/local/bin/covemeet-sip-entrypoint
9792e3cbb541c8f44c7acf5f14f4022ea62998ecc787d326bed4d8b6547dfd92 /usr/lib/x86_64-linux-gnu/libc.so.6
85590dd58edf5445e18bc7193e5ebc01ac5841f1ae187e97705a662e90c6421e /usr/lib/x86_64-linux-gnu/libz.so.1
972bb2a18b71140dab0240f8a1f68ab3fb1d56bcd4c4f824a91b70888faf5a00 /usr/lib/x86_64-linux-gnu/libstdc++.so.6
9592038e92d1f41affcbb625334d0b6e788714c889104fa6d5b107cf9fd657f2 /usr/lib/x86_64-linux-gnu/libssl.so.3
8ae56f0a9481280a68c19f59809cd242a07a91ad7142944d21a878221992244b /usr/lib/x86_64-linux-gnu/libcrypto.so.3
92e9b4167f9bbc237ca8f5526d82ee99ec9f8dbd0270ef1dd0ab24e2217f48e3 /usr/lib/x86_64-linux-gnu/libpcre2-8.so.0
6267f2b1ca9c8fe84bef85c2069944c964c6f269f5dd8b903bc8639c3ea8c9f2 /var/lib/dpkg/status'
      ;;
    asterisk)
      [[ "$reference" == covemeet-asterisk:local ]] || return 1
      set -- .dockerignore infra/asterisk.Dockerfile infra/asterisk infra/compose.sip-test.yaml
      expected_source=8f8f09773182166cca0df8131523252336cba07f0cfe6e3c1e73ac33f49ad62b
      expected_config='amd64|10001:10001|["/usr/sbin/asterisk","-f","-n","-C","/etc/asterisk/asterisk.conf"]|null'
      files='3fd6eb6dabc170527b79cfcf67b0097bc7beef8cd6f98f1866323750ae496520 /usr/lib/libasteriskssl.so.1
6f6a1356880c1b3b8bcf18a47954e1ade48a1014fea60568f11d8db5fcac9aff /usr/lib/libasteriskpj.so.2
9792e3cbb541c8f44c7acf5f14f4022ea62998ecc787d326bed4d8b6547dfd92 /usr/lib/x86_64-linux-gnu/libc.so.6
972bb2a18b71140dab0240f8a1f68ab3fb1d56bcd4c4f824a91b70888faf5a00 /usr/lib/x86_64-linux-gnu/libstdc++.so.6
85590dd58edf5445e18bc7193e5ebc01ac5841f1ae187e97705a662e90c6421e /usr/lib/x86_64-linux-gnu/libz.so.1
621fb67b4f6f9acc78c7777d1937ce6baf7104be4a7726b28321c5c6f6e05c3a /usr/local/lib/libxml2.so.16
4cde661dc336a1a835e605532086c629f6279a312374c91795215b8489ad4bcf /usr/lib/x86_64-linux-gnu/libedit.so.2
7f7c057d4a04af01365ebf056a59521499ab4454783c4f7b74bce9f53b80b471 /usr/lib/x86_64-linux-gnu/libncurses.so.6
11f89467141e6fea87e22e93050e6fc1243efdcf7779e7500497488215c7b79e /var/lib/dpkg/status'
      # Upstream embeds the build date, host and kernel in asterisk and
      # func_version.so. The other 303 modules retain exact reviewed hashes.
      modules=df3f803bc4f92b7128a1519d1021ceffbe52bf8211b937fb318fdda1d0cc690e
      ;;
    *) return 1 ;;
  esac
  [[ -z "$(git ls-files --others --exclude-standard -- "$@")" ]] || return 1
  [[ "$(git ls-files -z -- "$@" | xargs -0 sha256sum | sha256sum | cut -d ' ' -f1)" == "$expected_source" ]] || return 1
  [[ "$(docker image inspect --format '{{.Architecture}}|{{.Config.User}}|{{json .Config.Entrypoint}}|{{json .Config.Cmd}}' "$image")" == "$expected_config" ]] || return 1
  mkdir -p "$directory"
  container=$(docker create "$image") || return 1
  while read -r hash path; do
    name=${path##*/}
    docker cp -L "$container:$path" "$directory/$name" || result=1
    printf '%s  %s\n' "$hash" "$name" >> "$directory/checks"
  done <<< "$files"
  if [[ "$result" -eq 0 ]]; then
    (cd "$directory" && sha256sum --check --strict --status checks) || result=1
  fi
  if [[ -n "$modules" ]]; then
    docker cp -L "$container:/usr/sbin/asterisk" "$directory/asterisk" || result=1
    docker cp -L "$container:/usr/lib/asterisk/modules" "$directory/modules" || result=1
    if [[ "$result" -eq 0 ]]; then
      count=$(find "$directory/modules" -maxdepth 1 -type f -name '*.so' | wc -l | tr -d ' ')
      [[ "$count" == 304 ]] || result=1
      [[ "$(cd "$directory/modules" && find . -maxdepth 1 -type f -name '*.so' -print | LC_ALL=C sort | sha256sum | cut -d ' ' -f1)" == 5a7d51791c588f57ffeb5199c1b7173a54c374f23cb45860d40ec6421cb4e347 ]] || result=1
      [[ "$(cd "$directory/modules" && find . -maxdepth 1 -type f -name '*.so' ! -name func_version.so -print0 | LC_ALL=C sort -z | xargs -0 sha256sum | sha256sum | cut -d ' ' -f1)" == "$modules" ]] || result=1
      for path in "$directory/asterisk" "$directory/modules/func_version.so"; do
        # These two files contain variable build strings. Keep their native
        # caller/dependency boundary pinned to the reviewed source instead.
        readelf -h "$path" | grep -q 'Machine:.*Advanced Micro Devices X86-64' || result=1
        nm -D --undefined-only "$path" > "$directory/symbols" || result=1
        readelf -d "$path" > "$directory/dependencies" || result=1
        if awk '{ name=$NF; sub(/@.*/, "", name); if (name ~ /^(gzwrite|gzprintf|gzvprintf|ns_printrr|ns_sprintrr|ns_sprintrrf|fp_nquery|strfmon|strfmon_l|acl_get_file|acl_set_file|acl_delete_def_file|acl_copy_file)$/) bad=1 } END { exit !bad }' "$directory/symbols"; then result=1; fi
        if grep -Eq 'NEEDED.*\[(libresolv|libacl)\.so' "$directory/dependencies"; then result=1; fi
      done
    fi
  fi
  docker rm "$container" >/dev/null || result=1
  return "$result"
}

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
  assessed=false
  if [[ "$name" == core || "$name" == sip || "$name" == asterisk ]]; then
    if { [[ "$name" == core ]] && core_vex_ready "$reference" "$image"; } ||
       { [[ "$name" != core ]] && phone_vex_ready "$name" "$reference" "$image"; }; then
      assessed=true
    else
      echo "$name: reviewed image/source fingerprint changed; scan is unfiltered and review is required" >&2
      status=1
    fi
  fi
  result=0
  if [[ "$assessed" == true ]]; then
    "$temporary/grype" "docker:$image" --output json --fail-on high --vex "security/$name-image.vex.json" \
      > "$output/$name.grype.json" || result=$?
  else
    "$temporary/grype" "docker:$image" --output json --fail-on high \
      > "$output/$name.grype.json" || result=$?
  fi
  printf '{"reference":"%s","imageId":"%s","scannerExitCode":%s,"vexApplied":%s}\n' \
    "$reference" "$image" "$result" "$assessed" > "$output/$name.image.json"
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
