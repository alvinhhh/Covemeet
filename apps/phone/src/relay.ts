import { setTimeout as delay } from "node:timers/promises";
import {
  PhoneActionDenied,
  PhoneAuthorityRejected,
  joinSchema,
  pollSchema,
  sessionSchema,
  type Authority,
  type CallAction,
  type CallPolicy,
  type JoinInput,
  type MeetingGrant,
  type PhoneSession,
} from "./authority.js";

export interface AudioBridge {
  /** Synchronous gate: discard buffered audio before asynchronous disconnect. */
  silence(): void;
  readonly needsReconnect?: boolean;
  refreshGrant?(grant: MeetingGrant): void;
  meeting(grant: MeetingGrant | undefined, policy: CallPolicy): Promise<void>;
  close(): Promise<void>;
}
/** A failed open still owns resources whose teardown must be verified. */
export class AudioBridgeOpenError extends Error {
  constructor(readonly bridge: AudioBridge) {
    super("Phone media opening failed");
  }
}
export type PhoneMediaStage =
  | "gateway"
  | "connect"
  | "publish"
  | "active"
  | "cleanup";
export class PhoneMediaStageError extends Error {
  constructor(
    readonly stage: PhoneMediaStage,
    readonly detail: RelayFailureDetail = {},
  ) {
    super("Phone meeting media failed");
  }
}
export interface RelayFailureDetail {
  httpStatus?: number;
  timedOut?: boolean;
  transportFailed?: boolean;
}
export type RelayFailureStage =
  | "join"
  | "holding-open"
  | "holding-disconnected"
  | "authority-poll"
  | "authority-toggle-mute"
  | "authority-toggle-hand"
  | "media-gateway"
  | "media-connect"
  | "media-publish"
  | "media-active"
  | "media-cleanup"
  | "media-bridge"
  | "lease-expired"
  | "cleanup"
  | "relay-unexpected";
export interface RelayDependencies {
  authority: Authority;
  openBridge(
    onFailure: () => void,
    onDtmf: (digit: string) => void,
  ): Promise<AudioBridge>;
  /** Must remove only this call's native SIP participant; carrier hangup is a separate adapter. */
  terminateNative(): Promise<void>;
  /** Fixed stage labels only: no caller, meeting, credential, URL or raw error. */
  onFailureStage?(stage: RelayFailureStage, detail?: RelayFailureDetail): void;
  now?: () => number;
  pollIntervalMs?: number;
}

