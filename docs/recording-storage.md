# Recording keys, object storage, and recovery

The application supports its existing local encrypted files, a rotating local keyring, AWS KMS envelope wrapping, and private S3-compatible ciphertext storage. Existing `operator-kek-v1` envelopes remain readable with the original `RECORDING_KEK`. These adapters do not establish FIPS validation, media E2EE, production readiness, or compliance.

Recording starts only after the host enables recording and verifies an email address. The recorder is a trusted participant that can access plaintext media. Keep its raw spool on bounded tmpfs or an encrypted ephemeral volume, with encrypted/disabled swap and restricted access. The encryption package authenticates each chunk with AES-256-GCM and a separate per-recording data key before storage. It cannot retroactively secure a raw file already written to a durable unencrypted filesystem.

## Local keys and rotation

`RECORDING_KEY_PROVIDER=local` is the default. `RECORDING_KEK` supplies the legacy 32-byte base64 key under `RECORDING_KEK_ID` (default `operator-kek-v1`). Additional keys come from `RECORDING_LOCAL_KEYS`, a secret-manager-injected JSON object mapping key IDs to canonical base64 32-byte values. `RECORDING_ACTIVE_KEY_ID` chooses the key for new recordings and rewrapping. Do not place real keyring values in Git, browser fields, command arguments, screenshots, or logs.

To rotate safely:

1. Back up the database envelopes, object references, and ciphertext. Preserve wrapping keys separately under restricted operator access. A ciphertext backup without its exact envelope and recoverable wrapping key cannot be restored.
2. Add a new key to the keyring while retaining every key needed by live recordings and retained backups. Set its ID as active and restart the service. New recordings now use it; older recordings remain readable.
3. Call `POST /api/admin/meetings/:code/recordings/:id/rotate-key` through an authenticated operator session with the required mutation-origin/header protections. It accepts no caller-selected key. Ordinary meeting hosts and guests cannot rotate wrapping keys. The configured active key is the only target.
4. The service unwraps the existing data key, wraps it under the active key, verifies the entire recording through authenticated decryption, and atomically replaces unchanged database metadata. Ciphertext bytes, object key/version, tenant/meeting/recording binding, and recording data-key ID remain unchanged. A verification or concurrent-update failure keeps the prior envelope.
5. Restore and decrypt a backup using the retained key configuration before retiring any key. Do not retire an old key just because current rows have been rewrapped: older database backups still contain the older envelopes. Rewrapping cannot revoke copies of a data key already obtained by an attacker.

Local keys remain operator-controlled in self-hosted installations. Keyring buffers are cleared on destruction; JavaScript/OpenSSL memory handling is best effort, not guaranteed complete process-memory erasure. The application secret configuration itself remains present for its lifetime.

## AWS KMS

Set `RECORDING_KEY_PROVIDER=aws-kms`, `RECORDING_KMS_REGION`, and `RECORDING_KMS_KEY_ARN`. The key must be a symmetric encrypt/decrypt key addressed by its immutable key ARN. Aliases are deliberately rejected. List older permitted ARNs in `RECORDING_KMS_DECRYPT_KEY_ARNS`; envelopes cannot select arbitrary KMS keys outside this allowlist.

