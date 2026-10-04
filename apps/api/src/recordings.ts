import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
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
  LocalKeyProvider,
  encryptRecording,
  decryptRecordingToStream,
  createDownloadCredentials,
  digestDownloadToken,
  verifyRecordingPassword,
} from "@meeting-platform/recording";
import type { Config } from "./config.js";
import type { Meeting, Recording, Store } from "./store.js";
import { HttpError, safeEqual } from "./security.js";

export type RecorderClient = Pick<
  EgressClient,
  "startRoomCompositeEgress" | "stopEgress" | "listEgress"
>;

export class RecordingService {
  readonly available: boolean;
  private provider?: LocalKeyProvider;
  private client: RecorderClient;
  private working = new Set<string>();
  constructor(
    private config: Config,
    private store: Store,
    private mail: Transporter,
    client?: RecorderClient,
  ) {
    const key = Buffer.from(config.recordingKek, "base64");
    this.available =
      config.recordingEnabled &&
      key.length === 32 &&
      !!config.smtpHost &&
      !!config.livekitKey &&
      !!config.livekitSecret;
    if (this.available)
      this.provider = new LocalKeyProvider({ keyId: "operator-kek-v1", key });
    key.fill(0);
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
    return path.join(
      this.config.recordingDir,
      raw ? "raw" : "encrypted",
      `${r.id}.${raw ? "mp4" : "mprec"}`,
    );
  }
  private async directories() {
    await mkdir(path.join(this.config.recordingDir, "raw"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(path.join(this.config.recordingDir, "encrypted"), {
      recursive: true,
      mode: 0o700,
    });
  }
  private async removeFile(file: string) {
    try {
      await unlink(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  private async finishEncryption(m: Meeting, r: Recording) {
    // Metadata is already committed. Retrying after a crash needs no plaintext re-read.
    await this.removeFile(this.file(r, true));
    await this.store.change(m.code, (state) => {
      const row = state.recordings.find((x) => x.id === r.id)!;
      if (row.status === "encrypting" && row.metadata) row.status = "ready";
    });
    await this.store.audit(m.code, "recorder", "recording.encrypted", r.id);
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
  private async recoverUntracked(m: Meeting, r: Recording) {
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
        await this.client.stopEgress(info.egressId);
      }
    }
    if (matches.length !== 1) {
      // Ambiguous output ownership stays pending instead of exposing a raced spool.
      throw new Error("Multiple recorder jobs require operator review");
    }
    const info = matches[0]!;
    await this.store.change(m.code, (state) => {
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
    await this.store.change(meeting.code, (m) => {
      if (m.ended || !m.recordingAllowed)
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
    this.working.add(r.id);
    try {
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
      const mustStop = await this.store.change(meeting.code, (m) => {
        const row = m.recordings.find((x) => x.id === r.id)!;
        row.egressId = info.egressId;
        const stop =
          m.ended || !m.recordingAllowed || row.status === "stopping";
        row.status = stop
          ? "stopping"
          : info.status === EgressStatus.EGRESS_ACTIVE
            ? "recording"
            : "starting";
        return stop;
      });
      if (mustStop) await this.client.stopEgress(info.egressId);
      await this.store.audit(meeting.code, "host", "recording.start", r.id);
    } catch {
      // Stop before trying to persist recovery state: the database may be unavailable.
      if (startedId) await this.client.stopEgress(startedId).catch(() => {});
      await this.store
        .change(meeting.code, (m) => {
          const row = m.recordings.find((recording) => recording.id === r.id)!;
          if (startedId) row.egressId = startedId;
          row.status = "stopping";
          row.error =
            "Recorder start did not complete; stop recovery is pending";
        })
        .catch(() => {});
      if (!startedId) await this.recoverUntracked(meeting, r).catch(() => {});
      throw new HttpError(
        503,
        "Recorder start failed; stop recovery is pending",
      );
    } finally {
      this.working.delete(r.id);
    }
  }
  async stop(m: Meeting, id: string) {
    const row = await this.store.change(m.code, (state) => {
      const r = state.recordings.find((x) => x.id === id);
      if (!r) throw new HttpError(404, "Recording unavailable");
      if (["starting", "recording", "stopping"].includes(r.status))
        r.status = "stopping";
      return structuredClone(r);
    });
    if (row.egressId && row.status === "stopping")
      await this.client.stopEgress(row.egressId);
  }
  async stopAll(m: Meeting) {
    for (const r of m.recordings.filter((r) =>
      ["starting", "recording", "stopping"].includes(r.status),
    ))
      await this.stop(m, r.id);
  }
  async reconcile(m: Meeting) {
    if (!this.available) return;
    for (const r of m.recordings) {
      if (this.working.has(r.id)) continue;
      if (r.status === "ready" && r.createdAt < Date.now() - 7 * 86400000) {
        await this.revoke(m, r.id);
        await this.removeFile(this.file(r));
        await this.removeFile(this.file(r, true));
        await this.store.change(m.code, (state) => {
          const row = state.recordings.find((x) => x.id === r.id)!;
          row.status = "deleted";
          delete row.metadata;
        });
        continue;
      }
      if (
        !["recording", "starting", "stopping", "encrypting"].includes(r.status)
      )
        continue;
      this.working.add(r.id);
      try {
        if (r.status === "encrypting" && r.metadata) {
          await this.finishEncryption(m, r);
          continue;
        }
        const recovered = !r.egressId;
        const info = recovered
          ? await this.recoverUntracked(m, r)
          : (await this.client.listEgress({ egressId: r.egressId }))[0];
        if (!info) continue;
        if (info.status === EgressStatus.EGRESS_COMPLETE) {
          await this.directories();
          // An interrupted encryption may leave an orphan encrypted file; it has never been offered for download.
          await this.removeFile(this.file(r));
          const metadata = await encryptRecording(
            this.file(r, true),
            this.file(r),
            this.context(m, r),
            this.provider!,
          );
          await this.store.change(m.code, (state) => {
            const row = state.recordings.find((x) => x.id === r.id)!;
            row.metadata = metadata;
            row.status = "encrypting";
          });
          await this.finishEncryption(m, r);
        } else if (
          [
            EgressStatus.EGRESS_FAILED,
            EgressStatus.EGRESS_ABORTED,
            EgressStatus.EGRESS_LIMIT_REACHED,
          ].includes(info.status)
        ) {
          await this.removeFile(this.file(r, true));
          await this.store.change(m.code, (state) => {
            const row = state.recordings.find((x) => x.id === r.id)!;
            row.status = "failed";
            row.error = info.error?.includes("Start signal not received")
              ? "No published media was available to record"
              : "Recording did not complete";
          });
        } else if (r.status === "stopping" || recovered) {
          await this.client.stopEgress(info.egressId);
        } else if (
          info.status === EgressStatus.EGRESS_ACTIVE &&
          r.status === "starting"
        ) {
          await this.store.change(m.code, (state) => {
            const row = state.recordings.find((x) => x.id === r.id)!;
            if (row.status === "starting") row.status = "recording";
          });
        }
      } catch {
        /* Keep pending state for retry; never expose unencrypted or incomplete output. */
      } finally {
        this.working.delete(r.id);
      }
    }
  }
  async link(m: Meeting, id: string) {
    if (!this.available)
      throw new HttpError(503, "Recording is not configured");
    const credentials = await createDownloadCredentials();
    const expiresAt = Date.now() + 86400000;
    const email = await this.store.change(m.code, (state) => {
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
    if (m) {
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
    return decryptRecordingToStream(
      this.file(r),
      current.r.metadata,
      this.context(m, r),
      this.provider,
    );
  }
}
