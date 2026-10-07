# Requirements and release gates

This is the product and deployment checklist for the open-source core and its hosted integration. Architecture is described in [the infrastructure plan](infrastructure-plan.md); concrete controls are listed in [security controls](security-controls.md).

## Product requirements

- Browser-only meetings with account-free guests, a prejoin microphone/camera check, guest links or code/password entry, and separate host authority.
- Meetings for up to 100 participants; webinars for up to 1,000 viewers with a separate ten-member stage. Capacity must be measured on the deployed hardware.
- Waiting room, kick versus meeting ban, meeting lock, microphone/camera/share restrictions, co-hosts, hand raising, chat moderation, breakouts and an infinite whiteboard.
- Webinar backstage, presenter preflight, start/end broadcast, stage promotion and recording that excludes private backstage media.
- Optional encrypted recordings, verified-host password delivery, revocable 24-hour download links, and self-hosted control of encryption keys.
- Audio phone/SIP admission through a separate locator/PIN, with the same lobby, permission and removal policy as browser guests.
- Custom branding and landing pages. Hosted portal/sign-in uses `covemeet.com`; meetings and join links use `covemeet.io`. Automated mail uses `.io`.
- An independently usable Apache-2.0 core and a separate proprietary hosted service for accounts, subscriptions and operations.

## Hosted policy

Verified, non-suspended accounts can host on Free without payment or manual approval. Free permits 100 participants and has no deadline with one or two admitted participants. Admitting a third sets the deadline to meeting start plus three hours; removing participants does not reset it. Personal sessions last up to 24 hours and Teams sessions up to 30 hours. Teams permits 1,000 webinar viewers plus ten stage members. Named hosts have one active room each.

Paid grants have no cumulative monthly meeting-time or recording-time cap. Hosted capture uses 720p24. Current policy retains paid eligibility, meeting deadlines, storage/download allowances and seven-day recording retention. Legacy numeric grants remain enforceable until refreshed. Admission and cleanup share capacity accounting across browser peers, phone legs and breakouts; unresolved cleanup keeps its reservations.

## Implementation and remaining work

| Area | Implemented boundary | Remaining deployment or product work |
| --- | --- | --- |
| Guest and host authority | Random 130-bit hosted codes; separate one-use host capabilities; signed host-only sessions; server authorization | Invitation/recovery abuse checks and supported-browser coverage |
| Moderation and reconnect | Admission gateway, versioned permissions, physical media identities, pending cleanup and scoped co-host controls | Dependency failures, hostile reconnect, paired API/browser rollout and emergency termination |
| IP/device bans | Meeting-scoped signed browser marker and keyed network matching | Proxy configuration, shared-network impact, retention and reversible bans |
| Collaboration | Breakouts, scoped chat/private messages, chat moderation, whiteboard, hand raising, host succession and absence grace | Mobile/accessibility polish, reactions, polls, Q&A and advanced stage/layout controls |
| Webinars | Separate audience/stage limits, backstage lifecycle and stage-only recording path | Full-size media load, presenter/device workflows, reconnect and receiving-client isolation checks |
| HTTPS and signaling | Separate origins, exact proxy trust, cookie-bound signaling and private backend listeners | Public certificate renewal, external port/firewall checks and production logging configuration |
| WebRTC/TURN | SFU transport and authenticated relay fixtures | Chrome/Firefox/Safari/mobile interoperability, ordinary UI fallback, external restrictive networks and packet-level protocol checks |
| Recording access | Host opt-in, verified delivery address, encrypted output, password-gated links, expiry/revocation and recording-only host recovery | Provider mail delivery/retry, active-transfer revocation across processes and mid-capture disable under failure |
| Recording storage | Worker ownership, immutable attempts, bounded raw scratch, durable deletion state, storage reservations and operator keys | Production IAM/KMS, key rotation/loss, backup restoration, storage outages and legacy inventory migration |
| Retention | Recording access cutoff, cleanup and hosted account erasure with revival protection | Data-specific retention/deletion for chat, audit, IP/device records, derivatives, object versions and backups |
| Phone/SIP | Separate holding rooms, ARI supervisor, authorization leases, journaled allocations and single-host fencing/recovery | Carrier integration, production private TLS, fraud/spend controls, concurrent calls, recording notices/consent and phone breakouts |
| Hosted integration | Account-owned metadata, authority versions, durable delivery and expiring plan grants | Deployed account/billing/provider lifecycle checks and service-specific operational controls in the private hosted repository |
| Customer isolation | One installation tenant, account ownership checks and separate core/hosted credentials | Cross-customer database, events, media, storage, keys, jobs and support-access verification before expanding shared hosting |
| Durable operations | PostgreSQL state, revision checks, idempotent creation and reconciliation workers | Upgrade/rollback, process/network interruption and replica recovery across each provider boundary |
| Deployment | Container setup, persistent volumes, local HTTPS and health/network checks | Fresh-machine installation, signed/provenanced images, separate staging secrets and production rollback |
| Capacity and cost | Logical participant/stage/concurrency limits and bounded subscriptions | Representative 25/50/100-person meetings, 1,000-viewer webinars, TURN/recording load, node loss, draining and measured cost |
| Recovery and monitoring | Health checks, selected audit events and scoped failure tests | Off-host backups, restore/reopen drills, RPO/RTO, bounded telemetry and incident exercises |
| Security operations | Dependency locks, pinned CI actions, production npm SBOM/audit artifacts and automated source/integration checks | OS/native image scanning, deployed-image provenance, access/secrets rotation and vulnerability response |
| Private/E2EE mode | Standard media currently trusts the SFU and recorder | Authenticated group keys, rekeying, encrypted collaboration and browser support; phone/recording compatibility must follow the chosen trust model |
| Organizational controls | Technical control register and documented boundaries | Defined scope, owners, policies, contracts, privacy rights, operating evidence and any required external assessment |

