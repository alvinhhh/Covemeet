# Disposable compatibility test fixture, never a production storage recommendation.
# Build the upstream security release because its official prebuilt image is unavailable.
FROM golang:1.27.1-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS build
RUN CGO_ENABLED=0 go install github.com/minio/minio@RELEASE.2025-10-15T17-29-55Z

FROM debian:13-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a
COPY --from=build /go/bin/minio /usr/local/bin/minio
USER 65532:65532
ENTRYPOINT ["minio"]
CMD ["server", "--address", ":9000", "/data"]
