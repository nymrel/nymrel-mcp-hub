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

## Current native-backend source gate

- [x] isolated branch pushed to GitHub (`chatgpt/nymrel-remote-native-agent-20260909`)
- [x] PR opened against `main` (#14)
- [ ] exact PR head passes isolated Nymrel Remote CI on Node 22.23.2 and 24.20.0
- [ ] exact PR head passes the dedicated Windows native-backend contract lane
- [ ] exact PR head passes the production Docker image build
- [ ] repository-wide workflow/security checks green on the exact head
- [ ] independent studio review recorded
- [ ] JalenPC native-agent bootstrap and real-device smoke recorded

The current JalenPC relay is reachable and responds to transport-level pings, but Remote Desktop Commander substantive operations fail because its local Desktop Commander MCP package is missing/broken. That failure is the migration motivation, not evidence that the Nymrel-native agent is already installed on JalenPC.

## Environment gates

- [ ] production hostname selected
- [ ] TLS certificate active
- [ ] persistent volume provisioned and backup tested
- [ ] independent signing/data/audit keys installed from secret storage
- [ ] external OAuth AS configured for the exact MCP resource audience
- [ ] static compatibility modes confirmed off unless deliberately approved
- [ ] bootstrap HTTP mint route confirmed off unless deliberately approved
- [ ] public smoke gate in `DEPLOYMENT.md` passed
- [ ] one real controlled device paired and then successfully revoked/re-paired as a recovery drill
- [ ] alerting/health checks connected to an operator-visible channel
- [ ] rollback drill completed

Until every applicable environment gate has evidence, do not describe the service as publicly deployed or production live.
