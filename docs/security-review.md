# Security controls and verification

This document describes the implemented security boundaries and the checks required before deployment. See [security controls](security-controls.md) for the control register and [requirements](requirements-ledger.md) for remaining work.

## Admission and moderation

- Guest links and meeting codes do not grant host authority. Host bootstrap capabilities are exchanged once, cleared from the URL fragment, and replaced with a host-only cookie.
- Public media signaling requires both an active application session and its scoped media token. Raw SFU signaling must remain private.
- Admission, role changes, room moves, kick, ban, lock and source permissions are enforced by the API and media gateway. Permission changes rotate physical media identities; stale cleanup cannot remove a successor connection.
- Cleanup remains pending until media, recorder and phone resources are confirmed closed. A failed sweep must not prevent other rooms from being processed.
- Meeting-scoped IP and browser markers support bans but cannot permanently identify an anonymous person.

## Recordings and downloads

Recording is off by default. Starting it requires host authorization and a verified delivery address. Finalized output is encrypted before durable storage; raw capture uses bounded temporary storage.

PostgreSQL ownership and connection-bound writes fence stale recording workers. Encryption attempts have immutable output identities so a losing worker cannot overwrite the winner. Unknown start, stop, upload or deletion outcomes retain their cleanup state.

Download capabilities expire after 24 hours, require a separate password, and remain subject to host authority and revocation during streaming. Capabilities stay in URL fragments and request bodies, rather than navigation queries. Password delivery uses the verified host address. Key rotation, retained old keys and storage recovery are deployment responsibilities documented in [recording storage](recording-storage.md).

## Phone isolation

Each SIP caller enters a separate holding room. The application audio relay connects that caller to meeting media only after admission and while its short authorization lease remains valid. Both SIP legs require TLS/SRTP; ordinary PSTN transport is outside that boundary.

The supervisor records allocation intents and confirmed ownership before acknowledging cleanup. Unknown operations and colliding resources retain capacity. Single-host recovery fences the old supervisor/PBX/SIP containers before reconciling exact recorded native resources. See [phone/SIP design](phone-sip-design.md) for the runtime contract and remaining carrier work.

## Verification

Run the ordinary source checks after code changes:

```sh
npm run check
npm test
npm run build
```

Use the isolated commands in [verification](verification.md), [local HTTPS](local-https.md), [media validation](../scripts/validation/README.md), [storage testing](storage-test.md) and [phone/SIP validation](phone-sip-design.md#local-validation) for the relevant runtime boundary. Keep generated reports outside Git.

Deployment verification must cover:

1. Browser interoperability, ordinary UI/device behavior, forced TURN fallback and external network restrictions.
2. Direct-SFU denial, stale tokens, reconnect races, source restrictions and actual receiving-client media removal during dependency failures.
3. Recorder interruption, exhausted scratch storage, disable/revocation during capture, provider ambiguity, encrypted backup restoration and key loss/rotation.
4. Carrier negotiation, toll-abuse limits, redial isolation and cleanup of both phone legs.
5. Representative meeting/webinar load, mass reconnect, node loss and measured operating cost.

## Logging and operational controls

LiveKit signaling uses token query parameters. Redact the complete handshake query at every proxy, trace and error boundary; the supplied edge configuration disables access logs for these paths. Keep meeting passwords, capabilities, keypad PINs, recordings and private messages out of routine telemetry.

Restrict database, media, storage, mail and management credentials to their services. Maintain dependency updates, vulnerability handling, access reviews, backup/restore procedures and incident response. Standard SFU media is encrypted in transit but available to the media processors; operator-inaccessible end-to-end encryption is a separate feature.
