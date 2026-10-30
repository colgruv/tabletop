import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

const MAX_CACHED_TOKENS = 5000;
const STATE_TTL_MS = 10 * 60 * 1000;
const LOGIN_CODE_TTL_MS = 2 * 60 * 1000;

export interface Profile {
  /** True once a login method is attached. */
  claimed: boolean;
  credentials: { provider: string; displayName: string }[];
}

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
const newSecret = () => randomBytes(32).toString("base64url");

/**
 * Users, their bearer tokens, and OAuth credentials. Secrets (tokens, OAuth
 * states, login codes) are random and only their hash is stored. Token lookups
 * are cached in memory (single instance only, like the event store's caches) so
 * authenticating a poll doesn't touch the database.
 */
export class AccountStore {
  private cache = new Map<string, string>(); // token hash -> user id

  constructor(private db: DatabaseSync) {}

  /** Create a guest user and its first token. The raw token is returned once. */
  createGuest(): { userId: string; token: string } {
    const userId = randomUUID();
    this.db.prepare("INSERT INTO users (id, created_at) VALUES (?, ?)").run(userId, Date.now());
    return { userId, token: this.createToken(userId) };
  }

  /** Issue another token for an existing user (e.g. a new browser after OAuth sign-in). */
  createToken(userId: string): string {
    const token = newSecret();
    this.db
      .prepare("INSERT INTO auth_tokens (token_hash, user_id, created_at) VALUES (?, ?, ?)")
      .run(hashToken(token), userId, Date.now());
    return token;
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

  profile(userId: string): Profile {
    const rows = this.db
      .prepare("SELECT provider, display_name FROM credentials WHERE user_id = ? ORDER BY created_at")
      .all(userId) as { provider: string; display_name: string }[];
    return {
      claimed: rows.length > 0,
      credentials: rows.map((r) => ({ provider: r.provider, displayName: r.display_name })),
    };
  }

  /**
   * Finish an OAuth login. If this provider identity already belongs to a user,
   * the caller signs in as that user (new browser or device). Otherwise the
   * identity is attached to the current user, which claims it.
   *
   * Known gap: a guest who signs into an already-claimed account leaves the
   * guest behind. Once games and memberships exist, those must be merged.
   */
  resolveLogin(provider: string, subject: string, displayName: string, currentUserId: string): string {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "INSERT OR IGNORE INTO credentials (provider, subject, user_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(provider, subject, currentUserId, displayName, Date.now());
      // Keep the shown name current if the user renamed themselves at the provider.
      this.db
        .prepare("UPDATE credentials SET display_name = ? WHERE provider = ? AND subject = ?")
        .run(displayName, provider, subject);
      const row = this.db
        .prepare("SELECT user_id FROM credentials WHERE provider = ? AND subject = ?")
        .get(provider, subject) as { user_id: string };
      this.db.exec("COMMIT");
      return row.user_id;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Start an OAuth login for a user. The returned secret goes in the provider's `state` parameter. */
  createOAuthState(provider: string, userId: string, returnTo: string): string {
    this.purgeExpired();
    const state = newSecret();
    this.db
      .prepare("INSERT INTO oauth_states (state_hash, provider, user_id, return_to, expires_at) VALUES (?, ?, ?, ?, ?)")
      .run(hashToken(state), provider, userId, returnTo, Date.now() + STATE_TTL_MS);
    return state;
  }

  /** Single use: the state is deleted whether or not it turns out to be valid. */
  consumeOAuthState(state: string, provider: string): { userId: string; returnTo: string } | null {
    const row = this.db
      .prepare("DELETE FROM oauth_states WHERE state_hash = ? RETURNING provider, user_id, return_to, expires_at")
      .get(hashToken(state)) as
      | { provider: string; user_id: string; return_to: string; expires_at: number }
      | undefined;
    if (!row || row.provider !== provider || row.expires_at < Date.now()) return null;
    return { userId: row.user_id, returnTo: row.return_to };
  }

  /** A short-lived, single-use code the client trades for a token, so tokens never travel in URLs. */
  createLoginCode(userId: string): string {
    const code = newSecret();
    this.db
      .prepare("INSERT INTO login_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .run(hashToken(code), userId, Date.now() + LOGIN_CODE_TTL_MS);
    return code;
  }

  consumeLoginCode(code: string): string | null {
    const row = this.db
      .prepare("DELETE FROM login_codes WHERE code_hash = ? RETURNING user_id, expires_at")
      .get(hashToken(code)) as { user_id: string; expires_at: number } | undefined;
    return row && row.expires_at >= Date.now() ? row.user_id : null;
  }

  private purgeExpired(): void {
    const now = Date.now();
    this.db.prepare("DELETE FROM oauth_states WHERE expires_at < ?").run(now);
    this.db.prepare("DELETE FROM login_codes WHERE expires_at < ?").run(now);
  }
}
