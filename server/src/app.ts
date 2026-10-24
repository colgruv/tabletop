import { randomBytes, randomInt } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { EventsResponse, PostActionRequest, PostActionResponse, ServerContext } from "@tabletop/shared";
import type { EventStore } from "./store";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;

const newId = (bytes: number) => randomBytes(bytes).toString("base64url");

export const defaultContext: ServerContext = {
  newId: () => newId(6),
  rollDie: (sides) => randomInt(1, sides + 1),
};

export function createApp(store: EventStore, ctx: ServerContext = defaultContext) {
  const app = new Hono().basePath("/api");

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/sessions", (c) => {
    const id = newId(9);
    store.createSession(id);
    return c.json({ id }, 201);
  });

  // Poll endpoint. ETag is the latest seq, so "nothing new" is a 304 that
  // never reads the events table.
  app.get("/sessions/:id/events", (c) => {
    const id = c.req.param("id");
    if (!SESSION_ID_RE.test(id) || !store.sessionExists(id)) return c.json({ error: "no such session" }, 404);

    const after = Math.max(0, Number.parseInt(c.req.query("after") ?? "0", 10) || 0);
    const latestSeq = store.latestSeq(id);
    const etag = `"${latestSeq}"`;
    c.header("ETag", etag);
    c.header("Cache-Control", "no-cache");

    if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
    if (after >= latestSeq) return c.json<EventsResponse>({ events: [], latestSeq });
    return c.json<EventsResponse>({ events: store.eventsAfter(id, after), latestSeq });
  });

  app.post("/sessions/:id/actions", bodyLimit({ maxSize: 4 * 1024 }), async (c) => {
    const id = c.req.param("id");
    if (!SESSION_ID_RE.test(id) || !store.sessionExists(id))
      return c.json<PostActionResponse>({ ok: false, error: "no such session" }, 404);

    let body: PostActionRequest;
    try {
      body = await c.req.json<PostActionRequest>();
    } catch {
      return c.json<PostActionResponse>({ ok: false, error: "invalid JSON" }, 400);
    }

    const actor = body?.actor;
    if (typeof actor !== "string" || actor.length < 1 || actor.length > 64)
      return c.json<PostActionResponse>({ ok: false, error: "actor must be 1-64 characters" }, 400);

    const result = store.append(id, actor, body.action, ctx);
    if (!result.ok) return c.json<PostActionResponse>({ ok: false, error: result.error }, 400);
    return c.json<PostActionResponse>(result);
  });

  return app;
}
