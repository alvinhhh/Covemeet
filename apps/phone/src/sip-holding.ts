import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  AccessToken,
  ServerError,
  TrackSource,
  type RoomServiceClient,
} from "livekit-server-sdk";
import { AriRequestError, type AriClient } from "./ari.js";
import { serviceUrl } from "./authority.js";
import { AudioBridgeOpenError, type AudioBridge } from "./relay.js";
import { openRtcBridge } from "./rtc.js";
import { isHoldingRoom } from "./holding-name.js";
import type { SupervisedMedia } from "./supervisor.js";
import type { CallJournal, PhoneMutation } from "./journal.js";

type SipAri = Pick<
  AriClient,
  | "originate"
  | "getChannel"
  | "getChannelVariable"
  | "hangup"
  | "createBridge"
  | "getBridge"
  | "addChannel"
  | "destroyBridge"
>;
type Rooms = Pick<
  RoomServiceClient,
  "listRooms" | "listParticipants" | "removeParticipant"
>;
export interface SipHoldingConfig {
  callId: string;
  callerChannelId: string;
  outboundEndpoint: string;
  sipTrunkId: string;
  sipRuleId: string;
  livekitWsUrl: string;
  apiKey: string;
  apiSecret: string;
  meetingOrigin: string;
  development?: boolean;
}
const noRtc: AudioBridge = {
  silence() {},
  async meeting() {
    throw new Error("SIP holding media unavailable");
  },
  async close() {},
};
const absent = (error: unknown) =>
  error instanceof ServerError && error.code === "not_found";
// The PBX uses a fixed From user. LiveKit's hidePhoneNumber identity mapping
// hashes that user; a caller's telephone number never reaches holding metadata.
const nativeIdentity = `sip_${createHash("sha256").update("covemeet-pbx").digest("hex").slice(0, 16)}`;

/** Owns a single PBX outbound leg and a randomized native SIP holding room.
 * The original caller is never used as a dial string or native SIP identity. */
