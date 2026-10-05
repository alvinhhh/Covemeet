import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { RoomServiceClient } from "livekit-server-sdk";
import { SipHolding, type SipHoldingConfig } from "../src/sip-holding.js";
import { AriRequestError, type AriClient } from "../src/ari.js";
import { AudioBridgeOpenError, type AudioBridge } from "../src/relay.js";
import type { openRtcBridge } from "../src/rtc.js";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Holding fixture condition timed out");
}
function fixture() {
  const config: SipHoldingConfig = {
    callId: randomUUID(),
    callerChannelId: "inbound-123",
    outboundEndpoint: "covemeet-livekit",
    sipTrunkId: "ST_fixture",
    sipRuleId: "SDR_fixture",
    livekitWsUrl: "wss://holding.internal",
    apiKey: "fixture-key",
    apiSecret: "s".repeat(48),
    meetingOrigin: "https://meeting.internal",
  };
  const log: string[] = [];
  const native = {
    sid: "PA_fixture",
    identity: `sip_${createHash("sha256").update("covemeet-pbx").digest("hex").slice(0, 16)}`,
    kind: 3,
    attributes: {
      "sip.trunkID": config.sipTrunkId,
      "sip.ruleID": config.sipRuleId,
      "sip.callStatus": "active",
    },
  };
  const room = {
    sid: "RM_fixture",
    name: `phone-hold-${config.callId}_abcdefgh`,
    maxParticipants: 2,
  };
  let rooms = [room];
  let peers = [native];
  let originated = false;
  let channelLive = false;
  let bridgeLive = false;
  let channelState = "Up";
  const rtc: AudioBridge = {
    silence() {
      log.push("rtc:silence");
    },
    async meeting() {
      throw new Error("Holding setup must not access meeting media");
    },
    async close() {
      log.push("rtc:close");
    },
  };
  const factory: { open: typeof openRtcBridge } = {
    async open() {
      return rtc;
    },
  };
  const opened: Parameters<typeof openRtcBridge>[0][] = [];
  const ari: Pick<
    AriClient,
    | "originate"
    | "getChannel"
    | "getChannelVariable"
    | "hangup"
    | "createBridge"
    | "getBridge"
    | "addChannel"
    | "destroyBridge"
  > = {
    async originate(input) {
      log.push(`originate:${input.endpoint}`);
      originated = true;
      channelLive = true;
      return {
        id: input.channelId,
        name: "PJSIP/covemeet-livekit-fixture",
        state: channelState,
      };
    },
    async getChannel(id) {
      log.push(`get:${id}`);
      return channelLive
        ? { id, name: "PJSIP/covemeet-livekit-fixture", state: channelState }
        : undefined;
    },
    async getChannelVariable(_id, variable) {
      log.push(`verify:${variable}`);
      return variable === "CHANNEL(endpoint)" ? config.outboundEndpoint : "1";
    },
    async hangup(id) {
      log.push(`hangup:${id}`);
      channelLive = false;
    },
    async createBridge(id) {
      log.push(`bridge:${id}`);
      bridgeLive = true;
      return { id, channels: [] };
    },
    async addChannel(bridgeId, channelId) {
      log.push(`add:${bridgeId}:${channelId}`);
    },
    async destroyBridge(id) {
      log.push(`destroy:${id}`);
      bridgeLive = false;
    },
    async getBridge(id) {
      log.push(`get-bridge:${id}`);
      return bridgeLive ? { id, channels: [] } : undefined;
    },
  };
  const service = {
    async listRooms() {
      return originated ? rooms : [];
    },
    async listParticipants(name: string) {
      log.push(`peers:${name}`);
      return peers;
    },
    async removeParticipant(name: string, identity: string) {
      log.push(`remove:${name}:${identity}`);
      peers = peers.filter((p) => p.identity !== identity);
    },
  };
  const journal = {
    async mutate<T>(name: string, operation: () => Promise<T>) {
      log.push(`journal:begin:${name}`);
      const value = await operation();
      log.push(`journal:confirmed:${name}`);
      return value;
    },
    async holding(fields: {
      roomName: string;
      roomSid: string;
      nativeIdentity: string;
      nativeSid: string;
    }) {
      assert.equal(fields.roomSid, room.sid);
      assert.equal(fields.nativeSid, native.sid);
      log.push(`journal:holding:${fields.roomName}`);
    },
    async uncertain() {
      log.push("journal:uncertain");
    },
  };
  const holding = new SipHolding(
    config,
    ari,
    service as unknown as Pick<
      RoomServiceClient,
      "listRooms" | "listParticipants" | "removeParticipant"
    >,
    journal,
    async (...args) => {
      log.push("rtc:open");
      opened.push(args[0]);
      return factory.open(...args);
    },
  );
  return {
    config,
    log,
    ari,
    service,
    holding,
    journal,
    native,
    room,
    rtc,
    factory,
    opened,
    setRooms(value: typeof rooms) {
      rooms = value;
    },
    setPeers(value: typeof peers) {
      peers = value;
    },
    setOriginated(value: boolean) {
      originated = value;
    },
    setChannel(value: boolean) {
      channelLive = value;
    },
    setChannelState(value: string) {
      channelState = value;
    },
  };
}

