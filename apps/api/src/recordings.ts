import { meetingAllowed, recordingIncluded } from "./meeting-limits.js";
import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { addAbortSignal, Readable } from "node:stream";
import { isDeepStrictEqual } from "node:util";
import { hasMail, mailbox, type MailTransport } from "@meeting-platform/mail";
import {
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptions,
  type EgressInfo,
} from "livekit-server-sdk";
import {
  LocalKeyringProvider,
  AwsKmsKeyProvider,
  S3RecordingStorage,
  decryptRecordingFromStream,
  rotateRecordingKey,
  type KeyProvider,
  type RecordingObjectStorage,
  type EncryptedRecordingMetadata,
  encryptRecording,
  readEncryptionReceipt,
  decryptRecordingToStream,
  createDownloadCredentialsFromSecrets,
  digestDownloadToken,
  verifyRecordingPassword,
} from "@meeting-platform/recording";
import type { Config } from "./config.js";
import type {
  Meeting,
  Recording,
  RecordingLock,
  RecordingStorageAttempt,
  Store,
} from "./store.js";
import { clearRecordingLink } from "./store.js";
import { activePhone } from "./phone.js";
import { HttpError, safeEqual } from "./security.js";

export type RecorderClient = Pick<
  EgressClient,
  "startRoomCompositeEgress" | "stopEgress" | "listEgress"
>;
const retentionMs = 7 * 86400000;
const ownedChunkSize = 1024 * 1024;
const encryptedSize = (rawBytes: number) =>
  93 + rawBytes + Math.ceil(rawBytes / ownedChunkSize) * 25;
const terminalStatuses = [
  EgressStatus.EGRESS_COMPLETE,
  EgressStatus.EGRESS_FAILED,
  EgressStatus.EGRESS_ABORTED,
  EgressStatus.EGRESS_LIMIT_REACHED,
];

