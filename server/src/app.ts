import { randomBytes, randomInt } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { createMiddleware } from "hono/factory";
import type { Context } from "hono";
import type {
  EventsResponse,
  GuestResponse,
  MeResponse,
  PostActionRequest,
  PostActionResponse,
  ServerContext,
} from "@tabletop/shared";
import { AccountStore } from "./accounts";
import type { OAuthSettings } from "./oauth";
import { rateLimit } from "./rateLimit";
import type { EventStore } from "./store";

const SESSION_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const RETURN_TO_RE = /^[A-Za-z0-9_-]{0,32}$/;

const newId = (bytes: number) => randomBytes(bytes).toString("base64url");

type Env = { Variables: { userId: string } };

export const defaultContext: ServerContext = {
  newId: () => newId(6),
  rollDie: (sides) => randomInt(1, sides + 1),
};

export interface AppOptions {
  ctx?: ServerContext;
  /** Sign-in providers. Omit to leave guest-only. */
  oauth?: OAuthSettings;
  /** Browser origins allowed to call the API cross-origin (e.g. the GitHub Pages site). */
  allowedOrigins?: string[];
  /** Identify the caller for rate limiting. */
  clientIp?: (c: Context) => string;
}

/** Behind CloudFront, the real viewer IP is the last X-Forwarded-For entry. */
export const forwardedIp = (c: Context): string =>
  c.req.header("X-Forwarded-For")?.split(",").at(-1)?.trim() || "unknown";

export function createApp(store: EventStore, opts: AppOptions = {}) {
  const ctx = opts.ctx ?? defaultContext;
  const key = opts.clientIp ?? forwardedIp;
  const accounts = new AccountStore(store.database);
  const app = new Hono<Env>().basePath("/api");

  /** Resolve the bearer token to a user id, or reject with 401. */
  const requireAuth = createMiddleware<Env>(async (c, next) => {
    const header = c.req.header("Authorization") ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    const userId = token ? accounts.userForToken(token) : null;
    if (!userId) return c.json({ ok: false, error: "unauthorized" }, 401);
    c.set("userId", userId);
    await next();
  });

  if (opts.allowedOrigins?.length) {
    app.use(
      "*",
      cors({
        origin: opts.allowedOrigins,
        allowMethods: ["GET", "POST"],
        allowHeaders: ["Content-Type", "If-None-Match", "Authorization"],
        exposeHeaders: ["ETag"],
        maxAge: 7200, // cache preflights so polls don't double up
      }),
    );
  }

  // Generous enough for several tabs polling; stops scripted floods.
  app.use("*", rateLimit({ capacity: 30, refillPerSec: 15, key }));

  app.get("/health", (c) => c.json({ ok: true }));

  // Guest accounts are cheap to create but each is a database row, so limit per IP.
  // Generous burst because a whole table of players may share one network.
  app.post("/auth/guest", rateLimit({ capacity: 20, refillPerSec: 1 / 30, key }), (c) =>
    c.json<GuestResponse>(accounts.createGuest(), 201),
  );

  const oauth = opts.oauth;

  app.get("/me", requireAuth, (c) => {
    const userId = c.get("userId");
    return c.json<MeResponse>({ userId, ...accounts.profile(userId), providers: Object.keys(oauth?.providers ?? {}) });
  });

  // Returns the provider's sign-in URL. The browser navigates there; the provider
  // then sends it back to the callback below. The state ties the two to this user.
  app.post("/auth/oauth/:provider/start", requireAuth, rateLimit({ capacity: 10, refillPerSec: 1 / 6, key }), async (c) => {
    const provider = oauth?.providers[c.req.param("provider")];
    if (!oauth || !provider) return c.json({ error: "unknown provider" }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { returnTo?: unknown };
    const returnTo = typeof body.returnTo === "string" && RETURN_TO_RE.test(body.returnTo) ? body.returnTo : "";
    const state = accounts.createOAuthState(c.req.param("provider"), c.get("userId"), returnTo);
    const redirectUri = `${oauth.publicApiUrl}/api/auth/oauth/${c.req.param("provider")}/callback`;
    return c.json({ url: provider.authorizeUrl({ state, redirectUri }) });
  });

  // The provider sends the browser here. Whatever happens, finish by sending it
  // back to the client page; the outcome rides in the URL fragment.
  app.get("/auth/oauth/:provider/callback", async (c) => {
    const id = c.req.param("provider");
    const provider = oauth?.providers[id];
    if (!oauth || !provider) return c.json({ error: "unknown provider" }, 404);
    const back = (fragment: string) => c.redirect(`${oauth.clientUrl}#${fragment}`);

    const state = accounts.consumeOAuthState(c.req.query("state") ?? "", id);
    if (!state) return back("login-error=state");
    const code = c.req.query("code");
    if (!code) return back("login-error=denied");

    let identity;
    try {
      identity = await provider.exchange(code, `${oauth.publicApiUrl}/api/auth/oauth/${id}/callback`);
    } catch (err) {
      console.warn(`${id} sign-in failed: ${err instanceof Error ? err.message : err}`);
      return back("login-error=provider");
    }
    const userId = accounts.resolveLogin(id, identity.subject, identity.displayName, state.userId);
    const loginCode = accounts.createLoginCode(userId);
    return back(`login=${loginCode}${state.returnTo ? `&return=${state.returnTo}` : ""}`);
  });

  // The client trades the one-time code from the redirect for a bearer token.
  app.post("/auth/login-code", rateLimit({ capacity: 10, refillPerSec: 1 / 6, key }), async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { code?: unknown };
    const userId = typeof body.code === "string" ? accounts.consumeLoginCode(body.code) : null;
    if (!userId) return c.json({ error: "invalid or expired code" }, 400);
    return c.json<GuestResponse>({ userId, token: accounts.createToken(userId) });
  });

  app.post("/sessions", rateLimit({ capacity: 5, refillPerSec: 1 / 60, key }), (c) => {
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

  app.post(
    "/sessions/:id/actions",
    requireAuth,
    rateLimit({ capacity: 20, refillPerSec: 5, key }),
    bodyLimit({ maxSize: 4 * 1024 }),
    async (c) => {
      const id = c.req.param("id");
      if (!SESSION_ID_RE.test(id) || !store.sessionExists(id))
        return c.json<PostActionResponse>({ ok: false, error: "no such session" }, 404);

      let body: PostActionRequest;
      try {
        body = await c.req.json<PostActionRequest>();
      } catch {
        return c.json<PostActionResponse>({ ok: false, error: "invalid JSON" }, 400);
      }

      const result = store.append(id, c.get("userId"), body.action, ctx);
      if (!result.ok) return c.json<PostActionResponse>({ ok: false, error: result.error }, 400);
      return c.json<PostActionResponse>(result);
    },
  );

  return app;
}
