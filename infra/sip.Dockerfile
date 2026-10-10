FROM golang:1.26.9-trixie@sha256:f89535b7caea67fa9ff0ba009894bff8f3be915e49cb635477c8ce04e045db5d AS builder
WORKDIR /workspace
RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libopus-dev libopusfile-dev libsoxr-dev \
    && rm -rf /var/lib/apt/lists/*
ADD --checksum=sha256:e361d23a4889e4a2be0394f98705c4b2828ea759517706e0186abeb4bb8ff7ad \
    https://codeload.github.com/livekit/sip/tar.gz/357f3a9597b182be3e7610b5a86e3fe9f542787b /tmp/sip.tar.gz
RUN tar -xzf /tmp/sip.tar.gz --strip-components=1 && rm /tmp/sip.tar.gz
# Rebuild the same release to fix Go and HTTP/2 vulnerabilities in its upstream image.
ENV GOTOOLCHAIN=local GOMAXPROCS=2
RUN go get golang.org/x/net@v0.60.0 \
    && CGO_ENABLED=1 go build -p 2 -trimpath \
       -ldflags "-X github.com/livekit/sip/version.Version=v1.17.0" \
       -o /livekit-sip ./cmd/livekit-sip

# Upstream starts TCP/UDP5060 even when TLS is configured. A container-only
# firewall prevents any plaintext SIP listener from becoming a usable ingress.
FROM livekit/sip:v1.17.0@sha256:d3c6441eb0918a81ab9e48ba7df6f02c1eebbeace42c963b2c6a6e5418675671
COPY --from=builder /livekit-sip /usr/bin/livekit-sip
COPY --from=builder /workspace/LICENSE.txt /workspace/NOTICE /usr/share/licenses/livekit-sip/
RUN apt-get update && apt-get install -y --no-install-recommends iptables \
    libssl3t64 openssl openssl-provider-legacy libpcre2-8-0 \
    && for package in libssl3t64 openssl openssl-provider-legacy; do \
         dpkg --compare-versions "$(dpkg-query -W -f='${Version}' "$package")" ge '3.5.7-1~deb13u3' || exit 1; \
       done \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libpcre2-8-0)" ge '10.46-1~deb13u3' \
    && rm -rf /var/lib/apt/lists/*
COPY infra/sip/entrypoint.sh /usr/local/bin/covemeet-sip-entrypoint
ENTRYPOINT ["/bin/sh", "/usr/local/bin/covemeet-sip-entrypoint"]
