# Media control validation

This harness creates two disposable meetings and a webinar and checks the application against a real LiveKit server. It asserts SFU participant and track removal after moderation, then tries the previous token at the actual signaling gateway. It is a prerequisite check for load testing, not a 100-person or 1,000-viewer capacity result.

No browser, microphone, camera, audio source, speaker, or media playback is used. Published media consists only of generated 160×90 video frames. Microphone restrictions are verified in the signed grants and SFU permissions, and by disconnecting a current publisher. Actual audio-packet behavior remains a separate test.

## Coverage

- Waiting room media denial and host admission.
- Cookie requirement, another participant's cookie rejection and foreign-Origin rejection at both `/rtc` and `/rtc/v1`; every stale-token reconnect check exercises both paths.
- Lock rejection of new guests while admitted media remains connected.
- Audio/video restrictions, stale-token rejection, and a real denied camera publication.
- Separate screen-sharing permission: denied while camera works, explicit grant with camera/microphone blocked, active share removal and stale-token denial on revocation.
- Breakout moves, return to main, closing breakout rooms, scoped chat, and broadcast.
- Kick followed by fresh lobby entry on the same device marker.
- Device and IP meeting bans, each including SFU disconnection and stale reconnect denial.
- Meeting end, removed publisher, and rejected host reconnect/new entry.
- Webinar audience holding before Go live; backstage presenters decode each other’s silent video.
- Go live physically removes old backstage identities. The audience decodes stage video while a separate backstage publisher continues sending RTP, with no private identity or frames visible.
- Explicit presenter stage transfers remove the old publisher and reject its stale token at both gateway paths. Returning backstage stops audience decoding while live-stage reception and private RTP continue.
- Presenter promotion goes backstage; demotion restores a receive-only stage connection. Broadcast end removes stage and backstage publishers and deletes both SFU rooms.
- Explicit host handoff removes the original publisher, preserves the selected co-host’s SFU session/RTP, and permits that co-host to end the room.

The webinar checks require the lifecycle API and must run only after deploying the matching core build. At most three native peers are connected at once, with generated 160×90 video and no audio. Video receivers count decoded frames without rendering them. Negative isolation checks last 1.5 seconds and require both increasing private-publisher RTP bytes and continued stage decoding during that interval; room metadata alone is insufficient.

Each successful publisher must send actual RTP video bytes with DTLS connected and an SRTP cipher reported by the native SDK. The evidence records the negotiated cipher names; this does not assert end-to-end encryption or certification.

The evidence also records the selected local ICE candidate type and relay protocol. `VALIDATION_TURN_TRANSPORT=udp` or `tls` disables direct ICE candidates and requires every successful video publisher to select an actual relay candidate with that transport. A direct path or different relay transport fails validation. Native TLS mode requires a client-trusted TURN/TLS endpoint advertised by the SFU. The pinned native SDK exposes no custom TURN CA option, and `NODE_EXTRA_CA_CERTS` covers Node HTTPS/WSS rather than the native WebRTC TLS implementation. Use the separate trusted-browser fixture for the local private CA; never enable insecure certificate policies to make a test pass.

The SDK does not expose custom WebSocket headers. A temporary relay on `127.0.0.1` adds the test client's existing cookie and Origin, and puts its application-issued token in the browser client's query parameter, on its connection to the real gateway. It never signs tokens or bypasses application admission. An independent, privileged `RoomServiceClient` observes only rooms created by this run and removes them during cleanup.

## Delayed cleanup regression

`scripts/media-generation-test.mjs` runs two API instances against a temporary PostgreSQL database and real SFU. It holds an old participant-removal request, connects the replacement, then releases the old request. The replacement must keep the same SFU session, continue decoding silent video and retain its usage reservation. A second case closes the old API's database pool before releasing the request. That case tests lost database access, not a killed operating-system process.

Pull the pinned fixture dependencies, build the current source and use its exact local image. The runner does not pull images automatically.

```sh
npm run build
docker pull postgres:17.11-alpine3.23
docker pull livekit/livekit-server:v1.13.7
docker build -t covemeet-core:local .
MEDIA_GENERATION_IMAGE="$(docker image inspect covemeet-core:local --format '{{.Id}}')" \
  node scripts/media-generation-test.mjs --execute-reviewed-fixture
```

The test uses an internal Docker network with no published ports. It mounts the matching compiled phone gateway adapter and writes `test-results/media-generation/media-generation.json`. It does not restart the local installation. If teardown cannot be confirmed, `runtime/media-generation-test/owner.json` retains the exact project and image alongside its private configuration; recover that project before running again. Run this test separately from other media, phone or recording jobs on a laptop.

