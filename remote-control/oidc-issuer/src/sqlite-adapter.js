import { DatabaseSync } from 'node:sqlite';

export const PRUNE_BATCH_SIZE = 1000;

// One local database, one issuer process. Do not put this file on a network share.
export function createSqliteStore(filename) {
  if (!filename || filename === ':memory:') throw new Error('A persistent database path is required');
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS oidc (
      model TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL,
      expires INTEGER, grant_id TEXT, uid TEXT, user_code TEXT,
      PRIMARY KEY(model, id));
    CREATE INDEX IF NOT EXISTS oidc_grant ON oidc(grant_id);
    CREATE INDEX IF NOT EXISTS oidc_uid ON oidc(model, uid);
    CREATE INDEX IF NOT EXISTS oidc_user_code ON oidc(model, user_code);
    CREATE INDEX IF NOT EXISTS oidc_expires ON oidc(expires) WHERE expires IS NOT NULL;`);
  const now = () => Math.floor(Date.now() / 1000);
  const select = (model, column, value) => {
    const row = db.prepare(`SELECT payload FROM oidc WHERE model=? AND ${column}=? AND (expires IS NULL OR expires>?)`).get(model, value, now());
    return row ? JSON.parse(row.payload) : undefined;
  };
  class Adapter {
    constructor(model) { this.model = model; }
    async upsert(id, payload, expiresIn) {
      db.prepare(`INSERT INTO oidc VALUES(?,?,?,?,?,?,?) ON CONFLICT(model,id) DO UPDATE SET
        payload=excluded.payload, expires=excluded.expires, grant_id=excluded.grant_id,
        uid=excluded.uid, user_code=excluded.user_code`).run(
        this.model, id, JSON.stringify(payload), expiresIn ? now() + expiresIn : null,
        payload.grantId ?? null, payload.uid ?? null, payload.userCode ?? null);
    }
    async find(id) { return select(this.model, 'id', id); }
    async findByUid(uid) { return select(this.model, 'uid', uid); }
    async findByUserCode(code) { return select(this.model, 'user_code', code); }
    async destroy(id) { db.prepare('DELETE FROM oidc WHERE model=? AND id=?').run(this.model, id); }
    // Single-statement consumption for HTTP interaction bindings, before network I/O.
    async take(id, expectedStage, expectedState) {
      const row = expectedState
        ? db.prepare("DELETE FROM oidc WHERE model=? AND id=? AND json_extract(payload,'$.stage')=? AND json_extract(payload,'$.state')=? RETURNING payload,expires").get(this.model, id, expectedStage, expectedState)
        : expectedStage
        ? db.prepare("DELETE FROM oidc WHERE model=? AND id=? AND json_extract(payload,'$.stage')=? RETURNING payload,expires").get(this.model, id, expectedStage)
        : db.prepare('DELETE FROM oidc WHERE model=? AND id=? RETURNING payload,expires').get(this.model, id);
      return row && (row.expires === null || row.expires > now()) ? JSON.parse(row.payload) : undefined;
    }
    async consume(id) {
      db.prepare("UPDATE oidc SET payload=json_set(payload,'$.consumed',?) WHERE model=? AND id=?").run(now(), this.model, id);
    }
    async revokeByGrantId(id) { db.prepare('DELETE FROM oidc WHERE grant_id=?').run(id); }
  }
  return {
    Adapter,
    health: () => { db.prepare('SELECT 1 FROM oidc LIMIT 1').get(); },
    close: () => db.close(),
    // Bound synchronous SQLite work even when starting with a large expired backlog.
    prune: () => db.prepare(`DELETE FROM oidc WHERE rowid IN (
      SELECT rowid FROM oidc WHERE expires IS NOT NULL AND expires<=?
      ORDER BY expires LIMIT ?
    )`).run(now(), PRUNE_BATCH_SIZE)
  };
}
