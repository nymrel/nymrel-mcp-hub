# Nymrel MCP Hub

[![Registry status](https://img.shields.io/badge/registry%20publication-unverified-lightgrey.svg?style=flat-square)](#distribution-status)
[![License: MIT](https://img.shields.io/badge/License-MIT-A8541F.svg?style=flat-square)](./LICENSE)
[![MCP Spec](https://img.shields.io/badge/MCP-2026--07--28-2A332E.svg?style=flat-square)](https://modelcontextprotocol.io/specification/2026-07-28)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-success.svg?style=flat-square)](#validation)
[![Engines](https://img.shields.io/badge/engines-TypeScript%20%2B%20Python-FAF8F2.svg?style=flat-square)](#run-from-source)

A dual-engine Model Context Protocol server exposing 14 Nymrel tools, 3 resources, and 3 prompt templates through TypeScript/Node.js and Python stdio entry points.

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
| 5 | `nymrel_proof_ledger` | `nymrel/nymrel-proof-ledger` | Merkle-based execution attestation and proof generation. |
| 6 | `nymrel_crawler_mesh` | `nymrel/nymrel-crawler-mesh` | Web-content extraction and Markdown conversion. |
| 7 | `nymrel_beacon_ping` | `nymrel/agent-beacon` | Agent liveness and heartbeat reporting. |
| 8 | `nymrel_headless_quote` | `nymrel/headless-quote-layer` | Deterministic quote calculation. |
| 9 | `nymrel_local_forge` | `nymrel/local-agent-forge` | Local-model capability inspection and routing support. |
| 10 | `nymrel_open_ucp` | `nymrel/open-ucp` | Commerce-protocol and payment-challenge utilities. |
| 11 | `nymrel_sandstorm` | `nymrel/agent-sandstorm` | Workspace rollback, audit, and outbound-request guardrails. |
| 12 | `nymrel_a2ui_render` | `nymrel/a2ui-warm-paper` | Declarative decision-card rendering. |
| 13 | `nymrel_swarm_bus` | `nymrel/nymrel-swarm-protocol` | Inter-agent message envelopes and dispatch support. |
| 14 | `nymrel_proof_verify` | `nymrel/nymrel-proof-ledger` | Merkle receipt and signature verification. |

## Resources

- `nymrel://status` — server identity, engine status, tool count, and supported protocol revisions.
- `nymrel://ecosystem` — catalog of the Nymrel project references represented by the hub.
- `nymrel://llms-manifest` — machine-readable usage and trust guidance.

## Prompt templates

- `audit-website-ucp` — guided AI commerce readiness audit.
- `secure-agent-command` — command-safety review using Nymrel guardrail tools.
- `init-two-seat-mission` — two-seat Command Studio setup.

## Security boundary

The hub exposes application-level inspection, proof, lease, and credential-pattern tools. These tools do not replace operating-system isolation, network enforcement, independent authorization, credential rotation, or sandboxing. Consumers must apply least privilege and validate tool results at the actual enforcement point.

See [SECURITY.md](./SECURITY.md) for responsible disclosure and supply-chain controls.

## Validation

The repository pins npm `12.0.2` and targets Node.js 22/24 plus Python 3.11-3.14. Both package manifests declare no runtime dependencies.

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
python -m bandit -q -r python/nymrel_mcp_hub
python -m pytest -q
python -m pip uninstall --yes nymrel-mcp-hub
python -m pip_audit --strict
python -m build --outdir dist-py
python -m twine check dist-py/*
```

Local validation proves a source candidate; it does not prove a hosted check or registry publication.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Protocol changes must preserve TypeScript/Python parity and prove both modern and initialize-era behavior. Release or publication work requires a separate operator decision.

## License and organization

- **Brand:** Nymrel
- **Website:** https://nymrel.com
- **Contact:** contact@nymrel.com
- **Legal entity:** JalenBuilds LLC
- **License:** MIT — see [LICENSE](./LICENSE)
