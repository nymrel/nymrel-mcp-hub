/**
 * MCP Resource: /nymrel/llms-manifest
 * Clean, structured /llms.txt ecosystem context manifest
 */

import { MCPResourceDefinition } from '../types/index.js';

export const llmsManifestResourceDefinition: MCPResourceDefinition = {
  uri: 'nymrel://llms-manifest',
  name: 'Nymrel LLMs Manifest',
  mimeType: 'text/markdown',
  description: 'Clean semantic /llms.txt guide for autonomous LLMs and AI agent context loaders.'
};

export function getLlmsManifestResourceContent(): string {
  return `# Nymrel Open-Source Agent Ecosystem
> Unified tools, protocols, security sandboxes, and machine trust engines for autonomous AI agents.

## Core MCP Hub Architecture
- Package: \`@nymrel/mcp-hub\`
- Protocol: Model Context Protocol (MCP) JSON-RPC 2.0
- Runtime: Zero-dependency Node.js 22/24 & Python 3.11-3.14 dual-engine
- Organization: Nymrel (contact@nymrel.com)
- Legal entity: JalenBuilds LLC
- License: MIT 2026

## 14 Registered Tools
1. \`nymrel_ucp_audit\` - 7-layer AI Commerce Readiness & JSON-LD audit.
2. \`nymrel_surety_guard\` - Pre-execution safety firewall intercepting destructive commands.
3. \`nymrel_swarm_claim\` - Distributed directory lock & lease coordinator with fencing generations.
4. \`nymrel_machine_trust\` - Schema.org JSON-LD parentOrganization graph & /llms.txt generator.
5. \`nymrel_proof_ledger\` - RFC-6962 SHA-256 Merkle tree execution attestations & receipts.
6. \`nymrel_crawler_mesh\` - Clean Markdown AST extractor optimized for LLM token savings.
7. \`nymrel_beacon_ping\` - Liveness telemetry & multi-agent fleet heartbeat registry.
8. \`nymrel_headless_quote\` - Dynamic pricing formula calculator with Warm Paper tokens.
9. \`nymrel_local_forge\` - Local GPU / Ollama orchestrator & 3-tier model router.
10. \`nymrel_open_ucp\` - Universal Commerce Protocol x402 micropayments & AP2 cart negotiation.
11. \`nymrel_sandstorm\` - Zero-trust Copy-on-Write workspace isolation & secret token firewall.
12. \`nymrel_a2ui_render\` - Google A2UI v0.8 declarative JSON decision cards in Warm Paper tokens.
13. \`nymrel_swarm_bus\` - Multi-agent task bus message queuing & envelope dispatcher.
14. \`nymrel_proof_verify\` - Cryptographic Merkle receipt & digital signature validator.

## Resources Exposed
- \`nymrel://status\` - Live MCP server telemetry and uptime.
- \`nymrel://ecosystem\` - Full directory catalog of all 14 Nymrel repositories.
- \`nymrel://llms-manifest\` - This semantic /llms.txt document.

## Pre-Built Agent Prompts
- \`audit-website-ucp\` - Guided AI commerce readiness scorecard evaluation.
- \`secure-agent-command\` - Surety & Sandstorm pre-execution safety interceptor.
- \`init-two-seat-mission\` - Two-seat Command Studio orchestration setup.
`;
}
