// Actions are what a client asks for. Events are what the server accepted.
// The server turns an Action into an Event (assigning ids, rolling dice, etc.)
// and appends it to the session's log with a sequence number.

export const EVENT_VERSION = 1;

/** Table is a square centered on the origin; tokens live on the XZ plane. */
export const TABLE_HALF_SIZE = 10;

// ---- Actions (client -> server) ----

export type Action =
  | { type: "token.add"; name: string; color: string; x: number; z: number }
  | { type: "token.move"; id: string; x: number; z: number }
  | { type: "token.remove"; id: string }
  | { type: "dice.roll"; formula: string };

// ---- Events (stored in the log, server -> clients) ----

export type EventData =
  | { type: "token.added"; id: string; name: string; color: string; x: number; z: number }
  | { type: "token.moved"; id: string; x: number; z: number }
  | { type: "token.removed"; id: string }
  | { type: "dice.rolled"; formula: string; rolls: number[]; modifier: number; total: number };

export type TableEvent = EventData & {
  /** Per-session, strictly increasing, starting at 1. */
  seq: number;
  /** Schema version of this event. */
  v: number;
  /** Client id of whoever caused it. */
  actor: string;
  /** Server time in ms since epoch. */
  at: number;
};

// ---- HTTP payloads ----

export interface PostActionRequest {
  actor: string;
  action: Action;
}

export type PostActionResponse = { ok: true; seq: number } | { ok: false; error: string };

export interface EventsResponse {
  events: TableEvent[];
  latestSeq: number;
}
