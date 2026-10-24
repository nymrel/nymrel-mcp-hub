# Amazon Build, Ship, Shape 2026 — Alexa+ execution brief

Tracking: nymrel/nymrel-swarm-studio#13

## Objective

Create a competition-period, reviewable extension of Nymrel MCP Hub that can be consumed by Alexa+ through an eligible self-hosted Model Context Protocol endpoint while preserving the repository's existing stdio contract and fail-closed posture.

This branch is **not** evidence of Devpost registration, AWS credits, deployment, Alexa+ testing, or submission.

## Why this repository

The current hub already:

- supports the MCP 2025-11-25 initialize-era revision required by the Alexa+ competition path;
- exposes the canonical Nymrel tool surface plus resources/prompts;
- has cross-runtime protocol tests and explicit security boundaries;
- is public and MIT licensed.

The competition-specific capability is a separately bounded Streamable HTTP transport. Main must not claim hosted availability until a separately authorized deployed path is independently verified.

## Product concept

**Nymrel Operator for Alexa+**

An Alexa+ agent can use a least-privilege subset of Nymrel tools to inspect local heuristic results, generated artifacts, and proof receipts without granting execution authority. The UCP audit is a template and does not measure a website.

The first competition slice is read/inspect-first. No deployment, purchase, file write, credential rotation, publishing, or other destructive action belongs in the initial Alexa+ surface.

## Implemented competition delta

### Streamable HTTP transport

The branch:

- implements MCP 2025-11-25 over stateless Streamable HTTP JSON responses;
- keeps stdio behavior separate;
- exposes only the reviewed four-tool hosted allowlist;
- rejects unsupported methods, protocols, content types, hosts, and origins;
- bounds request bytes, JSON nesting, response bytes, request time, concurrent requests, and request rate;
- requires bearer authentication for any non-loopback bind;
- supports deterministic graceful drain with a bounded forced-close fallback;
- returns sanitized deterministic transport errors.

Default source limits are intentionally conservative and can only be changed by trusted server configuration:

- body: 1 MiB;
- response: 256 KiB;
- request timeout: 5 seconds;
- concurrent requests: 16;
- request rate: 120 per 60 seconds;
- JSON nesting: 32 levels;
- drain timeout: 5 seconds.

These are application-level controls, not a substitute for TLS termination, network isolation, a reverse proxy, or provider-side abuse protection.

### Hosted allowlist

The hosted transport exposes only:

- `nymrel_ucp_audit`
- `nymrel_surety_guard`
- `nymrel_machine_trust`
- `nymrel_proof_verify`

Tools outside that list fail before dispatch. Any future hosted tool addition requires its own review.
Hosted discovery and results label the UCP audit as an unfetched template, the command check as a local heuristic, machine trust artifacts as generated but unpublished, and proof verification as a cryptographic check that does not prove execution. Resources and prompts are not exposed by this HTTP transport.

### Authentication and abuse controls

Loopback fixtures may omit bearer authentication. **Any non-loopback bind fails before listen unless a bearer token is configured.** Allowed-host configuration is also required by the packaged CLI for non-loopback operation.

The source does not log bearer values or tool request bodies. The local demo keeps `executed:false` evidence and never executes the inspected commands.

### Alexa+ local demo

Run:

```bash
corepack npm@12.0.2 run demo:alexa
```

The deterministic loopback workflow performs the real MCP handshake and demonstrates:

1. local pattern check of `npm test` → **ALLOW** label, without execution or authorization;
2. `rm -rf /` → **BLOCK** before execution;
3. `nymrel_swarm_claim` → hosted-boundary **REFUSED** with MCP `-32602`.

For the human-visible same-origin browser flow:

```bash
corepack npm@12.0.2 run demo:alexa:web
```

It renders ALLOW/BLOCK/REFUSED outcomes and lets the operator copy or download deterministic JSON evidence. Every decision receipt explicitly says `executed:false`.

These are local simulator proofs, not public endpoint, Alexa+ platform, deployment, or submission proof.

## Friction-log fixture

The canonical Stage-1 friction requirement is represented by:

- `examples/amazon-alexa-friction-log.fixture.json`
- `scripts/verify-alexa-friction-log.mjs`
- `npm run verify:alexa-friction`

The fixture is explicitly non-production and secret-free. The validator caps size, enforces required fields/statuses, and rejects secret-bearing keys and common credential-shaped values. Actual organizer-submission feedback, if ever supplied, must be captured separately from this local fixture and must not include credentials or private operator data.

## Optional prize stacking

Only after the core works:

- **Open Source mini-challenge:** use the existing public MIT repository only if the final submission path remains eligible.
- **AWS Builder mini-challenge:** add AWS only when it improves the product; no prize-only cloud dependency.

## Evidence checklist

Before any public claim or submission:

- [ ] current exact-head repository verification passes;
- [ ] Streamable HTTP boundary tests pass;
- [ ] friction fixture validation passes;
- [ ] genuinely independent review accepts the current head;
- [ ] public endpoint is verified from an external client;
- [ ] Alexa+ or organizer-accepted simulator evidence is captured;
- [ ] no secret material appears in logs or fixtures;
- [ ] main README capability boundary changes only after actual hosted evidence exists;
- [ ] competition-period commits remain identifiable;
- [ ] public demo video and reproducible setup instructions exist.

## External gates

Devpost registration, official rule acceptance, Amazon/AWS credentials, credits, public deployment, public video publication, and final submission remain separately gated. This branch does not perform or imply any of them.
