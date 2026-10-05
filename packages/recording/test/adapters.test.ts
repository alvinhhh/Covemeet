import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import {
  EncryptCommand,
  DecryptCommand,
  type KMSClient,
} from "@aws-sdk/client-kms";
import {
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  AwsKmsKeyProvider,
  LocalKeyProvider,
  LocalKeyringProvider,
  S3RecordingStorage,
  RecordingIntegrityError,
  encryptRecording,
  decryptRecordingFromStream,
  decryptRecordingToStream,
  rotateRecordingKey,
} from "../src/index.js";

const context = {
  tenantId: "tenant",
  meetingId: "meeting",
  recordingId: "recording",
};
async function fixture(t: TestContext, size = 131091) {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "recording-adapters-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const raw = join(directory, "raw.mp4");
  const encrypted = join(directory, "cipher.mprec");
  const source = randomBytes(size);
  await writeFile(raw, source);
  const provider = new LocalKeyProvider({ keyId: "old", key: randomBytes(32) });
  t.after(() => provider.destroy());
  const metadata = await encryptRecording(raw, encrypted, context, provider, {
    chunkSize: 65536,
  });
  return { raw, encrypted, source, provider, metadata };
}
async function collect(stream: Readable): Promise<Buffer> {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

test("stream decryption survives arbitrary network framing and closes invalid inputs", async (t) => {
  const f = await fixture(t);
  const bytes = await readFile(f.encrypted);
  function fragmented() {
    return Readable.from(
      (function* () {
        for (let i = 0; i < bytes.length; i += 17)
          yield bytes.subarray(i, i + 17);
      })(),
    );
  }
  assert.deepEqual(
    await collect(
      await decryptRecordingFromStream(
        fragmented(),
        f.metadata,
        context,
        f.provider,
      ),
    ),
    f.source,
  );
  const untouched = fragmented();
  const cancelled = await decryptRecordingFromStream(
    untouched,
    f.metadata,
    context,
    f.provider,
  );
  const closed = new Promise<void>((resolve) =>
    cancelled.once("close", resolve),
  );
  cancelled.destroy();
  await closed;
  assert.equal(
    untouched.destroyed,
    true,
    "cancelling before the first read closes the network source",
  );
  const bad = fragmented();
  await assert.rejects(
    decryptRecordingFromStream(
      bad,
      f.metadata,
      { ...context, tenantId: "other" },
      f.provider,
    ),
  );
  assert.equal(bad.destroyed, true);
  for (const altered of [
    bytes.subarray(0, -1),
    Buffer.concat([bytes, Buffer.from([0])]),
  ]) {
    await assert.rejects(
      collect(
        await decryptRecordingFromStream(
          Readable.from([altered]),
          { ...f.metadata, encryptedBytes: altered.length },
          context,
          f.provider,
        ),
      ),
      RecordingIntegrityError,
    );
  }
  const altered = Buffer.from(bytes);
  altered[99] = altered[99]! ^ 1;
  let emitted = 0;
  await assert.rejects(async () => {
    for await (const chunk of await decryptRecordingFromStream(
      Readable.from([altered]),
      f.metadata,
      context,
      f.provider,
    )) {
      emitted += (chunk as Buffer).length;
    }
  });
  assert.equal(emitted, 0);
});

test("keyring supports staged rotation and restore of old backup metadata", async (t) => {
  const f = await fixture(t);
  const oldKey = randomBytes(32),
    newKey = randomBytes(32);
  const old = new LocalKeyProvider({ keyId: "v1", key: oldKey });
  const rotated = new LocalKeyringProvider({
    activeKeyId: "v2",
    keys: { v1: oldKey, v2: newKey },
  });
  t.after(() => {
    old.destroy();
    rotated.destroy();
    oldKey.fill(0);
    newKey.fill(0);
  });
  const binding = { context, recordingKeyId: f.metadata.recordingKeyId };
  const key = randomBytes(32);
  const oldEnvelope = await old.wrapKey(key, binding);
  assert.deepEqual(await rotated.unwrapKey(oldEnvelope, binding), key);
  assert.equal((await rotated.wrapKey(key, binding)).keyId, "v2");
  const copy = await rotateRecordingKey(
    f.metadata,
    context,
    f.provider,
    rotated,
  );
  assert.deepEqual(
    await collect(
      await decryptRecordingToStream(f.encrypted, copy, context, rotated),
    ),
    f.source,
  );
  assert.deepEqual(
    await collect(
      await decryptRecordingToStream(
        f.encrypted,
        f.metadata,
        context,
        f.provider,
      ),
    ),
    f.source,
  );
  await assert.rejects(
    rotated.unwrapKey({ ...oldEnvelope, keyId: "missing" }, binding),
    RecordingIntegrityError,
  );
  rotated.destroy();
  await assert.rejects(rotated.wrapKey(key, binding), /destroyed/);
});

test("KMS adapter pins immutable key IDs, binds all context, and erases SDK plaintext", async () => {
  const arn =
    "arn:aws:kms:us-east-1:123456789012:key/12345678-1234-1234-1234-123456789abc";
  const records = new Map<string, { key: Buffer; context: unknown }>();
  let requestKey: Uint8Array | undefined, responseKey: Uint8Array | undefined;
  let calls = 0;
  const client = {
    send: async (command: EncryptCommand | DecryptCommand) => {
      calls++;
      assert.equal(command.input.KeyId, arn);
      assert.equal(command.input.EncryptionAlgorithm, "SYMMETRIC_DEFAULT");
      if (command instanceof EncryptCommand) {
        requestKey = command.input.Plaintext!;
        const cipher = randomBytes(128);
        records.set(cipher.toString("base64"), {
          key: Buffer.from(requestKey),
          context: command.input.EncryptionContext,
        });
        return {
          KeyId: arn,
          EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
          CiphertextBlob: cipher,
        };
      }
      const entry = records.get(
        Buffer.from(command.input.CiphertextBlob!).toString("base64"),
      )!;
      assert.deepEqual(command.input.EncryptionContext, entry.context);
      responseKey = Buffer.from(entry.key);
      return {
        KeyId: arn,
        EncryptionAlgorithm: "SYMMETRIC_DEFAULT",
        Plaintext: responseKey,
      };
    },
  } as unknown as Pick<KMSClient, "send">;
  const provider = new AwsKmsKeyProvider({
    region: "us-east-1",
    activeKeyId: arn,
    client,
  });
  const key = randomBytes(32),
    binding = { context, recordingKeyId: randomBytes(16).toString("hex") };
  const wrapped = await provider.wrapKey(key, binding);
  assert.ok(requestKey!.every((byte) => byte === 0));
  assert.deepEqual(await provider.unwrapKey(wrapped, binding), key);
  assert.ok(responseKey!.every((byte) => byte === 0));
  for (const field of ["tenantId", "meetingId", "recordingId"] as const) {
    await assert.rejects(
      provider.unwrapKey(wrapped, {
        ...binding,
        context: { ...context, [field]: "changed" },
      }),
      RecordingIntegrityError,
    );
  }
  await assert.rejects(
    provider.unwrapKey(wrapped, {
      ...binding,
      recordingKeyId: randomBytes(16).toString("hex"),
    }),
  );
  const before = calls;
  await assert.rejects(
    provider.unwrapKey(
      { ...wrapped, keyId: arn.replace("123456789012", "999999999999") },
      binding,
    ),
  );
  assert.equal(
    calls,
    before,
    "an envelope cannot select an arbitrary cloud key",
  );
  assert.throws(
    () =>
      new AwsKmsKeyProvider({
        region: "us-east-1",
        activeKeyId: "alias/recordings",
        client,
      }),
  );
});

/** SDK-boundary fake: exercises command contracts and failure recovery, not an AWS integration. */
class ObjectStoreFake {
  objects = new Map<
    string,
    { bytes: Buffer; metadata: Record<string, string>; etag: string }
  >();
  uploads = new Map<
    string,
    { key: string; parts: Buffer[]; metadata: Record<string, string> }
  >();
  creates = 0;
  aborts = 0;
  failPart = 0;
  loseCompletion = false;
  corruptRead = false;
  async send(command: any): Promise<any> {
    const input = command.input;
    if (command instanceof CreateMultipartUploadCommand) {
      assert.equal(input.ContentType, "application/vnd.covemeet.recording");
      assert.equal(input.CacheControl, "private, no-store");
      assert.equal(input.ACL, undefined);
      const id = String(++this.creates);
      this.uploads.set(id, {
        key: input.Key,
        parts: [],
        metadata: input.Metadata,
      });
      return { UploadId: id };
    }
    if (command instanceof UploadPartCommand) {
      if (input.PartNumber === this.failPart)
        throw new Error("upload unavailable");
      const bytes = Buffer.from(input.Body);
      assert.ok(bytes.length <= 8 * 1024 * 1024);
      assert.equal(
        input.ChecksumSHA256,
        createHash("sha256").update(bytes).digest("base64"),
      );
      this.uploads.get(input.UploadId)!.parts[input.PartNumber - 1] = bytes;
      return {
        ETag: `"part-${input.PartNumber}"`,
        ChecksumSHA256: input.ChecksumSHA256,
      };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      assert.equal(input.IfNoneMatch, "*");
      if (this.objects.has(input.Key))
        throw Object.assign(new Error("exists"), {
          name: "PreconditionFailed",
        });
      const upload = this.uploads.get(input.UploadId)!;
      this.objects.set(input.Key, {
        bytes: Buffer.concat(upload.parts),
        metadata: upload.metadata,
        etag: '"immutable"',
      });
      if (this.loseCompletion)
        throw new Error("completion acknowledgement lost");
      return { ETag: '"immutable"' };
    }
    if (command instanceof AbortMultipartUploadCommand) {
      this.aborts++;
      this.uploads.delete(input.UploadId);
      return {};
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(input.Key);
      if (!object) throw new Error("missing");
      if (input.IfMatch) assert.equal(input.IfMatch, object.etag);
      const bytes = Buffer.from(object.bytes);
      if (this.corruptRead) bytes[90] = bytes[90]! ^ 1;
      return {
        Body: Readable.from(
          (function* () {
            for (let i = 0; i < bytes.length; i += 4093)
              yield bytes.subarray(i, i + 4093);
          })(),
        ),
        ContentLength: bytes.length,
        ETag: object.etag,
        Metadata: object.metadata,
        VersionId: "object-version-1",
      };
    }
    if (command instanceof DeleteObjectCommand) {
      assert.equal(input.IfMatch, '"immutable"');
      assert.equal(input.VersionId, "object-version-1");
      this.objects.delete(input.Key);
      return {};
    }
    throw new Error("unexpected object operation");
  }
  adapter() {
    return new S3RecordingStorage({
      bucket: "private-recordings",
      region: "us-east-1",
      client: this as unknown as Pick<S3Client, "send">,
    });
  }
}

test("S3 stores only verified ciphertext with bounded multipart uploads and context-bound immutable references", async (t) => {
  const f = await fixture(t, 9 * 1024 * 1024 + 93);
  const fake = new ObjectStoreFake(),
    storage = fake.adapter();
  const ref = await storage.put(f.encrypted, f.metadata, context, f.provider);
  assert.equal(fake.uploads.size, 0);
  assert.equal(fake.objects.size, 1);
  assert.deepEqual(
    fake.objects.get(ref.key)!.bytes,
    await readFile(f.encrypted),
  );
  assert.notDeepEqual(
    fake.objects.get(ref.key)!.bytes.subarray(0, 32),
    f.source.subarray(0, 32),
  );
  assert.deepEqual(
    await collect(
      await decryptRecordingFromStream(
        await storage.read(ref, f.metadata, context),
        f.metadata,
        context,
        f.provider,
      ),
    ),
    f.source,
  );
  assert.deepEqual(
    await storage.put(f.encrypted, f.metadata, context, f.provider),
    ref,
    "retry recovers exact object, without replacement",
  );
  await assert.rejects(
    storage.read({ ...ref, key: "other/file" }, f.metadata, context),
    RecordingIntegrityError,
  );
  await assert.rejects(
    storage.read(ref, f.metadata, { ...context, tenantId: "other" }),
    RecordingIntegrityError,
  );
  fake.corruptRead = true;
  await assert.rejects(
    collect(await storage.read(ref, f.metadata, context)),
    RecordingIntegrityError,
  );
  fake.corruptRead = false;
  await storage.delete(ref, f.metadata, context);
  assert.equal(fake.objects.size, 0);
});

test("S3 rejects plaintext before uploading and aborts failed uploads without destroying recovery files", async (t) => {
  const f = await fixture(t);
  const fake = new ObjectStoreFake(),
    storage = fake.adapter();
  await assert.rejects(
    storage.put(
      f.raw,
      { ...f.metadata, encryptedBytes: f.source.length },
      context,
      f.provider,
    ),
  );
  assert.equal(fake.creates, 0);
  fake.failPart = 1;
  await assert.rejects(
    storage.put(f.encrypted, f.metadata, context, f.provider),
    /upload unavailable/,
  );
  assert.equal(fake.uploads.size, 0);
  assert.equal(fake.objects.size, 0);
  assert.equal((await readFile(f.encrypted)).length, f.metadata.encryptedBytes);
  fake.failPart = 0;
  fake.loseCompletion = true;
  const ref = await storage.put(f.encrypted, f.metadata, context, f.provider);
  assert.equal(
    fake.objects.has(ref.key),
    true,
    "lost completion acknowledgement is recovered by full ciphertext comparison",
  );
});

test("S3 cancellation immediately closes a stalled response while the checked iterator is awaiting bytes", async (t) => {
  const f = await fixture(t);
  const fake = new ObjectStoreFake(),
    storage = fake.adapter();
  const ref = await storage.put(f.encrypted, f.metadata, context, f.provider);
  const body = new Readable({ read() {} });
  t.after(() => body.destroy());
  const prefix = fake.objects.get(ref.key)!.bytes.subarray(0, 4093);
  body.push(prefix);
  const send = fake.send.bind(fake);
  fake.send = async (command) => {
    const response = await send(command);
    if (command instanceof GetObjectCommand) {
      response.Body.destroy();
      response.Body = body;
    }
    return response;
  };
  const output = await storage.read(ref, f.metadata, context);
  const iterator = output[Symbol.asyncIterator]();
  assert.deepEqual((await iterator.next()).value, prefix);
  const pending = iterator.next();
  // Observe cancellation without leaving a rejected iterator promise unhandled.
  const settled = pending.then(
    () => undefined,
    () => undefined,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  output.destroy();
  assert.equal(
    body.destroyed,
    true,
    "Cancellation must destroy the HTTP body before waiting for iterator completion",
  );
  await settled;
});

test("S3 forwards cancellation before GetObject responds and closes a late response", async (t) => {
  const f = await fixture(t);
  const fake = new ObjectStoreFake(),
    storage = fake.adapter();
  const ref = await storage.put(f.encrypted, f.metadata, context, f.provider);
  const send = fake.send.bind(fake);
  const controller = new AbortController();
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let calls = 0;
  fake.send = async (command, options?: { abortSignal?: AbortSignal }) => {
    assert.ok(command instanceof GetObjectCommand);
    assert.equal(options?.abortSignal, controller.signal);
    calls++;
    return new Promise((_resolve, reject) => {
      controller.signal.addEventListener(
        "abort",
        () => reject(controller.signal.reason),
        { once: true },
      );
      enter();
    });
  };
  const pending = storage.read(ref, f.metadata, context, controller.signal);
  const denied = assert.rejects(pending, { name: "AbortError" });
  await entered;
  controller.abort();
  await denied;
  await assert.rejects(
    storage.read(ref, f.metadata, context, controller.signal),
    { name: "AbortError" },
  );
  assert.equal(calls, 1, "An already-aborted read must not send GetObject");

  const late = new AbortController();
  const response = await send(
    new GetObjectCommand({
      Bucket: "private-recordings",
      Key: ref.key,
      IfMatch: ref.etag,
    }),
  );
  fake.send = async (_command, options?: { abortSignal?: AbortSignal }) => {
    assert.equal(options?.abortSignal, late.signal);
    late.abort(); // The SDK may already have resolved its response when cancellation arrives.
    return response;
  };
  await assert.rejects(storage.read(ref, f.metadata, context, late.signal), {
    name: "AbortError",
  });
  assert.equal(response.Body.destroyed, true);
});

test("S3 refuses unencrypted remote endpoints, unsafe prefixes, and excessive object sizes", () => {
  const base = { bucket: "private-recordings", region: "us-east-1" };
  for (const endpoint of [
    "http://store.example",
    "http://localhost:9000",
    "https://user:password@store.example",
    "https://store.example/path",
  ]) {
    assert.throws(
      () =>
        new S3RecordingStorage({
          ...base,
          endpoint,
          allowInsecureLocalEndpoint: true,
        }),
    );
  }
  assert.doesNotThrow(
    () =>
      new S3RecordingStorage({
        ...base,
        endpoint: "http://127.0.0.1:9000",
        allowInsecureLocalEndpoint: true,
      }),
  );
  assert.throws(() => new S3RecordingStorage({ ...base, prefix: "../other" }));
  assert.throws(
    () => new S3RecordingStorage({ ...base, maxBytes: 65 * 1024 ** 3 }),
  );
});
