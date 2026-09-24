# Amazon Build, Ship, Shape 2026 — Alexa+ execution brief

Tracking: nymrel/nymrel-swarm-studio#13

## Objective

Create a competition-period, reviewable extension of Nymrel MCP Hub that can be consumed by Alexa+ through an eligible self-hosted Model Context Protocol endpoint while preserving the repository's existing stdio contract and fail-closed posture.

This branch is **not** evidence of Devpost registration, AWS credits, deployment, Alexa+ testing, or submission.

## Why this repository

The current hub already:

- supports the MCP 2025-11-25 initialize-era revision required by the Alexa+ competition path;
- exposes 14 bounded Nymrel tools plus resources/prompts;
- has cross-runtime protocol tests and explicit security boundaries;
- is public and MIT licensed.

The missing competition-specific capability is a hosted Streamable HTTP transport. The main README currently states that hosted transport is not claimed; that statement must remain true on `main` until an independently verified hosted path exists.

## Product concept

**Nymrel Operator for Alexa+**

An Alexa+ agent can use a least-privilege subset of Nymrel inspection tools to answer questions such as:

- Is this website ready for agentic commerce?
- What machine-readable trust metadata is available?
- Does this proof receipt verify against a supplied key?
- Which model profile satisfies an explicit set of routing constraints?
- Is a proposed command/path obviously destructive or unsafe?

The first competition slice should be read/inspect-first. No deployment, purchase, file write, credential rotation, publishing, or other destructive action belongs in the initial Alexa+ surface.

## Required competition delta

### 1. Streamable HTTP transport

Add a separate hosted entry point that:

- implements the eligible MCP Streamable HTTP request path;
- negotiates the existing supported protocol revision correctly;
- does not silently change stdio semantics;
- rejects unsupported methods/content types;
- applies strict body, response, timeout, concurrency, and rate bounds;
- returns deterministic sanitized errors.

### 2. Hosted allowlist

Begin with a reviewed allowlist of inspection-oriented tools. Hosted exposure must be explicit rather than inheriting every stdio tool automatically.

Candidate first set:

- `nymrel_ucp_audit`
- `nymrel_surety_guard`
- `nymrel_machine_trust`
- `nymrel_proof_verify`
- read-only status/resources needed for discovery

Any tool requiring caller-supplied signing material needs a separate threat review before hosted exposure.

### 3. Authentication and abuse controls

The competition endpoint must document and test:

- authentication model;
- replay/session behavior;
- CORS/origin posture where relevant;
- per-request size and nesting limits;
- rate limiting;
- no logging of secrets/signing material;
- deterministic shutdown/drain behavior.

### 4. Alexa+ demo

Build one end-to-end simulator flow that:

1. invokes the Alexa+ MCP integration;
2. calls a real Nymrel hosted tool;
3. receives a bounded result;
4. turns the result into a useful voice/assistant response;
5. shows at least one safe failure case.

Target demo length: under 3 minutes.

## Optional prize stacking

Only after the core works:

- **Open Source mini-challenge:** this public, licensed competition-period contribution is a natural fit if the final Devpost rules confirm it.
- **AWS Builder mini-challenge:** add a qualifying AWS component only if it improves the product architecture. Do not add AWS services solely to chase a prize.

## Evidence checklist

Before any public claim or submission:

- [ ] exact-head local verification passes;
- [ ] Streamable HTTP integration tests pass;
- [ ] public endpoint is verified from an external client;
- [ ] Alexa+ simulator invocation is captured;
- [ ] hosted tool allowlist is documented;
- [ ] abuse/security tests pass;
- [ ] no secret material appears in logs or fixtures;
- [ ] main README capability boundary is updated only after evidence exists;
- [ ] competition-period commits are clearly identified;
- [ ] demo video and reproducible setup instructions exist.

## External gates

Devpost registration requires profile completion plus explicit user acceptance of the official competition rules, Devpost terms, and eligibility statement. Those are operator gates and are not satisfied by this branch.
