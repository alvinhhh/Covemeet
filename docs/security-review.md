# Security review — 4 October 2026

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
