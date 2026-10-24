import type { Action, EventsResponse, PostActionResponse, TableEvent } from "@tabletop/shared";

/** API origin. Empty in dev (Vite proxies /api); set VITE_API_URL for hosted builds. */
const API = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export type EventsResult =
  | { changed: false }
  | { changed: true; events: TableEvent[]; latestSeq: number; etag: string | null };

export async function createSession(): Promise<string> {
  const res = await fetch(`${API}/api/sessions`, { method: "POST" });
  if (!res.ok) throw new Error(`create session failed: ${res.status}`);
  return ((await res.json()) as { id: string }).id;
}

export async function fetchEvents(session: string, after: number, etag: string | null): Promise<EventsResult> {
  const res = await fetch(`${API}/api/sessions/${encodeURIComponent(session)}/events?after=${after}`, {
    // We manage the ETag ourselves, so keep the browser cache out of it.
    cache: "no-store",
    headers: etag ? { "If-None-Match": etag } : {},
  });
  if (res.status === 304) return { changed: false };
  if (!res.ok) throw new Error(`poll failed: ${res.status}`);
  const body = (await res.json()) as EventsResponse;
  return { changed: true, events: body.events, latestSeq: body.latestSeq, etag: res.headers.get("ETag") };
}

export async function postAction(session: string, actor: string, action: Action): Promise<PostActionResponse> {
  try {
    const res = await fetch(`${API}/api/sessions/${encodeURIComponent(session)}/actions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actor, action }),
    });
    return (await res.json()) as PostActionResponse;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}
