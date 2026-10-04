# Isolated native SIP fixture

These artifacts support local integration testing only. They publish no ports and configure no carrier. The fixture supervisor owns authentication, per-dialog room creation, call lifetimes and confirmed teardown. See `docs/phone-sip-design.md` for the product boundary and release gates.

Build from the repository root:

```sh
docker build -f infra/asterisk.Dockerfile -t covemeet-asterisk:local .
docker build -f infra/sip.Dockerfile -t covemeet-sip:local .
docker build -f infra/sip-client.Dockerfile -t covemeet-sip-client:local .
```

Run the whole disposable fixture with `npm run test:sip`. It generates its own two-day CA and server certificates, uses an unused private Docker subnet, initializes configuration/keys with service-specific ownership, and removes its containers, volumes and generated secrets in `finally`. It never adds a certificate to the system trust store. Evidence remains in `test-results/sip/sip-media.json`, with bounded service error-label counts in `test-results/sip/infrastructure.json`. Raw PBX/SIP logs are neither printed nor retained by the wrapper. A CA and hostname verification preflight checks the private PBX-to-SIP TLS path before dialing. Build/setup failure before runner startup does not produce call evidence. A retained `runtime/sip-test/running` lock means Docker cleanup was uncertain and needs scoped inspection before another run.

The Dockerfiles pin Asterisk 22.11.0 and PJPROJECT 2.17 archives by SHA256, and LiveKit SIP 1.17.0 and Debian bases by image digest. Distribution security packages resolve when building; this is not a promise of byte-identical rebuilds. The native client uses Bookworm to match the Node validation runner. The PBX and SIP images use Trixie.

Copy the static `infra/asterisk` configuration into the private fixture runtime. Render `.template` files using freshly generated secrets. Do not put secrets in the image. The PBX runs as UID 10001; its key and writable state directories must have suitable ownership. The fixture accepts only extension 7000, endpoint/digest user `syntheticclient`, context `covemeet-inbound`, and ARI application `covemeet`. Its fixed outbound endpoint is `covemeet-livekit` and fixed SIP From user is `covemeet-pbx`.

Both SIP endpoints require SDES-SRTP and TLS with server certificate verification. Provide a private fixture CA and SAN certificates for `asterisk` and `sip`; never alter the user's trust store. The client uses only a null sound clock and memory PCM sinks. PBX prompt synthesis writes files without playing them. Prompts contain functional code/PIN instructions and call-state notices.

Upstream LiveKit SIP 1.17.0 also opens TCP/UDP 5060 when TLS is enabled. The wrapper rejects that port with IPv4 and IPv6 rules before starting SIP, then drops all Linux capabilities. Run this image only with its own container network namespace, `cap_drop: [ALL]`, `cap_add: [NET_ADMIN, SETPCAP]`, and writable tmpfs `/run` for the firewall lock. Never use host networking, privileged mode, or a host namespace mount. A failed rule prevents startup. Mounted configuration and private key must be readable by UID 0 without DAC override after capabilities drop. TLS 5061 and media ports remain reachable only on the private PBX/service network.

Native callee dispatch must use an empty prefix and `randomize:true`, with supervisor-selected `phone-hold-<UUID>` destinations. Resolve the exact resulting room and verify the single SIP participant's identity, trunk and rule. Native PIN dispatch is unused because its upstream PIN branch logs entered digits. No native call may dispatch directly to a shared meeting. LiveKit SIP waits to subscribe to remote audio before answering a no-PIN inbound call. The supervisor must therefore bind the isolated SIP participant and publish the relay's silent return track while the native call is ringing, then verify the answered PBX leg's TLS/SRTP state before connecting the caller or returning the relay. Waiting for SIP answer before opening that silent holding leg would deadlock.

References: [SIP release source](https://github.com/livekit/sip/tree/v1.17.0), [Asterisk 22 PJSIP options](https://docs.asterisk.org/Asterisk_22_Documentation/API_Documentation/Module_Configuration/res_pjsip/), [SIP encryption](https://docs.livekit.io/telephony/features/secure-trunking/), [PJSIP SRTP](https://docs.pjsip.org/en/2.17/specific-guides/security/srtp.html).
