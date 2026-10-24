import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { createApp, forwardedIp } from "./app";
import { EventStore } from "./store";

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.TABLETOP_DB ?? "tabletop.db";
// Comma-separated, e.g. "https://colgruv.github.io". Not needed in dev (Vite proxies /api).
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Only trust X-Forwarded-For when a proxy we control (CloudFront) is in front.
const trustProxy = process.env.TRUST_PROXY === "1";

const store = new EventStore(dbPath);
const app = createApp(store, {
  allowedOrigins,
  clientIp: trustProxy ? forwardedIp : (c) => getConnInfo(c).remote.address ?? "unknown",
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`tabletop server on http://localhost:${info.port} (db: ${dbPath})`);
});

const shutdown = () => {
  server.close();
  store.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
