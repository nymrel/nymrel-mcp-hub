# Nymrel Workspace Gateway

Nymrel Workspace Gateway is the canonical coordination service for Nymrel local and cloud agents.

It does not synchronize mutable filesystem trees. It gives every agent the same logical workspace identity: repository, canonical Git state, active writer lease, task and handoff state, local mirror observations, deployment observations, and immutable artifacts.

## Authority model

| Concern | v1 authority |
| --- | --- |
| Source code, branches, commits | GitHub |
| Workspace registry | Gateway single-primary transactional store |
| Leases, fencing, tasks, handoffs | Gateway single-primary transactional store |
| Local checkout state | Node observations submitted to Gateway |
| Deployment state | Provider observations submitted to Gateway |
| Large artifacts | SHA-256 content-addressed persistent storage |
| Audit history | Append-only SHA-256 hash chain |
| Local execution | Nymrel Remote and local agents |
| Human office documents | External document systems such as Google Drive |

The v1 store uses Node 24 built-in SQLite with STRICT tables, WAL, BEGIN IMMEDIATE writes, explicit UUID identifiers, and portable TEXT/INTEGER fields. The service/API contract is intentionally storage-neutral so Postgres can replace SQLite without changing agent behavior.

## Security model

The service has three bearer roles:

- read: list and resolve workspaces, verify audit history, read artifacts.
- write: read privileges plus leases, tasks, handoffs, node reports, deployment reports, and artifact uploads.
- admin: write privileges plus registry import and canonical repo promotion/head updates.

Required production variables:

- NYMREL_WORKSPACE_READ_TOKEN
- NYMREL_WORKSPACE_WRITE_TOKEN
- NYMREL_WORKSPACE_ADMIN_TOKEN

Bearer values are never logged. Comparisons use constant-time SHA-256 prehash comparison.

NYMREL_WORKSPACE_INSECURE_LOCAL=1 is development-only. The process refuses to start in insecure mode unless HOST is loopback.

/healthz is public liveness. /readyz is public readiness metadata containing no secrets. A service with missing auth credentials or a broken audit chain stays observable but fails closed for every mutation.

## Core invariants

1. Candidate registry import never makes data canonical.
2. Canonical promotion is explicit, admin-only, evidence-bearing, idempotent, and audited.
3. Canonical head advancement is compare-and-swap: expected SHA must equal the current canonical SHA.
4. Per-repo fencing tokens are DB-durable, monotonic, and allocated inside BEGIN IMMEDIATE.
5. Lease expiry uses the database clock, not client clocks.
6. Lease paths are strict repo-relative prefixes; star means the whole repo.
7. Stale/mismatched fencing tokens cannot renew or release leases or update fenced task state.
8. Handoff acceptance retires the source lease and issues a higher fencing token atomically.
9. Artifact bytes are streamed, hashed, fsync'd, atomically renamed, and only then registered.
10. Audit-chain corruption keeps health readable but disables all mutation routes.

## Local development

Node 24 or newer is required.

~~~powershell
$env:HOST = "127.0.0.1"
$env:NYMREL_WORKSPACE_INSECURE_LOCAL = "1"
node src/index.js
~~~

Then in another terminal:

~~~powershell
$env:NYMREL_WORKSPACE_URL = "http://127.0.0.1:8787"
$env:NYMREL_WORKSPACE_TOKEN = "unused-in-insecure-local"
node bin/nymrel-workspace.mjs list
~~~

For any non-loopback deployment, do not enable insecure-local mode.

## Bootstrap the studio

The portfolio-control Workspace Registry Candidate audit emits nymrel.workspace-registry-candidate/v1.

Set the gateway URL and an admin bearer token in environment variables, never CLI arguments:

~~~powershell
$env:NYMREL_WORKSPACE_URL = "https://<workspace-gateway>"
$env:NYMREL_WORKSPACE_TOKEN = "<admin bearer>"
$env:NYMREL_WORKSPACE_PRINCIPAL = "node:jalenpc"
node bin/nymrel-workspace.mjs bootstrap-candidate C:\path\candidate.json node:jalenpc
~~~

