import { randomUUID } from "node:crypto";
import {
  AriRequestError,
  type AriClient,
  type AriEvent,
  type AriChannel,
} from "./ari.js";
import type { Authority, CallPolicy, MeetingGrant } from "./authority.js";
import { AudioBridgeOpenError, PhoneRelay, type AudioBridge } from "./relay.js";
import type { CallJournal, JournalRegistry } from "./journal.js";

export type SupervisorAri = Pick<
  AriClient,
  | "answer"
  | "getChannelVariable"
  | "hangup"
  | "getChannel"
  | "play"
  | "stopPlayback"
>;
export interface SupervisedMedia {
  open(onFailure: () => void): Promise<AudioBridge>;
  /** Confirm every native/PBX leg is absent, including late opening work. */
  close(): Promise<void>;
}
export interface SupervisorConfig {
  inboundContext: string;
  inboundExtension: string;
  inboundEndpoint: string;
  trunkId: string;
  maxCalls?: number;
  credentialTimeoutMs?: number;
  maxCallMs?: number;
}
interface Playback {
  id: string;
  finish(error?: Error): void;
  creating?: Promise<unknown>;
}
interface Call {
  id: string;
  channel: AriChannel;
  phase: "checking" | "code" | "pin" | "joining" | "active" | "closed";
  digits: string;
  locator: string;
  prefixAt: number;
  actionAt: number;
  queued: number;
  queue: Promise<void>;
  setup?: Promise<void>;
  playback?: Playback;
  timer: ReturnType<typeof setTimeout>;
  lifetime: ReturnType<typeof setTimeout>;
  relay?: PhoneRelay;
  media?: SupervisedMedia;
  journal: CallJournal;
  journalStopping?: Promise<void>;
  stopping?: Promise<void>;
}
const error = () => new Error("Phone call control unavailable");
const names = new Set([
  "code",
  "pin",
  "waiting",
  "admitted",
  "muted",
  "unmuted",
  "blocked",
  "help",
  "invalid",
]);

/** One ARI application owns the calls. A lost event stream is terminal: callers
 * are gated and disconnected, never silently adopted by a replacement worker. */
