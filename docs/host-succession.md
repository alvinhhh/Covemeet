# Leaving a meeting running

The host can select an admitted co-host in **Leave**, then choose **Leave meeting**. The selected co-host keeps their moderation controls and can use **End for everyone**. Other co-hosts cannot end the meeting or choose another successor.

The original host keeps ownership of the meeting, billing, recordings, phone access and private messages addressed to the host. Recordings already running continue after handoff. Leaving does not reset the session deadline or free the original host's concurrent meeting slot.

Hosted creators return through **Re-enter as host** on Meetings. Self-hosted owners can use **Return as host** in the same browser while their original session remains valid. Returning restores control to the original host; the successor remains a co-host. A lost or expired self-hosted owner session cannot be recovered with the guest meeting password or a recording-access code.

A started meeting ends if its current leader is absent for five minutes after control-page and media presence expire. There is no automatic promotion. A returning leader clears the absence period before it expires. Unstarted and scheduled meetings are unaffected. Session, hosting-plan and funded-media limits can end a meeting sooner.

Self-hosted operators can set `HOST_ABSENCE_GRACE_SECONDS` from 30 to 1,800 seconds. Hosted meetings use 300 seconds. The value is saved for each meeting; changing configuration does not reset an existing absence period.
