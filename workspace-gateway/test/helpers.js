import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

export function makeTempRoot(prefix = "nymrel-workspace-test-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function makeConfig(root, overrides = {}) {
  const dataDir = path.join(root, "data");
  const config = {
    host: "127.0.0.1",
    port: 0,
    dataDir,
    dbPath: path.join(dataDir, "workspace.db"),
    artifactDir: path.join(dataDir, "artifacts"),
    tempDir: path.join(dataDir, "tmp"),
    readToken: "read-secret",
    writeToken: "write-secret",
    adminToken: "admin-secret",
    insecureLocal: false,
    authReady: true,
    maxJsonBytes: 1_048_576,
    maxArtifactBytes: 1_048_576,
    defaultLeaseTtlSeconds: 60,
    minLeaseTtlSeconds: 1,
    maxLeaseTtlSeconds: 3600,
    idempotencyTtlSeconds: 3600,
    ...overrides,
  };
  return config;
}

export function candidateRegistry({
  name = "Repo A",
  pathValue = "RepoA",
  sha = SHA_A,
  branch = "main",
  origin = "https://github.com/nymrel/repo-a.git",
} = {}) {
  return {
    schema_version: "nymrel.workspace-registry-candidate/v1",
    authority: "candidate",
    advisory: true,
    source_manifest: {
      path: "C:/studio/STUDIO_MANIFEST.json",
      sha256: "d".repeat(64),
    },
    repos: [
      {
        authority: "candidate",
        advisory: true,
        identity_key: "repo a::repoa",
        manifest: { name, path: pathValue },
        local: {
          exists: true,
          is_git: true,
          branch,
          head_sha: sha,
          dirty: false,
          origin_url: origin,
        },
        risk_flags: [],
      },
    ],
  };
}

export const adminPrincipal = Object.freeze({ role: "admin", id: "agent:admin" });
export const writerA = Object.freeze({ role: "write", id: "agent:a" });
export const writerB = Object.freeze({ role: "write", id: "agent:b" });
