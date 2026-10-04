import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { z } from "zod";
import { RoomServiceClient } from "livekit-server-sdk";
import { dispose } from "@livekit/rtc-node";
import { HttpAuthority, joinSchema, serviceUrl } from "./authority.js";
import { PhoneRelay } from "./relay.js";
import { openRtcBridge } from "./rtc.js";

process.umask(0o077);
if (process.env.PHONE_ENABLED !== "true") {
  console.log("Phone relay disabled");
} else {
  const schema = z
    .object({
      join: joinSchema,
      holding: z
        .object({
          url: z.string(),
          token: z.string().min(32),
          roomName: z.string(),
          participantIdentity: z.string().min(1).max(256),
        })
        .strict(),
    })
    .strict();
  let relay: PhoneRelay | undefined;
  try {
    const file = process.env.PHONE_CALL_FILE;
    if (!file) throw new Error("Phone call file required");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    let callInput: string;
    try {
      const info = await handle.stat();
      if (
        !info.isFile() ||
        info.size > 32768 ||
        (info.mode & 0o077) !== 0 ||
        (process.getuid && info.uid !== process.getuid())
      )
        throw new Error(
          "Phone call file must be private, owned by this user, and bounded",
        );
      const buffer = Buffer.alloc(32769);
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
      if (offset > 32768) throw new Error("Phone call file too large");
      callInput = buffer.subarray(0, offset).toString("utf8");
      buffer.fill(0);
    } finally {
      await handle.close();
    }
    const config = schema.parse(JSON.parse(callInput));
    callInput = "";
    const development = process.env.NODE_ENV !== "production";
    const authority = new HttpAuthority(
      process.env.PHONE_AUTHORITY_URL ?? "",
      process.env.PHONE_GATEWAY_KEY ?? "",
      development,
    );
    const livekitUrl = serviceUrl(
      process.env.LIVEKIT_URL ?? "",
      ["https:", "http:"],
      development,
    );
    const key = process.env.LIVEKIT_API_KEY,
      secret = process.env.LIVEKIT_API_SECRET;
    if (!key || !secret)
      throw new Error("Private media termination credentials required");
    const media = new RoomServiceClient(livekitUrl.toString(), key, secret);
    relay = new PhoneRelay(config.join, {
      authority,
      openBridge: (failure, dtmf) =>
        openRtcBridge(
          {
            holding: config.holding,
            meetingOrigin: process.env.SITE_ORIGIN ?? "",
            development,
          },
          failure,
          dtmf,
        ),
      async terminateNative() {
        if (!/^phone-hold-[A-Za-z0-9-]{16,128}$/.test(config.holding.roomName))
          throw new Error("Invalid holding room");
        try {
          await media.removeParticipant(
            config.holding.roomName,
            config.holding.participantIdentity,
          );
        } catch (error) {
          if (!/not found|does not exist/i.test(String(error)))
            throw new Error("Native participant cleanup failed");
        }
        const remaining = await media
          .listParticipants(config.holding.roomName)
          .catch((error) => {
            if (/not found|does not exist/i.test(String(error))) return [];
            throw new Error("Native participant cleanup verification failed");
          });
        if (
          remaining.some(
            (p) => p.identity === config.holding.participantIdentity,
          )
        )
          throw new Error("Native participant remains connected");
      },
    });
    config.join.pin = "";
    delete config.join.callerId;
    const stop = () => {
      void relay?.stop().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    await relay.run();
    console.log("Phone relay stopped");
  } catch {
    // SDK errors can contain URLs or token material. Keep supervisor output generic.
    console.error(
      "Phone relay failed; inspect protected service state and reconcile the call",
    );
    process.exitCode = 1;
  } finally {
    await relay?.stop().catch(() => {
      process.exitCode = 1;
    });
    await dispose();
  }
}
