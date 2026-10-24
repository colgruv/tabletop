import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action, EventsResponse, PostActionResponse } from "@tabletop/shared";
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

function post(id: string, action: Action, actor = "alice") {
  return app.request(`/api/sessions/${id}/actions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ actor, action }),
  });
}

describe("event log API", () => {
  it("assigns increasing seqs and returns events after N", async () => {
    const id = await newSession();
    const a = (await (await post(id, { type: "token.add", name: "A", color: "#ff0000", x: 0, z: 0 })).json()) as PostActionResponse;
    const b = (await (await post(id, { type: "dice.roll", formula: "2d6" }, "bob")).json()) as PostActionResponse;
    expect(a).toEqual({ ok: true, seq: 1 });
    expect(b).toEqual({ ok: true, seq: 2 });

    const res = await app.request(`/api/sessions/${id}/events?after=1`);
    const body = (await res.json()) as EventsResponse;
    expect(body.latestSeq).toBe(2);
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ seq: 2, type: "dice.rolled", rolls: [4, 4], total: 8, actor: "bob" });
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

  it("rejects bad JSON and missing actors", async () => {
    const id = await newSession();
    const res = await app.request(`/api/sessions/${id}/actions`, { method: "POST", body: "{nope" });
    expect(res.status).toBe(400);
    const noActor = await app.request(`/api/sessions/${id}/actions`, {
      method: "POST",
      body: JSON.stringify({ action: { type: "dice.roll", formula: "1d6" } }),
    });
    expect(noActor.status).toBe(400);
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
        "Access-Control-Request-Headers": "if-none-match",
      },
    });
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe("https://example.github.io");
    expect(pre.headers.get("Access-Control-Allow-Headers")?.toLowerCase()).toContain("if-none-match");

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
});
