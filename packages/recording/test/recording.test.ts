import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import {
  LocalKeyProvider, RecordingIntegrityError, createDownloadCredentials, createDownloadCredentialsFromSecrets,
  decryptRecordingToStream, digestDownloadToken, encryptRecording,
  rotateRecordingKey, verifyRecordingPassword,
  type EncryptedRecordingMetadata, type RecordingContext,
} from "../src/index.js";

const context: RecordingContext = { tenantId: "tenant-a", meetingId: "meeting-a", recordingId: "recording-a" };

async function fixture() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "recording-test-"));
  const source = join(directory, "source.mp4");
  const target = join(directory, "recording.mprec");
  const provider = new LocalKeyProvider({ keyId: "key-1", key: randomBytes(32) });
  return { directory, source, target, provider, cleanup: async () => {
    provider.destroy();
    await rm(directory, { recursive: true, force: true });
  } };
}

async function plaintext(path: string, metadata: EncryptedRecordingMetadata, provider: LocalKeyProvider,
  expectedContext: RecordingContext = context): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of await decryptRecordingToStream(path, metadata, expectedContext, provider)) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

test("authenticated recording round trip; unique files and exclusive restrictive output", async () => {
  const f = await fixture();
  try {
    const content = randomBytes(2 * 1024 * 1024 + 31);
    await writeFile(f.source, content, { mode: 0o600 });
    const metadata = await encryptRecording(f.source, f.target, context, f.provider);
    assert.equal(metadata.plaintextBytes, content.length);
    assert.equal(metadata.encryptedBytes, (await stat(f.target)).size);
    assert.equal((await stat(f.target)).mode & 0o777, 0o600);
    assert.deepEqual(await plaintext(f.target, metadata, f.provider), content);
    const secondPath = join(f.directory, "second.mprec");
    const second = await encryptRecording(f.source, secondPath, context, f.provider);
    assert.notEqual(second.recordingKeyId, metadata.recordingKeyId);
    assert.notDeepEqual(await readFile(secondPath), await readFile(f.target));
    const original = await readFile(f.target);
    await assert.rejects(encryptRecording(f.source, f.target, context, f.provider), { code: "EEXIST" });
    assert.deepEqual(await readFile(f.target), original);
  } finally { await f.cleanup(); }
});

test("empty recording still has an authenticated completion marker", async () => {
  const f = await fixture();
  try {
    await writeFile(f.source, "");
    const metadata = await encryptRecording(f.source, f.target, context, f.provider);
    assert.equal((await plaintext(f.target, metadata, f.provider)).length, 0);
    const damaged = await readFile(f.target);
    damaged[damaged.length - 1] = damaged[damaged.length - 1]! ^ 1;
    await writeFile(f.target, damaged);
    await assert.rejects(plaintext(f.target, metadata, f.provider), RecordingIntegrityError);
  } finally { await f.cleanup(); }
});

test("wrong keys, wrong tenant context and swapped envelopes cannot decrypt", async () => {
  const f = await fixture();
  const wrongProvider = new LocalKeyProvider({ keyId: "key-1", key: randomBytes(32) });
  try {
    await writeFile(f.source, "private recording");
    const metadata = await encryptRecording(f.source, f.target, context, f.provider);
    await assert.rejects(plaintext(f.target, metadata, wrongProvider), RecordingIntegrityError);
    const wrongContext = { ...context, tenantId: "tenant-b" };
    await assert.rejects(plaintext(f.target, metadata, f.provider, wrongContext), RecordingIntegrityError);
    await assert.rejects(plaintext(f.target, { ...metadata, context: wrongContext }, f.provider, wrongContext), RecordingIntegrityError);
    const other = await encryptRecording(f.source, join(f.directory, "other.mprec"), context, f.provider);
    await assert.rejects(plaintext(f.target, { ...metadata, wrappedKey: other.wrappedKey }, f.provider), RecordingIntegrityError);
  } finally { wrongProvider.destroy(); await f.cleanup(); }
});

