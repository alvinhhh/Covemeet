import { createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import type { Media } from "./media.js";
import type { Meeting, Participant, Store } from "./store.js";
import { HttpError, keyedDigest } from "./security.js";

const label = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);

export const phoneRuntimeSchema = z
  .object({
    daemonId: z.string().regex(/^[A-Za-z0-9:._-]{1,128}$/),
    project: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/),
    supervisor: z.string().regex(/^[0-9a-f]{64}$/),
    pbx: z.string().regex(/^[0-9a-f]{64}$/),
    sip: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict()
  .refine((r) => new Set([r.supervisor, r.pbx, r.sip]).size === 3);
export const phoneSupervisorInputSchema = z
  .object({
    pbxId: label,
    ownerId: z.string().uuid(),
    pbxEpoch: label,
    runtime: phoneRuntimeSchema.optional(),
  })
  .strict();
export type PhoneSupervisorInput = z.infer<typeof phoneSupervisorInputSchema>;
export const phoneSupervisorSchema = phoneSupervisorInputSchema
  .extend({
    state: z.enum(["active", "fencing"]),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type PhoneSupervisor = z.infer<typeof phoneSupervisorSchema>;
const channel = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
export const phoneDialogInputSchema = z
  .object({
    callId: z.string().uuid(),
    ownerId: z.string().uuid(),
    pbxId: label,
    pbxEpoch: label,
    callerChannelId: channel,
    trunkId: label,
    inboundEndpoint: label,
    outboundEndpoint: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    sipTrunkId: z.string().regex(/^ST_[A-Za-z0-9]{1,64}$/),
    sipRuleId: z.string().regex(/^SDR_[A-Za-z0-9]{1,64}$/),
  })
  .strict();
export type PhoneDialogInput = z.infer<typeof phoneDialogInputSchema>;

export const phoneMutations = [
  "answer",
  "originate",
  "create-bridge",
  "attach-outbound",
  "attach-caller",
  "play",
] as const;
export type PhoneMutation = (typeof phoneMutations)[number];
export type PhoneMutationState =
  | "pending"
  | "confirmed"
  | "rejected"
  | "unknown";
const mutation = z.enum(phoneMutations);
const nativeIdentity = `sip_${createHash("sha256").update("covemeet-pbx").digest("hex").slice(0, 16)}`;
const holdingSchema = z
  .object({
    roomName: z.string().max(160),
    roomSid: z.string().regex(/^RM_[A-Za-z0-9]{1,64}$/),
    nativeIdentity: z.literal(nativeIdentity),
    nativeSid: z.string().regex(/^PA_[A-Za-z0-9]{1,64}$/),
  })
  .strict();
export type PhoneHoldingBinding = z.infer<typeof holdingSchema>;
export const phoneDialogChangeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("begin"), operation: mutation }).strict(),
  z
    .object({
      type: z.literal("settle"),
      operation: mutation,
      outcome: z.enum(["confirmed", "rejected", "unknown"]),
    })
    .strict(),
  holdingSchema.extend({ type: z.literal("holding") }).strict(),
  z.object({ type: z.literal("uncertain") }).strict(),
]);
export type PhoneDialogChange = z.infer<typeof phoneDialogChangeSchema>;
export const phoneCleanupProofSchema = z
  .object({
    allocationsStopped: z.literal(true),
    callerAbsent: z.literal(true),
    outboundAbsent: z.literal(true),
    bridgeAbsent: z.literal(true),
    nativeAbsent: z.literal(true),
    holdingRelayAbsent: z.literal(true),
    rtcClosed: z.literal(true),
  })
  .strict();
export type PhoneCleanupProof = z.infer<typeof phoneCleanupProofSchema>;
export interface PhoneDialog extends PhoneDialogInput {
  state: "open" | "stopping" | "closed";
  revision: number;
  operations: Partial<Record<PhoneMutation, PhoneMutationState>>;
  uncertain: boolean;
  playbackId?: string;
  holding?: PhoneHoldingBinding;
  binding?: { code: string; participantId: string };
  createdAt: number;
  updatedAt: number;
}
export type PhoneDialogQuery = { callId: string } | { pbxId: string };
export interface PhoneDialogStop {
  dialog: PhoneDialog;
  meeting?: Meeting;
  participant?: Participant;
}

