# Native SIP validation PBX; not a production carrier deployment.
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a AS build
ARG ASTERISK_VERSION=22.11.0
ARG ASTERISK_SHA256=3bd5ee040509a3d3cd9b1ba9520c18e6ec0a7e7981ca68c457dcd36ba3c54d94
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates curl pkg-config python3 \
    libssl-dev libsrtp2-dev libxml2-dev libsqlite3-dev libjansson-dev uuid-dev libedit-dev libncurses-dev \
    espeak-ng sox && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl --fail --location --retry 3 --max-time 180 "https://downloads.asterisk.org/pub/telephony/asterisk/asterisk-${ASTERISK_VERSION}.tar.gz" -o asterisk.tar.gz \
    && echo "${ASTERISK_SHA256}  asterisk.tar.gz" | sha256sum --check --strict \
    && tar -xzf asterisk.tar.gz --strip-components=1 && rm asterisk.tar.gz
RUN ./configure --with-pjproject-bundled --with-jansson --with-ssl --with-srtp --without-dahdi --without-pri \
    && make menuselect.makeopts \
    && menuselect/menuselect --disable BUILD_NATIVE --disable-category MENUSELECT_CORE_SOUNDS --disable-category MENUSELECT_MOH --disable-category MENUSELECT_EXTRA_SOUNDS menuselect.makeopts \
    && make -j4 && make install DESTDIR=/staging
COPY infra/asterisk/prompts.sh /build/prompts.sh
RUN sh /build/prompts.sh /staging/var/lib/asterisk/sounds/en

FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3t64 libsrtp2-1 libxml2 \
    libsqlite3-0 libjansson4 libuuid1 libedit2 libncurses6 libstdc++6 libpcre2-8-0 \
    && dpkg --compare-versions "$(dpkg-query -W -f='${Version}' libpcre2-8-0)" ge '10.46-1~deb13u3' \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 10001 asterisk && useradd -u 10001 -g asterisk -M -s /usr/sbin/nologin asterisk
COPY --from=build /staging/usr/ /usr/
COPY --from=build /staging/var/lib/asterisk/ /var/lib/asterisk/
RUN mkdir -p /var/run/asterisk /var/log/asterisk /var/spool/asterisk /var/lib/asterisk /etc/asterisk \
    && chown -R 10001:10001 /var/run/asterisk /var/log/asterisk /var/spool/asterisk /var/lib/asterisk
USER 10001:10001
ENTRYPOINT ["/usr/sbin/asterisk", "-f", "-n", "-C", "/etc/asterisk/asterisk.conf"]