export class PhoneRelay {
  private session?: PhoneSession;
  private joining?: Promise<PhoneSession>;
  private opening?: Promise<AudioBridge>;
  private bridge?: AudioBridge;
  private stopped = false;
  private failed = false;
  private failureStage?: RelayFailureStage;
  private leaseTimer?: ReturnType<typeof setTimeout>;
  private deadline = 0;
  private policyKey = "";
  private actionQueue: Promise<void> = Promise.resolve();
  private stopPromise?: Promise<void>;
  private dtmfPrefix = false;
  private dtmfAt = 0;
  private dtmfActionAt = 0;
  private readonly abort = new AbortController();
  private readonly now: () => number;
  private readonly interval: number;
  constructor(
    private input: JoinInput,
    private deps: RelayDependencies,
  ) {
    joinSchema.parse(input);
    this.input = { ...input };
    this.now = deps.now ?? Date.now;
    this.interval = deps.pollIntervalMs ?? 2000;
    if (this.interval < 100 || this.interval > 2000)
      throw new Error("Invalid phone poll interval");
  }
  private gate() {
    this.bridge?.silence();
  }
  private reportFailure(stage: RelayFailureStage, detail?: RelayFailureDetail) {
    if (this.failureStage) return;
    this.failureStage = stage;
    try {
      this.deps.onFailureStage?.(stage, detail);
    } catch {
      /* Logging cannot affect call cleanup. */
    }
  }
  private arm(policy: CallPolicy) {
    const now = this.now();
    this.deadline = Math.min(
      policy.leaseExpiresAt,
      policy.expiresAt,
      now + 10000,
    );
    if (this.deadline <= now) throw new Error("Phone lease expired");
    clearTimeout(this.leaseTimer);
    this.leaseTimer = setTimeout(() => {
      this.failed = true;
      this.reportFailure("lease-expired");
      this.gate();
      void this.stop().catch(() => {});
    }, this.deadline - now);
  }
  async run(): Promise<void> {
    if (this.stopped) return;
    try {
      this.joining = this.deps.authority
        .join(this.input)
        .then((value) => sessionSchema.parse(value));
      this.session = await this.joining;
      // PIN/caller identity are never retained for polling or added to media metadata.
      this.input.pin = "";
      delete this.input.callerId;
      if (this.session.expiresAt <= this.now()) {
        this.reportFailure("lease-expired");
        throw new Error("Phone session expired");
      }
      if (this.stopped) return;
      this.arm({
        state: "waiting",
        mediaVersion: 0,
        muted: true,
        handRaised: false,
        audioAllowed: false,
        leaseExpiresAt: this.now() + 10000,
        expiresAt: this.session.expiresAt,
      });
      this.opening = Promise.resolve().then(() =>
        this.deps.openBridge(
          () => {
            if (this.stopped) return;
            this.failed = true;
            this.reportFailure("holding-disconnected");
            this.gate();
            void this.stop().catch(() => {});
          },
          (digit) => this.dtmf(digit),
        ),
      );
      try {
        this.bridge = await this.opening;
      } catch (error) {
        if (!this.stopped) this.reportFailure("holding-open");
        throw error;
      }
      if (this.stopped) return;
      while (!this.stopped) {
        await this.action("poll");
        if (!this.stopped)
          await delay(this.interval, undefined, { signal: this.abort.signal });
      }
    } catch (error) {
      if (!this.stopped) {
        this.reportFailure(this.session ? "relay-unexpected" : "join");
        await this.stop();
        throw new Error(
          "Phone relay stopped after an authority or media failure",
        );
      }
    } finally {
      await this.stop();
    }
    if (this.failed)
      throw new Error(
        "Phone relay stopped after an authority or media failure",
      );
  }
  action(action: CallAction): Promise<void> {
    if (action === "leave") return this.stop();
    const task = this.actionQueue.then(async () => {
      if (this.stopped || !this.session) return;
      if (this.now() >= this.deadline) {
        this.reportFailure("lease-expired");
        throw new Error("Phone lease expired");
      }
      let policy: CallPolicy;
      try {
        policy = pollSchema.parse(
          await this.deps.authority.action(
            this.session,
            this.input.callId,
            action,
          ),
        );
      } catch (error) {
        if (action === "toggle-mute" && error instanceof PhoneActionDenied)
          return;
        this.reportFailure(
          `authority-${action}` as RelayFailureStage,
          error instanceof PhoneAuthorityRejected
            ? { httpStatus: error.status }
            : undefined,
        );
        throw error;
      }
      if (this.stopped) return;
      if (policy.state === "ended") {
        await this.stop();
        return;
      }
      this.arm(policy);
      if (policy.state === "admitted" && !policy.grant)
        throw new Error("Admitted phone grant missing");
      if (
        policy.grant &&
        policy.grant.cookie !==
          `mp_${this.session.code}=${this.session.sessionToken}`
      )
        throw new Error("Phone grant session mismatch");
      const key = JSON.stringify([
        policy.state,
        policy.mediaVersion,
        policy.muted,
        policy.audioAllowed,
        [...(policy.grant?.subscribeParticipantIds ?? [])].sort(),
      ]);
      if (
        key !== this.policyKey ||
        (policy.state === "admitted" && this.bridge?.needsReconnect)
      ) {
        this.gate();
        try {
          await this.bridge?.meeting(
            policy.state === "admitted" ? policy.grant : undefined,
            policy,
          );
        } catch (error) {
          if (!this.stopped)
            this.reportFailure(
              error instanceof PhoneMediaStageError
                ? `media-${error.stage}`
                : "media-bridge",
              error instanceof PhoneMediaStageError ? error.detail : undefined,
            );
          throw error;
        }
        if (this.stopped) {
          this.gate();
          return;
        }
        if (this.now() >= this.deadline) {
          this.reportFailure("lease-expired");
          throw new Error("Phone lease expired during media connection");
        }
        this.policyKey = key;
      } else if (policy.grant) {
        this.bridge?.refreshGrant?.(policy.grant);
      }
    });
    this.actionQueue = task.catch(async () => {
      if (!this.stopped) {
        this.failed = true;
        this.reportFailure("relay-unexpected");
      }
      this.gate();
      await this.stop().catch(() => {});
    });
    return task;
  }
  private dtmf(digit: string) {
    const now = this.now();
    if (!/^[0-9*#]$/.test(digit) || this.stopped) return;
    if (digit === "*") {
      this.dtmfPrefix = true;
      this.dtmfAt = now;
      return;
    }
    const prefix = this.dtmfPrefix && now - this.dtmfAt < 3000;
    this.dtmfPrefix = false;
    if (!prefix || now - this.dtmfActionAt < 500) return;
    const action =
      digit === "6" ? "toggle-mute" : digit === "9" ? "toggle-hand" : undefined;
    if (action) {
      this.dtmfActionAt = now;
      void this.action(action).catch(() => {});
    }
    // *0/announcements require the later Asterisk IVR adapter, not an invented action.
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopped = true;
    this.gate();
    clearTimeout(this.leaseTimer);
    this.abort.abort();
    this.stopPromise = (async () => {
      const session =
        this.session ?? (await this.joining?.catch(() => undefined));
      const closeBridge = async () => {
        const bridge =
          this.bridge ??
          (await this.opening?.catch((error) => {
            if (error instanceof AudioBridgeOpenError) return error.bridge;
            // An unknown rejection cannot prove that an opening allocated no media.
            throw new Error("Phone opening cleanup unknown");
          }));
        bridge?.silence();
        await bridge?.close();
      };
      const results = await Promise.allSettled([
        closeBridge(),
        this.deps.terminateNative(),
      ]);
      // Retain a generic failure for the supervisor to reconcile; never print capabilities.
      if (results.some((r) => r.status === "rejected"))
        throw new Error("Phone cleanup incomplete; reconciliation required");
      // Only acknowledge leave after BOTH media paths are confirmed closed.
      // An uncertain cleanup retains the authority's reserved capacity.
      if (session)
        await this.deps.authority.action(session, this.input.callId, "leave");
    })().catch((error) => {
      this.reportFailure("cleanup");
      throw error;
    });
    return this.stopPromise;
  }
}
