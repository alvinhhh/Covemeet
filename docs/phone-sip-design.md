# Phone admission and isolated audio relay

Status: experimental, disabled by default. The application authority, audio relay, private Asterisk ARI supervisor and native SIP holding adapter are implemented. `scripts/phone-test.mjs` checks the RTC relay; `scripts/sip-test.mjs` separately exercises a native SIP client. Consult each generated report for its actual passing scope. There is no carrier integration or production service launcher yet. Do not publish a dial-in number from this milestone.

## Admission boundary

Each native SIP dialog must enter its own private, empty holding room. It must never dispatch directly to a Covemeet meeting. The application owns the 12-digit locator, separate 8-digit PIN, host lobby, lock/ban/permission decisions, and capacity reservation. A trusted relay connects the holding caller to the meeting only through the normal cookie-bound signaling gateway.

```mermaid
flowchart LR
  Caller[Phone or SIP endpoint] --> PBX[Asterisk IVR and call control]
  PBX --> SIP[Private LiveKit SIP service]
  SIP --> Hold[Unique holding room per dialog]
  Hold <--> Relay[Application audio relay]
  Relay --> Auth[Private admission authority]
  Relay <--> Gateway[Cookie-bound meeting gateway]
  Gateway <--> Meeting[Meeting SFU room]
```

A stale SIP dispatch can recreate only an empty holding room. The relay's main-room token is short-lived, tied to the application participant session and current media policy, and accepted only with its matching cookie. It receives no browser host capability. Native participant IDs and relay participant IDs are distinct and mapped by the trusted call supervisor.