test("tampering never emits plaintext from a damaged chunk", async () => {
  const f = await fixture();
  try {
    await writeFile(f.source, randomBytes(131072));
    const metadata = await encryptRecording(f.source, f.target, context, f.provider, { chunkSize: 65536 });
    const damaged = await readFile(f.target);
    damaged[68 + 9 + 17] = damaged[68 + 9 + 17]! ^ 1;
    await writeFile(f.target, damaged);
    let bytesEmitted = 0;
    await assert.rejects(async () => {
      for await (const chunk of await decryptRecordingToStream(f.target, metadata, context, f.provider)) {
        bytesEmitted += (chunk as Buffer).length;
      }
    }, RecordingIntegrityError);
    assert.equal(bytesEmitted, 0);
  } finally { await f.cleanup(); }
});

test("truncation, reorder, append, header tampering and damaged final markers fail", async () => {
  const f = await fixture();
  try {
    await writeFile(f.source, randomBytes(3 * 65536));
    const metadata = await encryptRecording(f.source, f.target, context, f.provider, { chunkSize: 65536 });
    const original = await readFile(f.target);
    const frameSize = 9 + 65536 + 16;
    const reordered = Buffer.from(original);
    original.copy(reordered, 68, 68 + frameSize, 68 + 2 * frameSize);
    original.copy(reordered, 68 + frameSize, 68, 68 + frameSize);
    const headerTamper = Buffer.from(original);
    headerTamper[12] = headerTamper[12]! ^ 1;
    const finalTamper = Buffer.from(original);
    finalTamper[finalTamper.length - 1] = finalTamper[finalTamper.length - 1]! ^ 1;
    for (const altered of [
      original.subarray(0, original.length - 25), // Remove the entire authenticated final marker.
      original.subarray(0, original.length - 1),
      reordered, Buffer.concat([original, Buffer.from([0])]), headerTamper, finalTamper,
    ]) {
      await writeFile(f.target, altered);
      // Even an attacker able to alter the length in DB metadata cannot hide damage.
      await assert.rejects(plaintext(f.target, { ...metadata, encryptedBytes: altered.length }, f.provider), RecordingIntegrityError);
    }
  } finally { await f.cleanup(); }
});

test("rotation only rewraps the key and requires the matching new provider", async () => {
  const f = await fixture();
  const replacement = new LocalKeyProvider({ keyId: "key-2", key: randomBytes(32) });
  try {
    await writeFile(f.source, "rotation test");
    const metadata = await encryptRecording(f.source, f.target, context, f.provider);
    const before = await readFile(f.target);
    const rotated = await rotateRecordingKey(metadata, context, f.provider, replacement);
    assert.equal(rotated.wrappedKey.keyId, "key-2");
    assert.equal(metadata.wrappedKey.keyId, "key-1");
    assert.deepEqual(await readFile(f.target), before);
    assert.equal((await plaintext(f.target, rotated, replacement)).toString(), "rotation test");
    await assert.rejects(plaintext(f.target, rotated, f.provider), RecordingIntegrityError);
  } finally { replacement.destroy(); await f.cleanup(); }
});

test("32 MiB input is read and decrypted through bounded chunks", async () => {
  const f = await fixture();
  try {
    const block = randomBytes(65536);
    const inputHash = createHash("sha256");
    const blocks = 512;
    async function* source() {
      for (let i = 0; i < blocks; i++) { inputHash.update(block); yield block; }
    }
    await pipeline(Readable.from(source()), createWriteStream(f.source, { flags: "wx", mode: 0o600 }));
    const metadata = await encryptRecording(f.source, f.target, context, f.provider, { chunkSize: 65536 });
    const outputHash = createHash("sha256");
    let total = 0;
    for await (const chunk of await decryptRecordingToStream(f.target, metadata, context, f.provider)) {
      assert.ok((chunk as Buffer).length <= 65536);
      outputHash.update(chunk as Buffer);
      total += (chunk as Buffer).length;
    }
    assert.equal(total, 32 * 1024 * 1024);
    assert.equal(outputHash.digest("hex"), inputHash.digest("hex"));
  } finally { await f.cleanup(); }
});

