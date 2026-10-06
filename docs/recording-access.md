# Recordings after a meeting

Hosts can open **Recordings** after leaving or ending a meeting. Hosted account holders also have a **Recordings** action beside each meeting they created. Self-hosted installations offer **Recordings** beside the meeting-code input; enter the code, then verify the code sent to the meeting's previously verified host email.

A recovered recording session expires 24 hours after recovery. Creating or retrieving a download link does not extend it; recover again if the session expires before the link. It can list recordings and retrieve, renew or revoke download links. It cannot join a room, access chat or the whiteboard, enable devices, change the host email, or start/stop recordings. Recovering access does not start a meeting or consume a hosting seat.

Downloads still require the current link and its separate emailed password, retain the seven-day storage cutoff, and use the original billing owner's download allowance. Opening the page does not renew links or send another recording password. A new recovery replaces the previous recovered recording session for that meeting.

Hosted recovery checks the exact meeting creator and current account authority under the existing account/owner database locks. An ordinarily ended meeting can be recovered; a meeting revoked by account suspension, a password reset or a team-authority change cannot. Recovery does not transfer recordings to a different team or reverse revocation.

Self-hosted recovery accepts no destination address from the requester. Its separate email challenge expires after ten minutes, permits five code attempts, and is bound to the meeting, verified email and requesting browser. Request limits are shared through the existing database counters and the meeting's ten-minute send cooldown. Changing the host email invalidates recording recovery. Both email recovery and the recording password use the same mailbox; they are not independent factors.

The ticket fragment is removed before rendering. Only token hashes and bounded challenge state are stored in meeting data; recording cookies are HttpOnly and Secure on HTTPS. Authorization is checked again during link changes and before each plaintext download frame. The existing asynchronous hosted-authority delivery applies unchanged.
