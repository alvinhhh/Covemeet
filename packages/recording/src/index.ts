import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { Readable } from "node:stream";
import * as argon2 from "argon2";

export interface RecordingContext {
  tenantId: string;
  meetingId: string;
  recordingId: string;
}

export interface KeyBinding {
  context: RecordingContext;
  recordingKeyId: string;
}

/** Provider-specific wrapped key. Never contains the plaintext data key. */
export interface WrappedKey {
  provider: string;
  keyId: string;
  ciphertext: string;
  metadata?: Record<string, string>;
}

/** An external KMS adapter must cryptographically authenticate the entire binding. */
export interface KeyProvider {
  wrapKey(key: Uint8Array, binding: KeyBinding): Promise<WrappedKey>;
  /** Return a newly allocated key buffer: the caller will erase it after use. */
  unwrapKey(wrappedKey: WrappedKey, binding: KeyBinding): Promise<Uint8Array>;
}

export interface EncryptedRecordingMetadata extends KeyBinding {
  version: 1;
  wrappedKey: WrappedKey;
  plaintextBytes: number;
  encryptedBytes: number;
}

export interface EncryptRecordingOptions {
  /** 64 KiB–4 MiB; defaults to 1 MiB. Memory use is bounded by this value. */
  chunkSize?: number;
}

export class RecordingIntegrityError extends Error {
  constructor() {
    super("Recording integrity verification failed");
    this.name = "RecordingIntegrityError";
  }
}

const MAGIC = Buffer.from("MPREC001", "ascii");
const HEADER_SIZE = 68;
const FRAME_HEADER_SIZE = 9;
const TAG_SIZE = 16;
const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const MAX_CHUNK_SIZE = 4 * 1024 * 1024;
const MIN_CHUNK_SIZE = 64 * 1024;
const MAX_FRAME_INDEX = 0xffff_ffff;
const LOCAL_PROVIDER = "local-aes-256-gcm-v1";

function contextBytes(context: RecordingContext): Buffer {
  for (const value of [
    context?.tenantId,
    context?.meetingId,
    context?.recordingId,
  ]) {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      Buffer.byteLength(value) > 1024
    ) {
      throw new TypeError(
        "Recording context requires nonempty tenant, meeting and recording IDs",
      );
    }
  }
  return Buffer.from(
    JSON.stringify([context.tenantId, context.meetingId, context.recordingId]),
  );
}

function bindingBytes(binding: KeyBinding): Buffer {
  contextBytes(binding.context);
  if (!/^[a-f0-9]{32}$/.test(binding.recordingKeyId))
    throw new RecordingIntegrityError();
  return Buffer.from(
    JSON.stringify([
      "meeting-platform-recording-key-v1",
      binding.context.tenantId,
      binding.context.meetingId,
      binding.context.recordingId,
      binding.recordingKeyId,
    ]),
  );
}

function hashContext(context: RecordingContext): Buffer {
  return createHash("sha256").update(contextBytes(context)).digest();
}

function decodeBase64(
  value: string | undefined,
  expectedBytes: number,
): Buffer {
  if (typeof value !== "string" || value.length > 256)
    throw new RecordingIntegrityError();
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.length !== expectedBytes ||
    decoded.toString("base64") !== value
  ) {
    throw new RecordingIntegrityError();
  }
  return decoded;
}

/** Local operator-controlled KEK. Store the KEK outside the database and backups. */
export class LocalKeyProvider implements KeyProvider {
  readonly keyId: string;
  #key: Buffer;
  #destroyed = false;

  constructor({ keyId, key }: { keyId: string; key: Uint8Array }) {
    if (!keyId || keyId.length > 256 || key.byteLength !== 32) {
      throw new TypeError(
        "A key ID and exactly 32 bytes of key material are required",
      );
    }
    this.keyId = keyId;
    this.#key = Buffer.from(key);
  }

