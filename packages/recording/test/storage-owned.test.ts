import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  truncate,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test, { type TestContext } from "node:test";
import {
  GetBucketVersioningCommand,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  encryptRecording,
  readEncryptionReceipt,
  decryptRecordingToStream,
  LocalKeyProvider,
  S3RecordingStorage,
  type EncryptedRecordingMetadata,
  type OwnedRecordingUpload,
} from "../src/index.js";

const context = {
  tenantId: "owned-test",
  meetingId: "meeting",
  recordingId: "recording",
};
async function fixture(t: TestContext, size = 70_001) {
  const directory = await mkdtemp(
    join(await realpath(tmpdir()), "recording-owned-"),
  );
  t.after(() => rm(directory, { recursive: true, force: true }));
  const raw = join(directory, "raw.mp4"),
    encrypted = join(directory, "cipher.mprec");
  const bytes = randomBytes(size);
  await writeFile(raw, bytes);
  const provider = new LocalKeyProvider({
    keyId: "fixture",
    key: randomBytes(32),
  });
  t.after(() => provider.destroy());
  return { directory, raw, encrypted, bytes, provider };
}
async function collect(source: Readable) {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}
const missing = (name: string) => Object.assign(new Error(name), { name });

test("owned encryption prepares exact size before I/O and retains an immutable closure marker", async (t) => {
  const f = await fixture(t);
  let prepared!: EncryptedRecordingMetadata;
  const exact = 68 + f.bytes.length + 3 * 25;
  const metadata = await encryptRecording(
    f.raw,
    f.encrypted,
    context,
    f.provider,
    {
      chunkSize: 65536,
      maxEncryptedBytes: exact,
      onPrepared: async (value) => {
        prepared = value;
        assert.equal(value.encryptedBytes, exact);
        await assert.rejects(stat(f.encrypted), { code: "ENOENT" });
        await assert.rejects(stat(f.encrypted + ".partial"), {
          code: "ENOENT",
        });
      },
    },
  );
  assert.deepEqual(metadata, prepared);
  assert.equal((await stat(f.encrypted)).size, exact);
  assert.deepEqual(
    await readEncryptionReceipt(f.encrypted, metadata, context),
    { version: 1, published: true, bytes: exact },
  );
  assert.deepEqual(
    await collect(
      await decryptRecordingToStream(
        f.encrypted,
        metadata,
        context,
        f.provider,
      ),
    ),
    f.bytes,
  );
  await assert.rejects(stat(f.encrypted + ".partial"), { code: "ENOENT" });
  assert.equal((await stat(f.encrypted + ".closed")).mode & 0o777, 0o600);
  // Removing the data does not permit a delayed duplicate writer to recreate it.
  await unlink(f.encrypted);
  await assert.rejects(
    encryptRecording(f.raw, f.encrypted, context, f.provider, {
      onPrepared: async () => {},
    }),
    { code: "EEXIST" },
  );
  await assert.rejects(stat(f.encrypted), { code: "ENOENT" });
  assert.deepEqual(
    await readEncryptionReceipt(f.encrypted, metadata, context),
    { version: 1, published: true, bytes: exact },
  );
  await assert.rejects(
    readEncryptionReceipt(
      f.encrypted,
      {
        ...metadata,
        wrappedKey: { ...metadata.wrappedKey, keyId: "different" },
      },
      context,
    ),
  );
});

test("ciphertext ceiling includes all format bytes and rejects before preparation", async (t) => {
  const f = await fixture(t, 0);
  let prepared = false;
  await assert.rejects(
    encryptRecording(f.raw, f.encrypted, context, f.provider, {
      maxEncryptedBytes: 92,
      onPrepared: async () => {
        prepared = true;
      },
    }),
  );
  assert.equal(prepared, false);
  const metadata = await encryptRecording(
    f.raw,
    f.encrypted,
    context,
    f.provider,
    {
      maxEncryptedBytes: 93,
      onPrepared: async () => {
        prepared = true;
      },
    },
  );
  assert.equal(metadata.encryptedBytes, 93);
  assert.equal(
    (await readEncryptionReceipt(f.encrypted, metadata, context))?.bytes,
    93,
  );
  const larger = await fixture(t);
  await assert.rejects(
    encryptRecording(larger.raw, larger.encrypted, context, larger.provider, {
      maxEncryptedBytes: larger.bytes.length + 92,
      onPrepared: async () => {
        assert.fail("must preflight");
      },
    }),
    /allowance/,
  );
});

