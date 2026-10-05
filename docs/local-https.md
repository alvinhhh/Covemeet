# Local HTTPS installation

This is a separate local installation, not a public deployment. It uses distinct portal and meeting hostnames, a project-specific certificate authority, its own database and secrets, and no host mapping for raw LiveKit signaling. Existing development previews on ports 5173/5174 and their database remain unchanged.

| Endpoint                                     | Purpose                                                          |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `https://portal.localhost:8443`              | Self-hosted control panel, or the optional private hosted portal |
| `https://meet.localhost:8443`                | Meeting UI, application API and admission-checked signaling      |
| `127.0.0.1:17881/TCP`, `127.0.0.1:17882/UDP` | WebRTC media listeners                                           |
| `http://127.0.0.1:18025`                     | Local test-mail capture; no email leaves this installation       |

The origins use different hostnames so host-only cookies stay separate. Production hosted origins remain exactly `https://covemeet.com` and `https://covemeet.io`; local names do not change that policy.

## Prepare and start

Install Docker with Compose and Node.js 22.12 or later. From the core repository:

```sh
node scripts/local.mjs setup
node scripts/local.mjs start
node scripts/local.mjs health
```

The core runs independently. To use the private hosted portal, place that repository beside this one as `MeetingPlatformHosted`, or set `HOSTED_SOURCE_DIR` to its absolute path:

```sh
node scripts/local.mjs start --hosted
```

The hosted overlay has a separate PostgreSQL database for accounts and sessions, with its own generated password and no published database port. Verification and password-reset mail goes to the local Mailpit inbox. The hosted repository documents account setup and automatic hosting access after email verification and confirmed payment or an active assigned Teams seat; the shared operator key is for administration, not customer sign-in.

Recording is off initially. Opt in explicitly to build and start the isolated recorder:

```sh
node scripts/local.mjs start --hosted --recording
```

Each start builds the current source unless `--no-build` is supplied. It preserves the selected edition and recording mode. `--self-hosted` switches back to the core control panel; `--no-recording` disables the global recorder and stops its worker. End active meetings and stop recordings before changing the edition or recording mode. Ordinary per-meeting recording controls remain in the product.

`--turn` enables the bounded local TURN fixture; `--no-turn` disables it. Its selected state is preserved across starts. Run `npm ci` in the core repository before using the browser fixture. The overlay publishes only `127.0.0.1:13478/UDP` and `127.0.0.1:15349/TCP`, limits each participant credential to four allocations and reserves 64 internal relay ports. Its only permitted restricted peer is the SFU's exact loopback address, `127.0.0.1/32`. End active test calls before starting this mode: port changes or refreshed leaf certificates restart the SFU. Run the browser TLS and UDP variants in `scripts/validation/README.md`; enabling the fixture alone proves neither. The separate native UDP diagnostic currently fails before gathering a relay candidate and is not acceptance evidence. Production still needs deployment-specific TURN peer/egress firewall policy, certificates and interoperability testing.

With `--turn`, start copies only Caddy's current `meet.localhost` leaf certificate and private key into ignored `runtime/local-tls/turn` (directory `0700`, files `0600`), verifies the leaf against the CA-validated HTTPS endpoint and matching key, and mounts that directory read-only into LiveKit. It never exports the CA private key or changes trust. LiveKit reads this copy at startup; run start again after Caddy renews it. A changed fingerprint restarts LiveKit. This manual local certificate refresh is not a production renewal system. The opt-in overlay also mounts the browser test page and installed SDK under `/__validation/`; these assets are not baked into the production image.

`runtime/local-tls/.env` contains unique secrets with mode `0600`; they are not copied from the existing `.env`. The hosted operator key is `HOSTED_ADMIN_KEY`; the standalone core control panel uses `CREATION_KEY`. Read them locally when needed, never put them in a URL or commit them. Portal and core session keys are different. The local wrapping key belongs to the operator; back it up separately from encrypted recordings.

## Certificate trust

