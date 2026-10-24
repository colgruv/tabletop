import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { EventStore } from "./store";

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.TABLETOP_DB ?? "tabletop.db";

const store = new EventStore(dbPath);
const app = createApp(store);

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
