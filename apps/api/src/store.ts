import pg from "pg";
import { HttpError } from "./security.js";
import {
  applyEntitlement,
  entitlementFor,
  entitlementSchema,
  nextEntitlement,
  requireEntitlement,
  startMeetingReservation,
  type HostedEntitlement,
  type MeetingEntitlement,
} from "./meeting-limits.js";
import {
  bumpPhoneDialog,
  canFinishPhoneDialog,
  editPhoneDialog,
  newPhoneDialog,
  ownPhoneDialog,
  ownPhoneSupervisor,
  phoneSupervisorInputSchema,
  type PhoneSupervisor,
  type PhoneSupervisorInput,
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
    cleanupTokenHash?: string;
    closed?: boolean;
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
  hosted?: {
    accountId: string;
    billingOwnerId?: string;
    entitlement?: MeetingEntitlement;
    version: number;
    operationId?: string;
    requestHash?: string;
    revoked?: boolean;
    cleanupConfirmed?: boolean;
  };
  limits?: { participants: number; durationSeconds: number };
  lifecycle?: {
    startedAt: number;
    deadlineAt?: number;
    cleanupConfirmed?: boolean;
  };
  cleanupPending?: boolean;
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
  createHosted(m: Meeting): Promise<Meeting>;
  setHostedEntitlement(input: HostedEntitlement): Promise<HostedEntitlement>;
  startMeeting<T>(code: string, fn: (m: Meeting) => Promise<T> | T): Promise<T>;
  setHostedAuthority(
    input: HostedAuthority & { legacyCodes?: string[] },
  ): Promise<{
    authority: HostedAuthority;
    meetings: Meeting[];
  }>;
  hasPhoneReservations(code: string): Promise<boolean>;
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
  claimPhoneSupervisor(input: PhoneSupervisorInput): Promise<PhoneSupervisor>;
  getPhoneSupervisor(pbxId: string): Promise<PhoneSupervisor | undefined>;
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

export type HostedAuthority = {
  accountId: string;
  billingOwnerId?: string;
  version: number;
  enabled: boolean;
};

function reusableHostedMeeting(existing: Meeting, incoming: Meeting) {
  if (
    existing.hosted?.requestHash !== incoming.hosted?.requestHash ||
    existing.hosted?.version !== incoming.hosted?.version
  )
    throw new HttpError(
      409,
      "Meeting operation already has different settings",
    );
  if (
    existing.ended ||
    !existing.hostTokenHash ||
    existing.hostTokenExpiresAt <= Date.now()
  )
    throw new HttpError(
      409,
      "Meeting invitation is no longer available",
      "MEETING_OPERATION_UNAVAILABLE",
    );
  return existing;
}

function nextHostedAuthority(
  current: HostedAuthority | undefined,
  input: HostedAuthority,
) {
  if (current?.version === input.version) {
    if (
      current.enabled !== input.enabled ||
      (current.billingOwnerId &&
        input.billingOwnerId &&
        current.billingOwnerId !== input.billingOwnerId)
    )
      throw new HttpError(409, "Hosting authority version conflicts");
    // One initial binding upgrade is allowed; it never adopts existing unbound meetings.
    return {
      ...current,
      ...(input.billingOwnerId ? { billingOwnerId: input.billingOwnerId } : {}),
    };
  }
  return !current || input.version > current.version
    ? {
        accountId: input.accountId,
        version: input.version,
        enabled: input.enabled,
        ...((input.billingOwnerId ?? current?.billingOwnerId)
          ? { billingOwnerId: input.billingOwnerId ?? current?.billingOwnerId }
          : {}),
      }
    : current;
}

function revokeHostedMeeting(m: Meeting) {
  if (m.hosted!.revoked) return false;
  m.hosted!.revoked = true;
  m.cleanupPending = true;
  m.ended = true;
  m.locked = true;
  m.recordingAllowed = false;
  if (m.phoneAccess) m.phoneAccess.enabled = false;
  delete m.hostTokenHash;
  delete m.emailOtpHash;
  for (const p of m.participants) {
    // The gateway still needs a teardown credential; this never authenticates a cookie.
    if (p.phone) {
      p.phone.cleanupTokenHash = p.tokenHash;
      p.phone.leaseExpiresAt = 0;
    }
    p.tokenHash = "";
    p.status = "left";
    p.previousRoom ??= participantRoom(m, p);
    p.mediaVersion++;
    p.enforcementPending = true;
  }
  for (const r of m.recordings) {
    if (["starting", "recording", "stopping"].includes(r.status))
      r.status = "stopping";
    delete r.tokenHash;
    delete r.passwordHash;
    delete r.expiresAt;
  }
  m.revision++;
  return true;
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
  participant.phone.closed = true;
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
      CREATE TABLE IF NOT EXISTS phone_supervisors(pbx_id text PRIMARY KEY, data jsonb NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS phone_dialogs_caller ON phone_dialogs ((data->>'pbxId'), (data->>'pbxEpoch'), (data->>'callerChannelId'));
      CREATE TABLE IF NOT EXISTS phone_attempts(key text PRIMARY KEY, bucket bigint NOT NULL, attempts integer NOT NULL);
      CREATE INDEX IF NOT EXISTS phone_attempts_bucket ON phone_attempts(bucket);`);
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS hosted_authorities(account_id uuid PRIMARY KEY, version bigint NOT NULL CHECK(version > 0), enabled boolean NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS meetings_hosted_operation ON meetings ((data->'hosted'->>'accountId'), (data->'hosted'->>'operationId')) WHERE data->'hosted'->>'operationId' IS NOT NULL;
      ALTER TABLE hosted_authorities ADD COLUMN IF NOT EXISTS billing_owner_id uuid;
      CREATE TABLE IF NOT EXISTS hosted_entitlements(billing_owner_id uuid PRIMARY KEY, data jsonb NOT NULL);
      CREATE INDEX IF NOT EXISTS meetings_billing_owner ON meetings ((data->'hosted'->>'billingOwnerId'));
      CREATE INDEX IF NOT EXISTS meetings_hosted_account ON meetings ((data->'hosted'->>'accountId'));
    `);
  }
  private async hostedTransaction<T>(
    accountId: string,
    fn: (c: pg.PoolClient) => Promise<T>,
    billingOwnerId?: string,
  ): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      if (billingOwnerId)
        await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          `hosting-pool:${billingOwnerId}`,
        ]);
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `hosted:${accountId}`,
      ]);
      const result = await fn(c);
      await c.query("COMMIT");
      return result;
    } catch (error) {
      await c.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      c.release();
    }
  }
  async setHostedEntitlement(raw: HostedEntitlement) {
    const input = entitlementSchema.parse(raw);
    return this.hostedTransaction(
      `pool:${input.billingOwnerId}`,
      async (c) => {
        const previous = (
          await c.query(
            "SELECT data FROM hosted_entitlements WHERE billing_owner_id=$1",
            [input.billingOwnerId],
          )
        ).rows[0]?.data as HostedEntitlement | undefined;
        const grant = nextEntitlement(previous, input);
        if (grant === previous) return grant;
        const meetings = (
          await c.query(
            "SELECT data FROM meetings WHERE data->'hosted'->>'billingOwnerId'=$1 ORDER BY code FOR UPDATE",
            [input.billingOwnerId],
          )
        ).rows.map((row) => row.data as Meeting);
        applyEntitlement(grant, meetings);
        await c.query(
          "INSERT INTO hosted_entitlements(billing_owner_id,data) VALUES($1,$2) ON CONFLICT(billing_owner_id) DO UPDATE SET data=$2",
          [input.billingOwnerId, JSON.stringify(grant)],
        );
        for (const m of meetings) {
          if (m.lifecycle?.cleanupConfirmed || m.hosted?.cleanupConfirmed)
            continue;
          m.revision++;
          await c.query("UPDATE meetings SET data=$2 WHERE code=$1", [
            m.code,
            JSON.stringify(m),
          ]);
        }
        return grant;
      },
      input.billingOwnerId,
    );
  }
  async createHosted(m: Meeting) {
    m = structuredClone(m);
    m.hosted!.accountId = m.hosted!.accountId.toLowerCase();
    m.hosted!.operationId = m.hosted!.operationId?.toLowerCase();
    m.hosted!.billingOwnerId = m.hosted!.billingOwnerId?.toLowerCase();
    const binding = m.hosted!;
    if (!binding.billingOwnerId)
      throw new HttpError(403, "Hosting plan is required");
    return this.hostedTransaction(
      binding.accountId,
      async (c) => {
        await c.query(
          "INSERT INTO hosted_authorities(account_id,version,enabled,billing_owner_id) VALUES($1,$2,true,$3) ON CONFLICT DO NOTHING",
          [binding.accountId, binding.version, binding.billingOwnerId],
        );
        const row = (
          await c.query(
            "SELECT version,enabled,billing_owner_id FROM hosted_authorities WHERE account_id=$1",
            [binding.accountId],
          )
        ).rows[0];
        if (
          !row.enabled ||
          Number(row.version) !== binding.version ||
          (row.billing_owner_id &&
            row.billing_owner_id !== binding.billingOwnerId)
        )
          throw new HttpError(409, "Hosting authority is not current");
        const grant = requireEntitlement(
          (
            await c.query(
              "SELECT data FROM hosted_entitlements WHERE billing_owner_id=$1",
              [binding.billingOwnerId],
            )
          ).rows[0]?.data,
          binding.accountId,
        );
        if (!row.billing_owner_id)
          await c.query(
            "UPDATE hosted_authorities SET billing_owner_id=$2 WHERE account_id=$1",
            [binding.accountId, binding.billingOwnerId],
          );
        const existing = (
          await c.query(
            "SELECT data FROM meetings WHERE data->'hosted'->>'accountId'=$1 AND data->'hosted'->>'operationId'=$2 FOR UPDATE",
            [binding.accountId, binding.operationId],
          )
        ).rows[0]?.data as Meeting | undefined;
        if (existing) return reusableHostedMeeting(existing, m);
        binding.entitlement = entitlementFor(grant, binding.accountId);
        await c.query("INSERT INTO meetings(code,room,data) VALUES($1,$2,$3)", [
          m.code,
          m.room,
          JSON.stringify(m),
        ]);
        await c.query(
          "INSERT INTO audit_events(meeting_code,actor,action,target) VALUES($1,$2,'meeting.create',$3)",
          [m.code, `hosted:${binding.accountId}`, `version:${binding.version}`],
        );
        return m;
      },
      binding.billingOwnerId,
    );
  }
  async startMeeting<T>(
    code: string,
    fn: (m: Meeting) => Promise<T> | T,
  ): Promise<T> {
    const snapshot = await this.get(code);
    if (!snapshot) throw new HttpError(404, "Meeting unavailable");
    if (!snapshot.hosted?.billingOwnerId)
      return this.change(code, async (m) => {
        const result = await fn(m);
        startMeetingReservation(m, []);
        return result;
      });
    const binding = snapshot.hosted;
    return this.hostedTransaction(
      binding.accountId,
      async (c) => {
        const m = (
          await c.query("SELECT data FROM meetings WHERE code=$1 FOR UPDATE", [
            code,
          ])
        ).rows[0]?.data as Meeting;
        if (!m || m.hosted?.billingOwnerId !== binding.billingOwnerId)
          throw new HttpError(409, "Meeting ownership changed");
        const result = await fn(m);
        const others = (
          await c.query(
            "SELECT data FROM meetings WHERE data->'hosted'->>'billingOwnerId'=$1 OR data->'hosted'->>'accountId'=$2",
            [binding.billingOwnerId, binding.accountId],
          )
        ).rows.map((row) => row.data as Meeting);
        startMeetingReservation(m, others);
        m.revision++;
        await c.query("UPDATE meetings SET data=$2 WHERE code=$1", [
          code,
          JSON.stringify(m),
        ]);
        return result;
      },
      binding.billingOwnerId,
    );
  }
  async setHostedAuthority(
    input: HostedAuthority & { legacyCodes?: string[] },
  ) {
    input = {
      ...input,
      accountId: input.accountId.toLowerCase(),
      ...(input.billingOwnerId
        ? { billingOwnerId: input.billingOwnerId.toLowerCase() }
        : {}),
    };
    return this.hostedTransaction(input.accountId, async (c) => {
      const row = (
        await c.query(
          "SELECT version,enabled,billing_owner_id FROM hosted_authorities WHERE account_id=$1",
          [input.accountId],
        )
      ).rows[0];
      const current = row
        ? {
            accountId: input.accountId,
            version: Number(row.version),
            enabled: row.enabled as boolean,
            ...(row.billing_owner_id
              ? { billingOwnerId: row.billing_owner_id }
              : {}),
          }
        : undefined;
      const authority = nextHostedAuthority(current, input);
      const rows = (
        await c.query(
          "SELECT data FROM meetings WHERE data->'hosted'->>'accountId'=$1 OR code=ANY($2::text[]) ORDER BY code FOR UPDATE",
          [input.accountId, input.legacyCodes ?? []],
        )
      ).rows.map((r) => r.data as Meeting);
      if (rows.some((m) => m.hosted && m.hosted.accountId !== input.accountId))
        throw new HttpError(409, "Legacy meeting belongs to another account");
      await c.query(
        "INSERT INTO hosted_authorities(account_id,version,enabled,billing_owner_id) VALUES($1,$2,$3,$4) ON CONFLICT(account_id) DO UPDATE SET version=$2,enabled=$3,billing_owner_id=$4",
        [
          authority.accountId,
          authority.version,
          authority.enabled,
          authority.billingOwnerId ?? null,
        ],
      );
      const meetings: Meeting[] = [];
      for (const m of rows) {
        m.hosted ??= { accountId: input.accountId, version: 0 };
        if (
          (m.hosted.version < authority.version || !authority.enabled) &&
          revokeHostedMeeting(m)
        ) {
          await c.query("UPDATE meetings SET data=$2 WHERE code=$1", [
            m.code,
            JSON.stringify(m),
          ]);
          await c.query(
            "INSERT INTO audit_events(meeting_code,actor,action,target) VALUES($1,$2,'hosted.revoke',$3)",
            [
              m.code,
              `hosted:${input.accountId}`,
              `version:${authority.version}`,
            ],
          );
        }
        if (m.hosted.revoked && !m.hosted.cleanupConfirmed) meetings.push(m);
      }
      return { authority, meetings };
    });
  }
  async hasPhoneReservations(code: string) {
    return !!(
      await this.pool.query(
        "SELECT 1 FROM phone_calls WHERE meeting_code=$1 AND released=false UNION ALL SELECT 1 FROM phone_dialogs WHERE data->'binding'->>'code'=$1 AND data->>'state'<>'closed' LIMIT 1",
        [code],
      )
    ).rowCount;
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
      if (dialog)
        ownPhoneSupervisor(
          (
            await c.query(
              "SELECT data FROM phone_supervisors WHERE pbx_id=$1",
              [dialog.pbxId],
            )
          ).rows[0]?.data,
          dialog,
        );
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
    await this.phoneTransaction(async (c) => {
      const released = await c.query(
        "UPDATE phone_calls SET released=true WHERE call_id=$1 AND meeting_code=$2 AND participant_id=$3 AND NOT EXISTS (SELECT 1 FROM phone_dialogs WHERE call_id=$1) RETURNING call_id",
        [callId, code, participantId],
      );
      if (released.rowCount) {
        const m = (
          await c.query("SELECT data FROM meetings WHERE code=$1 FOR UPDATE", [
            code,
          ])
        ).rows[0]?.data as Meeting | undefined;
        const p = m?.participants.find((x) => x.id === participantId);
        if (p?.phone?.callId === callId) {
          p.phone.closed = true;
          m!.revision++;
          await c.query("UPDATE meetings SET data=$2 WHERE code=$1", [
            code,
            JSON.stringify(m),
          ]);
        }
      }
    });
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
  async getPhoneSupervisor(
    pbxId: string,
  ): Promise<PhoneSupervisor | undefined> {
    return (
      await this.pool.query(
        "SELECT data FROM phone_supervisors WHERE pbx_id=$1",
        [pbxId],
      )
    ).rows[0]?.data;
  }
  async claimPhoneSupervisor(
    raw: PhoneSupervisorInput,
  ): Promise<PhoneSupervisor> {
    const input = phoneSupervisorInputSchema.parse(raw);
    return this.phoneTransaction(async (c) => {
      const previous = (
        await c.query(
          "SELECT data FROM phone_supervisors WHERE pbx_id=$1 FOR UPDATE",
          [input.pbxId],
        )
      ).rows[0]?.data;
      if (previous) {
        ownPhoneSupervisor(previous, input);
        if (
          Boolean(previous.runtime) !== Boolean(input.runtime) ||
          (input.runtime &&
            Object.entries(input.runtime).some(
              ([key, value]) =>
                previous.runtime?.[key as keyof typeof input.runtime] !== value,
            ))
        )
          throw new HttpError(409, "Phone supervisor runtime changed");
        return previous;
      }
      if (
        (
          await c.query(
            "SELECT 1 FROM phone_dialogs WHERE data->>'pbxId'=$1 AND data->>'state'<>'closed'",
            [input.pbxId],
          )
        ).rowCount
      )
        throw new HttpError(409, "Phone dialogs require managed recovery");
      const claim: PhoneSupervisor = { ...input, state: "active", revision: 1 };
      await c.query(
        "INSERT INTO phone_supervisors(pbx_id,data) VALUES($1,$2)",
        [input.pbxId, JSON.stringify(claim)],
      );
      return claim;
    });
  }
  /** Management-plane only: never exposed through the phone gateway API. */
  async fencePhoneSupervisor(
    expected: PhoneSupervisor,
  ): Promise<PhoneSupervisor> {
    return this.phoneTransaction(async (c) => {
      const claim: PhoneSupervisor | undefined = (
        await c.query(
          "SELECT data FROM phone_supervisors WHERE pbx_id=$1 FOR UPDATE",
          [expected.pbxId],
        )
      ).rows[0]?.data;
      if (
        !claim ||
        claim.ownerId !== expected.ownerId ||
        claim.revision !== expected.revision
      )
        throw new HttpError(409, "Phone supervisor revision changed");
      if (claim.state !== "fencing") {
        claim.state = "fencing";
        claim.revision++;
      }
      await c.query("UPDATE phone_supervisors SET data=$2 WHERE pbx_id=$1", [
        claim.pbxId,
        JSON.stringify(claim),
      ]);
      return claim;
    });
  }
  /** Called only by the Docker manager after physical fencing and reconciliation. */
  async replacePhoneSupervisor(
    expected: PhoneSupervisor,
    raw: PhoneSupervisorInput,
  ): Promise<PhoneSupervisor> {
    const input = phoneSupervisorInputSchema.parse(raw);
    return this.phoneTransaction(async (c) => {
      const claim: PhoneSupervisor | undefined = (
        await c.query(
          "SELECT data FROM phone_supervisors WHERE pbx_id=$1 FOR UPDATE",
          [expected.pbxId],
        )
      ).rows[0]?.data;
      if (
        !claim ||
        claim.state !== "fencing" ||
        claim.ownerId !== expected.ownerId ||
        claim.revision !== expected.revision ||
        input.pbxId !== claim.pbxId ||
        input.ownerId === claim.ownerId ||
        input.pbxEpoch === claim.pbxEpoch
      )
        throw new HttpError(409, "Phone supervisor replacement unavailable");
      if (
        (
          await c.query(
            "SELECT 1 FROM phone_dialogs WHERE data->>'pbxId'=$1 AND data->>'state'<>'closed'",
            [claim.pbxId],
          )
        ).rowCount
      )
        throw new HttpError(409, "Phone dialogs remain unresolved");
      const next: PhoneSupervisor = {
        ...input,
        state: "active",
        revision: claim.revision + 1,
      };
      await c.query("UPDATE phone_supervisors SET data=$2 WHERE pbx_id=$1", [
        next.pbxId,
        JSON.stringify(next),
      ]);
      return next;
    });
  }
  async createPhoneDialog(
    input: PhoneDialogInput,
    limit: number,
  ): Promise<PhoneDialog> {
    const created = newPhoneDialog(input);
    return this.phoneTransaction(async (c) => {
      ownPhoneSupervisor(
        (
          await c.query("SELECT data FROM phone_supervisors WHERE pbx_id=$1", [
            input.pbxId,
          ])
        ).rows[0]?.data,
        input,
      );
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
      if (change.type === "begin" || change.type === "holding")
        ownPhoneSupervisor(
          (
            await c.query(
              "SELECT data FROM phone_supervisors WHERE pbx_id=$1",
              [dialog.pbxId],
            )
          ).rows[0]?.data,
          dialog,
        );
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
      if (meeting) {
        meeting.revision++;
        await c.query("UPDATE meetings SET data=$2 WHERE code=$1", [
          meeting.code,
          JSON.stringify(meeting),
        ]);
      }
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
  hostedAuthorities = new Map<string, HostedAuthority>();
  hostedEntitlements = new Map<string, HostedEntitlement>();
  async setHostedEntitlement(raw: HostedEntitlement) {
    const input = entitlementSchema.parse(raw);
    return this.serialize(async () => {
      const previous = this.hostedEntitlements.get(input.billingOwnerId);
      const grant = nextEntitlement(previous, input);
      if (grant !== previous) {
        const meetings = structuredClone([...this.data.values()]);
        applyEntitlement(grant, meetings);
        for (const m of meetings)
          if (m.hosted?.billingOwnerId === grant.billingOwnerId) {
            m.revision++;
            this.data.set(m.code, m);
          }
        this.hostedEntitlements.set(
          input.billingOwnerId,
          structuredClone(grant),
        );
      }
      return structuredClone(grant);
    });
  }
  async startMeeting<T>(
    code: string,
    fn: (m: Meeting) => Promise<T> | T,
  ): Promise<T> {
    return this.change(code, async (m) => {
      const result = await fn(m);
      startMeetingReservation(m, [...this.data.values()]);
      return result;
    });
  }
  async createHosted(m: Meeting) {
    m = structuredClone(m);
    m.hosted!.accountId = m.hosted!.accountId.toLowerCase();
    m.hosted!.operationId = m.hosted!.operationId?.toLowerCase();
    m.hosted!.billingOwnerId = m.hosted!.billingOwnerId?.toLowerCase();
    return this.serialize(async () => {
      const binding = m.hosted!;
      const authority = this.hostedAuthorities.get(binding.accountId);
      if (
        authority &&
        (!authority.enabled ||
          authority.version !== binding.version ||
          (authority.billingOwnerId &&
            authority.billingOwnerId !== binding.billingOwnerId))
      )
        throw new HttpError(409, "Hosting authority is not current");
      if (!binding.billingOwnerId)
        throw new HttpError(403, "Hosting plan is required");
      const grant = requireEntitlement(
        this.hostedEntitlements.get(binding.billingOwnerId),
        binding.accountId,
      );
      binding.entitlement = entitlementFor(grant, binding.accountId);
      const existing = [...this.data.values()].find(
        (row) =>
          row.hosted?.accountId === binding.accountId &&
          row.hosted.operationId === binding.operationId,
      );
      if (existing) return structuredClone(reusableHostedMeeting(existing, m));
      await this.create(m);
      this.hostedAuthorities.set(binding.accountId, {
        accountId: binding.accountId,
        version: binding.version,
        enabled: true,
        billingOwnerId: binding.billingOwnerId,
      });
      await this.audit(
        m.code,
        `hosted:${binding.accountId}`,
        "meeting.create",
        `version:${binding.version}`,
      );
      return structuredClone(m);
    });
  }
  async setHostedAuthority(
    input: HostedAuthority & { legacyCodes?: string[] },
  ) {
    input = {
      ...input,
      accountId: input.accountId.toLowerCase(),
      ...(input.billingOwnerId
        ? { billingOwnerId: input.billingOwnerId.toLowerCase() }
        : {}),
    };
    return this.serialize(async () => {
      const authority = nextHostedAuthority(
        this.hostedAuthorities.get(input.accountId),
        input,
      );
      const rows = structuredClone(
        [...this.data.values()].filter(
          (m) =>
            m.hosted?.accountId === input.accountId ||
            input.legacyCodes?.includes(m.code),
        ),
      );
      if (rows.some((m) => m.hosted && m.hosted.accountId !== input.accountId))
        throw new HttpError(409, "Legacy meeting belongs to another account");
      const meetings: Meeting[] = [];
      for (const m of rows) {
        m.hosted ??= { accountId: input.accountId, version: 0 };
        if (
          (m.hosted.version < authority.version || !authority.enabled) &&
          revokeHostedMeeting(m)
        ) {
          this.data.set(m.code, m);
          await this.audit(
            m.code,
            `hosted:${input.accountId}`,
            "hosted.revoke",
            `version:${authority.version}`,
          );
        }
        if (m.hosted.revoked && !m.hosted.cleanupConfirmed) meetings.push(m);
      }
      this.hostedAuthorities.set(input.accountId, structuredClone(authority));
      return { authority: structuredClone(authority), meetings };
    });
  }
  async hasPhoneReservations(code: string) {
    return (
      [...this.phoneCalls.values()].some(
        (call) => call.code === code && !call.released,
      ) ||
      [...this.phoneDialogs.values()].some(
        (dialog) => dialog.binding?.code === code && dialog.state !== "closed",
      )
    );
  }
  phoneSupervisors = new Map<string, PhoneSupervisor>();
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
      if (dialog)
        ownPhoneSupervisor(this.phoneSupervisors.get(dialog.pbxId), dialog);
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
    ) {
      call.released = true;
      const m = this.data.get(code);
      const p = m?.participants.find((x) => x.id === participantId);
      if (p?.phone?.callId === callId) {
        p.phone.closed = true;
        m!.revision++;
      }
    }
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
  async getPhoneSupervisor(pbxId: string) {
    return structuredClone(this.phoneSupervisors.get(pbxId));
  }
  async claimPhoneSupervisor(
    raw: PhoneSupervisorInput,
  ): Promise<PhoneSupervisor> {
    const input = phoneSupervisorInputSchema.parse(raw);
    return this.serialize(async () => {
      const previous = this.phoneSupervisors.get(input.pbxId);
      if (previous) {
        ownPhoneSupervisor(previous, input);
        if (
          Boolean(previous.runtime) !== Boolean(input.runtime) ||
          (input.runtime &&
            Object.entries(input.runtime).some(
              ([key, value]) =>
                previous.runtime?.[key as keyof typeof input.runtime] !== value,
            ))
        )
          throw new HttpError(409, "Phone supervisor runtime changed");
        return structuredClone(previous);
      }
      if (
        [...this.phoneDialogs.values()].some(
          (d) => d.pbxId === input.pbxId && d.state !== "closed",
        )
      )
        throw new HttpError(409, "Phone dialogs require managed recovery");
      const claim: PhoneSupervisor = { ...input, state: "active", revision: 1 };
      this.phoneSupervisors.set(input.pbxId, claim);
      return structuredClone(claim);
    });
  }
  async fencePhoneSupervisor(
    expected: PhoneSupervisor,
  ): Promise<PhoneSupervisor> {
    return this.serialize(async () => {
      const claim = this.phoneSupervisors.get(expected.pbxId);
      if (
        !claim ||
        claim.ownerId !== expected.ownerId ||
        claim.revision !== expected.revision
      )
        throw new HttpError(409, "Phone supervisor revision changed");
      if (claim.state !== "fencing") {
        claim.state = "fencing";
        claim.revision++;
      }
      return structuredClone(claim);
    });
  }
  async replacePhoneSupervisor(
    expected: PhoneSupervisor,
    raw: PhoneSupervisorInput,
  ): Promise<PhoneSupervisor> {
    const input = phoneSupervisorInputSchema.parse(raw);
    return this.serialize(async () => {
      const claim = this.phoneSupervisors.get(expected.pbxId);
      if (
        !claim ||
        claim.state !== "fencing" ||
        claim.ownerId !== expected.ownerId ||
        claim.revision !== expected.revision ||
        input.pbxId !== claim.pbxId ||
        input.ownerId === claim.ownerId ||
        input.pbxEpoch === claim.pbxEpoch
      )
        throw new HttpError(409, "Phone supervisor replacement unavailable");
      if (
        [...this.phoneDialogs.values()].some(
          (d) => d.pbxId === claim.pbxId && d.state !== "closed",
        )
      )
        throw new HttpError(409, "Phone dialogs remain unresolved");
      const next: PhoneSupervisor = {
        ...input,
        state: "active",
        revision: claim.revision + 1,
      };
      this.phoneSupervisors.set(input.pbxId, next);
      return structuredClone(next);
    });
  }
  async createPhoneDialog(
    input: PhoneDialogInput,
    limit: number,
  ): Promise<PhoneDialog> {
    const created = newPhoneDialog(input);
    return this.serialize(async () => {
      ownPhoneSupervisor(this.phoneSupervisors.get(input.pbxId), input);
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
      if (change.type === "begin" || change.type === "holding")
        ownPhoneSupervisor(this.phoneSupervisors.get(dialog.pbxId), dialog);
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
      if (meeting) {
        meeting.revision++;
        this.data.set(meeting.code, meeting);
      }
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
  auditEvents: {
    code: string;
    actor: string;
    action: string;
    target?: string;
  }[] = [];
  async audit(code: string, actor: string, action: string, target?: string) {
    this.auditEvents.push({ code, actor, action, target });
  }
  async close() {}
}
