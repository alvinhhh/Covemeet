import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { addAbortSignal, Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  GetBucketVersioningCommand,
  ListObjectVersionsCommand,
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

/** Immutable, durable permission for one conditional native upload (never multipart). */
export interface OwnedRecordingUpload {
  provider: "s3-single";
  /** Binds recovery and deletion to the exact configured destination. */
  storageId: string;
  key: string;
  bytes: number;
  sha256: string;
}
export interface OwnedRecordingFence {
  provider: "s3-single";
  storageId: string;
  key: string;
  etag: string;
  versionId: string;
  bytes: 0;
  cleaned: true;
}
export interface OwnedUploadOptions {
  maxBytes: number;
  onPrepared: (intent: OwnedRecordingUpload) => Promise<void>;
  signal?: AbortSignal;
}
export interface RecordingObjectStorage {
  putOwned?(
    path: string,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
    provider: KeyProvider,
    options: OwnedUploadOptions,
  ): Promise<RecordingObjectReference>;
  recoverOwned?(
    intent: OwnedRecordingUpload,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
  ): Promise<RecordingObjectReference | null>;
  fenceOwned?(
    intent: OwnedRecordingUpload,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
  ): Promise<OwnedRecordingFence>;
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
    signal?: AbortSignal,
  ): Promise<Readable>;
  delete(
    reference: RecordingObjectReference,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
  ): Promise<void>;
}

const PART_SIZE = 8 * 1024 * 1024;
const MAX_BYTES = 64 * 1024 ** 3;
const OWNED_MAX_BYTES = 3_000_000_000;
const CONTENT_TYPE = "application/vnd.covemeet.recording";