test("changed raw size closes the exact failed partial, while colliding paths remain uncertain", async (t) => {
  for (const grow of [false, true]) {
    const f = await fixture(t, 20);
    let prepared!: EncryptedRecordingMetadata;
    await assert.rejects(
      encryptRecording(f.raw, f.encrypted, context, f.provider, {
        maxEncryptedBytes: 138,
        onPrepared: async (value) => {
          prepared = value;
          if (grow) await writeFile(f.raw, Buffer.alloc(21));
          else await truncate(f.raw, 10);
        },
      }),
    );
    const receipt = await readEncryptionReceipt(f.encrypted, prepared, context);
    assert.equal(receipt?.published, false);
    assert.equal(receipt?.bytes, (await stat(f.encrypted + ".partial")).size);
    assert.ok(receipt!.bytes <= prepared.encryptedBytes);
    await assert.rejects(stat(f.encrypted), { code: "ENOENT" });
  }
  for (const collision of [".partial", ""]) {
    const f = await fixture(t, 20);
    const existing = Buffer.from("not this attempt");
    await writeFile(f.encrypted + collision, existing);
    let prepared!: EncryptedRecordingMetadata;
    await assert.rejects(
      encryptRecording(f.raw, f.encrypted, context, f.provider, {
        onPrepared: async (value) => {
          prepared = value;
        },
      }),
      { code: "EEXIST" },
    );
    assert.equal(
      await readEncryptionReceipt(f.encrypted, prepared, context),
      null,
    );
    assert.deepEqual(await readFile(f.encrypted + collision), existing);
  }
});

