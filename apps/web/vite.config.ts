import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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
