import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { z } from "zod";
import { RoomServiceClient } from "livekit-server-sdk";
import { AriClient } from "./ari.js";
import { HttpAuthority, serviceUrl } from "./authority.js";
import {
  JournalRegistry,
  phoneRuntimeSchema,
  phoneSupervisorInputSchema,
} from "./journal.js";
import { SipHolding } from "./sip-holding.js";
import { SipSupervisor } from "./supervisor.js";

const label = z.string().regex(/^[A-Za-z0-9_.:-]{1,80}$/);
const secret = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const managedSchema = phoneSupervisorInputSchema.extend({
  pbxEpoch: z.string().regex(/^[0-9a-f]{64}$/),
  runtime: phoneRuntimeSchema,
});
export type ManagedPhoneRuntime = z.infer<typeof managedSchema>;

export function loadManagedPhoneConfig(env: NodeJS.ProcessEnv) {
  if (
    env.NODE_ENV !== "production" ||
    env.PHONE_ENABLED !== "true" ||
    env.NODE_TLS_REJECT_UNAUTHORIZED === "0"
  )
    throw new Error(
      "Managed phone service requires enabled production configuration",
    );
  return {
    authorityUrl: serviceUrl(env.PHONE_AUTHORITY_URL ?? "", ["https:"]).origin,
    ariUrl: serviceUrl(env.PHONE_ARI_URL ?? "", ["https:"]).origin,
    livekitUrl: serviceUrl(env.LIVEKIT_URL ?? "", ["https:"]).origin,
    livekitWsUrl: serviceUrl(env.PHONE_LIVEKIT_WS_URL ?? "", ["wss:"]).origin,
    meetingOrigin: serviceUrl(env.SITE_ORIGIN ?? "", ["https:"]).origin,
    gatewayKey: secret.parse(env.PHONE_GATEWAY_KEY),
    ariUsername: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,64}$/)
      .parse(env.PHONE_ARI_USERNAME),
    ariPassword: secret.parse(env.PHONE_ARI_PASSWORD),
    apiKey: z.string().min(1).max(256).parse(env.LIVEKIT_API_KEY),
    apiSecret: secret.parse(env.LIVEKIT_API_SECRET),
    pbxId: label.parse(env.PHONE_PBX_ID),
    ownerId: z.string().uuid().parse(env.PHONE_OWNER_ID),
    trunkId: label.parse(env.PHONE_TRUNK_ID),
    sipTrunkId: z
      .string()
      .regex(/^ST_[A-Za-z0-9]{1,64}$/)
      .parse(env.PHONE_SIP_TRUNK_ID),
    sipRuleId: z
      .string()
      .regex(/^SDR_[A-Za-z0-9]{1,64}$/)
      .parse(env.PHONE_SIP_RULE_ID),
    maxCalls: z.coerce
      .number()
      .int()
      .min(1)
      .max(20)
      .parse(env.PHONE_MAX_CALLS ?? "2"),
    maxCallMs:
      z.coerce
        .number()
        .int()
        .min(1)
        .max(7200)
        .parse(env.PHONE_MAX_DURATION_SECONDS ?? "7200") * 1000,
    runtimeFile: z.string().min(1).max(4096).parse(env.PHONE_MANAGED_FILE),
  };
}
export type ManagedPhoneConfig = ReturnType<typeof loadManagedPhoneConfig>;

export async function readManagedPhoneRuntime(
  config: ManagedPhoneConfig,
): Promise<ManagedPhoneRuntime> {
  const handle = await open(
    config.runtimeFile,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > 32768 ||
      (info.mode & 0o077) !== 0 ||
      (process.getuid && info.uid !== process.getuid())
    )
      throw new Error("Managed phone runtime must be a private owned file");
    const buffer = Buffer.alloc(32769);
    try {
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(
          buffer,
          offset,
          buffer.length - offset,
          null,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      if (offset > 32768) throw new Error("Managed phone runtime is too large");
      const runtime = managedSchema.parse(
        JSON.parse(buffer.subarray(0, offset).toString("utf8")),
      );
      if (runtime.pbxId !== config.pbxId || runtime.ownerId !== config.ownerId)
        throw new Error("Managed phone runtime does not match this supervisor");
      return runtime;
    } finally {
      buffer.fill(0);
    }
  } finally {
    await handle.close();
  }
}

/** The separate Docker manager must claim this exact runtime before it starts. */
export async function runManagedPhone(
  config: ManagedPhoneConfig,
  runtime: ManagedPhoneRuntime,
  signal: AbortSignal,
  readiness: (ready: boolean) => Promise<void>,
): Promise<void> {
  signal.throwIfAborted();
  const authority = new HttpAuthority(config.authorityUrl, config.gatewayKey);
  const rooms = new RoomServiceClient(
    config.livekitUrl,
    config.apiKey,
    config.apiSecret,
  );
  const registry = new JournalRegistry(authority, {
    ...runtime,
    outboundEndpoint: "covemeet-livekit",
    sipTrunkId: config.sipTrunkId,
    sipRuleId: config.sipRuleId,
  });
  let finish!: () => void;
  const stopped = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let failed = false;
  let supervisor: SipSupervisor | undefined;
  const stop = () => {
    // stop() gates new calls and existing audio before its first await.
    void supervisor?.stop().catch(() => {
      failed = true;
    });
    finish();
  };
  const ari = new AriClient({
    baseUrl: config.ariUrl,
    username: config.ariUsername,
    password: config.ariPassword,
    app: "covemeet",
    onEvent: (event) => supervisor?.onEvent(event),
    onFailure() {
      failed = true;
      stop();
    },
  });
  supervisor = new SipSupervisor(
    {
      inboundContext: "covemeet-inbound",
      inboundExtension: "7000",
      inboundEndpoint: "twilio-inbound",
      trunkId: config.trunkId,
      maxCalls: config.maxCalls,
      maxCallMs: config.maxCallMs,
    },
    ari,
    authority,
    (callId, callerChannelId, journal) =>
      new SipHolding(
        {
          callId,
          callerChannelId,
          outboundEndpoint: "covemeet-livekit",
          sipTrunkId: config.sipTrunkId,
          sipRuleId: config.sipRuleId,
          livekitWsUrl: config.livekitWsUrl,
          apiKey: config.apiKey,
          apiSecret: config.apiSecret,
          meetingOrigin: config.meetingOrigin,
        },
        ari,
        rooms,
        journal,
      ),
    registry,
  );
  signal.addEventListener("abort", stop, { once: true });
  try {
    signal.throwIfAborted();
    await readiness(false);
    await registry.initialize();
    signal.throwIfAborted();
    if (failed) throw new Error("Phone service stopped during initialization");
    await ari.connect();
    signal.throwIfAborted();
    if (failed) throw new Error("Phone service stopped during connection");
    await readiness(true);
    await stopped;
  } finally {
    signal.removeEventListener("abort", stop);
    try {
      await readiness(false);
    } finally {
      try {
        await supervisor.stop();
      } finally {
        await ari.close();
      }
    }
  }
  if (failed) throw new Error("Phone service requires managed recovery");
}
