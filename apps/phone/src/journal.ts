import { createHash } from "node:crypto";
import { z } from "zod";
import { AriRequestError } from "./ari.js";
import { PhoneAuthorityRejected } from "./authority.js";

const label = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);
export const phoneDialogInputSchema = z
  .object({
    callId: z.string().uuid(),
    ownerId: z.string().uuid(),
    pbxId: label,
    pbxEpoch: label,
    callerChannelId: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/),
    trunkId: label,
    inboundEndpoint: label,
    outboundEndpoint: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    sipTrunkId: z.string().regex(/^ST_[A-Za-z0-9]{1,64}$/),
    sipRuleId: z.string().regex(/^SDR_[A-Za-z0-9]{1,64}$/),
  })
  .strict();
export type PhoneDialogInput = z.infer<typeof phoneDialogInputSchema>;
export const phoneMutationSchema = z.enum([
  "answer",
  "originate",
  "create-bridge",
  "attach-outbound",
  "attach-caller",
  "play",
]);
export type PhoneMutation = z.infer<typeof phoneMutationSchema>;
const nativeIdentity: string = `sip_${createHash("sha256").update("covemeet-pbx").digest("hex").slice(0, 16)}`;
export const phoneHoldingSchema = z
  .object({
    roomName: z.string().max(160),
    roomSid: z.string().regex(/^RM_[A-Za-z0-9]{1,64}$/),
    nativeIdentity: z.literal(nativeIdentity),
    nativeSid: z.string().regex(/^PA_[A-Za-z0-9]{1,64}$/),
  })
  .strict();
export type PhoneHoldingBinding = z.infer<typeof phoneHoldingSchema>;
export const phoneDialogChangeSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("begin"), operation: phoneMutationSchema })
    .strict(),
  z
    .object({
      type: z.literal("settle"),
      operation: phoneMutationSchema,
      outcome: z.enum(["confirmed", "rejected", "unknown"]),
    })
    .strict(),
  phoneHoldingSchema.extend({ type: z.literal("holding") }).strict(),
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
export const phoneDialogSchema = phoneDialogInputSchema
  .extend({
    state: z.enum(["open", "stopping", "closed"]),
    revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    operations: z.partialRecord(
      phoneMutationSchema,
      z.enum(["pending", "confirmed", "rejected", "unknown"]),
    ),
    uncertain: z.boolean(),
    holding: phoneHoldingSchema.optional(),
    binding: z
      .object({
        code: z.string().regex(/^[A-Z0-9]{6,48}$/),
        participantId: z.string().uuid(),
      })
      .strict()
      .optional(),
    playbackId: z
      .string()
      .regex(/^cm-play-[0-9a-f-]{36}-[1-9]\d{0,15}$/)
      .optional(),
    createdAt: z.number().int().positive(),
    updatedAt: z.number().int().positive(),
  })
  .strict()
  .superRefine((dialog, context) => {
    const prefix = `phone-hold-${dialog.callId}_`;
    if (
      dialog.holding &&
      (!dialog.holding.roomName.startsWith(prefix) ||
        !/^[A-Za-z0-9-]{8,64}$/.test(
          dialog.holding.roomName.slice(prefix.length),
        ))
    )
      context.addIssue({
        code: "custom",
        message: "Invalid phone holding ownership",
      });
    if (
      dialog.playbackId &&
      !dialog.playbackId.startsWith(`cm-play-${dialog.callId}-`)
    )
      context.addIssue({
        code: "custom",
        message: "Invalid phone playback ownership",
      });
  });
export type PhoneDialog = z.infer<typeof phoneDialogSchema>;
export const phoneDialogQuerySchema = z.union([
  z.object({ callId: z.string().uuid() }).strict(),
  z.object({ pbxId: label }).strict(),
]);
export type PhoneDialogQuery = z.infer<typeof phoneDialogQuerySchema>;
export const phoneDialogsSchema = z
  .object({ dialogs: z.array(phoneDialogSchema).max(20) })
  .strict();
