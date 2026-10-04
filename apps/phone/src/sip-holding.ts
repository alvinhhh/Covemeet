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

type SipAri = Pick<
  AriClient,
  | "originate"
  | "getChannel"
  | "getChannelVariable"
  | "hangup"
  | "createBridge"
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
  private uncertain = false;
  private native?: { room: string; identity: string };
  private rtc?: AudioBridge;
  constructor(
    private config: SipHoldingConfig,
    private ari: SipAri,
    private rooms: Rooms,
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
  private async mutate<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof AriRequestError) || error.outcome === "unknown")
        this.uncertain = true;
      throw new Error("SIP call setup failed");
    }
  }
  open(onFailure: () => void): Promise<AudioBridge> {
    if (this.opening) return this.opening;
    this.opening = this.connect(onFailure).catch((error) => {
      if (error instanceof AudioBridgeOpenError) throw error;
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
    this.check();
    await this.mutate(() =>
      this.ari.originate({
        channelId: this.outboundId,
        endpoint: `PJSIP/${this.destination}@${this.config.outboundEndpoint}`,
        appArgs: ["outbound", this.config.callId],
        timeoutSeconds: 5,
      }),
    );
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
    await this.mutate(() => this.ari.createBridge(this.bridgeId));
    this.check();
    await this.mutate(() =>
      this.ari.addChannel(this.bridgeId, this.outboundId),
    );
    this.check();
    await this.mutate(() =>
      this.ari.addChannel(this.bridgeId, this.config.callerChannelId),
    );
    this.check();
    return this.rtc;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    this.closing = (async () => {
      await this.opening?.catch(() => {});
      const results = await Promise.allSettled([
        this.ari.hangup(this.outboundId),
        this.ari.destroyBridge(this.bridgeId),
      ]);
      if (await this.ari.getChannel(this.outboundId))
        throw new Error("SIP outbound leg remains");
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
        for (const peer of peers) {
          if (
            peer.kind !== 3 ||
            peer.attributes["sip.trunkID"] !== this.config.sipTrunkId ||
            peer.attributes["sip.ruleID"] !== this.config.sipRuleId
          )
            continue;
          await this.rooms
            .removeParticipant(room.name, peer.identity)
            .catch((error) => {
              if (!absent(error)) throw error;
            });
        }
        const remaining = await this.rooms
          .listParticipants(room.name)
          .catch((error) => {
            if (absent(error)) return [];
            throw error;
          });
        if (remaining.some((peer) => peer.kind === 3))
          throw new Error("Native SIP participant remains");
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
