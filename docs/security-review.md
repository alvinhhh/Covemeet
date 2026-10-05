# Security review — 4 October 2026

## Native SIP follow-up

The experimental implementation now includes an Asterisk ARI supervisor and a separate native SIP holding room for each call. Earlier local native validation passed 17 checks, covering verified SIP TLS and mandatory SRTP on both PBX legs, waiting-room audio isolation, host admission and speaking controls, keypad actions, cleanup before capacity release, certificate/downgrade rejection, and repeated digit sequences. These results concern an isolated local fixture with generated audio; internal ARI/SFU control still uses development HTTP/WS. They do not establish carrier interoperability, deployment readiness, capacity or compliance.

The follow-up review addressed pre-answer setup ordering and cleanup ownership: the native SIP service subscribes to an isolated silent return track before answering, while the original caller is bridged only after encryption verification. A late opening or failed setup retains its RTC teardown owner. Prompt cancellation waits for a pending playback creation before deleting it. Tests simulate delayed operations and failures without opening a real RTC connection. This review was not performed by Daybreak; a new Daybreak review of the native implementation is pending.

The first GitHub native validation then exposed a late-callback crash during kick cleanup: the relay tried to clear a disposed SDK audio source. Terminal gates now avoid native handles after close begins; a failed meeting teardown retains its cleanup owner while skipping source flushes after disposal starts. The holding pump finishes its final capture before its source closes. Five additional regression cases reproduce these resource-lifetime failures with strict fake sources, including uncertain teardown and blocked reopening. The resulting 12-case RTC suite passes. Native validation must be rerun against the corrected source; the earlier 17-check result does not prove this correction.

Ponytail's complexity review removed unused ARI originate variables, playback lookup and bridge-channel removal methods, plus an unused string-identity option in the validation observer. This simplification does not remove isolation checks or cleanup ownership.

The SIP fixture now records the outer process result separately from the in-container checks, so a crashed runner cannot leave an apparently unfinished result without its failure context. Cleanup success requires verified absence of the fixture's containers, networks and volumes, plus removal of generated secrets and its lock. GitHub has a bounded recovery step that selects the exact disposable project label and rechecks ownership before removal. Recovery produces separate evidence and cannot convert failed validation into success. Seven fake-command/filesystem tests cover scope, uncertain cleanup, interruption and evidence handling; an independent static review found no actionable issue. This does not prove behavior after a lost runner or replace a native validation run.

Two earlier native runs stopped unexpectedly during code entry. Later runs passed, including exact repeated-digit sequence checks, but the earlier cause remains unresolved. Durable orphan reconciliation, production private TLS, concurrent/redial isolation, carrier limits and recording/phone breakout behavior remain release gates in [the phone design](phone-sip-design.md#gates-before-real-dial-in). Phone access stays disabled by default.

## Phone foundation follow-up

An independent code review of the experimental phone admission, host controls and isolated audio relay found a terminal-cleanup race: a delayed RTC connection or publication could finish after cleanup, and a failed teardown could lose its resource reference. The relay now serializes opening and closing, checks terminal state after asynchronous operations, retains failed legs, and waits for pending SDK work before acknowledging cleanup. A follow-up also found that failed initial holding setup could lose its cleanup evidence; opening errors now retain their bridge, and unknown cleanup outcomes withhold the reservation release. The 26 phone tests include deferred lifecycle and failed-opening regressions. This follow-up was not performed by Daybreak and does not extend the earlier review to a native SIP implementation.

The final isolated PostgreSQL/LiveKit fixture passed eight audio/admission checks, including silence before admission, default mute, keypad controls, host mute enforcement, and reservation release only after both media legs and the simulated native participant are gone. The database test exercised two API instances sharing the same call cap. The fixture used an RTC peer in place of SIP; no carrier, TLS/SRTP trunk negotiation, IVR, or production load was tested.

The requested Ponytail pass removed an unused phone-access version counter; admission still checks the current locator and PIN hash. Phone access stays disabled by default. See [phone/SIP gates](phone-sip-design.md#gates-before-real-dial-in) for the native call control, announcements, encryption negotiation, orphan reconciliation and capacity work still required.

## Earlier Daybreak review

Daybreak reviewed the API, recording library, hosted adapter, and tests during implementation. It found no direct host/guest privilege escalation or recording cryptography break, but requested changes. This review is not an audit or a certification.

The implemented responses are:

- Preserve and reconcile recorder identity after post-start failures; request recorder shutdown rather than incorrectly marking an active recorder failed.
- Enforce participant expiry on established signaling connections and retry removal through the application worker.
- Authenticate the host before looking up a recording token in its specified meeting, avoiding unauthenticated whole-database token searches.
- Keep download capabilities in URL fragments, clear them before rendering, and submit them in a request body.
- Bind public signaling to the participant's host-only meeting cookie as well as its short-lived media token. Serialize signaling messages so database checks cannot reorder them.
- Require TLS for production password email. The hosted adapter requires HTTPS for non-loopback upstreams and includes its credential only on privileged mutations.

WebRTC signaling still uses the SDK's token query parameter. The reverse-proxy template disables access logging; deployments must preserve that rule or redact the complete query. Cookie binding reduces replay through the public gateway, but it does not replace private raw-SFU isolation. Direct raw signaling access is deliberately available on loopback for local development. Public deployment remains blocked on external network-isolation and hostile-reconnect testing.

The core and hosted service currently implement one configured installation. The 100-person and 1,000-viewer limits are targets pending load tests. Phone/SIP, shared multi-tenant provisioning, subscriptions, high availability, end-to-end media encryption, and operating evidence for compliance remain later work.
