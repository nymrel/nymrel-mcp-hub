# Nymrel Remote

Nymrel Remote is a remote MCP control plane and outbound-only device agent for computers you own. It projects a paired machine's local MCP tools into a hosted MCP endpoint without exposing an inbound port on the machine.

This package is intentionally isolated from the existing `@nymrel/mcp-hub` release artifact. It is an incubation/product lane, not a claim that the current Nymrel MCP Hub package has changed.

## Architecture

```text
AI client
  |  MCP 2026-07-28 + OAuth bearer
  v
Nymrel Remote MCP edge
  |  exact tool-schema projection + policy
  v
Durable encrypted call store  <---- operator approvals / audit chain
  |  outbound SSE doorbell + polling reconciliation
  v
Nymrel Remote device agent
  |  local stdio MCP
  v
DesktopCommanderMCP or another local MCP server
  v
Owned computer
```

The realtime event channel is advisory. The durable call record is authoritative. A device atomically claims a queued call before execution, so duplicate event delivery cannot execute the same call twice.

## Security defaults

- Remote devices make outbound connections only; there is no inbound listener on the computer.
- Tool arguments and results are AES-256-GCM encrypted at rest with call-specific authenticated data.
- Audit receipts store hashes and policy metadata, not task arguments or result bodies.
- Device tokens are scoped, revocable by generation, and refreshed before expiry.
- Read operations are auto-allowed only when the caller has `tools:read`.
- Writes and execution require operator approval by default.
- Unknown tools are denied. Known destructive tools are denied unless policy and scope are deliberately changed.
- Current MCP clients can use multi-round-trip elicitation for in-band approval. Older clients use the explicit approval tool/API.
- Projected input schemas are copied exactly and schema-hashed. The device checks the hash again immediately before local execution.
- Modern HTTP requests validate MCP protocol/method/name routing headers and any `x-mcp-header` parameter mirrors.
- Production MCP access is expected to use an external OAuth authorization server with audience-bound access tokens. Static MCP/admin tokens are off by default in production.
- The HTTP bootstrap-token mint route is off by default in production.

See [SECURITY.md](SECURITY.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).

## Requirements

- Node.js 22 or 24
- TLS termination in production
- A persistent local volume for the single server process
- An OAuth authorization server in production, unless the operator explicitly enables static-token compatibility mode
- A local stdio MCP server on each controlled machine. The default command is `desktop-commander`.

The current durable store and in-process event fanout are designed for **one server process / one replica**. Do not horizontally scale this build behind multiple active replicas. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Local development

```bash
npm ci
npm run check

# Terminal 1
node ./bin/nymrel-remote-server.js

# Terminal 2, on the machine to pair
node ./bin/nymrel-remote-agent.js
```

Development defaults bind the server to `127.0.0.1:8787` and use deterministic development-only keys. Production refuses to start without explicit cryptographic keys, public URL, bootstrap credential, and a configured authorization strategy.

## Production configuration

Generate independent 32-byte keys. Do not reuse keys across purposes.

```bash
openssl rand -hex 32  # signing
openssl rand -hex 32  # data encryption
openssl rand -hex 32  # audit HMAC
openssl rand -base64 48 # bootstrap credential
```

Set at minimum:

```text
NODE_ENV=production
NYMREL_REMOTE_HOST=0.0.0.0
NYMREL_REMOTE_PORT=8787
NYMREL_REMOTE_PUBLIC_URL=https://remote.example.com
NYMREL_REMOTE_STORE=/data/state.json
NYMREL_REMOTE_SIGNING_KEY=<32-byte key>
NYMREL_REMOTE_DATA_KEY=<different 32-byte key>
NYMREL_REMOTE_AUDIT_KEY=<different 32-byte key>
NYMREL_REMOTE_BOOTSTRAP_TOKEN=<high entropy credential>
NYMREL_REMOTE_AUTHORIZATION_SERVERS=https://auth.example.com
NYMREL_REMOTE_OAUTH_ISSUER=https://auth.example.com
NYMREL_REMOTE_OAUTH_AUDIENCE=https://remote.example.com/mcp
```

Leave these false unless deliberately using compatibility mode:

```text
NYMREL_REMOTE_ALLOW_STATIC_MCP_TOKENS=false
NYMREL_REMOTE_ALLOW_STATIC_ADMIN_TOKENS=false
NYMREL_REMOTE_ALLOW_BOOTSTRAP_HTTP=false
```

A complete template is in [.env.example](.env.example).

## Device configuration

On a controlled machine:

```text
NYMREL_REMOTE_SERVER_URL=https://remote.example.com
NYMREL_REMOTE_MCP_COMMAND=desktop-commander
NYMREL_REMOTE_MCP_ARGS=[]
```

Then run:

```bash
node ./bin/nymrel-remote-agent.js
```

The agent prints a short pairing code. Approve it from an authenticated Nymrel Remote operator session or via the `nymrel_remote_approve_pairing` MCP tool. Device credentials are stored with restrictive filesystem permissions where supported and are never sent to a different server URL than the URL they were issued for.

## MCP endpoint

- URL: `/mcp`
- Transport: HTTP POST
- Modern protocol: `2026-07-28`
- Protected Resource Metadata: `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp`
- Device-specific tools: dynamically projected with stable per-device names and exact local `inputSchema`

The edge also retains initialize-era response handling for client compatibility, while modern HTTP requests follow the 2026-07-28 routing and metadata contract.

## Operator endpoints

The web dashboard is intentionally small and does not persist bearer tokens in browser storage. Operator API actions require scoped authorization.

Important scopes:

- `devices:pair`, `devices:read`, `devices:revoke`
- `calls:read`, `calls:approve`
- `audit:read`
- `tools:read`, `tools:write`, `tools:execute`, `tools:network`

## Validation

```bash
npm run check
```

The suite covers cryptographic envelopes, signed tokens, audit tamper detection, exact schema relay, MCP header routing, RSA/ECDSA/opaque OAuth tokens, pairing idempotence, credential refresh, offline refusal, exactly-once claims, MRTR approvals, HTTP Origin/auth behavior, end-to-end HTTP call completion, and stdio MCP supervision.

## Deployment status semantics

A passing local or GitHub CI build means the source is a production **candidate**. It does not prove that a public service is deployed, DNS/TLS/OAuth are configured, an external authorization server has issued a valid token, or a real device has passed the post-deploy smoke test. Those are separate release receipts in [docs/PRODUCTION_READINESS.md](docs/PRODUCTION_READINESS.md).