Caddy issues local certificates and renews them from its private project CA. The configuration explicitly uses `skip_install_trust`. No lifecycle command installs a CA, changes the operating system/browser trust store, edits the hosts file, disables certificate validation, or uses a certificate-warning bypass. [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https), [trust installation option](https://caddyserver.com/docs/caddyfile/options#skip-install-trust)

After startup, inspect the certificate and its fingerprint:

```sh
node scripts/local.mjs certificate
```

The public root certificate is `runtime/local-tls/trust/root.crt`. Its private key remains in this Compose project's Caddy data volume. The hosted adapter adds that exported local root to Node's built-in trust through `NODE_EXTRA_CA_CERTS`; its upstream hostname and certificate chain are still verified. Health checks explicitly load the same CA and require TLS 1.3. They work without changing system trust.

For browser access, the user must explicitly choose to trust this particular development CA. On macOS, inspect the printed SHA-256 fingerprint, open the exported certificate in Keychain Access, add it to the **login** keychain, and grant SSL trust to that certificate. This affects certificate trust for the current user: the CA can issue other certificates, so protect its project volume. Do not import an unknown CA or accept a browser warning instead. Restart the browser if its trust cache has not refreshed. To remove trust later, remove this exact certificate from the login keychain after matching its fingerprint. Do not remove similarly named certificates from other projects. [Apple certificate trust settings](https://support.apple.com/guide/keychain-access/change-the-trust-settings-of-a-certificate-kyca11871/mac)

Until the user completes that step, HTTPS works for explicitly pinned clients, but the normal browser is expected to reject the untrusted issuer. Certificate trust is not silently completed by the agent or startup script. A supported browser should resolve `.localhost` names to loopback; if it does not, diagnose local name resolution rather than changing public DNS.

## Health and lifecycle

```sh
node scripts/local.mjs status
node scripts/local.mjs health
node scripts/local.mjs stop
```

The health command verifies both origins with the local CA and matching hostname, requires TLS 1.3, checks that anonymous signaling is rejected, and inspects Docker port publications. It writes a timestamp, certificate fingerprint and container image identities to the ignored `runtime/local-tls/health.json`. It does not prove a working media call, moderation, recording, browser trust, capacity or compliance. Those require the separate tests in `requirements-ledger.md`.

For a separate check of the Docker bridge boundary:

```sh
node --test scripts/local-network-test.test.mjs
node scripts/local-network-test.mjs
```

The network check verifies exact loopback publications and a single project network attachment, then runs two short, unprivileged containers from the already-installed core image. Without secrets, mounts or devices, they connect to each private TCP listener first from the trusted project bridge (positive control), then from Docker's unrelated default bridge (must fail). The probe containers remove themselves; no application service, firewall, network or volume is changed. Sanitized evidence with exact image identities is written to ignored `test-results/local-network.json`. This checks the running images; rebuild first when validating source changes. It does not test UDP isolation, the host administrator boundary, LAN reachability or TURN.

Stopping affects only the `covemeet-local-tls` Compose project and preserves its database, encrypted recordings and certificates. No lifecycle command deletes volumes. Rebuild/start after source changes; the container image contains built application code rather than a development hot-reload mount. Re-run start after replacing the edge container so the core trusts the exact current proxy address, not an entire network.

Only edge HTTPS, media listeners and test-mail UI are published, all on `127.0.0.1`. Raw LiveKit/API port 7880, application listeners, PostgreSQL and Redis remain on the project Docker bridge. The older development stack may still expose its own loopback 7880, but uses different media credentials. On Docker Desktop, containers live inside its VM; this does not prevent the machine's administrator or Docker socket owner from accessing the trusted backend. Native-Linux host bridge routing needs an additional host firewall review before claiming isolation from processes on that host. Never change these bindings to `0.0.0.0` to invite remote guests.

## Recording and remaining boundaries

The optional recorder shares a 4 GiB, UID 1000, mode `0700` raw-memory volume with the core. Only encrypted output uses the persistent recording volume. Configure encrypted swap or disable swap on the Docker host before sensitive testing; memory storage alone does not rule out swap. Space is bounded, so long/high-bitrate recordings can fail when it fills. The pinned recorder requires `SYS_ADMIN` for Chrome sandboxing and remains a privileged trust boundary. Test only silent synthetic video until the recording gates pass.

The browser-facing API/signaling leg uses HTTPS/WSS. Standard WebRTC media uses the SFU's DTLS-SRTP implementation, with protocol and moderation tests still required. Internal HTTP signaling, PostgreSQL/Redis connections and captured test SMTP stay on this local Docker bridge; this setup does not assert service-to-service TLS, FIPS validation or end-to-end encryption against the operator. Optional TURN is a local fixture only. Phone/SIP, external carrier, real SMTP delivery, production disaster recovery and validated 100/1,000-person capacity are not supplied by this local workflow.

The local Caddy image uses the official 2.11.7 release binary, verified against hard-coded SHA-256 digests for amd64/arm64, on a digest-pinned official Alpine runtime image. The newest official Docker tag was not available when this was prepared; 2.11.6 has upstream-documented streaming regressions. Review upstream security notes and the image before release. [Caddy release](https://github.com/caddyserver/caddy/releases/tag/v2.11.7), [official image catalog](https://github.com/docker-library/official-images/blob/master/library/caddy)
