import { HttpError } from "./errors.js";
import { roleAllows } from "./auth.js";

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "workspace_list",
    role: "read",
    description: "List all workspace registry entries visible to the gateway.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "workspace_resolve",
    role: "read",
    description: "Resolve one workspace with active leases, tasks, handoffs, node observations, and deployment reports.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" } },
      required: ["repo"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "audit_verify",
    role: "read",
    description: "Verify the complete tamper-evident workspace audit chain.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "artifact_metadata",
    role: "read",
    description: "Read metadata for a content-addressed artifact.",
    inputSchema: {
      type: "object",
      properties: { sha256: { type: "string" } },
      required: ["sha256"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  {
    name: "registry_import",
    role: "admin",
    description: "Import an advisory candidate registry. Does not promote entries to canonical authority.",
    inputSchema: {
      type: "object",
      properties: {
        candidate: { type: "object" },
        idempotency_key: { type: "string" },
      },
      required: ["candidate", "idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "repo_promote",
    role: "admin",
    description: "Promote one reconciled candidate repo to canonical authority using explicit evidence.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: { type: "string" },
        git_url: { type: "string" },
        default_branch: { type: "string" },
        latest_sha: { type: "string" },
        evidence: { type: "object" },
        idempotency_key: { type: "string" },
      },
      required: ["repo_id", "git_url", "default_branch", "latest_sha", "evidence", "idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "repo_head_update",
    role: "admin",
    description: "Advance canonical repository head using compare-and-swap and evidence metadata.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: { type: "string" },
        expected_sha: { type: "string" },
        latest_sha: { type: "string" },
        evidence: { type: "object" },
        idempotency_key: { type: "string" },
      },
      required: ["repo_id", "expected_sha", "latest_sha", "evidence", "idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "lease_acquire",
    role: "write",
    description: "Acquire a fenced write lease on repo-relative path prefixes.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        base_sha: { type: "string" },
        ttl_seconds: { type: "integer" },
        holder_node: { type: "string" },
        task_id: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["repo_id", "paths", "base_sha", "idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "lease_renew",
    role: "write",
    description: "Renew an active lease after re-validating owner and fencing token.",
    inputSchema: {
      type: "object",
      properties: {
        lease_id: { type: "string" },
        fencing_token: { type: "integer" },
        ttl_seconds: { type: "integer" },
        idempotency_key: { type: "string" },
      },
      required: ["lease_id", "fencing_token", "idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "lease_release",
    role: "write",
    description: "Release an active lease after fencing validation.",
    inputSchema: {
      type: "object",
      properties: {
        lease_id: { type: "string" },
        fencing_token: { type: "integer" },
        reason: { type: "string" },
        idempotency_key: { type: "string" },
      },
      required: ["lease_id", "fencing_token", "idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "task_create",
    role: "write",
    description: "Create a workspace task pinned to a base SHA and target branch.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: { type: "string" },
        title: { type: "string" },
        base_sha: { type: "string" },
        target_branch: { type: "string" },
        assigned_principal: { type: "string" },
        metadata: { type: "object" },
        idempotency_key: { type: "string" },
      },
      required: ["repo_id", "title", "base_sha", "target_branch", "idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "task_update",
    role: "write",
    description: "Update task state only with a live matching fenced lease.",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        status: { type: "string" },
        lease_id: { type: "string" },
        fencing_token: { type: "integer" },
        metadata: { type: "object" },
        idempotency_key: { type: "string" },
      },
      required: ["task_id", "status", "lease_id", "fencing_token", "idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "handoff_create",
    role: "write",
    description: "Create a durable handoff from a live fenced lease.",
    inputSchema: {
      type: "object",
      properties: {
        lease_id: { type: "string" },
        fencing_token: { type: "integer" },
        source_sha: { type: "string" },
        notes: { type: "string" },
        target_principal: { type: "string" },
        task_id: { type: "string" },
        artifact_hashes: { type: "array", items: { type: "string" } },
        idempotency_key: { type: "string" },
      },
      required: ["lease_id", "fencing_token", "source_sha", "notes", "idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "handoff_accept",
    role: "write",
    description: "Accept a handoff atomically, retire the source lease, and issue a higher fencing token.",
    inputSchema: {
      type: "object",
      properties: {
        handoff_id: { type: "string" },
        holder_node: { type: "string" },
        ttl_seconds: { type: "integer" },
        idempotency_key: { type: "string" },
      },
      required: ["handoff_id", "idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "node_report",
    role: "write",
    description: "Replace one execution node's repo observation snapshot.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string" },
        status: { type: "string" },
        metadata: { type: "object" },
        repos: { type: "array", items: { type: "object" } },
        idempotency_key: { type: "string" },
      },
      required: ["node_id", "repos", "idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "deployment_report",
    role: "write",
    description: "Record an observed deployment SHA/status without asserting it from agent memory.",
    inputSchema: {
      type: "object",
      properties: {
        repo_id: { type: "string" },
        provider: { type: "string" },
        environment: { type: "string" },
        sha: { type: "string" },
        url: { type: "string" },
        status: { type: "string" },
        source: { type: "string" },
        metadata: { type: "object" },
        idempotency_key: { type: "string" },
      },
      required: ["repo_id", "provider", "environment", "sha", "status", "idempotency_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
]);

function publicDefinition(tool) {
  const { role: _role, ...definition } = tool;
  return definition;
}

function toolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value),
      },
    ],
    structuredContent: value,
    isError: false,
  };
}

function errorResult(error) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          error: error.code ?? "tool_error",
          message: error.message,
          details: error.details,
        }),
      },
    ],
    isError: true,
  };
}

function callTool(name, args, principal, store) {
  switch (name) {
    case "workspace_list":
      return { repos: store.listRepos() };
    case "workspace_resolve":
      return store.resolveWorkspace(args.repo);
    case "audit_verify":
      return store.auditStatus();
    case "artifact_metadata":
      return store.getArtifact(args.sha256);
    case "registry_import":
      return store.importRegistry(args.candidate, principal, args.idempotency_key);
    case "repo_promote":
      return store.promoteRepo(args.repo_id, args, principal, args.idempotency_key);
    case "repo_head_update":
      return store.updateCanonicalHead(args.repo_id, args, principal, args.idempotency_key);
    case "lease_acquire":
      return store.acquireLease(args, principal, args.idempotency_key);
    case "lease_renew":
      return store.renewLease(args.lease_id, args, principal, args.idempotency_key);
    case "lease_release":
      return store.releaseLease(args.lease_id, args, principal, args.idempotency_key);
    case "task_create":
      return store.createTask(args, principal, args.idempotency_key);
    case "task_update":
      return store.updateTask(args.task_id, args, principal, args.idempotency_key);
    case "handoff_create":
      return store.createHandoff(args, principal, args.idempotency_key);
    case "handoff_accept":
      return store.acceptHandoff(args.handoff_id, args, principal, args.idempotency_key);
    case "node_report":
      return store.reportNode(args.node_id, args, principal, args.idempotency_key);
    case "deployment_report":
      return store.reportDeployment(args, principal, args.idempotency_key);
    default:
      throw new HttpError(404, "tool_not_found", `Unknown MCP tool: ${name}`);
  }
}

export function handleMcpMessage(message, principal, store, { writeReady = true } = {}) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    throw new HttpError(400, "invalid_jsonrpc", "MCP requests must be JSON-RPC 2.0 messages");
  }
  const id = message.id ?? null;

  if (message.method === "notifications/initialized") {
    return null;
  }
  if (message.method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (message.method === "initialize") {
    const requested = message.params?.protocolVersion;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: typeof requested === "string" ? requested : "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "nymrel-workspace-gateway", version: "0.1.0" },
      },
    };
  }
  if (message.method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOL_DEFINITIONS
          .filter((tool) => roleAllows(principal.role, tool.role))
          .map(publicDefinition),
      },
    };
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    const definition = TOOL_DEFINITIONS.find((tool) => tool.name === name);
    if (!definition) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unknown tool: ${name}` },
      };
    }
    if (!roleAllows(principal.role, definition.role)) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32001, message: "Insufficient scope for tool" },
      };
    }
    if (definition.role !== "read" && !writeReady) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32002, message: "Workspace gateway is not write-ready" },
      };
    }
    try {
      return {
        jsonrpc: "2.0",
        id,
        result: toolResult(callTool(name, args, principal, store)),
      };
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        result: errorResult(error),
      };
    }
  }
  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `Unsupported method: ${message.method}` },
  };
}

export { TOOL_DEFINITIONS };
