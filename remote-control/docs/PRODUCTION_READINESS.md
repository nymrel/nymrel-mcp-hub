# Production Readiness Gate

A source build is a **production-ready candidate** only when the code gates below are green. It is **production live** only after the environment gates have separate evidence.

## Code gates

- [x] fail-closed authorization policy
- [x] exact projected tool schemas + schema hash checks
- [x] durable exactly-once claim state machine
- [x] encrypted call arguments/results at rest
- [x] tamper-evident audit receipts without task bodies
- [x] scoped/revocable/refreshable device credentials
- [x] pairing retry idempotence
- [x] offline-device dispatch refusal
- [x] modern MCP routing/header validation
- [x] MRTR approval binding/reconfirmation
- [x] external OAuth JWT/JWKS + opaque introspection support
- [x] Origin validation
- [x] body/schema/catalog size limits and rate limits
- [x] Nymrel-native bounded filesystem/search/process backend
- [x] optional supervised stdio MCP compatibility backend
- [x] health/readiness endpoints
- [x] container and operations documentation
- [x] automated unit/integration suite

## Current regular-ChatGPT read-only source gate — September 24, 2026

Current main through merged PR #64 (`76c8b78`) contains the existing-`@Nymrel`
read-only backend/profile work, per-tool OAuth security metadata, the live bridge
preflight, a bundled Nymrel OIDC issuer with Google-owner interaction/consent,
bounded login/token rates and cleanup, replay/grant tests, disabled container
packaging, CSRF-bound cancellation, exact bridge issuer handling, and Linux
container persistence/restart recovery proof. Routine credential paths are also
excluded from native reads and the Windows bootstrap preserves those exclusions.

These are source and isolated-container controls, not evidence that regular
ChatGPT can read JalenPC. The existing `@Nymrel` connection still originated as
authentication-none; the selected rollout uses an explicit OAuth-capable ChatGPT
connection when that existing connection cannot be migrated. Production issuer,
gateway and backend cutover, exact Google/client configuration, subject mapping,
and an ordinary-ChatGPT staged-file read remain environment evidence.

The next gate is therefore **identity/provider/deployment evidence**, not another
OAuth implementation: complete the protected Google/client and issuer custody
steps in `NYMREL_PLUGIN_READONLY_GATEWAY.md`, prove the exact plugin audience and
scopes with a real authorization/refresh, enable the backend only after issuer and
subject-map agreement, then perform the isolated allowed-file/denied-path canary.
No local root expansion or static-auth fallback is permitted to make that pass.

## Historical native-backend source gate

- [x] isolated branch pushed to GitHub (`chatgpt/nymrel-remote-native-agent-20260909`)
- [x] PR opened against `main` (#14)
- [ ] exact PR head passes isolated Nymrel Remote CI on Node 22.23.2 and 24.20.0
- [ ] exact PR head passes the dedicated Windows native-backend contract lane
- [ ] exact PR head passes the production Docker image build
- [ ] repository-wide workflow/security checks green on the exact head
- [ ] independent studio review recorded
- [ ] JalenPC native-agent bootstrap and real-device smoke recorded

This section records the earlier native-backend migration lane. It is not the current ChatGPT OAuth rollout gate. Consult the current source gate above and the existing-app gateway runbook before creating follow-on work.

## Environment gates

- [ ] production hostname selected
- [ ] TLS certificate active
- [ ] persistent volume provisioned and backup tested
- [ ] independent signing/data/audit keys installed from secret storage
- [ ] external OAuth AS configured for the exact MCP resource audience
- [ ] `NYMREL_REMOTE_OAUTH_SUBJECT_TENANTS` maps only the operator's OAuth subject to the paired tenant
- [ ] JalenPC `NYMREL_REMOTE_ALLOWED_DIRECTORIES` narrowed from the whole user profile before any cloud client is connected
- [ ] `check-production-cutover.mjs --profile=readonly` reports `ready` without `--allow-static-auth`
- [ ] static compatibility modes confirmed off unless deliberately approved
- [ ] bootstrap HTTP mint route confirmed off unless deliberately approved
- [ ] public smoke gate in `DEPLOYMENT.md` passed
- [ ] one real controlled device paired and then successfully revoked/re-paired as a recovery drill
- [ ] alerting/health checks connected to an operator-visible channel
- [ ] rollback drill completed

Until every applicable environment gate has evidence, do not describe the service as publicly deployed or production live.
