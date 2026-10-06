# Chat

The host's **Who can send?** control applies to every room:

- **Everyone:** admitted browser participants can send messages.
- **Host only:** only the host can send.
- **No one:** new messages and all-room announcements are disabled. The host can still change the setting or remove messages.

**Everyone** in the message composer sends to the current room. A participant can choose **Host** to send privately. The host can use **Reply privately** to answer an admitted browser participant. Private conversations are visible only to their sender, recipient and current host, including across breakout moves. Public breakout messages remain scoped to that room. Phone sessions do not use browser chat.

The host can remove public or private messages. Removal clears the stored text and leaves **Message removed** in its place. It cannot erase a copy someone already saw or saved. Public and private messages share a rolling limit of 500 entries; each viewer receives up to 100 visible entries. Drafts are separate for each room and recipient.

Policy, recipient authority and removal are enforced by the API inside the existing meeting transaction. A stale interface or reconnect cannot bypass the current policy. Media data-channel publishing remains disabled; chat uses the authenticated application API.

Private entries use a separate `Meeting.privateMessages` field. The legacy `messages` field contains only public messages, so older serializers cannot return private text. Existing meetings without `chatMode` default to `everyone`. Upgrade all API instances together: older versions do not enforce the new sender policy.
