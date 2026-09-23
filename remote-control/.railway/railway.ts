import { defineRailway, github, preserve, project, service, volume } from "railway/iac";

// Imported from the existing production environment. preserve() keeps secret
// values on Railway; this file never reads or stores them.
export default defineRailway(() => {
  const data = volume("nymrel-remote-data-tPGV", {
    alerts: { usage: { "80": {}, "95": {}, "100": {} } },
    allowOnlineResize: true,
    region: "sfo",
    sizeMB: 500,
  });

  const remote = service("nymrel-remote", {
    source: github("nymrel/nymrel-mcp-hub", { rootDirectory: "/remote-control" }),
    build: {
      buildEnvironment: "V3",
      builder: "DOCKERFILE",
      dockerfilePath: "Dockerfile",
      watchPatterns: [
        "/remote-control/bin/**",
        "/remote-control/src/**",
        "/remote-control/public/**",
        "/remote-control/package.json",
        "/remote-control/package-lock.json",
        "/remote-control/Dockerfile",
        "/remote-control/.dockerignore",
        "/remote-control/.railway/**",
      ],
    },
    deploy: {
      healthcheckPath: "/readyz",
      healthcheckTimeout: 300,
      restartPolicyType: "ALWAYS",
      drainingSeconds: 30,
    },
    replicas: { sfo: 1 },
    volumeMounts: { "/data": data },
    env: {
      NODE_ENV: preserve(),
      NYMREL_REMOTE_ALLOWED_ORIGINS: preserve(),
      NYMREL_REMOTE_ALLOW_BOOTSTRAP_HTTP: preserve(),
      NYMREL_REMOTE_ALLOW_STATIC_ADMIN_TOKENS: preserve(),
      NYMREL_REMOTE_ALLOW_STATIC_MCP_TOKENS: preserve(),
      NYMREL_REMOTE_AUDIT_KEY: preserve(),
      NYMREL_REMOTE_BOOTSTRAP_TOKEN: preserve(),
      NYMREL_REMOTE_CALL_RETENTION_MS: preserve(),
      NYMREL_REMOTE_CALL_TTL_MS: preserve(),
      NYMREL_REMOTE_CHATGPT_OAUTH_AUDIENCE: preserve(),
      NYMREL_REMOTE_CONTAINER_GID: preserve(),
      NYMREL_REMOTE_CONTAINER_UID: preserve(),
      NYMREL_REMOTE_CONTAINER_WRITABLE_ROOT: preserve(),
      NYMREL_REMOTE_DATA_KEY: preserve(),
      NYMREL_REMOTE_HEARTBEAT_TTL_MS: preserve(),
      NYMREL_REMOTE_HOST: preserve(),
      NYMREL_REMOTE_INSTANCE_LEASE_TTL_MS: preserve(),
      NYMREL_REMOTE_MAX_BODY_BYTES: preserve(),
      NYMREL_REMOTE_MAX_TOOLS_PER_DEVICE: preserve(),
      NYMREL_REMOTE_MAX_TOOL_SCHEMA_BYTES: preserve(),
      NYMREL_REMOTE_OAUTH_AUDIENCE: preserve(),
      NYMREL_REMOTE_PAIRING_RETENTION_MS: preserve(),
      NYMREL_REMOTE_PAIRING_TTL_MS: preserve(),
      NYMREL_REMOTE_PORT: preserve(),
      NYMREL_REMOTE_PUBLIC_URL: preserve(),
      NYMREL_REMOTE_SIGNING_KEY: preserve(),
      NYMREL_REMOTE_STORE: preserve(),
      NYMREL_REMOTE_SYNC_WAIT_MS: preserve(),
      PORT: preserve(),
      RAILWAY_RUN_UID: preserve(),
    },
  });

  return project("Nymrel Remote", { resources: [remote, data] });
});
