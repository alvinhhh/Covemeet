# MeetingPlatform

Browser meeting software with an open-source core and hosted deployment. Follow the approved plan in docs/infrastructure-plan.md. Do not claim certification or production readiness from configuration alone.

Use functional labels and concise UI copy. Keep hosted meeting codes random (130 bits); custom codes are self-hosted only. Guests have no account. Host privileges use separate capabilities. Enforce all moderation on the server and through the media signaling gateway, including reconnects. Recordings default off. Never store secrets, recordings, private runtime state, or personal data in Git.

Run npm run check, npm test, and npm run build before committing substantive changes. Use separate meaningful commits and push to the existing private alvinhhh/MeetingPlatform repository. Do not change its visibility without user instruction.
