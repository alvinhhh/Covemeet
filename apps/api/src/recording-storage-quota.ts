import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type {
  EncryptedRecordingMetadata,
  EncryptionReceipt,
  OwnedRecordingFence,
  OwnedRecordingUpload,
  RecordingObjectReference,
} from "@meeting-platform/recording";
import { OWNED_MAX_BYTES } from "@meeting-platform/recording";
import type { HostedEntitlement } from "./meeting-limits.js";
import { recordingContext } from "./recording-context.js";
import { HttpError } from "./security.js";
import type { Meeting, Recording } from "./store.js";

export type RecordingStoragePlan = { maxBytes: number; copies: 1 | 2 };
export type RecordingStoragePrepared =
  | { kind: "local"; metadata: EncryptedRecordingMetadata }
  | {
      kind: "s3";
      metadata: EncryptedRecordingMetadata;
      intent: OwnedRecordingUpload;
    };
export type RecordingStorageProof =
  | {
      kind: "local";
      metadata: EncryptedRecordingMetadata;
      receipt: EncryptionReceipt;
    }
  | {
      kind: "s3";
      metadata: EncryptedRecordingMetadata;
      reference: RecordingObjectReference;
    };
export type RecordingStorageRelease =
  | { kind: "unused" }
  | {
      kind: "local";
      metadata: EncryptedRecordingMetadata;
      receipt: EncryptionReceipt;
      removed: true;
    }
  | {
      kind: "s3";
      metadata: EncryptedRecordingMetadata;
      fence: OwnedRecordingFence;
    };
export type RecordingStorageAttempt = {
  id: string;
  kind: "local" | "s3";
  maxBytes: number;
  state: "reserved" | "pending" | "retained" | "removing" | "released";
  prepared?: RecordingStoragePrepared;
  proof?: RecordingStorageProof;
  release?: RecordingStorageRelease;
  bytes?: number;
};
export type RecordingStorage = {
  billingOwnerId: string;
  maxBytes: number;
  attempts: RecordingStorageAttempt[];
};

function unavailable(): never {
  throw new HttpError(503, "Recording storage inventory is unavailable");
}
function conflict(): never {
  throw new HttpError(409, "Recording storage attempt changed");
}
function capacity(): never {
  throw new HttpError(
    409,
    "Recording storage allowance is unavailable",
    "RECORDING_STORAGE_QUOTA_UNAVAILABLE",
  );
}
const bytes = (value: number) => Number.isSafeInteger(value) && value >= 0;

export function recordingStorageView(
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
) {
  let used = 0,
    reserved = 0;
  for (const m of meetings) {
    if (!m.hosted?.billingOwnerId) continue;
    for (const r of m.recordings) {
      const inventory = r.storage;
      // Even a legacy deleted row may have an untracked abandoned attempt.
      if (!inventory || inventory.billingOwnerId !== m.hosted.billingOwnerId)
        unavailable();
      for (const attempt of inventory.attempts) {
        if (attempt.state === "released") continue;
        if (!bytes(attempt.maxBytes) || attempt.maxBytes === 0) unavailable();
        if (attempt.bytes === undefined) reserved += attempt.maxBytes;
        else {
          if (!bytes(attempt.bytes) || attempt.bytes > attempt.maxBytes)
            unavailable();
          used += attempt.bytes;
        }
      }
    }
  }
  if (!bytes(used) || !bytes(reserved) || !bytes(used + reserved))
    unavailable();
  const limit = grant?.quota?.storageBytes ?? 0;
  return {
    limit,
    used,
    reserved,
    available: Math.max(0, limit - used - reserved),
  };
}

function attempt(
  kind: "local" | "s3",
  maxBytes: number,
): RecordingStorageAttempt {
  return { id: randomUUID(), kind, maxBytes, state: "reserved" };
}

export function reserveRecordingStorage(
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
  m: Meeting,
  r: Recording,
  plan: RecordingStoragePlan | undefined,
) {
  if (!m.hosted?.billingOwnerId) return;
  if (
    !plan ||
    !Number.isSafeInteger(plan.maxBytes) ||
    plan.maxBytes < 93 ||
    plan.maxBytes > OWNED_MAX_BYTES ||
    ![1, 2].includes(plan.copies)
  )
    capacity();
  const view = recordingStorageView(grant, meetings);
  const maxBytes = Math.min(
    plan.maxBytes,
    Math.floor(view.available / plan.copies),
  );
  if (maxBytes < 93) capacity();
  r.storage = {
    billingOwnerId: m.hosted.billingOwnerId,
    maxBytes,
    attempts: [
      attempt("local", maxBytes),
      ...(plan.copies === 2 ? [attempt("s3", maxBytes)] : []),
    ],
  };
}

function inventory(m: Meeting, r: Recording) {
  if (
    !r.storage ||
    !m.hosted?.billingOwnerId ||
    r.storage.billingOwnerId !== m.hosted.billingOwnerId
  )
    unavailable();
  return r.storage;
}
function current(m: Meeting, r: Recording, id: string) {
  const row = inventory(m, r).attempts.find((a) => a.id === id);
  if (!row) conflict();
  return row;
}

