#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { normalizeRepoId } from "../src/paths.js";
import { canonicalJson, sha256Hex } from "../src/utils.js";
import { fetchGateway } from "../src/cli-transport.js";

function usage() {
  console.error(`
Nymrel Workspace CLI

Environment:
  NYMREL_WORKSPACE_URL    Gateway origin (for example https://workspace.example)
  NYMREL_WORKSPACE_TOKEN  Bearer token for the requested operation
  NYMREL_WORKSPACE_PRINCIPAL  Optional stable agent/node identity
  NYMREL_WORKSPACE_ALLOW_LOOPBACK_HTTP  Set to 1 only for literal-loopback development

Commands:
  list
  resolve <repo>
  import-candidate <candidate.json>
  report-candidate <candidate.json> <node-id>
  bootstrap-candidate <candidate.json> <node-id>
  acquire <repo-id> <base-sha> <path[,path...]>
  renew <lease-id> <fencing-token>
  release <lease-id> <fencing-token> [reason]
  promote <repo-id> <git-url> <default-branch> <sha> <evidence.json>
  head <repo-id> <expected-sha> <latest-sha> <evidence.json>
  audit
`);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function principal() {
  return process.env.NYMREL_WORKSPACE_PRINCIPAL?.trim() || "nymrel-workspace-cli";
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), "utf8").replace(/^\uFEFF/, ""));
}

function mutationHeaders(key = crypto.randomUUID()) {
  return {
    authorization: `Bearer ${requiredEnv("NYMREL_WORKSPACE_TOKEN")}`,
    "x-nymrel-principal": principal(),
    "content-type": "application/json",
    "idempotency-key": key,
  };
}

function readHeaders() {
  return {
    authorization: `Bearer ${requiredEnv("NYMREL_WORKSPACE_TOKEN")}`,
    "x-nymrel-principal": principal(),
  };
}

async function request(route, { method = "GET", body, mutation = false, key } = {}) {
  const response = await fetchGateway(route, {
    method,
    headers: mutation ? mutationHeaders(key) : readHeaders(),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { raw: text };
    }
  }
  if (!response.ok) {
    const message = payload?.message || payload?.error || `HTTP ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function recordRepoId(record) {
  return normalizeRepoId(record?.repo_id ?? record?.manifest?.name ?? record?.name ?? "");
}

function nodeReport(candidate, nodeId) {
  if (!candidate || !Array.isArray(candidate.repos)) {
    throw new Error("Candidate file must contain repos[]");
  }
  const repos = candidate.repos.map((record) => {
    const local = record.local ?? {};
    const stateHash = sha256Hex(canonicalJson(local));
    return {
      repo_id: recordRepoId(record),
      local_path: local.path ?? null,
      branch: local.branch ?? null,
      head_sha: local.head_sha ?? null,
      dirty: local.dirty ?? null,
      exists: local.exists !== false,
      is_git: local.is_git === true,
      state_hash: stateHash,
    };
  });
  return {
    status: "online",
    metadata: {
      reporter: "nymrel-workspace-cli",
      candidate_schema_version: candidate.schema_version ?? null,
      source_manifest: candidate.source_manifest ?? null,
    },
    repos,
    node_id: nodeId,
  };
}

function evidence(file) {
  const value = readJsonFile(file);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error("Evidence file must contain a non-empty JSON object");
  }
  return value;
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  switch (command) {
    case "list":
      return request("/v1/repos");
    case "resolve":
      if (!args[0]) throw new Error("resolve requires <repo>");
      return request(`/v1/workspaces/${encodeURIComponent(args[0])}`);
    case "audit":
      return request("/v1/audit/verify");
    case "import-candidate": {
      if (!args[0]) throw new Error("import-candidate requires <candidate.json>");
      const candidate = readJsonFile(args[0]);
      return request("/v1/registry/import", {
        method: "POST",
        body: candidate,
        mutation: true,
        key: `candidate:${sha256Hex(canonicalJson(candidate))}`,
      });
    }
    case "report-candidate": {
      if (!args[0] || !args[1]) {
        throw new Error("report-candidate requires <candidate.json> <node-id>");
      }
      const candidate = readJsonFile(args[0]);
      const body = nodeReport(candidate, args[1]);
      return request(`/v1/nodes/${encodeURIComponent(args[1])}/report`, {
        method: "POST",
        body,
        mutation: true,
        key: `node:${args[1]}:${sha256Hex(canonicalJson(body))}`,
      });
    }
    case "bootstrap-candidate": {
      if (!args[0] || !args[1]) {
        throw new Error("bootstrap-candidate requires <candidate.json> <node-id>");
      }
      const candidate = readJsonFile(args[0]);
      const imported = await request("/v1/registry/import", {
        method: "POST",
        body: candidate,
        mutation: true,
        key: `candidate:${sha256Hex(canonicalJson(candidate))}`,
      });
      const body = nodeReport(candidate, args[1]);
      const reported = await request(`/v1/nodes/${encodeURIComponent(args[1])}/report`, {
        method: "POST",
        body,
        mutation: true,
        key: `node:${args[1]}:${sha256Hex(canonicalJson(body))}`,
      });
      return { imported, reported };
    }
    case "acquire": {
      if (!args[0] || !args[1] || !args[2]) {
        throw new Error("acquire requires <repo-id> <base-sha> <path[,path...]>");
      }
      return request("/v1/leases/acquire", {
        method: "POST",
        body: {
          repo_id: args[0],
          base_sha: args[1],
          paths: args[2].split(",").map((item) => item.trim()).filter(Boolean),
          holder_node: process.env.NYMREL_WORKSPACE_NODE_ID || null,
        },
        mutation: true,
      });
    }
    case "renew": {
      if (!args[0] || !args[1]) throw new Error("renew requires <lease-id> <fencing-token>");
      return request(`/v1/leases/${encodeURIComponent(args[0])}/renew`, {
        method: "POST",
        body: { fencing_token: Number(args[1]) },
        mutation: true,
      });
    }
    case "release": {
      if (!args[0] || !args[1]) throw new Error("release requires <lease-id> <fencing-token> [reason]");
      return request(`/v1/leases/${encodeURIComponent(args[0])}/release`, {
        method: "POST",
        body: {
          fencing_token: Number(args[1]),
          reason: args[2] || "released_by_cli",
        },
        mutation: true,
      });
    }
    case "promote": {
      if (args.length < 5) {
        throw new Error("promote requires <repo-id> <git-url> <default-branch> <sha> <evidence.json>");
      }
      return request(`/v1/repos/${encodeURIComponent(args[0])}/promote`, {
        method: "POST",
        body: {
          git_url: args[1],
          default_branch: args[2],
          latest_sha: args[3],
          evidence: evidence(args[4]),
        },
        mutation: true,
      });
    }
    case "head": {
      if (args.length < 4) {
        throw new Error("head requires <repo-id> <expected-sha> <latest-sha> <evidence.json>");
      }
      return request(`/v1/repos/${encodeURIComponent(args[0])}/head`, {
        method: "POST",
        body: {
          expected_sha: args[1],
          latest_sha: args[2],
          evidence: evidence(args[3]),
        },
        mutation: true,
      });
    }
    default:
      usage();
      throw new Error(command ? `Unknown command: ${command}` : "Command is required");
  }
}

main()
  .then((result) => {
    if (result !== undefined) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  })
  .catch((error) => {
    console.error(JSON.stringify({
      error: error.payload?.error || "cli_error",
      message: error.message,
      status: error.status ?? null,
    }));
    process.exitCode = 1;
  });