  async wrapKey(key: Uint8Array, binding: KeyBinding): Promise<WrappedKey> {
    this.#assertAvailable();
    if (key.byteLength !== 32)
      throw new TypeError("Recording data keys must be 32 bytes");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, iv, {
      authTagLength: TAG_SIZE,
    });
    cipher.setAAD(bindingBytes(binding));
    const ciphertext = Buffer.concat([cipher.update(key), cipher.final()]);
    return {
      provider: LOCAL_PROVIDER,
      keyId: this.keyId,
      ciphertext: ciphertext.toString("base64"),
      metadata: {
        iv: iv.toString("base64"),
        tag: cipher.getAuthTag().toString("base64"),
      },
    };
  }

  async unwrapKey(
    wrappedKey: WrappedKey,
    binding: KeyBinding,
  ): Promise<Uint8Array> {
    this.#assertAvailable();
    if (
      wrappedKey?.provider !== LOCAL_PROVIDER ||
      wrappedKey.keyId !== this.keyId
    ) {
      throw new RecordingIntegrityError();
    }
    let unverified: Buffer | undefined;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        this.#key,
        decodeBase64(wrappedKey.metadata?.iv, 12),
        { authTagLength: TAG_SIZE },
      );
      decipher.setAAD(bindingBytes(binding));
      decipher.setAuthTag(decodeBase64(wrappedKey.metadata?.tag, TAG_SIZE));
      unverified = decipher.update(decodeBase64(wrappedKey.ciphertext, 32));
      decipher.final();
      return unverified;
    } catch {
      unverified?.fill(0);
      throw new RecordingIntegrityError();
    }
  }

  destroy(): void {
    this.#key.fill(0);
    this.#destroyed = true;
  }

  #assertAvailable(): void {
    if (this.#destroyed) throw new Error("Key provider has been destroyed");
  }
}

/**
 * Paths must originate in application configuration, never request parameters.
 * Resolving the parent removes symlink ambiguity; O_NOFOLLOW rejects leaf links.
 * Parent directories must remain writable only by trusted operators/processes.
 */
async function safePath(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0") || normalize(path) !== path) {
    throw new TypeError("Recording paths must be normalized absolute paths");
  }
  if (constants.O_NOFOLLOW === undefined) {
    throw new Error(
      "Recording storage requires a platform with O_NOFOLLOW support",
    );
  }
  const parent = await realpath(dirname(path));
  return join(parent, basename(path));
}

async function openInput(path: string): Promise<FileHandle> {
  // Nonblocking open prevents a misconfigured FIFO from hanging before fstat.
  const file = await open(
    await safePath(path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!(await file.stat()).isFile())
      throw new TypeError("Recording input must be a regular file");
    return file;
  } catch (error) {
    await file.close();
    throw error;
  }
}

function nonce(prefix: Buffer, index: number): Buffer {
  const value = Buffer.allocUnsafe(12);
  prefix.copy(value, 0);
  value.writeUInt32BE(index, 8);
  return value;
}

function frameHeader(kind: 0 | 1, index: number, length: number): Buffer {
  const value = Buffer.allocUnsafe(FRAME_HEADER_SIZE);
  value[0] = kind;
  value.writeUInt32BE(index, 1);
  value.writeUInt32BE(length, 5);
  return value;
}

async function writeAll(file: FileHandle, buffer: Buffer): Promise<void> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(
      buffer,
      offset,
      buffer.length - offset,
      null,
    );
    if (bytesWritten === 0)
      throw new Error("Recording storage stopped accepting writes");
    offset += bytesWritten;
  }
}

/** Pulls only the bytes needed for a frame, independent of network chunk boundaries. */
class BoundedStreamReader {
  private readonly iterator: AsyncIterator<unknown>;
  private chunk: Buffer = Buffer.alloc(0);
  private offset = 0;
  consumed = 0;
  constructor(
    private readonly source: Readable,
    private readonly maximum: number,
  ) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  private async next(): Promise<boolean> {
    while (this.offset === this.chunk.length) {
      const next = await this.iterator.next();
      if (next.done) return false;
      if (!(next.value instanceof Uint8Array))
        throw new RecordingIntegrityError();
      this.chunk = Buffer.isBuffer(next.value)
        ? next.value
        : Buffer.from(next.value);
      this.offset = 0;
    }
    return true;
  }
  async read(length: number): Promise<Buffer> {
    if (this.consumed + length > this.maximum)
      throw new RecordingIntegrityError();
    const result = Buffer.allocUnsafe(length);
    let written = 0;
    while (written < length) {
      if (!(await this.next())) throw new RecordingIntegrityError();
      const amount = Math.min(
        length - written,
        this.chunk.length - this.offset,
      );
      this.chunk.copy(result, written, this.offset, this.offset + amount);
      this.offset += amount;
      written += amount;
      this.consumed += amount;
    }
    return result;
  }
  async end(): Promise<boolean> {
    return this.consumed === this.maximum && !(await this.next());
  }
  close(): void {
    this.source.destroy();
  }
}

