# The official 2.11.7 Docker tag was not published at preparation time.
# Use an official runtime base and verify the official release binary by SHA-256.
FROM caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) caddy_archive_sha=727b91701a392de6ebc5027509f548bf39979e5216340d0faed8fa5e69c84f8b ;; \
      arm64) caddy_archive_sha=d8fc6d179a5d283028a472a5618564f6ad8a86fed513e64f032b3b0b7cc45e42 ;; \
      *) echo "Local HTTPS image supports amd64 and arm64 only" >&2; exit 1 ;; \
    esac \
    && wget -q "https://github.com/caddyserver/caddy/releases/download/v2.11.7/caddy_2.11.7_linux_${TARGETARCH}.tar.gz" -O /tmp/caddy.tar.gz \
    && echo "$caddy_archive_sha  /tmp/caddy.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/caddy.tar.gz -C /usr/bin caddy \
    && rm /tmp/caddy.tar.gz \
    && caddy version
