import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import test from "node:test";
import { startGateway } from "../src/index.js";
import { candidateRegistry, makeConfig, makeTempRoot, SHA_A } from "./helpers.js";

function auth(token, principal = "agent:test") {
  return {
    authorization: `Bearer ${token}`,
    "x-nymrel-principal": principal,
  };
}

async function jsonResponse(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function runCli(args, options) {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}

async function setupServer(overrides = {}) {
  const root = makeTempRoot("nymrel-workspace-http-");
  const config = makeConfig(root, overrides);
  const gateway = await startGateway(config, { installSignalHandlers: false });
  const address = gateway.server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    root,
    config,
    gateway,
    origin,
    async close() {
      await gateway.shutdown("test");
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function importRegistry(ctx) {
  const response = await fetch(`${ctx.origin}/v1/registry/import`, {
    method: "POST",
    headers: {
      ...auth(ctx.config.adminToken, "agent:admin"),
      "content-type": "application/json",
      "idempotency-key": "registry-import-1",
    },
    body: JSON.stringify(candidateRegistry()),
  });
  assert.equal(response.status, 201);
  return jsonResponse(response);
}

test("health is public while private routes require bearer auth", async () => {
  const ctx = await setupServer();
  try {
    const health = await fetch(`${ctx.origin}/healthz`);
    assert.equal(health.status, 200);
    assert.equal((await jsonResponse(health)).status, "ok");

    const ready = await fetch(`${ctx.origin}/readyz`);
    assert.equal(ready.status, 200);
    assert.equal((await jsonResponse(ready)).write_ready, true);

    const denied = await fetch(`${ctx.origin}/v1/repos`);
    assert.equal(denied.status, 401);
    assert.equal((await jsonResponse(denied)).error, "missing_bearer_token");

    const unknown = await fetch(`${ctx.origin}/v1/secret-route`);
    assert.equal(unknown.status, 401);

    const read = await fetch(`${ctx.origin}/v1/repos`, {
      headers: auth(ctx.config.readToken, "agent:reader"),
    });
    assert.equal(read.status, 200);
    assert.deepEqual((await jsonResponse(read)).repos, []);
  } finally {
    await ctx.close();
  }
});

test("admin imports candidate registry and read clients resolve it", async () => {
  const ctx = await setupServer();
  try {
    const imported = await importRegistry(ctx);
    assert.equal(imported.value.authority, "candidate");
    assert.equal(imported.value.advisory, true);

    const deniedAdmin = await fetch(`${ctx.origin}/v1/registry/import`, {
      method: "POST",
      headers: {
        ...auth(ctx.config.writeToken, "agent:writer"),
        "content-type": "application/json",
        "idempotency-key": "denied-import",
      },
      body: JSON.stringify(candidateRegistry()),
    });
    assert.equal(deniedAdmin.status, 403);

    const resolved = await fetch(`${ctx.origin}/v1/workspaces/repo-a`, {
      headers: auth(ctx.config.readToken, "agent:reader"),
    });
    assert.equal(resolved.status, 200);
    const body = await jsonResponse(resolved);
    assert.equal(body.repo.repo_id, "repo-a");
    assert.equal(body.repo.latest_sha, SHA_A);
    assert.equal(body.repo.authority, "candidate");
  } finally {
    await ctx.close();
  }
});

test("REST lease flow enforces idempotency, overlap, and fencing", async () => {
  const ctx = await setupServer();
  try {
    await importRegistry(ctx);
    const acquire = await fetch(`${ctx.origin}/v1/leases/acquire`, {
      method: "POST",
      headers: {
        ...auth(ctx.config.writeToken, "agent:a"),
        "content-type": "application/json",
        "idempotency-key": "lease-a",
      },
      body: JSON.stringify({
        repo_id: "repo-a",
        paths: ["src"],
        base_sha: SHA_A,
      }),
    });
    assert.equal(acquire.status, 201);
    const first = await jsonResponse(acquire);
    assert.equal(first.value.lease.fencing_token, 1);

    const replay = await fetch(`${ctx.origin}/v1/leases/acquire`, {
      method: "POST",
      headers: {
        ...auth(ctx.config.writeToken, "agent:a"),
        "content-type": "application/json",
        "idempotency-key": "lease-a",
      },
      body: JSON.stringify({
        repo_id: "repo-a",
        paths: ["src"],
        base_sha: SHA_A,
      }),
    });
    assert.equal(replay.status, 200);
    assert.equal((await jsonResponse(replay)).value.lease.lease_id, first.value.lease.lease_id);

    const conflict = await fetch(`${ctx.origin}/v1/leases/acquire`, {
      method: "POST",
      headers: {
        ...auth(ctx.config.writeToken, "agent:b"),
        "content-type": "application/json",
        "idempotency-key": "overlap",
      },
      body: JSON.stringify({
        repo_id: "repo-a",
        paths: ["src/app"],
        base_sha: SHA_A,
      }),
    });
    assert.equal(conflict.status, 409);
    assert.equal((await jsonResponse(conflict)).error, "lease_conflict");

    const staleRenew = await fetch(
      `${ctx.origin}/v1/leases/${first.value.lease.lease_id}/renew`,
      {
        method: "POST",
        headers: {
          ...auth(ctx.config.writeToken, "agent:a"),
          "content-type": "application/json",
          "idempotency-key": "stale-renew",
        },
        body: JSON.stringify({ fencing_token: 2 }),
      },
    );
    assert.equal(staleRenew.status, 409);
    assert.equal((await jsonResponse(staleRenew)).error, "stale_fencing_token");

    const release = await fetch(
      `${ctx.origin}/v1/leases/${first.value.lease.lease_id}/release`,
      {
        method: "POST",
        headers: {
          ...auth(ctx.config.writeToken, "agent:a"),
          "content-type": "application/json",
          "idempotency-key": "release-a",
        },
        body: JSON.stringify({ fencing_token: 1 }),
      },
    );
    assert.equal(release.status, 200);
  } finally {
    await ctx.close();
  }
});

test("MCP exposes one role-filtered contract backed by the same store", async () => {
  const ctx = await setupServer();
  try {
    await importRegistry(ctx);
    const initialize = await fetch(`${ctx.origin}/mcp`, {
      method: "POST",
      headers: {
        ...auth(ctx.config.readToken, "agent:reader"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
    });
    assert.equal(initialize.status, 200);
    assert.equal((await jsonResponse(initialize)).result.serverInfo.name, "nymrel-workspace-gateway");

    const listRead = await fetch(`${ctx.origin}/mcp`, {
      method: "POST",
      headers: {
        ...auth(ctx.config.readToken, "agent:reader"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    const readNames = (await jsonResponse(listRead)).result.tools.map((tool) => tool.name);
    assert.deepEqual(
      readNames.sort(),
      ["artifact_metadata", "audit_verify", "workspace_list", "workspace_resolve"].sort(),
    );

    const listWrite = await fetch(`${ctx.origin}/mcp`, {
      method: "POST",
      headers: {
        ...auth(ctx.config.writeToken, "agent:writer"),
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
    });
    const writeNames = (await jsonResponse(listWrite)).result.tools.map((tool) => tool.name);
    assert.ok(writeNames.includes("lease_acquire"));
    assert.ok(!writeNames.includes("registry_import"));

    const resolve = await fetch(`${ctx.origin}/mcp`, {
      method: "POST",
      headers: {
        ...auth(ctx.config.readToken, "agent:reader"),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: {
          name: "workspace_resolve",
          arguments: { repo: "repo-a" },
        },
      }),
    });
    const resolved = await jsonResponse(resolve);
    assert.equal(resolved.result.structuredContent.repo.repo_id, "repo-a");
  } finally {
    await ctx.close();
  }
});

test("CAS upload verifies hash and round-trips bytes without exposing storage paths", async () => {
  const ctx = await setupServer();
  try {
    const content = Buffer.from("workspace artifact\n");
    const hash = crypto.createHash("sha256").update(content).digest("hex");

    const put = await fetch(`${ctx.origin}/v1/artifacts/${hash}`, {
      method: "PUT",
      headers: {
        ...auth(ctx.config.writeToken, "agent:writer"),
        "content-type": "text/plain",
      },
      body: content,
    });
    assert.equal(put.status, 201);
    const putBody = await jsonResponse(put);
    assert.equal(putBody.artifact.sha256, hash);
    assert.equal("storage_path" in putBody.artifact, false);

    const meta = await fetch(`${ctx.origin}/v1/artifacts/${hash}/meta`, {
      headers: auth(ctx.config.readToken, "agent:reader"),
    });
    assert.equal(meta.status, 200);
    const metaBody = await jsonResponse(meta);
    assert.equal(metaBody.artifact.size_bytes, content.length);
    assert.equal("storage_path" in metaBody.artifact, false);

    const get = await fetch(`${ctx.origin}/v1/artifacts/${hash}`, {
      headers: auth(ctx.config.readToken, "agent:reader"),
    });
    assert.equal(get.status, 200);
    assert.deepEqual(Buffer.from(await get.arrayBuffer()), content);

    const wrong = "f".repeat(64);
    const mismatch = await fetch(`${ctx.origin}/v1/artifacts/${wrong}`, {
      method: "PUT",
      headers: {
        ...auth(ctx.config.writeToken, "agent:writer"),
        "content-type": "text/plain",
      },
      body: content,
    });
    assert.equal(mismatch.status, 422);
    assert.equal((await jsonResponse(mismatch)).error, "artifact_hash_mismatch");
  } finally {
    await ctx.close();
  }
});

test("audit corruption keeps health observable but fails closed for writes", async () => {
  const ctx = await setupServer();
  try {
    await importRegistry(ctx);
    ctx.gateway.database.db.prepare(
      "UPDATE audit_events SET payload_json = ? WHERE seq = 1",
    ).run('{"tampered":true}');

    const health = await fetch(`${ctx.origin}/healthz`);
    assert.equal(health.status, 200);

    const ready = await fetch(`${ctx.origin}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal((await jsonResponse(ready)).audit_valid, false);

    const read = await fetch(`${ctx.origin}/v1/repos`, {
      headers: auth(ctx.config.readToken, "agent:reader"),
    });
    assert.equal(read.status, 200);

    const write = await fetch(`${ctx.origin}/v1/leases/acquire`, {
      method: "POST",
      headers: {
        ...auth(ctx.config.writeToken, "agent:writer"),
        "content-type": "application/json",
        "idempotency-key": "blocked-write",
      },
      body: JSON.stringify({
        repo_id: "repo-a",
        paths: ["src"],
        base_sha: SHA_A,
      }),
    });
    assert.equal(write.status, 503);
    assert.equal((await jsonResponse(write)).error, "gateway_not_write_ready");
  } finally {
    await ctx.close();
  }
});

test("insecure local mode refuses a non-loopback bind at startup", async () => {
  const root = makeTempRoot("nymrel-workspace-insecure-");
  const config = makeConfig(root, {
    host: "0.0.0.0",
    insecureLocal: true,
    authReady: true,
  });
  try {
    await assert.rejects(
      () => startGateway(config, { installSignalHandlers: false }),
      /requires HOST=127\.0\.0\.1/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test("CLI bootstraps candidate registry and publishes node mirror state", async () => {
  const ctx = await setupServer();
  try {
    const candidatePath = path.join(ctx.root, "candidate.json");
    fs.writeFileSync(candidatePath, JSON.stringify(candidateRegistry()), "utf8");
    const cli = path.resolve("bin/nymrel-workspace.mjs");
    const env = {
      ...process.env,
      NYMREL_WORKSPACE_URL: ctx.origin,
      NYMREL_WORKSPACE_TOKEN: ctx.config.adminToken,
      NYMREL_WORKSPACE_PRINCIPAL: "node:jalenpc",
    };
    const output = await runCli(
      [cli, "bootstrap-candidate", candidatePath, "node:jalenpc"],
      { cwd: path.resolve("."), env, encoding: "utf8" },
    );
    const result = JSON.parse(output);
    assert.equal(result.imported.value.imported, 1);
    assert.deepEqual(result.reported.value.reported_repo_ids, ["repo-a"]);

    const resolveOutput = await runCli(
      [cli, "resolve", "repo-a"],
      { cwd: path.resolve("."), env, encoding: "utf8" },
    );
    const resolved = JSON.parse(resolveOutput);
    assert.equal(resolved.repo.repo_id, "repo-a");
    assert.equal(resolved.node_observations.length, 1);
    assert.equal(resolved.node_observations[0].node_id, "node:jalenpc");
  } finally {
    await ctx.close();
  }
});
