import type { Action, EventsResponse, GuestResponse, PostActionResponse, TableEvent } from "@tabletop/shared";

/** API origin. Empty in dev (Vite proxies /api); set VITE_API_URL for hosted builds. */
const API = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

export type EventsResult =
  | { changed: false }
  | { changed: true; events: TableEvent[]; latestSeq: number; etag: string | null };

const AUTH_KEY = "tabletop.auth";

let account: GuestResponse | null = null;

function loadAccount(): GuestResponse | null {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTH_KEY) ?? "null") as Partial<GuestResponse> | null;
    if (typeof saved?.userId === "string" && typeof saved.token === "string") return saved as GuestResponse;
  } catch {
    /* storage blocked or corrupt */
  }
  return null;
}

async function createGuest(): Promise<GuestResponse> {
  const res = await fetch(`${API}/api/auth/guest`, { method: "POST" });
  if (!res.ok) throw new Error(`create account failed: ${res.status}`);
  const fresh = (await res.json()) as GuestResponse;
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify(fresh));
  } catch {
    /* private mode: the account lasts for this tab only */
  }
  return fresh;
}

/** The signed-in user, creating a guest account on first use. */
export async function ensureAccount(): Promise<GuestResponse> {
  account ??= loadAccount() ?? (await createGuest());
  return account;
}

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

export async function postAction(session: string, action: Action): Promise<PostActionResponse> {
  try {
    const send = async () => {
      const { token } = await ensureAccount();
      return fetch(`${API}/api/sessions/${encodeURIComponent(session)}/actions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action }),
      });
    };
    let res = await send();
    if (res.status === 401) {
      // The server doesn't know this token (e.g. its database was reset). Start over as a new guest.
      account = await createGuest();
      res = await send();
    }
    return (await res.json()) as PostActionResponse;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}