export function newPhoneDialog(input: PhoneDialogInput): PhoneDialog {
  const now = Date.now();
  return {
    ...phoneDialogInputSchema.parse(input),
    state: "open",
    revision: 1,
    operations: {},
    uncertain: false,
    createdAt: now,
    updatedAt: now,
  };
}
export function samePhoneDialog(a: PhoneDialog, b: PhoneDialogInput): boolean {
  return Object.keys(phoneDialogInputSchema.shape).every(
    (key) =>
      a[key as keyof PhoneDialogInput] === b[key as keyof PhoneDialogInput],
  );
}
export function ownPhoneDialog(
  dialog: PhoneDialog,
  ownerId: string,
  revision?: number,
) {
  if (
    dialog.ownerId !== ownerId ||
    (revision !== undefined && dialog.revision !== revision)
  )
    throw new HttpError(409, "Phone dialog ownership or revision changed");
}
export function ownPhoneSupervisor(
  claim: PhoneSupervisor | undefined,
  input: Pick<PhoneDialogInput, "pbxId" | "ownerId" | "pbxEpoch">,
) {
  if (
    !claim ||
    claim.state !== "active" ||
    claim.pbxId !== input.pbxId ||
    claim.ownerId !== input.ownerId ||
    claim.pbxEpoch !== input.pbxEpoch
  )
    throw new HttpError(409, "Phone supervisor ownership unavailable");
}

export function bumpPhoneDialog(dialog: PhoneDialog) {
  if (
    !Number.isSafeInteger(dialog.revision) ||
    dialog.revision >= Number.MAX_SAFE_INTEGER
  )
    throw new HttpError(409, "Phone dialog revision exhausted");
  dialog.revision++;
  dialog.updatedAt = Date.now();
}
export function editPhoneDialog(
  dialog: PhoneDialog,
  change: PhoneDialogChange,
) {
  if (dialog.state === "closed")
    throw new HttpError(409, "Phone dialog is closed");
  if (change.type === "uncertain") {
    dialog.uncertain = true;
  } else if (change.type === "begin") {
    const previous =
      change.operation === "play"
        ? "answer"
        : phoneMutations[phoneMutations.indexOf(change.operation) - 1];
    const prior = dialog.operations[change.operation];
    if (
      dialog.state !== "open" ||
      dialog.uncertain ||
      (prior !== undefined &&
        !(
          change.operation === "play" &&
          ["confirmed", "rejected"].includes(prior)
        )) ||
      (previous && dialog.operations[previous] !== "confirmed") ||
      (change.operation === "originate" && !dialog.binding) ||
      (change.operation === "create-bridge" && !dialog.holding)
    )
      throw new HttpError(409, "Phone allocation stage unavailable");
    dialog.operations[change.operation] = "pending";
    if (change.operation === "play")
      dialog.playbackId = `cm-play-${dialog.callId}-${dialog.revision + 1}`;
  } else if (change.type === "settle") {
    if (dialog.operations[change.operation] !== "pending")
      throw new HttpError(409, "Phone mutation is not pending");
    dialog.operations[change.operation] = change.outcome;
    if (change.outcome === "unknown") dialog.uncertain = true;
  } else {
    const { type: _, ...holding } = change;
    const suffix = holding.roomName.slice(
      `phone-hold-${dialog.callId}_`.length,
    );
    if (
      dialog.operations.originate !== "confirmed" ||
      !holding.roomName.startsWith(`phone-hold-${dialog.callId}_`) ||
      !/^[A-Za-z0-9-]{8,64}$/.test(suffix) ||
      (dialog.holding &&
        Object.keys(holdingSchema.shape).some(
          (key) =>
            dialog.holding![key as keyof PhoneHoldingBinding] !==
            holding[key as keyof PhoneHoldingBinding],
        ))
    )
      throw new HttpError(409, "Phone holding ownership mismatch");
    dialog.holding = holding;
  }
  bumpPhoneDialog(dialog);
}
export function canFinishPhoneDialog(
  dialog: PhoneDialog,
  proof: PhoneCleanupProof,
) {
  // A private current-owner assertion is accepted only after durable state and
  // server-side media enforcement agree. It cannot clear unknown old work.
  phoneCleanupProofSchema.parse(proof);
  if (
    dialog.state !== "stopping" ||
    dialog.uncertain ||
    Object.values(dialog.operations).some(
      (state) => state === "pending" || state === "unknown",
    )
  )
    throw new HttpError(409, "Phone dialog cleanup remains unresolved");
}

