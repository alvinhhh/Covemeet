# Covemeet

Browser meeting software with guest access, host moderation, and an independently deployable core. The intended public source is this repository, under Apache-2.0. The paid service lives in the separate private `CovemeetHosted` repository and consumes a pinned core revision.

This is milestone one. It is for local evaluation and controlled development. The 100-participant meeting and 1,000-viewer webinar numbers are design targets, not demonstrated capacity. Phone/SIP, end-to-end encrypted rooms, billing, and audited operational controls are not part of this release.

## Local HTTPS installation

Run `node scripts/local.mjs start` for separate `https://portal.localhost:8443` and `https://meet.localhost:8443` origins, private raw signaling, and isolated local data. The [HTTPS workflow](docs/local-https.md) explains explicit browser certificate trust, optional hosted portal and recording, health checks, and stopping without deleting data. No command silently installs certificate trust.

## Development setup

Requirements: Node.js 22.12 or later, npm, and Docker Compose. Node 24 is used in the container build.

```sh
npm ci
node scripts/bootstrap.mjs
docker compose --profile mail up -d
npm run dev
```

Open `http://localhost:5173`. The API runs on port 4100. Mailpit captures test messages at `http://localhost:8025`; it does not deliver email externally. PostgreSQL uses local port 55432.

The setup script creates fresh local secrets, restricts file permissions, and renders the private LiveKit configuration. Re-running it preserves `.env`. Never commit `.env`, `runtime/`, recordings, or host capability links.

Create a meeting, keep the host page open, and use a separate browser profile to join with the guest link and meeting password. The host admits waiting participants. Test microphone/video with synthetic media before adding real users. Local services bind to loopback and are not a remote deployment.

## Features in the first milestone

- Guest links and meeting code plus password entry; one-time host capability exchange.
- Lobby, meeting lock, admit, kick, meeting ban, microphone/video restrictions, and viewer/presenter roles.
- Breakout rooms with room-scoped chat, return-to-main controls, and host announcements.
- Hosted random meeting codes; custom codes only in the self-hosted edition.
- LiveKit media behind the application signaling gateway; raw media-server access is private outside development.
- Optional encrypted recordings, operator keyring/KMS adapters, private ciphertext object-storage adapter, verified host email, revocable 24-hour download links, and separate email passwords. Real provider configuration remains a deployment gate.
- Operator-controlled branding, uploaded logo/background images, and configurable landing-page settings.

Recordings are disabled by default. Start the optional Egress profile and complete the recording checks in [deployment.md](docs/deployment.md) before enabling them. An IP/device ban cannot identify the same person after they change networks or clear browser data. Downloaded MP4 files are plaintext on the receiving device.

## Verification

```sh
npm run check
npm test
npm run build
docker compose config --quiet
```

Unit and API tests do not establish WebRTC interoperability, resilience, or capacity. The silent real-media harness in `scripts/validation` tests selected deployed controls. The evidence and remaining gates are tracked in [security-controls.md](docs/security-controls.md) and the [requirements ledger](docs/requirements-ledger.md).

The experimental phone admission and audio-relay implementation is disabled by default. `node scripts/phone-test.mjs` builds a separate disposable PostgreSQL/SFU fixture, tests concurrent admission through independent API instances, and checks generated audio through programmatic sinks without speakers or personal devices. It does not connect to a carrier or prove SIP trunk negotiation. Read [phone-sip-design.md](docs/phone-sip-design.md) before configuring it; native SIP must never dispatch directly into meeting rooms.

## Deployment and scope

Use [deployment.md](docs/deployment.md) for configuration and [infrastructure-plan.md](docs/infrastructure-plan.md) for the complete design. The production Compose file is a staging template; it needs TLS, TURN, backup/restore, network isolation, abuse controls, and the documented security gates before public operation.

This repository makes no claim of SOC 2 attestation, ISO/IEC certification, FedRAMP authorization, HIPAA compliance, or GDPR compliance. The intended target is demonstrable control alignment, supported by implementation and operating evidence. The framework names do not certify this code.
