# Media control validation

This harness creates a disposable meeting and webinar and checks the application against a real LiveKit server. It asserts SFU participant and track removal after moderation, then tries the previous token at the actual signaling gateway. It is a prerequisite check for load testing, not a 100-person or 1,000-viewer capacity result.

No browser, microphone, camera, audio source, speaker, or media playback is used. Published media consists only of generated 160×90 video frames. Microphone restrictions are verified in the signed grants and SFU permissions, and by disconnecting a current publisher. Actual audio-packet behavior remains a separate test.

## Coverage

- Waiting room media denial and host admission.
- Cookie requirement at the gateway.
- Lock rejection of new guests while admitted media remains connected.
- Audio/video restrictions, stale-token rejection, and a real denied camera publication.
- Breakout moves, return to main, closing breakout rooms, scoped chat, and broadcast.
- Kick followed by fresh lobby entry on the same device marker.
- Device and IP meeting bans, each including SFU disconnection and stale reconnect denial.
- Meeting end, removed publisher, and rejected host reconnect/new entry.
- Webinar viewer publication denial, presenter promotion, demotion, and rotated media authority.

Each successful publisher must send actual RTP video bytes with DTLS connected and an SRTP cipher reported by the native SDK. The evidence records the negotiated cipher names; this does not assert end-to-end encryption or certification.

The SDK does not expose custom WebSocket headers. A temporary relay on `127.0.0.1` adds the test client's existing cookie and Origin, and puts its application-issued token in the browser client's query parameter, on its connection to the real gateway. It never signs tokens or bypasses application admission. An independent, privileged `RoomServiceClient` observes only rooms created by this run and removes them during cleanup.

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

## Results

Exit status 0 means all checks and cleanup passed. The JSON evidence includes timestamps, generated frame counts, outbound RTP bytes, negotiated DTLS/SRTP ciphers, failures, and cleanup status. Removal timing measures the post-response verification interval, including a 300 ms check that the participant did not return; it is not total moderation latency. Tokens, cookies, meeting passwords, and infrastructure secrets are omitted. Runtime output belongs in ignored `test-results/` or `work/`; do not commit it. Ended synthetic meeting records and their audit trail remain in the test database. Use a dedicated test stack, and reset its test data when appropriate.

Read any failure before starting a capacity test. A passing run does not verify browser UX, packet-level transport encryption, SIP/PSTN, failover, compliance, or advertised capacity.
