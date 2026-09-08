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
- [x] supervised local stdio MCP process
- [x] health/readiness endpoints
- [x] container and operations documentation
- [x] automated unit/integration suite

## Hosted source gates

- [x] branch pushed to GitHub (`feat/nymrel-remote-control-plane-20260907`)
- [x] draft PR opened against `main` (#11)
- [x] isolated GitHub Actions checks green on Node 22.23.2 and 24.20.0
- [x] production Docker image build green in hosted CI
- [x] CodeQL green on the candidate head
- [ ] independent studio review recorded
- [ ] local studio writer-claim / integration-conflict check recorded (JalenPC is offline; GitHub diff itself is isolated)

The repository-wide MCP Hub Node matrix has a pre-existing `actions/setup-node` bootstrap defect on the same `main` base; draft PR #5 owns that repair. The isolated Nymrel Remote workflow disables the defective implicit npm cache path and is green. This lane does not absorb PR #5.

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
