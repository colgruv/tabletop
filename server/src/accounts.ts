import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const MAX_CACHED_TOKENS = 5000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Users and their bearer tokens. Tokens are random and only their hash is
 * stored. Lookups are cached in memory (single instance only, like the event
 * store's caches) so authenticating a poll doesn't touch the database.
 */
export class AccountStore {
  private cache = new Map<string, string>(); // token hash -> user id

  constructor(private db: DatabaseSync) {}

  /** Create a guest user and its first token. The raw token is returned once. */
  createGuest(): { userId: string; token: string } {
    const userId = randomUUID();
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(userId, now);
      this.db
        .prepare("INSERT INTO auth_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)")
        .run(hashToken(token), userId, now);
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    return { userId, token };
  }

  /** The user a token belongs to, or null if it is unknown. */
  userForToken(token: string): string | null {
    const hash = hashToken(token);
    const cached = this.cache.get(hash);
    if (cached) return cached;
    const row = this.db.prepare("SELECT user_id FROM auth_tokens WHERE token_hash = ?").get(hash) as
      | { user_id: string }
      | undefined;
    if (!row) return null;
    this.cache.set(hash, row.user_id);
    if (this.cache.size > MAX_CACHED_TOKENS) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    return row.user_id;
  }
}
