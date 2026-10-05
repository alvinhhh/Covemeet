import pg from "pg";
import { HttpError } from "./security.js";
import {
  bumpPhoneDialog,
  canFinishPhoneDialog,
  editPhoneDialog,
  newPhoneDialog,
  ownPhoneDialog,
  samePhoneDialog,
  type PhoneCleanupProof,
  type PhoneDialog,
  type PhoneDialogChange,
  type PhoneDialogInput,
  type PhoneDialogQuery,
  type PhoneDialogStop,
} from "./phone-dialogs.js";
export type Participant = {
  transport?: "browser" | "phone";
  phone?: {
    callId: string;
    trunkId: string;
    callerHash?: string;
    muted: boolean;
    handRaised: boolean;
    leaseExpiresAt: number;
    callExpiresAt: number;
  };
  id: string;
  name: string;
  role: "host" | "participant" | "viewer";
  status: "waiting" | "admitted" | "kicked" | "banned" | "left";
  audioAllowed: boolean;
  videoAllowed: boolean;
  mediaVersion: number;
  tokenHash: string;
  expiresAt: number;
  ipHash: string;
  deviceHash: string;
  breakoutId: string | null;
  enforcementPending?: boolean;
  previousRoom?: string;
};
export type Recording = {
  id: string;
  status: string;
  createdAt: number;
  egressId?: string;
  ciphertextId?: string;
  metadata?: any;
  tokenHash?: string;
  passwordHash?: string;
  expiresAt?: number;
  error?: string;
};
export type Meeting = {
  phoneAccess?: {
    enabled: boolean;
    locator: string;
    pinHash: string;
  };
  id: string;
  code: string;
  room: string;
  title: string;
  mode: "meeting" | "webinar";
  locked: boolean;
  ended: boolean;
  recordingAllowed: boolean;
  createdAt: number;
  revision: number;
  passwordHash: string;
  hostTokenHash?: string;
  hostTokenExpiresAt: number;
  participants: Participant[];
  bans: { ip: string[]; device: string[]; caller?: string[] };
  breakouts: { id: string; name: string; room: string }[];
  messages: {
    id: string;
    name: string;
    text: string;
    createdAt: number;
    breakoutId: string | null;
    broadcast?: boolean;
  }[];
  recordings: Recording[];
  hostEmail?: string;
  hostEmailVerified?: boolean;
  emailOtpHash?: string;
  emailOtpExpiresAt?: number;
  emailOtpAttempts?: number;
};
export function participantRoom(m: Meeting, p: Participant) {
  return p.breakoutId
    ? (m.breakouts.find((b) => b.id === p.breakoutId)?.room ?? m.room)
    : m.room;
}
export interface RecordingLock {
  get(): Promise<Meeting | null>;
  check(): Promise<void>;
  change<T>(fn: (m: Meeting) => Promise<T> | T): Promise<T>;
  audit(actor: string, action: string, target?: string): Promise<void>;
}
export interface Store {
  withRecordingLock<T>(
    code: string,
    id: string,
    fn: (lock: RecordingLock) => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }>;
  getSettings(): Promise<any>;
  setSettings(value: any): Promise<void>;
  getAsset(id: string): Promise<{ mime: string; data: string } | null>;
  setAsset(id: string, mime: string, data: string): Promise<void>;
  create(m: Meeting): Promise<void>;
  get(code: string): Promise<Meeting | null>;
  byRoom(room: string): Promise<Meeting | null>;
  all(): Promise<Meeting[]>;
  change<T>(code: string, fn: (m: Meeting) => Promise<T> | T): Promise<T>;
  byPhoneLocator(locator: string): Promise<Meeting | null>;
  reservePhone<T>(
    code: string,
    callId: string,
    participantId: string,
    limit: number,
    fn: (m: Meeting) => T,
    ownerId?: string,
  ): Promise<T>;
  createPhoneDialog(
    input: PhoneDialogInput,
    limit: number,
  ): Promise<PhoneDialog>;
  queryPhoneDialogs(query: PhoneDialogQuery): Promise<PhoneDialog[]>;
  changePhoneDialog(
    callId: string,
    ownerId: string,
    revision: number,
    change: PhoneDialogChange,
  ): Promise<PhoneDialog>;
  stopPhoneDialog(
    callId: string,
    ownerId: string,
    revision: number,
  ): Promise<PhoneDialogStop>;
  finishPhoneDialog(
    callId: string,
    ownerId: string,
    revision: number,
    proof: PhoneCleanupProof,
  ): Promise<PhoneDialog>;
  releasePhone(
    callId: string,
    code: string,
    participantId: string,
  ): Promise<void>;
  phoneAttempt(key: string, limit: number, now: number): Promise<boolean>;
  audit(
    code: string,
    actor: string,
    action: string,
    target?: string,
  ): Promise<void>;
  close(): Promise<void>;
}

