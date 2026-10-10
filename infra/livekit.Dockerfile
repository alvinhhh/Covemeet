FROM --platform=$BUILDPLATFORM golang:1.26.9-trixie@sha256:f89535b7caea67fa9ff0ba009894bff8f3be915e49cb635477c8ce04e045db5d AS builder
ARG TARGETARCH
WORKDIR /workspace
ADD --checksum=sha256:b34592cd01df33ea017363e3ea3a59143d041e19c7db8a956674eb84c1f0c43f \
    https://codeload.github.com/livekit/livekit/tar.gz/8d11efdfcd4220092b6ac7b8a21af28526da5a6b /tmp/livekit.tar.gz
RUN tar -xzf /tmp/livekit.tar.gz --strip-components=1 && rm /tmp/livekit.tar.gz
ENV GOTOOLCHAIN=local GOMAXPROCS=2
RUN go get golang.org/x/net@v0.60.0 \
       go.opentelemetry.io/otel/sdk@v1.45.0 \
       go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp@v1.45.0 \
    && CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH go build -p 2 -trimpath -o /livekit-server ./cmd/server \
    && mkdir -m 1777 /runtime-tmp

# The static server needs trust roots and timezone data, but no shell or shared libraries.
FROM scratch
COPY --from=builder /livekit-server /livekit-server
COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=builder /usr/share/zoneinfo /usr/share/zoneinfo
COPY --from=builder /workspace/LICENSE /workspace/NOTICE /usr/share/licenses/livekit/
COPY --from=builder /runtime-tmp /tmp
ENTRYPOINT ["/livekit-server"]
