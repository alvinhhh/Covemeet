import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import {
  decryptRecordingFromStream,
  RecordingIntegrityError,
  type EncryptedRecordingMetadata,
  type RecordingContext,
  type KeyProvider,
} from "./index.js";

export interface RecordingObjectReference {
  provider: "s3";
  key: string;
  etag: string;
  bytes: number;
  sha256: string;
  versionId?: string;
}

export interface RecordingObjectStorage {
  put(
    path: string,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
    provider: KeyProvider,
  ): Promise<RecordingObjectReference>;
  read(
    reference: RecordingObjectReference,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
  ): Promise<Readable>;
  delete(
    reference: RecordingObjectReference,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
  ): Promise<void>;
}

const PART_SIZE = 8 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 ** 3;
const CONTENT_TYPE = "application/vnd.covemeet.recording";

/** Uploads only fully authenticated ciphertext, never a raw recorder spool. */
export class S3RecordingStorage implements RecordingObjectStorage {
  private readonly client: Pick<S3Client, "send">;
  private readonly prefix: string;
  private readonly maximum: number;
  private readonly bucket: string;
  constructor(options: {
    bucket: string;
    region: string;
    endpoint?: string;
    prefix?: string;
    forcePathStyle?: boolean;
    allowInsecureLocalEndpoint?: boolean;
    maxBytes?: number;
    client?: Pick<S3Client, "send">;
  }) {
    if (
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) ||
      !/^[a-z0-9-]{3,32}$/.test(options.region)
    )
      throw new TypeError("Invalid S3 bucket or region");
    this.bucket = options.bucket;
    this.prefix = options.prefix ?? "recordings";
    if (
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(this.prefix) ||
      this.prefix.length > 200
    ) {
      throw new TypeError(
        "S3 recording prefix must contain safe path segments",
      );
    }
    if (options.endpoint) {
      const url = new URL(options.endpoint);
      const local = ["127.0.0.1", "[::1]"].includes(url.hostname);
      if (
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        (url.protocol !== "https:" &&
          !(
            url.protocol === "http:" &&
            local &&
            options.allowInsecureLocalEndpoint
          ))
      ) {
        throw new TypeError(
          "S3 requires HTTPS; only explicitly enabled local IP endpoints may use HTTP",
        );
      }
    }
    this.maximum = options.maxBytes ?? MAX_BYTES;
    if (
      !Number.isSafeInteger(this.maximum) ||
      this.maximum < 93 ||
      this.maximum > MAX_BYTES
    ) {
      throw new TypeError(
        "S3 recording size limit must be between 93 bytes and 64 GiB",
      );
    }
    this.client =
      options.client ??
      new S3Client({
        region: options.region,
        endpoint: options.endpoint,
        forcePathStyle: options.forcePathStyle,
        maxAttempts: 3,
        requestChecksumCalculation: "WHEN_REQUIRED",
        responseChecksumValidation: "WHEN_REQUIRED",
      });
  }
  private objectKey(
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
  ): string {
    if (
      metadata?.version !== 1 ||
      !/^[a-f0-9]{32}$/.test(metadata.recordingKeyId) ||
      !Number.isSafeInteger(metadata.encryptedBytes) ||
      metadata.encryptedBytes < 93 ||
      metadata.encryptedBytes > this.maximum
    ) {
      throw new RecordingIntegrityError();
    }
    for (const field of ["tenantId", "meetingId", "recordingId"] as const) {
      if (
        typeof context?.[field] !== "string" ||
        !context[field] ||
        Buffer.byteLength(context[field]) > 1024 ||
        metadata.context?.[field] !== context[field]
      )
        throw new RecordingIntegrityError();
    }
    const contextHash = createHash("sha256")
      .update(
        JSON.stringify([
          context.tenantId,
          context.meetingId,
          context.recordingId,
        ]),
      )
      .digest("hex");
    return `${this.prefix}/${contextHash}/${metadata.recordingKeyId}.mprec`;
  }
  private validate(
    reference: RecordingObjectReference,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
  ): void {
    if (
      reference?.provider !== "s3" ||
      reference.key !== this.objectKey(metadata, context) ||
      reference.bytes !== metadata.encryptedBytes ||
      !/^[a-f0-9]{64}$/.test(reference.sha256) ||
      typeof reference.etag !== "string" ||
      !reference.etag ||
      reference.etag.length > 256 ||
      /[\x00-\x1f\x7f]/.test(reference.etag) ||
      (reference.versionId !== undefined &&
        (typeof reference.versionId !== "string" ||
          reference.versionId.length > 1024 ||
          !reference.versionId))
    )
      throw new RecordingIntegrityError();
  }
  async put(
    path: string,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
    provider: KeyProvider,
  ): Promise<RecordingObjectReference> {
    metadata = structuredClone(metadata);
    context = { ...context };
    const key = this.objectKey(metadata, context);
    if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0"))
      throw new TypeError("Ciphertext path must be normalized and absolute");
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let uploadId: string | undefined;
    let digest: string | undefined;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== metadata.encryptedBytes)
        throw new RecordingIntegrityError();
      const hash = createHash("sha256");
      const tap = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      // Authenticate the complete file before sending any byte to durable storage.
      await pipeline(
        file.createReadStream({ autoClose: false, start: 0 }),
        tap,
        async (source) => {
          for await (const plaintext of await decryptRecordingFromStream(
            Readable.from(source),
            metadata,
            context,
            provider,
          )) {
            (plaintext as Buffer).fill(0);
          }
        },
      );
      digest = hash.digest("hex");
      const created = await this.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          ContentType: CONTENT_TYPE,
          CacheControl: "private, no-store",
          ChecksumAlgorithm: "SHA256",
          Metadata: {
            "cipher-sha256": digest,
            "recording-key-id": metadata.recordingKeyId,
          },
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
      uploadId = created.UploadId;
      if (!uploadId) throw new Error("Object store omitted the upload ID");
      const parts: {
        PartNumber: number;
        ETag: string;
        ChecksumSHA256: string;
      }[] = [];
      const uploadedHash = createHash("sha256");
      for (let offset = 0; offset < stat.size; ) {
        const buffer = Buffer.allocUnsafe(
          Math.min(PART_SIZE, stat.size - offset),
        );
        let read = 0;
        while (read < buffer.length) {
          const result = await file.read(
            buffer,
            read,
            buffer.length - read,
            offset + read,
          );
          if (!result.bytesRead) throw new RecordingIntegrityError();
          read += result.bytesRead;
        }
        offset += read;
        uploadedHash.update(buffer);
        const checksum = createHash("sha256").update(buffer).digest("base64");
        const partNumber = parts.length + 1;
        const response = await this.client.send(
          new UploadPartCommand({
            Bucket: this.bucket,
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: buffer,
            ContentLength: buffer.length,
            ChecksumSHA256: checksum,
          }),
          { abortSignal: AbortSignal.timeout(120_000) },
        );
        if (
          !response.ETag ||
          (response.ChecksumSHA256 && response.ChecksumSHA256 !== checksum)
        )
          throw new RecordingIntegrityError();
        parts.push({
          PartNumber: partNumber,
          ETag: response.ETag,
          ChecksumSHA256: checksum,
        });
      }
      const extra = Buffer.alloc(1);
      if (
        (await file.read(extra, 0, 1, stat.size)).bytesRead ||
        uploadedHash.digest("hex") !== digest
      )
        throw new RecordingIntegrityError();
      await this.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          MultipartUpload: { Parts: parts },
          IfNoneMatch: "*",
        }),
        { abortSignal: AbortSignal.timeout(120_000) },
      );
      // Verify stored bytes before deleting the local recovery copy, including completion ambiguity.
      const reference = await this.recover(key, digest, metadata, context);
      return reference;
    } catch (error) {
      // A lost completion acknowledgement or duplicate retry may already have committed this exact ciphertext.
      if (uploadId && digest) {
        try {
          const reference = await this.recover(key, digest, metadata, context);
          return reference;
        } catch {
          /* Original failure remains visible; keep the local recovery file. */
        }
      }
      throw error;
    } finally {
      await file.close().catch(() => undefined);
      // Aborting an already-completed upload is harmless; also clean up retry uploads that lost a conditional race.
      if (uploadId)
        await this.client
          .send(
            new AbortMultipartUploadCommand({
              Bucket: this.bucket,
              Key: key,
              UploadId: uploadId,
            }),
            { abortSignal: AbortSignal.timeout(15_000) },
          )
          .catch(() => undefined);
    }
  }
  private async recover(
    key: string,
    digest: string,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
  ): Promise<RecordingObjectReference> {
    const response = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    const body = response.Body;
    if (!(body instanceof Readable))
      throw new Error("Object store returned no Node byte stream");
    try {
      const reference: RecordingObjectReference = {
        provider: "s3",
        key,
        bytes: response.ContentLength ?? -1,
        sha256: digest,
        etag: response.ETag ?? "",
        ...(response.VersionId && response.VersionId !== "null"
          ? { versionId: response.VersionId }
          : {}),
      };
      this.validate(reference, metadata, context);
      if (
        response.Metadata?.["cipher-sha256"] !== digest ||
        response.Metadata?.["recording-key-id"] !== metadata.recordingKeyId
      ) {
        throw new RecordingIntegrityError();
      }
      let bytes = 0;
      const hash = createHash("sha256");
      for await (const chunk of body) {
        bytes += (chunk as Buffer).length;
        if (bytes > reference.bytes) throw new RecordingIntegrityError();
        hash.update(chunk);
      }
      if (bytes !== reference.bytes || hash.digest("hex") !== digest)
        throw new RecordingIntegrityError();
      return reference;
    } finally {
      body.destroy();
    }
  }
  async read(
    reference: RecordingObjectReference,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
  ): Promise<Readable> {
    reference = { ...reference };
    this.validate(reference, metadata, context);
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: reference.key,
        VersionId: reference.versionId,
        IfMatch: reference.etag,
      }),
    );
    const body = response.Body;
    if (!(body instanceof Readable))
      throw new Error("Object store returned no Node byte stream");
    if (
      response.ContentLength !== reference.bytes ||
      response.ETag !== reference.etag ||
      (reference.versionId && response.VersionId !== reference.versionId) ||
      response.Metadata?.["recording-key-id"] !== metadata.recordingKeyId ||
      response.Metadata?.["cipher-sha256"] !== reference.sha256
    ) {
      body.destroy();
      throw new RecordingIntegrityError();
    }
    async function* checked() {
      const hash = createHash("sha256");
      let bytes = 0;
      try {
        for await (const chunk of body as Readable) {
          bytes += (chunk as Buffer).length;
          if (bytes > reference.bytes) throw new RecordingIntegrityError();
          hash.update(chunk);
          yield chunk;
        }
        if (
          bytes !== reference.bytes ||
          hash.digest("hex") !== reference.sha256
        )
          throw new RecordingIntegrityError();
      } finally {
        (body as Readable).destroy();
      }
    }
    const output = Readable.from(checked(), { objectMode: false });
    const failed = (error: Error) => output.destroy(error);
    body.on("error", failed);
    output.once("close", () => {
      body.off("error", failed);
      body.destroy();
    });
    return output;
  }
  async delete(
    reference: RecordingObjectReference,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
  ): Promise<void> {
    this.validate(reference, metadata, context);
    await this.client.send(
      new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: reference.key,
        VersionId: reference.versionId,
        IfMatch: reference.etag,
      }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
  }
}