export interface JournalAuthority {
  journalCreate(input: PhoneDialogInput): Promise<PhoneDialog>;
  journalQuery(query: PhoneDialogQuery): Promise<{ dialogs: PhoneDialog[] }>;
  journalChange(
    callId: string,
    ownerId: string,
    revision: number,
    change: PhoneDialogChange,
  ): Promise<PhoneDialog>;
  journalStop(
    callId: string,
    ownerId: string,
    revision: number,
  ): Promise<PhoneDialog>;
  journalFinish(
    callId: string,
    ownerId: string,
    revision: number,
    proof: PhoneCleanupProof,
  ): Promise<PhoneDialog>;
}
export interface CallJournal {
  readonly ownerId: string;
  readonly createOutcome: "unattempted" | "reserved" | "rejected" | "unknown";
  reserve(): Promise<void>;
  mutate<T>(
    operation: PhoneMutation,
    action: (dialog: PhoneDialog) => Promise<T>,
  ): Promise<T>;
  holding(binding: PhoneHoldingBinding): Promise<void>;
  uncertain(): Promise<void>;
  stop(): Promise<void>;
  finish(proof: PhoneCleanupProof): Promise<void>;
}
const unavailable = () => new Error("Phone dialog requires reconciliation");
class OwnedCallJournal implements CallJournal {
  private queue: Promise<unknown> = Promise.resolve();
  private outcome: CallJournal["createOutcome"] = "unattempted";
  private stopped = false;
  private ambiguous = false;
  get ownerId() {
    return this.input.ownerId;
  }
  get createOutcome() {
    return this.outcome;
  }
  constructor(
    private authority: JournalAuthority,
    private input: PhoneDialogInput,
  ) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const task = this.queue.then(action);
    this.queue = task.catch(() => {});
    return task;
  }
  private owned(raw: unknown): PhoneDialog {
    const parsed = phoneDialogSchema.safeParse(raw);
    if (
      !parsed.success ||
      Object.keys(this.input).some(
        (key) =>
          parsed.data[key as keyof PhoneDialogInput] !==
          this.input[key as keyof PhoneDialogInput],
      )
    )
      throw unavailable();
    return parsed.data;
  }
  private async current() {
    const result = phoneDialogsSchema.parse(
      await this.authority.journalQuery({ callId: this.input.callId }),
    );
    if (result.dialogs.length !== 1) throw unavailable();
    return this.owned(result.dialogs[0]);
  }
  private async change(change: PhoneDialogChange) {
    const before = await this.current();
    const after = this.owned(
      await this.authority.journalChange(
        this.input.callId,
        this.ownerId,
        before.revision,
        change,
      ),
    );
    if (after.revision !== before.revision + 1) throw unavailable();
    return after;
  }
  reserve(): Promise<void> {
    return this.serial(async () => {
      if (this.outcome !== "unattempted" || this.stopped) throw unavailable();
      this.outcome = "unknown";
      try {
        const dialog = this.owned(
          await this.authority.journalCreate(this.input),
        );
        this.outcome = "reserved";
        if (
          dialog.state !== "open" ||
          dialog.uncertain ||
          Object.keys(dialog.operations).length
        )
          throw unavailable();
      } catch (error) {
        if (
          error instanceof PhoneAuthorityRejected &&
          error.status >= 400 &&
          error.status < 500
        )
          this.outcome = "rejected";
        else this.ambiguous = true;
        throw unavailable();
      }
    });
  }
  mutate<T>(
    operation: PhoneMutation,
    action: (dialog: PhoneDialog) => Promise<T>,
  ): Promise<T> {
    phoneMutationSchema.parse(operation);
    return this.serial(async () => {
      if (this.stopped || this.outcome !== "reserved" || this.ambiguous)
        throw unavailable();
      let begun: PhoneDialog;
      try {
        begun = await this.change({ type: "begin", operation });
        if (
          begun.state !== "open" ||
          begun.uncertain ||
          begun.operations[operation] !== "pending"
        )
          throw unavailable();
      } catch {
        this.ambiguous = true;
        throw unavailable();
      }
      if (this.stopped) {
        await this.change({ type: "settle", operation, outcome: "rejected" });
        throw unavailable();
      }
      let result: T;
      try {
        result = await action(begun);
      } catch (error) {
        const outcome =
          error instanceof AriRequestError && error.outcome === "rejected"
            ? "rejected"
            : "unknown";
        if (outcome === "unknown") this.ambiguous = true;
        try {
          await this.change({ type: "settle", operation, outcome });
        } catch {
          this.ambiguous = true;
        }
        if (outcome === "rejected" && !this.ambiguous) throw error;
        throw unavailable();
      }
      try {
        const settled = await this.change({
          type: "settle",
          operation,
          outcome: "confirmed",
        });
        if (settled.operations[operation] !== "confirmed") throw unavailable();
      } catch {
        this.ambiguous = true;
        throw unavailable();
      }
      return result;
    });
  }
  holding(binding: PhoneHoldingBinding): Promise<void> {
    const parsed = phoneHoldingSchema.parse(binding);
    return this.serial(async () => {
      if (this.stopped || this.outcome !== "reserved" || this.ambiguous)
        throw unavailable();
      try {
        await this.change({ type: "holding", ...parsed });
      } catch {
        this.ambiguous = true;
        throw unavailable();
      }
    });
  }
  uncertain(): Promise<void> {
    this.ambiguous = true;
    return this.serial(async () => {
      await this.change({ type: "uncertain" });
    });
  }
  stop(): Promise<void> {
    this.stopped = true;
    return this.serial(async () => {
      if (this.outcome === "unattempted" || this.outcome === "rejected") return;
      const before = await this.current();
      if (this.ambiguous && !before.uncertain)
        await this.change({ type: "uncertain" });
      const current = await this.current();
      const stopped = this.owned(
        await this.authority.journalStop(
          this.input.callId,
          this.ownerId,
          current.revision,
        ),
      );
      if (stopped.state !== "stopping") throw unavailable();
    });
  }
  finish(proof: PhoneCleanupProof): Promise<void> {
    const parsed = phoneCleanupProofSchema.parse(proof);
    return this.serial(async () => {
      if (!this.stopped || this.outcome !== "reserved" || this.ambiguous)
        throw unavailable();
      const current = await this.current();
      if (
        current.state !== "stopping" ||
        current.uncertain ||
        Object.values(current.operations).some(
          (state) => state === "pending" || state === "unknown",
        )
      )
        throw unavailable();
      const finished = this.owned(
        await this.authority.journalFinish(
          this.input.callId,
          this.ownerId,
          current.revision,
          parsed,
        ),
      );
      if (finished.state !== "closed") throw unavailable();
    });
  }
}
export type JournalRegistryConfig = Omit<
  PhoneDialogInput,
  "callId" | "callerChannelId" | "trunkId" | "inboundEndpoint"