async function writeFrame(
  file: FileHandle,
  key: Buffer,
  header: Buffer,
  prefix: Buffer,
  index: number,
  plaintext: Buffer,
  kind: 0 | 1,
): Promise<number> {
  const frame = frameHeader(kind, index, plaintext.length);
  const cipher = createCipheriv("aes-256-gcm", key, nonce(prefix, index), {
    authTagLength: TAG_SIZE,
  });
  cipher.setAAD(Buffer.concat([header, frame]));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  await writeAll(file, frame);
  await writeAll(file, ciphertext);
  await writeAll(file, cipher.getAuthTag());
  return frame.length + ciphertext.length + TAG_SIZE;
}

/**
 * Encrypt an existing recorder spool into a new, exclusive 0600 file.
 * Source spool encryption/deletion is the recorder's responsibility. This function
 * never creates a plaintext output. Keep returned metadata with the database row.
 */
export async function encryptRecording(
  inputPath: string,
  outputPath: string,
  context: RecordingContext,
  keyProvider: KeyProvider,
  options: EncryptRecordingOptions = {},
): Promise<EncryptedRecordingMetadata> {
  const chunkSize = options.chunkSize ?? DEFAULT_CHUNK_SIZE;
  if (
    !Number.isInteger(chunkSize) ||
    chunkSize < MIN_CHUNK_SIZE ||
    chunkSize > MAX_CHUNK_SIZE
  ) {
    throw new TypeError(
      "Recording chunk size must be between 64 KiB and 4 MiB",
    );
  }
  // Copy caller-owned context before any await so it cannot change during encryption.
  contextBytes(context);
  const stableContext = {
    tenantId: context.tenantId,
    meetingId: context.meetingId,
    recordingId: context.recordingId,
  };
  const key = randomBytes(32);
  const recordingKeyId = randomBytes(16).toString("hex");
  const binding: KeyBinding = { context: stableContext, recordingKeyId };
  let input: FileHandle | undefined;
  let output: FileHandle | undefined;
  let resolvedOutput: string | undefined;
  let completed = false;
  const readBuffer = Buffer.allocUnsafe(chunkSize);
  try {
    const wrappedKey = await keyProvider.wrapKey(key, binding);
    input = await openInput(inputPath);
    resolvedOutput = await safePath(outputPath);
    output = await open(
      resolvedOutput,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    const prefix = randomBytes(8);
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(header, 0);
    header.writeUInt32BE(chunkSize, 8);
    prefix.copy(header, 12);
    Buffer.from(recordingKeyId, "hex").copy(header, 20);
    hashContext(stableContext).copy(header, 36);
    await writeAll(output, header);
    let index = 0;
    let plaintextBytes = 0;
    let encryptedBytes = header.length;
    while (true) {
      const { bytesRead } = await input.read(readBuffer, 0, chunkSize, null);
      if (bytesRead === 0) break;
      if (index === MAX_FRAME_INDEX)
        throw new Error("Recording exceeds maximum format size");
      encryptedBytes += await writeFrame(
        output,
        key,
        header,
        prefix,
        index++,
        readBuffer.subarray(0, bytesRead),
        0,
      );
      plaintextBytes += bytesRead;
      readBuffer.fill(0, 0, bytesRead);
    }
    encryptedBytes += await writeFrame(
      output,
      key,
      header,
      prefix,
      index,
      Buffer.alloc(0),
      1,
    );
    await output.sync();
    // A durable file is insufficient if its new directory entry is lost after
    // the caller commits metadata and removes the source recovery spool.
    const directory = await open(
      dirname(resolvedOutput),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    completed = true;
    return {
      version: 1,
      ...binding,
      wrappedKey,
      plaintextBytes,
      encryptedBytes,
    };
  } finally {
    key.fill(0);
    readBuffer.fill(0);
    await input?.close().catch(() => undefined);
    await output?.close().catch(() => undefined);
    // Only remove a file this invocation actually created, never an existing target.
    if (!completed && output && resolvedOutput)
      await unlink(resolvedOutput).catch(() => undefined);
  }
}

function validateMetadata(
  metadata: EncryptedRecordingMetadata,
  expectedContext: RecordingContext,
): void {
  if (
    metadata?.version !== 1 ||
    !Number.isSafeInteger(metadata.plaintextBytes) ||
    metadata.plaintextBytes < 0 ||
    !Number.isSafeInteger(metadata.encryptedBytes) ||
    metadata.encryptedBytes < HEADER_SIZE + FRAME_HEADER_SIZE + TAG_SIZE
  ) {
    throw new RecordingIntegrityError();
  }
  bindingBytes(metadata);
  if (
    !timingSafeEqual(
      hashContext(metadata.context),
      hashContext(expectedContext),
    )
  ) {
    throw new RecordingIntegrityError();
  }
}

async function* decryptedStreamChunks(
  source: Readable,
  metadata: EncryptedRecordingMetadata,
  expectedContext: RecordingContext,
  provider: KeyProvider,
): AsyncGenerator<Buffer> {
  validateMetadata(metadata, expectedContext);
  const reader = new BoundedStreamReader(source, metadata.encryptedBytes);
  let providerKey: Uint8Array | undefined;
  let key: Buffer | undefined;
  try {
    const header = await reader.read(HEADER_SIZE);
    const chunkSize = header.readUInt32BE(8);
    if (
      !timingSafeEqual(header.subarray(0, 8), MAGIC) ||
      chunkSize < MIN_CHUNK_SIZE ||
      chunkSize > MAX_CHUNK_SIZE ||
      header.subarray(20, 36).toString("hex") !== metadata.recordingKeyId ||
      !timingSafeEqual(header.subarray(36, 68), hashContext(expectedContext))
    ) {
      throw new RecordingIntegrityError();
    }
    providerKey = await provider.unwrapKey(metadata.wrappedKey, metadata);
    if (providerKey.byteLength !== 32) throw new RecordingIntegrityError();
    key = Buffer.from(providerKey);
    providerKey.fill(0);
    const prefix = header.subarray(12, 20);
    let expectedIndex = 0;
    let plaintextBytes = 0;
    while (true) {
      const frame = await reader.read(FRAME_HEADER_SIZE);
      const kind = frame[0];
      const index = frame.readUInt32BE(1);
      const length = frame.readUInt32BE(5);
      if (
        index !== expectedIndex ||
        length > chunkSize ||
        (kind !== 0 && kind !== 1) ||
        (kind === 0 && length === 0) ||
        (kind === 1 && length !== 0)
      ) {
        throw new RecordingIntegrityError();
      }
      const ciphertext = await reader.read(length);
      const tag = await reader.read(TAG_SIZE);
      let plaintext: Buffer | undefined;
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          nonce(prefix, index),
          { authTagLength: TAG_SIZE },
        );
        decipher.setAAD(Buffer.concat([header, frame]));
        decipher.setAuthTag(tag);
        plaintext = decipher.update(ciphertext);
        decipher.final();
      } catch {
        plaintext?.fill(0);
        throw new RecordingIntegrityError();
      }
      if (kind === 1) {
        if (
          !(await reader.end()) ||
          plaintextBytes !== metadata.plaintextBytes
        ) {
          throw new RecordingIntegrityError();
        }
        return;
      }
      plaintextBytes += length;
      if (
        plaintextBytes > metadata.plaintextBytes ||
        expectedIndex === MAX_FRAME_INDEX
      ) {
        plaintext.fill(0);
        throw new RecordingIntegrityError();
      }
      expectedIndex++;
      // No plaintext from this frame is released before its GCM tag passes.
      yield plaintext;
    }
  } finally {
    providerKey?.fill(0);
    key?.fill(0);
    reader.close();
  }
}

