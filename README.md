# Nymrel MCP Hub

[![Registry status](https://img.shields.io/badge/registry%20publication-unverified-lightgrey.svg?style=flat-square)](#distribution-status)
[![License: MIT](https://img.shields.io/badge/License-MIT-A8541F.svg?style=flat-square)](./LICENSE)
[![MCP Spec](https://img.shields.io/badge/MCP-2026--07--28-2A332E.svg?style=flat-square)](https://modelcontextprotocol.io/specification/2026-07-28)
[![Node runtime dependencies](https://img.shields.io/badge/Node%20runtime%20dependencies-0-success.svg?style=flat-square)](#validation)
[![Engines](https://img.shields.io/badge/engines-TypeScript%20%2B%20Python-FAF8F2.svg?style=flat-square)](#run-from-source)

A dual-engine Model Context Protocol server exposing 15 Nymrel tools, 3 resources, and 3 prompt templates through TypeScript/Node.js and Python stdio entry points.

The repository supports the modern MCP `2026-07-28` request model while retaining initialize-era compatibility through `2025-11-25`. It does not currently claim a hosted transport or verified npm/PyPI publication.

## Distribution status

> [!IMPORTANT]
> **Registry publication is unverified.** As of September 1, 2026, this repository contains npm and Python package manifests and gated release workflows, but it does not contain a registry receipt proving that `@nymrel/mcp-hub` or `nymrel-mcp-hub` is publicly installable.

Until an npm or PyPI receipt is independently verified:

- do not use `npx @nymrel/mcp-hub` as a documented installation path;
- do not use `pip install nymrel-mcp-hub` as a documented installation path;
- run the server from a pinned source checkout using the instructions below;
- treat a local build, GitHub artifact, tag, or workflow result as distinct from registry publication.

Publishing, releasing, tagging, and trusted-publisher configuration are intentionally outside this documentation correction.

## Run from source

### TypeScript / Node.js

Requirements: Node.js 22 or 24 and Corepack.

```bash
git clone https://github.com/nymrel/nymrel-mcp-hub.git
cd nymrel-mcp-hub
corepack npm@12.0.2 ci
corepack npm@12.0.2 run build
node ./bin/mcp-server.js --help
node ./bin/mcp-server.js --stdio
```

Point an MCP client at the built source checkout with an absolute path:

```json
{
  "mcpServers": {
    "nymrel": {
      "command": "node",
      "args": [
        "/absolute/path/to/nymrel-mcp-hub/bin/mcp-server.js",
        "--stdio"
      ]
    }
  }
}
```

The Node entry point imports compiled files from `dist/`, so run the build before starting the server.

### Python

Requirements: Python 3.11 through 3.14.

```bash
git clone https://github.com/nymrel/nymrel-mcp-hub.git
cd nymrel-mcp-hub
python -m venv .venv
# macOS/Linux: source .venv/bin/activate
# Windows PowerShell: .venv\Scripts\Activate.ps1
python -m pip install --editable .
nymrel-mcp --help
nymrel-mcp --stdio
```

For an MCP client, use the absolute path to the virtual environment's `nymrel-mcp` executable. On Windows, that executable is under `.venv\Scripts`; on macOS and Linux, it is under `.venv/bin`.

## Protocol contract

The stdio engines support two MCP behavior families without changing the exposed tool, resource, or prompt catalog.

### Modern requests

- Protocol revision: `2026-07-28`.
- Discovery method: `server/discover`.
- Each modern request carries protocol and client capability metadata in `params._meta`.
- Successful results include `resultType: "complete"` plus server identity metadata.
- Discovery and static list results may include bounded public cache hints.

### Initialize-era compatibility

Supported initialize-era revisions are:

- `2024-10-07`
- `2024-11-05`
- `2025-03-26`
- `2025-06-18`
- `2025-11-25`

Legacy responses remain free of modern-only fields. A modern revision offered through `initialize` receives the preferred legacy counteroffer rather than a false modern handshake.

### Fail-closed behavior

- Unsupported modern revisions return MCP error `-32022` with the supported revision.
- Missing or malformed modern metadata returns `-32602`.
- JSON-RPC notifications remain silent.
- `ping` and `notifications/initialized` remain initialize-era behavior.
- Modern list-change subscriptions are not advertised because this server does not implement `subscriptions/listen`.

## Exposed tools

The hub exposes Nymrel-oriented tools through one MCP surface. Repository names below identify the source project represented by each tool; they are not registry-publication claims.

| # | MCP tool | Source project | Purpose |
|---:|---|---|---|
| 1 | `nymrel_ucp_audit` | `nymrel/agentic-ucp-scanner` | AI commerce readiness and structured-data checks. |
| 2 | `nymrel_surety_guard` | `nymrel/agent-action-surety` | Destructive-command and path-safety inspection. |
| 3 | `nymrel_swarm_claim` | `nymrel/nymrel-swarm-protocol` | Lease coordination and fencing generations. |
| 4 | `nymrel_machine_trust` | `nymrel/nymrel-machine-trust` | Machine-readable organization and trust metadata. |
| 5 | `nymrel_proof_ledger` | `nymrel/nymrel-proof-ledger` | Canonical signed claim receipt generation. |
| 6 | `nymrel_crawler_mesh` | `nymrel/nymrel-crawler-mesh` | Web-content extraction and Markdown conversion. |
| 7 | `nymrel_beacon_ping` | `nymrel/agent-beacon` | Agent liveness and heartbeat reporting. |
| 8 | `nymrel_headless_quote` | `nymrel/headless-quote-layer` | Deterministic quote calculation. |
| 9 | `nymrel_local_forge` | `nymrel/local-agent-forge` | Local-model capability inspection and routing support. |
| 10 | `nymrel_open_ucp` | `nymrel/open-ucp` | Commerce-protocol and payment-challenge utilities. |
| 11 | `nymrel_sandstorm` | `nymrel/agent-sandstorm` | Workspace rollback, audit, and outbound-request guardrails. |
| 12 | `nymrel_a2ui_render` | `nymrel/a2ui-warm-paper` | Declarative decision-card rendering. |
| 13 | `nymrel_swarm_bus` | `nymrel/nymrel-swarm-protocol` | Inter-agent message envelopes and dispatch support. |
| 14 | `nymrel_proof_verify` | `nymrel/nymrel-proof-ledger` | Merkle receipt and signature verification. |
| 15 | `nymrel_web_search` | `nymrel/nymrel-mcp-hub` | Provider-neutral public-web search with configured fallback across Exa, Tavily, Brave Search, and SerpAPI. |

### Web search gateway

`nymrel_web_search` is the discovery layer of the studio web-access stack. API keys are read only from the MCP server environment (`EXA_API_KEY`, `TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`, `SERPAPI_API_KEY`); callers cannot pass credentials as tool arguments. `provider: "auto"` prefers Exa/Tavily-style agent search and falls back across configured providers. `mode: "serp_exact"` prioritizes SerpAPI, while `mode: "research"` asks Tavily for advanced search when routed there. Results are normalized, domain-filtered, and never synthesized when providers fail.

Search does not fetch arbitrary result URLs. Escalate selected URLs to `nymrel_crawler_mesh` for extraction/crawling, and use a separately privileged browser service only when JavaScript execution, login state, forms, or other interaction is genuinely required.

## Resources

- `nymrel://status` — server identity, engine status, tool count, and supported protocol revisions.
- `nymrel://ecosystem` — catalog of the Nymrel project references represented by the hub.
- `nymrel://llms-manifest` — machine-readable usage and trust guidance.

## Prompt templates

- `audit-website-ucp` — guided AI commerce readiness audit.
- `secure-agent-command` — command-safety review using Nymrel guardrail tools.
- `init-two-seat-mission` — two-seat Command Studio setup.

## Proof receipts and authentication

`nymrel_proof_ledger` requires `action`, `agentId`, an object `payload`, and a
caller-supplied `signingKey` and explicit `algorithm: "HMAC-SHA256"` or
`"Ed25519"`. Ed25519 accepts a raw 32-byte hex private key; PEM is not accepted
by these portable adapters. Use a cryptographically random HMAC secret of at
least 32 bytes. The receipt is
canonical `nymrel-proof-ledger` Protocol `2.0.0`, using RFC 8785 JSON and RFC 6962
Merkle hashing. There is no built-in secret or identity registry. MCP clients may
log request arguments, so use a client and transport appropriate for your signing
material. Prefer Ed25519 public keys for verification-only clients.

Call `nymrel_proof_verify` with `receipt`. To authenticate, supply both
`publicKeyOrSecret` and `expectedAlgorithm` (`HMAC-SHA256` or `Ed25519`) from
trusted key configuration. Never derive the expected algorithm from a receipt;
this prevents treating a known public key as an HMAC secret.

| Result | Meaning |
| --- | --- |
| `valid: true, trusted: false` | No key supplied: envelope and Merkle consistency only. Signature, identity, metadata/payload and previous-hash reference are **not authenticated**. |
| `valid: true, trusted: true` | The signature matches the supplied HMAC secret or Ed25519 public key. The caller must obtain that key independently from a trusted source. |
| `valid: false, trusted: false` | Malformed/unsupported input, Merkle mismatch, or signature failure with the supplied key. |

The compatibility field `verified` aliases `trusted`. Verdicts are
`INTEGRITY_ONLY`, `SIGNATURE_AUTHENTICATED`, or `INVALID`; no tool claims a
receipt is universally tamper-free. `agentId` becomes the task runner and signed
signer label, not a verified real-world identity. `payload` and optional
`prevProofHash` are signed metadata; chain continuity and execution are not
checked. Artifact files are never read and Git commands are never executed by
these MCP adapters. Environment fields describe the server runtime only;
`ATTESTED` and the canonical default `exitCode: 0` are claims, not execution evidence.

Missing signatures fail. Old simulated hub receipts and Protocol v1 receipts
are rejected; v1 does not authenticate all v2 identity and metadata fields.
Callers must migrate to canonical v2 receipts and supply their own signing key.
Unknown tool arguments fail instead of being silently ignored. Extra envelope
fields follow the upstream forward-compatibility contract and may be outside
the signature; do not use unrecognized fields as authenticated claims.

The canonical core is vendored verbatim at a pinned commit, because it is not
available as a published dependency. See [source and license provenance](./THIRD_PARTY_NOTICES.md).
Its verification API also binds the independently configured key algorithm.
Git collection is off by default upstream and explicitly disabled by these adapters.
Both language suites run the same adversarial fixtures; after building Node and
installing Python, run `python tests/proof_cross_runtime.py` for schema equality
and bidirectional HMAC/Ed25519 receipt verification.

Inputs are limited to 64 nested levels, 10,000 values, and 1 MiB of canonical
JSON. Numbers must be finite and within JavaScript's safe integer magnitude
(`±9007199254740991`); strings must contain valid Unicode scalar values. These
limits keep the two runtimes interoperable. Proofs have no freshness/replay gate.

## Security boundary

The hub exposes application-level inspection, proof, lease, and credential-pattern tools. These tools do not replace operating-system isolation, network enforcement, independent authorization, credential rotation, or sandboxing. Consumers must apply least privilege and validate tool results at the actual enforcement point.

See [SECURITY.md](./SECURITY.md) for responsible disclosure and supply-chain controls.

## Validation

The repository pins npm `12.0.2` and targets Node.js 22/24 plus Python 3.11-3.14. The Node package has no runtime dependencies. Python uses `cryptography>=50.0.1,<51` for Ed25519 and `rfc8785==0.1.4` for canonical JSON, matching the pinned Proof Ledger implementation.

### Node.js

```bash
corepack npm@12.0.2 ci
corepack npm@12.0.2 run verify
corepack npm@12.0.2 audit --audit-level=high
corepack npm@12.0.2 audit --omit=dev --audit-level=high
corepack npm@12.0.2 install-scripts ls
```

The verification contract covers toolchain pins, TypeScript compilation, protocol tests, CI-policy tests, and the npm package allowlist.

### Python

```bash
python -m pip install --requirement requirements-dev.txt
python -m pip install --editable .
python -m pip check
python -m ruff check python tests
python scripts/check-bandit.py
python -m pytest -q
python -m pip uninstall --yes nymrel-mcp-hub
python -m pip_audit --strict
python -m build --outdir dist-py
python -m twine check dist-py/*
```

The Bandit gate scans all runtime sources and recognizes only nine exact reviewed low-severity findings for fixed-argument Git context collection in the pinned vendor source. Changed or additional findings fail; see `docs/proof-ledger/bandit-reviewed.json`.

Local validation proves a source candidate; it does not prove a hosted check or registry publication.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Protocol changes must preserve TypeScript/Python parity and prove both modern and initialize-era behavior. Release or publication work requires a separate operator decision.

## License and organization

- **Brand:** Nymrel
- **Website:** https://nymrel.com
- **Contact:** contact@nymrel.com
- **Legal entity:** JalenBuilds LLC
- **License:** MIT — see [LICENSE](./LICENSE)