LiveKit documents `MoveParticipant` and `ForwardParticipant` as Cloud-only. The self-hosted implementation therefore does not use either as its admission boundary. [Participant management](https://docs.livekit.io/intro/basics/rooms-participants-tracks/participants/#move-participant)

The pinned LiveKit SIP 1.17.0 callee dispatch uses `randomize: true`, an empty prefix and a supervisor-generated `phone-hold-<UUID>` destination. Its room has an additional randomized suffix and a two-participant limit. The adapter requires exactly one matching room and one native SIP participant bound to the configured trunk/rule before bridging. The PBX uses the fixed opaque From user `covemeet-pbx`; `hidePhoneNumber` maps this to a fixed hashed identity, never the original caller ID. Native SIP digest authentication and the exact private PBX address restrict trunk entry. Never introduce a shared catch-all meeting route. [Dispatch rules](https://docs.livekit.io/telephony/accepting-calls/dispatch-rule/)

## Implemented relay behavior

- `HttpAuthority` calls only the fixed private API paths. Requests use `Bearer PHONE_GATEWAY_KEY` and `X-Requested-With: CovemeetPhone`, with no browser Origin. Endpoint validation requires verified TLS in production; redirects are rejected and responses are capped at 65 KiB while streaming.
- Join returns a meeting code, participant ID, opaque session, and expiry. Polling every two seconds renews a lease of at most ten seconds. Lease expiry or an authority failure synchronously gates audio and begins teardown, even if an authority request is stalled.
- Waiting callers have no meeting media grant. Admission supplies the cookie-bound token, gateway origin, and explicit peer media identities whose microphone or shared-audio tracks may be received. These identities rotate with permission changes; dialog and participant IDs stay stable. Video, data, unrelated identities, and the relay's own output are not subscribed or forwarded.
- Caller-to-meeting audio is published only when admitted, self-unmuted, and allowed by the host. Phone callers start muted. Host permission or media-generation changes clear queued PCM and replace the meeting leg. Expected removal of that leg for a policy change leaves the isolated caller connected while a fresh poll authorizes the replacement.
- Audio is decoded/mixed using `@livekit/rtc-node` 1.1.0 `AudioMixer`: 48 kHz mono, 20 ms frames, bounded queues. Silent frames maintain the private return stream while waiting. This adds codec work and latency; capacity has not been benchmarked.
- The SDK cannot attach the application cookie directly. A per-call, loopback-only gateway adapter inserts that fixed cookie and Origin. It forwards SDK-refreshed tokens to the real gateway for validation and updates authority-issued token renewal without reconnecting on every poll. It cannot mint tokens or turn an arbitrary supplied token into a valid one.
- `*6` toggles self-mute and `*9` toggles hand raise. A blocked caller cannot regain speaking permission. The standalone RTC relay accepts commands only from the known native participant. With Asterisk, only the original ARI caller channel controls keypad actions; forwarded native DTMF is ignored to prevent double toggles. The supervisor implements `*0` help, waiting/admission and mute/block announcements. Numeric credentials are collected before any native bridge exists. Recording notices/consent are not implemented; recording remains incompatible with active phone participation.
- Terminal close waits for in-flight gateway opening, RTC connection and track publication before acknowledging cleanup. Failed legs retain their teardown owner. The standalone RTC test harness acknowledges `leave` only after both media paths close. For native journaled calls, `leave` does not release capacity: only the current owner's verified journal `finish` can do so. An uncertain teardown retains the reservation.

The official SIP DTMF feature transports keypad events; the relay still requires an IVR to collect and validate entry credentials before a meeting grant exists. [DTMF handling](https://docs.livekit.io/telephony/features/dtmf/)

## Durable dialog lifecycle

The native supervisor reserves installation-wide capacity in a persisted dialog journal before answering or collecting a locator/PIN. The record contains a process owner UUID, operator-configured PBX ID/epoch, exact caller channel, trunk/endpoints and SIP trunk/rule IDs. It does not store entered credentials, session capabilities or caller numbers. `HttpAuthority` validates bounded journal responses; the journal client serializes mutations, refreshes the record and supplies its expected revision for each write.

Before each answer, playback, outbound originate, bridge creation or bridge attachment, the supervisor persists an intent. Playback IDs are derived from the dialog and persisted revision before their ARI request. Responses settle the operation as confirmed, rejected or unknown. Local terminal checks run again inside mutation callbacks after the intent round trip, so a late acknowledgment cannot initiate a new ARI request after local termination. Playback cancellation still waits for pending creation and settlement before deletion.

A successful application join atomically binds the journal to the meeting participant and bumps its revision. Subsequent polling uses the returned session; a lost join response can still be revoked by stopping the exact journal. The holding room SID, native participant SID and verified fixed identity are recorded before bridging. Journals cannot authorize another process's dialog or create a meeting grant themselves.

Stopping first marks the local call terminal, waits for initial setup and attempts journal revocation before native/RTC teardown. Cleanup is still attempted if the authority is unavailable, but failure cannot release the reservation. `finish` accepts only the same process owner and expected revision with a complete cleanup proof. The trusted supervisor submits that proof only after allocations have stopped and the caller, outbound leg, bridge, native participant, holding relay and RTC connections have been confirmed absent/closed; the API does not independently inspect the PBX. The adapter tracks successful creation of each outbound channel and bridge separately; a name match or `409` does not prove ownership. It preserves colliding/unowned resources, removes only verified owned native peers, and rejects completion while any holding peer remains. Pending, unknown or sticky-uncertain operations prevent `finish`, even if an immediate resource lookup returns absent.

A definitive rejected reservation permits releasing the local slot only after caller cleanup. A lost create response retains the local slot and, when creation reached the authority, its global reservation. Disabling phone admission blocks new reservations and allocation intents; authenticated journal query/stop/finish and existing-call `leave` remain available for teardown.

Registry initialization acquires a persisted, non-expiring PBX claim before checking unresolved journals. PostgreSQL serializes this claim with capacity, join and allocation-intent writes. Only the active owner and exact PBX epoch may reserve, join or begin new work. Concurrent empty starts cannot both acquire ownership. No timer, process restart, changed label or missing channel transfers ownership.

The supported recovery topology is one dedicated supervisor, Asterisk and native SIP container on the same Docker host, with the database and SFU surviving replacement. The separate manager verifies the Docker daemon ID, exact immutable container IDs, Compose project and PBX/owner/role labels. It persists `fencing`, disables restart and removes the old supervisor first, then the old PBX and SIP containers. The supervisor never receives the Docker socket. The manager accepts already absent immutable container IDs only on the original daemon, allowing recovery after a manager crash; a missing ARI resource is not equivalent evidence. Deletion or inspection failures abort recovery.

After new PBX/SIP containers start, the manager verifies their new IDs and PBX boot digest before reconciling old dialogs. It revokes each bound meeting participant, removes only the recorded holding room/native SID with matching identity/trunk/rule, waits for the terminated relay to disappear, rechecks the holding scope, and submits normal finish proof. The manager observes relay departure for up to 30 seconds and retains capacity if it is still present. The pinned LiveKit 1.13.7 server allows [15 seconds for ICE failure](https://github.com/livekit/livekit/blob/v1.13.7/pkg/rtc/transport.go#L75), followed by [five seconds for participant cleanup](https://github.com/livekit/livekit/blob/v1.13.7/pkg/rtc/participant.go#L2573); an earlier five-second recovery bound raced that normal expiry. Pending, unknown, sticky-uncertain or colliding resources remain reserved and block takeover. Only after every old journal closes does an atomic compare-and-swap install the replacement owner. Multi-host automatic takeover and clearing ambiguous provider outcomes are unsupported.

## Runtime contract

`npm run build -w apps/phone` builds the package. `npm start -w apps/phone` runs only the standalone call-file test harness: it requires both `PHONE_ENABLED=true` and `NODE_ENV=test`. Outside test mode the unjournaled harness refuses to start. The native fixture composes `SipSupervisor`/`SipHolding`; deployment wiring must use a distinct owner UUID per supervisor container and the managed ownership protocol below.

Single-host management command: `npm run phone:manage -w apps/api -- claim|fence|recover`. Build the API first. Run this outside the supervisor with the private API database/media environment and the local Docker socket. `PHONE_MANAGED_FILE` names a regular JSON file not writable by group/others; it contains `{pbxId, ownerId, pbxEpoch, runtime: {daemonId, project, supervisor, pbx, sip}}`. Container IDs are full 64-character IDs, and `pbxEpoch` is SHA-256 of `pbxContainerId:StartedAt` from Docker inspection. Each managed container must carry exact `io.covemeet.phone.pbx`, `io.covemeet.phone.owner` and `io.covemeet.phone.role` labels, plus its Compose project label. Roles are `supervisor`, `pbx`, and `sip`.

Create the supervisor container with a fresh UUID and no restart policy; obtain and persist all runtime IDs before starting it. `claim` verifies that runtime and acquires ownership, then the supervisor's `JournalRegistry` confirms the same claim before ARI connects. To replace it, `fence` uses the persisted original runtime; set `PHONE_PREVIOUS_OWNER_ID` to that exact old UUID. Create fresh PBX/SIP and supervisor containers, update the manifest, then run `recover` with the same previous-owner UUID before starting the replacement supervisor. The API exposes no takeover endpoint. Stop if either command fails; retained reservations are not an instruction to delete database rows.

Test-harness environment:

| Setting                                 | Purpose                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| `PHONE_CALL_FILE`                       | Ephemeral JSON call input on a private tmpfs; format below.                      |
| `PHONE_AUTHORITY_URL`                   | Private API origin; no public route, arbitrary path, redirect or browser access. |
| `PHONE_GATEWAY_KEY`                     | Separate service credential shared only with the private authority.              |
| `SITE_ORIGIN`                           | Meeting application's origin; pins the media grant destination.                  |
| `LIVEKIT_URL`                           | Private RoomService endpoint used for scoped native participant removal.         |
| `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` | Private media service credentials; never expose to callers.                      |
| `NODE_ENV`                              | Must be `test` for the standalone call-file harness.                             |

Call-file shape (values below are placeholders, not a usable call):

```json
{
  "join": {
    "locator": "12 numeric digits",
    "pin": "8 numeric digits",
    "callId": "UUID bound to the real dialog",
    "trunkId": "authenticated-trunk-id"
  },
  "holding": {
    "url": "wss://private-sfu.example",
    "token": "holding-room-only relay token",
    "roomName": "phone-hold-unique-dialog-identifier",
    "participantIdentity": "exact-native-caller-identity"
  }
}
```

The caller ID is optional E.164 input and is not proof of identity. The supervisor must obtain it from an authenticated call path, treat it as untrusted, and keep it out of routine logs/media metadata. It must also bind the call UUID and holding-room identity to the same live dialog; they must not be supplied by an arbitrary client.

The file reader refuses symlinks, nonregular files, another user's files, group/other permissions and content over 32 KiB. It reads through the same opened file descriptor. The supervisor must create the file privately (0600), preferably on tmpfs, and delete it after the call is consumed. The CLI does not delete the caller-owned input. PIN/caller fields are cleared from retained JavaScript objects after joining, but JavaScript cannot guarantee secure memory erasure. Do not put raw PINs, tokens, cookies, call input or caller IDs in command arguments, images, committed configuration, telemetry or crash reports.

The test-only call-file CLI removes only its scoped native participant; it cannot substitute for the journaled supervisor. The native `SipSupervisor` + `SipHolding` composition owns the caller and its confirmed outbound/bridge allocations, verifies native/RTC closure, and then finishes its journal. Unknown mutation/cleanup outcomes retain the reservation and local slot. The separate Docker manager can reconcile confirmed orphan work after destroying its original runtime; unknown outcomes remain reserved. A hung native SDK operation deliberately prevents cleanup acknowledgment rather than freeing a possibly active reservation.

## Native supervisor and fixture

`AriClient` uses a fixed private management origin, header-only authentication, bounded messages/responses, heartbeat and terminal failure handling. Production mode requires HTTPS/WSS with certificate validation. Each inbound call must use the expected PJSIP endpoint, context and extension. After answering, both `CHANNEL(pjsip,secure)` and `CHANNEL(rtp,secure)` must report encryption before numeric credentials are collected. The outbound leg receives the same checks. [Asterisk channel fields](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Dialplan_Functions/CHANNEL/)

Code/PIN entry is bounded to 12/8 digits, 60 seconds and a 32-event queue. The PBX bridge explicitly requests `mixing,proxy_media,dtmf_events`, so Asterisk stays on the media/event path. Mandatory waiting/admission notices finish before meeting media opens; cancellation waits for an in-flight announcement creation before deleting it. The native service first subscribes to a silent return track in its isolated holding room while ringing; only an answered, encryption-verified leg is bridged to the original caller. Terminal closure waits for late setup and both media legs. The local cap is at most 20 calls, including unresolved teardown. [ARI mixing behavior](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/Introduction-to-ARI-and-Bridges/ARI-and-Bridges-Basic-Mixing-Bridges/)

`npm run test:sip` builds pinned Asterisk 22.11.0, LiveKit SIP 1.17.0 and a PJSIP 2.17 client with physical sound/video backends disabled. A disposable internal Docker network contains PostgreSQL, Redis, SFU, PBX, native SIP and the test runner. It has no host-published ports. The test creates its own short-lived CA and never installs it into a trust store. Generated credentials and volumes are removed afterward. Do not reuse this development fixture for deployment: its isolated ARI/SFU control uses HTTP/WS, Redis has no production access policy, and it has no carrier route.

Both SIP legs require verified TLS and [SDES-SRTP (RFC 4568)](https://www.rfc-editor.org/rfc/rfc4568); the client asserts the negotiated suite. Native SIP cannot disable its built-in plaintext listener in this pinned version, so its container blocks TCP/UDP 5060 before startup and then drops all Linux capabilities. The PBX exposes only TLS. The existing WebRTC leg separately uses DTLS-SRTP. These are encrypted hops with trusted media processors, not end-to-end encryption through the PBX.

After the ordinary native checks, the fixture leaves a real admitted call active, removes its supervisor/PBX/SIP through the independent manager, restarts PBX/SIP against the surviving database/SFU, reconciles the orphan and starts a fresh supervisor for a native redial/cleanup probe. The socket is mounted only into the isolated management helper. Its `sip-fence.json`, `sip-recover.json` and `sip-restart.json` reports must all pass; a successful container cleanup alone does not establish application recovery. Failed recovery records fixed stage labels and journal state/counts without raw provider exceptions, private call bindings or credentials.

The harness stores only counters, state and verification results in ignored `test-results/sip/sip-media.json`. Native client stderr is discarded, PBX DTMF/debug logging is disabled and native SIP dispatch has no PIN handler. Its upstream PIN handler can log entered digits; that path must remain unused.

## Local validation

Run `npm test -w apps/phone` for authority, relay, loopback proxy, subscription eligibility and deferred RTC lifecycle tests. These open no sound device. The loopback gateway test may need permission to bind its isolated ephemeral listener.

The separate `scripts/phone-test.mjs` / `infra/compose.phone-test.yaml` fixture owns a disposable PostgreSQL and SFU network with no host-published ports. Its runner uses the real API, database and relay with generated PCM, counting decoded samples in programmatic sinks. No physical microphone, speaker, browser playback, carrier or billable call is involved. Consult the generated report and the requirements ledger for the exact passing checks; fixture success is not native SIP interoperability or scale evidence.

Baseline commit `7ff3ba69e0729b7abf966ec9971d4d319a4a94d5` passed [GitHub ordinary checks, PostgreSQL integration and eight RTC-relay checks](https://github.com/alvinhhh/Covemeet/actions/runs/37248890326) and [17 native SIP checks](https://github.com/alvinhhh/Covemeet/actions/runs/37248890423), including the corrected kick cleanup. Journal source `7f5e9083b88a29167ab8f31c604a06dc38124055` passed local type checks, 219 tests with two opt-in integration skips, and build, including focused API/client/supervisor/ownership coverage. The current local native rerun described below passed; phone source `ce354e1` also passed the current real PostgreSQL two-pool claim-race/reservation test and eight audio-relay checks (5 October 2026, 05:26 UTC). CI reruns remain pending. Baseline results alone do not prove the new journal behavior. The latest native implementation also awaits Daybreak review.

The current local run passed on 5 October 2026, 05:21:43–05:24:49 UTC: 18 native checks (run `34d5c4d4-3cf1-4c21-972e-9ec9e016c2d1`), actual admitted-orphan fencing/reconciliation, and four replacement-call checks. All eight numeric code/PIN sequences matched exactly. `sip-fence.json` proves the old runtime was removed while capacity stayed reserved; `sip-recover.json` proves confirmed orphan closure, release and fresh boot ownership; `sip-restart.json` proves a new native call, encrypted legs, waiting-room isolation and cleanup. `execution.json` passed with all container/network/volume/secret/lock cleanup flags true. These ignored reports validate the current single-host path; uncertain operations, multi-host recovery and carrier behavior remain outside that result.

## Gates before real dial-in

1. Deploy and validate the implemented ARI adapter with authenticated private HTTPS/WSS, the single-host managed ownership/recovery path and carrier-side time/concurrency limits. Verify both call legs terminate under actual restart, network partition and ambiguous provider outcomes. [ARI DTMF](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/Introduction-to-ARI-and-Channels/ARI-and-Channels-Handling-DTMF/), [ARI bridges](https://docs.asterisk.org/Configuration/Interfaces/Asterisk-REST-Interface-ARI/Introduction-to-ARI-and-Bridges/ARI-and-Bridges-Basic-Mixing-Bridges/), [ARI channel operations](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Asterisk_REST_Interface/Channels_REST_API/)
2. Maintain the pinned SIP/PBX sources and verify production certificate rotation, outbound certificate failure, SRTP policy and every network boundary on the target OS. Rerun the isolated native fixture after journal or transport changes and on the source intended for deployment. The WebRTC relay's DTLS/SRTP does not prove SIP trunk encryption. [Self-hosted SIP](https://docs.livekit.io/transport/self-hosting/sip-server/), [secure trunking](https://docs.livekit.io/telephony/features/secure-trunking/), [Asterisk PJSIP options](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Module_Configuration/res_pjsip/)
3. Prove native reconnect/redial cannot receive shared-room audio without new authorization, including concurrent calls to the same destination and termination races. Do not rely on a webhook removing an unauthorized caller after audio delivery.
4. Verify the chosen upstream SIP build never logs sensitive entered PINs. The reviewed upstream `inbound.go` PIN branch logs the entered value; this design collects PINs in the application IVR instead of that native dispatch path. Recheck source and logs when pinning the release. [Upstream SIP inbound source](https://github.com/livekit/sip/blob/main/pkg/sip/inbound.go)
5. Implement carrier limits: no arbitrary outbound or premium-number routing, per-trunk/caller attempt limits, maximum lobby/call duration, hard concurrency/spend stops, and crash reconciliation. Test rejected/unreachable/duplicate native hangup responses and loss of the authority/PBX/SFU.
6. Keep recording unavailable while phone participation is active until audible notices, consent and stop behavior are implemented and tested. Phone breakout moves remain unsupported. Test webinar listen-only behavior and promotion separately.
7. Measure codec compatibility, packet loss, DTMF reliability, double talk/echo, added latency, reconnect and simultaneous-call load. Recordings, relay decode/mix and native SIP increase resource usage and cannot inherit the browser capacity estimate.

Ordinary PSTN is outside the encrypted SIP/WebRTC boundary. The relay operator can process audio. This milestone does not establish end-to-end encryption, compliance, certification, production readiness, or a guaranteed hosting cost.