test("holding configuration fixes random namespace, endpoint and SIP identifiers", () => {
  const f = fixture();
  assert.equal(f.holding.destination, `phone-hold-${f.config.callId}`);
  assert.equal(f.holding.outboundId, `cm-out-${f.config.callId}`);
  assert.equal(f.holding.bridgeId, `cm-bridge-${f.config.callId}`);
  for (const change of [
    { callId: "meeting-code" },
    { outboundEndpoint: "evil@remote" },
    { sipTrunkId: "wrong" },
    { sipRuleId: "wrong" },
    { livekitWsUrl: "ws://public.example" },
    { meetingOrigin: "http://public.example" },
    { apiSecret: "short" },
  ]) {
    assert.throws(
      () =>
        new SipHolding(
          { ...f.config, ...change },
          f.ari,
          f.service as never,
          f.journal,
        ),
    );
  }
});

test("holding binds matching trunk/rule and secure PJSIP to a scoped audio-only RTC grant", async () => {
  const f = fixture();
  assert.equal(await f.holding.open(() => {}), f.rtc);
  assert(
    f.log.includes(
      `originate:PJSIP/phone-hold-${f.config.callId}@covemeet-livekit`,
    ),
  );
  assert(f.log.includes(`bridge:${f.holding.bridgeId}`));
  const holding = f.opened[0].holding;
  assert.equal(holding.roomName, f.room.name);
  assert.equal(holding.participantIdentity, f.native.identity);
  assert.equal(holding.url, f.config.livekitWsUrl);
  const claims = JSON.parse(
    Buffer.from(holding.token.split(".")[1], "base64url").toString(),
  );
  assert.equal(claims.sub, `cm-relay-${f.config.callId}`);
  assert.deepEqual(claims.video, {
    room: f.room.name,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
    canPublishSources: ["microphone"],
  });
  assert(claims.exp - claims.nbf <= 120);
  assert.deepEqual(
    f.log.filter((item) => item.startsWith("add:")),
    [
      `add:${f.holding.bridgeId}:${f.holding.outboundId}`,
      `add:${f.holding.bridgeId}:${f.config.callerChannelId}`,
    ],
  );
  await f.rtc.close();
  await f.holding.close();
  assert(f.log.includes(`hangup:${f.holding.outboundId}`));
  assert(f.log.includes(`remove:${f.room.name}:${f.native.identity}`));
});

for (const field of ["endpoint", "signaling", "media"])
  test(`holding rejects wrong ${field} before native binding or RTC`, async () => {
    const f = fixture(),
      original = f.ari.getChannelVariable;
    const variable =
      field === "endpoint"
        ? "CHANNEL(endpoint)"
        : field === "signaling"
          ? "CHANNEL(pjsip,secure)"
          : "CHANNEL(rtp,secure)";
    f.ari.getChannelVariable = async (id, name) =>
      name === variable ? "wrong" : original(id, name);
    await assert.rejects(
      f.holding.open(() => {}),
      AudioBridgeOpenError,
    );
    assert.equal(
      f.log.some((item) => item.startsWith("bridge:")),
      false,
    );
    assert.equal(f.opened.length, 0);
    await f.holding.close();
  });

