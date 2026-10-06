import { fenceParticipantMedia } from "./media-identity.js";
import pg from "pg";
import {
  allocateRecordingStorage,
  prepareRecordingStorage,
  releaseRecordingStorage,
  removeRecordingStorage,
  reserveRecordingStorage,
  retainRecordingStorage,
  type RecordingStorage,
  type RecordingStorageAttempt,
  type RecordingStoragePlan,
  type RecordingStoragePrepared,
  type RecordingStorageProof,
  type RecordingStorageRelease,
} from "./recording-storage-quota.js";
import type { WrappedKey } from "@meeting-platform/recording";
export type {
  RecordingStorageAttempt,
  RecordingStoragePlan,
  RecordingStoragePrepared,
  RecordingStorageProof,
  RecordingStorageRelease,
} from "./recording-storage-quota.js";
import {
  canSettleMeter,
  checkRecordingTime,
  debitDownloadBytes,
  observeRecordingTime,
  quotaOverdrawn,
  requireUsage,
  reserveRecordingTime,
  settleMeter,
  setMetering,
  sweepParticipantMeters,
  sweepRecordingTimes,
  updateMeter,
  usageView,
  type MeterInput,
  type MeetingMeter,
  type ParticipantMeter,
  type RecordingTimeObservation,
  type RecordingTimeReservation,
  type UsageLedger,
} from "./participant-meter.js";
export type { RecordingTimeObservation } from "./participant-meter.js";
import { HttpError } from "./security.js";
import {
  authorizeWhiteboardWrite,
  WHITEBOARD_BYTE_LIMIT,
  WHITEBOARD_EVENT_LIMIT,
  WHITEBOARD_PAGE_SIZE,
  sameWhiteboardItem,
  whiteboardEventSize,
  type WhiteboardAccess,
  type WhiteboardEvent,
  type WhiteboardInput,
  type WhiteboardPage,
} from "./whiteboard.js";
import {
  applyEntitlement,
  endMeeting,
  entitlementFor,
  entitlementSchema,
  meetingAllowed,
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
  meter?: ParticipantMeter;
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
  moderator?: { grantedBy: string; grantedAt: number; revision: number };
  auditReferenced?: boolean;
  audioAllowed: boolean;
  videoAllowed: boolean;
  mediaVersion: number;
  mediaIdentity?: string;
  previousMediaIdentity?: string;
  gatewayConnectionId?: string;
  gatewayPresenceUntil?: number;
  tokenHash: string;
  expiresAt: number;
  ipHash: string;
  deviceHash: string;
  breakoutId: string | null;
  enforcementPending?: boolean;
  previousRoom?: string;
};
export type Recording = {
  storage?: RecordingStorage;
  timeReservation?: RecordingTimeReservation;
  rawCleanupPending?: boolean;
  id: string;
  status: string;
  createdAt: number;
  egressId?: string;
  ciphertextId?: string;
  metadata?: any;
  tokenHash?: string;
  passwordHash?: string;
  expiresAt?: number;
  linkGeneration?: number;
  readyAt?: number;
  autoLinkPending?: boolean;
  delivery?: {
    id: string;
    mode: "auto" | "manual";
    recipient: string;
    messageId: string;
    token: { bindingId: string; wrappedKey: WrappedKey };
    password?: { bindingId: string; wrappedKey: WrappedKey };
    attempts: number;
    nextAttemptAt: number;
    sentAt?: number;
  };
  error?: string;
};
export type ChatMessage = {
  id: string;
  sequence?: number;
  senderId?: string;
  name: string;
  text: string;
  createdAt: number;
  breakoutId: string | null;
  broadcast?: boolean;
  recipientId?: string;
  deleted?: boolean;
};
export function clearRecordingLink(r: Recording) {
  r.linkGeneration = (r.linkGeneration ?? 0) + 1;
  delete r.tokenHash;
  delete r.passwordHash;
  delete r.expiresAt;
  delete r.delivery;
  r.autoLinkPending = false;
}
export type RecordingIdentity =
  | { email: string }
  | { accountId: string; version: number; billingOwnerId: string };
