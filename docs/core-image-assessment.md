# Core image vulnerability assessment

This assessment covers the Linux/amd64 core API image built from source revision `74dd2795b0d818e47b8b748d748d17ff13f0cfa0`. The inspected image ID is `sha256:2829a6c6369a6466529a1ceaf629140f081c64e571444871fd13ea988971f86f`. Its configured user is `node`; its command starts `apps/api/dist/index.js`. It is not an assessment of the phone worker, Egress, a shell session in the image, or arbitrary future native modules.

The four relevant inspected binaries have these SHA-256 hashes:

| File | SHA-256 |
| --- | --- |
| `/usr/local/bin/node` | `7fde7b8afa198da66257f42ee2001d874c7355631e6d1579a5fb5ef1f246df4c` |
| `libc.so.6` | `9792e3cbb541c8f44c7acf5f14f4022ea62998ecc787d326bed4d8b6547dfd92` |
| `libstdc++.so.6` | `972bb2a18b71140dab0240f8a1f68ab3fb1d56bcd4c4f824a91b70888faf5a00` |
| `libz.so.1` | `85590dd58edf5445e18bc7193e5ebc01ac5841f1ae187e97705a662e90c6421e` |

The [OpenVEX file](../security/core-image.vex.json) records 14 `not_affected` decisions for this configured core service. These decisions do not say the packages are patched.

| Advisory | Affected path and evidence in this image | Decision |
| --- | --- | --- |
| [CVE-2026-95619](https://security-tracker.debian.org/tracker/CVE-2026-95619) | The [GCC fix](https://github.com/gcc-mirror/gcc/commit/59d235ffa5a69231eb42e5290d52dc8c90d28b7a) excludes the `posix_memalign` implementation. Disassembly of this exact `libstdc++` aligned-new function passes the original size to `posix_memalign`; the affected rounding branch is absent. | Vulnerable code not present in the inspected function. |
| [CVE-2026-102010](https://security-tracker.debian.org/tracker/CVE-2026-102010) | The [GCC patch](https://github.com/gcc-mirror/gcc/commit/aaa8351f4d2e636f9680a1f0a8ebc2f0a60611e6) concerns a compiled GNU PBDS `binary_heap_tag::erase_if` instantiation. The installed LiveKit RTC add-on includes opaque WebRTC code, but only the separate phone worker imports that add-on. The core API imports `livekit-server-sdk`; its other loaded native source does not use PBDS. | Affected path is not loaded by the core entrypoint. Phone applicability remains unresolved. |
| [CVE-2026-85091](https://security-tracker.debian.org/tracker/CVE-2026-85091) | Debian's packaged `libz` lacks the described `gz_vacate` path. The exact Node executable **does** embed affected [zlib file-writer code](https://raw.githubusercontent.com/nodejs/node/v24.21.0/deps/zlib/gzwrite.c). Full executable call references, loaded native add-on imports, and [Node's compression binding](https://raw.githubusercontent.com/nodejs/node/v24.21.0/src/node_zlib.cc) show no configured call to `gzwrite`, `gzprintf`, or `gzvprintf`; ordinary GZIP uses `deflateInit2`. | Affected code is present but outside the configured call path. Reassess on a Node/native-module change. |
| [CVE-2026-5435](https://security-tracker.debian.org/tracker/CVE-2026-5435) | The affected deprecated resolver debug printers are absent from exact Node and loaded add-on imports, relocations, and target-name strings. Node's DNS path uses c-ares, not those printers. | Affected path is not called by this service. |
| [CVE-2026-19499](https://security-tracker.debian.org/tracker/CVE-2026-19499) | The exact libc monetary formatter helper is reached only through `strfmon`/`strfmon_l`; Node and the loaded add-ons have no import, relocation, or target-name string for those wrappers. | Affected path is not called by this service. |

The remaining findings concern installed tools or privileged APIs that the core API does not invoke:

| Advisories | Required path absent from core operation |
| --- | --- |
| CVE-2026-76642, CVE-2026-78408, CVE-2026-78409, CVE-2026-78410 | Privileged `mount` or `nsenter` actions, authorized fstab entries, and namespace/cgroup access. |
| CVE-2026-54369, CVE-2026-54370 | Privileged `libacl` pathname operations or recursive ACL CLI use. The API uses Node file operations. |
| CVE-2025-69720 | `infocmp` parsing a terminal description. |
| CVE-2026-82560, CVE-2026-9538 | Perl `Pod::Text` or `Archive::Tar` execution on supplied content. |

The core service has no `child_process`, dynamic module loading, or calls to these CLIs in the reviewed API/packages source. Its production container configuration runs without additional Linux capabilities or privilege escalation. This assessment does not cover an attacker who already has arbitrary code execution inside the container.

CI scans the built image with Grype 0.120.1 at the existing High threshold. [Grype's OpenVEX support](https://oss.anchore.com/docs/guides/vulnerability/filter-results/) moves matching decisions into `ignoredMatches`; unmatched findings remain in `matches` and still fail the job. The VEX names the local `covemeet-core:generation-test` tag because locally built images lack a registry manifest digest. Before passing the VEX file, `scripts/ci-image-security.sh` checks the source-file manifest, image architecture/user/command, and all four binary hashes above. A mismatch runs an unfiltered scan and fails pending reassessment. The tag alone is not a security identity.