test("holding refuses pre-existing or ambiguous destinations and larger rooms", async () => {
  const existing = fixture();
  existing.setOriginated(true);
  await assert.rejects(
    existing.holding.open(() => {}),
    AudioBridgeOpenError,
  );
  assert.equal(
    existing.log.some((item) => item.startsWith("originate:")),
    false,
  );
  await assert.rejects(existing.holding.close(), /Unowned SIP holding/);
  assert.equal(
    existing.log.some(
      (entry) => entry.startsWith("remove:") || entry.startsWith("hangup:"),
    ),
    false,
  );
  const ambiguous = fixture();
  ambiguous.setRooms([
    ambiguous.room,
    {
      ...ambiguous.room,
      name: `phone-hold-${ambiguous.config.callId}_ijklmnop`,
    },
  ]);
  await assert.rejects(
    ambiguous.holding.open(() => {}),
    AudioBridgeOpenError,
  );
  assert.equal(
    ambiguous.log.some((item) => item.startsWith("bridge:")),
    false,
  );
  await ambiguous.holding.close();
  const capacity = fixture();
  capacity.room.maxParticipants = 3;
  await assert.rejects(
    capacity.holding.open(() => {}),
    AudioBridgeOpenError,
  );
  assert.equal(
    capacity.log.some((item) => item.startsWith("bridge:")),
    false,
  );
  await capacity.holding.close();
});

test("holding refuses multiple native peers even when both share the trusted trunk", async () => {
  const f = fixture();
  f.setPeers([f.native, { ...f.native, identity: "second-sip" }]);
  await assert.rejects(
    f.holding.open(() => {}),
    AudioBridgeOpenError,
  );
  assert.equal(
    f.log.some((item) => item.startsWith("bridge:")),
    false,
  );
  await assert.rejects(f.holding.close(), /SIP holding participant remains/);
  assert.equal(
    f.log.some((entry) => entry.endsWith(":second-sip")),
    false,
  );
});

for (const wrong of ["trunk", "rule", "kind", "status", "identity"])
  test(`holding rejects wrong participant ${wrong} without touching a meeting room`, async () => {
    const f = fixture();
    const attributes = { ...f.native.attributes };
    if (wrong === "trunk") attributes["sip.trunkID"] = "ST_other";
    if (wrong === "rule") attributes["sip.ruleID"] = "SDR_other";
    if (wrong === "status") attributes["sip.callStatus"] = "ended";
    f.setPeers([
      {
        ...f.native,
        identity: wrong === "identity" ? "sip-unrelated" : f.native.identity,
        kind: wrong === "kind" ? 0 : 3,
        attributes,
      },
    ]);
    let checks = 0;
    const original = f.ari.getChannel;
    f.ari.getChannel = async (id) => (++checks > 2 ? undefined : original(id));
    await assert.rejects(
      f.holding.open(() => {}),
      AudioBridgeOpenError,
    );
    assert.equal(
      f.log.some((item) => item.startsWith("bridge:")),
      false,
    );
    // Cleanup never removes another trunk/rule's identity; that unresolved SIP
    // participant must retain capacity instead of claiming the room is clean.
    if (["trunk", "rule", "kind", "identity"].includes(wrong)) {
      await assert.rejects(
        f.holding.close(),
        /SIP holding participant remains/,
      );
      assert.equal(
        f.log.some((item) => item.startsWith("remove:")),
        false,
      );
    } else await f.holding.close();
  });

test("unknown originate outcome remains unresolved despite immediate channel absence", async () => {
  const f = fixture();
  f.ari.originate = async () => {
    throw new AriRequestError("unknown");
  };
  await assert.rejects(
    f.holding.open(() => {}),
    AudioBridgeOpenError,
  );
  await assert.rejects(f.holding.close(), /reconciliation/);
  assert.equal(f.log.includes(`hangup:${f.holding.outboundId}`), false);
  assert.equal(f.log.includes(`destroy:${f.holding.bridgeId}`), false);
});

