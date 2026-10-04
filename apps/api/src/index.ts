import { loadConfig } from "./config.js";
import { PgStore } from "./store.js";
import { LiveMedia } from "./media.js";
import { createApp } from "./server.js";
const config = loadConfig();
const store = new PgStore(config.databaseUrl);
await store.init();
const app = await createApp(config, store, new LiveMedia(config, store));
await app.listen({ host: config.host, port: config.port });
console.log(`Meeting API listening on ${config.host}:${config.port}`);
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => void app.close().then(() => process.exit(0)));