## Recorded validation evidence

Validation commands and their scope belong in the repository. Generated execution reports, local image IDs, timestamps and work logs do not.

```sh
npm run check
npm test
npm run build
```

Additional checks are documented in:

- [Verification](verification.md): source and opt-in integration checks.
- [Local HTTPS](local-https.md): certificate, origin, listener and lifecycle checks.
- [Media validation](../scripts/validation/README.md): silent real-media moderation, webinar/recording isolation, lifecycle and TURN checks.
- [Storage testing](storage-test.md): encrypted local/object-storage behavior.
- [Phone/SIP design](phone-sip-design.md#local-validation): relay, native SIP and recovery fixtures.

Run the checks relevant to a changed boundary against the source and configuration intended for deployment. A logical admission test exercises limits; a load test must connect representative clients and media. Provider delivery, carrier behavior and recovery require their own deployed checks.

## Authoritative technical boundaries

- [TLS 1.3, RFC 8446](https://www.rfc-editor.org/rfc/rfc8446), [WebRTC security, RFC 8827](https://www.rfc-editor.org/rfc/rfc8827), [DTLS-SRTP, RFC 5764](https://www.rfc-editor.org/rfc/rfc5764), [SRTP, RFC 3711](https://www.rfc-editor.org/rfc/rfc3711), [ICE, RFC 8445](https://www.rfc-editor.org/rfc/rfc8445), [TURN, RFC 8656](https://www.rfc-editor.org/rfc/rfc8656): record actual negotiated behavior; a list of RFCs is not a conformance result.
- [LiveKit token lifecycle](https://docs.livekit.io/frontends/reference/tokens-grants/) and [distributed deployment](https://docs.livekit.io/transport/self-hosting/distributed/): keep raw signaling private, test revocation, and account for a room's single-node boundary.
- [LiveKit Egress requirements](https://docs.livekit.io/transport/self-hosting/egress/): recordings need separately sized/isolated workers; tests must include failures and resource exhaustion.
- [Caddy trust controls](https://caddyserver.com/docs/caddyfile/options#skip-install-trust): local trust installation is explicitly disabled. [Local HTTPS workflow](local-https.md) distinguishes verified CLI transport, opt-in trusted browser relay evidence and the remaining production checks.