export function allocateRecordingStorage(
  grant: HostedEntitlement | undefined,
  meetings: Meeting[],
  m: Meeting,
  r: Recording,
  kind: "local" | "s3",
) {
  if (kind !== "local" && kind !== "s3") conflict();
  const storage = inventory(m, r);
  const unused = storage.attempts.find(
    (a) => a.kind === kind && a.state === "reserved",
  );
  if (unused) return unused;
  if (recordingStorageView(grant, meetings).available < storage.maxBytes)
    capacity();
  const row = attempt(kind, storage.maxBytes);
  storage.attempts.push(row);
  return row;
}

function metadataMatches(
  row: RecordingStorageAttempt,
  metadata: EncryptedRecordingMetadata,
) {
  if (!row.prepared || !isDeepStrictEqual(row.prepared.metadata, metadata))
    conflict();
}
function receiptMatches(
  row: RecordingStorageAttempt,
  receipt: EncryptionReceipt,
) {
  if (
    receipt.version !== 1 ||
    typeof receipt.published !== "boolean" ||
    !bytes(receipt.bytes) ||
    receipt.bytes > row.maxBytes ||
    receipt.bytes > row.prepared!.metadata.encryptedBytes ||
    (receipt.published &&
      receipt.bytes !== row.prepared!.metadata.encryptedBytes)
  )
    conflict();
}

export function prepareRecordingStorage(
  m: Meeting,
  r: Recording,
  id: string,
  prepared: RecordingStoragePrepared,
) {
  const row = current(m, r, id);
  if (row.prepared) {
    if (row.state !== "pending" || !isDeepStrictEqual(row.prepared, prepared))
      conflict();
    return row;
  }
  const metadata = prepared.metadata;
  const expectedContext = recordingContext(m, r);
  if (
    row.state !== "reserved" ||
    prepared.kind !== row.kind ||
    metadata.version !== 1 ||
    metadata.context.tenantId !== expectedContext.tenantId ||
    metadata.context.meetingId !== expectedContext.meetingId ||
    metadata.context.recordingId !== expectedContext.recordingId ||
    !metadata.recordingKeyId ||
    !bytes(metadata.plaintextBytes) ||
    !bytes(metadata.encryptedBytes) ||
    metadata.encryptedBytes <= 0 ||
    metadata.encryptedBytes > row.maxBytes
  )
    conflict();
  if (
    prepared.kind === "s3" &&
    (prepared.intent.provider !== "s3-single" ||
      !/^[a-f0-9]{64}$/.test(prepared.intent.storageId) ||
      !prepared.intent.key ||
      prepared.intent.bytes !== metadata.encryptedBytes ||
      !/^[a-f0-9]{64}$/.test(prepared.intent.sha256))
  )
    conflict();
  row.prepared = structuredClone(prepared);
  row.state = "pending";
  return row;
}

export function retainRecordingStorage(
  m: Meeting,
  r: Recording,
  id: string,
  proof: RecordingStorageProof,
) {
  const row = current(m, r, id);
  metadataMatches(row, proof.metadata);
  if (
    row.kind !== proof.kind ||
    !["pending", "retained", "removing"].includes(row.state)
  )
    conflict();
  if (row.proof) {
    if (!isDeepStrictEqual(row.proof, proof)) conflict();
    return row;
  }
  let retainedBytes: number;
  if (proof.kind === "local") {
    receiptMatches(row, proof.receipt);
    retainedBytes = proof.receipt.bytes;
  } else {
    if (row.prepared!.kind !== "s3") conflict();
    const intent = row.prepared!.intent,
      ref = proof.reference;
    if (
      ref.provider !== "s3" ||
      ref.key !== intent.key ||
      ref.bytes !== intent.bytes ||
      ref.sha256 !== intent.sha256 ||
      !ref.etag ||
      !ref.versionId ||
      ref.versionId === "null"
    )
      conflict();
    retainedBytes = ref.bytes;
  }
  row.proof = structuredClone(proof);
  row.bytes = retainedBytes;
  if (row.state !== "removing") row.state = "retained";
  return row;
}

export function removeRecordingStorage(m: Meeting, r: Recording, id: string) {
  const row = current(m, r, id);
  if (row.state === "reserved") conflict();
  if (row.state !== "released") row.state = "removing";
  return row;
}

export function releaseRecordingStorage(
  m: Meeting,
  r: Recording,
  id: string,
  proof: RecordingStorageRelease,
) {
  const row = current(m, r, id);
  if (row.state === "released") {
    if (!isDeepStrictEqual(row.release, proof)) conflict();
    return row;
  }
  if (proof.kind === "unused") {
    if (row.state !== "reserved" || row.prepared) conflict();
  } else {
    metadataMatches(row, proof.metadata);
    if (row.state !== "removing" || row.kind !== proof.kind) conflict();
    if (proof.kind === "local") {
      receiptMatches(row, proof.receipt);
      if (
        proof.removed !== true ||
        (row.proof &&
          (row.proof.kind !== "local" ||
            !isDeepStrictEqual(row.proof.receipt, proof.receipt)))
      )
        conflict();
    } else {
      if (row.prepared!.kind !== "s3") conflict();
      const fence = proof.fence;
      if (
        fence.provider !== "s3-single" ||
        fence.storageId !== row.prepared!.intent.storageId ||
        fence.key !== row.prepared!.intent.key ||
        !fence.etag ||
        !fence.versionId ||
        fence.versionId === "null" ||
        fence.bytes !== 0 ||
        fence.cleaned !== true
      )
        conflict();
    }
  }
  row.release = structuredClone(proof);
  row.state = "released";
  return row;
}
