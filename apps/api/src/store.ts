import pg from "pg";
import { HttpError } from "./security.js";
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
export interface Store {
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
  ): Promise<T>;
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
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      // All API instances serialize installation-wide reservations on this lock.
      await c.query("SELECT pg_advisory_xact_lock(704621938)");
      if (
        (await c.query("SELECT 1 FROM phone_calls WHERE call_id=$1", [callId]))
          .rowCount
      )
        throw new HttpError(409, "Call identity has already been used");
      if (
        Number(
          (
            await c.query(
              "SELECT count(*) AS count FROM phone_calls WHERE released=false",
            )
          ).rows[0].count,
        ) >= limit
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
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async releasePhone(callId: string, code: string, participantId: string) {
    await this.pool.query(
      "UPDATE phone_calls SET released=true WHERE call_id=$1 AND meeting_code=$2 AND participant_id=$3",
      [callId, code, participantId],
    );
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
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
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
  phoneCalls = new Map<
    string,
    { code: string; participantId: string; released: boolean }
  >();
  phoneAttempts = new Map<string, { bucket: number; attempts: number }>();
  settings: any = null;
  assets = new Map<string, { mime: string; data: string }>();
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
  ): Promise<T> {
    return this.change(code, (m) => {
      if (this.phoneCalls.has(callId))
        throw new HttpError(409, "Call identity has already been used");
      if (
        [...this.phoneCalls.values()].filter((c) => !c.released).length >= limit
      )
        throw new HttpError(409, "Phone capacity is full");
      const result = fn(m);
      this.phoneCalls.set(callId, { code, participantId, released: false });
      return result;
    });
  }
  async releasePhone(callId: string, code: string, participantId: string) {
    const call = this.phoneCalls.get(callId);
    if (call?.code === code && call.participantId === participantId)
      call.released = true;
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
    let release!: () => void;
    const prev = this.chain;
    this.chain = new Promise<void>((r) => (release = r));
    await prev;
    try {
      const m = await this.get(code);
      if (!m) throw new HttpError(404, "Meeting unavailable");
      const r = await fn(m);
      m.revision++;
      this.data.set(code, m);
      return r;
    } finally {
      release();
    }
  }
  async audit() {}
  async close() {}
}
