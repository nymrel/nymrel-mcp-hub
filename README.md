# @nymrel/mcp-hub

[![Distribution: source checkout](https://img.shields.io/badge/Distribution-source_checkout-A8541F.svg?style=flat-square)](https://github.com/nymrel/nymrel-mcp-hub)
[![License: MIT](https://img.shields.io/badge/License-MIT-A8541F.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![MCP Spec](https://img.shields.io/badge/MCP_Spec-2026--07--28-2A332E.svg?style=flat-square)](https://modelcontextprotocol.io/specification/2026-07-28)
[![Zero Dependency](https://img.shields.io/badge/Dependencies-Zero-success.svg?style=flat-square)](https://github.com/nymrel/nymrel-mcp-hub)
[![Dual Engine](https://img.shields.io/badge/Engine-TypeScript_%2B_Python-FAF8F2.svg?style=flat-square)](https://github.com/nymrel/nymrel-mcp-hub)

> **The Premier Unified Model Context Protocol (MCP) Server for Autonomous AI Agents.**  
> Aggregates all 14 Nymrel open-source developer toolchains, execution sandboxes, cryptographic ledgers, and machine-trust engines into a single, zero-dependency MCP server for **Claude Desktop**, **Claude Code**, **Cursor**, **Codex**, and **OpenAI** agents.

---

## 🏛️ System Architecture

```
                                  +---------------------------------------+
                                  |   AI Agent Execution Surface          |
                                  |  (Claude Code / Cursor / Codex / GPT) |
                                  +-------------------+-------------------+
                                                      |
                                                      | MCP JSON-RPC 2.0 (stdio)
                                                      v
  +---------------------------------------------------------------------------------------------------+
  |                                       @nymrel/mcp-hub                                             |
  |                            Unified Model Context Protocol Server                                 |
  +---------------------------------------------------------------------------------------------------+
  |                                                                                                   |
  |  [ TOOLS (14) ]                          [ RESOURCES (3) ]             [ PROMPTS (3) ]            |
  |  - nymrel_ucp_audit                      - nymrel://status             - audit-website-ucp        |
  |  - nymrel_surety_guard                   - nymrel://ecosystem          - secure-agent-command     |
  |  - nymrel_swarm_claim                    - nymrel://llms-manifest      - init-two-seat-mission    |
  |  - nymrel_machine_trust                                                                           |
  |  - nymrel_proof_ledger                   [ DUAL-ENGINE CORE ]                                     |
  |  - nymrel_crawler_mesh                   - Node.js 22/24 (Pure TypeScript ESM)                    |
  |  - nymrel_beacon_ping                    - Python 3.11-3.14 (Zero-dependency Package)             |
  |  - nymrel_headless_quote                                                                          |
  |  - nymrel_local_forge                    [ PROTOCOL COMPLIANCE ]                                  |
  |  - nymrel_open_ucp                       - MCP 2026-07-28 + initialize-era compatibility         |
  |  - nymrel_sandstorm                      - RFC-6962 Merkle Tree Hashing                           |
  |  - nymrel_a2ui_render                    - RFC-x402 Micropayment Headers                          |
  |  - nymrel_swarm_bus                      - Google A2UI v0.8 Specification                         |
  |  - nymrel_proof_verify                   - Schema.org JSON-LD Hierarchy                           |
  +---------------------------------------------------------------------------------------------------+
```

---

## 🔌 Dual-Era Protocol Contract

The stdio server supports both MCP behavior families without changing the tool, resource, or prompt catalog:

- **Modern (`2026-07-28`)** — `server/discover` advertises the supported modern revision and capabilities. Every modern request carries the protocol revision and client capabilities in `params._meta`; successful results carry `resultType: "complete"` and the server identity in result `_meta`. Static list/discovery results include public TTL hints.
- **Legacy (`2024-10-07` through `2025-11-25`)** — `initialize` negotiates only initialize-era revisions and keeps modern-only fields out of legacy results. A modern version offered through `initialize` receives the preferred legacy counter-offer rather than a false modern handshake.
- **Fail-closed boundaries** — unsupported modern revisions return MCP error `-32022` with the supported revision. Missing or malformed modern metadata returns `-32602`. `ping` and `notifications/initialized` remain legacy-only; modern list-change subscriptions are not advertised because this server does not implement `subscriptions/listen`.

This repository currently ships stdio entry points. It does not claim a Streamable HTTP endpoint, registry publication, or hosted transport receipt.

---

## 📦 Registry Status and Source Installation

No npm or PyPI release is currently verified. Package metadata and a release workflow exist in this repository, but neither is a registry publication receipt.

| Distribution | Public registry status | Supported path today |
|---|---|---|
| npm `@nymrel/mcp-hub` | Not published | Node.js source checkout |
| PyPI `nymrel-mcp-hub` | Not published | Python source checkout |

Do not use registry-based `npx` or `pip install` recipes until the corresponding public registry page shows a verified release.

### Node.js source checkout

```bash
git clone https://github.com/nymrel/nymrel-mcp-hub.git
cd nymrel-mcp-hub
corepack npm@12.0.2 ci
corepack npm@12.0.2 run build
node ./bin/mcp-server.js --stdio
```

Configure Claude Desktop, Cursor, Codex, or another stdio MCP client with the absolute path to the built checkout:

```json
{
  "mcpServers": {
    "nymrel": {
      "command": "node",
      "args": ["/absolute/path/to/nymrel-mcp-hub/bin/mcp-server.js", "--stdio"]
    }
  }
}
```

### Python source checkout

From the same cloned repository:

```bash
python -m venv .venv
./.venv/bin/python -m pip install --editable .
./.venv/bin/nymrel-mcp --stdio
```

On Windows, use `.venv\Scripts\python.exe` and `.venv\Scripts\nymrel-mcp.exe` instead.

---

## 🧰 The 14 Aggregated Nymrel Tools

| # | MCP Tool Name | Origin Repo | Category | Description |
|---|---|---|---|---|
| 1 | `nymrel_ucp_audit` | `@nymrel/agentic-ucp-scanner` | Commerce | 7-layer AI Commerce Readiness scorecard, JSON-LD verifier, and /llms.txt compliance grader. |
| 2 | `nymrel_surety_guard` | `@nymrel/agent-surety` | Security | Pre-execution safety firewall intercepting destructive shell commands (`rm -rf`, `DROP`, `format`). |
| 3 | `nymrel_swarm_claim` | `@nymrel/swarm-protocol` | Swarms | Distributed directory lock and multi-agent lease coordinator with monotonically increasing fencing tokens. |
| 4 | `nymrel_machine_trust` | `@nymrel/machine-trust` | Trust | Dual-Audience engine generating Schema.org JSON-LD organization graphs, `/llms.txt`, and robots.txt. |
| 5 | `nymrel_proof_ledger` | `@nymrel/proof-ledger` | Security | Attests agent execution with RFC-6962 SHA-256 binary Merkle trees and digital signature receipts. |
| 6 | `nymrel_crawler_mesh` | `@nymrel/crawler-mesh` | Data | High-throughput clean web crawler & Markdown AST extractor optimized for LLM token savings. |
| 7 | `nymrel_beacon_ping` | `@nymrel/agent-beacon` | Telemetry | Agent liveness heartbeat emitter and active multi-agent fleet presence monitor. |
| 8 | `nymrel_headless_quote` | `@nymrel/headless-quote` | Commerce | Instant dynamic pricing formula calculator with Nymrel Warm Paper presets. |
| 9 | `nymrel_local_forge` | `@nymrel/local-forge` | Models | Probes local GPU/Ollama status, calculates token dollar savings, and routes tasks across Luna/Terra/Sol tiers. |
| 10 | `nymrel_open_ucp` | `@nymrel/open-ucp` | Commerce | Universal Commerce Protocol x402 HTTP micropayment challenge handler and AP2 cart negotiation. |
| 11 | `nymrel_sandstorm` | `@nymrel/agent-sandstorm` | Security | Zero-Trust Copy-on-Write workspace isolation and secret exfiltration token masking firewall. |
| 12 | `nymrel_a2ui_render` | `a2ui-warm-paper` | UI | Google A2UI v0.8 declarative JSON decision cards in signature Warm Paper tokens (`#FAF8F2`, `#2A332E`). |
| 13 | `nymrel_swarm_bus` | `@nymrel/swarm-protocol` | Swarms | Studio task bus message queuing, envelope dispatch, and inter-agent coordination broadcasting. |
| 14 | `nymrel_proof_verify` | `@nymrel/proof-ledger` | Security | Cryptographically validates RFC-6962 Merkle receipts and digital signatures against tampering. |

---

## 📡 Live MCP Resources

The MCP server exposes live, dynamic resources accessible via the `resources/read` protocol:

1. **`nymrel://status` (`application/json`)**  
   Real-time MCP server telemetry, node/python runtime version, memory RSS footprint, and registered tool counts.
2. **`nymrel://ecosystem` (`application/json`)**  
   Complete directory catalog of all 14 Nymrel repositories, npm packages, GitHub URLs, categories, and descriptions.
3. **`nymrel://llms-manifest` (`text/markdown`)**  
   Curated `/llms.txt` semantic manifest guiding autonomous AI agents on how to leverage the Nymrel toolchain.

---

## 📝 Pre-Built MCP Prompts

1. **`audit-website-ucp`**  
   Prompts the agent to perform a comprehensive 7-layer AI Commerce Readiness audit on a target URL and produce an actionable fix list.
2. **`secure-agent-command`**  
   Evaluates a proposed terminal command with Surety Guard and Sandstorm secret masking before running it.
3. **`init-two-seat-mission`**  
   Guides the agent to configure a two-seat Command Studio mission (`mission_owner` + `studio_controller`) with lease coordination and bus dispatch.

---

## 🎨 Dual-Audience Philosophy & Aesthetics

Every tool within `@nymrel/mcp-hub` is engineered under the **Dual-Audience Contract**:
- **For Human Visitors:** Elegant, accessible UI styled in warm, lighter tones (**Warm Paper** `#FAF8F2`, cedar green `#2A332E`, terracotta `#A8541F`).
- **For Autonomous Machines:** Cryptographically verifiable machine trust, RFC-6962 Merkle proofs, RFC-x402 payment headers, and hierarchical Schema.org JSON-LD organization graphs.

---

## 🧪 Validation & Test Suite

The repository pins npm 12.0.2 and validates Node.js 22/24 plus Python 3.11-3.14 on Ubuntu and Windows. Use the same fail-closed gates locally:

```bash
# Node: locked install, protocol tests, CI contracts, and dependency audits
corepack npm@12.0.2 ci
corepack npm@12.0.2 run verify
corepack npm@12.0.2 audit --audit-level=high
corepack npm@12.0.2 audit --omit=dev --audit-level=high
corepack npm@12.0.2 install-scripts ls

# Python: reviewed tooling, package install, lint, security scan, and tests
python -m pip install --requirement requirements-dev.txt
python -m pip install --editable .
python -m pip check
python -m ruff check python tests
python -m bandit -q -r python/nymrel_mcp_hub
python -m pytest -q
python -m pip uninstall --yes nymrel-mcp-hub
python -m pip_audit --strict

# Build Python artifacts separately from the TypeScript distribution
python -m build --outdir dist-py
python -m twine check dist-py/*
```

The npm package allowlist ships only compiled runtime modules, the executable wrapper, and public documentation; compiled tests are excluded. Python wheels likewise exclude repository tests.

Matching `v<package-version>` tags invoke a separate tag-only release workflow. npm and PyPI jobs consume already-validated artifacts and request short-lived OIDC credentials only inside dedicated `npm` and `pypi` environments. Registry trusted-publisher relationships and those protected environments remain operator-controlled external gates; a local build or GitHub artifact is not proof of registry publication.

---

## 📄 License & Organization

- **Organization:** Nymrel
- **Contact:** `contact@nymrel.com`
- **License:** MIT License (2026)