## Local development

From the core repository:

```sh
npm ci --prefix scripts/validation
VALIDATION_REPORT=test-results/media-controls-dev.json node scripts/validation/media-controls.mjs
```

The default protected configuration file is `.env`. Set `VALIDATION_ENV_FILE` for another file. Expected fields are `SITE_ORIGIN`, optional `CREATION_KEY`, `LIVEKIT_URL`, `LIVEKIT_API_KEY`, and `LIVEKIT_API_SECRET` (or `LIVEKIT_SECRET`). `VALIDATION_API_URL` and `VALIDATION_LIVEKIT_URL` override request destinations without changing the browser Origin. Only loopback, `.localhost`, and named local Docker endpoints are accepted.

Installations with TLS must supply a trusted local certificate using `NODE_EXTRA_CA_CERTS`. Do not disable certificate checks.

## Isolated TLS stack

After starting the local TLS stack and exporting its root certificate, build and run on its private Docker network:

```sh
docker build -t covemeet-media-validation scripts/validation
mkdir -p test-results
docker run --rm --network covemeet-local-tls --user "$(id -u):$(id -g)" \
  --mount type=bind,src="$PWD/runtime/local-tls/.env",dst=/secrets/local.env,readonly \
  --mount type=bind,src="$PWD/runtime/local-tls/trust/root.crt",dst=/trust/root.crt,readonly \
  --mount type=bind,src="$PWD/test-results",dst=/results \
  -e VALIDATION_ENV_FILE=/secrets/local.env \
  -e SITE_ORIGIN=https://meet.localhost:8443 \
  -e VALIDATION_LIVEKIT_URL=http://livekit:7880 \
  -e NODE_EXTRA_CA_CERTS=/trust/root.crt \
  -e VALIDATION_REPORT=/results/media-controls-tls.json \
  covemeet-media-validation
```

Run the container with permission to read only the mounted test secrets and write the evidence directory. No Docker socket, host devices, host networking, or privileged mode is needed. The host must have the local certificate trusted separately for browser testing.

Set `VALIDATION_RECORDING=true` to include the real recorder workflow, after enabling recording on the isolated stack. It verifies default-off behavior, a host OTP delivered only to local Mailpit, an active recorder, 30 seconds of silent video, encrypted-ready status, a 24-hour fragment link, the emailed password download, wrong-password denial, revocation, and recording disabled again. `VALIDATION_MAILPIT_URL` defaults to `http://mailpit:8025` and only accepts the local Mailpit service or a loopback host. The script never prints OTPs, recording passwords, or download capabilities. This check adds several minutes and does not inspect physical storage directly; correlate the recording ID with a separate ciphertext/raw-spool inspection when required.

## Webinar recording privacy

After deploying the matching webinar lifecycle source, run the TLS fixture once with
`VALIDATION_RECORDING=false` and `VALIDATION_WEBINAR_RECORDING=true`. Keep TURN
forcing unset. The existing recorder and local Mailpit must already be enabled;
this fixture does not change infrastructure. Use a fresh private host directory
(mode 0700) for `/results`, a unique container name, 512 MiB memory and one CPU.
The first ordinary meeting is not recorded. The webinar uses normal host email
verification/opt-in, rejects recording backstage, then captures 30 seconds after
Go live. Stage video is blue; private backstage video is red. No audio, physical
devices or playback are used.

The fixture checks the actual Egress room/output, ongoing backstage RTP and stage
reception every two seconds. It downloads one encrypted-ready recording through
the normal password flow and leaves its plaintext MP4 at mode 0600 beside the
report. A successful container exits with `result: "capture-ready"`, **not passed**.
Then run the decoder on the host with its existing `ffmpeg` on PATH (no installation):

```sh
node scripts/validation/verify-webinar-recording.mjs /absolute/private/results/media-controls.json
```

This verifies the exact downloaded hash, decodes every video frame with one CPU
thread and no audio, requires the stage marker in at least 80% of frames, and
rejects any frame with a backstage marker covering 0.5% or more of its scaled
160×90 pixels. It writes `passed` only after that check and plaintext removal.
This is a bounded synthetic recording-content check; smaller/shorter leaks
outside its measured content are not established by the result.

Allow 12 minutes for capture and 90 seconds for decoding. On timeout, send TERM
with a 120-second cleanup grace before killing the exact fixture container.
Retain failures; do not retry automatically. Cleanup attempts the exact recorder
output in both run-owned rooms, requires terminal Egress evidence plus terminal
application recording state, revokes the link, and ends the fixture's meetings.
The encrypted recording and ended audit rows remain under normal retention.
Verify raw-spool absence and zero active work independently with the existing
local preservation check. A forced kill still requires scoped cleanup from the
report. The host decoder removes plaintext even after a verification failure;
it refuses to unlink a replaced file.

