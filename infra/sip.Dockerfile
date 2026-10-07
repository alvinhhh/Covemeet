# Upstream starts TCP/UDP5060 even when TLS is configured. A container-only
# firewall prevents any plaintext SIP listener from becoming a usable ingress.
FROM livekit/sip:v1.17.0@sha256:d3c6441eb0918a81ab9e48ba7df6f02c1eebbeace42c963b2c6a6e5418675671
RUN apt-get update && apt-get install -y --no-install-recommends iptables \
    libssl3t64 openssl openssl-provider-legacy libpcre2-8-0 \
    && for package in libssl3t64 openssl openssl-provider-legacy; do \
         dpkg --compare-versions "$(dpkg-query -W -f='${Version}' "$package")" ge '3.5.7-1~deb13u3' || exit 1; \
       done \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libpcre2-8-0)" ge '10.46-1~deb13u3' \
    && rm -rf /var/lib/apt/lists/*
COPY infra/sip/entrypoint.sh /usr/local/bin/covemeet-sip-entrypoint
ENTRYPOINT ["/bin/sh", "/usr/local/bin/covemeet-sip-entrypoint"]