const phoneCapacitySql = `SELECT count(*) AS count FROM (
  SELECT call_id FROM phone_calls WHERE released=false
  UNION SELECT call_id FROM phone_dialogs WHERE data->>'state' <> 'closed'
) occupied`;
function requirePhoneJoin(dialog: PhoneDialog | undefined, ownerId?: string) {
  if (!dialog) {
    if (ownerId !== undefined)
      throw new HttpError(409, "Phone dialog is missing");
    return; // Temporary RTC fixture compatibility; still counted against the same cap.
  }
  if (!ownerId) throw new HttpError(409, "Phone dialog owner is required");
  ownPhoneDialog(dialog, ownerId);
  if (
    dialog.state !== "open" ||
    dialog.uncertain ||
    dialog.binding ||
    dialog.operations.answer !== "confirmed"
  )
    throw new HttpError(409, "Phone dialog cannot join");
}
function stopPhoneParticipant(
  dialog: PhoneDialog,
  meeting?: Meeting,
): Participant | undefined {
  if (!dialog.binding) return;
  const participant = meeting?.participants.find(
    (p) => p.id === dialog.binding!.participantId,
  );
  if (
    !participant?.phone ||
    participant.phone.callId !== dialog.callId ||
    participant.transport !== "phone"
  )
    throw new HttpError(409, "Phone dialog meeting binding unavailable");
  if (dialog.state === "open") {
    if (["waiting", "admitted"].includes(participant.status))
      participant.status = "left";
    participant.mediaVersion++;
    participant.enforcementPending = true;
    participant.phone.leaseExpiresAt = 0;
  }
  return participant;
}
function finishedPhoneParticipant(dialog: PhoneDialog, meeting?: Meeting) {
  if (!dialog.binding) return;
  const participant = meeting?.participants.find(
    (p) => p.id === dialog.binding!.participantId,
  );
  if (
    !participant?.phone ||
    participant.phone.callId !== dialog.callId ||
    participant.transport !== "phone" ||
    ["waiting", "admitted"].includes(participant.status) ||
    participant.enforcementPending ||
    participant.phone.leaseExpiresAt !== 0
  )
    throw new HttpError(409, "Phone meeting cleanup remains unresolved");
}
export class PgStore implements Store {
  pool: pg.Pool;
  constructor(url: string) {
    this.pool = new pg.Pool({ connectionString: url, max: 10 });
  }
  async init() {
    await this.pool.query(
      `CREATE TABLE IF NOT EXISTS settings(id text PRIMARY KEY,data jsonb NOT NULL); CREATE TABLE IF NOT EXISTS assets(id text PRIMARY KEY,mime text NOT NULL,data text NOT NULL); CREATE TABLE IF NOT EXISTS meetings(code text PRIMARY KEY,room text UNIQUE NOT NULL,data jsonb NOT NULL); CREATE TABLE IF NOT EXISTS audit_events(id bigserial PRIMARY KEY,meeting_code text NOT NULL,actor text NOT NULL,action text NOT NULL,target text,created_at timestamptz NOT NULL DEFAULT now());`,
    );
    await this.pool
      .query(`CREATE UNIQUE INDEX IF NOT EXISTS meetings_phone_locator ON meetings ((data->'phoneAccess'->>'locator')) WHERE data->'phoneAccess'->>'locator' IS NOT NULL;
      CREATE TABLE IF NOT EXISTS phone_calls(call_id uuid PRIMARY KEY, meeting_code text NOT NULL REFERENCES meetings(code), participant_id text NOT NULL, released boolean NOT NULL DEFAULT false);
      CREATE TABLE IF NOT EXISTS phone_dialogs(call_id uuid PRIMARY KEY, data jsonb NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS phone_dialogs_caller ON phone_dialogs ((data->>'pbxId'), (data->>'pbxEpoch'), (data->>'callerChannelId'));
      CREATE TABLE IF NOT EXISTS phone_attempts(key text PRIMARY KEY, bucket bigint NOT NULL, attempts integer NOT NULL);
      CREATE INDEX IF NOT EXISTS phone_attempts_bucket ON phone_attempts(bucket);`);
  }
  async getSettings() {
    return (
      (await this.pool.query("SELECT data FROM settings WHERE id='branding'"))
        .rows[0]?.data ?? null
    );
  }
  async setSettings(value: any) {
    await this.pool.query(
      "INSERT INTO settings(id,data) VALUES('branding',$1) ON CONFLICT(id) DO UPDATE SET data=$1",
      [JSON.stringify(value)],
    );
  }
  async getAsset(id: string) {
    return (
      (await this.pool.query("SELECT mime,data FROM assets WHERE id=$1", [id]))
        .rows[0] ?? null
    );
  }
  async setAsset(id: string, mime: string, data: string) {
    await this.pool.query(
      "INSERT INTO assets(id,mime,data) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
      [id, mime, data],
    );
  }
  async create(m: Meeting) {
    await this.pool.query(
      "INSERT INTO meetings(code,room,data) VALUES($1,$2,$3)",
      [m.code, m.room, JSON.stringify(m)],
    );
  }
  async get(code: string) {
    return (
      (await this.pool.query("SELECT data FROM meetings WHERE code=$1", [code]))
        .rows[0]?.data ?? null
    );
  }
  async byRoom(room: string) {
    return (
      (await this.pool.query("SELECT data FROM meetings WHERE room=$1", [room]))
        .rows[0]?.data ?? null
    );
  }
  async byPhoneLocator(locator: string) {
    return (
      (
        await this.pool.query(
          "SELECT data FROM meetings WHERE data->'phoneAccess'->>'locator'=$1",
          [locator],
        )
      ).rows[0]?.data ?? null
    );
  }
  async reservePhone<T>(
    code: string,
    callId: string,
    participantId: string,
    limit: number,
    fn: (m: Meeting) => T,
    ownerId?: string,
  ): Promise<T> {
    return this.phoneTransaction(async (c) => {
      const dialog = await this.lockPhoneDialog(c, callId);
      requirePhoneJoin(dialog, ownerId);
      if (
        (await c.query("SELECT 1 FROM phone_calls WHERE call_id=$1", [callId]))
          .rowCount
      )
        throw new HttpError(409, "Call identity has already been used");
      if (
        Number((await c.query(phoneCapacitySql)).rows[0].count) >= limit &&
        !dialog
      )
        throw new HttpError(409, "Phone capacity is full");
      const m = (
        await c.query("SELECT data FROM meetings WHERE code=$1 FOR UPDATE", [
          code,
        ])
      ).rows[0]?.data as Meeting | undefined;
      if (!m) throw new HttpError(403, "Phone access unavailable");
      const result = fn(m);
      m.revision++;
      await c.query("UPDATE meetings SET data=$2 WHERE code=$1", [
        code,
        JSON.stringify(m),
      ]);
      await c.query(
        "INSERT INTO phone_calls(call_id,meeting_code,participant_id) VALUES($1,$2,$3)",
        [callId, code, participantId],
      );
      if (dialog) {
        dialog.binding = { code, participantId };
        bumpPhoneDialog(dialog);
        await this.savePhoneDialog(c, dialog);
      }
      return result;
    });
  }
  async releasePhone(callId: string, code: string, participantId: string) {
    await this.pool.query(
      "UPDATE phone_calls SET released=true WHERE call_id=$1 AND meeting_code=$2 AND participant_id=$3 AND NOT EXISTS (SELECT 1 FROM phone_dialogs WHERE call_id=$1)",
      [callId, code, participantId],
    );
  }
  private async phoneTransaction<T>(
    fn: (client: pg.PoolClient) => Promise<T>,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(704621938)");
      const value = await fn(c);
      await c.query("COMMIT");
      return value;
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  }
  private async lockPhoneDialog(
    c: pg.PoolClient,
    callId: string,
  ): Promise<PhoneDialog | undefined> {
    return (
      await c.query(
        "SELECT data FROM phone_dialogs WHERE call_id=$1 FOR UPDATE",
        [callId],
      )
    ).rows[0]?.data;
  }
  private async savePhoneDialog(c: pg.PoolClient, dialog: PhoneDialog) {
    await c.query("UPDATE phone_dialogs SET data=$2 WHERE call_id=$1", [
      dialog.callId,
      JSON.stringify(dialog),
    ]);
  }
  async createPhoneDialog(
    input: PhoneDialogInput,
    limit: number,
  ): Promise<PhoneDialog> {
    const created = newPhoneDialog(input);
    return this.phoneTransaction(async (c) => {
      const previous = await this.lockPhoneDialog(c, input.callId);
      if (previous) {
        if (!samePhoneDialog(previous, input) || previous.state === "closed")
          throw new HttpError(
            409,
            "Phone dialog identity has already been used",
          );
        return previous;
      }
      if (
        (
          await c.query("SELECT 1 FROM phone_calls WHERE call_id=$1", [
            input.callId,
          ])
        ).rowCount ||
        (
          await c.query(
            "SELECT 1 FROM phone_dialogs WHERE data->>'pbxId'=$1 AND data->>'pbxEpoch'=$2 AND data->>'callerChannelId'=$3",
            [input.pbxId, input.pbxEpoch, input.callerChannelId],
          )
        ).rowCount
      )
        throw new HttpError(409, "Phone dialog identity has already been used");
      if (Number((await c.query(phoneCapacitySql)).rows[0].count) >= limit)
        throw new HttpError(409, "Phone capacity is full");
      await c.query("INSERT INTO phone_dialogs(call_id,data) VALUES($1,$2)", [
        input.callId,
        JSON.stringify(created),
      ]);
      return created;
    });
  }
  async queryPhoneDialogs(query: PhoneDialogQuery): Promise<PhoneDialog[]> {
    const rows =
      "callId" in query
        ? (
            await this.pool.query(
              "SELECT data FROM phone_dialogs WHERE call_id=$1",
              [query.callId],
            )
          ).rows
        : (
            await this.pool.query(
              "SELECT data FROM phone_dialogs WHERE data->>'pbxId'=$1 AND data->>'state'<>'closed' ORDER BY call_id LIMIT 101",
              [query.pbxId],
            )
          ).rows;
    if (rows.length > 100)
      throw new HttpError(409, "Phone dialog query limit exceeded");
    return rows.map((row) => row.data);
  }
  async changePhoneDialog(
    callId: string,
    ownerId: string,
    revision: number,
    change: PhoneDialogChange,
  ): Promise<PhoneDialog> {
    return this.phoneTransaction(async (c) => {
      const dialog = await this.lockPhoneDialog(c, callId);
      if (!dialog) throw new HttpError(404, "Phone dialog unavailable");
      ownPhoneDialog(dialog, ownerId, revision);
      editPhoneDialog(dialog, change);
      await this.savePhoneDialog(c, dialog);
      return dialog;
    });
  }
  async stopPhoneDialog(
    callId: string,
    ownerId: string,
    revision: number,
  ): Promise<PhoneDialogStop> {
    return this.phoneTransaction(async (c) => {
      const dialog = await this.lockPhoneDialog(c, callId);
      if (!dialog) throw new HttpError(404, "Phone dialog unavailable");
      ownPhoneDialog(dialog, ownerId, revision);
      if (dialog.state === "closed") return { dialog };
      const meeting: Meeting | undefined = dialog.binding
        ? (
            await c.query(
              "SELECT data FROM meetings WHERE code=$1 FOR UPDATE",
              [dialog.binding.code],
            )
          ).rows[0]?.data
        : undefined;
      const participant = stopPhoneParticipant(dialog, meeting);
      if (dialog.state === "open") {
        dialog.state = "stopping";
        bumpPhoneDialog(dialog);
        await this.savePhoneDialog(c, dialog);
        if (meeting) {
          meeting.revision++;
          await c.query("UPDATE meetings SET data=$2 WHERE code=$1", [
            meeting.code,
            JSON.stringify(meeting),
          ]);
        }
      }
      return { dialog, meeting, participant };
    });
  }
  async finishPhoneDialog(
    callId: string,
    ownerId: string,
    revision: number,
    proof: PhoneCleanupProof,
  ): Promise<PhoneDialog> {
    return this.phoneTransaction(async (c) => {
      const dialog = await this.lockPhoneDialog(c, callId);
      if (!dialog) throw new HttpError(404, "Phone dialog unavailable");
      ownPhoneDialog(dialog, ownerId, revision);
      canFinishPhoneDialog(dialog, proof);
      const meeting: Meeting | undefined = dialog.binding
        ? (
            await c.query(
              "SELECT data FROM meetings WHERE code=$1 FOR UPDATE",
              [dialog.binding.code],
            )
          ).rows[0]?.data
        : undefined;
      finishedPhoneParticipant(dialog, meeting);
      if (dialog.binding) {
        const released = await c.query(
          "UPDATE phone_calls SET released=true WHERE call_id=$1 AND meeting_code=$2 AND participant_id=$3 RETURNING call_id",
          [callId, dialog.binding.code, dialog.binding.participantId],
        );
        if (released.rowCount !== 1)
          throw new HttpError(409, "Phone reservation binding unavailable");
      }
      dialog.state = "closed";
      bumpPhoneDialog(dialog);
      await this.savePhoneDialog(c, dialog);
      return dialog;
    });
  }
  async phoneAttempt(key: string, limit: number, now: number) {
    const bucket = Math.floor(now / 60000);
    await this.pool.query("DELETE FROM phone_attempts WHERE bucket<$1", [
      bucket - 2,
    ]);
    const r = await this.pool.query(
      `INSERT INTO phone_attempts(key,bucket,attempts) VALUES($1,$2,1)
      ON CONFLICT(key) DO UPDATE SET bucket=$2,attempts=CASE WHEN phone_attempts.bucket=$2 THEN phone_attempts.attempts+1 ELSE 1 END RETURNING attempts`,
      [key, bucket],
    );
    return Number(r.rows[0].attempts) <= limit;
  }
  async all() {
    return (await this.pool.query("SELECT data FROM meetings")).rows.map(
      (r) => r.data,
    );
  }
  async change<T>(
    code: string,
    fn: (m: Meeting) => Promise<T> | T,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      return await this.changeWithClient(c, code, fn);
    } finally {
      c.release();
    }
  }
  private async changeWithClient<T>(
    c: pg.PoolClient,
    code: string,
    fn: (m: Meeting) => Promise<T> | T,
  ): Promise<T> {
    try {
      await c.query("BEGIN");
      const m = (
        await c.query("SELECT data FROM meetings WHERE code=$1 FOR UPDATE", [
          code,
        ])
      ).rows[0]?.data as Meeting | undefined;
      if (!m) throw new HttpError(404, "Meeting unavailable");
      const result = await fn(m);
      m.revision++;
      await c.query("UPDATE meetings SET data=$2 WHERE code=$1", [
        code,
        JSON.stringify(m),
      ]);
      await c.query("COMMIT");
      return result;
    } catch (error) {
      await c.query("ROLLBACK").catch(() => {});
      throw error;
    }
  }
  async withRecordingLock<T>(
    code: string,
    id: string,
    fn: (lock: RecordingLock) => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }> {
    const c = await this.pool.connect();
    const key = JSON.stringify(["recording", code, id]);
    let acquired = false;
    let lost = false;
    let active = true;
    const onError = () => {
      lost = true;
    };
    c.on("error", onError);
    const check = async () => {
      if (lost || !active)
        throw new Error("Recording ownership connection lost");
      await c.query("SELECT 1");
    };
    try {
      acquired = (
        await c.query(
          "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
          [key],
        )
      ).rows[0].acquired;
      if (!acquired) return { acquired: false };
      const value = await fn({
        check,
        get: async () => {
          await check();
          return (
            (await c.query("SELECT data FROM meetings WHERE code=$1", [code]))
              .rows[0]?.data ?? null
          );
        },
        change: async (change) => {
          await check();
          return this.changeWithClient(c, code, change);
        },
        audit: async (actor, action, target) => {
          await check();
          await c.query(
            "INSERT INTO audit_events(meeting_code,actor,action,target) VALUES($1,$2,$3,$4)",
            [code, actor, action, target],
          );
        },
      });
      await check();
      return { acquired: true, value };
    } finally {
      active = false;
      // A broken session must never return to the pool with an advisory lock.
      if (acquired && !lost) {
        try {
          await c.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
            key,
          ]);
        } catch {
          lost = true;
        }
      }
      c.removeListener("error", onError);
      c.release(lost);
    }
  }
  async audit(code: string, actor: string, action: string, target?: string) {
    await this.pool.query(
      "INSERT INTO audit_events(meeting_code,actor,action,target) VALUES($1,$2,$3,$4)",
      [code, actor, action, target],
    );
  }
  async close() {
    await this.pool.end();
  }
}
// Test adapter only; production always uses PostgreSQL transactions.
export class MemoryStore implements Store {
  phoneDialogs = new Map<string, PhoneDialog>();
  phoneCalls = new Map<
    string,
    { code: string; participantId: string; released: boolean }
  >();
  phoneAttempts = new Map<string, { bucket: number; attempts: number }>();
  settings: any = null;
  assets = new Map<string, { mime: string; data: string }>();
  private recordingLocks = new Set<string>();
  async withRecordingLock<T>(
    code: string,
    id: string,
    fn: (lock: RecordingLock) => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }> {
    const key = JSON.stringify([code, id]);
    if (this.recordingLocks.has(key)) return { acquired: false };
    this.recordingLocks.add(key);
    let active = true;
    const check = async () => {
      if (!active) throw new Error("Recording ownership connection lost");
    };
    try {
      const value = await fn({
        check,
        get: async () => {
          await check();
          return this.get(code);
        },
        change: async (change) => {
          await check();
          return this.change(code, change);
        },
        audit: async (actor, action, target) => {
          await check();
          await (this as Store).audit(code, actor, action, target);
        },
      });
      return { acquired: true, value };
    } finally {
      active = false;
      this.recordingLocks.delete(key);
    }
  }
  async getSettings() {
    return structuredClone(this.settings);
  }
  async setSettings(v: any) {
    this.settings = structuredClone(v);
  }
  async getAsset(id: string) {
    return this.assets.get(id) ?? null;
  }
  async setAsset(id: string, mime: string, data: string) {
    this.assets.set(id, { mime, data });
  }
  data = new Map<string, Meeting>();
  private chain = Promise.resolve();
  async create(m: Meeting) {
    if (this.data.has(m.code)) throw new Error("duplicate");
    this.data.set(m.code, structuredClone(m));
  }
  async get(code: string) {
    return structuredClone(this.data.get(code) ?? null);
  }
  async byRoom(room: string) {
    return structuredClone(
      [...this.data.values()].find((m) => m.room === room) ?? null,
    );
  }
  async byPhoneLocator(locator: string) {
    return structuredClone(
      [...this.data.values()].find((m) => m.phoneAccess?.locator === locator) ??
        null,
    );
  }
  async reservePhone<T>(
    code: string,
    callId: string,
    participantId: string,
    limit: number,
    fn: (m: Meeting) => T,
    ownerId?: string,
  ): Promise<T> {
    return this.change(code, (m) => {
      const dialog = structuredClone(this.phoneDialogs.get(callId));
      requirePhoneJoin(dialog, ownerId);
      if (this.phoneCalls.has(callId))
        throw new HttpError(409, "Call identity has already been used");
      if (this.phoneCapacity() >= limit && !dialog)
        throw new HttpError(409, "Phone capacity is full");
      const result = fn(m);
      if (dialog) {
        dialog.binding = { code, participantId };
        bumpPhoneDialog(dialog);
        this.phoneDialogs.set(callId, dialog);
      }
      this.phoneCalls.set(callId, { code, participantId, released: false });
      return result;
    });
  }
  async releasePhone(callId: string, code: string, participantId: string) {
    const call = this.phoneCalls.get(callId);
    if (
      !this.phoneDialogs.has(callId) &&
      call?.code === code &&
      call.participantId === participantId
    )
      call.released = true;
  }
  private phoneCapacity() {
    return new Set([
      ...[...this.phoneCalls]
        .filter(([, call]) => !call.released)
        .map(([id]) => id),
      ...[...this.phoneDialogs]
        .filter(([, dialog]) => dialog.state !== "closed")
        .map(([id]) => id),
    ]).size;
  }
  async createPhoneDialog(
    input: PhoneDialogInput,
    limit: number,
  ): Promise<PhoneDialog> {
    const created = newPhoneDialog(input);
    return this.serialize(async () => {
      const previous = this.phoneDialogs.get(input.callId);
      if (previous) {
        if (!samePhoneDialog(previous, input) || previous.state === "closed")
          throw new HttpError(
            409,
            "Phone dialog identity has already been used",
          );
        return structuredClone(previous);
      }
      if (
        this.phoneCalls.has(input.callId) ||
        [...this.phoneDialogs.values()].some(
          (dialog) =>
            dialog.pbxId === input.pbxId &&
            dialog.pbxEpoch === input.pbxEpoch &&
            dialog.callerChannelId === input.callerChannelId,
        )
      )
        throw new HttpError(409, "Phone dialog identity has already been used");
      if (this.phoneCapacity() >= limit)
        throw new HttpError(409, "Phone capacity is full");
      this.phoneDialogs.set(input.callId, created);
      return structuredClone(created);
    });
  }
  async queryPhoneDialogs(query: PhoneDialogQuery): Promise<PhoneDialog[]> {
    const dialogs = [...this.phoneDialogs.values()].filter((dialog) =>
      "callId" in query
        ? dialog.callId === query.callId
        : dialog.pbxId === query.pbxId && dialog.state !== "closed",
    );
    if (dialogs.length > 100)
      throw new HttpError(409, "Phone dialog query limit exceeded");
    return structuredClone(dialogs);
  }
  private ownedPhoneDialog(callId: string, ownerId: string, revision: number) {
    const dialog = structuredClone(this.phoneDialogs.get(callId));
    if (!dialog) throw new HttpError(404, "Phone dialog unavailable");
    ownPhoneDialog(dialog, ownerId, revision);
    return dialog;
  }
  async changePhoneDialog(
    callId: string,
    ownerId: string,
    revision: number,
    change: PhoneDialogChange,
  ): Promise<PhoneDialog> {
    return this.serialize(async () => {
      const dialog = this.ownedPhoneDialog(callId, ownerId, revision);
      editPhoneDialog(dialog, change);
      this.phoneDialogs.set(callId, dialog);
      return structuredClone(dialog);
    });
  }
  async stopPhoneDialog(
    callId: string,
    ownerId: string,
    revision: number,
  ): Promise<PhoneDialogStop> {
    return this.serialize(async () => {
      const dialog = this.ownedPhoneDialog(callId, ownerId, revision);
      if (dialog.state === "closed") return { dialog };
      const meeting = dialog.binding
        ? ((await this.get(dialog.binding.code)) ?? undefined)
        : undefined;
      const participant = stopPhoneParticipant(dialog, meeting);
      if (dialog.state === "open") {
        dialog.state = "stopping";
        bumpPhoneDialog(dialog);
        this.phoneDialogs.set(callId, structuredClone(dialog));
        if (meeting) {
          meeting.revision++;
          this.data.set(meeting.code, structuredClone(meeting));
        }
      }
      return { dialog, meeting, participant };
    });
  }
  async finishPhoneDialog(
    callId: string,
    ownerId: string,
    revision: number,
    proof: PhoneCleanupProof,
  ): Promise<PhoneDialog> {
    return this.serialize(async () => {
      const dialog = this.ownedPhoneDialog(callId, ownerId, revision);
      canFinishPhoneDialog(dialog, proof);
      const meeting = dialog.binding
        ? ((await this.get(dialog.binding.code)) ?? undefined)
        : undefined;
      finishedPhoneParticipant(dialog, meeting);
      const call = this.phoneCalls.get(callId);
      if (dialog.binding) {
        if (
          !call ||
          call.code !== dialog.binding.code ||
          call.participantId !== dialog.binding.participantId
        )
          throw new HttpError(409, "Phone reservation binding unavailable");
      }
      dialog.state = "closed";
      bumpPhoneDialog(dialog);
      if (dialog.binding) call!.released = true;
      this.phoneDialogs.set(callId, dialog);
      return structuredClone(dialog);
    });
  }
  async phoneAttempt(key: string, limit: number, now: number) {
    const bucket = Math.floor(now / 60000);
    for (const [stored, value] of this.phoneAttempts)
      if (value.bucket < bucket - 2) this.phoneAttempts.delete(stored);
    const old = this.phoneAttempts.get(key);
    const value = {
      bucket,
      attempts: old?.bucket === bucket ? old.attempts + 1 : 1,
    };
    this.phoneAttempts.set(key, value);
    return value.attempts <= limit;
  }
  async all() {
    return structuredClone([...this.data.values()]);
  }
  async change<T>(
    code: string,
    fn: (m: Meeting) => Promise<T> | T,
  ): Promise<T> {
    return this.serialize(async () => {
      const m = await this.get(code);
      if (!m) throw new HttpError(404, "Meeting unavailable");
      const r = await fn(m);
      m.revision++;
      this.data.set(code, m);
      return r;
    });
  }
  private async serialize<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const prev = this.chain;
    this.chain = new Promise<void>((r) => (release = r));
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }
  async audit() {}
  async close() {}
}
