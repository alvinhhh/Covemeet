# Meeting data retention

Meeting content retention is disabled by default. Operators choose the period before enabling deletion:

- `MEETING_DATA_RETENTION_DAYS`: whole days after the meeting ended. `0` leaves the period unset.
- `MEETING_DATA_RETENTION_MODE`: `disabled` (default), `preview`, or `delete`. Preview and delete require a positive period.

Start in `preview`. Using the existing administrator authentication, send `POST /api/admin/retention/preview` with an empty JSON object. The response reports `scanned`, `eligible`, `blocked`, `missingEndedAt`, `notExpired`, and `nextAfter`. Each request examines at most four ended meetings; repeat with `{"after":"<nextAfter>"}` until `nextAfter` is null. Preview does not change content or timestamps. Production operators use their existing private administrative access; do not expose an admin route to enable retention.

After reviewing the policy and preview, set the mode to `delete` and restart the API. It examines four meetings per minute, continuing past blocked rooms. A failed pass logs a fixed error message and retries the same page the next minute. Set the mode to `disabled` to stop future passes; removed content can only be recovered from a separately retained backup.

The period starts at the recorded `endedAt`, not meeting creation. Ended meetings from older versions without that timestamp are reported as `missingEndedAt` and excluded; this feature does not guess their age or backdate them.

Deletion requires confirmed meeting cleanup, settled usage, no pending media or phone teardown, and all recordings already physically deleted with released storage inventories. Active meetings, available recordings, unresolved recorder jobs, storage/meter holds and recordings without a verified deletion inventory stay intact. The existing seven-day recording retention still runs independently. Recorder ownership and database locks prevent deletion during a concurrent writer.

Eligible meetings lose their title, passwords/tokens, host email, participant names and IP/device markers, bans, public/private/backstage chat, whiteboards, meeting audit entries and closed phone-call/dialog rows. A small ended record retains meeting/code/room identifiers, mode, creation/end/purge timestamps, revision and hosted account/billing/operation bindings. These prevent code reuse and stale invitation retries; purged unbound meetings also stay excluded from legacy account adoption. Shared billing accounting is retained. Installation audit events are not meeting records and are unaffected.

This does not remove hosted account/profile data, provider records, old backups or object-store versions. Their retention policies are separate. Existing account deletion can still remove a retained meeting record after its authority is revoked.
