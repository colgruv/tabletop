import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { Action, EventsResponse, GuestResponse, PostActionResponse } from "@tabletop/shared";
import { createApp } from "./app";
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
      expect(upgraded.database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 2 });
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