test("aborted preparation never publishes data and missing receipt is not cleanup proof", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  let prepared!: EncryptedRecordingMetadata;
  await assert.rejects(
    encryptRecording(f.raw, f.encrypted, context, f.provider, {
      signal: controller.signal,
      onPrepared: async (value) => {
        prepared = value;
        controller.abort();
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(
    await readEncryptionReceipt(f.encrypted, prepared, context),
    null,
  );
  await assert.rejects(stat(f.encrypted), { code: "ENOENT" });
  await assert.rejects(stat(f.encrypted + ".partial"), { code: "ENOENT" });
});

type Version = {
  key: string;
  id: string;
  bytes: Buffer;
  metadata: Record<string, string>;
  etag: string;
};
class VersionedStore {
  versions: Version[] = [];
  commands: string[] = [];
  versioning = "Enabled";
  lostPutResponse = false;
  holdData?: () => Promise<void>;
  pageSize = 1;
  mutationChecks?: () => void;
  foreignMarker = false;
  sequence = 0;
  current(key: string, id?: string) {
    return this.versions.find((v) => v.key === key && (!id || v.id === id));
  }
  info(v: Version) {
    return {
      ContentLength: v.bytes.length,
      Metadata: { ...v.metadata },
      ETag: v.etag,
      VersionId: v.id,
    };
  }
  async send(command: any) {
    const input = command.input;
    this.commands.push(command.constructor.name);
    if (command instanceof GetBucketVersioningCommand)
      return { Status: this.versioning };
    if (command instanceof PutObjectCommand) {
      this.mutationChecks?.();
      const bytes = Buffer.isBuffer(input.Body)
        ? Buffer.from(input.Body)
        : await collect(input.Body);
      if (bytes.length > 0) await this.holdData?.();
      const current = this.current(input.Key);
      if (
        (input.IfNoneMatch === "*" && current) ||
        (input.IfMatch && current?.etag !== input.IfMatch)
      )
        throw missing("PreconditionFailed");
      assert.equal(bytes.length, input.ContentLength);
      assert.equal(
        createHash("sha256").update(bytes).digest("base64"),
        input.ChecksumSHA256,
      );
      const version = {
        key: input.Key,
        id: "version-" + ++this.sequence,
        bytes,
        metadata: { ...input.Metadata },
        etag: '"' + createHash("md5").update(bytes).digest("hex") + '"',
      };
      this.versions.unshift(version);
      if (this.lostPutResponse && bytes.length) {
        this.lostPutResponse = false;
        throw new Error("lost response");
      }
      return this.info(version);
    }
    if (
      command instanceof HeadObjectCommand ||
      command instanceof GetObjectCommand
    ) {
      const version = this.current(input.Key, input.VersionId);
      if (!version)
        throw missing(
          command instanceof HeadObjectCommand ? "NotFound" : "NoSuchKey",
        );
      return {
        ...this.info(version),
        ...(command instanceof GetObjectCommand
          ? { Body: Readable.from([version.bytes]) }
          : {}),
      };
    }
    if (command instanceof ListObjectVersionsCommand) {
      const versions = this.versions.filter((v) =>
        v.key.startsWith(input.Prefix),
      );
      const offset = input.VersionIdMarker
        ? versions.findIndex((v) => v.id === input.VersionIdMarker) + 1
        : 0;
      const page = versions.slice(offset, offset + this.pageSize);
      const more = offset + this.pageSize < versions.length;
      return {
        Versions: page.map((v) => ({
          Key: v.key,
          VersionId: v.id,
          ETag: v.etag,
          Size: v.bytes.length,
        })),
        DeleteMarkers: this.foreignMarker
          ? [{ Key: input.Prefix, VersionId: "unowned-delete-marker" }]
          : [],
        IsTruncated: more,
        ...(more
          ? {
              NextKeyMarker: page.at(-1)!.key,
              NextVersionIdMarker: page.at(-1)!.id,
            }
          : {}),
      };
    }
    if (command instanceof DeleteObjectCommand) {
      this.mutationChecks?.();
      assert.ok(input.VersionId, "owned deletion must target an exact version");
      const version = this.current(input.Key, input.VersionId);
      if (version) assert.equal(input.IfMatch, version.etag);
      this.versions = this.versions.filter((v) => v !== version);
      return {};
    }
    throw new Error("Unexpected command " + command.constructor.name);
  }
  adapter() {
    return new S3RecordingStorage({
      bucket: "fixture-recordings",
      region: "us-west-2",
      client: { send: this.send.bind(this) } as unknown as S3Client,
    });
  }
}
async function objectFixture(t: TestContext) {
  const f = await fixture(t);
  const metadata = await encryptRecording(
    f.raw,
    f.encrypted,
    context,
    f.provider,
  );
  const fake = new VersionedStore(),
    adapter = fake.adapter();
  let intent!: OwnedRecordingUpload;
  const options = {
    maxBytes: 3_000_000_000,
    onPrepared: async (value: OwnedRecordingUpload) => {
      intent = value;
    },
  };
  return { ...f, metadata, fake, adapter, options, intent: () => intent };
}

test("owned upload persists intent before native PUT, recovers lost response, and fences all exact versions", async (t) => {
  const f = await objectFixture(t);
  f.fake.mutationChecks = () => assert.ok(f.intent());
  f.fake.lostPutResponse = true;
  const ref = await f.adapter.putOwned(
    f.encrypted,
    f.metadata,
    context,
    f.provider,
    f.options,
  );
  assert.equal(ref.versionId, "version-1");
  assert.deepEqual(
    await f.adapter.recoverOwned(f.intent(), f.metadata, context),
    ref,
  );
  const again = await f.adapter.putOwned(
    f.encrypted,
    f.metadata,
    context,
    f.provider,
    f.options,
  );
  assert.deepEqual(again, ref);
  assert.equal(
    f.fake.versions.length,
    1,
    "replay cannot create another data version",
  );
  // Two matching historical versions require complete pagination; a prefix neighbor is untouched.
  const old = f.fake.versions[0]!;
  f.fake.versions.push(
    { ...old, id: "older-owned" },
    { ...old, key: old.key + "-neighbor", id: "neighbor" },
  );
  const fence = await f.adapter.fenceOwned(f.intent(), f.metadata, context);
  assert.equal(fence.cleaned, true);
  assert.equal(fence.bytes, 0);
  assert.deepEqual(
    f.fake.versions.filter((v) => v.key === ref.key).map((v) => v.bytes.length),
    [0],
  );
  assert.ok(f.fake.versions.some((v) => v.id === "neighbor"));
  assert.deepEqual(
    await f.adapter.fenceOwned(f.intent(), f.metadata, context),
    fence,
  );
  await assert.rejects(
    f.adapter.putOwned(f.encrypted, f.metadata, context, f.provider, f.options),
  );
  assert.ok(
    !f.fake.commands.some(
      (name) => name.includes("Multipart") || name === "UploadPartCommand",
    ),
  );
});

test("a delayed conditional upload cannot repopulate storage after a retained fence", async (t) => {
  const f = await objectFixture(t);
  let entered!: () => void, release!: () => void;
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.fake.holdData = async () => {
    entered();
    await gate;
  };
  const upload = f.adapter.putOwned(
    f.encrypted,
    f.metadata,
    context,
    f.provider,
    f.options,
  );
  const rejected = assert.rejects(upload);
  await began;
  const fence = await f.adapter.fenceOwned(f.intent(), f.metadata, context);
  assert.equal(fence.cleaned, true);
  release();
  await rejected;
  assert.deepEqual(
    f.fake.versions.map((v) => v.bytes.length),
    [0],
  );
});

test("owned storage requires versioning and authenticates before durable upload permission", async (t) => {
  const f = await objectFixture(t);
  for (const versioning of ["Suspended", ""]) {
    f.fake.versioning = versioning;
    await assert.rejects(
      f.adapter.putOwned(
        f.encrypted,
        f.metadata,
        context,
        f.provider,
        f.options,
      ),
      /versioning/,
    );
    assert.equal(f.intent(), undefined);
    assert.equal(f.fake.versions.length, 0);
  }
  f.fake.versioning = "Enabled";
  const corrupt = await readFile(f.encrypted);
  corrupt[100] = corrupt[100]! ^ 1;
  await writeFile(f.encrypted, corrupt);
  await assert.rejects(
    f.adapter.putOwned(f.encrypted, f.metadata, context, f.provider, f.options),
  );
  assert.equal(f.intent(), undefined);
  assert.equal(f.fake.versions.length, 0);
});

test("foreign history and delete markers never authorize a quota release or foreign deletion", async (t) => {
  for (const marker of [false, true]) {
    const f = await objectFixture(t);
    await f.adapter.putOwned(
      f.encrypted,
      f.metadata,
      context,
      f.provider,
      f.options,
    );
    const original = f.fake.versions[0]!;
    if (marker) f.fake.foreignMarker = true;
    else
      f.fake.versions.push({
        ...original,
        id: "foreign",
        metadata: { "recording-key-id": "other" },
      });
    const deletesBefore = f.fake.commands.filter(
      (v) => v === "DeleteObjectCommand",
    ).length;
    await assert.rejects(f.adapter.fenceOwned(f.intent(), f.metadata, context));
    assert.equal(
      f.fake.commands.filter((v) => v === "DeleteObjectCommand").length,
      deletesBefore,
    );
    assert.ok(f.fake.versions.includes(original));
  }
});

test("owned intents cannot be recovered or fenced at a changed destination", async (t) => {
  const f = await objectFixture(t);
  await f.adapter.putOwned(
    f.encrypted,
    f.metadata,
    context,
    f.provider,
    f.options,
  );
  const before = f.fake.commands.length;
  const adapters: S3RecordingStorage[] = [];
  for (const changed of [
    { bucket: "different-recordings", region: "us-west-2" },
    { bucket: "fixture-recordings", region: "us-east-1" },
    {
      bucket: "fixture-recordings",
      region: "us-west-2",
      endpoint: "https://storage.example.test",
    },
  ]) {
    const adapter = new S3RecordingStorage({
      ...changed,
      client: { send: f.fake.send.bind(f.fake) } as unknown as S3Client,
    });
    adapters.push(adapter);
    await assert.rejects(adapter.recoverOwned(f.intent(), f.metadata, context));
    await assert.rejects(adapter.fenceOwned(f.intent(), f.metadata, context));
  }
  assert.equal(
    f.fake.commands.length,
    before,
    "destination mismatch must fail before provider I/O",
  );
  const mutationsBefore = f.fake.commands.filter(
    (name) => name === "PutObjectCommand" || name === "DeleteObjectCommand",
  ).length;
  for (const adapter of adapters) {
    await assert.rejects(
      adapter.putOwned(f.encrypted, f.metadata, context, f.provider, {
        maxBytes: 3_000_000_000,
        onPrepared: async (value) => {
          assert.deepEqual(
            value,
            f.intent(),
            "durable original intent is immutable",
          );
        },
      }),
    );
  }
  assert.equal(
    f.fake.commands.filter(
      (name) => name === "PutObjectCommand" || name === "DeleteObjectCommand",
    ).length,
    mutationsBefore,
  );
  assert.equal(
    f.fake.versions.length,
    1,
    "original destination data remains retained",
  );
});
