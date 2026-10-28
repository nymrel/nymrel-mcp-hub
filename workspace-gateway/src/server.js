import http from "node:http";
import { authorize } from "./auth.js";
import { asHttpError, HttpError } from "./errors.js";
import { handleMcpMessage } from "./mcp.js";

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

function sendEmpty(res, statusCode, headers = {}) {
  res.writeHead(statusCode, {
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end();
}

async function readJson(req, maxBytes) {
  let size = 0;
  const chunks = [];
  for await (const chunkValue of req) {
    const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
    size += chunk.length;
    if (size > maxBytes) {
      throw new HttpError(413, "request_too_large", "JSON request exceeds the configured size limit");
    }
    chunks.push(chunk);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must contain valid JSON");
  }
}

function decodeSegment(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "invalid_path_encoding", "URL path contains invalid percent-encoding");
  }
}

function idempotencyKey(req) {
  const value = req.headers["idempotency-key"];
  return typeof value === "string" ? value : "";
}

function readiness(config, store, runtime) {
  const audit = store.auditStatus();
  const writeReady = Boolean(config.authReady && audit.valid && runtime.storageReady);
  return {
    status: writeReady ? "ready" : "degraded",
    write_ready: writeReady,
    auth_configured: config.authReady,
    audit_valid: audit.valid,
    audit_count: audit.count,
    storage_ready: runtime.storageReady,
    recovery: runtime.recovery,
    orphan_sweep: runtime.orphanSweep,
  };
}

function requireWriteReady(config, store, runtime) {
  const state = readiness(config, store, runtime);
  if (!state.write_ready) {
    throw new HttpError(
      503,
      "gateway_not_write_ready",
      "Workspace gateway is not ready for mutations",
      {
        auth_configured: state.auth_configured,
        audit_valid: state.audit_valid,
        storage_ready: state.storage_ready,
      },
    );
  }
}

function privateRole(req, config, role) {
  return authorize(req, config, role);
}

