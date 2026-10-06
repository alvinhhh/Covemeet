# Webinars

New webinars open backstage. The host can admit viewers, make guests presenters, and select presenters for the stage before choosing **Go live**. Viewers wait until the broadcast starts. Presenters who have not been selected stay backstage.

The stage and backstage use separate media rooms. Viewers receive only the live stage. Backstage chat and whiteboard content stay backstage; Announcements deliberately reaches every room. Private messages to the original host retain their existing recipient rules.

**Go live** disconnects the old backstage presenter sessions before starting the broadcast. If cleanup fails, the webinar stays backstage and blocks new media connections there. Retry **Go live** after the disconnect completes. Stage transfers use the same disconnect process; stale media tokens cannot reconnect to the old room.

The current leader can move admitted presenters between backstage and stage. Making someone a presenter does not automatically put them on stage. Returning from a breakout sends a presenter backstage. Phone viewers remain on hold until the broadcast starts; a phone presenter can join backstage or the stage, with audio only.

Only a live broadcast can be recorded. Recordings capture the stage, never backstage. **End broadcast** ends the entire webinar. There is no pause or return-to-rehearsal action in this release.

A host can hand control to a co-host through **Leave**. Only the selected current co-host inherits broadcast controls. Meeting ownership, recording access, billing, session deadlines and absence handling stay with their existing rules. Starting the broadcast does not restart the session clock or create another host reservation.

Webinars created before this lifecycle was introduced remain live and keep their existing presenter controls. They do not gain stage-location controls midway through a session.
