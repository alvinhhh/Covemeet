import { rm, writeFile } from "node:fs/promises";
import { dispose } from "@livekit/rtc-node";
import {
  loadManagedPhoneConfig,
  readManagedPhoneRuntime,
  runManagedPhone,
} from "./managed.js";

process.umask(0o077);
if (process.env.PHONE_ENABLED !== "true") {
  console.log("Phone service disabled");
} else {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    const config = loadManagedPhoneConfig(process.env);
    const runtime = await readManagedPhoneRuntime(config);
    await runManagedPhone(config, runtime, controller.signal, async (ready) => {
      const path = "/tmp/covemeet-phone-ready";
      if (ready) await writeFile(path, "ready\n", { mode: 0o600 });
      else await rm(path, { force: true });
    });
  } catch {
    console.error(
      "Phone service stopped; reconcile its managed runtime before replacement",
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await rm("/tmp/covemeet-phone-ready", { force: true }).catch(() => {});
    await dispose();
  }
}