export function createGatewayServer({ config, store, cas, runtime }) {
  return http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://workspace.local");
    const pathname = url.pathname;

    try {
      if (method === "GET" && pathname === "/healthz") {
        return sendJson(res, 200, {
          status: "ok",
          service: "nymrel-workspace-gateway",
          version: "0.1.0",
        });
      }

      if (method === "GET" && pathname === "/readyz") {
        const state = readiness(config, store, runtime);
        return sendJson(res, state.write_ready ? 200 : 503, state);
      }

      if (method === "OPTIONS") {
        return sendEmpty(res, 204, {
          allow: "GET, POST, PATCH, PUT, OPTIONS",
        });
      }

      if (method === "POST" && pathname === "/mcp") {
        const principal = privateRole(req, config, "read");
        const message = await readJson(req, config.maxJsonBytes);
        const state = readiness(config, store, runtime);
        const response = handleMcpMessage(message, principal, store, {
          writeReady: state.write_ready,
        });
        if (response === null) return sendEmpty(res, 202);
        return sendJson(res, 200, response);
      }

      if (method === "GET" && pathname === "/v1/repos") {
        privateRole(req, config, "read");
        return sendJson(res, 200, { repos: store.listRepos() });
      }

      const workspaceMatch = pathname.match(/^\/v1\/workspaces\/([^/]+)$/);
      if (method === "GET" && workspaceMatch) {
        privateRole(req, config, "read");
        return sendJson(res, 200, store.resolveWorkspace(decodeSegment(workspaceMatch[1])));
      }

      if (method === "GET" && pathname === "/v1/audit/verify") {
        privateRole(req, config, "read");
        return sendJson(res, 200, store.auditStatus());
      }

      const artifactMetaMatch = pathname.match(/^\/v1\/artifacts\/([0-9a-fA-F]{64})\/meta$/);
      if (method === "GET" && artifactMetaMatch) {
        privateRole(req, config, "read");
        const artifact = store.getArtifact(artifactMetaMatch[1]);
        const { storage_path: _storagePath, ...publicArtifact } = artifact;
        return sendJson(res, 200, { artifact: publicArtifact });
      }

      const artifactMatch = pathname.match(/^\/v1\/artifacts\/([0-9a-fA-F]{64})$/);
      if (method === "GET" && artifactMatch) {
        privateRole(req, config, "read");
        const { metadata, stream } = cas.openForRead(artifactMatch[1]);
        res.writeHead(200, {
          "content-type": metadata.mime_type,
          "content-length": metadata.size_bytes,
          "etag": `"${metadata.sha256}"`,
          "cache-control": "private, max-age=31536000, immutable",
          "x-content-type-options": "nosniff",
        });
        stream.on("error", () => res.destroy());
        return stream.pipe(res);
      }

      if (method === "PUT" && artifactMatch) {
        const principal = privateRole(req, config, "write");
        requireWriteReady(config, store, runtime);
        const declaredLength = Number(req.headers["content-length"] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > config.maxArtifactBytes) {
          throw new HttpError(413, "artifact_too_large", "Artifact exceeds the configured size limit");
        }
        const result = await cas.putFromRequest(req, artifactMatch[1], principal);
        const { storage_path: _storagePath, ...publicArtifact } = result.artifact;
        return sendJson(res, result.replayed ? 200 : 201, {
          artifact: publicArtifact,
          replayed: result.replayed,
        });
      }

      if (method === "POST" && pathname === "/v1/registry/import") {
        const principal = privateRole(req, config, "admin");
        requireWriteReady(config, store, runtime);
        const body = await readJson(req, config.maxJsonBytes);
        const result = store.importRegistry(body, principal, idempotencyKey(req));
        return sendJson(res, result.replayed ? 200 : 201, result);
      }

      const promoteMatch = pathname.match(/^\/v1\/repos\/([^/]+)\/promote$/);
      if (method === "POST" && promoteMatch) {
        const principal = privateRole(req, config, "admin");
        requireWriteReady(config, store, runtime);
        const body = await readJson(req, config.maxJsonBytes);
        const result = store.promoteRepo(
          decodeSegment(promoteMatch[1]),
          body,
          principal,
          idempotencyKey(req),
        );
        return sendJson(res, 200, result);
      }

      const headMatch = pathname.match(/^\/v1\/repos\/([^/]+)\/head$/);
      if (method === "POST" && headMatch) {
        const principal = privateRole(req, config, "admin");
        requireWriteReady(config, store, runtime);
        const body = await readJson(req, config.maxJsonBytes);
        const result = store.updateCanonicalHead(
          decodeSegment(headMatch[1]),
          body,
          principal,
          idempotencyKey(req),
        );
        return sendJson(res, 200, result);
      }

      if (method === "POST" && pathname === "/v1/leases/acquire") {
        const principal = privateRole(req, config, "write");
        requireWriteReady(config, store, runtime);
        const body = await readJson(req, config.maxJsonBytes);
        const result = store.acquireLease(body, principal, idempotencyKey(req));
        return sendJson(res, result.replayed ? 200 : 201, result);
      }

      const renewMatch = pathname.match(/^\/v1\/leases\/([^/]+)\/renew$/);
      if (method === "POST" && renewMatch) {
        const principal = privateRole(req, config, "write");
        requireWriteReady(config, store, runtime);
        const body = await readJson(req, config.maxJsonBytes);
        const result = store.renewLease(
          decodeSegment(renewMatch[1]),
          body,
          principal,
          idempotencyKey(req),
        );
        return sendJson(res, 200, result);
      }

      const releaseMatch = pathname.match(/^\/v1\/leases\/([^/]+)\/release$/);
      if (method === "POST" && releaseMatch) {
        const principal = privateRole(req, config, "write");
        requireWriteReady(config, store, runtime);
        const body = await readJson(req, config.maxJsonBytes);
        const result = store.releaseLease(
          decodeSegment(releaseMatch[1]),
          body,
          principal,
          idempotencyKey(req),
        );
        return sendJson(res, 200, result);
      }

      if (method === "POST" && pathname === "/v1/tasks") {
        const principal = privateRole(req, config, "write");
        requireWriteReady(config, store, runtime);
        const body = await readJson(req, config.maxJsonBytes);
        const result = store.createTask(body, principal, idempotencyKey(req));
        return sendJson(res, result.replayed ? 200 : 201, result);
      }

      const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)$/);
      if (method === "PATCH" && taskMatch) {
        const principal = privateRole(req, config, "write");
        requireWriteReady(config, store, runtime);
        const body = await readJson(req, config.maxJsonBytes);
        const result = store.updateTask(
          decodeSegment(taskMatch[1]),
          body,
          principal,
          idempotencyKey(req),
        );
        return sendJson(res, 200, result);
      }

      if (method === "POST" && pathname === "/v1/handoffs") {
        const principal = privateRole(req, config, "write");
        requireWriteReady(config, store, runtime);
        const body = await readJson(req, config.maxJsonBytes);
        const result = store.createHandoff(body, principal, idempotencyKey(req));
        return sendJson(res, result.replayed ? 200 : 201, result);
      }

      const acceptMatch = pathname.match(/^\/v1\/handoffs\/([^/]+)\/accept$/);
      if (method === "POST" && acceptMatch) {
        const principal = privateRole(req, config, "write");
        requireWriteReady(config, store, runtime);
        const body = await readJson(req, config.maxJsonBytes);
        const result = store.acceptHandoff(
          decodeSegment(acceptMatch[1]),
          body,
          principal,
          idempotencyKey(req),
        );
        return sendJson(res, 200, result);
      }

      const nodeMatch = pathname.match(/^\/v1\/nodes\/([^/]+)\/report$/);
      if (method === "POST" && nodeMatch) {
        const principal = privateRole(req, config, "write");
        requireWriteReady(config, store, runtime);
        const body = await readJson(req, config.maxJsonBytes);
        const result = store.reportNode(
          decodeSegment(nodeMatch[1]),
          body,
          principal,
          idempotencyKey(req),
        );
        return sendJson(res, 200, result);
      }

      if (method === "POST" && pathname === "/v1/deployments/report") {
        const principal = privateRole(req, config, "write");
        requireWriteReady(config, store, runtime);
        const body = await readJson(req, config.maxJsonBytes);
        const result = store.reportDeployment(body, principal, idempotencyKey(req));
        return sendJson(res, result.replayed ? 200 : 201, result);
      }

      // Authenticate private-path misses before returning route information.
      if (pathname.startsWith("/v1/") || pathname === "/mcp") {
        privateRole(req, config, "read");
      }
      throw new HttpError(404, "not_found", "Route not found");
    } catch (error) {
      const httpError = asHttpError(error);
      if (httpError.statusCode >= 500 && httpError.code === "internal_error") {
        console.error(JSON.stringify({
          level: "error",
          event: "request_failed",
          method,
          path: pathname,
          error: error?.message ?? String(error),
        }));
      }
      if (!res.headersSent) {
        return sendJson(res, httpError.statusCode, {
          error: httpError.code,
          message: httpError.message,
          details: httpError.details,
        });
      }
      res.destroy();
    }
  });
}

export { readJson, readiness };
