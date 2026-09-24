import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HttpError } from "./errors.js";
import { canonicalJson, parseJson, randomId, sha256Hex } from "./utils.js";

const SCHEMA_VERSION = "1";
const AUDIT_GENESIS = "0".repeat(64);

export class WorkspaceDatabase {
  constructor(dbPath) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.dbPath = dbPath;
    this.db = new DatabaseSync(dbPath);
    this.closed = false;
    this.#configure();
    this.#migrate();
  }

  #configure() {
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA wal_autocheckpoint = 1000");
  }

  #migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS repos (
        repo_id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        manifest_path TEXT,
        git_url TEXT,
        default_branch TEXT,
        latest_sha TEXT,
        authority TEXT NOT NULL CHECK(authority IN ('candidate', 'canonical')),
        advisory INTEGER NOT NULL CHECK(advisory IN (0, 1)),
        risk_flags_json TEXT NOT NULL DEFAULT '[]',
        metadata_json TEXT NOT NULL DEFAULT '{}',
        fence_counter INTEGER NOT NULL DEFAULT 0,
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS leases (
        lease_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
        holder_principal TEXT NOT NULL,
        holder_node TEXT,
        base_sha TEXT NOT NULL,
        paths_json TEXT NOT NULL,
        fence_token INTEGER NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'released', 'expired')),
        task_id TEXT,
        acquired_at_epoch INTEGER NOT NULL,
        expires_at_epoch INTEGER NOT NULL,
        last_heartbeat_epoch INTEGER NOT NULL,
        released_at_epoch INTEGER,
        release_reason TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_leases_repo_status_expiry
        ON leases(repo_id, status, expires_at_epoch);

      CREATE TABLE IF NOT EXISTS tasks (
        task_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'in_progress', 'blocked', 'review_ready', 'completed', 'failed')),
        assigned_principal TEXT,
        base_sha TEXT NOT NULL,
        target_branch TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at_epoch INTEGER NOT NULL,
        updated_at_epoch INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_tasks_repo_status ON tasks(repo_id, status);

      CREATE TABLE IF NOT EXISTS handoffs (
        handoff_id TEXT PRIMARY KEY,
        task_id TEXT REFERENCES tasks(task_id) ON DELETE SET NULL,
        repo_id TEXT NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
        source_lease_id TEXT REFERENCES leases(lease_id) ON DELETE SET NULL,
        source_principal TEXT NOT NULL,
        target_principal TEXT,
        source_sha TEXT NOT NULL,
        notes TEXT NOT NULL,
        artifact_hashes_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL CHECK(status IN ('pending', 'accepted', 'closed')),
        created_at_epoch INTEGER NOT NULL,
        accepted_at_epoch INTEGER
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_handoffs_repo_status ON handoffs(repo_id, status);

      CREATE TABLE IF NOT EXISTS nodes (
        node_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        principal TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        last_seen_epoch INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS node_repos (
        node_id TEXT NOT NULL REFERENCES nodes(node_id) ON DELETE CASCADE,
        repo_id TEXT NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
        local_path TEXT,
        branch TEXT,
        head_sha TEXT,
        dirty INTEGER,
        exists_local INTEGER NOT NULL CHECK(exists_local IN (0, 1)),
        is_git INTEGER NOT NULL CHECK(is_git IN (0, 1)),
        state_hash TEXT,
        observed_at_epoch INTEGER NOT NULL,
        PRIMARY KEY(node_id, repo_id)
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_node_repos_repo ON node_repos(repo_id);

      CREATE TABLE IF NOT EXISTS deployments (
        deployment_id TEXT PRIMARY KEY,
        repo_id TEXT NOT NULL REFERENCES repos(repo_id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        environment TEXT NOT NULL,
        sha TEXT NOT NULL,
        url TEXT,
        status TEXT NOT NULL,
        source TEXT NOT NULL,
        observed_at_epoch INTEGER NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_deployments_repo_observed
        ON deployments(repo_id, observed_at_epoch DESC);

      CREATE TABLE IF NOT EXISTS artifacts (
        sha256 TEXT PRIMARY KEY,
        size_bytes INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        storage_path TEXT NOT NULL,
        producer_principal TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at_epoch INTEGER NOT NULL
      ) STRICT;

      CREATE TABLE IF NOT EXISTS idempotency (
        scope_key TEXT PRIMARY KEY,
        key_value TEXT NOT NULL,
        principal TEXT NOT NULL,
        operation TEXT NOT NULL,
        request_hash TEXT NOT NULL,
        response_json TEXT NOT NULL,
        created_at_epoch INTEGER NOT NULL,
        expires_at_epoch INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_idempotency_expiry ON idempotency(expires_at_epoch);

      CREATE TABLE IF NOT EXISTS audit_events (
        event_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        timestamp_epoch INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        principal TEXT NOT NULL,
        resource TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        hash TEXT NOT NULL UNIQUE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_audit_seq ON audit_events(seq);
    `);

    const current = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (current && current.value !== SCHEMA_VERSION) {
      throw new Error(`Unsupported workspace database schema version: ${current.value}`);
    }
    if (!current) {
      this.db.prepare("INSERT INTO meta(key, value) VALUES('schema_version', ?)").run(SCHEMA_VERSION);
    }
  }

  nowEpoch() {
    return Number(this.db.prepare("SELECT unixepoch() AS now").get().now);
  }

  transaction(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original transaction error.
      }
      throw error;
    }
  }

  withIdempotency({ key, principal, operation, request, ttlSeconds }, fn) {
    if (typeof key !== "string" || !key.trim() || key.length > 200) {
      throw new HttpError(400, "idempotency_key_required", "A valid Idempotency-Key is required");
    }
    const normalizedKey = key.trim();
    const requestJson = canonicalJson(request);
    const requestHash = sha256Hex(requestJson);
    const scopeKey = sha256Hex(`${principal}\n${operation}\n${normalizedKey}`);

    return this.transaction(() => {
      const now = this.nowEpoch();
      this.db.prepare("DELETE FROM idempotency WHERE expires_at_epoch <= ?").run(now);
      const existing = this.db.prepare("SELECT * FROM idempotency WHERE scope_key = ?").get(scopeKey);
      if (existing) {
        if (existing.request_hash !== requestHash) {
          throw new HttpError(409, "idempotency_conflict", "Idempotency key was reused with a different request");
        }
        return {
          replayed: true,
          value: parseJson(existing.response_json, null),
        };
      }

      const value = fn({ now, requestJson, requestHash });
      const responseJson = canonicalJson(value);
      this.db.prepare(`
        INSERT INTO idempotency(
          scope_key, key_value, principal, operation, request_hash,
          response_json, created_at_epoch, expires_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        scopeKey,
        normalizedKey,
        principal,
        operation,
        requestHash,
        responseJson,
        now,
        now + ttlSeconds,
      );
      return { replayed: false, value };
    });
  }

  appendAudit({ eventType, principal, resource, payload }) {
    const last = this.db.prepare(
      "SELECT seq, hash FROM audit_events ORDER BY seq DESC LIMIT 1",
    ).get();
    const seq = Number(last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? AUDIT_GENESIS;
    const timestamp = this.nowEpoch();
    const payloadJson = canonicalJson(payload ?? {});
    const eventId = randomId();
    const hash = sha256Hex(
      [prevHash, seq, timestamp, eventType, principal, resource, payloadJson].join("|"),
    );
    this.db.prepare(`
      INSERT INTO audit_events(
        event_id, seq, timestamp_epoch, event_type, principal,
        resource, payload_json, prev_hash, hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      seq,
      timestamp,
      eventType,
      principal,
      resource,
      payloadJson,
      prevHash,
      hash,
    );
    return { event_id: eventId, seq, timestamp_epoch: timestamp, prev_hash: prevHash, hash };
  }

  verifyAuditChain() {
    const rows = this.db.prepare("SELECT * FROM audit_events ORDER BY seq").all();
    let prevHash = AUDIT_GENESIS;
    let expectedSeq = 1;
    for (const row of rows) {
      if (Number(row.seq) !== expectedSeq || row.prev_hash !== prevHash) {
        return {
          valid: false,
          count: rows.length,
          failed_seq: Number(row.seq),
          reason: "sequence_or_prev_hash_mismatch",
        };
      }
      const expectedHash = sha256Hex(
        [
          row.prev_hash,
          row.seq,
          row.timestamp_epoch,
          row.event_type,
          row.principal,
          row.resource,
          row.payload_json,
        ].join("|"),
      );
      if (expectedHash !== row.hash) {
        return {
          valid: false,
          count: rows.length,
          failed_seq: Number(row.seq),
          reason: "hash_mismatch",
        };
      }
      prevHash = row.hash;
      expectedSeq += 1;
    }
    return {
      valid: true,
      count: rows.length,
      tail_hash: rows.length ? rows.at(-1).hash : AUDIT_GENESIS,
    };
  }

  checkpoint() {
    if (!this.closed) {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    }
  }

  close() {
    if (this.closed) return;
    this.checkpoint();
    this.db.close();
    this.closed = true;
  }
}

export { AUDIT_GENESIS, SCHEMA_VERSION };