export type Meeting = {
  hostControl?: {
    revision: number;
    graceSeconds: number;
    lastSeenAt: number;
    absentSince?: number;
    handoff?: {
      requestId: string;
      participantId: string;
      grantRevision: number;
      ownerSessionHash: string;
      ownerMediaVersion: number;
    };
  };
  recordingAccess?: {
    identity: RecordingIdentity;
    ticket?: { hash: string; expiresAt: number };
    session?: { hash: string; expiresAt: number };
  };
  recordingRecoveryRequestedAt?: number;
  recordingRecovery?: {
    email: string;
    challengeHash: string;
    otpHash: string;
    expiresAt: number;
    attempts: number;
  };
  meetingMeter?: MeetingMeter;
  hostReentryRevision?: number;
  hostReentry?: {
    requestId: string;
    phase: "issued" | "fenced" | "consumed";
  };
  hosted?: {
    accountId: string;
    billingOwnerId?: string;
    brandingProfileId?: string;
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
  chatMode?: "everyone" | "host-only" | "disabled";
  createdAt: number;
  revision: number;
  passwordHash: string;
  hostTokenHash?: string;
  hostTokenExpiresAt: number;
  participants: Participant[];
  bans: { ip: string[]; device: string[]; caller?: string[] };
  breakouts: { id: string; name: string; room: string }[];
  messages: ChatMessage[];
  privateMessages?: ChatMessage[];
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
  reserveRecording(
    recording: Recording,
    authorize: (current: Meeting) => void,
    storagePlan?: RecordingStoragePlan,
  ): Promise<Recording>;
  reserveRecordingStorage(
    kind: "local" | "s3",
  ): Promise<RecordingStorageAttempt>;
  prepareRecordingStorage(
    id: string,
    prepared: RecordingStoragePrepared,
  ): Promise<RecordingStorageAttempt>;
  retainRecordingStorage(
    id: string,
    proof: RecordingStorageProof,
  ): Promise<RecordingStorageAttempt>;
  removeRecordingStorage(id: string): Promise<RecordingStorageAttempt>;
  releaseRecordingStorage(
    id: string,
    proof: RecordingStorageRelease,
  ): Promise<RecordingStorageAttempt>;
  checkRecordingTime(): Promise<{ recording: Recording; mustStop: boolean }>;
  observeRecordingTime(
    observation: RecordingTimeObservation,
  ): Promise<{ recording: Recording; mustStop: boolean }>;
}
type RecordingUsageChange<T> = (
  ledger: UsageLedger | undefined,
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
  meeting: Meeting,
  now: number,
) => T;
function recordingTimeMethods(
  id: string,
  transaction: <T>(
    change: RecordingUsageChange<T>,
    authorize?: (m: Meeting) => void,
  ) => Promise<T>,
) {
  const current = (m: Meeting) => {
    const r = m.recordings.find((row) => row.id === id);
    if (!r) throw new HttpError(404, "Recording unavailable");
    return r;
  };
  return {
    reserveRecording: (
      recording: Recording,
      authorize: (m: Meeting) => void,
      storagePlan?: RecordingStoragePlan,
    ) =>
      transaction((ledger, grant, meetings, m, now) => {
        authorize(m);
        if (
          recording.id !== id ||
          recording.status !== "starting" ||
          recording.timeReservation ||
          recording.storage ||
          m.recordings.some((r) => r.id === id)
        )
          throw new HttpError(409, "Recording reservation changed");
        const r = structuredClone(recording);
        if (m.hosted?.billingOwnerId) {
          if (!ledger)
            throw new HttpError(404, "Usage unavailable", "USAGE_UNAVAILABLE");
          reserveRecordingTime(ledger, grant, meetings, m, r, now);
          reserveRecordingStorage(grant, meetings, m, r, storagePlan);
        }
        m.recordings.push(r);
        return structuredClone(r);
      }, authorize),
    reserveRecordingStorage: (kind: "local" | "s3") =>
      transaction((_ledger, grant, meetings, m) =>
        structuredClone(
          allocateRecordingStorage(grant, meetings, m, current(m), kind),
        ),
      ),
    prepareRecordingStorage: (
      attemptId: string,
      prepared: RecordingStoragePrepared,
    ) =>
      transaction((_ledger, _grant, _meetings, m) =>
        structuredClone(
          prepareRecordingStorage(m, current(m), attemptId, prepared),
        ),
      ),
    retainRecordingStorage: (attemptId: string, proof: RecordingStorageProof) =>
      transaction((_ledger, _grant, _meetings, m) =>
        structuredClone(
          retainRecordingStorage(m, current(m), attemptId, proof),
        ),
      ),
    removeRecordingStorage: (attemptId: string) =>
      transaction((_ledger, _grant, _meetings, m) =>
        structuredClone(removeRecordingStorage(m, current(m), attemptId)),
      ),
    releaseRecordingStorage: (
      attemptId: string,
      proof: RecordingStorageRelease,
    ) =>
      transaction((_ledger, _grant, _meetings, m) =>
        structuredClone(
          releaseRecordingStorage(m, current(m), attemptId, proof),
        ),
      ),
    checkRecordingTime: () =>
      transaction((ledger, grant, meetings, m, now) => {
        const r = current(m);
        const mustStop = checkRecordingTime(ledger, grant, meetings, m, r, now);
        return { recording: structuredClone(r), mustStop };
      }),
    observeRecordingTime: (input: RecordingTimeObservation) =>
      transaction((ledger, grant, meetings, m, now) => {
        const r = current(m);
        const mustStop = observeRecordingTime(
          ledger,
          grant,
          meetings,
          m,
          r,
          input,
          now,
        );
        return { recording: structuredClone(r), mustStop };
      }),
  };
}
export interface Store {
  hostedUsage(billingOwnerId: string): Promise<ReturnType<typeof usageView>>;
  debitRecordingDownload(
    code: string,
    plaintextBytes: number,
    authorize: (current: Meeting) => void,
  ): Promise<void>;
  checkUsage(code: string, participantId?: string): Promise<void>;
  updateParticipantMeter(
    code: string,
    input: MeterInput,
  ): Promise<{ meeting: Meeting; participant: Participant }>;
  settleParticipantMeter(
    code: string,
    participantId: string,
    mediaVersion: number,
    expected?: Pick<ParticipantMeter, "connectionId" | "mediaVersion">,
  ): Promise<void>;
  reconcileParticipantMeters(code: string): Promise<void>;
  createHosted(m: Meeting): Promise<Meeting>;
  withHostedReentry<T>(code: string, change: (m: Meeting) => T): Promise<T>;
  withHostedRecordingAccess<T>(
    code: string,
    change: (m: Meeting) => T,
  ): Promise<T>;
  setHostedEntitlement(input: HostedEntitlement): Promise<HostedEntitlement>;
  startMeeting<T>(
    code: string,
    fn: (m: Meeting) => Promise<T> | T,
    freeRoomLimit?: number,
  ): Promise<T>;
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
  hostedMeetings(accountId: string): Promise<Meeting[]>;
  hostedOperations(
    accountId: string,
    operationIds: string[],
  ): Promise<Meeting[]>;
  byRoom(room: string): Promise<Meeting | null>;
  all(): Promise<Meeting[]>;
  change<T>(code: string, fn: (m: Meeting) => Promise<T> | T): Promise<T>;
  readWhiteboard(
    code: string,
    after: number,
    authorize: (m: Meeting) => WhiteboardAccess,
  ): Promise<WhiteboardPage>;
  writeWhiteboard(
    code: string,
    input: WhiteboardInput,
    authorize: (m: Meeting) => WhiteboardAccess,
  ): Promise<WhiteboardEvent>;
  purgeWhiteboard(code: string): Promise<void>;
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

function requireCurrentHostedRecordingAccess(
  m: Meeting,
  authority: HostedAuthority | undefined,
) {
  const binding = m.hosted;
  if (
    !binding?.billingOwnerId ||
    binding.revoked ||
    !authority?.enabled ||
    authority.accountId !== binding.accountId ||
    authority.version !== binding.version ||
    authority.billingOwnerId !== binding.billingOwnerId
  )
    throw new HttpError(403, "Recording access is unavailable");
}

function requireCurrentHostedReentry(
  m: Meeting,
  authority: HostedAuthority | undefined,
  grant: HostedEntitlement | undefined,
) {
  const binding = m.hosted;
  if (
    !binding?.billingOwnerId ||
    !authority?.enabled ||
    authority.accountId !== binding.accountId ||
    authority.version !== binding.version ||
    authority.billingOwnerId !== binding.billingOwnerId ||
    m.lifecycle?.cleanupConfirmed ||
    binding.revoked ||
    binding.cleanupConfirmed ||
    m.cleanupPending ||
    !meetingAllowed(m) ||
    !m.participants.some(
      (p) =>
        p.role === "host" &&
        (m.lifecycle
          ? p.status === "admitted" || p.status === "left"
          : p.status === "waiting" || p.status === "left"),
    ) ||
    (!m.lifecycle &&
      m.hostReentry !== undefined &&
      m.hostReentry.phase !== "issued") ||
    (m.lifecycle && !m.hostReentry && !!m.hostTokenHash)
  )
    throw new HttpError(409, "Host re-entry is unavailable");
  const currentGrant = requireEntitlement(grant, binding.accountId);
  if (binding.entitlement?.revision !== currentGrant.revision)
    throw new HttpError(409, "Hosting grant changed");
}

function reusableHostedMeeting(existing: Meeting, incoming: Meeting) {
  if (
    existing.hosted?.requestHash !== incoming.hosted?.requestHash ||
    existing.hosted?.brandingProfileId !== incoming.hosted?.brandingProfileId ||
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
  delete m.recordingAccess;
  delete m.recordingRecovery;
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
    fenceParticipantMedia(m, p);
  }
  for (const r of m.recordings) {
    if (["starting", "recording", "stopping"].includes(r.status))
      r.status = "stopping";
    clearRecordingLink(r);
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
    fenceParticipantMedia(meeting!, participant);
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
  constructor(url: string, transport: { tls?: boolean; ca?: string } = {}) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid database URL");
    }
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname ||
      parsed.pathname.length < 2
    )
      throw new Error("Invalid database URL");
    if (
      [...parsed.searchParams].some(
        ([name, value]) => name !== "sslmode" || value !== "verify-full",
      )
    )
      throw new Error("Database URL options may not override verified TLS");
    if (transport.ca !== undefined && !transport.ca.trim())
      throw new Error("Database CA must not be empty");
    const ssl =
      transport.tls ||
      transport.ca !== undefined ||
      parsed.searchParams.has("sslmode")
        ? {
            rejectUnauthorized: true,
            minVersion: "TLSv1.2" as const,
            ...(transport.ca ? { ca: transport.ca } : {}),
          }
        : false;
    // pg connection-string SSL options otherwise replace this explicit object.
    parsed.search = "";
    this.pool = new pg.Pool({
      connectionString: parsed.toString(),
      ssl,
      max: 10,
      connectionTimeoutMillis: 5000,
    });
    // Idle driver errors may contain connection details; active operations fail
    // through their own promise without exposing those details in a pool log.
    this.pool.on("error", () => {});
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
      CREATE TABLE IF NOT EXISTS hosted_usage(billing_owner_id uuid PRIMARY KEY, data jsonb NOT NULL);
      CREATE INDEX IF NOT EXISTS meetings_billing_owner ON meetings ((data->'hosted'->>'billingOwnerId'));
      CREATE INDEX IF NOT EXISTS meetings_hosted_account ON meetings ((data->'hosted'->>'accountId'));
      CREATE TABLE IF NOT EXISTS whiteboards(
        meeting_code text NOT NULL REFERENCES meetings(code),
        scope text NOT NULL,
        seq bigint NOT NULL DEFAULT 0,
        epoch bigint NOT NULL DEFAULT 0,
        read_only boolean NOT NULL DEFAULT false,
        event_count integer NOT NULL DEFAULT 0,
        bytes_used integer NOT NULL DEFAULT 0,
        PRIMARY KEY(meeting_code,scope)
      );
      CREATE TABLE IF NOT EXISTS whiteboard_events(
        meeting_code text NOT NULL,
        scope text NOT NULL,
        seq bigint NOT NULL,
        event jsonb NOT NULL,
        PRIMARY KEY(meeting_code,scope,seq),
        FOREIGN KEY(meeting_code,scope) REFERENCES whiteboards(meeting_code,scope)
      );
    `);
  }
  private async usageTransaction<T>(
    billingOwnerId: string,
    fn: (
      ledger: UsageLedger,
      grant: HostedEntitlement | undefined,
      meetings: Meeting[],
      now: number,
    ) => T,
    client?: pg.PoolClient,
    missingLedger?: (
      grant: HostedEntitlement | undefined,
      meetings: Meeting[],
      now: number,
    ) => T,
  ) {
    let failure: unknown;
    const result = await this.hostedTransaction(
      `pool:${billingOwnerId}`,
      async (c) => {
        const grant = (
          await c.query(
            "SELECT data FROM hosted_entitlements WHERE billing_owner_id=$1",
            [billingOwnerId],
          )
        ).rows[0]?.data as HostedEntitlement | undefined;
        const ledger = (
          await c.query(
            "SELECT data FROM hosted_usage WHERE billing_owner_id=$1",
            [billingOwnerId],
          )
        ).rows[0]?.data as UsageLedger | undefined;
        if (!ledger && !missingLedger)
          throw new HttpError(404, "Usage unavailable", "USAGE_UNAVAILABLE");
        // ponytail: scan retained owner meetings under one pool lock. Large meeting
        // histories will need an unsettled-meter index; do not prune recovery state.
        const meetings = (
          await c.query(
            "SELECT data FROM meetings WHERE data->'hosted'->>'billingOwnerId'=$1 ORDER BY code FOR UPDATE",
            [billingOwnerId],
          )
        ).rows.map((row) => row.data as Meeting);
        const now = Date.now();
        const before = new Map(
          meetings.map((m) => [m.code, JSON.stringify(m)]),
        );
        if (ledger) sweepParticipantMeters(ledger, meetings, now);
        sweepRecordingTimes(ledger, grant, meetings, now);
        let value: T | undefined;
        try {
          value = ledger
            ? fn(ledger, grant, meetings, now)
            : missingLedger!(grant, meetings, now);
        } catch (error) {
          failure = error;
        }
        if (ledger)
          await c.query(
            "UPDATE hosted_usage SET data=$2 WHERE billing_owner_id=$1",
            [billingOwnerId, JSON.stringify(ledger)],
          );
        for (const m of meetings) {
          if (before.get(m.code) === JSON.stringify(m)) continue;
          m.revision++;
          await c.query("UPDATE meetings SET data=$2 WHERE code=$1", [
            m.code,
            JSON.stringify(m),
          ]);
        }
        return value;
      },
      billingOwnerId,
      client,
    );
    if (failure) throw failure;
    return result as T;
  }
  async hostedUsage(billingOwnerId: string) {
    return this.usageTransaction(billingOwnerId.toLowerCase(), usageView);
  }
  private async meetingUsage<T>(
    code: string,
    fn: (
      ledger: UsageLedger,
      grant: HostedEntitlement,
      meetings: Meeting[],
      m: Meeting,
      now: number,
    ) => T,
    fallback: () => Promise<T>,
  ) {
    const snapshot = await this.get(code);
    if (!snapshot) throw new HttpError(404, "Meeting unavailable");
    const owner = snapshot.hosted?.billingOwnerId;
    if (!owner) return fallback();
    return this.usageTransaction(owner, (ledger, grant, meetings, now) => {
      const m = meetings.find((row) => row.code === code);
      if (!m || !grant) throw new HttpError(403, "Hosting plan is unavailable");
      return fn(ledger, grant, meetings, m, now);
    });
  }
  async debitRecordingDownload(
    code: string,
    plaintextBytes: number,
    authorize: (current: Meeting) => void,
  ) {
    await this.meetingUsage(
      code,
      (ledger, grant, _meetings, m, now) => {
        if (m.hosted?.revoked)
          throw new HttpError(403, "Recording access denied");
        authorize(m);
        debitDownloadBytes(ledger, grant, plaintextBytes, now);
      },
      () =>
        this.change(code, (m) => {
          // A legacy room may have been bound after the initial read. Retry with
          // its owner lock rather than bypassing the newly required allowance.
          if (m.hosted?.billingOwnerId)
            throw new HttpError(
              409,
              "Recording access changed; retry download",
            );
          if (m.hosted?.revoked)
            throw new HttpError(403, "Recording access denied");
          authorize(m);
        }),
    );
  }
  async checkUsage(code: string, participantId?: string) {
    await this.meetingUsage(
      code,
      (ledger, grant, meetings, m, now) =>
        requireUsage(
          ledger,
          grant,
          meetings,
          now,
          m.participants.find((p) => p.id === participantId),
          m,
        ),
      async () => {},
    );
  }
  async updateParticipantMeter(code: string, input: MeterInput) {
    return this.meetingUsage(
      code,
      (ledger, grant, meetings, m, now) => {
        updateMeter(ledger, grant, meetings, m, input, now);
        return {
          meeting: structuredClone(m),
          participant: structuredClone(
            m.participants.find((p) => p.id === input.participantId)!,
          ),
        };
      },
      async () => {
        const m = (await this.get(code))! as Meeting;
        const p = m.participants.find((p) => p.id === input.participantId);
        if (!p) throw new HttpError(403, "Media access denied");
        return { meeting: m, participant: p };
      },
    );
  }
  async settleParticipantMeter(
    code: string,
    participantId: string,
    mediaVersion: number,
    expected?: Pick<ParticipantMeter, "connectionId" | "mediaVersion">,
  ) {
    const snapshot = (await this.get(code)) as Meeting | null;
    if (!snapshot?.participants.some((p) => p.id === participantId && p.meter))
      return;
    await this.meetingUsage(
      code,
      (ledger, _grant, _meetings, m, now) => {
        const p = m.participants.find((p) => p.id === participantId);
        if (
          p?.mediaVersion === mediaVersion &&
          expected !== undefined &&
          p.meter?.connectionId === expected.connectionId &&
          p.meter.mediaVersion === expected.mediaVersion &&
          canSettleMeter(m, p, now)
        )
          settleMeter(ledger, m, p, now);
      },
      async () => {},
    );
  }
  async reconcileParticipantMeters(code: string) {
    const snapshot = (await this.get(code)) as Meeting | null;
    if (!snapshot?.participants.some((p) => p.meter)) return;
    await this.meetingUsage(
      code,
      (ledger, _grant, _meetings, m, now) => {
        for (const p of m.participants)
          if (
            p.meter?.phase === "closing" &&
            !p.enforcementPending &&
            canSettleMeter(m, p, now)
          )
            settleMeter(ledger, m, p, now);
      },
      async () => {},
    );
  }
  private async hostedTransaction<T>(
    accountId: string,
    fn: (c: pg.PoolClient) => Promise<T>,
    billingOwnerId?: string,
    client?: pg.PoolClient,
  ): Promise<T> {
    const c = client ?? (await this.pool.connect());
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
      if (!client) c.release();
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
        let ledger = (
          await c.query(
            "SELECT data FROM hosted_usage WHERE billing_owner_id=$1",
            [input.billingOwnerId],
          )
        ).rows[0]?.data as UsageLedger | undefined;
        if (grant.quota) {
          if (ledger && ledger.anchorAt !== grant.quota.anchorAt)
            throw new HttpError(409, "Usage anniversary cannot change");
          ledger ??= { anchorAt: grant.quota.anchorAt, windows: [] };
        }
        const meetings = (
          await c.query(
            "SELECT data FROM meetings WHERE data->'hosted'->>'billingOwnerId'=$1 ORDER BY code FOR UPDATE",
            [input.billingOwnerId],
          )
        ).rows.map((row) => row.data as Meeting);
        if (ledger)
          setMetering(
            ledger,
            grant,
            meetings.filter(
              (m) => m.hosted?.billingOwnerId === grant.billingOwnerId,
            ),
          );
        applyEntitlement(grant, meetings);
        if (ledger) {
          sweepParticipantMeters(ledger, meetings, Date.now());
          sweepRecordingTimes(ledger, grant, meetings, Date.now());
          if (
            grant.enabled &&
            quotaOverdrawn(ledger, grant, meetings, Date.now())
          )
            for (const m of meetings) if (m.lifecycle) endMeeting(m);
          await c.query(
            "INSERT INTO hosted_usage(billing_owner_id,data) VALUES($1,$2) ON CONFLICT(billing_owner_id) DO UPDATE SET data=$2",
            [input.billingOwnerId, JSON.stringify(ledger)],
          );
        }
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
  withHostedReentry<T>(code: string, change: (m: Meeting) => T): Promise<T> {
    return this.withHostedAccess(code, change, "host");
  }
  withHostedRecordingAccess<T>(
    code: string,
    change: (m: Meeting) => T,
  ): Promise<T> {
    return this.withHostedAccess(code, change, "recordings");
  }
  private async withHostedAccess<T>(
    code: string,
    change: (m: Meeting) => T,
    purpose: "host" | "recordings",
  ): Promise<T> {
    const snapshot = await this.get(code);
    const binding = snapshot?.hosted;
    if (!binding?.billingOwnerId)
      throw new HttpError(404, "Meeting unavailable");
    return this.hostedTransaction(
      binding.accountId,
      async (c) => {
        const m = (
          await c.query("SELECT data FROM meetings WHERE code=$1 FOR UPDATE", [
            code,
          ])
        ).rows[0]?.data as Meeting | undefined;
        if (
          !m ||
          m.hosted?.accountId !== binding.accountId ||
          m.hosted?.billingOwnerId !== binding.billingOwnerId
        )
          throw new HttpError(409, "Meeting ownership changed");
        const authorityRow = (
          await c.query(
            "SELECT version,enabled,billing_owner_id FROM hosted_authorities WHERE account_id=$1",
            [binding.accountId],
          )
        ).rows[0];
        const authority = authorityRow && {
          accountId: binding.accountId,
          version: Number(authorityRow.version),
          enabled: authorityRow.enabled as boolean,
          billingOwnerId: authorityRow.billing_owner_id as string | undefined,
        };
        if (purpose === "host") {
          const grant = (
            await c.query(
              "SELECT data FROM hosted_entitlements WHERE billing_owner_id=$1",
              [binding.billingOwnerId],
            )
          ).rows[0]?.data as HostedEntitlement | undefined;
          requireCurrentHostedReentry(m, authority, grant);
        } else requireCurrentHostedRecordingAccess(m, authority);
        const result = change(m);
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
  async startMeeting<T>(
    code: string,
    fn: (m: Meeting) => Promise<T> | T,
    freeRoomLimit = 1,
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
        let freeRooms: Meeting[] = [];
        if (
          m.hosted?.entitlement?.limits.groupDurationSeconds &&
          !m.lifecycle
        ) {
          // Serialize capacity reservations across billing owners and API replicas.
          await c.query(
            "SELECT pg_advisory_xact_lock(hashtextextended('covemeet:free-room-capacity',0))",
          );
          freeRooms = (
            await c.query(
              "SELECT data FROM meetings WHERE data->'hosted'->'entitlement'->'limits'->>'groupDurationSeconds'='10800' AND data->'lifecycle' IS NOT NULL AND data->'lifecycle'->>'cleanupConfirmed' IS DISTINCT FROM 'true'",
            )
          ).rows.map((row) => row.data as Meeting);
        }
        const others = (
          await c.query(
            "SELECT data FROM meetings WHERE data->'hosted'->>'billingOwnerId'=$1 OR data->'hosted'->>'accountId'=$2",
            [binding.billingOwnerId, binding.accountId],
          )
        ).rows.map((row) => row.data as Meeting);
        startMeetingReservation(m, others, freeRoomLimit, freeRooms);
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
  async hostedMeetings(accountId: string) {
    return (
      await this.pool.query(
        "SELECT data FROM meetings WHERE data->'hosted'->>'accountId'=$1",
        [accountId],
      )
    ).rows.map((row) => row.data as Meeting);
  }
  async hostedOperations(accountId: string, operationIds: string[]) {
    return (
      await this.pool.query(
        "SELECT data FROM meetings WHERE data->'hosted'->>'accountId'=$1 AND data->'hosted'->>'operationId'=ANY($2::text[]) AND data->'hosted'->>'billingOwnerId' IS NOT NULL LIMIT 20",
        [accountId, operationIds],
      )
    ).rows.map((row) => row.data as Meeting);
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
  async readWhiteboard(
    code: string,
    after: number,
    authorize: (m: Meeting) => WhiteboardAccess,
  ): Promise<WhiteboardPage> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const m = (
        await c.query("SELECT data FROM meetings WHERE code=$1 FOR SHARE", [
          code,
        ])
      ).rows[0]?.data as Meeting | undefined;
      if (!m) throw new HttpError(404, "Meeting unavailable");
      const { scope } = authorize(m);
      const board = (
        await c.query(
          "SELECT seq,epoch,read_only FROM whiteboards WHERE meeting_code=$1 AND scope=$2",
          [code, scope],
        )
      ).rows[0];
      const rows = (
        await c.query(
          "SELECT event FROM whiteboard_events WHERE meeting_code=$1 AND scope=$2 AND seq>$3 ORDER BY seq LIMIT $4",
          [code, scope, after, WHITEBOARD_PAGE_SIZE + 1],
        )
      ).rows;
      const hasMore = rows.length > WHITEBOARD_PAGE_SIZE;
      const events = rows
        .slice(0, WHITEBOARD_PAGE_SIZE)
        .map((r) => r.event as WhiteboardEvent);
      await c.query("COMMIT");
      return {
        events,
        cursor: events.at(-1)?.seq ?? Number(board?.seq ?? 0),
        hasMore,
        readOnly: !!board?.read_only,
        epoch: Number(board?.epoch ?? 0),
      };
    } catch (error) {
      await c.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      c.release();
    }
  }
  async writeWhiteboard(
    code: string,
    input: WhiteboardInput,
    authorize: (m: Meeting) => WhiteboardAccess,
  ): Promise<WhiteboardEvent> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const m = (
        await c.query("SELECT data FROM meetings WHERE code=$1 FOR UPDATE", [
          code,
        ])
      ).rows[0]?.data as Meeting | undefined;
      if (!m) throw new HttpError(404, "Meeting unavailable");
      const access = authorize(m);
      await c.query(
        "INSERT INTO whiteboards(meeting_code,scope) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [code, access.scope],
      );
      const board = (
        await c.query(
          "SELECT seq,epoch,read_only,event_count,bytes_used FROM whiteboards WHERE meeting_code=$1 AND scope=$2 FOR UPDATE",
          [code, access.scope],
        )
      ).rows[0];
      if (input.epoch !== Number(board.epoch))
        throw new HttpError(409, "Whiteboard changed. Try again.");
      authorizeWhiteboardWrite(!!board.read_only, access, input);
      if (input.kind === "stroke" || input.kind === "text") {
        const existing = (
          await c.query(
            "SELECT event FROM whiteboard_events WHERE meeting_code=$1 AND scope=$2 AND event->>'id'=$3 LIMIT 1",
            [code, access.scope, input.id],
          )
        ).rows[0]?.event as WhiteboardEvent | undefined;
        if (existing) {
          if (!sameWhiteboardItem(existing, input, access.authorId))
            throw new HttpError(409, "Whiteboard item ID is already used");
          await c.query("COMMIT");
          return existing;
        }
      }
      const event = {
        ...input,
        seq: Number(board.seq) + 1,
        epoch:
          input.kind === "clear"
            ? Number(board.epoch) + 1
            : Number(board.epoch),
        authorId: access.authorId,
      } as WhiteboardEvent;
      if (input.kind === "policy") {
        await c.query(
          "UPDATE whiteboards SET seq=$3,read_only=$4 WHERE meeting_code=$1 AND scope=$2",
          [code, access.scope, event.seq, input.readOnly],
        );
        await c.query("COMMIT");
        return event;
      }
      const bytes = whiteboardEventSize(event);
      const count = input.kind === "clear" ? 1 : Number(board.event_count) + 1;
      const used =
        input.kind === "clear" ? bytes : Number(board.bytes_used) + bytes;
      if (
        input.kind !== "clear" &&
        (count > WHITEBOARD_EVENT_LIMIT || used > WHITEBOARD_BYTE_LIMIT)
      )
        throw new HttpError(
          409,
          "Whiteboard is full. Ask the host to clear it.",
        );
      if (input.kind === "clear")
        await c.query(
          "DELETE FROM whiteboard_events WHERE meeting_code=$1 AND scope=$2",
          [code, access.scope],
        );
      await c.query(
        "UPDATE whiteboards SET seq=$3,epoch=$4,read_only=$5,event_count=$6,bytes_used=$7 WHERE meeting_code=$1 AND scope=$2",
        [
          code,
          access.scope,
          event.seq,
          event.epoch,
          board.read_only,
          count,
          used,
        ],
      );
      await c.query(
        "INSERT INTO whiteboard_events(meeting_code,scope,seq,event) VALUES($1,$2,$3,$4)",
        [code, access.scope, event.seq, JSON.stringify(event)],
      );
      await c.query("COMMIT");
      return event;
    } catch (error) {
      await c.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      c.release();
    }
  }
  async purgeWhiteboard(code: string): Promise<void> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const m = (
        await c.query("SELECT data FROM meetings WHERE code=$1 FOR UPDATE", [
          code,
        ])
      ).rows[0]?.data as Meeting | undefined;
      if (!m?.ended) throw new HttpError(409, "Meeting has not ended");
      await c.query("DELETE FROM whiteboard_events WHERE meeting_code=$1", [
        code,
      ]);
      await c.query("DELETE FROM whiteboards WHERE meeting_code=$1", [code]);
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      c.release();
    }
  }
  private async recordingUsage<T>(
    c: pg.PoolClient,
    code: string,
    change: RecordingUsageChange<T>,
    authorize?: (m: Meeting) => void,
  ) {
    const snapshot = (
      await c.query("SELECT data FROM meetings WHERE code=$1", [code])
    ).rows[0]?.data as Meeting | undefined;
    if (!snapshot) throw new HttpError(404, "Meeting unavailable");
    authorize?.(snapshot);
    const owner = snapshot.hosted?.billingOwnerId;
    if (!owner)
      return this.changeWithClient(c, code, (m) => {
        if (m.hosted?.billingOwnerId)
          throw new HttpError(409, "Recording allowance owner changed");
        return change(undefined, undefined, [m], m, Date.now());
      });
    return this.usageTransaction(
      owner,
      (ledger, grant, meetings, now) => {
        const m = meetings.find((row) => row.code === code);
        if (!m) throw new HttpError(409, "Recording allowance owner changed");
        return change(ledger, grant, meetings, m, now);
      },
      c,
      (grant, meetings, now) => {
        const m = meetings.find((row) => row.code === code);
        if (!m) throw new HttpError(409, "Recording allowance owner changed");
        return change(undefined, grant, meetings, m, now);
      },
    );
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
        ...recordingTimeMethods(id, async (change, authorize) => {
          await check();
          return this.recordingUsage(c, code, change, authorize);
        }),
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
  usageLedgers = new Map<string, UsageLedger>();
  whiteboards = new Map<
    string,
    {
      seq: number;
      epoch: number;
      readOnly: boolean;
      bytesUsed: number;
      events: WhiteboardEvent[];
    }
  >();
  private async usageTransaction<T>(
    owner: string,
    fn: (
      ledger: UsageLedger,
      grant: HostedEntitlement | undefined,
      meetings: Meeting[],
      now: number,
    ) => T,
    missingLedger?: (
      grant: HostedEntitlement | undefined,
      meetings: Meeting[],
      now: number,
    ) => T,
  ) {
    let failure: unknown;
    const result = await this.serialize(async () => {
      const ledger = structuredClone(this.usageLedgers.get(owner));
      if (!ledger && !missingLedger)
        throw new HttpError(404, "Usage unavailable", "USAGE_UNAVAILABLE");
      const grant = this.hostedEntitlements.get(owner);
      const meetings = structuredClone(
        [...this.data.values()].filter(
          (m) => m.hosted?.billingOwnerId === owner,
        ),
      );
      const now = Date.now();
      if (ledger) sweepParticipantMeters(ledger, meetings, now);
      sweepRecordingTimes(ledger, grant, meetings, now);
      let value: T | undefined;
      try {
        value = ledger
          ? fn(ledger, grant, meetings, now)
          : missingLedger!(grant, meetings, now);
      } catch (error) {
        failure = error;
      }
      if (ledger) this.usageLedgers.set(owner, ledger);
      for (const m of meetings) {
        m.revision++;
        this.data.set(m.code, m);
      }
      return value;
    });
    if (failure) throw failure;
    return result as T;
  }
  async hostedUsage(owner: string) {
    return this.usageTransaction(owner.toLowerCase(), usageView);
  }
  private async meetingUsage<T>(
    code: string,
    fn: (
      ledger: UsageLedger,
      grant: HostedEntitlement,
      meetings: Meeting[],
      m: Meeting,
      now: number,
    ) => T,
    fallback: () => Promise<T>,
  ) {
    const snapshot = await this.get(code);
    if (!snapshot) throw new HttpError(404, "Meeting unavailable");
    const owner = snapshot.hosted?.billingOwnerId;
    if (!owner) return fallback();
    return this.usageTransaction(owner, (ledger, grant, meetings, now) => {
      const m = meetings.find((row) => row.code === code);
      if (!m || !grant) throw new HttpError(403, "Hosting plan is unavailable");
      return fn(ledger, grant, meetings, m, now);
    });
  }
  async debitRecordingDownload(
    code: string,
    plaintextBytes: number,
    authorize: (current: Meeting) => void,
  ) {
    await this.meetingUsage(
      code,
      (ledger, grant, _meetings, m, now) => {
        if (m.hosted?.revoked)
          throw new HttpError(403, "Recording access denied");
        authorize(m);
        debitDownloadBytes(ledger, grant, plaintextBytes, now);
      },
      () =>
        this.change(code, (m) => {
          // A legacy room may have been bound after the initial read. Retry with
          // its owner lock rather than bypassing the newly required allowance.
          if (m.hosted?.billingOwnerId)
            throw new HttpError(
              409,
              "Recording access changed; retry download",
            );
          if (m.hosted?.revoked)
            throw new HttpError(403, "Recording access denied");
          authorize(m);
        }),
    );
  }
  async checkUsage(code: string, participantId?: string) {
    await this.meetingUsage(
      code,
      (ledger, grant, meetings, m, now) =>
        requireUsage(
          ledger,
          grant,
          meetings,
          now,
          m.participants.find((p) => p.id === participantId),
          m,
        ),
      async () => {},
    );
  }
  async updateParticipantMeter(code: string, input: MeterInput) {
    return this.meetingUsage(
      code,
      (ledger, grant, meetings, m, now) => {
        updateMeter(ledger, grant, meetings, m, input, now);
        return {
          meeting: structuredClone(m),
          participant: structuredClone(
            m.participants.find((p) => p.id === input.participantId)!,
          ),
        };
      },
      async () => {
        const m = (await this.get(code))! as Meeting;
        const p = m.participants.find((p) => p.id === input.participantId);
        if (!p) throw new HttpError(403, "Media access denied");
        return { meeting: m, participant: p };
      },
    );
  }
  async settleParticipantMeter(
    code: string,
    participantId: string,
    mediaVersion: number,
    expected?: Pick<ParticipantMeter, "connectionId" | "mediaVersion">,
  ) {
    const snapshot = (await this.get(code)) as Meeting | null;
    if (!snapshot?.participants.some((p) => p.id === participantId && p.meter))
      return;
    await this.meetingUsage(
      code,
      (ledger, _grant, _meetings, m, now) => {
        const p = m.participants.find((p) => p.id === participantId);
        if (
          p?.mediaVersion === mediaVersion &&
          expected !== undefined &&
          p.meter?.connectionId === expected.connectionId &&
          p.meter.mediaVersion === expected.mediaVersion &&
          canSettleMeter(m, p, now)
        )
          settleMeter(ledger, m, p, now);
      },
      async () => {},
    );
  }
  async reconcileParticipantMeters(code: string) {
    const snapshot = (await this.get(code)) as Meeting | null;
    if (!snapshot?.participants.some((p) => p.meter)) return;
    await this.meetingUsage(
      code,
      (ledger, _grant, _meetings, m, now) => {
        for (const p of m.participants)
          if (
            p.meter?.phase === "closing" &&
            !p.enforcementPending &&
            canSettleMeter(m, p, now)
          )
            settleMeter(ledger, m, p, now);
      },
      async () => {},
    );
  }
  async setHostedEntitlement(raw: HostedEntitlement) {
    const input = entitlementSchema.parse(raw);
    return this.serialize(async () => {
      const previous = this.hostedEntitlements.get(input.billingOwnerId);
      const grant = nextEntitlement(previous, input);
      if (grant !== previous) {
        let ledger = structuredClone(
          this.usageLedgers.get(input.billingOwnerId),
        );
        if (grant.quota) {
          if (ledger && ledger.anchorAt !== grant.quota.anchorAt)
            throw new HttpError(409, "Usage anniversary cannot change");
          ledger ??= { anchorAt: grant.quota.anchorAt, windows: [] };
        }
        const meetings = structuredClone([...this.data.values()]);
        if (ledger)
          setMetering(
            ledger,
            grant,
            meetings.filter(
              (m) => m.hosted?.billingOwnerId === grant.billingOwnerId,
            ),
          );
        applyEntitlement(grant, meetings);
        if (ledger) {
          const bound = meetings.filter(
            (m) => m.hosted?.billingOwnerId === input.billingOwnerId,
          );
          sweepParticipantMeters(ledger, bound, Date.now());
          sweepRecordingTimes(ledger, grant, bound, Date.now());
          if (grant.enabled && quotaOverdrawn(ledger, grant, bound, Date.now()))
            for (const m of bound) if (m.lifecycle) endMeeting(m);
          this.usageLedgers.set(input.billingOwnerId, ledger);
        }
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
    freeRoomLimit = 1,
  ): Promise<T> {
    return this.change(code, async (m) => {
      const result = await fn(m);
      startMeetingReservation(m, [...this.data.values()], freeRoomLimit);
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
  withHostedReentry<T>(code: string, change: (m: Meeting) => T): Promise<T> {
    return this.withHostedAccess(code, change, "host");
  }
  withHostedRecordingAccess<T>(
    code: string,
    change: (m: Meeting) => T,
  ): Promise<T> {
    return this.withHostedAccess(code, change, "recordings");
  }
  private async withHostedAccess<T>(
    code: string,
    change: (m: Meeting) => T,
    purpose: "host" | "recordings",
  ): Promise<T> {
    return this.serialize(async () => {
      const m = structuredClone(this.data.get(code));
      if (!m?.hosted?.billingOwnerId)
        throw new HttpError(404, "Meeting unavailable");
      const authority = this.hostedAuthorities.get(m.hosted.accountId);
      if (purpose === "host")
        requireCurrentHostedReentry(
          m,
          authority,
          this.hostedEntitlements.get(m.hosted.billingOwnerId),
        );
      else requireCurrentHostedRecordingAccess(m, authority);
      const result = change(m);
      m.revision++;
      this.data.set(code, m);
      return result;
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
        ...recordingTimeMethods(id, async (change, authorize) => {
          await check();
          const snapshot = await this.get(code);
          if (!snapshot) throw new HttpError(404, "Meeting unavailable");
          authorize?.(snapshot);
          const owner = snapshot.hosted?.billingOwnerId;
          if (!owner)
            return this.change(code, (m) => {
              if (m.hosted?.billingOwnerId)
                throw new HttpError(409, "Recording allowance owner changed");
              return change(undefined, undefined, [m], m, Date.now());
            });
          const apply = (
            ledger: UsageLedger | undefined,
            grant: HostedEntitlement | undefined,
            meetings: Meeting[],
            now: number,
          ) => {
            const m = meetings.find((row) => row.code === code);
            if (!m)
              throw new HttpError(409, "Recording allowance owner changed");
            return change(ledger, grant, meetings, m, now);
          };
          return this.usageTransaction(owner, apply, (grant, meetings, now) =>
            apply(undefined, grant, meetings, now),
          );
        }),
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
  async hostedMeetings(accountId: string) {
    return structuredClone(
      [...this.data.values()].filter((m) => m.hosted?.accountId === accountId),
    );
  }
  async hostedOperations(accountId: string, operationIds: string[]) {
    const requested = new Set(operationIds);
    return structuredClone(
      [...this.data.values()]
        .filter(
          (m) =>
            m.hosted?.accountId === accountId &&
            !!m.hosted.operationId &&
            !!m.hosted.billingOwnerId &&
            requested.has(m.hosted.operationId),
        )
        .slice(0, 20),
    );
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
  async readWhiteboard(
    code: string,
    after: number,
    authorize: (m: Meeting) => WhiteboardAccess,
  ): Promise<WhiteboardPage> {
    return this.serialize(async () => {
      const m = this.data.get(code);
      if (!m) throw new HttpError(404, "Meeting unavailable");
      const access = authorize(m);
      const board = this.whiteboards.get(`${code}\0${access.scope}`);
      const matching = (board?.events ?? []).filter(
        (event) => event.seq > after,
      );
      const events = matching.slice(0, WHITEBOARD_PAGE_SIZE);
      return structuredClone({
        events,
        cursor: events.at(-1)?.seq ?? board?.seq ?? 0,
        hasMore: matching.length > WHITEBOARD_PAGE_SIZE,
        readOnly: board?.readOnly ?? false,
        epoch: board?.epoch ?? 0,
      });
    });
  }
  async writeWhiteboard(
    code: string,
    input: WhiteboardInput,
    authorize: (m: Meeting) => WhiteboardAccess,
  ): Promise<WhiteboardEvent> {
    return this.serialize(async () => {
      const m = this.data.get(code);
      if (!m) throw new HttpError(404, "Meeting unavailable");
      const access = authorize(m);
      const key = `${code}\0${access.scope}`;
      const board = this.whiteboards.get(key) ?? {
        seq: 0,
        epoch: 0,
        readOnly: false,
        bytesUsed: 0,
        events: [] as WhiteboardEvent[],
      };
      if (input.epoch !== board.epoch)
        throw new HttpError(409, "Whiteboard changed. Try again.");
      authorizeWhiteboardWrite(board.readOnly, access, input);
      if (input.kind === "stroke" || input.kind === "text") {
        const existing = board.events.find(
          (event) =>
            (event.kind === "stroke" || event.kind === "text") &&
            event.id === input.id,
        );
        if (existing) {
          if (!sameWhiteboardItem(existing, input, access.authorId))
            throw new HttpError(409, "Whiteboard item ID is already used");
          return structuredClone(existing);
        }
      }
      const event = {
        ...input,
        seq: board.seq + 1,
        epoch: input.kind === "clear" ? board.epoch + 1 : board.epoch,
        authorId: access.authorId,
      } as WhiteboardEvent;
      if (input.kind === "policy") {
        board.seq = event.seq;
        board.readOnly = input.readOnly;
        this.whiteboards.set(key, board);
        return structuredClone(event);
      }
      const bytes = whiteboardEventSize(event);
      const count = input.kind === "clear" ? 1 : board.events.length + 1;
      const used = input.kind === "clear" ? bytes : board.bytesUsed + bytes;
      if (
        input.kind !== "clear" &&
        (count > WHITEBOARD_EVENT_LIMIT || used > WHITEBOARD_BYTE_LIMIT)
      )
        throw new HttpError(
          409,
          "Whiteboard is full. Ask the host to clear it.",
        );
      board.seq = event.seq;
      board.epoch = event.epoch;
      board.bytesUsed = used;
      board.events =
        input.kind === "clear" ? [event] : [...board.events, event];
      this.whiteboards.set(key, board);
      return structuredClone(event);
    });
  }
  async purgeWhiteboard(code: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.data.get(code)?.ended)
        throw new HttpError(409, "Meeting has not ended");
      for (const key of this.whiteboards.keys())
        if (key.startsWith(`${code}\0`)) this.whiteboards.delete(key);
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
