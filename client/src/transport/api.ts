import type { Action, EventsResponse, GuestResponse, MeResponse, PostActionResponse, TableEvent } from "@tabletop/shared";

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

function saveAccount(next: GuestResponse): GuestResponse {
  account = next;
  try {
    localStorage.setItem(AUTH_KEY, JSON.stringify(next));
  } catch {
    /* private mode: the account lasts for this tab only */
  }
  return next;
}

async function createGuest(): Promise<GuestResponse> {
  const res = await fetch(`${API}/api/auth/guest`, { method: "POST" });
  if (!res.ok) throw new Error(`create account failed: ${res.status}`);
  return saveAccount((await res.json()) as GuestResponse);
}

/** Trade the one-time code from an OAuth redirect for a token, and switch to that account. */
export async function completeLogin(code: string): Promise<void> {
  const res = await fetch(`${API}/api/auth/login-code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!res.ok) throw new Error("that sign-in link has expired; try again");
  saveAccount((await res.json()) as GuestResponse);
}

export async function fetchMe(): Promise<MeResponse> {
  const { token } = await ensureAccount();
  const res = await fetch(`${API}/api/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`profile failed: ${res.status}`);
  return (await res.json()) as MeResponse;
}

/** The provider's sign-in page URL. The caller navigates the browser there. */
export async function startOAuth(provider: string, returnTo: string): Promise<string> {
  const { token } = await ensureAccount();
  const res = await fetch(`${API}/api/auth/oauth/${encodeURIComponent(provider)}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ returnTo }),
  });
  if (!res.ok) throw new Error(`sign-in failed: ${res.status}`);
  return ((await res.json()) as { url: string }).url;
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
      await createGuest();
      res = await send();
    }
    return (await res.json()) as PostActionResponse;
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "network error" };
  }
}
