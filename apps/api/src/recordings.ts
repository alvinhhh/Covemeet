import { meetingAllowed } from "./meeting-limits.js";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { Transporter } from "nodemailer";
import {
  EgressClient,
  EgressStatus,
  EncodedFileOutput,
  EncodedFileType,
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
  decryptRecordingToStream,
  createDownloadCredentials,
  digestDownloadToken,
  verifyRecordingPassword,
} from "@meeting-platform/recording";
import type { Config } from "./config.js";
import type { Meeting, Recording, RecordingLock, Store } from "./store.js";
import { activePhone } from "./phone.js";
import { HttpError, safeEqual } from "./security.js";

export type RecorderClient = Pick<
  EgressClient,
  "startRoomCompositeEgress" | "stopEgress" | "listEgress"
>;

export class RecordingService {
  readonly available: boolean;
  private provider?: KeyProvider;
  private objectStorage?: RecordingObjectStorage;
  private client: RecorderClient;
  constructor(
    private config: Config,
    private store: Store,
    private mail: Transporter,
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
      !!config.smtpHost &&
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
      if (current.status === "encrypting" && current.metadata)
        current.status = "ready";
    });
    await lock.audit("recorder", "recording.encrypted", r.id);
  }
  private async openEncrypted(m: Meeting, r: Recording, metadata = r.metadata) {
    if (!this.provider)
      throw new HttpError(503, "Recording keys are not configured");
    if (metadata?.storage) {
      if (!this.objectStorage)
        throw new HttpError(503, "Recording object storage is not configured");
      const ciphertext = await this.objectStorage.read(
        metadata.storage,
        metadata,
        this.context(m, r),
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
            JSON.stringify(row.metadata) !== JSON.stringify(previous)
          ) {
            throw new HttpError(
              409,
              "Recording changed during key rotation; retry",
            );
          }
          row.metadata = rotated;
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
    if (!this.available)
      throw new HttpError(503, "Recording is not configured");
    await this.directories();
    const r: Recording = {
      id: randomUUID(),
      status: "starting",
      createdAt: Date.now(),
    };
    await this.store.withRecordingLock(meeting.code, r.id, async (lock) => {
      await lock.change((m) => {
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
        m.recordings.push(r);
      });
      let startedId: string | undefined;
      try {
        await lock.check();
        const info = await this.client.startRoomCompositeEgress(
          meeting.room,
          new EncodedFileOutput({
            fileType: EncodedFileType.MP4,
            filepath: `${this.config.egressFileRoot}/raw/${r.id}.mp4`,
          }),
          { layout: "grid" },
        );
        startedId = info.egressId;
        if (!startedId) throw new Error("Recorder response omitted its job ID");
        const mustStop = await lock.change((m) => {
          const row = m.recordings.find((x) => x.id === r.id)!;
          row.egressId = info.egressId;
          const stop =
            !meetingAllowed(m) ||
            !m.recordingAllowed ||
            row.status === "stopping";
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
  async reconcile(snapshot: Meeting) {
    for (const candidate of snapshot.recordings) {
      if (
        ![
          "ready",
          "deleting",
          "recording",
          "starting",
          "stopping",
          "encrypting",
        ].includes(candidate.status)
      )
        continue;
      try {
        await this.store.withRecordingLock(
          snapshot.code,
          candidate.id,
          async (lock) => {
            // The timer snapshot may predate another process's completed encryption or deletion.
            const m = await lock.get();
            const r = m?.recordings.find((row) => row.id === candidate.id);
            if (!m || !r) return;
            if (
              r.status === "deleting" ||
              (r.status === "ready" && r.createdAt < Date.now() - 7 * 86400000)
            ) {
              await lock.change((state) => {
                const row = state.recordings.find(
                  (entry) => entry.id === r.id,
                )!;
                row.status = "deleting";
                delete row.tokenHash;
                delete row.passwordHash;
                delete row.expiresAt;
              });
              await lock.audit("recorder", "recording.revoke", r.id);
              await lock.check();
              if (r.metadata?.storage) {
                if (!this.objectStorage)
                  throw new Error(
                    "Recording object storage is required for deletion",
                  );
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
                const row = state.recordings.find(
                  (entry) => entry.id === r.id,
                )!;
                row.status = "deleted";
                delete row.metadata;
              });
              return;
            }
            if (
              r.status === "ready" ||
              !["recording", "starting", "stopping", "encrypting"].includes(
                r.status,
              )
            )
              return;
            if (r.status === "encrypting" && r.metadata) {
              await this.directories();
              await this.finishEncryption(m, r, lock);
              return;
            }
            const recovered = !r.egressId;
            const info = recovered
              ? await this.recoverUntracked(m, r, lock)
              : (await this.client.listEgress({ egressId: r.egressId }))[0];
            if (!info) return;
            if (info.status === EgressStatus.EGRESS_COMPLETE) {
              if (!this.provider)
                throw new Error("Recording keys are not configured");
              await this.directories();
              const raw = await lstat(this.file(r, true));
              if (!raw.isFile() || raw.size > this.config.recordingMaxBytes)
                throw new Error(
                  "Recording spool is not a bounded regular file",
                );
              await lock.check();
              // A disconnected old worker can finish only its own immutable attempt.
              // Never remove or overwrite ciphertext whose database commit may have succeeded.
              const attempt = { ...r, ciphertextId: randomUUID() };
              const metadata = await encryptRecording(
                this.file(r, true),
                this.file(attempt),
                this.context(m, r),
                this.provider,
              );
              await lock.change((state) => {
                const row = state.recordings.find(
                  (entry) => entry.id === r.id,
                )!;
                if (row.metadata)
                  throw new Error("Recording encryption state changed");
                row.metadata = metadata;
                row.ciphertextId = attempt.ciphertextId;
                row.status = "encrypting";
              });
              await this.finishEncryption(m, attempt, lock);
            } else if (
              [
                EgressStatus.EGRESS_FAILED,
                EgressStatus.EGRESS_ABORTED,
                EgressStatus.EGRESS_LIMIT_REACHED,
              ].includes(info.status)
            ) {
              await lock.check();
              await this.removeFile(this.file(r, true));
              await lock.change((state) => {
                const row = state.recordings.find(
                  (entry) => entry.id === r.id,
                )!;
                row.status = "failed";
                row.error = info.error?.includes("Start signal not received")
                  ? "No published media was available to record"
                  : "Recording did not complete";
              });
            } else {
              const current = (await lock.get())!;
              const row = current.recordings.find(
                (entry) => entry.id === r.id,
              )!;
              if (
                row.status === "stopping" ||
                recovered ||
                !this.available ||
                !current.recordingAllowed ||
                !meetingAllowed(current)
              ) {
                await lock.check();
                await this.client.stopEgress(info.egressId);
                await lock.change((state) => {
                  const row = state.recordings.find(
                    (entry) => entry.id === r.id,
                  )!;
                  if (["starting", "recording"].includes(row.status))
                    row.status = "stopping";
                });
              } else if (
                info.status === EgressStatus.EGRESS_ACTIVE &&
                row.status === "starting"
              ) {
                await lock.change((state) => {
                  const row = state.recordings.find(
                    (entry) => entry.id === r.id,
                  )!;
                  if (row.status === "starting") row.status = "recording";
                });
              }
            }
          },
        );
      } catch {
        /* Keep pending state and recovery copies; never expose incomplete output. */
      }
    }
  }
  async link(m: Meeting, id: string) {
    if (!this.available)
      throw new HttpError(503, "Recording is not configured");
    const credentials = await createDownloadCredentials();
    const expiresAt = Date.now() + 86400000;
    const email = await this.store.change(m.code, (state) => {
      if (state.hosted?.revoked)
        throw new HttpError(403, "Recording unavailable");
      const r = state.recordings.find((x) => x.id === id);
      if (!r || r.status !== "ready")
        throw new HttpError(409, "Recording is not ready");
      if (!state.hostEmailVerified || !state.hostEmail)
        throw new HttpError(403, "Verify the host email first");
      r.tokenHash = credentials.tokenDigest;
      r.passwordHash = credentials.passwordHash;
      r.expiresAt = expiresAt;
      return state.hostEmail;
    });
    try {
      await this.mail.sendMail({
        from: this.config.smtpFrom,
        to: email,
        subject: "Recording download password",
        text: `Recording: ${id}\nPassword: ${credentials.password}\nExpires: ${new Date(expiresAt).toISOString()}\nThe download link is available in the meeting host panel. This email does not include the link.`,
      });
    } catch {
      await this.store.change(m.code, (state) => {
        const r = state.recordings.find((x) => x.id === id)!;
        if (r.tokenHash === credentials.tokenDigest) {
          delete r.tokenHash;
          delete r.passwordHash;
          delete r.expiresAt;
        }
      });
      throw new HttpError(503, "Password email failed. Request a new link.");
    }
    await this.store.audit(m.code, "host", "recording.link", id);
    return {
      url: `${this.config.origin}/download/${m.code}#${credentials.token}`,
      expiresAt,
    };
  }
  async revoke(m: Meeting, id: string) {
    await this.store.change(m.code, (state) => {
      const r = state.recordings.find((x) => x.id === id);
      if (!r) throw new HttpError(404, "Recording unavailable");
      delete r.tokenHash;
      delete r.passwordHash;
      delete r.expiresAt;
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
          r.tokenHash &&
          safeEqual(r.tokenHash, hash) &&
          (r.expiresAt ?? 0) > Date.now(),
      );
      if (r) return { m, r };
    }
    return null;
  }
  async download(m: Meeting, r: Recording, token: string, password: string) {
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
    // Recheck after the expensive password verification to observe a concurrent revocation.
    if (!(await this.findToken(token, m.code)))
      throw new HttpError(403, "Download unavailable");
    await this.store.audit(m.code, "host", "recording.download", r.id);
    return this.openEncrypted(current.m, current.r);
  }
}
