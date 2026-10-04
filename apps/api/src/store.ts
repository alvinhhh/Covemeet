import pg from "pg";
import { HttpError } from "./security.js";
export type Participant = {
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
  bans: { ip: string[]; device: string[] };
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
