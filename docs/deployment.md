# Deployment

## Local development

The default Compose file runs PostgreSQL, Redis, and LiveKit. The API and browser application run on the development host. All published ports bind to `127.0.0.1`. Redis has no published port. LiveKit port 7880 is exposed only to the local host because the API needs to reach it.

```sh
node scripts/bootstrap.mjs
docker compose --profile mail up -d
npm ci
npm run dev
```

Do not change the dev bindings to `0.0.0.0` to invite remote users. The local raw-signaling shortcut would bypass the application admission gateway if it were exposed. Use a deployment with the private signaling boundary intact.

| Configuration                            | Meaning                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `EDITION`                                | `self-hosted` permits custom meeting codes; `hosted` requires generated codes and the creation key.                |
| `SITE_ORIGIN`                            | Exact browser origin; use `http://localhost:5173` for development and an HTTPS origin externally.                  |
| `PORTAL_ORIGIN`                          | Optional separate self-hosted portal origin. Omit it for a single-origin installation.                             |
| `SESSION_SECRET`                         | Random secret for session-related cryptography. Rotating it may invalidate active sessions.                        |
| `CREATION_KEY`                           | Server-controlled creation credential in hosted mode. Never embed it in a browser bundle.                          |
| `LIVEKIT_URL`                            | Private API/signaling destination: localhost in development, `http://livekit:7880` inside Compose.                 |
| `LIVEKIT_PUBLIC_URL`                     | Browser gateway origin, such as `ws://localhost:4100`; the SDK appends `/rtc`. It must never point at raw LiveKit. |
| `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | Server-only credentials shared with LiveKit/Egress.                                                                |
| `LIVEKIT_NODE_IP`                        | IP advertised for media candidates. Local setup uses `127.0.0.1`.                                                  |
| `RECORDING_KEK`                          | Base64 encoding of a 32-byte operator-owned recording wrapping key.                                                |
| `RECORDING_ENABLED`                      | Global opt-in; defaults to `false`. Each meeting also controls permission.                                         |
| `RECORDING_DIR`                          | API-visible recording root, containing `raw/` and `encrypted/`.                                                    |
| `EGRESS_FILE_ROOT`                       | Same directory as Egress sees it; `/recordings` in Compose.                                                        |
| `SMTP_*`                                 | Test capture or real SMTP provider configuration.                                                                  |

The script uses atomic exclusive creation for `.env`, generates secrets with the operating system random generator, and gives runtime directories mode `0700` and secret files mode `0600`. It never prints credentials. Existing `.env` values are preserved. Keep an encrypted backup of the recording key separately from database and recording backups; losing it makes existing recordings unrecoverable. The current local key provider does not implement automated key rotation or a managed KMS integration.

## Recording development

```sh
docker compose --profile mail --profile egress up -d
```

After confirming Egress is healthy, set `RECORDING_ENABLED=true` in `.env` and restart the API. Enable recording for an isolated test meeting, verify the host email using the message in Mailpit, then start and stop a silent synthetic video recording. Generate a download link, obtain its separate password from Mailpit, and test successful download, an incorrect password, expiration, and revocation. Enabling the profile alone does not enable recording in the product.

The worker writes `/recordings/raw/<id>.mp4`. The API commits encrypted metadata, removes the raw spool, and only then makes the recording available. Restart recovery completes pending cleanup without requiring a raw file that may already have been removed. The thin `infra/egress.Dockerfile` derives from the pinned official image and remaps Egress's account and home ownership to the host UID/GID produced by bootstrap. Staging fixes both API and recorder to UID/GID 1000. This lets both access the same `0700` spool without opening it to other users. An encrypted development disk is required when testing this spool; use synthetic media. A raw spool file is plaintext until finalized. A crash can leave an unfinished file, so test cleanup and retention before using real recordings.

If starting a recorder fails after the remote job starts, the API attempts to stop it before writing recovery state. A missing job ID is recovered by matching both room and exact output path against Egress. Failed stop/list/database operations remain pending for retry and block a second recording. If the remote job cannot be found, or multiple jobs match, an operator must investigate the Egress state and spool; the API does not silently declare the recording failed or expose uncertain output. Alert on prolonged `starting`, `stopping`, or `encrypting` states.

The production template places raw spools in a bounded shared memory filesystem and stores only the encrypted result on the persistent recording volume. Memory-backed files can still reach swap: disable swap or use encrypted swap on that host. Size and alert on scratch usage, handle full storage, and isolate recording workers. This pinned Egress configuration grants `SYS_ADMIN` for Chrome sandboxing; it must run on a dedicated worker boundary before external deployment. Revisit the upstream sandbox requirements when upgrading. [LiveKit Egress deployment guidance](https://docs.livekit.io/transport/self-hosting/egress/)

The emailed password gates the application download. It is not the storage encryption key. A successful download decrypts to an ordinary MP4; the recipient must protect that file. Link expiry is 24 hours and does not itself delete the stored recording. The current service schedules stored-recording cleanup after seven days; prove that cleanup, failed-file cleanup, and backup expiry work before relying on the retention policy.

Issuing a link emails its password automatically to the verified host. The link is `/download/<meeting-code>#<token>`: the browser fragment is not sent in the initial HTTP request. The page submits token and password in the download request body after the server checks the matching host session, and the server searches only that meeting. Issuing a link extends the existing host session through the link expiry. This first version therefore requires the host's existing browser session; forwarding the link and password does not grant another browser host authority. Host account recovery and cross-device access remain future work. Do not log download request bodies.