test("input and output leaf symlinks and relative paths are rejected", async () => {
  const f = await fixture();
  try {
    await writeFile(f.source, "source survives");
    const link = join(f.directory, "link");
    await symlink(f.source, link);
    await assert.rejects(encryptRecording(link, f.target, context, f.provider));
    await assert.rejects(encryptRecording(f.source, link, context, f.provider));
    await assert.rejects(encryptRecording("relative.mp4", f.target, context, f.provider), TypeError);
    assert.equal((await readFile(f.source)).toString(), "source survives");
  } finally { await f.cleanup(); }
});

test("download credentials are random, hashed and password verification is bounded", async () => {
  const a = await createDownloadCredentials();
  const b = await createDownloadCredentials();
  assert.equal(a.token.length, 43);
  assert.equal(a.password.length, 24);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.password, b.password);
  assert.equal(a.tokenDigest, digestDownloadToken(a.token));
  assert.equal(await verifyRecordingPassword(a.passwordHash, a.password), true);
  assert.equal(await verifyRecordingPassword(a.passwordHash, b.password), false);
  assert.equal(await verifyRecordingPassword(a.passwordHash, "x".repeat(257)), false);
  assert.equal(await verifyRecordingPassword(a.passwordHash.replace("m=65536", "m=999999999"), a.password), false);
  assert.throws(() => digestDownloadToken("short"), TypeError);
});

test("download credentials recover from distinct 32-byte secrets", async () => {
  const tokenSecret = Buffer.alloc(32, 1);
  const passwordSecret = Buffer.alloc(32, 2);
  const credentials = await createDownloadCredentialsFromSecrets(
    tokenSecret,
    passwordSecret,
  );
  assert.equal(credentials.token, tokenSecret.toString("base64url"));
  assert.equal(
    credentials.password,
    passwordSecret.subarray(0, 18).toString("base64url"),
  );
  assert.equal(credentials.tokenDigest, digestDownloadToken(credentials.token));
  assert.equal(
    await verifyRecordingPassword(
      credentials.passwordHash,
      credentials.password,
    ),
    true,
  );
  await assert.rejects(
    createDownloadCredentialsFromSecrets(
      tokenSecret.subarray(1),
      passwordSecret,
    ),
    TypeError,
  );
  await assert.rejects(
    createDownloadCredentialsFromSecrets(tokenSecret, Buffer.alloc(33)),
    TypeError,
  );
  await assert.rejects(
    createDownloadCredentialsFromSecrets(tokenSecret, tokenSecret),
    TypeError,
  );
  await assert.rejects(
    createDownloadCredentialsFromSecrets(tokenSecret, Buffer.from(tokenSecret)),
    TypeError,
  );
  await assert.rejects(
    createDownloadCredentialsFromSecrets(
      tokenSecret,
      Buffer.concat([tokenSecret.subarray(0, 18), Buffer.alloc(14, 3)]),
    ),
    TypeError,
  );
});

test("local envelope authenticates each context component and key identity", async () => {
  const provider = new LocalKeyProvider({ keyId: "envelope-key", key: randomBytes(32) });
  const dataKey = randomBytes(32);
  const binding = { context, recordingKeyId: randomBytes(16).toString("hex") };
  try {
    const wrappedKey = await provider.wrapKey(dataKey, binding);
    const unwrapped = await provider.unwrapKey(wrappedKey, binding);
    assert.deepEqual(Buffer.from(unwrapped), dataKey);
    unwrapped.fill(0);
    for (const field of ["tenantId", "meetingId", "recordingId"] as const) {
      await assert.rejects(provider.unwrapKey(wrappedKey, {
        ...binding, context: { ...context, [field]: "different" },
      }), RecordingIntegrityError);
    }
    await assert.rejects(provider.unwrapKey(wrappedKey, {
      ...binding, recordingKeyId: randomBytes(16).toString("hex"),
    }), RecordingIntegrityError);
    provider.destroy();
    await assert.rejects(provider.unwrapKey(wrappedKey, binding), /destroyed/);
  } finally { dataKey.fill(0); provider.destroy(); }
});