/** Uploads only fully authenticated ciphertext, never a raw recorder spool. */
export class S3RecordingStorage implements RecordingObjectStorage {
  private readonly client: Pick<S3Client, "send">;
  private readonly ownedClient: Pick<S3Client, "send">;
  private readonly prefix: string;
  private readonly maximum: number;
  private readonly bucket: string;
  private readonly storageId: string;
  constructor(options: {
    bucket: string;
    region: string;
    endpoint?: string;
    prefix?: string;
    forcePathStyle?: boolean;
    allowInsecureLocalEndpoint?: boolean;
    maxBytes?: number;
    client?: Pick<S3Client, "send">;
    ownedClient?: Pick<S3Client, "send">;
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
    this.storageId = createHash("sha256")
      .update(
        JSON.stringify([
          options.endpoint ? new URL(options.endpoint).origin : "aws-s3",
          options.region,
          options.bucket,
        ]),
      )
      .digest("hex");
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
    const clientOptions = {
      region: options.region,
      endpoint: options.endpoint,
      forcePathStyle: options.forcePathStyle,
      requestChecksumCalculation: "WHEN_REQUIRED" as const,
      responseChecksumValidation: "WHEN_REQUIRED" as const,
    };
    this.client =
      options.client ?? new S3Client({ ...clientOptions, maxAttempts: 3 });
    // Owned writes must not acquire a hidden retry after the caller starts fencing.
    this.ownedClient =
      options.ownedClient ??
      options.client ??
      new S3Client({ ...clientOptions, maxAttempts: 1 });
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
  private async authenticate(
    file: FileHandle,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
    provider: KeyProvider,
    signal?: AbortSignal,
  ) {
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
        ))
          (plaintext as Buffer).fill(0);
      },
      { signal },
    );
    return { size: stat.size, digest: hash.digest("hex") };
  }
  private validateOwned(
    intent: OwnedRecordingUpload,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
  ) {
    if (
      intent?.provider !== "s3-single" ||
      intent.storageId !== this.storageId ||
      intent.key !== this.objectKey(metadata, context) ||
      intent.bytes !== metadata.encryptedBytes ||
      intent.bytes > OWNED_MAX_BYTES ||
      !/^[a-f0-9]{64}$/.test(intent.sha256)
    )
      throw new RecordingIntegrityError();
  }
  private async requireOwnedBucket() {
    const result = await this.ownedClient.send(
      new GetBucketVersioningCommand({ Bucket: this.bucket }),
      { abortSignal: AbortSignal.timeout(30_000) },
    );
    if (result.Status !== "Enabled")
      throw new Error(
        "Owned recording storage requires bucket versioning enabled",
      );
  }
  async putOwned(
    path: string,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
    provider: KeyProvider,
    options: OwnedUploadOptions,
  ): Promise<RecordingObjectReference> {
    metadata = structuredClone(metadata);
    context = { ...context };
    const key = this.objectKey(metadata, context);
    if (
      !Number.isSafeInteger(options.maxBytes) ||
      options.maxBytes < 93 ||
      options.maxBytes > OWNED_MAX_BYTES ||
      metadata.encryptedBytes > options.maxBytes
    )
      throw new Error("Owned recording exceeds ciphertext allowance");
    if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0"))
      throw new TypeError("Ciphertext path must be normalized and absolute");
    options.signal?.throwIfAborted();
    const file = await open(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let upload: Readable | undefined;
    try {
      const { digest } = await this.authenticate(
        file,
        metadata,
        context,
        provider,
        options.signal,
      );
      const intent: OwnedRecordingUpload = {
        provider: "s3-single",
        storageId: this.storageId,
        key,
        bytes: metadata.encryptedBytes,
        sha256: digest,
      };
      await this.requireOwnedBucket();
      await options.onPrepared({ ...intent });
      options.signal?.throwIfAborted();
      upload = file.createReadStream({
        autoClose: false,
        start: 0,
        end: intent.bytes - 1,
      });
      const signal = AbortSignal.any([
        AbortSignal.timeout(120_000),
        ...(options.signal ? [options.signal] : []),
      ]);
      addAbortSignal(signal, upload);
      try {
        const result = await this.ownedClient.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: upload,
            ContentLength: intent.bytes,
            ContentType: CONTENT_TYPE,
            CacheControl: "private, no-store",
            IfNoneMatch: "*",
            ChecksumSHA256: Buffer.from(intent.sha256, "hex").toString(
              "base64",
            ),
            Metadata: {
              "cipher-sha256": intent.sha256,
              "recording-key-id": metadata.recordingKeyId,
            },
          }),
          { abortSignal: signal },
        );
        if (!result.VersionId || result.VersionId === "null")
          throw new RecordingIntegrityError();
        return await this.recover(key, intent.sha256, metadata, context, {
          versionId: result.VersionId,
          signal: options.signal,
        });
      } catch (error) {
        // A lost acknowledgement is recoverable only as this exact authenticated data.
        // A fence or any unknown response retains the durable intent and its full hold.
        if (!options.signal?.aborted) {
          const recovered = await this.recoverOwned(
            intent,
            metadata,
            context,
          ).catch(() => null);
          if (recovered) return recovered;
        }
        throw error;
      }
    } finally {
      upload?.destroy();
      await file.close();
    }
  }
  async recoverOwned(
    intent: OwnedRecordingUpload,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
  ): Promise<RecordingObjectReference | null> {
    this.validateOwned(intent, metadata, context);
    await this.requireOwnedBucket();
    try {
      return await this.recover(
        intent.key,
        intent.sha256,
        metadata,
        context,
        {},
      );
    } catch (error) {
      if ((error as Error).name === "NoSuchKey") return null;
      throw error;
    }
  }
  async fenceOwned(
    intent: OwnedRecordingUpload,
    metadata: EncryptedRecordingMetadata,
    context: RecordingContext,
  ): Promise<OwnedRecordingFence> {
    intent = { ...intent };
    metadata = structuredClone(metadata);
    context = { ...context };
    this.validateOwned(intent, metadata, context);
    await this.requireOwnedBucket();
    const head = async (versionId?: string) =>
      this.ownedClient.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: intent.key,
          VersionId: versionId,
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
    const owned = (value: Awaited<ReturnType<typeof head>>) => {
      if (
        !value.VersionId ||
        value.VersionId === "null" ||
        !value.ETag ||
        value.Metadata?.["cipher-sha256"] !== intent.sha256 ||
        value.Metadata?.["recording-key-id"] !== metadata.recordingKeyId ||
        !(
          (value.ContentLength === intent.bytes &&
            !value.Metadata?.["recording-fence"]) ||
          (value.ContentLength === 0 &&
            value.Metadata?.["recording-fence"] === "closed")
        )
      )
        throw new RecordingIntegrityError();
      return value.ContentLength === 0;
    };
    let fence: Awaited<ReturnType<typeof head>> | undefined;
    // Conditional updates handle an already-completed late upload or another fencer.
    // No unconditional write can cover up an unowned collision.
    for (let attempt = 0; attempt < 4; attempt++) {
      let current: Awaited<ReturnType<typeof head>> | undefined;
      try {
        current = await head();
      } catch (error) {
        if (!["NotFound", "NoSuchKey"].includes((error as Error).name))
          throw error;
      }
      if (current && owned(current)) {
        fence = current;
        break;
      }
      if (current) {
        const data = await this.recover(
          intent.key,
          intent.sha256,
          metadata,
          context,
          { versionId: current.VersionId },
        );
        if (data.etag !== current.ETag) throw new RecordingIntegrityError();
      }
      try {
        await this.ownedClient.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: intent.key,
            Body: Buffer.alloc(0),
            ContentLength: 0,
            ContentType: CONTENT_TYPE,
            CacheControl: "private, no-store",
            ...(current ? { IfMatch: current.ETag } : { IfNoneMatch: "*" }),
            ChecksumSHA256: createHash("sha256")
              .update(Buffer.alloc(0))
              .digest("base64"),
            Metadata: {
              "cipher-sha256": intent.sha256,
              "recording-key-id": metadata.recordingKeyId,
              "recording-fence": "closed",
            },
          }),
          { abortSignal: AbortSignal.timeout(30_000) },
        );
      } catch (error) {
        // Unknown completion may still have installed the exact fence; HEAD decides.
        const after = await head().catch(() => undefined);
        if (after && owned(after)) {
          fence = after;
          break;
        }
        if (
          !["PreconditionFailed", "ConditionalRequestConflict"].includes(
            (error as Error).name,
          )
        )
          throw error;
      }
    }
    if (!fence) {
      fence = await head();
      if (!owned(fence)) throw new RecordingIntegrityError();
    }
    const versions = async () => {
      const result: { versionId: string; etag: string; size: number }[] = [];
      let keyMarker: string | undefined, versionMarker: string | undefined;
      for (let page = 0; page < 100; page++) {
        const listed = await this.ownedClient.send(
          new ListObjectVersionsCommand({
            Bucket: this.bucket,
            Prefix: intent.key,
            KeyMarker: keyMarker,
            VersionIdMarker: versionMarker,
            MaxKeys: 1000,
          }),
          { abortSignal: AbortSignal.timeout(30_000) },
        );
        if (listed.DeleteMarkers?.some((value) => value.Key === intent.key))
          throw new RecordingIntegrityError();
        for (const value of listed.Versions ?? []) {
          if (value.Key !== intent.key) continue;
          if (
            !value.VersionId ||
            value.VersionId === "null" ||
            !value.ETag ||
            !Number.isSafeInteger(value.Size) ||
            (value.Size ?? -1) < 0
          )
            throw new RecordingIntegrityError();
          result.push({
            versionId: value.VersionId,
            etag: value.ETag,
            size: value.Size!,
          });
        }
        if (!listed.IsTruncated) return result;
        if (
          !listed.NextKeyMarker ||
          !listed.NextVersionIdMarker ||
          (listed.NextKeyMarker === keyMarker &&
            listed.NextVersionIdMarker === versionMarker)
        )
          throw new RecordingIntegrityError();
        keyMarker = listed.NextKeyMarker;
        versionMarker = listed.NextVersionIdMarker;
      }
      throw new Error(
        "Owned recording version inventory exceeded bounded scan",
      );
    };
    const inventory = await versions();
    if (
      !inventory.some(
        (value) => value.versionId === fence!.VersionId && value.size === 0,
      )
    )
      throw new RecordingIntegrityError();
    // Verify every exact-key version before deleting any data version.
    for (const value of inventory) {
      if (value.size === 0) {
        const info = await head(value.versionId);
        if (!owned(info)) throw new RecordingIntegrityError();
      } else {
        const data = await this.recover(
          intent.key,
          intent.sha256,
          metadata,
          context,
          { versionId: value.versionId },
        );
        if (data.etag !== value.etag || data.bytes !== value.size)
          throw new RecordingIntegrityError();
      }
    }
    for (const value of inventory) {
      if (value.size === 0) continue; // Retain control tombstones, including a concurrent fencer's.
      await this.ownedClient.send(
        new DeleteObjectCommand({
          Bucket: this.bucket,
          Key: intent.key,
          VersionId: value.versionId,
          IfMatch: value.etag,
        }),
        { abortSignal: AbortSignal.timeout(30_000) },
      );
    }
    const remaining = await versions();
    if (!remaining.length || remaining.some((value) => value.size !== 0))
      throw new RecordingIntegrityError();
    for (const value of remaining)
      if (!owned(await head(value.versionId)))
        throw new RecordingIntegrityError();
    const current = await head();
    if (!owned(current)) throw new RecordingIntegrityError();
    return {
      provider: "s3-single",
      storageId: this.storageId,
      key: intent.key,
      etag: current.ETag!,
      versionId: current.VersionId!,
      bytes: 0,
      cleaned: true,
    };
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
      const verified = await this.authenticate(
        file,
        metadata,
        context,
        provider,
      );
      digest = verified.digest;
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
      for (let offset = 0; offset < verified.size; ) {
        const buffer = Buffer.allocUnsafe(
          Math.min(PART_SIZE, verified.size - offset),
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
        (await file.read(extra, 0, 1, verified.size)).bytesRead ||
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
    owned?: { versionId?: string; signal?: AbortSignal },
  ): Promise<RecordingObjectReference> {
    const signal = owned
      ? AbortSignal.any([
          AbortSignal.timeout(120_000),
          ...(owned.signal ? [owned.signal] : []),
        ])
      : undefined;
    const response = await (owned ? this.ownedClient : this.client).send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        VersionId: owned?.versionId,
      }),
      { abortSignal: signal },
    );
    const body = response.Body;
    if (!(body instanceof Readable))
      throw new Error("Object store returned no Node byte stream");
    if (signal) addAbortSignal(signal, body);
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
        owned &&
        (!reference.versionId ||
          (owned.versionId && reference.versionId !== owned.versionId))
      )
        throw new RecordingIntegrityError();
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
    signal?: AbortSignal,
  ): Promise<Readable> {
    signal?.throwIfAborted();
    reference = { ...reference };
    this.validate(reference, metadata, context);
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: reference.key,
        VersionId: reference.versionId,
        IfMatch: reference.etag,
      }),
      { abortSignal: signal },
    );
    const body = response.Body;
    if (!(body instanceof Readable))
      throw new Error("Object store returned no Node byte stream");
    if (signal?.aborted) {
      body.destroy();
      signal.throwIfAborted();
    }
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
    // Close the HTTP response before waiting for a stalled iterator to return.
    const destroy = output._destroy;
    output._destroy = (error, done) => {
      body.destroy();
      destroy.call(output, error, done);
    };
    const failed = (error: Error) => output.destroy(error);
    body.on("error", failed);
    output.once("close", () => body.off("error", failed));
    if (signal) addAbortSignal(signal, output);
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
