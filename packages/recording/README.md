# Recording encryption

This package provides authenticated encryption for stored recordings and password verifiers for download access. It does not implement meeting media E2EE, recording consent, link expiry, host sessions, email delivery, or authorization. The application must enforce those controls. No FIPS validation or compliance certification is claimed.

## API

```ts
const context = { tenantId, meetingId, recordingId };
const provider = new LocalKeyProvider({ keyId: "operator-key-v1", key: kekBytes });
const metadata = await encryptRecording(spoolPath, encryptedPath, context, provider);
// Atomically store metadata with the corresponding recording row after success.
const stream = await decryptRecordingToStream(encryptedPath, metadata, context, provider);
await pipeline(stream, authorizedHttpResponse);
```

`encryptRecording` reads a file in chunks (default 1 MiB, configurable 64 KiB–4 MiB) and writes only encrypted bytes to a new exclusive file with permission mode `0600`. It refuses input/output leaf symlinks, relative paths, traversal components and existing outputs. The configured directories must be owned and writable only by trusted operators/processes: these checks are not a sandbox against a malicious local filesystem administrator. The recorder's source spool must already be on an encrypted ephemeral volume, or memory-backed storage, and must be deleted by the caller on success and failure. This library does not make an existing plaintext source file encrypted at rest.

Every recording uses a new random 256-bit data key. A `KeyProvider` wraps it with authenticated context consisting of tenant, meeting, recording, and a random recording key ID. `LocalKeyProvider` uses an operator-supplied 256-bit key; keep it outside the media/database store and supply it through a secret manager. A KMS adapter can implement the interface with its service's authenticated encryption context. Adapters must authenticate **all** binding fields and must return a new buffer from `unwrapKey`, because the package erases it after use. Never reuse a provider's internal KEK as a returned data key.

The returned envelope metadata is stored separately in the database. The encrypted file includes its recording key ID and context hash, both authenticated with every chunk. The caller must pass context from its already authorized database query when decrypting. Do not derive the expected context from a client-supplied envelope.

`rotateRecordingKey(metadata, expectedContext, oldProvider, newProvider)` produces a new wrapped envelope without rewriting the file. Atomically save the new metadata and verify recovery before retiring old keys; old backups may still require old keys. Rewrapping does not revoke someone who previously copied the old key and envelope. Key material is cleared in owned JavaScript buffers on a best-effort basis; Node/OpenSSL and garbage-collected runtimes cannot promise complete process-memory zeroization.

## Format v1

All integers are unsigned big-endian. Header: 8-byte magic `MPREC001`, 4-byte maximum chunk size, 8-byte nonce prefix, 16-byte recording key ID, 32-byte SHA-256 hash of UTF-8 JSON `[tenantId, meetingId, recordingId]`. The header is 68 bytes.

Every frame is a 9-byte frame header (kind: 1 byte; sequential index: 4 bytes; ciphertext length: 4 bytes), ciphertext, then a 16-byte AES-256-GCM tag. The nonce is the 8-byte file prefix plus the 4-byte frame index. AAD is the entire immutable file header followed by the frame header. Nonces never repeat within a recording; there is a new random DEK for every recording. Index `0xffffffff` is reserved as the final possible index, so encryption stops before nonce exhaustion.

Data frames have kind `0` and a positive length no greater than the configured chunk size. Completion is a kind `1`, zero-length authenticated final frame at the next index. Reorder, duplicate, missing, modified and trailing frames fail verification. Header/length limits are checked before allocating chunk buffers. This is a versioned container around standard AES-GCM primitives; it is not a standardized interoperable media file format and needs independent security review before production.

`decryptRecordingToStream` never emits a chunk until that chunk's GCM tag validates. **A clean stream EOF is required to establish complete-file integrity.** Earlier, valid chunks may already have been delivered when a later chunk fails. Always consume with `pipeline`, propagate errors, and abort a partial HTTP response. Do not concatenate whole recordings into memory or write a decrypted intermediate file. The package returns an error on size mismatch before streaming, but a matching size alone is not an integrity check. An authorized downloaded MP4 is plaintext on the recipient's device.

## Download credentials

`createDownloadCredentials()` returns a 256-bit URL token, its SHA-256 digest, a separate random 144-bit password, and an Argon2id password hash (64 MiB, 3 iterations, parallelism 1). Store only the digest and password hash. Show the link only to its authorized host; email the password separately to the verified host. Neither secret may appear in logs. Treat raw values as transient; JavaScript strings cannot reliably be erased.

`digestDownloadToken(token)` validates and hashes tokens for lookup. `verifyRecordingPassword(hash, password)` rejects unsupported/unbounded hash parameters; callers must rate-limit and limit concurrent verifications before invoking Argon2. Hashing does not itself enforce a 24-hour expiry, revocation, tenant binding, or host authentication: those belong to the download row and API transaction. Use `Cache-Control: no-store`, safe attachment filenames, and audit the completed download without recording secrets.
