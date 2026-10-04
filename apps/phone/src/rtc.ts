import {
  AudioFrame,
  AudioMixer,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "@livekit/rtc-node";
import { setTimeout as delay } from "node:timers/promises";
import { serviceUrl, type CallPolicy, type MeetingGrant } from "./authority.js";
import { openGateway, type GatewayProxy } from "./gateway.js";
import { FrameQueue } from "./audio.js";
import { isHoldingRoom } from "./holding-name.js";
import { AudioBridgeOpenError, type AudioBridge } from "./relay.js";

const RATE = 48000,
  CHANNELS = 1,
  SAMPLES = 960;
export interface HoldingLeg {
  url: string;
  token: string;
  roomName: string;
  participantIdentity: string;
}
export interface RtcBridgeConfig {
  holding: HoldingLeg;
  meetingOrigin: string;
  development?: boolean;
}
interface Reader {
  cancel(): Promise<void>;
}
interface MeetingLeg {
  active: boolean;
  room: Room;
  proxy: GatewayProxy;
  source?: AudioSource;
  track?: LocalAudioTrack;
  mixer: AudioMixer;
  readers: Map<string, Reader>;
  allowed: Set<string>;
  uplink: boolean;
  mixed: FrameQueue<AudioFrame>;
  abort: AbortController;
  tasks: Promise<void>[];
  pending: Promise<unknown>[];
}
async function bounded<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Phone media timed out")),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
function validateHolding(holding: HoldingLeg, development = false) {
  serviceUrl(holding.url, ["wss:", "ws:"], development);
  if (
    !isHoldingRoom(holding.roomName) ||
    !holding.participantIdentity ||
    holding.participantIdentity.length > 256
  )
    throw new Error("Invalid isolated holding room");
  // A consistency check only: the media server independently verifies the signature.
  const claims = JSON.parse(
    Buffer.from(holding.token.split(".")[1] ?? "", "base64url").toString(),
  );
  if (
    claims.video?.room !== holding.roomName ||
    claims.sub === holding.participantIdentity ||
    !claims.sub
  )
    throw new Error("Holding grant mismatch");
}
export function eligibleAudio(
  kind: TrackKind | undefined,
  source: TrackSource | undefined,
  identity: string,
  allowed: ReadonlySet<string>,
) {
  return (
    allowed.has(identity) &&
    kind === TrackKind.KIND_AUDIO &&
    [
      TrackSource.SOURCE_MICROPHONE,
      TrackSource.SOURCE_SCREENSHARE_AUDIO,
    ].includes(source!)
  );
}

export interface RtcResources {
  room(): Room;
  source(): AudioSource;
  track(name: string, source: AudioSource): LocalAudioTrack;
  mixer(): AudioMixer;
  gateway(
    grant: MeetingGrant,
    origin: string,
    development?: boolean,
  ): Promise<GatewayProxy>;
}
const resources: RtcResources = {
  room: () => new Room(),
  source: () => new AudioSource(RATE, CHANNELS, 100),
  track: (name, source) => LocalAudioTrack.createAudioTrack(name, source),
  mixer: () =>
    new AudioMixer(RATE, CHANNELS, {
      blocksize: SAMPLES,
      streamTimeoutMs: 60,
      capacity: 3,
    }),
  gateway: openGateway,
};

export class RtcBridge implements AudioBridge {
  private holding: Room;
  private holdingSource: AudioSource;
  private holdingTrack: LocalAudioTrack;
  private holdingReaders = new Map<string, Reader>();
  private current?: MeetingLeg;
  private closed = false;
  private abort = new AbortController();
  private holdingPump?: Promise<void>;
  private closePromise?: Promise<void>;
  private operations: Promise<void> = Promise.resolve();
  private holdingPending: Promise<unknown>[] = [];
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation);
    // Preserve each caller's rejection, but permit terminal cleanup to retry a failed leg.
    this.operations = task.then(
      () => {},
      () => {},
    );
    return task;
  }
  get needsReconnect() {
    return !this.current?.active;
  }
  refreshGrant(grant: MeetingGrant) {
    this.current?.proxy.updateGrant(grant);
  }
  constructor(
    private config: RtcBridgeConfig,
    private onFailure: () => void,
    private onDtmf: (digit: string) => void,
    private rtc: RtcResources = resources,
  ) {
    this.holding = rtc.room();
    this.holdingSource = rtc.source();
    this.holdingTrack = rtc.track("phone-return", this.holdingSource);
  }
  private fail = () => {
    if (!this.closed) {
      this.silence();
      this.onFailure();
    }
  };
  async open() {
    validateHolding(this.config.holding, this.config.development);
    serviceUrl(
      this.config.meetingOrigin,
      ["https:", "http:"],
      this.config.development,
    );
    this.holding.on(RoomEvent.Disconnected, this.fail);
    this.holding.on(RoomEvent.Reconnecting, this.fail);
    this.holding.on(RoomEvent.ParticipantDisconnected, (p) => {
      if (p.identity === this.config.holding.participantIdentity) this.fail();
    });
    this.holding.on(RoomEvent.DtmfReceived, (_code, digit, p) => {
      if (p.identity === this.config.holding.participantIdentity)
        this.onDtmf(digit);
    });
    this.holding.on(RoomEvent.TrackPublished, (publication, participant) =>
      this.subscribeNative(publication, participant),
    );
    this.holding.on(
      RoomEvent.TrackSubscribed,
      (track, publication, participant) =>
        this.nativeTrack(track, publication, participant),
    );
    this.holding.on(RoomEvent.TrackUnsubscribed, (_track, publication) =>
      this.cancelNative(publication.sid),
    );
    try {
      const connecting = this.holding.connect(
        this.config.holding.url,
        this.config.holding.token,
        {
          autoSubscribe: false,
          dynacast: false,
          dataStream: { maxPayloadByteLength: 1024 },
        },
      );
      this.holdingPending.push(connecting);
      await bounded(connecting);
      if (this.closed)
        throw new Error("Phone relay closed during holding connect");
      if (this.holding.name !== this.config.holding.roomName)
        throw new Error("Wrong holding room");
      const options = new TrackPublishOptions();
      options.source = TrackSource.SOURCE_MICROPHONE;
      const publishing = this.holding.localParticipant!.publishTrack(
        this.holdingTrack,
        options,
      );
      this.holdingPending.push(publishing);
      await bounded(publishing);
      if (this.closed)
        throw new Error("Phone relay closed during holding publish");
      // Exactly one paced output per phone, even when waiting or everyone is silent.
      // No sound device is opened: samples are encoded into this private room only.
      this.holdingPump = this.returnAudio().catch(this.fail);
    } catch (error) {
      await this.close();
      throw error;
    }
  }
  private async returnAudio() {
    while (!this.closed) {
      const leg = this.current;
      const frame = leg?.active ? leg.mixed.shift() : undefined;
      await this.holdingSource.captureFrame(
        frame ?? AudioFrame.create(RATE, CHANNELS, SAMPLES),
      );
      await delay(20, undefined, { signal: this.abort.signal }).catch(() => {});
    }
  }
  private subscribeNative(
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) {
    const allowed = new Set(
      this.current?.active && this.current.uplink
        ? [this.config.holding.participantIdentity]
        : [],
    );
    publication.setSubscribed(
      eligibleAudio(
        publication.kind,
        publication.source,
        participant.identity,
        allowed,
      ) && publication.source === TrackSource.SOURCE_MICROPHONE,
    );
  }
  private cancelNative(sid?: string) {
    if (!sid) return;
    const reader = this.holdingReaders.get(sid);
    this.holdingReaders.delete(sid);
    void reader?.cancel().catch(() => {});
  }
  private nativeTrack(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant,
  ) {
    const leg = this.current,
      sid = publication.sid;
    if (
      !sid ||
      !leg?.active ||
      !leg.uplink ||
      participant.identity !== this.config.holding.participantIdentity ||
      publication.source !== TrackSource.SOURCE_MICROPHONE ||
      track.kind !== TrackKind.KIND_AUDIO
    ) {
      publication.setSubscribed(false);
      return;
    }
    this.cancelNative(sid);
    const reader = new AudioStream(track, {
      sampleRate: RATE,
      numChannels: CHANNELS,
      frameSizeMs: 20,
    }).getReader();
    this.holdingReaders.set(sid, reader);
    const task = (async () => {
      try {
        while (leg.active && this.current === leg && leg.uplink) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!leg.active || this.current !== leg) break;
          await leg.source?.captureFrame(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
        if (this.holdingReaders.get(sid) === reader)
          this.holdingReaders.delete(sid);
      }
    })();
    leg.tasks.push(
      task.catch(() => {
        if (leg.active) this.fail();
      }),
    );
  }
  silence() {
    if (this.current) {
      this.current.active = false;
      this.current.mixed.clear();
      this.current.source?.clearQueue();
    }
    this.holdingSource.clearQueue();
    for (const p of this.holding.remoteParticipants.values())
      for (const publication of p.trackPublications.values())
        publication.setSubscribed(false);
  }
  meeting(grant: MeetingGrant | undefined, policy: CallPolicy) {
    this.silence();
    return this.enqueue(() => this.replaceMeeting(grant, policy));
  }
  private async replaceMeeting(
    grant: MeetingGrant | undefined,
    policy: CallPolicy,
  ) {
    await this.closeMeeting();
    if (this.closed || !grant) return;
    const proxy = await this.rtc.gateway(
      grant,
      this.config.meetingOrigin,
      this.config.development,
    );
    // Track the new resource before checking terminal state so a failed proxy close
    // remains part of final cleanup; no late connection may escape that cleanup.
    const leg: MeetingLeg = {
      active: false,
      room: this.rtc.room(),
      proxy,
      mixer: this.rtc.mixer(),
      readers: new Map(),
      allowed: new Set(grant.subscribeParticipantIds),
      uplink: policy.audioAllowed && !policy.muted,
      mixed: new FrameQueue(3),
      abort: new AbortController(),
      tasks: [],
      pending: [],
    };
    this.current = leg;
    const subscribe = (pub: RemoteTrackPublication, p: RemoteParticipant) =>
      pub.setSubscribed(
        leg.active &&
          eligibleAudio(pub.kind, pub.source, p.identity, leg.allowed),
      );
    leg.room.on(RoomEvent.TrackPublished, subscribe);
    leg.room.on(RoomEvent.TrackSubscribed, (track, pub, p) => {
      const sid = pub.sid;
      if (
        !sid ||
        !leg.active ||
        !eligibleAudio(track.kind, pub.source, p.identity, leg.allowed) ||
        leg.readers.has(sid)
      ) {
        pub.setSubscribed(false);
        return;
      }
      const reader = new AudioStream(track, {
        sampleRate: RATE,
        numChannels: CHANNELS,
        frameSizeMs: 20,
      }).getReader();
      const stream = {
        async *[Symbol.asyncIterator]() {
          try {
            while (leg.active) {
              const r = await reader.read();
              if (r.done || !leg.active) break;
              yield r.value;
            }
          } finally {
            await reader.cancel().catch(() => {});
          }
        },
      };
      leg.readers.set(sid, {
        async cancel() {
          leg.mixer.removeStream(stream);
          await reader.cancel();
        },
      });
      leg.mixer.addStream(stream);
    });
    leg.room.on(RoomEvent.TrackUnsubscribed, (_track, pub) => {
      if (!pub.sid) return;
      const reader = leg.readers.get(pub.sid);
      leg.readers.delete(pub.sid);
      void reader?.cancel().catch(() => {});
    });
    const disconnected = () => {
      if (!leg.active || this.closed) return;
      // Host permission changes deliberately remove the meeting participant.
      // Gate audio immediately, retire this leg, and require a fresh authority
      // poll before reconnecting. The native caller remains in isolation.
      this.silence();
      void this.enqueue(() => this.closeMeeting()).catch(this.fail);
    };
    leg.room.on(RoomEvent.Disconnected, disconnected);
    leg.room.on(RoomEvent.Reconnecting, disconnected);
    try {
      if (this.closed)
        throw new Error("Phone relay closed during gateway opening");
      const connecting = leg.room.connect(proxy.url, grant.token, {
        autoSubscribe: false,
        dynacast: false,
        dataStream: { maxPayloadByteLength: 1024 },
      });
      leg.pending.push(connecting);
      await bounded(connecting);
      if (this.closed || this.current !== leg)
        throw new Error("Phone relay closed during connect");
      if (leg.room.name?.startsWith("phone-hold-"))
        throw new Error("Meeting grant targets holding namespace");
      const identity = leg.room.localParticipant!.identity;
      leg.allowed.delete(identity);
      if (leg.uplink) {
        leg.source = this.rtc.source();
        leg.track = this.rtc.track("phone-microphone", leg.source);
        const options = new TrackPublishOptions();
        options.source = TrackSource.SOURCE_MICROPHONE;
        const publishing = leg.room.localParticipant!.publishTrack(
          leg.track,
          options,
        );
        leg.pending.push(publishing);
        await bounded(publishing);
      }
      if (this.closed || this.current !== leg)
        throw new Error("Phone relay closed during publish");
      leg.active = true;
      // A silence stream keeps the SDK mixer alive when its last speaker departs.
      leg.mixer.addStream({
        async *[Symbol.asyncIterator]() {
          while (leg.active) {
            await delay(20, undefined, { signal: leg.abort.signal }).catch(
              () => {},
            );
            if (leg.active) yield AudioFrame.create(RATE, CHANNELS, SAMPLES);
          }
        },
      });
      leg.tasks.push(
        (async () => {
          for await (const frame of leg.mixer) {
            if (!leg.active) break;
            leg.mixed.push(frame);
          }
        })().catch(() => {
          if (leg.active) this.fail();
        }),
      );
      for (const p of leg.room.remoteParticipants.values())
        for (const pub of p.trackPublications.values()) subscribe(pub, p);
      for (const p of this.holding.remoteParticipants.values())
        for (const pub of p.trackPublications.values())
          this.subscribeNative(pub, p);
    } catch (error) {
      await this.closeMeeting();
      throw error;
    }
  }
  private async closeMeeting() {
    const leg = this.current;
    if (!leg) return;
    leg.active = false;
    leg.abort.abort();
    leg.mixed.clear();
    leg.source?.clearQueue();
    this.holdingSource.clearQueue();
    // A timeout does not cancel SDK work. Await its settlement before disconnecting
    // so a late connect/publish cannot appear after a successful cleanup response.
    await Promise.allSettled(leg.pending);
    const nativeReaders = [...this.holdingReaders.entries()];
    const results = await Promise.allSettled([
      leg.proxy.close(),
      leg.room.disconnect(),
      ...nativeReaders.map(([, r]) => r.cancel()),
      ...Array.from(leg.readers.values(), (r) => r.cancel()),
      leg.mixer.aclose(),
    ]);
    await Promise.allSettled(leg.tasks);
    const tracks = await Promise.allSettled([
      leg.track ? leg.track.close(true) : leg.source?.close(),
    ]);
    this.holdingSource.clearQueue();
    if ([...results, ...tracks].some((r) => r.status === "rejected"))
      throw new Error("Meeting audio cleanup failed");
    for (const [sid, r] of nativeReaders)
      if (this.holdingReaders.get(sid) === r) this.holdingReaders.delete(sid);
    // Keep a failed leg reachable for final cleanup; only confirmed teardown retires it.
    if (this.current === leg) this.current = undefined;
  }
  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.silence();
    this.abort.abort();
    this.closePromise = this.enqueue(async () => {
      await Promise.allSettled(this.holdingPending);
      const results = await Promise.allSettled([
        this.closeMeeting(),
        this.holding.disconnect(),
        ...Array.from(this.holdingReaders.values(), (r) => r.cancel()),
      ]);
      const sources = await Promise.allSettled([
        this.holdingPump,
        this.holdingTrack.close(true),
      ]);
      if ([...results, ...sources].some((r) => r.status === "rejected"))
        throw new Error("Holding audio cleanup failed");
      this.holdingReaders.clear();
    });
    return this.closePromise;
  }
}
export async function openRtcBridge(
  config: RtcBridgeConfig,
  onFailure: () => void,
  onDtmf: (digit: string) => void,
  rtc?: RtcResources,
): Promise<AudioBridge> {
  const bridge = new RtcBridge(config, onFailure, onDtmf, rtc);
  try {
    await bridge.open();
    return bridge;
  } catch {
    // Preserve the resource owner even if open()'s own cleanup rejected.
    throw new AudioBridgeOpenError(bridge);
  }
}
