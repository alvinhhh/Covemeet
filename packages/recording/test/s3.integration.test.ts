import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import {
  LocalKeyProvider,
  S3RecordingStorage,
  encryptRecording,
  decryptRecordingFromStream,
  type OwnedRecordingUpload,
} from "../src/index.js";

// Explicit opt-in to an isolated loopback service. Never falls back to ambient AWS credentials/endpoints.
test(
  "isolated S3 provider: owned upload fencing, multipart immutability, and version-pinned restore",
  {
    skip: !process.env.TEST_S3_ENDPOINT,
    timeout: 120_000,
  },
  async (t) => {
    const endpoint = process.env.TEST_S3_ENDPOINT!;
    const url = new URL(endpoint);
    assert.ok(
      ["127.0.0.1", "[::1]"].includes(url.hostname),
      "integration test must target a loopback IP",
    );
    const accessKeyId = process.env.TEST_S3_ACCESS_KEY,
      secretAccessKey = process.env.TEST_S3_SECRET_KEY;
    assert.ok(
      accessKeyId && secretAccessKey,
      "explicit isolated service credentials are required",
    );
    const region = process.env.TEST_S3_REGION ?? "us-east-1";
    const client = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      // Match the production SDK policy, including reconnecting after a conditional response closes its socket.
      maxAttempts: 3,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    const ownedClient = new S3Client({
      endpoint,
      region,
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      maxAttempts: 1,
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    const bucket = `covemeet-recording-test-${randomBytes(8).toString("hex")}`;
    const directory = await mkdtemp(
      join(await realpath(tmpdir()), "covemeet-s3-integration-"),
    );
    const provider = new LocalKeyProvider({
      keyId: "local-integration",
      key: randomBytes(32),
    });
    let created = false;
    let phase = "bucket setup";
    try {
      await client.send(new CreateBucketCommand({ Bucket: bucket }));
      created = true;
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: bucket,
          VersioningConfiguration: { Status: "Enabled" },
        }),
      );
      const storage = new S3RecordingStorage({
        bucket,
        region,
        endpoint,
        forcePathStyle: true,
        allowInsecureLocalEndpoint: true,
        client,
      });
      const context = {
        tenantId: "isolated-test",
        meetingId: randomBytes(16).toString("hex"),
        recordingId: randomBytes(16).toString("hex"),
      };
      const source = randomBytes(9 * 1024 * 1024 + 71);
      const raw = join(directory, "silent-bytes.bin"),
        ciphertext = join(directory, "encrypted.mprec");
      await writeFile(raw, source, { mode: 0o600 });
      const metadata = await encryptRecording(
        raw,
        ciphertext,
        context,
        provider,
      );
      phase = "initial multipart upload";
      const reference = await storage.put(
        ciphertext,
        metadata,
        context,
        provider,
      );
      assert.ok(
        reference.versionId,
        "provider must return the committed object version",
      );
      phase = "conditional multipart retry";
      assert.deepEqual(
        await storage.put(ciphertext, metadata, context, provider),
        reference,
        "conditional multipart retry must not create a replacement version",
      );
      const digest = async () => {
        const hash = createHash("sha256");
        for await (const chunk of await decryptRecordingFromStream(
          await storage.read(reference, metadata, context),
          metadata,
          context,
          provider,
        )) {
          hash.update(chunk);
        }
        return hash.digest("hex");
      };
      const expected = createHash("sha256").update(source).digest("hex");
      phase = "initial download";
      assert.equal(await digest(), expected);
      phase = "owned native upload and exact-version fencing";
      const ownedStorage = new S3RecordingStorage({
        bucket,
        region,
        endpoint,
        forcePathStyle: true,
        allowInsecureLocalEndpoint: true,
        client,
        ownedClient,
      });
      const ownedContext = {
        ...context,
        recordingId: randomBytes(16).toString("hex"),
      };
      const ownedPath = join(directory, "owned.mprec");
      const ownedMetadata = await encryptRecording(
        raw,
        ownedPath,
        ownedContext,
        provider,
      );
      let intent!: OwnedRecordingUpload;
      const options = {
        maxBytes: 3_000_000_000,
        onPrepared: async (value: OwnedRecordingUpload) => {
          intent = value;
        },
      };
      const ownedReference = await ownedStorage.putOwned(
        ownedPath,
        ownedMetadata,
        ownedContext,
        provider,
        options,
      );
      assert.ok(ownedReference.versionId);
      assert.deepEqual(
        await ownedStorage.putOwned(
          ownedPath,
          ownedMetadata,
          ownedContext,
          provider,
          options,
        ),
        ownedReference,
      );
      const fence = await ownedStorage.fenceOwned(
        intent,
        ownedMetadata,
        ownedContext,
      );
      assert.equal(fence.cleaned, true);
      await assert.rejects(
        ownedStorage.read(ownedReference, ownedMetadata, ownedContext),
      );
      const afterFence = await client.send(
        new ListObjectVersionsCommand({ Bucket: bucket, Prefix: intent.key }),
      );
      assert.deepEqual(
        afterFence.Versions?.filter((v) => v.Key === intent.key).map(
          (v) => v.Size,
        ),
        [0],
      );
      assert.equal(
        afterFence.DeleteMarkers?.filter((v) => v.Key === intent.key).length ??
          0,
        0,
      );
      assert.deepEqual(
        await ownedStorage.fenceOwned(intent, ownedMetadata, ownedContext),
        fence,
      );

      phase = "delayed native request after durable fence";
      const lateContext = {
        ...context,
        recordingId: randomBytes(16).toString("hex"),
      };
      const latePath = join(directory, "late.mprec");
      const lateMetadata = await encryptRecording(
        raw,
        latePath,
        lateContext,
        provider,
      );
      let entered!: () => void,
        release!: () => void,
        lateIntent!: OwnedRecordingUpload;
      const began = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const delayedClient = {
        send: async (command: any, options: any) => {
          if (
            command instanceof PutObjectCommand &&
            command.input.ContentLength! > 0
          ) {
            entered();
            await gate;
          }
          return ownedClient.send(command, options);
        },
      } as unknown as S3Client;
      const lateStorage = new S3RecordingStorage({
        bucket,
        region,
        endpoint,
        forcePathStyle: true,
        allowInsecureLocalEndpoint: true,
        client,
        ownedClient: delayedClient,
      });
      const delayed = lateStorage.putOwned(
        latePath,
        lateMetadata,
        lateContext,
        provider,
        {
          maxBytes: 3_000_000_000,
          onPrepared: async (value) => {
            lateIntent = value;
          },
        },
      );
      const rejected = assert.rejects(delayed);
      let deadline: NodeJS.Timeout | undefined;
      try {
        await Promise.race([
          began,
          delayed.then(() => {
            throw new Error("Delayed upload unexpectedly completed");
          }),
          new Promise<never>((_, reject) => {
            deadline = setTimeout(
              () => reject(new Error("Delayed upload did not reach its gate")),
              15_000,
            );
            deadline.unref();
          }),
        ]);
        assert.equal(
          (await lateStorage.fenceOwned(lateIntent, lateMetadata, lateContext))
            .cleaned,
          true,
        );
      } finally {
        if (deadline) clearTimeout(deadline);
        release();
        await rejected;
      }
      const lateVersions = await client.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: lateIntent.key,
        }),
      );
      assert.deepEqual(
        lateVersions.Versions?.filter((v) => v.Key === lateIntent.key).map(
          (v) => v.Size,
        ),
        [0],
      );
      // Simulate an administrative overwrite outside the immutable adapter. Recovery must use the old exact version.
      const altered = await readFile(ciphertext);
      altered[100] = altered[100]! ^ 1;
      phase = "administrative overwrite";
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: reference.key,
          Body: altered,
          Metadata: {
            "cipher-sha256": reference.sha256,
            "recording-key-id": metadata.recordingKeyId,
          },
        }),
      );
      phase = "version-pinned restore after overwrite";
      assert.equal(
        await digest(),
        expected,
        "recording reference must remain pinned to its original version",
      );
      phase = "conditional exact-version deletion";
      await storage.delete(reference, metadata, context);
      await assert.rejects(
        storage.read(reference, metadata, context),
        "deleted version must not fall back to the current object",
      );
    } catch (error) {
      t.diagnostic(`Provider failure during ${phase}`);
      throw error;
    } finally {
      provider.destroy();
      if (created) {
        const listed = await client.send(
          new ListObjectVersionsCommand({ Bucket: bucket }),
        );
        const objects = [
          ...(listed.Versions ?? []),
          ...(listed.DeleteMarkers ?? []),
        ].map(({ Key, VersionId }) => ({ Key, VersionId }));
        if (objects.length)
          await client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: objects, Quiet: true },
            }),
          );
        await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      }
      client.destroy();
      ownedClient.destroy();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