`node scripts/validation/verify-webinar-recording.mjs --self-check` exercises
marker detection, fragmented decoder output, missing stage and leaked private
frames without a server or recorder.

## Native UDP relay diagnostic

The current local native run failed at connection setup: authenticated TURN grants and SFU candidates arrived, but the native client sent no relay candidate before timeout. This is not a passing UDP check; the cause remains unresolved. Use the browser variant below to test the route independently. Retain this command for diagnosis in an approved local environment, separately from other media runs.

Enable the local embedded TURN fixture after ending active test calls:

```sh
node scripts/local.mjs start --hosted --turn
docker build -t covemeet-media-validation scripts/validation
docker run --rm --network container:covemeet-local-tls-livekit-1 --memory 512m --cpus 1 \
  --user "$(id -u):$(id -g)" \
  --mount type=bind,src="$PWD/runtime/local-tls/.env",dst=/secrets/local.env,readonly \
  --mount type=bind,src="$PWD/runtime/local-tls/trust/root.crt",dst=/trust/root.crt,readonly \
  --mount type=bind,src="$PWD/test-results",dst=/results \
  -e VALIDATION_ENV_FILE=/secrets/local.env \
  -e SITE_ORIGIN=https://meet.localhost:8443 \
  -e VALIDATION_LIVEKIT_URL=http://livekit:7880 \
  -e NODE_EXTRA_CA_CERTS=/trust/root.crt \
  -e VALIDATION_TURN_TRANSPORT=udp \
  -e VALIDATION_REPORT=/results/media-controls-turn-udp.json \
  covemeet-media-validation
```

This fixture deliberately shares only the SFU's network namespace so its advertised loopback relay address resolves correctly; it has no Docker socket, host networking, devices or privileged mode. A passing run would verify authenticated local UDP relay selection and moderation using silent video, not TURN/TLS or traversal from an external restricted network. No certificate or trust-store change is needed. Run it separately from other media or recording tests on a resource-constrained laptop.

## Local browser relay

After `start --turn`, prepare a disposable meeting through the ordinary `/api/meetings` creation API using the protected creation key locally. Keep the operator key out of the browser. Open this fixture with the returned meeting code and one-use host token only in its fragment:

```text
https://meet.localhost:8443/__validation/turn.html#code=MEETING_CODE&host=ONE_USE_HOST_TOKEN
```

Use the trusted Yuxuan browser session and select **Run**. The page immediately removes the fragment, exchanges the one-use host capability for the ordinary host cookie, and connects through the admission-checked signaling gateway. The default TLS mode restricts the SDK's authenticated ICE servers to `turns:meet.localhost:15349`. To test UDP separately, prepare a fresh meeting link and append `&transport=udp` to the fragment; that mode allows only `turn:127.0.0.1:13478?transport=udp`. Both modes enforce relay-only ICE on every browser peer connection, publish a 160×90 synthetic canvas video, and require selected `relay` candidates with the requested transport plus increasing outbound RTP bytes and connected DTLS. It never opens a microphone/camera, creates audio, or attaches media playback. Results are visible on the page without credentials; preserve them in ignored test evidence. It disconnects and ends the disposable meeting in `finally`; `meetingEnded` must be true.

LiveKit 1.13.7's embedded TURN advertisement always uses TLS port 443 ([upstream implementation](https://github.com/livekit/livekit/blob/v1.13.7/pkg/service/roommanager.go#L998-L1000)). This local fixture maps only that exact `meet.localhost:443` TLS URL to the published loopback port 15349; the authenticated username/password, hostname verification and TLS requirements remain unchanged. This mapping is confined to the test page and does not establish TURN fallback for the ordinary meeting UI on this local port layout. Sanitized ICE configuration counts, candidate types, error codes and states help diagnose failures without exposing credentials.

This local browser check relies on the user's existing trust in the exact project CA. The fixture never installs trust or bypasses a certificate error. A passing run establishes this browser's selected local TURN route, not external firewall traversal, certificate renewal, protocol conformance, phone/SIP or capacity. UDP TURN still carries DTLS-SRTP media; it does not establish TLS protection of the client-to-TURN connection. Re-run after source or infrastructure changes.

## RTP receiver