/**
 * Authenticates every chunk before emitting it. Only clean EOF proves completeness.
 * Aborting the returned stream closes the input, including an S3 HTTP response.
 */
export async function decryptRecordingFromStream(
  input: Readable,
  metadata: EncryptedRecordingMetadata,
  expectedContext: RecordingContext,
  keyProvider: KeyProvider,
): Promise<Readable> {
  try {
    validateMetadata(metadata, expectedContext);
    const snapshot: EncryptedRecordingMetadata = structuredClone(metadata);
    const output = Readable.from(
      decryptedStreamChunks(
        input,
        snapshot,
        { ...expectedContext },
        keyProvider,
      ),
      { objectMode: false },
    );
    // Async-generator finally blocks do not run when cancelled before the first read.
    const failed = (error: Error) => output.destroy(error);
    input.on("error", failed);
    output.once("close", () => {
      input.off("error", failed);
      input.destroy();
    });
    return output;
  } catch (error) {
    input.destroy();
    throw error;
  }
}

export async function decryptRecordingToStream(
  inputPath: string,
  metadata: EncryptedRecordingMetadata,
  expectedContext: RecordingContext,
  keyProvider: KeyProvider,
): Promise<Readable> {
  validateMetadata(metadata, expectedContext);
  const snapshot: EncryptedRecordingMetadata = structuredClone(metadata);
  const contextSnapshot = { ...expectedContext };
  async function* fromFile() {
    const file = await openInput(inputPath);
    try {
      if ((await file.stat()).size !== snapshot.encryptedBytes)
        throw new RecordingIntegrityError();
      yield* decryptedStreamChunks(
        file.createReadStream({ autoClose: false }),
        snapshot,
        contextSnapshot,
        keyProvider,
      );
    } finally {
      await file.close().catch(() => undefined);
    }
  }
  return Readable.from(fromFile(), { objectMode: false });
}

