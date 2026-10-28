import crypto from "node:crypto";
import { HttpError } from "./errors.js";
import { safeHeaderValue, sha256Hex } from "./utils.js";

const RANK = Object.freeze({ read: 1, write: 2, admin: 3 });

function tokenMatches(provided, expected) {
  if (!provided || !expected) {
    return false;
  }
  const left = Buffer.from(sha256Hex(provided), "hex");
  const right = Buffer.from(sha256Hex(expected), "hex");
  return crypto.timingSafeEqual(left, right);
}

function isLoopback(address) {
  return address === "127.0.0.1"
    || address === "::1"
    || address === "::ffff:127.0.0.1";
}

export function authorize(req, config, requiredRole = "read") {
  if (!RANK[requiredRole]) {
    throw new Error(`Unknown auth role: ${requiredRole}`);
  }

  if (config.insecureLocal) {
    if (!isLoopback(req.socket.remoteAddress)) {
      throw new HttpError(403, "insecure_local_remote_rejected", "Insecure local mode accepts loopback clients only");
    }
    return {
      role: "admin",
      id: safeHeaderValue(req.headers["x-nymrel-principal"], "local-insecure"),
      authentication: "insecure-local",
    };
  }

  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) {
    throw new HttpError(401, "missing_bearer_token", "Bearer authentication is required");
  }
  const token = header.slice("Bearer ".length).trim();
  let role = null;
  if (tokenMatches(token, config.adminToken)) role = "admin";
  else if (tokenMatches(token, config.writeToken)) role = "write";
  else if (tokenMatches(token, config.readToken)) role = "read";

  if (!role) {
    throw new HttpError(401, "invalid_bearer_token", "Bearer token is invalid");
  }
  if (RANK[role] < RANK[requiredRole]) {
    throw new HttpError(403, "insufficient_scope", `${requiredRole} access is required`);
  }
  return {
    role,
    id: safeHeaderValue(req.headers["x-nymrel-principal"], `${role}-token`),
    authentication: "bearer",
  };
}

export function roleAllows(actualRole, requiredRole) {
  return Boolean(RANK[actualRole] && RANK[requiredRole] && RANK[actualRole] >= RANK[requiredRole]);
}
