FROM livekit/egress:v1.14.1@sha256:bf2b648b947349c3e9ff7aa8c718f00378d5c06af7624652a3653318e00333ce
USER root
ARG EGRESS_UID=1000
ARG EGRESS_GID=1000
# Keep the recorder and API on the same numeric owner for the private 0700 spool.
# Remap its home too: overriding only Compose's user leaves Chrome/Pulse unwritable.
RUN test "$EGRESS_UID" -gt 0 && test "$EGRESS_GID" -ge 0 \
    && groupadd --non-unique --gid "$EGRESS_GID" recording \
    && usermod --non-unique --uid "$EGRESS_UID" --gid recording egress \
    && chown -R egress:recording /home/egress
USER egress