const ownerRevision = z
  .object({
    ownerId: z.string().uuid(),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export class PhoneDialogService {
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly media: Media,
  ) {}
  async claim(raw: unknown) {
    if (!this.config.phoneEnabled)
      throw new HttpError(503, "Phone access is disabled");
    return this.store.claimPhoneSupervisor(
      phoneSupervisorInputSchema.parse(raw),
    );
  }
  async create(raw: unknown) {
    if (!this.config.phoneEnabled)
      throw new HttpError(503, "Phone access is disabled");
    const input = phoneDialogInputSchema.parse(raw);
    if (input.trunkId !== this.config.phoneTrunkId)
      throw new HttpError(403, "Phone trunk unavailable");
    const existing = (
      await this.store.queryPhoneDialogs({ callId: input.callId })
    )[0];
    const retry =
      existing &&
      existing.state !== "closed" &&
      samePhoneDialog(existing, input);
    if (
      !retry &&
      !(await this.store.phoneAttempt(
        keyedDigest(
          this.config.secret,
          `phone-dialog-attempt:${input.trunkId}`,
        ),
        30,
        Date.now(),
      ))
    )
      throw new HttpError(429, "Phone dialog attempts exceeded");
    return this.store.createPhoneDialog(input, this.config.phoneMaxCalls);
  }
  async query(raw: unknown) {
    const query = z
      .union([
        z.object({ callId: z.string().uuid() }).strict(),
        z.object({ pbxId: label }).strict(),
      ])
      .parse(raw);
    return { dialogs: await this.store.queryPhoneDialogs(query) };
  }
  async change(callId: string, raw: unknown) {
    z.string().uuid().parse(callId);
    const body = ownerRevision
      .extend({ change: phoneDialogChangeSchema })
      .strict()
      .parse(raw);
    if (body.change.type === "begin" && !this.config.phoneEnabled)
      throw new HttpError(503, "Phone access is disabled");
    return this.store.changePhoneDialog(
      callId,
      body.ownerId,
      body.revision,
      body.change,
    );
  }
  async stop(callId: string, raw: unknown) {
    z.string().uuid().parse(callId);
    const body = ownerRevision.parse(raw);
    const stopped = await this.store.stopPhoneDialog(
      callId,
      body.ownerId,
      body.revision,
    );
    const { meeting, participant } = stopped;
    if (meeting && participant?.enforcementPending) {
      await this.media.remove(meeting, participant);
      await this.store.change(meeting.code, (state) => {
        const current = state.participants.find((p) => p.id === participant.id);
        if (current?.mediaVersion === participant.mediaVersion) {
          current.enforcementPending = false;
          delete current.previousRoom;
        }
      });
    }
    return stopped.dialog;
  }
  async finish(callId: string, raw: unknown) {
    z.string().uuid().parse(callId);
    const body = ownerRevision
      .extend({ proof: phoneCleanupProofSchema })
      .strict()
      .parse(raw);
    return this.store.finishPhoneDialog(
      callId,
      body.ownerId,
      body.revision,
      body.proof,
    );
  }
}