>;
/** The process may stop only records it created. PBX epoch is an operator label,
 * not proof that a previous owner or an in-flight PBX mutation has stopped. */
export class JournalRegistry {
  private ready = false;
  constructor(
    private authority: JournalAuthority,
    private config: JournalRegistryConfig,
  ) {
    phoneDialogInputSchema
      .omit({
        callId: true,
        callerChannelId: true,
        trunkId: true,
        inboundEndpoint: true,
      })
      .parse(config);
    this.config = { ...config };
  }
  async initialize(): Promise<void> {
    this.ready = false;
    const result = phoneDialogsSchema.parse(
      await this.authority.journalQuery({ pbxId: this.config.pbxId }),
    );
    if (
      result.dialogs.some(
        (dialog) =>
          dialog.pbxId !== this.config.pbxId || dialog.state !== "closed",
      )
    )
      throw unavailable();
    this.ready = true;
  }
  forCall(
    callId: string,
    callerChannelId: string,
    inboundEndpoint: string,
    trunkId: string,
  ): CallJournal {
    if (!this.ready) throw unavailable();
    return new OwnedCallJournal(
      this.authority,
      phoneDialogInputSchema.parse({
        ...this.config,
        callId,
        callerChannelId,
        inboundEndpoint,
        trunkId,
      }),
    );
  }
}
