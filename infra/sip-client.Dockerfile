FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251 AS build
ARG PJPROJECT_VERSION=2.17
ARG PJPROJECT_SHA256=065fe06c06788d97c35f563796d59f00ce52fe9558a52d7b490a042a966facce
RUN apt-get update && apt-get install -y --no-install-recommends build-essential ca-certificates curl pkg-config libssl-dev libsrtp2-dev && rm -rf /var/lib/apt/lists/*
WORKDIR /build
RUN curl --fail --location --retry 3 --max-time 180 "https://github.com/pjsip/pjproject/archive/refs/tags/${PJPROJECT_VERSION}.tar.gz" -o pjproject.tar.gz \
    && echo "${PJPROJECT_SHA256}  pjproject.tar.gz" | sha256sum --check --strict \
    && tar -xzf pjproject.tar.gz --strip-components=1 && rm pjproject.tar.gz
RUN ./configure --disable-sound --disable-video --disable-opencore-amr --disable-silk --disable-libyuv --with-external-srtp \
    && make dep && make -j4 && make install
COPY scripts/validation/sip-client.c /build/sip-client.c
RUN cc -D_DEFAULT_SOURCE -std=c11 -O2 -Wall -Wextra /build/sip-client.c -o /usr/local/bin/covemeet-sip-client $(pkg-config --cflags --libs --static libpjproject)

FROM debian:bookworm-slim@sha256:3783cc01769c7b2b1b83a5c5ad96c815348e28ed7da68e2e3687004faa906251
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libssl3 libsrtp2-1 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/covemeet-sip-client /usr/local/bin/covemeet-sip-client
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/covemeet-sip-client"]
