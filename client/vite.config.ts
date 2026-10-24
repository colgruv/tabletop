import { defineConfig } from "vite";

export default defineConfig({
  // GitHub Pages serves the site under /<repo>/; set VITE_BASE=/tabletop/ there.
  base: process.env.VITE_BASE ?? "/",
  server: {
    // Listen on the LAN too, so a phone on the same Wi-Fi can join.
    host: true,
    proxy: { "/api": "http://localhost:8787" },
  },
  preview: { proxy: { "/api": "http://localhost:8787" } },
  build: { target: "es2022" },
});
