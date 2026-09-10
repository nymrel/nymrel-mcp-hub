# Railway deployment runbook

Nymrel Remote is a stateful single-active-instance service. Railway is configured as a long-running Docker service with one replica and a persistent `/data` volume. Do not deploy this build as stateless/serverless functions and do not configure multiple active replicas.

## Service layout

Use the Nymrel MCP Hub repository with:

```text
Root Directory: /remote-control
Config File: /remote-control/railway.json
Volume mount: /data
Replicas: 1
```

The repository `railway.json` uses the Dockerfile, `/readyz` as the health check, an always-restart policy, and a drain window. The Docker entrypoint starts with the minimum root privilege required to take ownership of a newly mounted `/data` volume, validates that the state path stays under `/data`, and then drops to UID/GID 1000 before importing the Nymrel Remote server.

Set Railway's runtime UID override so the entrypoint can perform that one ownership step:

```text
RAILWAY_RUN_UID=0
```

The application process itself does not remain root after startup. CI starts the production image with an anonymous volume, waits for `/readyz`, and verifies that PID 1 has dropped to UID 1000.

## Required production variables

Do not put any values from this section in Git, tickets, logs, or chat transcripts. Generate independent high-entropy values in a secret-management context.

```text
NODE_ENV=production
PORT=8787
NYMREL_REMOTE_HOST=0.0.0.0
NYMREL_REMOTE_PORT=8787
NYMREL_REMOTE_STORE=/data/state.json
NYMREL_REMOTE_PUBLIC_URL=https://<production-host>

NYMREL_REMOTE_SIGNING_KEY=<independent 32-byte key>
NYMREL_REMOTE_DATA_KEY=<different independent 32-byte key>
NYMREL_REMOTE_AUDIT_KEY=<different independent 32-byte key>
NYMREL_REMOTE_BOOTSTRAP_TOKEN=<high-entropy bootstrap credential>

NYMREL_REMOTE_AUTHORIZATION_SERVERS=https://<oauth-issuer>
NYMREL_REMOTE_OAUTH_ISSUER=https://<oauth-issuer>
NYMREL_REMOTE_OAUTH_AUDIENCE=https://<production-host>/mcp
NYMREL_REMOTE_CHATGPT_OAUTH_AUDIENCE=https://<production-host>/chatgpt/mcp
```

Configure either JWKS verification or OAuth introspection according to the authorization server:

```text
NYMREL_REMOTE_OAUTH_JWKS_URL=https://<oauth-issuer>/<jwks-path>
```

or:

```text
NYMREL_REMOTE_OAUTH_INTROSPECTION_URL=https://<oauth-issuer>/<introspection-path>
NYMREL_REMOTE_OAUTH_INTROSPECTION_CLIENT_ID=<secret>
NYMREL_REMOTE_OAUTH_INTROSPECTION_CLIENT_SECRET=<secret>
```

Keep compatibility escape hatches disabled in normal production:

```text
NYMREL_REMOTE_ALLOW_STATIC_MCP_TOKENS=false
NYMREL_REMOTE_ALLOW_STATIC_ADMIN_TOKENS=false
NYMREL_REMOTE_ALLOW_BOOTSTRAP_HTTP=false
```

## Payload retention

The default hosted retention is deliberately short for payload-bearing durable records:

```text
NYMREL_REMOTE_CALL_RETENTION_MS=86400000
NYMREL_REMOTE_PAIRING_RETENTION_MS=3600000
```

Terminal call records containing encrypted arguments/results are pruned after 24 hours by default. Consumed or expired pairing records are pruned after one hour. Audit receipts remain because they contain hashes and operational metadata rather than task, file, command, or result bodies. Active calls and active pairings are not removed by retention cleanup.

Set `NYMREL_REMOTE_ALLOWED_ORIGINS` only to actual first-party web origins that need browser access. MCP clients that do not send an Origin header are authenticated by OAuth instead.

## OAuth provider gate

Do not enable static-token compatibility as a substitute for a production authorization server. The provider must support OAuth authorization-code flow with PKCE, authorization-server discovery, MCP client registration or another OpenAI-supported client-registration path, and audience/resource-bound access tokens that Nymrel Remote can verify by JWKS or introspection.

For this remote-execution surface, prefer a production-grade managed authorization service with explicit MCP support. Provider provisioning remains a separate external account gate from Railway deployment.

## Domain, TLS, and review URLs

A Railway-generated HTTPS hostname can be used for the first production smoke. A Nymrel-owned custom hostname is preferred before public plugin submission. `NYMREL_REMOTE_PUBLIC_URL` must exactly match the externally reachable HTTPS origin.

The same service exposes the review-facing pages:

```text
https://<production-host>/privacy
https://<production-host>/terms
https://<production-host>/support
```

After a hostname change, update both OAuth resource audiences and re-run the full health/MCP/device smoke before calling the environment production-ready.

## Deployment verification

The deployment is not complete until all of these are proven against the live hostname:

1. `GET /healthz` returns 200.
2. `GET /readyz` returns 200 with a valid audit chain.
3. `/privacy`, `/terms`, and `/support` return the Nymrel Remote review pages over HTTPS.
4. Protected Resource Metadata is reachable for both `/mcp` and `/chatgpt/mcp`.
5. Unauthenticated MCP calls return an OAuth Bearer challenge rather than executing.
6. OAuth can issue an audience-bound token for `/chatgpt/mcp`.
7. A real device pairs and registers the native catalog.
8. `list_devices` from `/chatgpt/mcp` sees that device.
9. A remote read succeeds.
10. A remote write/process call enters the expected approval/policy path and then succeeds only after permitted confirmation.
11. The agent is deliberately terminated and the supervisor brings it back online.
12. A device revoke/re-pair recovery drill succeeds.
13. A rollback to the previous known-good service revision is tested.

## JalenPC install target

For JalenPC, persist these as User or Machine environment variables before installing autostart:

```text
NYMREL_REMOTE_SERVER_URL=https://<production-host>
NYMREL_REMOTE_DEVICE_NAME=JalenPC
NYMREL_REMOTE_ALLOWED_DIRECTORIES=["C:\\Users\\johns"]
NYMREL_REMOTE_LOCAL_CWD=C:\Users\johns
NYMREL_REMOTE_LOCAL_SHELL=powershell.exe
```

Then run `bin/install-nymrel-remote-windows.ps1` from the checked-out `remote-control` directory. The task launches `nymrel-remote-supervisor`, which restarts the native device agent with exponential backoff.

The current Remote Desktop Commander connection cannot perform this bootstrap because its local Desktop Commander MCP package fails before command execution. Treat the installer as a one-time migration bootstrap; after the live Nymrel device agent is paired and smoke-tested, normal remote operation no longer depends on Remote Desktop Commander.
