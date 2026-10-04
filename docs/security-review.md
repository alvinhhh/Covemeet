# Security review — 4 October 2026

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