Bootstrap imports candidate identities and publishes the local node snapshot. It never fetches, resets, moves, cleans, commits, or otherwise mutates a Git worktree.

## Promote a reconciled repository

After an authoritative Git provider verifies remote, default branch, and exact SHA:

~~~powershell
node bin/nymrel-workspace.mjs promote repo-id https://github.com/nymrel/repo.git main <sha> evidence.json
~~~

Evidence must be a non-empty JSON object describing the provider/ref/probe that established the values.

Canonical head advancement is compare-and-swap:

~~~powershell
node bin/nymrel-workspace.mjs head repo-id <expected-sha> <new-sha> evidence.json
~~~

Once a repo is canonical, lease acquisition rejects any base SHA other than the current canonical SHA.

## Agent lease flow

Acquire:

~~~powershell
node bin/nymrel-workspace.mjs acquire repo-id <base-sha> "src,tests"
~~~

Persist the returned lease_id and fencing_token. State-changing work tied to the lease must carry that fence token.

Renew:

~~~powershell
node bin/nymrel-workspace.mjs renew <lease-id> <fencing-token>
~~~

Release:

~~~powershell
node bin/nymrel-workspace.mjs release <lease-id> <fencing-token>
~~~

## MCP

POST /mcp uses the exact same WorkspaceStore implementation as REST.

Read-role tools:

- workspace_list
- workspace_resolve
- audit_verify
- artifact_metadata

Write-role additions:

- lease_acquire
- lease_renew
- lease_release
- task_create
- task_update
- handoff_create
- handoff_accept
- node_report
- deployment_report

Admin additions:

- registry_import
- repo_promote
- repo_head_update

The MCP tool list itself is filtered by bearer role.

## REST

Public:

- GET /healthz
- GET /readyz

Authenticated reads:

- GET /v1/repos
- GET /v1/workspaces/:repo
- GET /v1/audit/verify
- GET /v1/artifacts/:sha256
- GET /v1/artifacts/:sha256/meta

Write:

- PUT /v1/artifacts/:sha256
- POST /v1/leases/acquire
- POST /v1/leases/:id/renew
- POST /v1/leases/:id/release
- POST /v1/tasks
- PATCH /v1/tasks/:id
- POST /v1/handoffs
- POST /v1/handoffs/:id/accept
- POST /v1/nodes/:id/report
- POST /v1/deployments/report

Admin:

- POST /v1/registry/import
- POST /v1/repos/:id/promote
- POST /v1/repos/:id/head

REST JSON mutations require Idempotency-Key. MCP mutation tools carry idempotency_key in their arguments.

## Artifact CAS

Upload bytes with PUT /v1/artifacts/<sha256>. The URI digest must match the streamed bytes.

Content is persisted before metadata. A crash can therefore create an unreferenced orphan blob, which startup recovery may later delete after a grace period. The reverse condition, a database record pointing to missing bytes, is treated as storage corruption and fails closed.

## Startup recovery

At startup the service:

1. opens the durable database in WAL mode;
2. verifies the complete audit hash chain;
3. if valid, expires stale leases using the database clock;
4. reports orphaned active tasks and pending handoffs;
5. sweeps old CAS temp/orphan files;
6. starts serving.

If the audit chain is invalid, diagnostic reads remain available and mutations remain blocked.

## Production deployment

Mount one persistent volume at /data. V1 is intentionally single-primary: use one replica only. Horizontal multi-writer replicas are unsupported until the storage adapter moves to Postgres.

railway.toml uses /healthz for container liveness so an unconfigured deployment can start safely. Operational monitoring must use /readyz; it returns success only when storage, authentication, and audit integrity are all ready.

The Workspace Gateway is independent from remote-control/. Nymrel Remote remains the local-machine capability bridge. The Workspace Gateway provides canonical coordination state used by every local or cloud agent.

## Validation

~~~bash
npm run check
~~~

The suite covers authentication/role isolation, Windows/Linux syntax portability, candidate idempotency, canonical promotion/head CAS, path locking, monotonic fencing, stale-writer rejection, task fencing, handoff transfer, node/deployment observations, startup recovery, audit tamper detection, REST/MCP parity, CAS integrity, CLI bootstrap, and insecure-local refusal.
