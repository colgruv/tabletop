import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { Action, EventsResponse, GuestResponse, PostActionResponse } from "@tabletop/shared";
import { createApp } from "./app";
import { loadOAuthSettings } from "./config";
import { discordProvider } from "./oauth";
import { EventStore } from "./store";

let store: EventStore;
let app: ReturnType<typeof createApp>;
let nextId = 0;

beforeEach(() => {
  store = new EventStore(":memory:");
  app = createApp(store, { ctx: { newId: () => `tok${++nextId}`, rollDie: () => 4 } });
});
afterEach(() => store.close());

async function newSession(): Promise<string> {
  const res = await app.request("/api/sessions", { method: "POST" });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

async function newGuest(): Promise<GuestResponse> {
  const res = await app.request("/api/auth/guest", { method: "POST" });
  expect(res.status).toBe(201);
  return (await res.json()) as GuestResponse;
}

let alice: GuestResponse;
let bob: GuestResponse;
beforeEach(async () => {
  alice = await newGuest();
  bob = await newGuest();
});

function post(id: string, action: Action, as: GuestResponse | null = alice) {
  return app.request(`/api/sessions/${id}/actions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(as ? { Authorization: `Bearer ${as.token}` } : {}),
    },
    body: JSON.stringify({ action }),
  });
}

describe("event log API", () => {
  it("assigns increasing seqs and returns events after N", async () => {
    const id = await newSession();
    const a = (await (await post(id, { type: "token.add", name: "A", color: "#ff0000", x: 0, z: 0 })).json()) as PostActionResponse;
    const b = (await (await post(id, { type: "dice.roll", formula: "2d6" }, bob)).json()) as PostActionResponse;
    expect(a).toEqual({ ok: true, seq: 1 });
    expect(b).toEqual({ ok: true, seq: 2 });

    const res = await app.request(`/api/sessions/${id}/events?after=1`);
    const body = (await res.json()) as EventsResponse;
    expect(body.latestSeq).toBe(2);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ seq: 2, type: "dice.rolled", rolls: [4, 4], total: 8, actor: bob.userId });
  });

  it("returns 304 when the client already has the latest seq", async () => {
    const id = await newSession();
    await post(id, { type: "dice.roll", formula: "1d20" });
    const first = await app.request(`/api/sessions/${id}/events?after=0`);
    const etag = first.headers.get("ETag")!;
    const again = await app.request(`/api/sessions/${id}/events?after=1`, { headers: { "If-None-Match": etag } });
    expect(again.status).toBe(304);
  });

  it("rejects invalid actions without using a seq", async () => {
    const id = await newSession();
    const bad = await post(id, { type: "token.move", id: "missing", x: 0, z: 0 });
    expect(bad.status).toBe(400);
    const good = (await (await post(id, { type: "dice.roll", formula: "1d4" })).json()) as PostActionResponse;
    expect(good).toEqual({ ok: true, seq: 1 });
  });

  it("validates against state rebuilt from the log", async () => {
    const id = await newSession();
    await post(id, { type: "token.add", name: "A", color: "#ff0000", x: 0, z: 0 });
    const moved = await post(id, { type: "token.move", id: "tok" + nextId, x: 5, z: 5 });
    expect(moved.status).toBe(200);
  });

  it("404s for unknown sessions", async () => {
    expect((await app.request("/api/sessions/doesnotexist/events")).status).toBe(404);
    expect((await post("doesnotexist", { type: "dice.roll", formula: "1d6" })).status).toBe(404);
  });

  it("rejects bad JSON", async () => {
    const id = await newSession();
    const res = await app.request(`/api/sessions/${id}/actions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${alice.token}` },
      body: "{nope",
    });
    expect(res.status).toBe(400);
  });
});

describe("accounts", () => {
  it("creates distinct guests with distinct tokens", async () => {
    expect(alice.userId).not.toBe(bob.userId);
    expect(alice.token).not.toBe(bob.token);
  });

  it("rejects actions without a valid token", async () => {
    const id = await newSession();
    const action: Action = { type: "dice.roll", formula: "1d6" };
    expect((await post(id, action, null)).status).toBe(401);
    expect((await post(id, action, { userId: alice.userId, token: "forged" })).status).toBe(401);
    // Nothing was appended.
    const body = (await (await app.request(`/api/sessions/${id}/events`)).json()) as EventsResponse;
    expect(body.latestSeq).toBe(0);
  });

  it("sets the actor from the token and ignores one in the body", async () => {
    const id = await newSession();
    await app.request(`/api/sessions/${id}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${alice.token}` },
      body: JSON.stringify({ actor: bob.userId, action: { type: "dice.roll", formula: "1d6" } }),
    });
    const body = (await (await app.request(`/api/sessions/${id}/events`)).json()) as EventsResponse;
    expect(body.events[0]?.actor).toBe(alice.userId);
  });

  it("stores only a hash of the token", () => {
    const rows = store.database.prepare("SELECT token_hash FROM auth_tokens").all() as { token_hash: string }[];
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([alice.token, bob.token]).not.toContain(r.token_hash);
  });
});

describe("migrations", () => {
  it("upgrades a database from before migrations existed without losing events", () => {
    const dir = mkdtempSync(join(tmpdir(), "tabletop-"));
    const path = join(dir, "old.db");
    try {
      const old = new DatabaseSync(path);
      old.exec(`
        CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL);
        CREATE TABLE events (session_id TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL,
          PRIMARY KEY (session_id, seq)) WITHOUT ROWID;
        INSERT INTO sessions VALUES ('oldsession', 1);
        INSERT INTO events VALUES ('oldsession', 1, '{"type":"dice.rolled","seq":1}');
      `);
      old.close();

      const upgraded = new EventStore(path);
      expect(upgraded.sessionExists("oldsession")).toBe(true);
      expect(upgraded.latestSeq("oldsession")).toBe(1);
      expect(upgraded.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 3 });
      upgraded.close();

      // Reopening is a no-op.
      new EventStore(path).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("CORS", () => {
  it("allows the configured origin and exposes ETag", async () => {
    const corsApp = createApp(new EventStore(":memory:"), { allowedOrigins: ["https://example.github.io"] });
    const pre = await corsApp.request("/api/sessions/abcdefgh/events", {
      method: "OPTIONS",
      headers: {
        Origin: "https://example.github.io",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "if-none-match,authorization",
      },
    });
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("https://example.github.io");
    expect(pre.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("if-none-match");
    expect(pre.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("authorization");

    const res = await corsApp.request("/api/health", { headers: { Origin: "https://example.github.io" } });
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("ETag");
  });

  it("does not allow other origins", async () => {
    const corsApp = createApp(new EventStore(":memory:"), { allowedOrigins: ["https://example.github.io"] });
    const res = await corsApp.request("/api/health", { headers: { Origin: "https://evil.example" } });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("rate limiting", () => {
  it("limits session creation per IP", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await app.request("/api/sessions", { method: "POST", headers: { "X-Forwarded-For": "1.1.1.1, 9.9.9.9" } });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);

    // A different viewer IP (last X-Forwarded-For entry) has its own bucket.
    const other = await app.request("/api/sessions", { method: "POST", headers: { "X-Forwarded-For": "1.1.1.1, 8.8.8.8" } });
    expect(other.status).toBe(201);
  });

  it("limits guest creation per IP", async () => {
    const headers = { "X-Forwarded-For": "2.2.2.2" };
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await app.request("/api/auth/guest", { method: "POST", headers })).status);
    expect(statuses.slice(0, 20).every((s) => s === 201)).toBe(true);
    expect(statuses.at(-1)).toBe(429);
  });
});

describe("OAuth sign-in", () => {
  const CLIENT = "https://client.example/tabletop/";
  let identity = { subject: "d-1", displayName: "Dana" };
  let failExchange = false;
  let oauthApp: ReturnType<typeof createApp>;

  const auth = (g: GuestResponse) => ({ Authorization: `Bearer ${g.token}`, "Content-Type": "application/json" });

  beforeEach(() => {
    identity = { subject: "d-1", displayName: "Dana" };
    failExchange = false;
    oauthApp = createApp(store, {
      oauth: {
        publicApiUrl: "https://api.example",
        clientUrl: CLIENT,
        providers: {
          fake: {
            authorizeUrl: ({ state, redirectUri }) => `https://idp.example/auth?state=${state}&ru=${encodeURIComponent(redirectUri)}`,
            exchange: async () => {
              if (failExchange) throw new Error("boom");
              return identity;
            },
          },
        },
      },
    });
  });

  async function start(g: GuestResponse, returnTo = "") {
    const res = await oauthApp.request("/api/auth/oauth/fake/start", {
      method: "POST",
      headers: auth(g),
      body: JSON.stringify({ returnTo }),
    });
    expect(res.status).toBe(200);
    const url = new URL(((await res.json()) as { url: string }).url);
    return { state: url.searchParams.get("state")!, redirectUri: url.searchParams.get("ru")! };
  }

  async function callback(state: string, code: string | null = "abc") {
    const q = new URLSearchParams({ state, ...(code ? { code } : {}) });
    const res = await oauthApp.request(`/api/auth/oauth/fake/callback?${q}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("Location")!);
    expect(`${loc.origin}${loc.pathname}`).toBe(CLIENT);
    return new URLSearchParams(loc.hash.slice(1));
  }

  const exchange = (code: string) =>
    oauthApp.request("/api/auth/login-code", { method: "POST", body: JSON.stringify({ code }) });

  it("claims a guest and sends the browser back with a one-time code", async () => {
    const { state, redirectUri } = await start(alice, "sess1234");
    expect(redirectUri).toBe("https://api.example/api/auth/oauth/fake/callback");

    const frag = await callback(state);
    expect(frag.get("return")).toBe("sess1234");
    const res = await exchange(frag.get("login")!);
    expect(res.status).toBe(200);
    const got = (await res.json()) as GuestResponse;
    expect(got.userId).toBe(alice.userId);

    const me = await oauthApp.request("/api/me", { headers: auth(got) });
    expect(await me.json()).toEqual({
      userId: alice.userId,
      claimed: true,
      credentials: [{ provider: "fake", displayName: "Dana" }],
      providers: ["fake"],
    });
  });

  it("reports a fresh guest as unclaimed", async () => {
    const me = await oauthApp.request("/api/me", { headers: auth(alice) });
    expect(await me.json()).toMatchObject({ claimed: false, credentials: [] });
  });

  it("signs a second browser in as the already-claimed user", async () => {
    await exchange((await callback((await start(alice)).state)).get("login")!);

    // A different guest (a new browser) signs in with the same identity.
    const frag = await callback((await start(bob)).state);
    const got = (await (await exchange(frag.get("login")!)).json()) as GuestResponse;
    expect(got.userId).toBe(alice.userId);
    expect(got.token).not.toBe(alice.token);
    expect(got.token).not.toBe(bob.token);
  });

  it("makes login codes and states single-use", async () => {
    const { state } = await start(alice);
    const frag = await callback(state);
    expect((await exchange(frag.get("login")!)).status).toBe(200);
    expect((await exchange(frag.get("login")!)).status).toBe(400);
    expect((await callback(state)).get("login-error")).toBe("state");
  });

  it("reports forged states, denied sign-ins and provider failures", async () => {
    expect((await callback("forged")).get("login-error")).toBe("state");
    expect((await callback((await start(alice)).state, null)).get("login-error")).toBe("denied");
    failExchange = true;
    expect((await callback((await start(alice)).state)).get("login-error")).toBe("provider");
  });

  it("requires a token to start, 404s unknown providers, and drops an unsafe returnTo", async () => {
    const noAuth = await oauthApp.request("/api/auth/oauth/fake/start", { method: "POST" });
    expect(noAuth.status).toBe(401);
    const unknown = await oauthApp.request("/api/auth/oauth/nope/start", { method: "POST", headers: auth(alice) });
    expect(unknown.status).toBe(404);

    const { state } = await start(alice, "x&login=evil");
    expect((await callback(state)).get("return")).toBeNull();
  });

  it("is off when no provider is configured", async () => {
    const res = await app.request("/api/auth/oauth/discord/start", { method: "POST", headers: auth(alice) });
    expect(res.status).toBe(404);
    const me = await app.request("/api/me", { headers: auth(alice) });
    expect(((await me.json()) as { providers: string[] }).providers).toEqual([]);
  });
});

describe("Discord provider", () => {
  it("builds the authorize URL and reads the user id from the profile", async () => {
    const calls: { url: string; body: string; auth?: string }[] = [];
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      calls.push({ url, body: String(init?.body ?? ""), auth: headers?.Authorization });
      return url.endsWith("/token")
        ? Response.json({ access_token: "at" })
        : Response.json({ id: "42", username: "dana", global_name: "Dana W" });
    }) as unknown as typeof fetch;
    const p = discordProvider({ clientId: "cid", clientSecret: "sec", fetch: fakeFetch });

    const url = new URL(p.authorizeUrl({ state: "st", redirectUri: "https://api/cb" }));
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "cid",
      scope: "identify",
      state: "st",
      redirect_uri: "https://api/cb",
    });
    expect(url.search).not.toContain("sec");

    expect(await p.exchange("the-code", "https://api/cb")).toEqual({ subject: "42", displayName: "Dana W" });
    expect(new URLSearchParams(calls[0]!.body).get("code")).toBe("the-code");
    expect(calls[1]!.auth).toBe("Bearer at");
  });

  it("throws when Discord rejects the code", async () => {
    const reject = (async () => new Response("no", { status: 400 })) as unknown as typeof fetch;
    const p = discordProvider({ clientId: "c", clientSecret: "s", fetch: reject });
    await expect(p.exchange("bad", "https://api/cb")).rejects.toThrow(/400/);
  });
});

describe("OAuth config", () => {
  it("is off without credentials, reads env in dev, and reads SSM params in production", () => {
    expect(loadOAuthSettings({}, () => ({}))).toBeUndefined();

    const dev = loadOAuthSettings({ DISCORD_CLIENT_ID: "a", DISCORD_CLIENT_SECRET: "b" }, () => ({}));
    expect(Object.keys(dev!.providers)).toEqual(["discord"]);
    expect(dev!.publicApiUrl).toBe("http://localhost:5173");

    const prod = loadOAuthSettings({ NODE_ENV: "production" }, () => ({
      "discord-client-id": "a",
      "discord-client-secret": "b",
      "public-api-url": "https://api.example/",
      "client-url": "https://client.example/tabletop/#old",
    }));
    expect(prod!.publicApiUrl).toBe("https://api.example");
    expect(prod!.clientUrl).toBe("https://client.example/tabletop/");

    // Production without the URLs configured must not guess.
    const noUrls = { "discord-client-id": "a", "discord-client-secret": "b" };
    expect(loadOAuthSettings({ NODE_ENV: "production" }, () => noUrls)).toBeUndefined();
  });
});