export class SipHolding implements SupervisedMedia {
  readonly destination: string;
  readonly outboundId: string;
  readonly bridgeId: string;
  private opening?: Promise<AudioBridge>;
  private closing?: Promise<void>;
  private stopped = false;
  private allocationAttempted = false;
  private outboundOwned = false;
  private bridgeOwned = false;
  private uncertain = false;
  private native?: { room: string; identity: string };
  private rtc?: AudioBridge;
  constructor(
    private config: SipHoldingConfig,
    private ari: SipAri,
    private rooms: Rooms,
    private journal: Pick<CallJournal, "mutate" | "holding" | "uncertain">,
    private openHolding: typeof openRtcBridge = openRtcBridge,
  ) {
    if (
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(config.callId) ||
      !/^[A-Za-z0-9_.:-]{1,128}$/.test(config.callerChannelId) ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(config.outboundEndpoint) ||
      !/^ST_[A-Za-z0-9]+$/.test(config.sipTrunkId) ||
      !/^SDR_[A-Za-z0-9]+$/.test(config.sipRuleId) ||
      !config.apiKey ||
      config.apiSecret.length < 32
    )
      throw new Error("Invalid SIP holding configuration");
    serviceUrl(config.livekitWsUrl, ["wss:", "ws:"], config.development);
    serviceUrl(config.meetingOrigin, ["https:", "http:"], config.development);
    this.destination = `phone-hold-${config.callId}`;
    this.outboundId = `cm-out-${config.callId}`;
    this.bridgeId = `cm-bridge-${config.callId}`;
  }
  private check() {
    if (this.stopped) throw new Error("SIP holding stopped");
  }
  private matchingRooms() {
    return this.rooms.listRooms().then((rooms) => {
      if (rooms.length > 10000)
        throw new Error("SIP room discovery limit exceeded");
      return rooms.filter((room) =>
        room.name.startsWith(`${this.destination}_`),
      );
    });
  }
  private async mutate<T>(
    name: PhoneMutation,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await this.journal.mutate(name, () => {
        // The durable intent round trip may finish after local termination.
        // No request was issued, so cancellation has a definitive outcome.
        if (this.stopped) throw new AriRequestError("rejected");
        return operation();
      });
    } catch (error) {
      if (!(error instanceof AriRequestError) || error.outcome === "unknown")
        this.uncertain = true;
      throw new Error("SIP call setup failed");
    }
  }
  open(onFailure: () => void): Promise<AudioBridge> {
    if (this.opening) return this.opening;
    this.opening = this.connect(onFailure).catch((error) => {
      if (error instanceof AudioBridgeOpenError) {
        this.rtc = error.bridge;
        throw error;
      }
      // A pre-answer holding connection may already own RTC resources. Its
      // cleanup and the independently owned native legs must both succeed.
      throw new AudioBridgeOpenError(this.rtc ?? noRtc);
    });
    return this.opening;
  }
  private async connect(onFailure: () => void): Promise<AudioBridge> {
    this.check();
    if ((await this.matchingRooms()).length)
      throw new Error("SIP dialog destination already exists");
    if (
      (await this.ari.getChannel(this.outboundId)) ||
      (await this.ari.getBridge(this.bridgeId))
    )
      throw new Error("SIP dialog resource already exists");
    this.check();
    await this.mutate("originate", async () => {
      this.check();
      this.allocationAttempted = true;
      const channel = await this.ari.originate({
        channelId: this.outboundId,
        endpoint: `PJSIP/${this.destination}@${this.config.outboundEndpoint}`,
        appArgs: ["outbound", this.config.callId],
        timeoutSeconds: 5,
      });
      this.outboundOwned = true;
      return channel;
    });
    this.check();
    const deadline = Date.now() + 6000;
    const relayIdentity = `cm-relay-${this.config.callId}`;
    let verified = false;
    while (Date.now() < deadline) {
      this.check();
      const channel = await this.ari.getChannel(this.outboundId);
      if (!channel) throw new Error("SIP outbound leg ended");
      if (channel.state === "Up") {
        const [endpoint, signaling, media] = await Promise.all([
          this.ari.getChannelVariable(this.outboundId, "CHANNEL(endpoint)"),
          this.ari.getChannelVariable(this.outboundId, "CHANNEL(pjsip,secure)"),
          this.ari.getChannelVariable(this.outboundId, "CHANNEL(rtp,secure)"),
        ]);
        if (
          endpoint !== this.config.outboundEndpoint ||
          signaling !== "1" ||
          media !== "1"
        )
          throw new Error("SIP transport encryption required");
      }
      const matches = await this.matchingRooms();
      if (matches.length > 1) throw new Error("Ambiguous SIP dialog binding");
      if (matches.length === 1) {
        const room = matches[0];
        if (
          !isHoldingRoom(room.name) ||
          room.maxParticipants !== 2 ||
          (this.native && this.native.room !== room.name)
        )
          throw new Error("Invalid SIP holding policy");
        const peers = await this.rooms.listParticipants(room.name);
        if (
          peers.length > (this.rtc ? 2 : 1) ||
          peers.some(
            (peer) =>
              peer.identity !== nativeIdentity &&
              !(this.rtc && peer.identity === relayIdentity),
          )
        )
          throw new Error("SIP holding isolation failed");
        const peer = peers.find((p) => p.identity === nativeIdentity);
        // ParticipantInfo.Kind.SIP is3 in the pinned LiveKit wire protocol.
        if (
          peer?.kind === 3 &&
          peer.attributes["sip.trunkID"] === this.config.sipTrunkId &&
          peer.attributes["sip.ruleID"] === this.config.sipRuleId &&
          ["ringing", "active"].includes(peer.attributes["sip.callStatus"])
        ) {
          this.native = { room: room.name, identity: peer.identity };
          if (!this.rtc) {
            await this.journal.holding({
              roomName: room.name,
              roomSid: room.sid,
              nativeIdentity: peer.identity,
              nativeSid: peer.sid,
            });
            // Native SIP waits to subscribe to remote audio before SIP 200.
            // Open only the isolated, silent holding leg at this point. No
            // original PBX bridge or meeting grant exists until verification.
            const token = new AccessToken(
              this.config.apiKey,
              this.config.apiSecret,
              { identity: relayIdentity, ttl: "2m" },
            );
            token.addGrant({
              room: room.name,
              roomJoin: true,
              canPublish: true,
              canSubscribe: true,
              canPublishData: false,
              canPublishSources: [TrackSource.MICROPHONE],
            });
            const jwt = await token.toJwt();
            this.check();
            try {
              this.rtc = await this.openHolding(
                {
                  holding: {
                    roomName: room.name,
                    participantIdentity: peer.identity,
                    url: this.config.livekitWsUrl,
                    token: jwt,
                  },
                  meetingOrigin: this.config.meetingOrigin,
                  development: this.config.development,
                },
                onFailure,
                () => {},
              );
            } catch (error) {
              if (error instanceof AudioBridgeOpenError)
                this.rtc = error.bridge;
              else {
                this.uncertain = true;
                await this.journal.uncertain().catch(() => {});
              }
              throw error;
            }
            this.check();
          }
          if (
            channel.state === "Up" &&
            peer.attributes["sip.callStatus"] === "active"
          ) {
            verified = true;
            break;
          }
        }
      }
      await delay(100);
    }
    if (!verified || !this.rtc)
      throw new Error("SIP call binding deadline exceeded");
    this.check();
    await this.mutate("create-bridge", async () => {
      const bridge = await this.ari.createBridge(this.bridgeId);
      this.bridgeOwned = true;
      return bridge;
    });
    this.check();
    await this.mutate("attach-outbound", () =>
      this.ari.addChannel(this.bridgeId, this.outboundId),
    );
    this.check();
    await this.mutate("attach-caller", () =>
      this.ari.addChannel(this.bridgeId, this.config.callerChannelId),
    );
    this.check();
    return this.rtc;
  }

  private async absentAfterTeardown(
    read: () => Promise<unknown>,
    owned: boolean,
  ): Promise<boolean> {
    // ARI can acknowledge a hangup before the channel disappears from reads.
    for (let attempt = 0; attempt <= 30; attempt++) {
      if (!(await read())) return true;
      if (!owned || attempt === 30) return false;
      await delay(100);
    }
    return false;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = (async () => {
      await this.opening?.catch(() => {});
      if (!this.allocationAttempted) {
        // A collision seen before allocation is not ownership. Preserve it for
        // reconciliation rather than deleting another dialog's resources.
        if (
          (await this.ari.getChannel(this.outboundId)) ||
          (await this.ari.getBridge(this.bridgeId)) ||
          (await this.matchingRooms()).length
        )
          throw new Error(
            "Unowned SIP holding resources require reconciliation",
          );
        return;
      }
      const results = await Promise.allSettled([
        this.rtc?.close(),
        this.outboundOwned
          ? this.ari.hangup(this.outboundId)
          : Promise.resolve(),
        this.bridgeOwned
          ? this.ari.destroyBridge(this.bridgeId)
          : Promise.resolve(),
      ]);
      if (
        !(await this.absentAfterTeardown(
          () => this.ari.getChannel(this.outboundId),
          this.outboundOwned,
        ))
      )
        throw new Error("SIP outbound leg remains");
      if (
        !(await this.absentAfterTeardown(
          () => this.ari.getBridge(this.bridgeId),
          this.bridgeOwned,
        ))
      )
        throw new Error("SIP bridge remains");
      const matches = await this.matchingRooms();
      for (const room of matches) {
        if (!isHoldingRoom(room.name))
          throw new Error("Invalid cleanup namespace");
        const peers = await this.rooms
          .listParticipants(room.name)
          .catch((error) => {
            if (absent(error)) return [];
            throw error;
          });
        let removalAttempted = false;
        for (const peer of peers) {
          if (
            !this.outboundOwned ||
            peer.kind !== 3 ||
            peer.identity !== nativeIdentity ||
            peer.attributes["sip.trunkID"] !== this.config.sipTrunkId ||
            peer.attributes["sip.ruleID"] !== this.config.sipRuleId
          )
            continue;
          removalAttempted = true;
          try {
            await this.rooms.removeParticipant(room.name, peer.identity);
          } catch {
            // SIP departure may race this removal. Allocation has stopped, so
            // the required empty-room read below can confirm absence instead.
            // Uncertain allocation or failed RTC/PBX cleanup still rejects.
          }
        }
        if (
          !(await this.absentAfterTeardown(async () => {
            const remaining = await this.rooms
              .listParticipants(room.name)
              .catch((error) => {
                if (absent(error)) return [];
                throw error;
              });
            return remaining.length ? remaining : undefined;
          }, removalAttempted))
        )
          throw new Error("SIP holding participant remains");
      }
      if (
        this.uncertain ||
        results.some((result) => result.status === "rejected")
      )
        throw new Error("SIP cleanup requires reconciliation");
    })();
    return this.closing;
  }
}