test("late originate is awaited and removed before cleanup can finish", async () => {
  const f = fixture(),
    pending = deferred<void>();
  const original = f.ari.originate;
  f.ari.originate = async (input) => {
    f.log.push("originate:pending");
    await pending.promise;
    return original(input);
  };
  const opening = f.holding.open(() => {}).catch((error) => error);
  await until(() => f.log.includes("originate:pending"));
  let closed = false;
  const closing = f.holding.close().then(() => {
    closed = true;
  });
  await delay(10);
  assert.equal(closed, false);
  assert.equal(
    f.log.some((item) => item.startsWith("hangup:")),
    false,
  );
  pending.resolve();
  assert((await opening) instanceof AudioBridgeOpenError);
  await closing;
  assert.equal(
    f.log.some((item) => item.startsWith("bridge:")),
    false,
  );
  assert(f.log.includes(`hangup:${f.holding.outboundId}`));
});

test("holding cleanup does not touch unrelated rooms and fails if scoped channel remains", async () => {
  const f = fixture();
  f.setOriginated(true);
  f.setRooms([
    { name: "meeting-real", maxParticipants: 100 },
    { name: `phone-hold-${randomUUID()}_abcdefgh`, maxParticipants: 2 },
  ]);
  await f.holding.close();
  assert.equal(
    f.log.some(
      (item) => item.startsWith("peers:") || item.startsWith("remove:"),
    ),
    false,
  );
  const stuck = fixture();
  stuck.ari.getChannel = async (id) => ({
    id,
    name: "PJSIP/fixture",
    state: "Up",
  });
  await assert.rejects(stuck.holding.close(), /Unowned SIP holding/);
});

test("ringing opens silent holding before Up, but the PBX bridge waits for encryption verification", async () => {
  const f = fixture(),
    verified = deferred();
  f.setChannelState("Ringing");
  f.native.attributes["sip.callStatus"] = "ringing";
  const original = f.ari.getChannelVariable;
  f.ari.getChannelVariable = async (id, variable) => {
    await verified.promise;
    return original(id, variable);
  };
  const opening = f.holding.open(() => {});
  await until(() => f.opened.length === 1);
  assert.equal(
    f.log.some((entry) => entry.startsWith("bridge:")),
    false,
  );
  assert.equal(
    f.log.some((entry) => entry.startsWith("verify:")),
    false,
  );
  f.setChannelState("Up");
  f.native.attributes["sip.callStatus"] = "active";
  await delay(120);
  assert.equal(
    f.log.some((entry) => entry.startsWith("bridge:")),
    false,
  );
  verified.resolve();
  assert.equal(await opening, f.rtc);
  assert.equal(f.opened.length, 1);
  assert(
    f.log.indexOf("rtc:open") < f.log.indexOf("verify:CHANNEL(rtp,secure)"),
  );
  assert(
    f.log.indexOf("verify:CHANNEL(rtp,secure)") <
      f.log.indexOf(`bridge:${f.holding.bridgeId}`),
  );
  await Promise.all([f.rtc.close(), f.holding.close()]);
});

test("an insecure Up result after early holding returns the owned RTC connection for teardown", async () => {
  const f = fixture();
  f.setChannelState("Ringing");
  f.native.attributes["sip.callStatus"] = "ringing";
  f.factory.open = async () => {
    f.setChannelState("Up");
    f.native.attributes["sip.callStatus"] = "active";
    return f.rtc;
  };
  const original = f.ari.getChannelVariable;
  f.ari.getChannelVariable = async (id, variable) =>
    variable === "CHANNEL(rtp,secure)" ? "0" : original(id, variable);
  const error = await f.holding.open(() => {}).catch((error: unknown) => error);
  assert(error instanceof AudioBridgeOpenError);
  assert.equal(error.bridge, f.rtc);
  assert.equal(
    f.log.some((entry) => entry.startsWith("bridge:")),
    false,
  );
  await Promise.all([error.bridge.close(), f.holding.close()]);
  assert(f.log.includes("rtc:close"));
  assert(f.log.includes(`remove:${f.room.name}:${f.native.identity}`));
});

test("late PBX setup rejection preserves RTC ownership without adding the caller", async () => {
  const f = fixture();
  f.ari.createBridge = async () => {
    throw new AriRequestError("rejected", 403);
  };
  const error = await f.holding.open(() => {}).catch((error: unknown) => error);
  assert(error instanceof AudioBridgeOpenError);
  assert.equal(error.bridge, f.rtc);
  assert.equal(f.opened.length, 1);
  assert.equal(
    f.log.some((entry) => entry.startsWith("add:")),
    false,
  );
  await Promise.all([error.bridge.close(), f.holding.close()]);
});

