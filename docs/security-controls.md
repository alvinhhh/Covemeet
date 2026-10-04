# Security controls and release gates

This file separates implemented mechanisms from unproven deployment claims. The design targets in `infrastructure-plan.md` remain broader than the first milestone. Passing application tests is evidence for specific behavior; it is not evidence that a deployment meets every SOC, ISO/IEC, FedRAMP, GDPR, or HIPAA requirement.

The [requirements ledger](requirements-ledger.md) maps the full plan to implementation evidence and remaining gates. The [isolated local HTTPS workflow](local-https.md) adds separate origins and removes raw SFU host publication without silently trusting a local CA; it does not close the media, capacity, telephony or compliance gates.

## Boundary

The first installation has one application tenant. The browser is untrusted. The application owns admission and host authority; LiveKit owns media forwarding. Egress is a trusted recording participant with access to plaintext media. The operator controls PostgreSQL, media infrastructure, SMTP, and the recording wrapping key. The private hosted wrapper must provision an isolated core installation or add verified tenant isolation before selling shared hosting.

Transport encryption does not make meetings end-to-end encrypted from the operator. The SFU and recorder are inside the trusted boundary. End-to-end media key distribution and its recording/phone incompatibilities are a later milestone.

## Control status

| Control                            | First milestone                                                                                                        | Required release evidence                                                                                                                                           |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosted meeting codes               | Server generates high-entropy codes; custom codes belong only to self-hosted mode.                                     | Property/API tests covering entropy format, rejection of hosted overrides, collision handling, and enumeration limits.                                              |
| Host authority                     | Separate one-time capability exchanged for an HTTP-only session.                                                       | Replay, session fixation, role spoofing, cross-meeting access, CSRF, and XSS review.                                                                                |
| Lobby and lock                     | Admission is evaluated by the application.                                                                             | No media before admission; lock blocks new joins while defined reconnect behavior remains consistent.                                                               |
| Kick and meeting ban               | Distinct application actions; optional IP and device matching.                                                         | Disconnect the current participant; deny stale-session reconnects; validate regular kick versus occurrence ban behavior.                                            |
| Device/IP matching                 | Installation-scoped browser marker and observed IP are limited signals.                                                | Verify trusted proxies; document shared-IP effects and cookie reset/VPN bypass; retain only as long as needed.                                                      |
| Microphone and camera restrictions | Server updates allowed publish sources and participant state.                                                          | Modified client cannot publish a blocked source; active tracks stop; reconnect cannot restore stale grants.                                                         |
| Signaling gateway                  | Browser access passes through current application admission. Production raw signaling has no host port.                | Direct-node access fails; all initial, resume, full-reconnect, token-refresh, and SDK fallback paths are covered.                                                   |
| Recording encryption               | Authenticated chunks and per-file wrapped keys; operator keyring/KMS and ciphertext S3 adapters.                       | Corruption, truncation, reordered frames, swapped metadata, wrong context/key, and incomplete-file tests. Independent cryptographic design review before real data. |
| Recording delivery                 | Verified host email, separate emailed password, host session, 24-hour link, and revocation.                            | Unauthorized download, brute force, expiry, revoke, email failure, and wrong-session tests. No passwords/tokens in logs.                                            |
| Recording opt-out                  | Global off by default and per-meeting permission.                                                                      | No recorder starts while disabled; disabling during active capture has a defined stop behavior.                                                                     |
| Plaintext spool                    | Dev spool on restricted local storage; isolated HTTPS/staging templates use bounded shared tmpfs.                      | Crash recovery, orphan deletion, no durable plaintext, encrypted swap, capacity handling, and verified retention.                                                   |
| Network isolation                  | Loopback dev ports; private DB/Redis/raw signaling in staging template.                                                | External port scan, SSRF review, service-to-service access review, secret rotation, TURN configuration.                                                             |
| WebRTC encryption                  | Uses the chosen media stack's WebRTC transport implementation.                                                         | Browser/stack interoperability and protocol/cipher evidence; do not claim every IETF RFC is implemented.                                                            |
| Capacity and resilience            | Logical limits: 100 meeting participants; 1,000 webinar viewers plus ten stage members. Media load remains unverified. | Load test, multiple browsers, network impairment, TURN, recording, node loss, restore, and cost evidence.                                                           |
| Phone/SIP                          | Planned.                                                                                                               | Trunk authentication, separate keypad credentials, toll-abuse limits, caller moderation, and honest PSTN encryption disclosure.                                     |
| Retention and privacy              | Design requirements only beyond local application state.                                                               | Deletion workflow, backup expiry, audit retention, data inventory, subprocessors, incident response, rights handling, and operator procedures.                      |

Local TLS and a 41-check silent real-media harness have passed against the isolated Docker installation. The [requirements ledger](requirements-ledger.md) records their scope; audio packet behavior, browser device controls, failure injection, restricted networks and load remain distinct evidence requirements. Recording provider configuration and remaining cloud/storage gates are in [recording storage](recording-storage.md).

## Media gate: mandatory before external use

Self-hosted LiveKit does not provide automatic token revocation. A short token lifetime alone cannot prove removal: issued or refreshed tokens can remain usable. The gateway must check current application state on every supported connection path, and the media server must not be directly reachable by participants. [LiveKit token guidance](https://docs.livekit.io/frontends/reference/tokens-grants/)

Run this matrix against the exact deployed server and browser SDK versions, with an unmodified browser and a deliberately modified client:

1. A waiting guest cannot connect to media or use another guest's identity.
2. Kick stops existing media. The old session and media token cannot reconnect. A fresh join follows the configured lobby policy.
3. Meeting ban additionally blocks matching device/IP signals for that occurrence. Changing those signals is documented as a limitation of anonymous access.
4. Lock rejects new participants, stale tokens, and unauthorized phone admission. Explicitly test existing admitted reconnects.
5. Blocking audio/video stops the current source and prevents republishing it. Grant changes remain enforced through network loss and token refresh.
6. Ending a meeting disconnects everybody and prevents resurrection through old credentials.
7. There is no bypass through a raw SFU address, alternate hostname, fallback endpoint, or trusting an unverified forwarded IP.
8. Application restart and database failure fail closed for new admission. Revocation after gateway restart is tested.

Store test versions, configuration, timestamps, and results in release evidence. Any failure blocks external release; disabling a UI button does not satisfy the gate.

## Standards target

Applicable WebRTC transport references include [RFC 8827](https://www.rfc-editor.org/rfc/rfc8827), [DTLS-SRTP, RFC 5764](https://www.rfc-editor.org/rfc/rfc5764), and [SRTP, RFC 3711](https://www.rfc-editor.org/rfc/rfc3711). Support must be described by actual negotiated protocols and tested behavior. TLS terminates at the application edge; DTLS-SRTP protects browser media transport. Plain local HTTP development is not a production encryption configuration.

Control alignment is an operating obligation as well as a code obligation. SOC 2 requires defined controls and evidence over the relevant scope; ISO/IEC 27001 includes a maintained information security management system; FedRAMP adds deployment-boundary, assessment, monitoring, and cryptographic requirements. GDPR and HIPAA applicability also depends on data use, roles, contracts, and operating practice. No certification is required to start implementing strong controls, and skipping certification does not establish that all requirements are met.

The first milestone lacks a complete control register, documented owner/evidence for every applicable requirement, validated FIPS cryptographic boundary, independent penetration test, operational recovery evidence, and privacy/legal process validation. Those gaps remain open even when every automated test passes. See the full plan for the control mapping and implementation sequence.
