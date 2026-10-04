# Native SIP validation client

`sip-client.c` is a single-call fixture built against pjproject 2.17, commit `5a457451fa2712ba18e12b01738e8ff3af2b26fd`. It targets only the isolated Docker Asterisk service. It never opens a microphone, speaker, or audio file. The null sound device drives the media clock; an in-memory PJMEDIA port generates bounded synthetic PCM when requested and counts received frames/peak values. No received samples are retained.

The default call uses SIP over verified TLS 1.2/1.3 with mandatory SDES-SRTP, the `AES_CM_128_HMAC_SHA1_80` suite, PCMU, and RFC 4733 telephone events. The harness checks the negotiated TLS verification state and SRTP transport rather than assuming those settings were accepted. This validates the SIP leg to the local PBX. It does not establish carrier support, end-to-end media encryption through the PBX, or production capacity.

Build with the pinned source in `infra/sip-client.Dockerfile`. Required development dependencies are a C11 compiler, make, pkg-config, OpenSSL headers, and libsrtp2 development headers. Disable physical sound backends and video. Do not mount `/dev/snd`, publish SIP/RTP ports to the host, or enable packet/SIP logging: SDES keys and access digits are sensitive.

## Process configuration

| Environment variable | Value                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SIP_PASSWORD_FILE`  | Required digest password file: owned by the fixture's UID, regular file, no symlink, mode `0600`, 16–256 characters from `A-Za-z0-9_.-`; one final newline is accepted.                                 |
| `SIP_CA_FILE`        | CA certificate path, default `/certs/ca.crt`. A separate unrelated CA is used for the trust rejection case.                                                                                             |
| `SIP_TEST_HOST`      | `asterisk` (default) or `asterisk-wrong-name` (same private service with a name absent from its certificate).                                                                                           |
| `SIP_TEST_MODE`      | `tls` (default); `without-srtp` deliberately offers plain RTP over TLS; `cleartext` deliberately attempts SIP/TCP port 5060. Negative modes must never be treated as successful service configurations. |
| `SIP_DEADLINE_MS`    | 1,000–300,000 milliseconds; default 120,000. Closing stdin, SIGINT, SIGTERM, or `hangup` also terminates the call.                                                                                      |

The synthetic digest identity is `syntheticclient`. The only destination is extension `7000`, TLS port `5061` (or port `5060` for the cleartext rejection case). Use a unique generated fixture password, not a production credential. The password is read from its protected file; no secret is passed in command arguments.

## Commands and evidence

stdin is a bounded line protocol. Commands: `stats`, `tone on`, `tone off`, `dtmf <1–32 digits from 0–9*#>`, and `hangup`. `tone` means generated PCM inside the private network, never audible output. Do not print stdin or log commands containing a meeting locator/PIN. Wait for `dtmf-drained` before entering the next field; that event confirms the native sender drained its queue, while the supervisor/API must independently confirm receipt and successful entry.

stdout contains only NDJSON events: `started`, `tls`, `call`, `media`, `stats`, `command`, `dtmf-drained`, `error`, and `stopped`. Call/SIP status numbers, encryption identifiers, and frame/packet counters are permitted. `tls.allowedProtocols` and `stats.tlsAllowedProtocols` report the configured PJSIP TLS allow-mask: TLS 1.2 is `16`, TLS 1.3 is `32`, and this fixture enables both (`48`). In pinned pjproject 2.17, this field is copied from the socket parameters, not the selected handshake version. It must not be described as the negotiated TLS version. A verified established connection with this strict mask proves the connection used one of the permitted versions; the exact selected version is not exposed by this client. No SIP message, Call-ID, caller ID, password, PIN, JWT, SRTP key, or raw PCM is emitted. Native library logs are disabled. The Node helper discards stderr instead of retaining potentially sensitive native logs.

`sip-client.mjs` exports `SipClient`, with `waitFor`, `stats`, `tone`, `dtmf`, and `close`. The optional `command`/`args` constructor values are a trusted fixture launch command, never user input; the default runs `/usr/local/bin/covemeet-sip-client` in the isolated client container. Each event has a local monotonically increasing sequence; pass an `after` cursor for fresh observations. Keep stdin open until cleanup.

Required success evidence: a connected call, `tlsVerified:true`, zero verification errors, `srtpActive:true`, `srtpSuiteConfirmed:true`, actual received RTP/PCM, numeric entry accepted by the supervisor, and final removal/release verified independently. Negative cases must assert no confirmed call or admitted participant, not merely a nonzero process exit: bad CA, hostname mismatch, plaintext SIP transport, and TLS with unencrypted RTP. Timeouts are bounded failures, not evidence of a valid call.

Official references: [PJSIP releases](https://github.com/pjsip/pjproject/releases/tag/2.17), [TLS verification](https://docs.pjsip.org/en/latest/specific-guides/security/ssl.html), [SRTP policy and negotiated transport inspection](https://docs.pjsip.org/en/latest/specific-guides/security/srtp.html), and [PJSUA audio devices](https://docs.pjsip.org/en/latest/api/generated/pjsip/group/group__PJSUA__LIB__MEDIA.html).