export class RecordingService {
  readonly available: boolean;
  private provider?: KeyProvider;
  private objectStorage?: RecordingObjectStorage;
  private client: RecorderClient;
  private deliveryOffsets = new Map<string, number>();
  constructor(
    private config: Config,
    private store: Store,
    private mail: Pick<MailTransport, "sendMail"> | undefined,
    client?: RecorderClient,
    adapters?: {
      keyProvider?: KeyProvider;
      objectStorage?: RecordingObjectStorage;
    },
  ) {
    const keyConfigured =
      config.recordingKeyProvider === "aws-kms"
        ? !!config.recordingKmsKeyArn
        : !!config.recordingLocalKeys[config.recordingActiveKeyId];
    this.available =
      config.recordingEnabled &&
      keyConfigured &&
      hasMail(config) &&
      !!mail &&
      !!config.livekitKey &&
      !!config.livekitSecret;
    // Recovery and retention must keep running when new recordings are disabled.
    if (keyConfigured) {
      if (adapters?.keyProvider) this.provider = adapters.keyProvider;
      else {
        const keys: Record<string, Buffer> = Object.create(null);
        let local: LocalKeyringProvider | undefined;
        try {
          for (const [id, encoded] of Object.entries(
            config.recordingLocalKeys,
          )) {
            const key = Buffer.from(encoded, "base64");
            if (key.length !== 32 || key.toString("base64") !== encoded)
              throw new Error("Invalid recording key material");
            keys[id] = key;
          }
          if (Object.keys(keys).length)
            local = new LocalKeyringProvider({
              activeKeyId:
                config.recordingKeyProvider === "local"
                  ? config.recordingActiveKeyId
                  : Object.keys(keys)[0]!,
              keys,
            });
        } finally {
          for (const key of Object.values(keys)) key.fill(0);
        }
        const kms = config.recordingKmsKeyArn
          ? new AwsKmsKeyProvider({
              region: config.recordingKmsRegion,
              activeKeyId: config.recordingKmsKeyArn,
              decryptKeyIds: config.recordingKmsDecryptKeyArns,
            })
          : undefined;
        const active = config.recordingKeyProvider === "aws-kms" ? kms : local;
        if (!active)
          throw new Error("Active recording key provider is not configured");
        this.provider = {
          wrapKey: (key, binding) => active.wrapKey(key, binding),
          unwrapKey: (wrapped, binding) => {
            const selected =
              wrapped.provider === "local-aes-256-gcm-v1"
                ? local
                : wrapped.provider === "aws-kms-symmetric-v1"
                  ? kms
                  : undefined;
            if (!selected)
              throw new Error(
                "Recording recovery key provider is not configured",
              );
            return selected.unwrapKey(wrapped, binding);
          },
        };
      }
    }
    if (config.recordingStorage === "s3") {
      this.objectStorage =
        adapters?.objectStorage ??
        new S3RecordingStorage({
          bucket: config.recordingS3Bucket,
          region: config.recordingS3Region,
          endpoint: config.recordingS3Endpoint,
          prefix: config.recordingS3Prefix,
          forcePathStyle: config.recordingS3PathStyle,
          allowInsecureLocalEndpoint: config.recordingS3AllowLocalHttp,
          maxBytes: config.recordingMaxBytes,
        });
    }
    this.client =
      client ??
      new EgressClient(
        config.livekitUrl,
        config.livekitKey,
        config.livekitSecret,
      );
  }
  private context(m: Meeting, r: Recording) {
    return { tenantId: "installation", meetingId: m.id, recordingId: r.id };
  }
  private file(r: Recording, raw = false) {
    if (!/^[a-f0-9-]{36}$/.test(r.id)) throw new Error("Invalid recording ID");
    if (!raw && r.ciphertextId && !/^[a-f0-9-]{36}$/.test(r.ciphertextId))
      throw new Error("Invalid ciphertext ID");
    return path.join(
      this.config.recordingDir,
      raw ? "raw" : "encrypted",
      `${r.id}${!raw && r.ciphertextId ? `.${r.ciphertextId}` : ""}.${raw ? "mp4" : "mprec"}`,
    );
  }
  private async directories() {
    for (const directory of [
      this.config.recordingDir,
      ...["raw", "encrypted"].map((name) =>
        path.join(this.config.recordingDir, name),
      ),
    ]) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const info = await lstat(directory);
      if (!info.isDirectory() || (info.mode & 0o077) !== 0)
        throw new Error(
          "Recording directories must be private directories, not symlinks",
        );
    }
  }
  private async removeFile(file: string) {
    try {
      await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private attemptFile(r: Recording, attempt: RecordingStorageAttempt) {
    return this.file({ ...r, ciphertextId: attempt.id });
  }
  private async cleanupStorage(
    m: Meeting,
    r: Recording,
    lock: RecordingLock,
    keep = new Set<string>(),
  ) {
    const row = (await lock.get())!.recordings.find(
      (entry) => entry.id === r.id,
    )!;
    let complete = true;
    for (const attempt of row.storage!.attempts) {
      if (keep.has(attempt.id) || attempt.state === "released") continue;
      if (attempt.state === "reserved") {
        await lock.releaseRecordingStorage(attempt.id, { kind: "unused" });
        continue;
      }
      await lock.removeRecordingStorage(attempt.id);
      const prepared = attempt.prepared;
      if (!prepared)
        throw new Error("Recording storage evidence is unavailable");
      if (prepared.kind === "local") {
        const file = this.attemptFile(row, attempt);
        const receipt = await readEncryptionReceipt(
          file,
          prepared.metadata,
          this.context(m, row),
        );
        if (!receipt) {
          complete = false;
          continue;
        }
        await lock.check();
        await this.removeFile(file);
        await this.removeFile(`${file}.partial`);
        // The permanent closed marker prevents this immutable attempt from
        // being reopened after its data is removed.
        await lock.releaseRecordingStorage(attempt.id, {
          kind: "local",
          metadata: prepared.metadata,
          receipt,
          removed: true,
        });
      } else {
        if (!this.objectStorage?.fenceOwned)
          throw new Error(
            "Owned recording object storage is required for cleanup",
          );
        await lock.check();
        const fence = await this.objectStorage.fenceOwned(
          prepared.intent,
          prepared.metadata,
          this.context(m, row),
        );
        await lock.releaseRecordingStorage(attempt.id, {
          kind: "s3",
          metadata: prepared.metadata,
          fence,
        });
      }
    }
    return complete;
  }
  private keptStorage(r: Recording) {
    return new Set(
      r
        .storage!.attempts.filter((attempt) =>
          r.metadata?.storage
            ? attempt.kind === "s3" &&
              attempt.proof?.kind === "s3" &&
              isDeepStrictEqual(attempt.proof.reference, r.metadata.storage)
            : attempt.kind === "local" && attempt.id === r.ciphertextId,
        )
        .map((attempt) => attempt.id),
    );
  }
  private async finishOwnedEncryption(
    m: Meeting,
    r: Recording,
    lock: RecordingLock,
  ) {
    let row = (await lock.get())!.recordings.find(
      (entry) => entry.id === r.id,
    )!;
    if (!row.metadata) {
      // A previous process may have closed a complete immutable attempt before
      // it lost the metadata acknowledgement. Recover that exact resource.
      for (const attempt of row.storage!.attempts) {
        if (
          attempt.kind !== "local" ||
          !attempt.prepared ||
          !["pending", "retained"].includes(attempt.state)
        )
          continue;
        const metadata = attempt.prepared.metadata;
        const receipt = await readEncryptionReceipt(
          this.attemptFile(row, attempt),
          metadata,
          this.context(m, row),
        );
        if (!receipt) continue;
        await lock.retainRecordingStorage(attempt.id, {
          kind: "local",
          metadata,
          receipt,
        });
        if (receipt.published) {
          await this.selectCiphertext(row, attempt.id, metadata, lock);
          break;
        }
      }
      row = (await lock.get())!.recordings.find((entry) => entry.id === r.id)!;
      if (!row.metadata) {
        // Unknown writers keep their allocation. Closed failed attempts may be
        // removed; unused slots remain available for this capture's first write.
        await this.cleanupStorage(
          m,
          row,
          lock,
          new Set(
            row
              .storage!.attempts.filter((a) => a.state === "reserved")
              .map((a) => a.id),
          ),
        );
        const raw = await lstat(this.file(row, true));
        if (
          !raw.isFile() ||
          raw.size > this.config.recordingMaxBytes ||
          encryptedSize(raw.size) > row.storage!.maxBytes
        ) {
          await lock.change((state) => {
            const saved = state.recordings.find(
              (entry) => entry.id === row.id,
            )!;
            saved.status = "failed";
            saved.autoLinkPending = false;
            saved.rawCleanupPending = true;
            saved.error = "Recording exceeded the stored-file allowance";
          });
          return;
        }
        const attempt = await lock.reserveRecordingStorage("local");
        await lock.check();
        const metadata = await encryptRecording(
          this.file(row, true),
          this.attemptFile(row, attempt),
          this.context(m, row),
          this.provider!,
          {
            chunkSize: ownedChunkSize,
            maxEncryptedBytes: attempt.maxBytes,
            onPrepared: async (prepared) => {
              await lock.prepareRecordingStorage(attempt.id, {
                kind: "local",
                metadata: prepared,
              });
            },
          },
        );
        const receipt = await readEncryptionReceipt(
          this.attemptFile(row, attempt),
          metadata,
          this.context(m, row),
        );
        if (!receipt?.published)
          throw new Error("Recording writer completion is unavailable");
        await lock.retainRecordingStorage(attempt.id, {
          kind: "local",
          metadata,
          receipt,
        });
        await this.selectCiphertext(row, attempt.id, metadata, lock);
      }
      row = (await lock.get())!.recordings.find((entry) => entry.id === r.id)!;
    }
    if (this.objectStorage && !row.metadata.storage) {
      if (!this.objectStorage.putOwned || !this.objectStorage.recoverOwned)
        throw new Error("Owned recording object storage is required");
      let attempt = row.storage!.attempts.find(
        (a) =>
          a.kind === "s3" &&
          ["pending", "retained"].includes(a.state) &&
          isDeepStrictEqual(a.prepared?.metadata, row.metadata),
      );
      attempt ??= await lock.reserveRecordingStorage("s3");
      let reference =
        attempt.proof?.kind === "s3" ? attempt.proof.reference : undefined;
      if (!reference && attempt.prepared?.kind === "s3")
        reference =
          (await this.objectStorage.recoverOwned(
            attempt.prepared.intent,
            attempt.prepared.metadata,
            this.context(m, row),
          )) ?? undefined;
      if (!reference) {
        await lock.check();
        reference = await this.objectStorage.putOwned(
          this.file(row),
          row.metadata,
          this.context(m, row),
          this.provider!,
          {
            maxBytes: attempt.maxBytes,
            onPrepared: async (intent) => {
              await lock.prepareRecordingStorage(attempt!.id, {
                kind: "s3",
                metadata: row.metadata,
                intent,
              });
            },
          },
        );
      }
      await lock.retainRecordingStorage(attempt.id, {
        kind: "s3",
        metadata: row.metadata,
        reference,
      });
      await lock.change((state) => {
        const saved = state.recordings.find((entry) => entry.id === row.id)!;
        if (
          saved.status !== "encrypting" ||
          !isDeepStrictEqual(saved.metadata, row.metadata)
        )
          throw new Error("Recording encryption state changed");
        saved.metadata.storage = reference;
      });
      row = (await lock.get())!.recordings.find((entry) => entry.id === r.id)!;
    }
    for await (const plaintext of await this.openEncrypted(m, row))
      (plaintext as Buffer).fill(0);
    await lock.check();
    await this.removeFile(this.file(row, true));
    await this.cleanupStorage(m, row, lock, this.keptStorage(row));
    await lock.change((state) => {
      const saved = state.recordings.find((entry) => entry.id === row.id)!;
      if (saved.status === "encrypting" && saved.metadata) {
        saved.status = "ready";
        saved.readyAt ??= Date.now();
      }
    });
    await lock.audit("recorder", "recording.encrypted", r.id);
  }
  private async selectCiphertext(
    r: Recording,
    ciphertextId: string,
    metadata: EncryptedRecordingMetadata,
    lock: RecordingLock,
  ) {
    await lock.change((state) => {
      const row = state.recordings.find((entry) => entry.id === r.id)!;
      if (row.status !== "encrypting" || row.metadata)
        throw new Error("Recording encryption state changed");
      row.metadata = metadata;
      row.ciphertextId = ciphertextId;
    });
  }
  private async storageCaptureFull(m: Meeting, r: Recording) {
    if (!m.hosted?.billingOwnerId) return false;
    if (!r.storage) return true;
    try {
      const raw = await lstat(this.file(r, true));
      // The stop RPC can overshoot. Encryption separately enforces the hard
      // ciphertext ceiling; the raw spool has its own deployment disk bound.
      return (
        !raw.isFile() || encryptedSize(raw.size) >= r.storage.maxBytes * 0.9
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      return true;
    }
  }
  private async finishEncryption(
    m: Meeting,
    r: Recording,
    lock: RecordingLock,
  ) {
    // Reload committed metadata; the caller may still hold the pre-encryption snapshot.
    let row = (await lock.get())?.recordings.find((entry) => entry.id === r.id);
    if (!row?.metadata || row.status !== "encrypting")
      throw new Error("Recording encryption state changed");
    if (this.objectStorage && !row.metadata.storage) {
      const expectedKey = row.metadata.recordingKeyId;
      const reference = await this.objectStorage.put(
        this.file(row),
        row.metadata,
        this.context(m, row),
        this.provider!,
      );
      await lock.change((state) => {
        const current = state.recordings.find((entry) => entry.id === r.id)!;
        if (
          current.status !== "encrypting" ||
          current.metadata?.recordingKeyId !== expectedKey
        ) {
          throw new Error("Recording encryption state changed");
        }
        current.metadata.storage = reference;
      });
      row = (await lock.get())!.recordings.find((entry) => entry.id === r.id)!;
    }
    // Verify the committed recovery copy before deleting plaintext, including after restart.
    for await (const plaintext of await this.openEncrypted(m, row))
      (plaintext as Buffer).fill(0);
    await lock.check();
    await this.removeFile(this.file(row, true));
    if (row.metadata.storage) {
      await lock.check();
      await this.removeFile(this.file(row));
    }
    await lock.change((state) => {
      const current = state.recordings.find((entry) => entry.id === r.id)!;
      if (current.status === "encrypting" && current.metadata) {
        current.status = "ready";
        current.readyAt ??= Date.now();
      }
    });
    await lock.audit("recorder", "recording.encrypted", r.id);
  }
  private async openEncrypted(
    m: Meeting,
    r: Recording,
    metadata = r.metadata,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    if (!this.provider)
      throw new HttpError(503, "Recording keys are not configured");
    if (metadata?.storage) {
      if (!this.objectStorage)
        throw new HttpError(503, "Recording object storage is not configured");
      const ciphertext = await this.objectStorage.read(
        metadata.storage,
        metadata,
        this.context(m, r),
        signal,
      );
      return decryptRecordingFromStream(
        ciphertext,
        metadata,
        this.context(m, r),
        this.provider,
      );
    }
    return decryptRecordingToStream(
      this.file(r),
      metadata,
      this.context(m, r),
      this.provider,
    );
  }
  /** Operator action: verify recovery under the active KEK before atomically replacing its envelope. */
  async rotateKey(m: Meeting, id: string): Promise<void> {
    if (!this.provider)
      throw new HttpError(503, "Recording keys are not configured");
    const result = await this.store.withRecordingLock(
      m.code,
      id,
      async (lock) => {
        const snapshot = (await lock.get())?.recordings.find(
          (entry) => entry.id === id,
        );
        if (!snapshot || snapshot.status !== "ready" || !snapshot.metadata)
          throw new HttpError(409, "Recording is not ready");
        const previous = structuredClone(snapshot.metadata);
        const rotated = await rotateRecordingKey(
          previous as EncryptedRecordingMetadata,
          this.context(m, snapshot),
          this.provider!,
          this.provider!,
        );
        const previousDelivery = structuredClone(snapshot.delivery);
        const rewrap = async (
          envelope: NonNullable<Recording["delivery"]>["token"],
        ) => {
          const binding = {
            context: this.context(m, snapshot),
            recordingKeyId: envelope.bindingId,
          };
          const secret = await this.provider!.unwrapKey(
            envelope.wrappedKey,
            binding,
          );
          try {
            return {
              bindingId: envelope.bindingId,
              wrappedKey: await this.provider!.wrapKey(secret, binding),
            };
          } finally {
            secret.fill(0);
          }
        };
        const rotatedDelivery = previousDelivery
          ? {
              ...previousDelivery,
              token: await rewrap(previousDelivery.token),
              password: previousDelivery.password
                ? await rewrap(previousDelivery.password)
                : undefined,
            }
          : undefined;
        for await (const plaintext of await this.openEncrypted(
          m,
          snapshot,
          rotated,
        ))
          (plaintext as Buffer).fill(0);
        await lock.change((state) => {
          const row = state.recordings.find((entry) => entry.id === id);
          if (
            !row ||
            row.status !== "ready" ||
            !isDeepStrictEqual(row.metadata, previous) ||
            !isDeepStrictEqual(row.delivery, previousDelivery)
          ) {
            throw new HttpError(
              409,
              "Recording changed during key rotation; retry",
            );
          }
          row.metadata = rotated;
          if (rotatedDelivery) row.delivery = rotatedDelivery;
        });
        await lock.audit("operator", "recording.key.rotate", id);
      },
    );
    if (!result.acquired) throw new HttpError(409, "Recording is busy; retry");
  }
  private belongsToRecording(info: EgressInfo, m: Meeting, r: Recording) {
    if (info.roomName !== m.room) return false;
    const expected = `${this.config.egressFileRoot}/raw/${r.id}.mp4`;
    if (info.request.case === "roomComposite") {
      const request = info.request.value;
      if (request.fileOutputs.some((output) => output.filepath === expected))
        return true;
      if (
        request.output.case === "file" &&
        request.output.value.filepath === expected
      )
        return true;
    }
    if (
      info.request.case === "egress" &&
      info.request.value.outputs.some(
        (output) =>
          output.config.case === "file" &&
          output.config.value.filepath === expected,
      )
    )
      return true;
    return info.fileResults.some(
      (output) => output.filename === expected || output.location === expected,
    );
  }
  private async observeTime(
    m: Meeting,
    r: Recording,
    info: EgressInfo,
    lock: RecordingLock,
  ) {
    if (!m.hosted?.billingOwnerId) return { recording: r, mustStop: false };
    // Egress timestamps are Unix nanoseconds. Convert before Number to avoid
    // losing precision; the allowance covers recorder startup and shutdown.
    const millis = (value: bigint, roundUp = false) => {
      if (value === 0n) return undefined;
      if (typeof value !== "bigint" || value < 0n)
        throw new Error("Recorder time is invalid");
      const result = Number((value + (roundUp ? 999_999n : 0n)) / 1_000_000n);
      if (!Number.isSafeInteger(result) || result <= 0)
        throw new Error("Recorder time is invalid");
      return result;
    };
    const startedAt = millis(info.startedAt);
    if (terminalStatuses.includes(info.status)) {
      const endedAt = millis(info.endedAt, true);
      if (startedAt === undefined || endedAt === undefined)
        throw new Error(
          "Recorder timing is unavailable; allowance remains reserved",
        );
      return lock.observeRecordingTime({
        egressId: info.egressId,
        terminal: true,
        startedAt,
        endedAt,
      });
    }
    return lock.observeRecordingTime({
      egressId: info.egressId,
      terminal: false,
      ...(startedAt !== undefined ? { startedAt } : {}),
    });
  }
  private async recoverUntracked(
    m: Meeting,
    r: Recording,
    lock: RecordingLock,
  ) {
    const matches = (await this.client.listEgress({ roomName: m.room })).filter(
      (info) => this.belongsToRecording(info, m, r),
    );
    if (!matches.length) return undefined;
    // A start timeout or lost DB acknowledgement must never silently leave a recorder running.
    for (const info of matches) {
      if (
        [
          EgressStatus.EGRESS_STARTING,
          EgressStatus.EGRESS_ACTIVE,
          EgressStatus.EGRESS_ENDING,
        ].includes(info.status)
      ) {
        await lock.check();
        await this.client.stopEgress(info.egressId);
      }
    }
    if (matches.length !== 1) {
      // Ambiguous output ownership stays pending instead of exposing a raced spool.
      throw new Error("Multiple recorder jobs require operator review");
    }
    const info = matches[0]!;
    await lock.change((state) => {
      const row = state.recordings.find((recording) => recording.id === r.id)!;
      row.egressId = info.egressId;
      row.status = "stopping";
      row.error = "Recorder start was interrupted; recovering stopped output";
    });
    return info;
  }
  async start(meeting: Meeting) {
    if (!recordingIncluded(meeting))
      throw new HttpError(403, "Recording is not available on this plan");
    if (!this.available)
      throw new HttpError(503, "Recording is not configured");
    await this.directories();
    const r: Recording = {
      id: randomUUID(),
      status: "starting",
      createdAt: Date.now(),
      autoLinkPending: true,
    };
    await this.store.withRecordingLock(meeting.code, r.id, async (lock) => {
      await lock.reserveRecording(
        r,
        (m) => {
          if (!recordingIncluded(m))
            throw new HttpError(403, "Recording is not available on this plan");
          if (m.participants.some(activePhone))
            throw new HttpError(
              409,
              "Recording is unavailable while phone calls are active; phone recording announcements are not implemented",
            );
          if (!meetingAllowed(m) || !m.recordingAllowed)
            throw new HttpError(403, "Enable recording first");
          if (!m.hostEmailVerified)
            throw new HttpError(403, "Verify the host email first");
          if (
            m.recordings.some((r) =>
              ["starting", "recording", "stopping", "encrypting"].includes(
                r.status,
              ),
            )
          )
            throw new HttpError(409, "A recording is already active");
          if (
            m.hosted?.billingOwnerId &&
            this.objectStorage &&
            (!this.objectStorage.putOwned ||
              !this.objectStorage.recoverOwned ||
              !this.objectStorage.fenceOwned)
          )
            throw new HttpError(
              503,
              "Owned recording object storage is not configured",
            );
        },
        {
          maxBytes: Math.min(this.config.recordingMaxBytes, 3_000_000_000),
          copies: this.objectStorage ? 2 : 1,
        },
      );
      let startedId: string | undefined;
      try {
        await lock.check();
        const info = await this.client.startRoomCompositeEgress(
          meeting.room,
          new EncodedFileOutput({
            fileType: EncodedFileType.MP4,
            filepath: `${this.config.egressFileRoot}/raw/${r.id}.mp4`,
          }),
          {
            layout: "grid",
            ...(this.config.edition === "hosted"
              ? {
                  encodingOptions: new EncodingOptions({
                    width: 1280,
                    height: 720,
                    framerate: 24,
                  }),
                }
              : {}),
          },
        );
        if (!info.egressId || !this.belongsToRecording(info, meeting, r))
          throw new Error(
            "Recorder response does not match the requested output",
          );
        startedId = info.egressId;
        const timing = await this.observeTime(
          (await lock.get())!,
          r,
          info,
          lock,
        );
        const mustStop = await lock.change((m) => {
          const row = m.recordings.find((x) => x.id === r.id)!;
          row.egressId = info.egressId;
          const stop =
            !meetingAllowed(m) ||
            !m.recordingAllowed ||
            row.status === "stopping" ||
            timing.mustStop;
          row.status = stop
            ? "stopping"
            : info.status === EgressStatus.EGRESS_ACTIVE
              ? "recording"
              : "starting";
          return stop;
        });
        if (mustStop) await this.client.stopEgress(info.egressId);
        await lock.audit("host", "recording.start", r.id);
      } catch {
        // Stop before trying to persist recovery state: the database may be unavailable.
        if (startedId) await this.client.stopEgress(startedId).catch(() => {});
        await lock
          .change((m) => {
            const row = m.recordings.find(
              (recording) => recording.id === r.id,
            )!;
            if (startedId) row.egressId = startedId;
            row.status = "stopping";
            row.error =
              "Recorder start did not complete; stop recovery is pending";
          })
          .catch(() => {});
        if (!startedId)
          await this.recoverUntracked(meeting, r, lock).catch(() => {});
        throw new HttpError(
          503,
          "Recorder start failed; stop recovery is pending",
        );
      }
    });
  }
  async stop(m: Meeting, id: string) {
    await this.store.change(m.code, (state) => {
      const r = state.recordings.find((x) => x.id === id);
      if (!r) throw new HttpError(404, "Recording unavailable");
      if (["starting", "recording", "stopping"].includes(r.status))
        r.status = "stopping";
    });
    // Stop intent is durable even when the starting/finalizing owner is busy.
    await this.store.withRecordingLock(m.code, id, async (lock) => {
      const row = (await lock.get())?.recordings.find((r) => r.id === id);
      if (row?.egressId && row.status === "stopping") {
        await lock.check();
        await this.client.stopEgress(row.egressId);
      }
    });
  }
  async stopAll(m: Meeting) {
    for (const r of m.recordings.filter((r) =>
      ["starting", "recording", "stopping"].includes(r.status),
    ))
      await this.stop(m, r.id);
  }
  private async finishFiles(m: Meeting, r: Recording, lock: RecordingLock) {
    if (r.rawCleanupPending) {
      await lock.check();
      await this.removeFile(this.file(r, true));
      if (r.storage && !(await this.cleanupStorage(m, r, lock))) return;
      await lock.change((state) => {
        delete state.recordings.find((row) => row.id === r.id)!
          .rawCleanupPending;
      });
      return;
    }
    if (
      r.status === "deleting" ||
      (r.status === "ready" && r.createdAt <= Date.now() - retentionMs)
    ) {
      await lock.change((state) => {
        const row = state.recordings.find((entry) => entry.id === r.id)!;
        row.status = "deleting";
        clearRecordingLink(row);
      });
      await lock.audit("recorder", "recording.revoke", r.id);
      if (r.storage) {
        if (!(await this.cleanupStorage(m, r, lock))) return;
        await lock.check();
        await this.removeFile(this.file(r, true));
        await lock.change((state) => {
          const row = state.recordings.find((entry) => entry.id === r.id)!;
          row.status = "deleted";
          delete row.metadata;
        });
        return;
      }
      await lock.check();
      if (r.metadata?.storage) {
        if (!this.objectStorage)
          throw new Error("Recording object storage is required for deletion");
        await this.objectStorage.delete(
          r.metadata.storage,
          r.metadata,
          this.context(m, r),
        );
      }
      await lock.check();
      await this.removeFile(this.file(r));
      await lock.check();
      await this.removeFile(this.file(r, true));
      await lock.change((state) => {
        const row = state.recordings.find((entry) => entry.id === r.id)!;
        row.status = "deleted";
        delete row.metadata;
      });
      return;
    }
    if (r.status === "ready" && r.storage) {
      await this.cleanupStorage(m, r, lock, this.keptStorage(r));
      return;
    }
    if (r.status !== "encrypting") return;
    if (!this.provider) throw new Error("Recording keys are not configured");
    await this.directories();
    if (r.storage) {
      await this.finishOwnedEncryption(m, r, lock);
      return;
    }
    if (m.hosted?.billingOwnerId)
      throw new Error("Recording storage inventory is unavailable");
    if (!r.metadata) {
      const raw = await lstat(this.file(r, true));
      if (!raw.isFile() || raw.size > this.config.recordingMaxBytes)
        throw new Error("Recording spool is not a bounded regular file");
      await lock.check();
      // A disconnected old worker can finish only its own immutable attempt.
      // Never overwrite ciphertext whose database commit may have succeeded.
      const attempt = { ...r, ciphertextId: randomUUID() };
      const metadata = await encryptRecording(
        this.file(r, true),
        this.file(attempt),
        this.context(m, r),
        this.provider,
      );
      await lock.change((state) => {
        const row = state.recordings.find((entry) => entry.id === r.id)!;
        if (row.status !== "encrypting" || row.metadata)
          throw new Error("Recording encryption state changed");
        row.metadata = metadata;
        row.ciphertextId = attempt.ciphertextId;
      });
    }
    await this.finishEncryption(m, r, lock);
  }
  async reconcile(
    snapshot: Meeting,
    phase: "capture" | "files" | "all" = "all",
  ) {
    for (const candidate of snapshot.recordings) {
      const capture = ["starting", "recording", "stopping"].includes(
        candidate.status,
      );
      const files =
        candidate.rawCleanupPending ||
        ["ready", "deleting", "encrypting"].includes(candidate.status);
      if (
        (!capture && !files) ||
        (phase === "capture" && !capture) ||
        (phase === "files" && !files)
      )
        continue;
      try {
        await this.store.withRecordingLock(
          snapshot.code,
          candidate.id,
          async (lock) => {
            // The timer snapshot may predate another process's terminal transition.
            let m = await lock.get();
            let r = m?.recordings.find((row) => row.id === candidate.id);
            if (!m || !r) return;
            if (["starting", "recording", "stopping"].includes(r.status)) {
              if (phase === "files") return;
              // Stop intent must survive a failed status lookup or a lost response.
              let timing;
              try {
                timing = await lock.checkRecordingTime();
              } catch (error) {
                // Lost accounting access cannot authorize continued paid capture.
                if (r.egressId)
                  await this.client.stopEgress(r.egressId).catch(() => {});
                throw error;
              }
              r = timing.recording;
              let stopAttempted = false;
              if (
                timing.mustStop ||
                r.status === "stopping" ||
                !this.available ||
                (await this.storageCaptureFull(m, r)) ||
                !m.recordingAllowed ||
                !meetingAllowed(m)
              ) {
                await lock.change((state) => {
                  const row = state.recordings.find(
                    (entry) => entry.id === r!.id,
                  )!;
                  if (["starting", "recording"].includes(row.status))
                    row.status = "stopping";
                });
                if (r.egressId) {
                  await lock.check();
                  // Listing may still prove a terminal job when the stop RPC fails.
                  stopAttempted = true;
                  await this.client.stopEgress(r.egressId).catch(() => {});
                }
              }
              const recovered = !r.egressId;
              let info: EgressInfo | undefined;
              try {
                info = recovered
                  ? await this.recoverUntracked(m, r, lock)
                  : (
                      await this.client.listEgress({ egressId: r.egressId })
                    ).find((job) => job.egressId === r!.egressId);
              } catch {
                // A failed lookup does not prove the recorder stopped.
              }
              if (!info) {
                await lock
                  .change((state) => {
                    state.recordings.find((row) => row.id === r!.id)!.status =
                      "stopping";
                  })
                  .catch(() => {});
                if (r.egressId && !stopAttempted)
                  await this.client.stopEgress(r.egressId).catch(() => {});
                return;
              }
              if (info.status === EgressStatus.EGRESS_ENDING)
                await lock.change((state) => {
                  state.recordings.find((row) => row.id === r!.id)!.status =
                    "stopping";
                });
              let observation;
              try {
                observation = await this.observeTime(m, r, info, lock);
              } catch (error) {
                await lock
                  .change((state) => {
                    state.recordings.find((row) => row.id === r!.id)!.status =
                      "stopping";
                  })
                  .catch(() => {});
                if (!terminalStatuses.includes(info.status))
                  await this.client.stopEgress(info.egressId).catch(() => {});
                throw error;
              }
              if (terminalStatuses.includes(info.status)) {
                await lock.change((state) => {
                  const row = state.recordings.find(
                    (entry) => entry.id === r!.id,
                  )!;
                  if (info.status === EgressStatus.EGRESS_COMPLETE)
                    row.status = "encrypting";
                  else {
                    row.status = "failed";
                    row.autoLinkPending = false;
                    row.rawCleanupPending = true;
                    row.error = info.error?.includes(
                      "Start signal not received",
                    )
                      ? "No published media was available to record"
                      : "Recording did not complete";
                  }
                });
              } else {
                const stop = await lock.change((state) => {
                  const row = state.recordings.find(
                    (entry) => entry.id === r!.id,
                  )!;
                  const stopping =
                    observation.mustStop ||
                    row.status === "stopping" ||
                    recovered ||
                    !this.available ||
                    !state.recordingAllowed ||
                    !meetingAllowed(state);
                  if (stopping) row.status = "stopping";
                  else if (
                    info.status === EgressStatus.EGRESS_ACTIVE &&
                    row.status === "starting"
                  )
                    row.status = "recording";
                  return stopping;
                });
                // The preflight above already attempted a known stopped job once.
                if (stop && !stopAttempted && !recovered) {
                  await lock.check();
                  await this.client.stopEgress(info.egressId);
                }
              }
              if (phase === "capture") return;
              m = (await lock.get())!;
              r = m.recordings.find((row) => row.id === candidate.id)!;
            }
            if (phase !== "capture") await this.finishFiles(m, r, lock);
          },
        );
      } catch {
        /* Keep pending state and recovery copies; never expose incomplete output. */
      }
    }
  }
  private async issueLink(
    lock: RecordingLock,
    code: string,
    id: string,
    mode: "auto" | "manual",
    authorize?: (meeting: Meeting) => void,
  ) {
    if (!this.provider)
      throw new HttpError(503, "Recording keys are not configured");
    const meeting = await lock.get();
    const row = meeting?.recordings.find((recording) => recording.id === id);
    if (
      !meeting ||
      meeting.hosted?.revoked ||
      !row ||
      row.status !== "ready" ||
      row.createdAt <= Date.now() - retentionMs
    )
      throw new HttpError(409, "Recording is not ready");
    if (!meeting.hostEmailVerified || !meeting.hostEmail)
      throw new HttpError(403, "Verify the host email first");
    authorize?.(meeting);
    const recipient = meeting.hostEmail;
    const generation = row.linkGeneration ?? 0;
    const tokenSecret = randomBytes(32);
    const passwordSecret = randomBytes(32);
    const tokenBindingId = randomBytes(16).toString("hex");
    const passwordBindingId = randomBytes(16).toString("hex");
    const intentId = randomUUID().replaceAll("-", "");
    let credentials;
    let tokenWrapped;
    let passwordWrapped;
    try {
      credentials = await createDownloadCredentialsFromSecrets(
        tokenSecret,
        passwordSecret,
      );
      tokenWrapped = await this.provider.wrapKey(tokenSecret, {
        context: this.context(meeting, row),
        recordingKeyId: tokenBindingId,
      });
      passwordWrapped = await this.provider.wrapKey(passwordSecret, {
        context: this.context(meeting, row),
        recordingKeyId: passwordBindingId,
      });
    } finally {
      tokenSecret.fill(0);
      passwordSecret.fill(0);
    }
    const expiresAt = Math.min(
      Date.now() + 86400000,
      row.createdAt + retentionMs,
    );
    const domain = mailbox(this.config.smtpFrom).split("@")[1]!;
    await lock.change((state) => {
      const current = state.recordings.find((recording) => recording.id === id);
      if (
        state.hosted?.revoked ||
        (current?.linkGeneration ?? 0) !== generation ||
        !state.hostEmailVerified ||
        state.hostEmail !== recipient ||
        !current ||
        current.status !== "ready" ||
        current.createdAt <= Date.now() - retentionMs
      )
        throw new HttpError(409, "Recording or host email changed; retry");
      authorize?.(state);
      current.tokenHash = credentials.tokenDigest;
      current.passwordHash = credentials.passwordHash;
      current.expiresAt = expiresAt;
      current.autoLinkPending = false;
      current.delivery = {
        id: intentId,
        mode,
        recipient,
        messageId: `<recording-${intentId}@${domain}>`,
        token: { bindingId: tokenBindingId, wrappedKey: tokenWrapped },
        password: { bindingId: passwordBindingId, wrappedKey: passwordWrapped },
        attempts: 0,
        nextAttemptAt: Date.now(),
      };
    });
    return {
      url: `${this.config.origin}/download/${code}#${credentials.token}`,
      expiresAt,
    };
  }
  private async deliverPassword(
    lock: RecordingLock,
    id: string,
  ): Promise<"skipped" | "failed" | "sent"> {
    if (!this.mail || !this.provider) return "skipped";
    const meeting = await lock.get();
    const row = meeting?.recordings.find((recording) => recording.id === id);
    const delivery = row?.delivery;
    if (!meeting || !row || !delivery?.password) return "skipped";
    if (
      meeting.hosted?.revoked ||
      row.status !== "ready" ||
      !row.tokenHash ||
      !row.passwordHash ||
      !row.expiresAt ||
      row.expiresAt <= Date.now() ||
      !meeting.hostEmailVerified ||
      meeting.hostEmail !== delivery.recipient
    ) {
      await lock.change((state) => {
        const current = state.recordings.find(
          (recording) => recording.id === id,
        );
        if (current?.delivery?.id === delivery.id) clearRecordingLink(current);
      });
      return "skipped";
    }
    if (delivery.nextAttemptAt > Date.now()) return "skipped";
    await lock.change((state) => {
      const current = state.recordings.find((recording) => recording.id === id);
      if (current?.delivery?.id !== delivery.id || !current.delivery.password)
        throw new HttpError(409, "Recording link changed");
      current.delivery.attempts++;
      current.delivery.nextAttemptAt =
        Date.now() +
        Math.max(
          45_000,
          Math.min(
            3600000,
            5000 * 2 ** Math.min(current.delivery.attempts, 10),
          ),
        );
    });
    const passwordBytes = await this.provider.unwrapKey(
      delivery.password.wrappedKey,
      {
        context: this.context(meeting, row),
        recordingKeyId: delivery.password.bindingId,
      },
    );
    let password: string;
    try {
      if (passwordBytes.length !== 32)
        throw new Error("Invalid password envelope");
      password = Buffer.from(passwordBytes.subarray(0, 18)).toString(
        "base64url",
      );
    } finally {
      passwordBytes.fill(0);
    }
    // Room-row revocation is allowed while this advisory owner unwraps keys.
    // A send already in progress cannot be recalled, but its link is invalid.
    const current = await this.store.get(meeting.code);
    const active = current?.recordings.find((recording) => recording.id === id);
    if (
      current?.hosted?.revoked ||
      !current?.hostEmailVerified ||
      current.hostEmail !== delivery.recipient ||
      active?.status !== "ready" ||
      active.delivery?.id !== delivery.id ||
      active.tokenHash !== row.tokenHash ||
      !active.expiresAt ||
      active.expiresAt <= Date.now()
    )
      return "skipped";
    try {
      await this.mail.sendMail({
        from: this.config.smtpFrom,
        to: delivery.recipient,
        messageId: delivery.messageId,
        subject: "Recording download password",
        text: `Recording: ${id}\nPassword: ${password}\nExpires: ${new Date(row.expiresAt).toISOString()}\nThe download link is available in the meeting host panel. This email does not include the link.`,
      });
    } catch {
      return "failed";
    }
    await lock.change((state) => {
      const current = state.recordings.find((recording) => recording.id === id);
      if (current?.delivery?.id === delivery.id && current.delivery.password) {
        delete current.delivery.password;
        current.delivery.sentAt = Date.now();
      }
    });
    await lock.audit("recorder", "recording.password.delivered", id);
    return "sent";
  }
  async reconcileDelivery(snapshot: Meeting) {
    if (!snapshot.recordings.length) return;
    const start = this.deliveryOffsets.get(snapshot.code) ?? 0;
    if (this.deliveryOffsets.size > 1024) this.deliveryOffsets.clear();
    this.deliveryOffsets.set(
      snapshot.code,
      (start + 1) % snapshot.recordings.length,
    );
    for (
      let index = 0;
      index < Math.min(4, snapshot.recordings.length);
      index++
    ) {
      const candidate =
        snapshot.recordings[(start + index) % snapshot.recordings.length]!;
      if (
        !candidate.autoLinkPending &&
        !candidate.delivery?.password &&
        !(candidate.expiresAt && candidate.expiresAt <= Date.now())
      )
        continue;
      try {
        const result = await this.store.withRecordingLock(
          snapshot.code,
          candidate.id,
          async (lock) => {
            const meeting = await lock.get();
            const row = meeting?.recordings.find((r) => r.id === candidate.id);
            if (!meeting || !row) return;
            if (
              (row.expiresAt && row.expiresAt <= Date.now()) ||
              row.createdAt <= Date.now() - retentionMs ||
              meeting.hosted?.revoked ||
              ["deleting", "deleted", "failed"].includes(row.status)
            ) {
              await lock.change((state) => {
                const current = state.recordings.find(
                  (r) => r.id === candidate.id,
                );
                if (current) clearRecordingLink(current);
              });
              return;
            }
            if (row.status === "ready" && row.autoLinkPending) {
              if (!meeting.hostEmailVerified || !meeting.hostEmail) {
                await lock.change((state) => {
                  state.recordings.find(
                    (r) => r.id === candidate.id,
                  )!.autoLinkPending = false;
                });
                return;
              }
              if (!this.provider || !this.mail) return;
              await this.issueLink(lock, snapshot.code, candidate.id, "auto");
            }
            return this.deliverPassword(lock, candidate.id);
          },
        );
        if (
          result.acquired &&
          result.value !== "skipped" &&
          result.value !== undefined
        )
          return;
      } catch {
        // Keep the committed intent for a later pass; never mint a replacement.
        return;
      }
    }
  }
  async link(m: Meeting, id: string, authorize?: (meeting: Meeting) => void) {
    if (!this.provider || !this.mail || !hasMail(this.config))
      throw new HttpError(503, "Recording is not configured");
    const result = await this.store.withRecordingLock(
      m.code,
      id,
      async (lock) => {
        const link = await this.issueLink(
          lock,
          m.code,
          id,
          "manual",
          authorize,
        );
        if ((await this.deliverPassword(lock, id)) !== "sent")
          throw new HttpError(
            503,
            "Password email is pending. Try again later.",
          );
        await lock.audit("host", "recording.link", id);
        return link;
      },
    );
    if (!result.acquired) throw new HttpError(409, "Recording is busy; retry");
    return result.value;
  }
  async currentLink(m: Meeting, id: string) {
    if (!this.provider)
      throw new HttpError(503, "Recording keys are not configured");
    const meeting = await this.store.get(m.code);
    const row = meeting?.recordings.find((recording) => recording.id === id);
    if (
      !meeting ||
      meeting.hosted?.revoked ||
      !row ||
      row.status !== "ready" ||
      !row.tokenHash ||
      !row.expiresAt ||
      row.expiresAt <= Date.now() ||
      row.createdAt <= Date.now() - retentionMs ||
      !row.delivery?.token
    )
      throw new HttpError(404, "Recording link unavailable");
    const tokenBytes = await this.provider.unwrapKey(
      row.delivery.token.wrappedKey,
      {
        context: this.context(meeting, row),
        recordingKeyId: row.delivery.token.bindingId,
      },
    );
    let token: string;
    try {
      if (tokenBytes.length !== 32) throw new Error("Invalid token envelope");
      token = Buffer.from(tokenBytes).toString("base64url");
    } finally {
      tokenBytes.fill(0);
    }
    const current = (await this.store.get(m.code))?.recordings.find(
      (r) => r.id === id,
    );
    if (
      !current ||
      current.status !== "ready" ||
      !current.tokenHash ||
      !safeEqual(current.tokenHash, digestDownloadToken(token)) ||
      !current.expiresAt ||
      current.expiresAt <= Date.now() ||
      current.delivery?.id !== row.delivery.id
    )
      throw new HttpError(404, "Recording link unavailable");
    return {
      url: `${this.config.origin}/download/${m.code}#${token}`,
      expiresAt: current.expiresAt,
    };
  }
  async revoke(m: Meeting, id: string, authorize?: (meeting: Meeting) => void) {
    // Invalidate immediately even if a KMS or SMTP call holds ownership.
    // Its eventual issue commit must compare linkGeneration, and its mail ACK
    // is conditional on the old intent ID.
    await this.store.change(m.code, (state) => {
      authorize?.(state);
      const r = state.recordings.find((x) => x.id === id);
      if (!r) throw new HttpError(404, "Recording unavailable");
      clearRecordingLink(r);
    });
    await this.store.audit(m.code, "host", "recording.revoke", id);
  }
  async findToken(token: string, code: string) {
    let hash: string;
    try {
      hash = digestDownloadToken(token);
    } catch {
      return null;
    }
    const m = await this.store.get(code);
    if (m && !m.hosted?.revoked) {
      const r = m.recordings.find(
        (r) =>
          r.status === "ready" &&
          r.createdAt > Date.now() - retentionMs &&
          r.tokenHash &&
          safeEqual(r.tokenHash, hash) &&
          (r.expiresAt ?? 0) > Date.now(),
      );
      if (r) return { m, r };
    }
    return null;
  }
  async download(
    m: Meeting,
    r: Recording,
    token: string,
    password: string,
    authorize?: (current: Meeting) => void,
    signal?: AbortSignal,
  ) {
    signal?.throwIfAborted();
    const current = await this.findToken(token, m.code);
    if (
      !this.provider ||
      !current ||
      current.r.id !== r.id ||
      current.m.id !== m.id ||
      !current.r.passwordHash ||
      !(await verifyRecordingPassword(current.r.passwordHash, password))
    )
      throw new HttpError(403, "Download unavailable");
    signal?.throwIfAborted();
    const source = await this.openEncrypted(
      current.m,
      current.r,
      current.r.metadata,
      signal,
    );
    const reader = source[Symbol.asyncIterator]();
    let first: IteratorResult<Buffer> | undefined;
    let handedOff = false;
    let closing: Promise<void> | undefined;
    const close = () =>
      (closing ??= (async () => {
        source.destroy();
        if (first && !first.done && !handedOff) first.value.fill(0);
        await reader.return?.();
      })());
    const currentAccess = (state: Meeting | null) => {
      signal?.throwIfAborted();
      if (!state) throw new HttpError(403, "Download unavailable");
      authorize?.(state);
      const saved = state.recordings.find((row) => row.id === r.id);
      if (
        state.id !== current.m.id ||
        state.hosted?.revoked ||
        !saved ||
        saved.status !== "ready" ||
        saved.createdAt <= Date.now() - retentionMs ||
        (saved.expiresAt ?? 0) <= Date.now() ||
        saved.tokenHash !== current.r.tokenHash ||
        saved.passwordHash !== current.r.passwordHash ||
        saved.ciphertextId !== current.r.ciphertextId ||
        !isDeepStrictEqual(saved.metadata, current.r.metadata)
      )
        throw new HttpError(403, "Download unavailable");
    };
    const authorizeFrame = async (frame: Buffer) => {
      try {
        currentAccess(await this.store.get(m.code));
      } catch (error) {
        frame.fill(0);
        throw error;
      }
    };
    try {
      if (signal) addAbortSignal(signal, source);
      // Open the file and authenticate its first frame before charging. The
      // decryptor bounds every frame by the persisted size; EOF verifies total size.
      first = await reader.next();
      await this.store.debitRecordingDownload(
        m.code,
        current.r.metadata.plaintextBytes,
        currentAccess,
      );
      await this.store.audit(m.code, "host", "recording.download", r.id);
      signal?.throwIfAborted();
      const output = Readable.from(
        (async function* () {
          try {
            // A revocation on another API process blocks the next frame; bytes
            // already handed to the transport cannot be recalled.
            if (!first!.done) {
              await authorizeFrame(first!.value);
              handedOff = true;
              yield first!.value;
            }
            for await (const chunk of reader) {
              await authorizeFrame(chunk);
              yield chunk;
            }
          } finally {
            await close();
          }
        })(),
        { objectMode: false },
      );
      // Interrupt pending source reads before the output waits for its generator.
      const destroy = output._destroy;
      output._destroy = (error, done) => {
        void close().catch(() => {});
        destroy.call(output, error, done);
      };
      if (signal) addAbortSignal(signal, output);
      return output;
    } catch (error) {
      await close().catch(() => {});
      throw error;
    }
  }
}
