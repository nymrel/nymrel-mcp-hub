import os from "node:os";
import path from "node:path";

function envBoolean(value) {
  return value === "1" || value === "true";
}

function envInteger(value, fallback, min, max) {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid integer environment value: ${value}`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const dataDir = path.resolve(
    env.NYMREL_WORKSPACE_DATA_DIR
      ?? (env.RAILWAY_VOLUME_MOUNT_PATH
        ? path.join(env.RAILWAY_VOLUME_MOUNT_PATH, "workspace-gateway")
        : path.join(os.homedir(), ".nymrel-workspace")),
  );
  const insecureLocal = envBoolean(env.NYMREL_WORKSPACE_INSECURE_LOCAL);
  const config = {
    host: env.HOST ?? "0.0.0.0",
    port: envInteger(env.PORT, 8787, 1, 65535),
    dataDir,
    dbPath: path.join(dataDir, "workspace.db"),
    artifactDir: path.join(dataDir, "artifacts"),
    tempDir: path.join(dataDir, "tmp"),
    readToken: env.NYMREL_WORKSPACE_READ_TOKEN ?? "",
    writeToken: env.NYMREL_WORKSPACE_WRITE_TOKEN ?? "",
    adminToken: env.NYMREL_WORKSPACE_ADMIN_TOKEN ?? "",
    insecureLocal,
    maxJsonBytes: envInteger(env.NYMREL_WORKSPACE_MAX_JSON_BYTES, 1_048_576, 1024, 16_777_216),
    maxArtifactBytes: envInteger(env.NYMREL_WORKSPACE_MAX_ARTIFACT_BYTES, 52_428_800, 1024, 1_073_741_824),
    defaultLeaseTtlSeconds: envInteger(env.NYMREL_WORKSPACE_DEFAULT_LEASE_TTL_SECONDS, 900, 30, 7200),
    minLeaseTtlSeconds: envInteger(env.NYMREL_WORKSPACE_MIN_LEASE_TTL_SECONDS, 60, 1, 3600),
    maxLeaseTtlSeconds: envInteger(env.NYMREL_WORKSPACE_MAX_LEASE_TTL_SECONDS, 7200, 60, 86400),
    idempotencyTtlSeconds: envInteger(env.NYMREL_WORKSPACE_IDEMPOTENCY_TTL_SECONDS, 86400, 60, 604800),
  };
  const configuredTokens = [config.readToken, config.writeToken, config.adminToken].filter(Boolean);
  if (configuredTokens.length === 3 && new Set(configuredTokens).size !== 3) {
    throw new Error("Workspace bearer tokens must be distinct across read, write, and admin roles");
  }
  config.authReady = insecureLocal || configuredTokens.length === 3;
  return Object.freeze(config);
}