/** Full integrity verification without writing or retaining decrypted output. */
export async function verifyEncryptedRecording(
  inputPath: string,
  metadata: EncryptedRecordingMetadata,
  expectedContext: RecordingContext,
  keyProvider: KeyProvider,
): Promise<void> {
  for await (const chunk of await decryptRecordingToStream(
    inputPath,
    metadata,
    expectedContext,
    keyProvider,
  )) {
    (chunk as Buffer).fill(0);
  }
}

/** Rewrap the DEK under a new KEK, then atomically persist the returned metadata. */
export async function rotateRecordingKey(
  metadata: EncryptedRecordingMetadata,
  expectedContext: RecordingContext,
  oldProvider: KeyProvider,
  newProvider: KeyProvider,
): Promise<EncryptedRecordingMetadata> {
  validateMetadata(metadata, expectedContext);
  const snapshot: EncryptedRecordingMetadata = structuredClone(metadata);
  const key = await oldProvider.unwrapKey(snapshot.wrappedKey, snapshot);
  try {
    if (key.byteLength !== 32) throw new RecordingIntegrityError();
    return {
      ...snapshot,
      wrappedKey: await newProvider.wrapKey(key, snapshot),
    };
  } finally {
    key.fill(0);
  }
}

export interface DownloadCredentials {
  token: string;
  tokenDigest: string;
  password: string;
  passwordHash: string;
}

/** Token digest may be indexed in storage; never persist or log the raw token. */
export function digestDownloadToken(token: string): string {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token))
    throw new TypeError("Invalid download token");
  return createHash("sha256")
    .update("recording-download-v1\0")
    .update(token)
    .digest("hex");
}

/** Raw values are transient: deliver the password separately from the link. */
export async function createDownloadCredentials(): Promise<DownloadCredentials> {
  const token = randomBytes(32).toString("base64url");
  const password = randomBytes(18).toString("base64url");
  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
    salt: randomBytes(16),
  });
  return {
    token,
    tokenDigest: digestDownloadToken(token),
    password,
    passwordHash,
  };
}

/** Apply rate/concurrency limits before invoking this deliberately expensive check. */
export async function verifyRecordingPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  const hashParts =
    /^\$argon2id\$v=19\$([^$]{1,40})\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.exec(
      passwordHash,
    );
  const parameters = new Set(hashParts?.[1]?.split(",") ?? []);
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > 256 ||
    !hashParts ||
    hashParts[1]?.split(",").length !== 3 ||
    parameters.size !== 3 ||
    !parameters.has("m=65536") ||
    !parameters.has("t=3") ||
    !parameters.has("p=1")
  ) {
    return false;
  }
  try {
    return await argon2.verify(passwordHash, password);
  } catch {
    return false;
  }
}

export { LocalKeyringProvider } from "./keyring.js";
export { AwsKmsKeyProvider } from "./kms.js";
export {
  S3RecordingStorage,
  type RecordingObjectReference,
  type RecordingObjectStorage,
} from "./storage.js";
