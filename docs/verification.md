# Local verification — 4 October 2026

## Dependency checks

The Checks workflow generates a CycloneDX inventory from the lockfile and audits
production npm dependencies before installation. Known moderate, high or critical
vulnerabilities fail the check. The `dependency-security-<commit>` artifact retains
the inventory, audit result, commit and lockfile hash for 14 days, including failed
audits. Registry errors also fail the check. OS packages, native libraries and
deployed-image provenance require separate checks.

## Initial functional checks

Verified against the first Covemeet implementation on the local development stack:

- Browser: host bootstrap and fragment removal; connected WebRTC session; lock/unlock; breakout create, move and return; scoped chat; desktop and mobile layout.
- Hosted portal: public branded landing, sign-in, branding save/restore, asset upload, meeting creation, host bootstrap replay rejection, logout. Production origin tests enforce covemeet.com and covemeet.io.
- Actual recorder: isolated generated video, no audio track, no camera/microphone device, and no browser playback. Egress reached ACTIVE and recorded 30.376 seconds before stop and COMPLETE.
- Recording service encrypted a 6,780,534-byte MP4 into a 6,780,802-byte authenticated file, removed the raw spool, delivered a password to local Mailpit, successfully decrypted the protected download, rejected an incorrect password, and rejected the revoked link.
- Container: core Docker build completed with the pinned Node image and production dependency pruning.
- Security tests cover actual signed media grants, cookie-bound gateway access, ordered signaling, live expiry, role/admission boundaries, breakout isolation, recording integrity, recovery from recorder/DB/audit failures, scoped token lookup, and download expiry/revocation.

The initial recorder attempt failed because the running SFU had not loaded the newly generated internal ICE-candidate setting. Restarting the SFU fixed it. Regenerating runtime configuration requires restarting the affected service.

These checks establish local behavior only. They do not demonstrate 100-person or 1,000-viewer capacity, remote TURN behavior, phone/SIP, multi-region resilience, production SMTP delivery, or compliance with an entire control framework. See security-controls.md for release gates.

### Hosted team presentation

`hosted-authority.test.ts` checks machine-only `brandingProfileId` binding, unchanged replay, different-profile conflict, and the public `/api/meetings/:code/branding` response. The response contains only the stored profile ID; it does not grant access to a meeting. `team-branding.test.ts` checks company pages, meeting-bound and scheduled pre-start lookup, omitted credentials, fixed portal/image origins, response size limits and canceled lookups. Self-hosted installations retain `/api/config` branding.

Hosted `/t/<slug>` routes render a company join form. After code entry, the meeting's stored profile replaces the company hint. Route changes reset document branding; missing/unpublished profiles use installation defaults. Actual cross-origin rendering, browser history, pending schedules starting, and guest entry still require the paired hosted release and browser verification.
