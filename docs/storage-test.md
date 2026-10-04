# Local storage compatibility check

This disposable fixture tests the recording storage adapter against real S3-compatible request handling. It contains synthetic bytes only, has its own Docker bridge, publishes only `127.0.0.1:19000`, and keeps its objects in a bounded memory filesystem. It is not attached to the meeting network and receives no cloud credentials. The bridge allows outbound networking; MinIO update checks are disabled, and no cloud API is used by the test. Test credentials are generated in ignored `runtime/storage-test/.env` with mode `0600` and are never printed.

```sh
node scripts/storage-test.mjs start
node --env-file=runtime/storage-test/.env --import tsx --test packages/recording/test/s3.integration.test.ts
node scripts/storage-test.mjs stop
```

Wait until `http://127.0.0.1:19000/minio/health/ready` responds successfully before running the test. The test creates a random bucket, enables versioning, checks multipart ciphertext upload/download, conditional overwrite prevention and version-pinned recovery, and cleans its bucket and versions. The stop command removes only this fixture's containers/network; its memory-resident test objects are discarded. The protected test configuration remains for another run. No real recording, production bucket, or cloud credential belongs here.

The fixture builds the upstream MinIO security release `RELEASE.2025-10-15T17-29-55Z` from source because an official image for that release is unavailable. That repository is archived; this is a test fixture, **not a production storage recommendation**. Compatibility with this fixture does not establish compatibility with every provider, cloud IAM policy, HTTPS endpoint, retention policy or deletion workflow. [Upstream release and source-build instructions](https://github.com/minio/minio/releases/tag/RELEASE.2025-10-15T17-29-55Z)

The production recording adapter requires encrypted remote endpoints. The integration test deliberately opts into the application's development-only explicit-loopback HTTP exception. Do not widen that exception or disable TLS verification to connect to a deployed provider. Provider configuration and open gates are described in [recording storage](recording-storage.md).
