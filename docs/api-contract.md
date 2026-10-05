# Initial API contract

Same-origin `/api`, JSON. Mutation calls send `Content-Type: application/json` and `X-Requested-With: MeetingPlatform` (the stable protocol marker). Cookie-backed HTTP-only sessions. Errors `{error: string}`. All GETs no-store. No client-supplied tenant. Single installation/tenant for this first implementation.

- `GET /api/config` → `{edition:'hosted'|'self-hosted',brandName,recordingAvailable,mediaAvailable,creationRequiresKey}`.
- `POST /api/meetings` body `{title,hostName,password,mode:'meeting'|'webinar',customCode?,creationKey?}` → `{code,hostToken,guestUrl}`. Never persist plaintext hostToken in local storage. Navigate `/host/CODE#TOKEN` and immediately exchange/clear fragment.
- `POST /api/meetings/:code/host` `{token}` → `{participantId}` + session cookie. Token single use.
- `POST /api/meetings/:code/join` `{name,password}` → `{participantId}` + session cookie; lobby by default.
- `GET /api/meetings/:code/state` → `{meeting:{code,title,mode,locked,ended,recordingAllowed,createdAt},me:{id,name,role,status,audioAllowed,videoAllowed},participants:[{id,name,role,status,audioAllowed,videoAllowed}],messages:[{id,name,text,createdAt}],recordings:[{id,status,createdAt,expiresAt?}],revision}`. Guests see admitted participants and themselves; hosts also see waiting/rejected/kicked/banned. Status waiting/admitted/kicked/banned/left. Role host/participant/viewer.
- Poll state every 2s; 401/403 means show a join page, never silently create a new session.
- `POST /api/meetings/:code/participants/:id/action` `{action:'admit'|'kick'|'ban'|'allow-audio'|'block-audio'|'allow-video'|'block-video'|'promote'|'demote',banIp?:boolean,banDevice?:boolean}` → `{ok:true}`.
- `PATCH /api/meetings/:code` `{locked?:boolean,recordingAllowed?:boolean}` → `{ok:true}`; host only.
- `POST /api/meetings/:code/end` `{}` → `{ok:true,cleanupPending}`. Returns 202 while media, phone or recorder cleanup is unresolved; 200 after confirmation. State polling exposes `meeting.cleanupPending` until cleanup finishes.
- `POST /api/meetings/:code/leave` `{}` → `{ok:true}`.
- `POST /api/meetings/:code/messages` `{text}` → `{ok:true}`.
- `POST /api/meetings/:code/media` `{}` → `{token,url}`; only admitted sessions. URL is the gateway signaling endpoint. Client uses `autoSubscribe:false` and explicitly subscribes to admitted participants' audio and at most 16 visible video tiles including local video. Screen shares receive bounded priority; remaining tiles are paginated. Webinar video excludes audience placeholders. Camera and microphone start off.
- `POST /api/meetings/:code/host-email` `{email}` → `{ok:true}` sends OTP. `POST /api/meetings/:code/verify-email` `{otp}` → `{ok:true}`.
- `POST /api/meetings/:code/recordings` `{}` starts optional recording if available, allowed and host email verified. `POST /api/meetings/:code/recordings/:id/stop` `{}` stops. `POST /api/meetings/:code/recordings/:id/link` `{}` → `{url,expiresAt}` emails separate password. No plaintext password in response. `POST /api/meetings/:code/recordings/:id/revoke` `{}` revokes.
- `/download/:code#token` UI accepts password; `POST /api/meetings/:code/download` `{token,password}` returns decrypted media as attachment, requires host session. UI can submit fetch and blob only with bounded file expectations; form POST with hidden CSRF header alternative must be reviewed.

Meeting state also includes `participantLimit`, optional `startedAt` and `deadlineAt` (epoch milliseconds). The fixed session clock starts on the first host entry. Reconnecting or refreshing a paid entitlement does not extend it. Finished recording downloads remain available after an ordinary meeting end; revoking the host account removes that access too.

The hosted adapter uses authenticated private endpoints for account authority, named host entitlements and meeting creation. Entitlements carry a monotonic revision, a short expiry and the allowed hosts for one billing owner. New customer meetings require a current grant; self-hosted installations do not require subscriptions. Customer plans currently cap rooms at 100 total people, two hours, one room per host and at most two rooms per Teams account. Capacity remains reserved until cleanup is confirmed.

Phone integration and 100/1000 media capacity require separate runtime validation.