The official pinned AWS SDK uses workload identity or its standard credential chain. Grant only the required KMS encrypt/decrypt permissions on the configured keys. The adapter authenticates purpose, tenant, meeting, recording, and recording data-key ID using KMS EncryptionContext; it verifies the returned algorithm and key ARN. Context is not secret: KMS audit records can contain it, so use opaque IDs rather than personal data. [KMS Encrypt](https://docs.aws.amazon.com/kms/latest/APIReference/API_Encrypt.html), [KMS Decrypt](https://docs.aws.amazon.com/kms/latest/APIReference/API_Decrypt.html)

Retain a local keyring when migrating older local envelopes to KMS. Conversely, retain the KMS recovery configuration if migrating back to local keys. Switching the active provider does not itself migrate existing metadata. The operator rotation action supports both transitions. KMS credentials, plaintext data keys, and recording passwords are never stored in object metadata.

## Private S3-compatible ciphertext storage

Set `RECORDING_STORAGE=s3` plus `RECORDING_S3_BUCKET`, `RECORDING_S3_REGION`, and optionally an HTTPS `RECORDING_S3_ENDPOINT`, safe `RECORDING_S3_PREFIX`, and `RECORDING_S3_PATH_STYLE=true`. The endpoint is fixed operator configuration. Production rejects plaintext HTTP. Local tests may explicitly enable an HTTP loopback IP endpoint with `RECORDING_S3_ALLOW_LOCAL_HTTP=true`; `localhost` or arbitrary HTTP hostnames are not accepted.

Use a dedicated private bucket/prefix and least-privilege workload identity. Enable public-access blocking, enable versioning for recovery after administrative replacement, and deny insecure transport in the provider policy. The adapter never requests a public ACL or returns a public/presigned object URL. Application-layer ciphertext remains encrypted independently of optional provider disk encryption. The code cannot prove that an operator's bucket policy is private; verify that with the actual provider before deployment. Unversioned buckets retain conditional-write and integrity checks, but cannot restore a replaced object through an earlier version ID.

The upload path verifies complete authenticated ciphertext before starting multipart upload. Parts are at most 8 MiB; the configured object bound defaults to 64 GiB and cannot exceed that limit. Every part carries a SHA-256 checksum. Completion uses `If-None-Match: *`, so existing object keys are not overwritten. Object keys derive from the authorized context and immutable recording data-key ID. Confirm your S3-compatible provider supports conditional multipart completion and checksums. A provider that ignores those semantics is unsupported. [S3 conditional completion](https://docs.aws.amazon.com/AmazonS3/latest/API/API_CompleteMultipartUpload.html)

After completion, the adapter reads back the entire ciphertext and compares its size and SHA-256 digest before returning its immutable reference. This extra read incurs transfer cost. A lost completion acknowledgement or duplicate retry is recovered only if the existing object's bytes match exactly. A failed upload is aborted when possible; configure a bucket lifecycle rule to abort incomplete multipart uploads because process death can prevent cleanup.

The API commits the object reference alongside encryption metadata before deleting either the raw spool or local ciphertext recovery copy. A database or upload failure leaves the row unavailable and retryable. A restart after the reference commit can finish local cleanup without re-encrypting. Ciphertext objects created before a lost database acknowledgement may be orphaned; configure an appropriate object-expiration policy and reconcile orphan objects against database backups before deletion. Lifecycle expiry is asynchronous and is not proof of immediate deletion.

Downloads still require the matching host session, a valid unexpired 24-hour token, and the separately emailed password. S3 downloads use the committed key, version, ETag, length, and digest, then stream per-chunk authenticated decryption directly to the response. No decrypted intermediate file is created. Complete-file integrity requires a clean stream end; earlier authenticated chunks may already have reached the authorized host when later corruption aborts the response. Disconnecting the response closes the upstream object stream, including cancellation before the first read.

The current seven-day retention path revokes download access before deleting the referenced object/version. A storage outage keeps deletion retryable. Provider replicas, noncurrent versions, independent backups, and lifecycle delays require their own retention policy and restore/deletion evidence. Do not disable the S3 configuration while live rows still reference it. Existing local recordings continue using local files after S3 is enabled; there is no automatic bulk data migration.

## Recovery and deployment limits

Back up the database, key configuration/identity policy, ciphertext, and object version IDs coherently. Test restoration with both an old unrotated envelope and a newly rotated one. Keep the object bucket/prefix configuration stable across restore; metadata cannot redirect recovery to another bucket or prefix. A missing key, wrong context, changed object, or absent recovery provider fails closed.

The adapter tests cover command contracts and failure handling with SDK-boundary fakes; they do not prove AWS IAM, provider compatibility, bucket policy, regional availability, or a real KMS integration. Run an isolated S3-compatible integration and a separately authorized provider test before external use. No billable cloud calls are made by the unit tests.

The opt-in integration test is `packages/recording/test/s3.integration.test.ts`. It accepts only a loopback IP endpoint and explicit fixture credentials supplied through `TEST_S3_ENDPOINT`, `TEST_S3_ACCESS_KEY`, `TEST_S3_SECRET_KEY`, and optional `TEST_S3_REGION`. It creates and cleans up its own random private test bucket, enables versioning, uploads encrypted multipart data, verifies retry immutability, restores the committed version after an administrative overwrite, and verifies deletion cannot fall back to another version. It does not use ambient cloud credentials. With the isolated fixture running and its environment file protected and ignored by Git, run from the repository root:

```sh
node --env-file=runtime/storage-test/.env --import tsx --test packages/recording/test/s3.integration.test.ts
```

The ordinary test suite skips this provider test unless explicitly configured. A compatible emulator passing it does not establish production provider, IAM, KMS, or bucket-policy validation.

Local validation on 2026-10-04 passed this test against the isolated source-built MinIO `RELEASE.2025-10-15T17-29-55Z` fixture in `infra/minio-test.Dockerfile`. The test uses the production adapter's three-attempt SDK policy, including reconnecting when the provider closes a socket after rejecting a duplicate conditional write. The test cleaned its generated bucket and object versions. This disposable fixture is not a production storage recommendation.

The application currently has a process-local reconciliation guard. Run one recording reconciler until durable distributed job claims are implemented and tested. Multiple API replicas must not concurrently encrypt or clean the same spool. Object immutability and compare-and-swap rotation protect their own boundaries; they are not a replacement for recording-job leasing, orphan reconciliation, storage quotas, or operational restore drills.
