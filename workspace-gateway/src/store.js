import { HttpError } from "./errors.js";
import {
  normalizeRepoId,
  normalizeResourcePaths,
  normalizeSha,
  pathsOverlap,
} from "./paths.js";
import { asBoolean, canonicalJson, parseJson, positiveInteger, randomId, sha256Hex } from "./utils.js";

const TASK_STATUSES = new Set([
  "pending",
  "claimed",
  "in_progress",
  "blocked",
  "review_ready",
  "completed",
  "failed",
]);

function text(value, field, { required = true, max = 500 } = {}) {
  if (value === undefined || value === null || value === "") {
    if (!required) return null;
    throw new HttpError(400, "invalid_field", `${field} is required`);
  }
  if (typeof value !== "string" || !value.trim() || value.trim().length > max) {
    throw new HttpError(400, "invalid_field", `${field} must be a non-empty string up to ${max} characters`);
  }
  return value.trim();
}

function optionalSha(value, field) {
  if (value === undefined || value === null || value === "") return null;
  return normalizeSha(value, field);
}

function jsonObject(value, field) {
  if (value === undefined || value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "invalid_field", `${field} must be an object`);
  }
  return value;
}

function ttlSeconds(value, config) {
  try {
    return positiveInteger(
      value,
      config.defaultLeaseTtlSeconds,
      { min: config.minLeaseTtlSeconds, max: config.maxLeaseTtlSeconds },
    );
  } catch {
    throw new HttpError(
      400,
      "invalid_ttl",
      `ttl_seconds must be between ${config.minLeaseTtlSeconds} and ${config.maxLeaseTtlSeconds}`,
    );
  }
}

function fenceToken(value) {
  try {
    return positiveInteger(value, undefined, { min: 1 });
  } catch {
    throw new HttpError(400, "invalid_fencing_token", "fencing_token must be a positive integer");
  }
}

function repoRow(row) {
  if (!row) return null;
  return {
    repo_id: row.repo_id,
    display_name: row.display_name,
    manifest_path: row.manifest_path,
    git_url: row.git_url,
    default_branch: row.default_branch,
    latest_sha: row.latest_sha,
    authority: row.authority,
    advisory: asBoolean(row.advisory),
    risk_flags: parseJson(row.risk_flags_json, []),
    metadata: parseJson(row.metadata_json, {}),
    fence_counter: Number(row.fence_counter),
    created_at_epoch: Number(row.created_at_epoch),
    updated_at_epoch: Number(row.updated_at_epoch),
  };
}

function leaseRow(row) {
  if (!row) return null;
  return {
    lease_id: row.lease_id,
    repo_id: row.repo_id,
    holder_principal: row.holder_principal,
    holder_node: row.holder_node,
    base_sha: row.base_sha,
    paths: parseJson(row.paths_json, []),
    fencing_token: Number(row.fence_token),
    status: row.status,
    task_id: row.task_id,
    acquired_at_epoch: Number(row.acquired_at_epoch),
    expires_at_epoch: Number(row.expires_at_epoch),
    last_heartbeat_epoch: Number(row.last_heartbeat_epoch),
    released_at_epoch: row.released_at_epoch === null ? null : Number(row.released_at_epoch),
    release_reason: row.release_reason,
  };
}

function taskRow(row) {
  if (!row) return null;
  return {
    task_id: row.task_id,
    repo_id: row.repo_id,
    title: row.title,
    status: row.status,
    assigned_principal: row.assigned_principal,
    base_sha: row.base_sha,
    target_branch: row.target_branch,
    metadata: parseJson(row.metadata_json, {}),
    created_at_epoch: Number(row.created_at_epoch),
    updated_at_epoch: Number(row.updated_at_epoch),
  };
}

function handoffRow(row) {
  if (!row) return null;
  return {
    handoff_id: row.handoff_id,
    task_id: row.task_id,
    repo_id: row.repo_id,
    source_lease_id: row.source_lease_id,
    source_principal: row.source_principal,
    target_principal: row.target_principal,
    source_sha: row.source_sha,
    notes: row.notes,
    artifact_hashes: parseJson(row.artifact_hashes_json, []),
    status: row.status,
    created_at_epoch: Number(row.created_at_epoch),
    accepted_at_epoch: row.accepted_at_epoch === null ? null : Number(row.accepted_at_epoch),
  };
}

function artifactHash(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value.trim())) {
    throw new HttpError(400, "invalid_artifact_hash", "Artifact hashes must be SHA-256 hex strings");
  }
  return value.trim().toLowerCase();
}

function candidateRepoId(record) {
  const explicit = record?.repo_id;
  if (explicit) return normalizeRepoId(explicit);
  return normalizeRepoId(record?.manifest?.name ?? record?.name ?? "");
}

export class WorkspaceStore {
  constructor(database, config) {
    this.database = database;
    this.db = database.db;
    this.config = config;
  }