test("partial RTC opening errors preserve their exact teardown owner", async () => {
  const f = fixture(),
    partial: AudioBridge = {
      silence() {},
      async meeting() {},
      async close() {
        f.log.push("partial:close");
      },
    };
  const expected = new AudioBridgeOpenError(partial);
  f.factory.open = async () => {
    throw expected;
  };
  const error = await f.holding.open(() => {}).catch((error: unknown) => error);
  assert.equal(error, expected);
  assert.equal(
    f.log.some((entry) => entry.startsWith("bridge:")),
    false,
  );
  await Promise.all([expected.bridge.close(), f.holding.close()]);
  assert(f.log.includes("partial:close"));
});

test("close during pending silent RTC setup waits and exposes the late connection without bridging", async () => {
  const f = fixture(),
    pending = deferred<AudioBridge>();
  f.factory.open = () => pending.promise;
  const opening = f.holding.open(() => {}).catch((error: unknown) => error);
  await until(() => f.opened.length === 1);
  let closed = false;
  const closing = f.holding.close().then(() => {
    closed = true;
  });
  await delay(10);
  assert.equal(closed, false);
  assert.equal(
    f.log.some((entry) => entry.startsWith("hangup:")),
    false,
  );
  pending.resolve(f.rtc);
  const error = await opening;
  assert(error instanceof AudioBridgeOpenError);
  assert.equal(error.bridge, f.rtc);
  await Promise.all([closing, error.bridge.close()]);
  assert.equal(
    f.log.some(
      (entry) => entry.startsWith("bridge:") || entry.startsWith("add:"),
    ),
    false,
  );
  assert.equal(closed, true);
});

test("a changed native room after early RTC setup never bridges the original caller", async () => {
  const f = fixture();
  f.setChannelState("Ringing");
  f.native.attributes["sip.callStatus"] = "ringing";
  f.factory.open = async () => {
    f.setRooms([{ ...f.room, name: `phone-hold-${f.config.callId}_ijklmnop` }]);
    return f.rtc;
  };
  const error = await f.holding.open(() => {}).catch((error: unknown) => error);
  assert(error instanceof AudioBridgeOpenError);
  assert.equal(error.bridge, f.rtc);
  assert.equal(
    f.log.some((entry) => entry.startsWith("bridge:")),
    false,
  );
  await Promise.all([error.bridge.close(), f.holding.close()]);
});

test("holding persists allocating intent and exact native binding before resource use", async () => {
  const f = fixture();
  await f.holding.open(() => {});
  assert(
    f.log.indexOf("journal:begin:originate") <
      f.log.findIndex((v) => v.startsWith("originate:")),
  );
  assert(
    f.log.indexOf(`journal:holding:${f.room.name}`) < f.log.indexOf("rtc:open"),
  );
  assert(
    f.log.indexOf("journal:begin:create-bridge") <
      f.log.indexOf(`bridge:${f.holding.bridgeId}`),
  );
  await f.holding.close();
});

test("successful bridge deletion acknowledgement does not prove actual bridge absence", async () => {
  const f = fixture();
  await f.holding.open(() => {});
  f.ari.destroyBridge = async () => {};
  await assert.rejects(f.holding.close(), /SIP bridge remains/);
});

test("holding closure waits for its RTC owner and preserves an unrelated peer", async () => {
  const f = fixture(),
    pending = deferred();
  await f.holding.open(() => {});
  f.setPeers([f.native, { ...f.native, identity: "unrelated-peer", kind: 0 }]);
  f.rtc.close = async () => {
    await pending.promise;
  };
  let settled = false;
  const closing = f.holding
    .close()
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });
  await delay(10);
  assert.equal(settled, false);
  pending.resolve();
  assert.match((await closing).message, /SIP holding participant remains/);
  assert.equal(
    f.log.some((entry) => entry.endsWith(":unrelated-peer")),
    false,
  );
});

test("native removal rejection can finish only after observing an empty room", async () => {
  const f = fixture();
  await f.holding.open(() => {});
  const remove = f.service.removeParticipant;
  f.service.removeParticipant = async (name, identity) => {
    await remove(name, identity);
    throw new Error("Native peer left during removal");
  };
  await f.holding.close();
  assert(
    f.log.lastIndexOf(`peers:${f.room.name}`) >
      f.log.indexOf(`remove:${f.room.name}:${f.native.identity}`),
  );
});

