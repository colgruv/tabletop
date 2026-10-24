import { defineConfig } from "vite";

export default defineConfig({
  server: {
    // Listen on the LAN too, so a phone on the same Wi-Fi can join.
    host: true,
    proxy: { "/api": "http://localhost:8787" },
  },
  preview: { proxy: { "/api": "http://localhost:8787" } },
  build: { target: "es2022" },
});
