import fs from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { WorkspaceDatabase } from "../src/db.js";
import { WorkspaceStore } from "../src/store.js";
import { HttpError } from "../src/errors.js";
import {
  SHA_A,
  SHA_B,
  adminPrincipal,
  candidateRegistry,
  makeConfig,
  makeTempRoot,
  writerA,
  writerB,
} from "./helpers.js";

function setup() {
  const root = makeTempRoot();
  const config = makeConfig(root);
  const database = new WorkspaceDatabase(config.dbPath);
  const store = new WorkspaceStore(database, config);
  return {
    root,
    config,
    database,
    store,
    close() {
      database.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function importOne(ctx, key = "registry-1") {
  return ctx.store.importRegistry(
    candidateRegistry(),
    adminPrincipal,
    key,
  );
}

test("candidate registry import is deterministic and idempotent", () => {
  const ctx = setup();
  try {
    const first = importOne(ctx);
    assert.equal(first.replayed, false);
    assert.equal(first.value.imported, 1);
    assert.equal(first.value.authority, "candidate");
    const second = importOne(ctx);
    assert.equal(second.replayed, true);
    assert.deepEqual(second.value, first.value);

    const repos = ctx.store.listRepos();
    assert.equal(repos.length, 1);
    assert.equal(repos[0].repo_id, "repo-a");
    assert.equal(repos[0].authority, "candidate");
    assert.equal(repos[0].advisory, true);
    assert.equal(repos[0].latest_sha, SHA_A);
    assert.equal(ctx.store.auditStatus().valid, true);
  } finally {
    ctx.close();
  }
});

test("idempotency key reuse with different request is rejected", () => {
  const ctx = setup();
  try {
    importOne(ctx, "same-key");
    assert.throws(
      () => ctx.store.importRegistry(
        candidateRegistry({ name: "Different Repo", pathValue: "Different" }),
        adminPrincipal,
        "same-key",
      ),
      (error) => error instanceof HttpError && error.code === "idempotency_conflict",
    );
  } finally {
    ctx.close();
  }
});

test("leases reject overlap and monotonically increase fencing tokens", () => {
  const ctx = setup();
  try {
    importOne(ctx);
    const first = ctx.store.acquireLease(
      { repo_id: "repo-a", paths: ["src"], base_sha: SHA_A },
      writerA,
      "lease-a",
    );
    assert.equal(first.replayed, false);
    assert.equal(first.value.lease.fencing_token, 1);
    const replay = ctx.store.acquireLease(
      { repo_id: "repo-a", paths: ["src"], base_sha: SHA_A },
      writerA,
      "lease-a",
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.value.lease.lease_id, first.value.lease.lease_id);

    assert.throws(
      () => ctx.store.acquireLease(
        { repo_id: "repo-a", paths: ["src/app"], base_sha: SHA_A },
        writerB,
        "lease-overlap",
      ),
      (error) => error instanceof HttpError && error.code === "lease_conflict",
    );

    const second = ctx.store.acquireLease(
      { repo_id: "repo-a", paths: ["docs"], base_sha: SHA_A },
      writerB,
      "lease-b",
    );
    assert.equal(second.value.lease.fencing_token, 2);

    ctx.store.releaseLease(
      first.value.lease.lease_id,
      { fencing_token: 1, reason: "done" },
      writerA,
      "release-a",
    );
    const third = ctx.store.acquireLease(
      { repo_id: "repo-a", paths: ["src"], base_sha: SHA_A },
      writerB,
      "lease-c",
    );
    assert.equal(third.value.lease.fencing_token, 3);
  } finally {
    ctx.close();
  }
});

test("stale fencing tokens cannot renew or release a lease", () => {
  const ctx = setup();
  try {
    importOne(ctx);
    const acquired = ctx.store.acquireLease(
      { repo_id: "repo-a", paths: ["*"], base_sha: SHA_A },
      writerA,
      "lease",
    ).value.lease;
    assert.throws(
      () => ctx.store.renewLease(
        acquired.lease_id,
        { fencing_token: acquired.fencing_token + 1 },
        writerA,
        "renew-bad",
      ),
      (error) => error instanceof HttpError && error.code === "stale_fencing_token",
    );
    assert.throws(
      () => ctx.store.releaseLease(
        acquired.lease_id,
        { fencing_token: acquired.fencing_token + 1 },
        writerA,
        "release-bad",
      ),
      (error) => error instanceof HttpError && error.code === "stale_fencing_token",
    );
  } finally {
    ctx.close();
  }
});

test("task updates are fenced and handoff acceptance issues a higher token", () => {
  const ctx = setup();
  try {
    importOne(ctx);
    const task = ctx.store.createTask(
      {
        repo_id: "repo-a",
        title: "Change the thing",
        base_sha: SHA_A,
        target_branch: "agent/change",
      },
      writerA,
      "task",
    ).value.task;
    const lease = ctx.store.acquireLease(
      {
        repo_id: "repo-a",
        paths: ["src"],
        base_sha: SHA_A,
        task_id: task.task_id,
      },
      writerA,
      "task-lease",
    ).value.lease;

    assert.throws(
      () => ctx.store.updateTask(
        task.task_id,
        {
          status: "in_progress",
          lease_id: lease.lease_id,
          fencing_token: lease.fencing_token + 1,
        },
        writerA,
        "bad-task-update",
      ),
      (error) => error instanceof HttpError && error.code === "stale_fencing_token",
    );
    const updated = ctx.store.updateTask(
      task.task_id,
      {
        status: "in_progress",
        lease_id: lease.lease_id,
        fencing_token: lease.fencing_token,
      },
      writerA,
      "task-update",
    );
    assert.equal(updated.value.task.status, "in_progress");

    const handoff = ctx.store.createHandoff(
      {
        lease_id: lease.lease_id,
        fencing_token: lease.fencing_token,
        task_id: task.task_id,
        source_sha: SHA_B,
        notes: "Continue the scoped work",
        target_principal: writerB.id,
      },
      writerA,
      "handoff",
    ).value.handoff;
    const accepted = ctx.store.acceptHandoff(
      handoff.handoff_id,
      {},
      writerB,
      "accept",
    ).value;
    assert.equal(accepted.handoff.status, "accepted");
    assert.equal(accepted.lease.holder_principal, writerB.id);
    assert.ok(accepted.lease.fencing_token > lease.fencing_token);

    const resolved = ctx.store.resolveWorkspace("repo-a");
    assert.equal(resolved.active_leases.length, 1);
    assert.equal(resolved.active_leases[0].lease_id, accepted.lease.lease_id);
  } finally {
    ctx.close();
  }
});

test("node and deployment reports are visible in workspace resolution", () => {
  const ctx = setup();
  try {
    importOne(ctx);
    ctx.store.reportNode(
      "node:jalenpc",
      {
        status: "online",
        repos: [
          {
            repo_id: "repo-a",
            local_path: "C:/studio/RepoA",
            branch: "main",
            head_sha: SHA_A,
            dirty: true,
            exists: true,
            is_git: true,
            state_hash: "e".repeat(64),
          },
        ],
      },
      writerA,
      "node-report",
    );
    ctx.store.reportDeployment(
      {
        repo_id: "repo-a",
        provider: "vercel",
        environment: "production",
        sha: SHA_B,
        status: "ready",
        source: "vercel-observer",
      },
      writerA,
      "deployment",
    );
    const resolved = ctx.store.resolveWorkspace("Repo A");
    assert.equal(resolved.node_observations.length, 1);
    assert.equal(resolved.node_observations[0].dirty, true);
    assert.equal(resolved.deployments.length, 1);
    assert.equal(resolved.deployments[0].sha, SHA_B);
  } finally {
    ctx.close();
  }
});

test("startup recovery expires stale leases without reusing fencing tokens", () => {
  const ctx = setup();
  try {
    importOne(ctx);
    const lease = ctx.store.acquireLease(
      { repo_id: "repo-a", paths: ["src"], base_sha: SHA_A, ttl_seconds: 1 },
      writerA,
      "short",
    ).value.lease;
    ctx.database.db.prepare(
      "UPDATE leases SET expires_at_epoch = unixepoch() - 1 WHERE lease_id = ?",
    ).run(lease.lease_id);
    const recovery = ctx.store.recoverState();
    assert.equal(recovery.expired_leases, 1);
    const next = ctx.store.acquireLease(
      { repo_id: "repo-a", paths: ["src"], base_sha: SHA_A },
      writerB,
      "next",
    ).value.lease;
    assert.ok(next.fencing_token > lease.fencing_token);
    assert.equal(ctx.store.auditStatus().valid, true);
  } finally {
    ctx.close();
  }
});

test("audit verification detects tampering", () => {
  const ctx = setup();
  try {
    importOne(ctx);
    assert.equal(ctx.store.auditStatus().valid, true);
    ctx.database.db.prepare(
      "UPDATE audit_events SET payload_json = ? WHERE seq = 1",
    ).run('{"tampered":true}');
    const status = ctx.store.auditStatus();
    assert.equal(status.valid, false);
    assert.equal(status.reason, "hash_mismatch");
  } finally {
    ctx.close();
  }
});


test("canonical promotion requires evidence and enforces base SHA", () => {
  const ctx = setup();
  try {
    importOne(ctx);
    assert.throws(
      () => ctx.store.promoteRepo(
        "repo-a",
        {
          git_url: "https://github.com/nymrel/repo-a.git",
          default_branch: "main",
          latest_sha: SHA_A,
          evidence: {},
        },
        adminPrincipal,
        "promote-no-evidence",
      ),
      (error) => error instanceof HttpError && error.code === "promotion_evidence_required",
    );

    const promoted = ctx.store.promoteRepo(
      "repo-a",
      {
        git_url: "https://github.com/nymrel/repo-a.git",
        default_branch: "main",
        latest_sha: SHA_A,
        evidence: { source: "github", ref: "refs/heads/main" },
      },
      adminPrincipal,
      "promote",
    ).value.repo;
    assert.equal(promoted.authority, "canonical");
    assert.equal(promoted.advisory, false);
    assert.deepEqual(promoted.risk_flags, []);

    assert.throws(
      () => ctx.store.acquireLease(
        { repo_id: "repo-a", paths: ["src"], base_sha: SHA_B },
        writerA,
        "stale-base",
      ),
      (error) => error instanceof HttpError && error.code === "base_sha_stale",
    );

    const lease = ctx.store.acquireLease(
      { repo_id: "repo-a", paths: ["src"], base_sha: SHA_A },
      writerA,
      "current-base",
    ).value.lease;
    assert.equal(lease.base_sha, SHA_A);
  } finally {
    ctx.close();
  }
});

test("canonical head update is compare-and-swap with evidence", () => {
  const ctx = setup();
  try {
    importOne(ctx);
    ctx.store.promoteRepo(
      "repo-a",
      {
        git_url: "https://github.com/nymrel/repo-a.git",
        default_branch: "main",
        latest_sha: SHA_A,
        evidence: { source: "github", ref: "refs/heads/main" },
      },
      adminPrincipal,
      "promote",
    );

    assert.throws(
      () => ctx.store.updateCanonicalHead(
        "repo-a",
        {
          expected_sha: SHA_B,
          latest_sha: "c".repeat(40),
          evidence: { source: "github" },
        },
        adminPrincipal,
        "wrong-expected",
      ),
      (error) => error instanceof HttpError && error.code === "canonical_head_conflict",
    );

    const updated = ctx.store.updateCanonicalHead(
      "repo-a",
      {
        expected_sha: SHA_A,
        latest_sha: SHA_B,
        evidence: { source: "github", ref: "refs/heads/main", observed: true },
      },
      adminPrincipal,
      "head-update",
    ).value.repo;
    assert.equal(updated.latest_sha, SHA_B);

    assert.throws(
      () => ctx.store.acquireLease(
        { repo_id: "repo-a", paths: ["docs"], base_sha: SHA_A },
        writerB,
        "old-head",
      ),
      (error) => error instanceof HttpError && error.code === "base_sha_stale",
    );
  } finally {
    ctx.close();
  }
});