`rtp-receiver/` supplies a Linux receive-only helper and a Node client for measuring authenticated RTP without decoding every receiver's audio and video. The caller supplies already-admitted sessions through private loopback signaling bridges; the helper does not create meetings, admit participants, sign tokens, or bypass the application's cookie and Origin checks.

Build the helper with Go 1.26 or later, then run the protocol checks from the repository root:

```sh
cd scripts/validation/rtp-receiver
go test ./...
CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o /tmp/covemeet-rtp-receiver .
cd ../../..
node scripts/validation/rtp-receiver/client.mjs --offline-check
```

The protocol check starts simulated child processes only; it makes no SDK or network connections. Build outputs and runtime evidence must remain untracked.

Import `startReceiver` from `scripts/validation/rtp-receiver/client.mjs`. Its arguments are `config`, an absolute Linux binary path, an `onFault(label)` callback, `offline` (leave `false` for the real helper), and an optional asynchronous `grantProvider(index)`.

| Configuration | Default meeting profile | Webinar profile |
| --- | --- | --- |
| Top-level fields | `peers`, `publishers`; omit `profile` | `profile: "webinar"`, `peers`, `publishers` |
| Publishers | Exactly nine unique media identities | Exactly ten unique stage media identities |
| Receivers | 2–982 | Exactly 1,000 |
| Peer fields | `index`, `url`, `token` | `index`, `url`; no pre-issued token |
| Peer indices | Consecutive integers beginning at 18 | Consecutive integers beginning at 18 |
| Signaling URL | `ws://127.0.0.1:<port>` | `ws://127.0.0.1:<port>` |
| Tracks per publisher | Video | Audio and video |
| Grant provider | Omit it | Required; returns the requested viewer's token |

The default profile and its snapshot shape remain unchanged. Webinar joins use at most 20 concurrent slots. A slot requests its token immediately before joining, and grant replies may arrive out of order. Each token must identify a distinct viewer in the same room, have 15–180 seconds remaining, and explicitly grant `roomJoin`, `canSubscribe`, and `hidden` while denying `canPublish` and `canPublishData`. Stage identities cannot be reused as viewers. Claim validation is an input check; the SFU verifies the signature during connection.

```js
const receiver = startReceiver(config, binaryPath, onFault, false, grantProvider);
try {
  await receiver.connected;
  const snapshot = await receiver.snapshot();
  // Compare successive per-stream counters over the measured interval.
} finally {
  await receiver.close();
}
```

`connected` confirms that every configured receiver joined. `snapshot()` returns ordered `rows`, process CPU microseconds, and peak Linux RSS bytes. Each row contains ordered per-publisher stream counters and their aggregate bytes, packets, complete RTP frames, and unusable packet gaps. Webinar streams add `kind: "audio" | "video"`, ordered audio then video for each publisher; meeting streams omit `kind`. VP8/H.264 video and Opus audio are accepted. Missing tracks remain visible as incomplete stream coverage: the caller must require every expected stream to advance throughout its hold interval.

A non-null `subscriber` means every observed stream has received packets through Pion's authenticated SRTP reader, with connected DTLS and a remote certificate present. It records the selected local ICE candidate type and protocol. Cipher names are unavailable and remain `null`. Complete RTP frames are not decoded-media quality, and unusable packet gaps conservatively include discarded frame packets rather than estimating network loss.

Faults use fixed labels without credentials. Connection deadlines are bounded (up to 90 seconds for meetings, 180 seconds for webinars); a track read stalls after five seconds without RTP. Always await `close()`, including during an interrupted connection. It cancels pending work and requires confirmed peer shutdown; forced termination is a cleanup failure. The caller remains responsible for ending its meeting, erasing fixture credentials, enforcing resource/transfer budgets, and stopping its generator.

This helper enables a full stream-count measurement at the caller's explicit media profile. It does not establish 100-person/1,000-viewer capacity, browser decoding performance, recording quality, or any particular resolution by itself.

## Results

Exit status 0 means all checks and cleanup passed. The JSON evidence includes timestamps, generated frame counts, outbound RTP bytes, negotiated DTLS/SRTP ciphers, failures, and cleanup status. Removal timing measures the post-response verification interval, including a 300 ms check that the participant did not return; it is not total moderation latency. Tokens, cookies, meeting passwords, and infrastructure secrets are omitted. Runtime output belongs in ignored `test-results/` or `work/`; do not commit it. Ended synthetic meeting records and their audit trail remain in the test database. Use a dedicated test stack, and reset its test data when appropriate.

Read any failure before starting a capacity test. A passing run does not verify browser UX, packet-level transport encryption, SIP/PSTN, failover, compliance, or advertised capacity.
