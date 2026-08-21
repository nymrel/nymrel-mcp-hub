# @nymrel/mcp-hub

[![npm version](https://img.shields.io/npm/v/@nymrel/mcp-hub.svg?style=flat-square&color=2A332E)](https://www.npmjs.com/package/@nymrel/mcp-hub)
[![License: MIT](https://img.shields.io/badge/License-MIT-A8541F.svg?style=flat-square)](https://opensource.org/licenses/MIT)
[![MCP Spec](https://img.shields.io/badge/MCP_Spec-2024--11--05-2A332E.svg?style=flat-square)](https://modelcontextprotocol.io/)
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
  |  - nymrel_crawler_mesh                   - Node.js 18+ (Pure TypeScript ESM)                      |
  |  - nymrel_beacon_ping                    - Python 3.10+ (Zero-dependency Package)                 |
  |  - nymrel_headless_quote                                                                          |
  |  - nymrel_local_forge                    [ PROTOCOL COMPLIANCE ]                                  |
  |  - nymrel_open_ucp                       - Specification Version 2024-11-05                       |
  |  - nymrel_sandstorm                      - RFC-6962 Merkle Tree Hashing                           |
  |  - nymrel_a2ui_render                    - RFC-x402 Micropayment Headers                          |
  |  - nymrel_swarm_bus                      - Google A2UI v0.8 Specification                         |
  |  - nymrel_proof_verify                   - Schema.org JSON-LD Hierarchy                           |
  +---------------------------------------------------------------------------------------------------+
```

---

## ⚡ 1-Line Installation Recipes

### 1. Claude Desktop
Add `@nymrel/mcp-hub` to your `claude_desktop_config.json` file:

**macOS / Linux:** `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "nymrel": {
      "command": "npx",
      "args": ["@nymrel/mcp-hub"]
    }
  }
}
```

---

### 2. Cursor (Composer & Agent Mode)
Create or update `.cursor/mcp.json` in your workspace root:

```json
{
  "mcpServers": {
    "nymrel-hub": {
      "command": "npx",
      "args": ["@nymrel/mcp-hub"]
    }
  }
}
```

---

### 3. Codex CLI & Native Workers
Add to your Codex MCP configuration file:

```json
{
  "mcpServers": {
    "nymrel": {
      "command": "npx",
      "args": ["@nymrel/mcp-hub"],
      "env": {}
    }
  }
}
```

---

### 4. Python Engine (Pip)
```bash
pip install nymrel-mcp-hub
nymrel-mcp --stdio
```

---

## 🧰 The 14 Aggregated Nymrel Tools

| # | MCP Tool Name | Origin Repo | Category | Description |
|---|---|---|---|---|
| 1 | `nymrel_ucp_audit` | `@nymrel/agentic-ucp-scanner` | Commerce | 7-layer AI Commerce Readiness scorecard, JSON-LD verifier, and /llms.txt compliance grader. |
| 2 | `nymrel_surety_guard` | `@nymrel/agent-surety` | Security | Pre-execution safety firewall intercepting destructive shell commands (`rm -rf`, `DROP`, `format`). |
| 3 | `nymrel_swarm_claim` | `@nymrel/swarm-protocol` | Swarms | Distributed directory lock and multi-agent lease coordinator with monotonically increasing fencing tokens. |
| 4 | `nymrel_machine_trust` | `@nymrel/machine-trust` | Trust | Dual-Audience engine generating Schema.org JSON-LD (`Nymrel -> JalenBuilds LLC`), `/llms.txt`, and robots.txt. |
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
- **For Autonomous Machines:** Cryptographically verifiable machine trust, RFC-6962 Merkle proofs, RFC-x402 payment headers, and hierarchical Schema.org JSON-LD entity graphs (`parentOrganization: Nymrel -> JalenBuilds LLC`).

---

## 🧪 Validation & Test Suite

```bash
# 1. Typecheck TypeScript
npm run typecheck

# 2. Build TypeScript distribution
npm run build

# 3. Run Node.js native test runner
npm test

# 4. Run Python pytest test suite
pytest
```

---

## 📄 License & Organization

- **Brand:** Nymrel
- **Parent Entity:** JalenBuilds LLC
- **Contact:** `contact@jalenbuilds.com`
- **License:** MIT License (2026)
