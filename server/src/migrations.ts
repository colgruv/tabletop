import type { DatabaseSync } from "node:sqlite";

/**
 * Schema migrations, applied in order. The database's `PRAGMA user_version` is
 * the number of migrations already applied. Never edit or reorder an entry
 * once it has shipped; append a new one instead.
 */
const MIGRATIONS: string[] = [
  // 1: the event log. IF NOT EXISTS because databases from before migrations
  // existed already have these tables at user_version 0.
  `
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
  `,
  // 2: accounts. Tokens are stored as SHA-256 hashes, never in the clear.
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE auth_tokens (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL
  );
  CREATE INDEX auth_tokens_user ON auth_tokens (user_id);
  `,
];

export function migrate(db: DatabaseSync): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
