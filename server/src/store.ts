import { DatabaseSync } from "node:sqlite";
import {
  EVENT_VERSION,
  applyEvent,
  emptyState,
  validateAction,
  type Action,
  type PostActionResponse,
  type ServerContext,
  type TableEvent,
  type TableState,
} from "@tabletop/shared";

const MAX_CACHED_STATES = 1000;

/**
 * The append-only event log, backed by SQLite.
 *
 * The in-memory caches (latest seq, current state) only work while there is a
 * single server instance. They stand in for Redis until we scale out. The
 * database is always the source of truth: appends catch up from it first.
 */
export class EventStore {
  private db: DatabaseSync;
  private latest = new Map<string, number>();
  private states = new Map<string, TableState>();

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        session_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (session_id, seq)
      ) WITHOUT ROWID;
    `);
  }

  createSession(id: string): void {
    this.db.prepare("INSERT INTO sessions (id, created_at) VALUES (?, ?)").run(id, Date.now());
    this.latest.set(id, 0);
  }

  sessionExists(id: string): boolean {
    if (this.latest.has(id)) return true;
    return this.db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(id) !== undefined;
  }

  /** Cheap check used by empty polls. Hits the database only on a cache miss. */
  latestSeq(id: string): number {
    const cached = this.latest.get(id);
    if (cached !== undefined) return cached;
    const row = this.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE session_id = ?").get(id) as
      | { seq: number | null }
      | undefined;
    const seq = row?.seq ?? 0;
    this.latest.set(id, seq);
    return seq;
  }

  eventsAfter(id: string, after: number, limit = 500): TableEvent[] {
    const rows = this.db
      .prepare("SELECT data FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?")
      .all(id, after, limit) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data) as TableEvent);
  }

  /** Validate an action against current state and, if valid, append it with the next seq. */
  append(id: string, actor: string, action: Action, ctx: ServerContext): PostActionResponse {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const state = this.catchUp(id);
      const result = validateAction(state, action, ctx);
      if (!result.ok) {
        this.db.exec("ROLLBACK");
        return result;
      }

      const event: TableEvent = { ...result.event, seq: state.seq + 1, v: EVENT_VERSION, actor, at: Date.now() };
      this.db
        .prepare("INSERT INTO events (session_id, seq, data) VALUES (?, ?, ?)")
        .run(id, event.seq, JSON.stringify(event));
      this.db.exec("COMMIT");

      this.cacheState(id, applyEvent(state, event));
      this.latest.set(id, event.seq);
      return { ok: true, seq: event.seq };
    } catch (err) {
      if (this.db.isTransaction) this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }

  /** Current state: cached state plus any events written since it was cached. */
  private catchUp(id: string): TableState {
    let state = this.states.get(id) ?? emptyState();
    for (;;) {
      const batch = this.eventsAfter(id, state.seq);
      if (batch.length === 0) break;
      for (const e of batch) state = applyEvent(state, e);
    }
    return state;
  }

  private cacheState(id: string, state: TableState): void {
    // Re-insert so Map order tracks recency; evict the least recently used.
    this.states.delete(id);
    this.states.set(id, state);
    if (this.states.size > MAX_CACHED_STATES) {
      const oldest = this.states.keys().next().value;
      if (oldest !== undefined) this.states.delete(oldest);
    }
  }
}