test("native removal rejection cannot finish while the peer remains", async () => {
  const f = fixture();
  await f.holding.open(() => {});
  f.service.removeParticipant = async () => {
    throw new Error("Native removal unavailable");
  };
  await assert.rejects(f.holding.close(), /SIP holding participant remains/);
});

test("native removal rejection cannot hide a failed absence check", async () => {
  const f = fixture();
  await f.holding.open(() => {});
  const remove = f.service.removeParticipant;
  const readError = new Error("Participant verification unavailable");
  f.service.removeParticipant = async (name, identity) => {
    await remove(name, identity);
    f.service.listParticipants = async () => {
      throw readError;
    };
    throw new Error("Native peer left during removal");
  };
  await assert.rejects(f.holding.close(), (error) => error === readError);
});

test("an empty room after rejected removal cannot hide failed RTC cleanup", async () => {
  const f = fixture();
  await f.holding.open(() => {});
  const remove = f.service.removeParticipant;
  f.service.removeParticipant = async (name, identity) => {
    await remove(name, identity);
    throw new Error("Native peer left during removal");
  };
  f.rtc.close = async () => {
    throw new Error("RTC cleanup unavailable");
  };
  await assert.rejects(
    f.holding.close(),
    /SIP cleanup requires reconciliation/,
  );
});

test("unknown RTC setup is journaled and cannot acknowledge cleanup", async () => {
  const f = fixture();
  f.factory.open = async () => {
    throw new Error("unknown allocation outcome");
  };
  await assert.rejects(
    f.holding.open(() => {}),
    AudioBridgeOpenError,
  );
  assert(f.log.includes("journal:uncertain"));
  await assert.rejects(f.holding.close(), /reconciliation/);
});

test("a deferred outbound collision is quarantined without deleting the conflicting resource", async () => {
  const f = fixture();
  f.ari.originate = async () => {
    f.setChannel(true);
    throw new AriRequestError("rejected", 409);
  };
  await assert.rejects(
    f.holding.open(() => {}),
    AudioBridgeOpenError,
  );
  await assert.rejects(f.holding.close(), /outbound leg remains/);
  assert.equal(f.log.includes(`hangup:${f.holding.outboundId}`), false);
  assert.equal(f.log.includes(`destroy:${f.holding.bridgeId}`), false);
});

test("a rejected bridge collision does not become bridge ownership", async () => {
  const f = fixture();
  let conflicting = false;
  f.ari.createBridge = async () => {
    conflicting = true;
    throw new AriRequestError("rejected", 409);
  };
  f.ari.getBridge = async (id) =>
    conflicting ? { id, channels: ["unrelated"] } : undefined;
  await assert.rejects(
    f.holding.open(() => {}),
    AudioBridgeOpenError,
  );
  await assert.rejects(f.holding.close(), /SIP bridge remains/);
  assert(f.log.includes(`hangup:${f.holding.outboundId}`));
  assert.equal(f.log.includes(`destroy:${f.holding.bridgeId}`), false);
});

for (const stage of [
  "originate",
  "create-bridge",
  "attach-outbound",
  "attach-caller",
]) {
  test(`late ${stage} journal acknowledgement cannot allocate after close`, async () => {
    const f = fixture(),
      begun = deferred(),
      resume = deferred();
    const mutate = f.journal.mutate;
    f.journal.mutate = async (name, operation) => {
      if (name === stage) {
        begun.resolve();
        await resume.promise;
      }
      return mutate(name, operation);
    };
    const opening = f.holding.open(() => {}).catch((error: unknown) => error);
    await begun.promise;
    const closing = f.holding.close();
    resume.resolve();
    assert((await opening) instanceof AudioBridgeOpenError);
    await closing;
    const prefix =
      stage === "originate"
        ? "originate:"
        : stage === "create-bridge"
          ? "bridge:"
          : `add:${f.holding.bridgeId}:${stage === "attach-outbound" ? f.holding.outboundId : f.config.callerChannelId}`;
    assert.equal(
      f.log.some((entry) => entry.startsWith(prefix)),
      false,
    );
  });
}
