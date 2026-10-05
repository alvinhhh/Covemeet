import { open } from "node:fs/promises";
import { constants } from "node:fs";
import { RoomServiceClient } from "livekit-server-sdk";
import { z } from "zod";
import { loadConfig } from "./config.js";
import { PgStore } from "./store.js";
import { LiveMedia } from "./media.js";
import {
  PhoneDialogService,
  phoneSupervisorInputSchema,
} from "./phone-dialogs.js";
import {
  PhoneDockerManager,
  PhoneRecoveryError,
  fenceManagedPhone,
  recoverManagedPhone,
} from "./phone-recovery.js";

// Run outside the supervisor container. Only this management process receives
// the local Docker socket and private database credentials.
const config = loadConfig(process.env);
const store = new PgStore(config.databaseUrl, {
  tls: config.production,
  ca: config.databaseCa,
});
const media = new LiveMedia(config, store);
try {
  const mode = z.enum(["claim", "fence", "recover"]).parse(process.argv[2]);
  const file = await open(
    process.env.PHONE_MANAGED_FILE ?? "",
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  let input;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 16384 || stat.mode & 0o022)
      throw new Error();
    const buffer = Buffer.alloc(16385);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 16384) throw new Error();
    input = phoneSupervisorInputSchema.parse(
      JSON.parse(buffer.subarray(0, bytesRead).toString("utf8")),
    );
  } finally {
    await file.close();
  }
  await store.init();
  const manager = new PhoneDockerManager();
  if (mode === "claim") {
    await manager.inspect(input);
    await store.claimPhoneSupervisor(input);
  } else {
    const previousOwnerId = z
      .string()
      .uuid()
      .parse(process.env.PHONE_PREVIOUS_OWNER_ID);
    if (mode === "fence")
      await fenceManagedPhone(store, manager, input.pbxId, previousOwnerId);
    else
      await recoverManagedPhone(
        store,
        new PhoneDialogService(config, store, media),
        new RoomServiceClient(
          config.livekitUrl,
          config.livekitKey,
          config.livekitSecret,
        ),
        manager,
        input,
        previousOwnerId,
      );
  }
  console.log(`Phone manager ${mode} completed`);
} catch (error) {
  if (error instanceof PhoneRecoveryError)
    console.error(`Phone recovery stopped at ${error.stage}`);
  console.error(
    "Phone management incomplete; ownership and unresolved reservations remain protected",
  );
  process.exitCode = 1;
} finally {
  media.close();
  await store.close();
}