export class SipSupervisor {
  private calls = new Map<string, Call>();
  private terminal = false;
  private readonly maxCalls: number;
  private readonly credentialMs: number;
  private readonly maxCallMs: number;
  constructor(
    private config: SupervisorConfig,
    private ari: SupervisorAri,
    private authority: Authority,
    private createMedia: (
      callId: string,
      callerChannelId: string,
      journal: CallJournal,
    ) => SupervisedMedia,
    private journals: Pick<JournalRegistry, "forCall">,
  ) {
    for (const value of [
      config.inboundContext,
      config.inboundEndpoint,
      config.trunkId,
    ])
      if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(value))
        throw new Error("Invalid phone supervisor configuration");
    if (!/^\d{1,16}$/.test(config.inboundExtension))
      throw new Error("Invalid inbound extension");
    this.maxCalls = config.maxCalls ?? 20;
    this.credentialMs = config.credentialTimeoutMs ?? 60_000;
    this.maxCallMs = config.maxCallMs ?? 7_200_000;
    if (
      !Number.isInteger(this.maxCalls) ||
      this.maxCalls < 1 ||
      this.maxCalls > 20 ||
      !Number.isInteger(this.credentialMs) ||
      this.credentialMs < 100 ||
      this.credentialMs > 60_000 ||
      !Number.isInteger(this.maxCallMs) ||
      this.maxCallMs < 100 ||
      this.maxCallMs > 7_200_000
    )
      throw new Error("Invalid phone supervisor limits");
  }
  get status() {
    return {
      accepting: !this.terminal,
      calls: this.calls.size,
      unresolved: [...this.calls.values()].filter((c) => c.phase === "closed")
        .length,
    };
  }
  private isClosed(call: Call) {
    return call.phase === "closed";
  }
  onEvent(event: AriEvent): void {
    if (event.type === "PlaybackFinished") {
      for (const call of this.calls.values())
        if (call.playback?.id === event.playback.id) {
          if (event.playback.target_uri !== `channel:${call.channel.id}`)
            return;
          call.playback.finish(
            event.playback.state === "done" ? undefined : error(),
          );
          return;
        }
      return;
    }
    if (event.type === "BridgeDestroyed") {
      for (const call of this.calls.values())
        if (
          event.bridge.id === `cm-bridge-${call.id}` &&
          call.phase !== "closed"
        )
          void this.stopCall(call).catch(() => {});
      return;
    }
    if (!("channel" in event)) return;
    const call =
      this.calls.get(event.channel.id) ??
      [...this.calls.values()].find(
        (c) => event.channel.id === `cm-out-${c.id}`,
      );
    if (call) {
      if (
        ["StasisEnd", "ChannelDestroyed", "ChannelHangupRequest"].includes(
          event.type,
        )
      ) {
        void this.stopCall(call).catch(() => {});
      } else if (
        event.type === "ChannelDtmfReceived" &&
        event.channel.id === call.channel.id
      ) {
        if (call.phase === "closed") return;
        if (++call.queued > 32) {
          void this.stopCall(call).catch(() => {});
          return;
        }
        call.queue = call.queue
          .then(() => this.digit(call, event.digit))
          .catch(() => this.stopCall(call))
          .finally(() => {
            call.queued--;
          });
        void call.queue.catch(() => {});
      }
      return;
    }
    if (event.type !== "StasisStart") return;
    if (
      event.args.length !== 1 ||
      event.args[0] !== "inbound" ||
      event.channel.dialplan?.context !== this.config.inboundContext ||
      event.channel.dialplan.exten !== this.config.inboundExtension ||
      this.terminal ||
      this.calls.size >= this.maxCalls
    ) {
      void this.ari.hangup(event.channel.id).catch(() => {});
      return;
    }
    this.startCall(event.channel);
  }
  private startCall(channel: AriChannel) {
    const id = randomUUID();
    let journal: CallJournal;
    try {
      journal = this.journals.forCall(
        id,
        channel.id,
        this.config.inboundEndpoint,
        this.config.trunkId,
      );
    } catch {
      void this.ari.hangup(channel.id).catch(() => {});
      return;
    }
    const call: Call = {
      id,
      channel,
      phase: "checking",
      digits: "",
      locator: "",
      prefixAt: 0,
      actionAt: 0,
      queued: 0,
      queue: Promise.resolve(),
      journal,
      timer: setTimeout(() => {
        void this.stopCall(call).catch(() => {});
      }, this.credentialMs),
      lifetime: setTimeout(() => {
        void this.stopCall(call).catch(() => {});
      }, this.maxCallMs),
    };
    this.calls.set(channel.id, call);
    call.setup = (async () => {
      if (
        (await this.ari.getChannelVariable(channel.id, "CHANNEL(endpoint)")) !==
        this.config.inboundEndpoint
      )
        throw error();
      if (this.isClosed(call)) return;
      await call.journal.reserve();
      if (this.isClosed(call)) return;
      try {
        call.media = this.createMedia(id, channel.id, call.journal);
      } catch {
        await call.journal.uncertain().catch(() => {});
        throw error();
      }
      await call.journal.mutate("answer", () => {
        // A journal round trip may finish after local termination. No ARI
        // request has been issued, so this cancellation is definitive.
        if (this.isClosed(call)) throw new AriRequestError("rejected");
        return this.ari.answer(channel.id);
      });
      const [signaling, media] = await Promise.all([
        this.ari.getChannelVariable(channel.id, "CHANNEL(pjsip,secure)"),
        this.ari.getChannelVariable(channel.id, "CHANNEL(rtp,secure)"),
      ]);
      if (signaling !== "1" || media !== "1") throw error();
      if (this.isClosed(call)) return;
      call.phase = "code";
      await this.prompt(call, "code", false);
    })();
    void call.setup.catch(() => this.stopCall(call)).catch(() => {});
  }
  private async digit(call: Call, digit: string) {
    if (
      call.phase === "closed" ||
      call.phase === "checking" ||
      !/^[0-9*#]$/.test(digit)
    )
      return;
    if (call.phase === "code" || call.phase === "pin") {
      await this.cancelPrompt(call);
      if (this.isClosed(call)) return;
      if (digit === "*") {
        call.digits = "";
        return;
      }
      const size = call.phase === "code" ? 12 : 8;
      if (digit !== "#") {
        if (call.digits.length >= size) {
          await this.stopCall(call);
          return;
        }
        call.digits += digit;
        return;
      }
      if (call.digits.length !== size) {
        await this.stopCall(call);
        return;
      }
      if (call.phase === "code") {
        call.locator = call.digits;
        call.digits = "";
        call.phase = "pin";
        await this.prompt(call, "pin", false);
        return;
      }
      const pin = call.digits,
        locator = call.locator;
      call.digits = "";
      call.locator = "";
      call.phase = "joining";
      clearTimeout(call.timer);
      const caller = call.channel.caller?.number;
      // Keep the original number only long enough to derive the authority's
      // occurrence-scoped hash. It never becomes the outbound SIP From user.
      call.channel = { ...call.channel, caller: undefined };
      call.relay = new PhoneRelay(
        {
          locator,
          pin,
          callId: call.id,
          ownerId: call.journal.ownerId,
          trunkId: this.config.trunkId,
          ...(/^\+[1-9]\d{6,14}$/.test(caller ?? "")
            ? { callerId: caller }
            : {}),
        },
        {
          authority: {
            join: async (input) => {
              try {
                return await this.authority.join(input);
              } catch {
                await this.prompt(call, "invalid", true).catch(() => {});
                throw error();
              }
            },
            action: (session, callId, action) =>
              this.authority.action(session, callId, action),
          },
          openBridge: async (failure) => {
            try {
              await this.prompt(call, "waiting", true);
              if (this.isClosed(call)) throw error();
            } catch {
              // No RTC allocation has begun. Native cleanup is still independently required.
              throw new AudioBridgeOpenError({
                silence() {},
                async meeting() {
                  throw error();
                },
                async close() {},
              });
            }
            if (!call.media) throw error();
            const bridge = await call.media.open(failure);
            if (call.phase !== "closed") call.phase = "active";
            let previous: CallPolicy | undefined;
            return {
              silence: () => bridge.silence(),
              get needsReconnect() {
                return bridge.needsReconnect;
              },
              refreshGrant: (grant) => bridge.refreshGrant?.(grant),
              close: async () => {
                const stopped = await this.stopJournal(call).then(
                  () => true,
                  () => false,
                );
                await bridge.close();
                if (!stopped) throw error();
              },
              meeting: async (
                grant: MeetingGrant | undefined,
                policy: CallPolicy,
              ) => {
                bridge.silence();
                if (policy.state === "admitted") {
                  const notice =
                    previous?.state !== "admitted"
                      ? "admitted"
                      : previous.audioAllowed && !policy.audioAllowed
                        ? "blocked"
                        : previous.muted !== policy.muted
                          ? policy.muted
                            ? "muted"
                            : "unmuted"
                          : undefined;
                  if (notice) await this.prompt(call, notice, true);
                }
                if (call.phase === "closed") throw error();
                await bridge.meeting(grant, policy);
                previous = policy;
              },
            };
          },
          terminateNative: () => this.closeNative(call),
        },
      );
      void call.relay
        .run()
        .catch(() => {})
        .finally(() => this.stopCall(call))
        .catch(() => {});
      return;
    }
    if (call.phase !== "active" || !call.relay) return;
    const now = Date.now();
    if (digit === "*") {
      call.prefixAt = now;
      return;
    }
    const prefixed = call.prefixAt > 0 && now - call.prefixAt < 3000;
    call.prefixAt = 0;
    if (!prefixed || now - call.actionAt < 500) return;
    call.actionAt = now;
    if (digit === "0") await this.prompt(call, "help", false);
    else if (digit === "6") await call.relay.action("toggle-mute");
    else if (digit === "9") await call.relay.action("toggle-hand");
  }
  private async cancelPrompt(call: Call) {
    const playback = call.playback;
    if (!playback) return;
    call.playback = undefined;
    playback.finish(error());
    // DELETE before a pending POST finishes could return 404 and leave a late
    // announcement playing. Preserve ownership until creation has settled.
    await playback.creating?.catch(() => {});
    if (playback.id) await this.ari.stopPlayback(playback.id);
  }
  private async prompt(call: Call, name: string, wait: boolean) {
    if (call.phase === "closed" || !names.has(name)) throw error();
    await this.cancelPrompt(call);
    if (this.isClosed(call)) throw error();
    let finish!: (reason?: Error) => void;
    const done = new Promise<void>((resolve, reject) => {
      finish = (reason) => (reason ? reject(reason) : resolve());
    });
    void done.catch(() => {});
    const playback: Playback = { id: "", finish };
    call.playback = playback;
    const timer = setTimeout(() => finish(error()), 8000);
    try {
      const creating = call.journal.mutate("play", (dialog) => {
        if (this.isClosed(call)) throw new AriRequestError("rejected");
        if (!dialog.playbackId) throw error();
        playback.id = dialog.playbackId;
        return this.ari.play(call.channel.id, playback.id, `covemeet-${name}`);
      });
      playback.creating = creating;
      const result = await creating;
      if (result.state === "failed") throw error();
      if (result.state === "done") finish();
      if (this.isClosed(call)) throw error();
      if (wait) await done;
      else
        void done
          .finally(() => {
            clearTimeout(timer);
          })
          .catch(() => {});
    } catch {
      clearTimeout(timer);
      finish(error());
      throw error();
    } finally {
      if (wait) {
        clearTimeout(timer);
        if (call.playback === playback) call.playback = undefined;
      }
    }
  }
  private markClosed(call: Call) {
    call.phase = "closed";
    call.digits = "";
    call.locator = "";
    clearTimeout(call.timer);
    clearTimeout(call.lifetime);
    call.playback?.finish(error());
  }
  private stopJournal(call: Call): Promise<void> {
    this.markClosed(call);
    return (call.journalStopping ??= (async () => {
      // No late answer or initial playback may outlive the terminal marker.
      await call.setup?.catch(() => {});
      await call.journal.stop();
    })());
  }
  private async closeNative(call: Call) {
    // Revocation is attempted first; a lost authority response must never
    // prevent best-effort carrier teardown or release an uncertain slot.
    const stopped = await this.stopJournal(call).then(
      () => true,
      () => false,
    );
    const results = await Promise.allSettled([
      this.cancelPrompt(call),
      this.ari.hangup(call.channel.id),
      call.media?.close(),
    ]);
    const remains = await this.ari.getChannel(call.channel.id);
    if (
      !stopped ||
      remains ||
      results.some((result) => result.status === "rejected")
    )
      throw error();
  }
  private stopCall(call: Call): Promise<void> {
    if (call.stopping) return call.stopping;
    this.markClosed(call);
    call.stopping = (async () => {
      if (call.relay) await call.relay.stop();
      else await this.closeNative(call);
      if (call.journal.createOutcome === "unknown") throw error();
      if (call.journal.createOutcome === "reserved")
        await call.journal.finish({
          allocationsStopped: true,
          callerAbsent: true,
          outboundAbsent: true,
          bridgeAbsent: true,
          nativeAbsent: true,
          holdingRelayAbsent: true,
          rtcClosed: true,
        });
      this.calls.delete(call.channel.id);
    })();
    // Keep uncertain calls counted against the local cap for reconciliation.
    return call.stopping;
  }
  async stop(): Promise<void> {
    this.terminal = true;
    const results = await Promise.allSettled(
      [...this.calls.values()].map((call) => this.stopCall(call)),
    );
    if (results.some((result) => result.status === "rejected")) throw error();
  }
}