## Staging deployment

`infra/compose.production.yaml` is a single-host staging template. It does not establish a high-availability service. Start with a private staging network and synthetic data.

1. Set the real `SITE_ORIGIN=https://…`, `LIVEKIT_PUBLIC_URL=wss://…` (origin only), and reachable `LIVEKIT_NODE_IP` in a protected environment file. Supply SMTP credentials separately from source control.
2. Render configuration with `node scripts/bootstrap.mjs --production`.
3. Validate with `docker compose --env-file .env -f infra/compose.production.yaml config --quiet`.
4. Review and build with `docker compose --env-file .env -f infra/compose.production.yaml build`.
5. Configure the host TLS proxy from `infra/Caddyfile.example`, an explicit trusted-proxy policy, and firewall rules before starting external access.
6. Complete every release gate in `security-controls.md`; keep recordings disabled until their separate gate passes.

The app container listens internally on port 4100 and publishes only to host loopback. LiveKit signaling/API port 7880, PostgreSQL, and Redis have no host mapping. Only media ports 7881/TCP and 7882/UDP are public in the template. Open these at the perimeter only for the dedicated media host. Production clients need a real reachable media address and a TURN/TLS deployment for networks that block direct media. TURN is not included in this starter template. [LiveKit port requirements](https://docs.livekit.io/transport/self-hosting/ports-firewall/)

Forwarded client addresses must be accepted only from the exact trusted proxy, which must replace incoming forwarding headers. An overly broad proxy trust setting makes IP bans and rate limits bypassable. The public ingress must preserve WebSocket upgrades and route `/rtc` through the application gateway. Do not publish the LiveKit management APIs through a general reverse proxy.

The HTTP/TLS proxy must avoid logging host fragments, tokens, passwords, or capability URLs. Do not add third-party scripts to host or download pages. Limit management access to an administrative network. Replace `.env` injection with a deployment secret manager before broader operation; Docker administrators can inspect container environment variables.

Self-hosted operators may use a single origin or configure a separate `PORTAL_ORIGIN`. The closed hosted service requires `.com` for its portal/sign-in and `.io` for meetings; see that repository's dual-host proxy example. Never widen cookies with a `Domain` attribute to link the two sites. Keep portal and meeting sessions independent. A cross-origin host entry uses a one-use fragment capability that the meeting page exchanges and clears; guest entry does not carry host authority.

## Release operations

- Back up PostgreSQL (including branding/settings and uploaded brand images) and encrypted recordings, with the encryption key stored separately. Prove recovery in an isolated environment and record the recovery time.
- Before upgrades, snapshot persistent state and test migration/rollback against a copy. Never run `docker compose down -v` against persistent data unless deletion is intended.
- Drain rooms before replacing media nodes. A single-host stack cannot guarantee uninterrupted calls through host failure.
- Monitor API error rate, join failures, gateway rejections, worker failures, spool space, CPU, memory, packet loss, and unexpected public ports. Redact participant identifiers where not needed.
- Patch pinned images through reviewed changes and re-run security/media gates. Version tags are pinned here; deployment should resolve and retain image digests as part of release evidence.
- Test 100-person meetings and 1,000-viewer webinars under representative media, browsers, phone callers, TURN usage, and failure conditions before selling those capacities. Phone/SIP is not implemented by these templates.

## Dependency pins

Pins were checked against official upstream sources on 2026-10-04. They are selected versions, not a promise that no newer patch exists at deployment time.

| Component  | Pin                     | Source                                                             |
| ---------- | ----------------------- | ------------------------------------------------------------------ |
| Node.js    | `24.21.0-bookworm-slim` | [Official image](https://hub.docker.com/_/node)                    |
| PostgreSQL | `17.11-alpine3.23`      | [Official image](https://hub.docker.com/_/postgres)                |
| Redis      | `8.2.10-alpine3.22`     | [Official image](https://hub.docker.com/_/redis)                   |
| LiveKit    | `v1.13.7`               | [Release](https://github.com/livekit/livekit/releases/tag/v1.13.7) |
| Egress     | `v1.14.1`               | [Release](https://github.com/livekit/egress/releases/tag/v1.14.1)  |
| Mailpit    | `v1.31.4`               | [Release](https://github.com/axllent/mailpit/releases/tag/v1.31.4) |

The repositories remain private during development. The core uses Apache-2.0; public release still requires checking dependency obligations; Redis 8 has a choice of licenses that must be reviewed for the distribution and hosting model. [Redis licensing](https://redis.io/legal/licenses/)