  #idempotent({ key, principal, operation, request }, fn) {
    return this.database.withIdempotency(
      {
        key,
        principal: principal.id,
        operation,
        request,
        ttlSeconds: this.config.idempotencyTtlSeconds,
      },
      fn,
    );
  }

  #requireRepo(repoId) {
    const normalized = normalizeRepoId(repoId);
    const row = this.db.prepare("SELECT * FROM repos WHERE repo_id = ?").get(normalized);
    if (!row) {
      throw new HttpError(404, "repo_not_found", `Unknown repo: ${normalized}`);
    }
    return row;
  }

  #validateLease({ leaseId, fencingToken, principal, repoId = null, now = null }) {
    const row = this.db.prepare("SELECT * FROM leases WHERE lease_id = ?").get(leaseId);
    if (!row) {
      throw new HttpError(404, "lease_not_found", "Lease does not exist");
    }
    const current = now ?? this.database.nowEpoch();
    if (row.status !== "active" || Number(row.expires_at_epoch) <= current) {
      if (row.status === "active") {
        this.db.prepare(
          "UPDATE leases SET status = 'expired', release_reason = 'ttl_expired', released_at_epoch = ? WHERE lease_id = ?",
        ).run(current, leaseId);
      }
      throw new HttpError(409, "lease_expired", "Lease is no longer active");
    }
    if (Number(row.fence_token) !== Number(fencingToken)) {
      throw new HttpError(409, "stale_fencing_token", "Lease fencing token is stale");
    }
    if (repoId && row.repo_id !== normalizeRepoId(repoId)) {
      throw new HttpError(409, "lease_repo_mismatch", "Lease belongs to a different repo");
    }
    if (principal.role !== "admin" && row.holder_principal !== principal.id) {
      throw new HttpError(403, "lease_owner_mismatch", "Lease belongs to a different principal");
    }
    return row;
  }

  importRegistry(candidate, principal, idempotencyKey) {
    if (!candidate || typeof candidate !== "object" || !Array.isArray(candidate.repos)) {
      throw new HttpError(400, "invalid_registry", "Registry import must contain a repos array");
    }
    if (candidate.authority !== "candidate" || candidate.advisory !== true) {
      throw new HttpError(
        400,
        "candidate_registry_required",
        "v1 imports only advisory candidate registries",
      );
    }

    const prepared = [];
    const seen = new Set();
    for (const record of candidate.repos) {
      const repoId = candidateRepoId(record);
      if (seen.has(repoId)) {
        throw new HttpError(409, "duplicate_repo_id", `Duplicate repo_id in import: ${repoId}`);
      }
      seen.add(repoId);
      const displayName = text(record?.manifest?.name ?? record?.name, "repo name", { max: 200 });
      const manifestPath = text(record?.manifest?.path ?? record?.path, "repo path", { max: 1000 });
      const local = record?.local && typeof record.local === "object" ? record.local : {};
      const latestSha = optionalSha(local.head_sha ?? record.latest_sha, "latest_sha");
      const gitUrl = text(local.origin_url ?? record.git_url, "git_url", { required: false, max: 2000 });
      const defaultBranch = text(local.branch ?? record.default_branch, "default_branch", { required: false, max: 300 });
      const riskFlags = Array.isArray(record.risk_flags)
        ? [...new Set(record.risk_flags.filter((item) => typeof item === "string"))].sort()
        : [];
      prepared.push({
        repoId,
        displayName,
        manifestPath,
        gitUrl,
        defaultBranch,
        latestSha,
        riskFlags,
        metadata: {
          identity_key: record.identity_key ?? null,
          source_manifest: candidate.source_manifest ?? null,
          local_observation: local,
        },
      });
    }

    return this.#idempotent(
      {
        key: idempotencyKey,
        principal,
        operation: "registry.import",
        request: candidate,
      },
      ({ now }) => {
        const statement = this.db.prepare(`
          INSERT INTO repos(
            repo_id, display_name, manifest_path, git_url, default_branch,
            latest_sha, authority, advisory, risk_flags_json, metadata_json,
            fence_counter, created_at_epoch, updated_at_epoch
          ) VALUES (?, ?, ?, ?, ?, ?, 'candidate', 1, ?, ?, 0, ?, ?)
          ON CONFLICT(repo_id) DO UPDATE SET
            display_name = excluded.display_name,
            manifest_path = excluded.manifest_path,
            git_url = excluded.git_url,
            default_branch = excluded.default_branch,
            latest_sha = excluded.latest_sha,
            authority = 'candidate',
            advisory = 1,
            risk_flags_json = excluded.risk_flags_json,
            metadata_json = excluded.metadata_json,
            updated_at_epoch = excluded.updated_at_epoch
        `);
        for (const repo of prepared) {
          statement.run(
            repo.repoId,
            repo.displayName,
            repo.manifestPath,
            repo.gitUrl,
            repo.defaultBranch,
            repo.latestSha,
            canonicalJson(repo.riskFlags),
            canonicalJson(repo.metadata),
            now,
            now,
          );
        }
        this.database.appendAudit({
          eventType: "registry.imported",
          principal: principal.id,
          resource: "registry",
          payload: {
            count: prepared.length,
            repo_ids: prepared.map((repo) => repo.repoId),
            source_manifest: candidate.source_manifest ?? null,
          },
        });
        return {
          imported: prepared.length,
          repo_ids: prepared.map((repo) => repo.repoId),
          authority: "candidate",
          advisory: true,
        };
      },
    );
  }

  promoteRepo(repoIdInput, input, principal, idempotencyKey) {
    const repoId = normalizeRepoId(repoIdInput);
    const gitUrl = text(input.git_url, "git_url", { max: 2000 });
    const defaultBranch = text(input.default_branch, "default_branch", { max: 300 });
    const latestSha = normalizeSha(input.latest_sha, "latest_sha");
    const evidence = jsonObject(input.evidence, "evidence");
    if (Object.keys(evidence).length === 0) {
      throw new HttpError(400, "promotion_evidence_required", "Canonical promotion requires evidence metadata");
    }

    return this.#idempotent(
      {
        key: idempotencyKey,
        principal,
        operation: `repo.promote:${repoId}`,
        request: {
          git_url: gitUrl,
          default_branch: defaultBranch,
          latest_sha: latestSha,
          evidence,
        },
      },
      ({ now }) => {
        const repo = this.#requireRepo(repoId);
        this.db.prepare(`
          UPDATE repos
          SET git_url = ?,
              default_branch = ?,
              latest_sha = ?,
              authority = 'canonical',
              advisory = 0,
              risk_flags_json = '[]',
              metadata_json = ?,
              updated_at_epoch = ?
          WHERE repo_id = ?
        `).run(
          gitUrl,
          defaultBranch,
          latestSha,
          canonicalJson({
            ...parseJson(repo.metadata_json, {}),
            canonical_evidence: evidence,
            promoted_by: principal.id,
            promoted_at_epoch: now,
          }),
          now,
          repoId,
        );
        this.database.appendAudit({
          eventType: "repo.promoted",
          principal: principal.id,
          resource: `repo:${repoId}`,
          payload: {
            git_url: gitUrl,
            default_branch: defaultBranch,
            latest_sha: latestSha,
            evidence,
          },
        });
        return {
          repo: repoRow(this.db.prepare("SELECT * FROM repos WHERE repo_id = ?").get(repoId)),
        };
      },
    );
  }

  updateCanonicalHead(repoIdInput, input, principal, idempotencyKey) {
    const repoId = normalizeRepoId(repoIdInput);
    const expectedSha = normalizeSha(input.expected_sha, "expected_sha");
    const latestSha = normalizeSha(input.latest_sha, "latest_sha");
    const evidence = jsonObject(input.evidence, "evidence");
    if (Object.keys(evidence).length === 0) {
      throw new HttpError(400, "head_evidence_required", "Canonical head updates require evidence metadata");
    }

    return this.#idempotent(
      {
        key: idempotencyKey,
        principal,
        operation: `repo.head.update:${repoId}`,
        request: { expected_sha: expectedSha, latest_sha: latestSha, evidence },
      },
      ({ now }) => {
        const repo = this.#requireRepo(repoId);
        if (repo.authority !== "canonical") {
          throw new HttpError(409, "repo_not_canonical", "Only canonical repos can advance canonical head state");
        }
        if (repo.latest_sha !== expectedSha) {
          throw new HttpError(409, "canonical_head_conflict", "expected_sha does not match current canonical head", {
            expected: repo.latest_sha,
            provided: expectedSha,
          });
        }
        this.db.prepare(
          "UPDATE repos SET latest_sha = ?, updated_at_epoch = ? WHERE repo_id = ?",
        ).run(latestSha, now, repoId);
        this.database.appendAudit({
          eventType: "repo.head.updated",
          principal: principal.id,
          resource: `repo:${repoId}`,
          payload: { expected_sha: expectedSha, latest_sha: latestSha, evidence },
        });
        return {
          repo: repoRow(this.db.prepare("SELECT * FROM repos WHERE repo_id = ?").get(repoId)),
        };
      },
    );
  }

  listRepos() {
    return this.db
      .prepare("SELECT * FROM repos ORDER BY repo_id")
      .all()
      .map(repoRow);
  }

  resolveWorkspace(identifier) {
    const raw = text(identifier, "repo identifier", { max: 200 });
    let normalized = null;
    try {
      normalized = normalizeRepoId(raw);
    } catch {
      // Display-name lookup below may still resolve the workspace.
    }
    const repo = normalized
      ? this.db.prepare(
        "SELECT * FROM repos WHERE repo_id = ? OR lower(display_name) = lower(?) ORDER BY repo_id LIMIT 1",
      ).get(normalized, raw)
      : this.db.prepare(
        "SELECT * FROM repos WHERE lower(display_name) = lower(?) ORDER BY repo_id LIMIT 1",
      ).get(raw);
    if (!repo) {
      throw new HttpError(404, "repo_not_found", `Unknown workspace: ${raw}`);
    }
    const now = this.database.nowEpoch();
    const leases = this.db.prepare(
      "SELECT * FROM leases WHERE repo_id = ? AND status = 'active' AND expires_at_epoch > ? ORDER BY acquired_at_epoch",
    ).all(repo.repo_id, now).map(leaseRow);
    const tasks = this.db.prepare(
      "SELECT * FROM tasks WHERE repo_id = ? AND status NOT IN ('completed', 'failed') ORDER BY created_at_epoch",
    ).all(repo.repo_id).map(taskRow);
    const handoffs = this.db.prepare(
      "SELECT * FROM handoffs WHERE repo_id = ? AND status = 'pending' ORDER BY created_at_epoch",
    ).all(repo.repo_id).map(handoffRow);
    const nodes = this.db.prepare(`
      SELECT n.node_id, n.status, n.last_seen_epoch, nr.local_path, nr.branch,
             nr.head_sha, nr.dirty, nr.exists_local, nr.is_git, nr.state_hash,
             nr.observed_at_epoch
      FROM node_repos nr
      JOIN nodes n ON n.node_id = nr.node_id
      WHERE nr.repo_id = ?
      ORDER BY n.node_id
    `).all(repo.repo_id).map((row) => ({
      node_id: row.node_id,
      status: row.status,
      last_seen_epoch: Number(row.last_seen_epoch),
      local_path: row.local_path,
      branch: row.branch,
      head_sha: row.head_sha,
      dirty: row.dirty === null ? null : asBoolean(row.dirty),
      exists: asBoolean(row.exists_local),
      is_git: asBoolean(row.is_git),
      state_hash: row.state_hash,
      observed_at_epoch: Number(row.observed_at_epoch),
    }));
    const deployments = this.db.prepare(
      "SELECT * FROM deployments WHERE repo_id = ? ORDER BY observed_at_epoch DESC LIMIT 20",
    ).all(repo.repo_id).map((row) => ({
      deployment_id: row.deployment_id,
      provider: row.provider,
      environment: row.environment,
      sha: row.sha,
      url: row.url,
      status: row.status,
      source: row.source,
      observed_at_epoch: Number(row.observed_at_epoch),
      metadata: parseJson(row.metadata_json, {}),
    }));
    return {
      repo: repoRow(repo),
      active_leases: leases,
      open_tasks: tasks,
      pending_handoffs: handoffs,
      node_observations: nodes,
      deployments,
      resolved_at_epoch: now,
    };
  }

  acquireLease(input, principal, idempotencyKey) {
    const repoId = normalizeRepoId(input.repo_id);
    const paths = normalizeResourcePaths(input.paths);
    const baseSha = normalizeSha(input.base_sha, "base_sha");
    const ttl = ttlSeconds(input.ttl_seconds, this.config);
    const holderNode = text(input.holder_node, "holder_node", { required: false, max: 200 });
    const taskId = text(input.task_id, "task_id", { required: false, max: 200 });

    return this.#idempotent(
      {
        key: idempotencyKey,
        principal,
        operation: "lease.acquire",
        request: { repo_id: repoId, paths, base_sha: baseSha, ttl_seconds: ttl, holder_node: holderNode, task_id: taskId },
      },
      ({ now }) => {
        const repo = this.#requireRepo(repoId);
        if (repo.authority === "canonical" && repo.latest_sha && repo.latest_sha !== baseSha) {
          throw new HttpError(409, "base_sha_stale", "base_sha does not match the canonical repo SHA", {
            expected: repo.latest_sha,
            provided: baseSha,
          });
        }
        if (taskId) {
          const task = this.db.prepare("SELECT repo_id FROM tasks WHERE task_id = ?").get(taskId);
          if (!task || task.repo_id !== repoId) {
            throw new HttpError(409, "task_repo_mismatch", "task_id is not bound to this repo");
          }
        }

        this.db.prepare(`
          UPDATE leases
          SET status = 'expired', released_at_epoch = ?, release_reason = 'ttl_expired'
          WHERE repo_id = ? AND status = 'active' AND expires_at_epoch <= ?
        `).run(now, repoId, now);

        const active = this.db.prepare(
          "SELECT * FROM leases WHERE repo_id = ? AND status = 'active' AND expires_at_epoch > ?",
        ).all(repoId, now);
        for (const lease of active) {
          const existingPaths = parseJson(lease.paths_json, []);
          if (paths.some((requested) => existingPaths.some((existing) => pathsOverlap(requested, existing)))) {
            throw new HttpError(409, "lease_conflict", "Requested paths overlap an active lease", {
              lease_id: lease.lease_id,
              holder_principal: lease.holder_principal,
              paths: existingPaths,
              expires_at_epoch: Number(lease.expires_at_epoch),
            });
          }
        }

        const fence = this.db.prepare(
          "UPDATE repos SET fence_counter = fence_counter + 1, updated_at_epoch = ? WHERE repo_id = ? RETURNING fence_counter",
        ).get(now, repoId);
        const leaseId = randomId();
        const expiresAt = now + ttl;
        this.db.prepare(`
          INSERT INTO leases(
            lease_id, repo_id, holder_principal, holder_node, base_sha, paths_json,
            fence_token, status, task_id, acquired_at_epoch, expires_at_epoch,
            last_heartbeat_epoch, released_at_epoch, release_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL)
        `).run(
          leaseId,
          repoId,
          principal.id,
          holderNode,
          baseSha,
          canonicalJson(paths),
          Number(fence.fence_counter),
          taskId,
          now,
          expiresAt,
          now,
        );
        const created = this.db.prepare("SELECT * FROM leases WHERE lease_id = ?").get(leaseId);
        this.database.appendAudit({
          eventType: "lease.acquired",
          principal: principal.id,
          resource: `repo:${repoId}`,
          payload: {
            lease_id: leaseId,
            paths,
            base_sha: baseSha,
            fencing_token: Number(fence.fence_counter),
            expires_at_epoch: expiresAt,
          },
        });
        return {
          lease: leaseRow(created),
          base_matches_observed_sha: repo.latest_sha ? repo.latest_sha === baseSha : null,
          authority: repo.authority,
        };
      },
    );
  }

  renewLease(leaseId, input, principal, idempotencyKey) {
    const token = fenceToken(input.fencing_token);
    const ttl = ttlSeconds(input.ttl_seconds, this.config);
    return this.#idempotent(
      {
        key: idempotencyKey,
        principal,
        operation: `lease.renew:${leaseId}`,
        request: { fencing_token: token, ttl_seconds: ttl },
      },
      ({ now }) => {
        const lease = this.#validateLease({
          leaseId,
          fencingToken: token,
          principal,
          now,
        });
        const expiresAt = now + ttl;
        this.db.prepare(
          "UPDATE leases SET expires_at_epoch = ?, last_heartbeat_epoch = ? WHERE lease_id = ?",
        ).run(expiresAt, now, leaseId);
        this.database.appendAudit({
          eventType: "lease.renewed",
          principal: principal.id,
          resource: `lease:${leaseId}`,
          payload: { fencing_token: token, expires_at_epoch: expiresAt },
        });
        return {
          lease: leaseRow(this.db.prepare("SELECT * FROM leases WHERE lease_id = ?").get(leaseId)),
        };
      },
    );
  }

  releaseLease(leaseId, input, principal, idempotencyKey) {
    const token = fenceToken(input.fencing_token);
    const reason = text(input.reason ?? "released_by_holder", "reason", { max: 300 });
    return this.#idempotent(
      {
        key: idempotencyKey,
        principal,
        operation: `lease.release:${leaseId}`,
        request: { fencing_token: token, reason },
      },
      ({ now }) => {
        this.#validateLease({ leaseId, fencingToken: token, principal, now });
        this.db.prepare(
          "UPDATE leases SET status = 'released', released_at_epoch = ?, release_reason = ? WHERE lease_id = ?",
        ).run(now, reason, leaseId);
        this.database.appendAudit({
          eventType: "lease.released",
          principal: principal.id,
          resource: `lease:${leaseId}`,
          payload: { fencing_token: token, reason },
        });
        return {
          lease: leaseRow(this.db.prepare("SELECT * FROM leases WHERE lease_id = ?").get(leaseId)),
        };
      },
    );
  }

  createTask(input, principal, idempotencyKey) {
    const repoId = normalizeRepoId(input.repo_id);
    const title = text(input.title, "title", { max: 500 });
    const baseSha = normalizeSha(input.base_sha, "base_sha");
    const targetBranch = text(input.target_branch, "target_branch", { max: 300 });
    const assigned = text(input.assigned_principal, "assigned_principal", { required: false, max: 200 });
    const metadata = jsonObject(input.metadata, "metadata");

    return this.#idempotent(
      {
        key: idempotencyKey,
        principal,
        operation: "task.create",
        request: { repo_id: repoId, title, base_sha: baseSha, target_branch: targetBranch, assigned_principal: assigned, metadata },
      },
      ({ now }) => {
        this.#requireRepo(repoId);
        const taskId = randomId();
        this.db.prepare(`
          INSERT INTO tasks(
            task_id, repo_id, title, status, assigned_principal, base_sha,
            target_branch, metadata_json, created_at_epoch, updated_at_epoch
          ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
        `).run(
          taskId,
          repoId,
          title,
          assigned,
          baseSha,
          targetBranch,
          canonicalJson(metadata),
          now,
          now,
        );
        this.database.appendAudit({
          eventType: "task.created",
          principal: principal.id,
          resource: `task:${taskId}`,
          payload: { repo_id: repoId, base_sha: baseSha, target_branch: targetBranch },
        });
        return { task: taskRow(this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId)) };
      },
    );
  }

  updateTask(taskId, input, principal, idempotencyKey) {
    const status = text(input.status, "status", { max: 50 });
    if (!TASK_STATUSES.has(status)) {
      throw new HttpError(400, "invalid_task_status", "Unsupported task status");
    }
    const leaseId = text(input.lease_id, "lease_id", { max: 200 });
    const token = fenceToken(input.fencing_token);
    const metadata = jsonObject(input.metadata, "metadata");

    return this.#idempotent(
      {
        key: idempotencyKey,
        principal,
        operation: `task.update:${taskId}`,
        request: { status, lease_id: leaseId, fencing_token: token, metadata },
      },
      ({ now }) => {
        const task = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
        if (!task) throw new HttpError(404, "task_not_found", "Task does not exist");
        this.#validateLease({
          leaseId,
          fencingToken: token,
          principal,
          repoId: task.repo_id,
          now,
        });
        this.db.prepare(
          "UPDATE tasks SET status = ?, assigned_principal = ?, metadata_json = ?, updated_at_epoch = ? WHERE task_id = ?",
        ).run(status, principal.id, canonicalJson(metadata), now, taskId);
        this.database.appendAudit({
          eventType: "task.updated",
          principal: principal.id,
          resource: `task:${taskId}`,
          payload: { status, lease_id: leaseId, fencing_token: token },
        });
        return { task: taskRow(this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId)) };
      },
    );
  }

  createHandoff(input, principal, idempotencyKey) {
    const leaseId = text(input.lease_id, "lease_id", { max: 200 });
    const token = fenceToken(input.fencing_token);
    const notes = text(input.notes, "notes", { max: 10_000 });
    const target = text(input.target_principal, "target_principal", { required: false, max: 200 });
    const sourceSha = normalizeSha(input.source_sha, "source_sha");
    const taskId = text(input.task_id, "task_id", { required: false, max: 200 });
    const hashes = Array.isArray(input.artifact_hashes)
      ? [...new Set(input.artifact_hashes.map(artifactHash))].sort()
      : [];

    return this.#idempotent(
      {
        key: idempotencyKey,
        principal,
        operation: "handoff.create",
        request: { lease_id: leaseId, fencing_token: token, notes, target_principal: target, source_sha: sourceSha, task_id: taskId, artifact_hashes: hashes },
      },
      ({ now }) => {
        const lease = this.#validateLease({ leaseId, fencingToken: token, principal, now });
        if (taskId) {
          const task = this.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
          if (!task || task.repo_id !== lease.repo_id) {
            throw new HttpError(409, "task_repo_mismatch", "task_id is not bound to the lease repo");
          }
        }
        const handoffId = randomId();
        this.db.prepare(`
          INSERT INTO handoffs(
            handoff_id, task_id, repo_id, source_lease_id, source_principal,
            target_principal, source_sha, notes, artifact_hashes_json, status,
            created_at_epoch, accepted_at_epoch
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
        `).run(
          handoffId,
          taskId,
          lease.repo_id,
          leaseId,
          principal.id,
          target,
          sourceSha,
          notes,
          canonicalJson(hashes),
          now,
        );
        this.database.appendAudit({
          eventType: "handoff.created",
          principal: principal.id,
          resource: `handoff:${handoffId}`,
          payload: { repo_id: lease.repo_id, source_lease_id: leaseId, target_principal: target, artifact_hashes: hashes },
        });
        return { handoff: handoffRow(this.db.prepare("SELECT * FROM handoffs WHERE handoff_id = ?").get(handoffId)) };
      },
    );
  }
  acceptHandoff(handoffId, input, principal, idempotencyKey) {
    const ttl = ttlSeconds(input.ttl_seconds, this.config);
    const holderNode = text(input.holder_node, "holder_node", { required: false, max: 200 });
    return this.#idempotent(
      {
        key: idempotencyKey,
        principal,
        operation: `handoff.accept:${handoffId}`,
        request: { ttl_seconds: ttl, holder_node: holderNode },
      },
      ({ now }) => {
        const handoff = this.db.prepare("SELECT * FROM handoffs WHERE handoff_id = ?").get(handoffId);
        if (!handoff) throw new HttpError(404, "handoff_not_found", "Handoff does not exist");
        if (handoff.status !== "pending") {
          throw new HttpError(409, "handoff_not_pending", "Handoff has already been accepted or closed");
        }
        if (handoff.target_principal && principal.role !== "admin" && handoff.target_principal !== principal.id) {
          throw new HttpError(403, "handoff_target_mismatch", "Handoff targets a different principal");
        }
        const sourceLease = this.db.prepare("SELECT * FROM leases WHERE lease_id = ?").get(handoff.source_lease_id);
        if (!sourceLease) throw new HttpError(409, "source_lease_missing", "Source lease is unavailable");
        const sourcePaths = parseJson(sourceLease.paths_json, []);

        this.db.prepare(`
          UPDATE leases
          SET status = 'expired', released_at_epoch = ?, release_reason = 'ttl_expired'
          WHERE repo_id = ? AND status = 'active' AND expires_at_epoch <= ?
        `).run(now, handoff.repo_id, now);

        const conflicts = this.db.prepare(
          "SELECT * FROM leases WHERE repo_id = ? AND status = 'active' AND expires_at_epoch > ? AND lease_id <> ?",
        ).all(handoff.repo_id, now, sourceLease.lease_id);
        for (const lease of conflicts) {
          const paths = parseJson(lease.paths_json, []);
          if (sourcePaths.some((requested) => paths.some((existing) => pathsOverlap(requested, existing)))) {
            throw new HttpError(409, "lease_conflict", "Handoff paths now overlap another active lease", {
              lease_id: lease.lease_id,
              holder_principal: lease.holder_principal,
            });
          }
        }

        if (sourceLease.status === "active") {
          this.db.prepare(
            "UPDATE leases SET status = 'released', released_at_epoch = ?, release_reason = 'handoff_accepted' WHERE lease_id = ?",
          ).run(now, sourceLease.lease_id);
        }
        const fence = this.db.prepare(
          "UPDATE repos SET fence_counter = fence_counter + 1, updated_at_epoch = ? WHERE repo_id = ? RETURNING fence_counter",
        ).get(now, handoff.repo_id);
        const leaseId = randomId();
        const expiresAt = now + ttl;
        this.db.prepare(`
          INSERT INTO leases(
            lease_id, repo_id, holder_principal, holder_node, base_sha, paths_json,
            fence_token, status, task_id, acquired_at_epoch, expires_at_epoch,
            last_heartbeat_epoch, released_at_epoch, release_reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, NULL, NULL)
        `).run(
          leaseId,
          handoff.repo_id,
          principal.id,
          holderNode,
          sourceLease.base_sha,
          sourceLease.paths_json,
          Number(fence.fence_counter),
          handoff.task_id,
          now,
          expiresAt,
          now,
        );
        this.db.prepare(
          "UPDATE handoffs SET status = 'accepted', target_principal = ?, accepted_at_epoch = ? WHERE handoff_id = ?",
        ).run(principal.id, now, handoffId);
        this.database.appendAudit({
          eventType: "handoff.accepted",
          principal: principal.id,
          resource: `handoff:${handoffId}`,
          payload: {
            prior_lease_id: sourceLease.lease_id,
            new_lease_id: leaseId,
            fencing_token: Number(fence.fence_counter),
          },
        });
        return {
          handoff: handoffRow(this.db.prepare("SELECT * FROM handoffs WHERE handoff_id = ?").get(handoffId)),
          lease: leaseRow(this.db.prepare("SELECT * FROM leases WHERE lease_id = ?").get(leaseId)),
        };
      },
    );
  }

  reportNode(nodeIdInput, input, principal, idempotencyKey) {
    const nodeId = text(nodeIdInput, "node_id", { max: 200 });
    const status = text(input.status ?? "online", "status", { max: 100 });
    const metadata = jsonObject(input.metadata, "metadata");
    if (!Array.isArray(input.repos)) {
      throw new HttpError(400, "invalid_node_report", "repos must be an array");
    }

    return this.#idempotent(
      {
        key: idempotencyKey,
        principal,
        operation: `node.report:${nodeId}`,
        request: { status, metadata, repos: input.repos },
      },
      ({ now }) => {
        this.db.prepare(`
          INSERT INTO nodes(node_id, status, principal, metadata_json, last_seen_epoch)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(node_id) DO UPDATE SET
            status = excluded.status,
            principal = excluded.principal,
            metadata_json = excluded.metadata_json,
            last_seen_epoch = excluded.last_seen_epoch
        `).run(nodeId, status, principal.id, canonicalJson(metadata), now);

        this.db.prepare("DELETE FROM node_repos WHERE node_id = ?").run(nodeId);
        const insert = this.db.prepare(`
          INSERT INTO node_repos(
            node_id, repo_id, local_path, branch, head_sha, dirty, exists_local,
            is_git, state_hash, observed_at_epoch
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const reported = [];
        const ignored = [];
        for (const observation of input.repos) {
          const repoId = normalizeRepoId(observation.repo_id);
          const exists = this.db.prepare("SELECT 1 AS ok FROM repos WHERE repo_id = ?").get(repoId);
          if (!exists) {
            ignored.push(repoId);
            continue;
          }
          const headSha = optionalSha(observation.head_sha, "head_sha");
          const stateHash = observation.state_hash ? artifactHash(observation.state_hash) : null;
          const dirty = observation.dirty === null || observation.dirty === undefined
            ? null
            : (Boolean(observation.dirty) ? 1 : 0);
          insert.run(
            nodeId,
            repoId,
            text(observation.local_path, "local_path", { required: false, max: 2000 }),
            text(observation.branch, "branch", { required: false, max: 300 }),
            headSha,
            dirty,
            observation.exists === false ? 0 : 1,
            observation.is_git ? 1 : 0,
            stateHash,
            now,
          );
          reported.push(repoId);
        }
        this.database.appendAudit({
          eventType: "node.reported",
          principal: principal.id,
          resource: `node:${nodeId}`,
          payload: { status, reported_repo_ids: reported, ignored_repo_ids: ignored },
        });
        return { node_id: nodeId, reported_repo_ids: reported, ignored_repo_ids: ignored, observed_at_epoch: now };
      },
    );
  }

  reportDeployment(input, principal, idempotencyKey) {
    const repoId = normalizeRepoId(input.repo_id);
    const provider = text(input.provider, "provider", { max: 100 });
    const environment = text(input.environment, "environment", { max: 100 });
    const sha = normalizeSha(input.sha, "sha");
    const url = text(input.url, "url", { required: false, max: 2000 });
    const status = text(input.status, "status", { max: 100 });
    const source = text(input.source ?? principal.id, "source", { max: 200 });
    const metadata = jsonObject(input.metadata, "metadata");

    return this.#idempotent(
      {
        key: idempotencyKey,
        principal,
        operation: "deployment.report",
        request: { repo_id: repoId, provider, environment, sha, url, status, source, metadata },
      },
      ({ now }) => {
        this.#requireRepo(repoId);
        const deploymentId = randomId();
        this.db.prepare(`
          INSERT INTO deployments(
            deployment_id, repo_id, provider, environment, sha, url, status,
            source, observed_at_epoch, metadata_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          deploymentId,
          repoId,
          provider,
          environment,
          sha,
          url,
          status,
          source,
          now,
          canonicalJson(metadata),
        );
        this.database.appendAudit({
          eventType: "deployment.reported",
          principal: principal.id,
          resource: `repo:${repoId}`,
          payload: { deployment_id: deploymentId, provider, environment, sha, status, source },
        });
        return { deployment_id: deploymentId, observed_at_epoch: now };
      },
    );
  }

  registerArtifact({ sha256, sizeBytes, mimeType, storagePath, metadata }, principal) {
    const hash = artifactHash(sha256);
    const size = positiveInteger(sizeBytes, undefined, { min: 0, max: this.config.maxArtifactBytes });
    const mime = text(mimeType || "application/octet-stream", "mime_type", { max: 300 });
    const artifactPath = text(storagePath, "storage_path", { max: 4000 });
    const meta = jsonObject(metadata, "metadata");

    return this.database.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM artifacts WHERE sha256 = ?").get(hash);
      if (existing) {
        if (Number(existing.size_bytes) !== size || existing.storage_path !== artifactPath) {
          throw new HttpError(409, "artifact_metadata_conflict", "Artifact hash is already registered with different metadata");
        }
        return {
          artifact: this.getArtifact(hash),
          replayed: true,
        };
      }
      const now = this.database.nowEpoch();
      this.db.prepare(`
        INSERT INTO artifacts(
          sha256, size_bytes, mime_type, storage_path, producer_principal,
          metadata_json, created_at_epoch
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(hash, size, mime, artifactPath, principal.id, canonicalJson(meta), now);
      this.database.appendAudit({
        eventType: "artifact.registered",
        principal: principal.id,
        resource: `artifact:${hash}`,
        payload: { size_bytes: size, mime_type: mime },
      });
      return { artifact: this.getArtifact(hash), replayed: false };
    });
  }

  findArtifact(hashInput) {
    const hash = artifactHash(hashInput);
    const row = this.db.prepare("SELECT * FROM artifacts WHERE sha256 = ?").get(hash);
    if (!row) return null;
    return {
      sha256: row.sha256,
      size_bytes: Number(row.size_bytes),
      mime_type: row.mime_type,
      storage_path: row.storage_path,
      producer_principal: row.producer_principal,
      metadata: parseJson(row.metadata_json, {}),
      created_at_epoch: Number(row.created_at_epoch),
    };
  }

  getArtifact(hashInput) {
    const artifact = this.findArtifact(hashInput);
    if (!artifact) throw new HttpError(404, "artifact_not_found", "Artifact does not exist");
    return artifact;
  }

  isArtifactRegistered(hashInput) {
    return this.findArtifact(hashInput) !== null;
  }

  recoverState() {
    return this.database.transaction(() => {
      const now = this.database.nowEpoch();
      const expired = this.db.prepare(`
        UPDATE leases
        SET status = 'expired', released_at_epoch = ?, release_reason = 'startup_recovery_expired'
        WHERE status = 'active' AND expires_at_epoch <= ?
      `).run(now, now);
      const orphanedTasks = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM tasks t
        WHERE t.status IN ('claimed', 'in_progress')
          AND NOT EXISTS (
            SELECT 1 FROM leases l
            WHERE l.task_id = t.task_id
              AND l.status = 'active'
              AND l.expires_at_epoch > ?
          )
      `).get(now);
      const orphanedHandoffs = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM handoffs h
        LEFT JOIN leases l ON l.lease_id = h.source_lease_id
        WHERE h.status = 'pending'
          AND (l.lease_id IS NULL OR l.status <> 'active' OR l.expires_at_epoch <= ?)
      `).get(now);
      const result = {
        expired_leases: Number(expired.changes ?? 0),
        orphaned_tasks: Number(orphanedTasks.count ?? 0),
        orphaned_handoffs: Number(orphanedHandoffs.count ?? 0),
        recovered_at_epoch: now,
      };
      if (result.expired_leases > 0) {
        this.database.appendAudit({
          eventType: "startup.recovered",
          principal: "system",
          resource: "workspace-gateway",
          payload: result,
        });
      }
      return result;
    });
  }

  auditStatus() {
    return this.database.verifyAuditChain();
  }
}
