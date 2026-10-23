import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const vision = join(
  dirname(createRequire(import.meta.url).resolve("@mediapipe/tasks-vision")),
  "wasm",
);
const assets = [
  "vision_wasm_internal.js",
  "vision_wasm_internal.wasm",
  "vision_wasm_nosimd_internal.js",
  "vision_wasm_nosimd_internal.wasm",
];

export default defineConfig({
  plugins: [
    react(),
    {
      name: "background-runtime-assets",
      generateBundle() {
        for (const name of assets)
          this.emitFile({
            type: "asset",
            fileName: `backgrounds/mediapipe-0.10.14/${name}`,
            source: readFileSync(join(vision, name)),
          });
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const name = request.url
            ?.split("?")[0]
            ?.replace(/^\/backgrounds\/mediapipe-0\.10\.14\//, "");
          if (
            !request.url?.startsWith("/backgrounds/mediapipe-0.10.14/") ||
            !assets.includes(name ?? "")
          )
            return next();
          response.setHeader(
            "Content-Type",
            name!.endsWith(".wasm") ? "application/wasm" : "text/javascript",
          );
          response.end(readFileSync(join(vision, name!)));
        });
      },
    },
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: "http://127.0.0.1:4100", changeOrigin: false },
      "/rtc": {
        target: "http://127.0.0.1:4100",
        ws: true,
        changeOrigin: false,
      },
    },
  },
});
