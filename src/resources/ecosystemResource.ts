/**
 * MCP Resource: /nymrel/ecosystem
 * Complete directory catalog of all 14 Nymrel open-source projects
 */

import { MCPResourceDefinition } from '../types/index.js';

export const ecosystemResourceDefinition: MCPResourceDefinition = {
  uri: 'nymrel://ecosystem',
  name: 'Nymrel Ecosystem Repository Catalog',
  mimeType: 'application/json',
  description: 'Structured directory metadata of all 14 Nymrel open-source toolchains, repos, npm packages, and capabilities.'
};

export const NYMREL_CATALOG = [
  {
    id: 'swarm-studio',
    name: 'Swarm Studio',
    package: '@nymrel/swarm-studio',
    github: 'https://github.com/nymrel/nymrel-swarm-studio',
    category: 'Agents & Swarms',
    description: 'Visual command deck for multi-agent coding swarms with Warm Paper aesthetics.'
  },
  {
    id: 'open-ucp',
    name: 'OpenUCP',
    package: '@nymrel/open-ucp',
    github: 'https://github.com/nymrel/open-ucp',
    category: 'Commerce & Micropayments',
    description: 'Universal Commerce Protocol (UCP) & Agentic Purchasing Engine with x402 micropayments.'
  },
  {
    id: 'agent-sandstorm',
    name: 'Agent Sandstorm',
    package: '@nymrel/agent-sandstorm',
    github: 'https://github.com/nymrel/agent-sandstorm',
    category: 'Security & Sandboxing',
    description: 'Zero-Trust Agent Execution Sandbox & Copy-on-Write Workspace Isolation Engine.'
  },
  {
    id: 'agentic-ucp-scanner',
    name: 'UCP Scanner',
    package: 'agentic-ucp-scanner',
    github: 'https://github.com/nymrel/agentic-ucp-scanner',
    category: 'Commerce & Micropayments',
    description: 'CLI & audit engine to verify websites for AI Agent Commerce Readiness and JSON-LD trust.'
  },
  {
    id: 'a2ui-warm-paper',
    name: 'A2UI Warm Paper',
    package: 'a2ui-warm-paper',
    github: 'https://github.com/nymrel/a2ui-warm-paper',
    category: 'UI & Machine Trust',
    description: 'Google A2UI declarative JSON specification component system in Nymrel Warm Paper aesthetics.'
  },
  {
    id: 'agent-action-surety',
    name: 'Agent Surety',
    package: '@nymrel/agent-surety',
    github: 'https://github.com/nymrel/agent-action-surety',
    category: 'Security & Sandboxing',
    description: 'Execution firewall, path sandbox, command interceptor, and cryptographic audit ledger.'
  },
  {
    id: 'nymrel-machine-trust',
    name: 'Machine Trust',
    package: '@nymrel/machine-trust',
    github: 'https://github.com/nymrel/nymrel-machine-trust',
    category: 'UI & Machine Trust',
    description: 'Dual-Audience Machine Trust & AI Search Discoverability Engine for modern web applications.'
  },
  {
    id: 'nymrel-proof-ledger',
    name: 'Proof Ledger',
    package: '@nymrel/proof-ledger',
    github: 'https://github.com/nymrel/nymrel-proof-ledger',
    category: 'Security & Sandboxing',
    description: 'Dual-language cryptographic attestation and proof-of-execution protocol library.'
  },
  {
    id: 'local-agent-forge',
    name: 'Local Forge',
    package: '@nymrel/local-forge',
    github: 'https://github.com/nymrel/local-agent-forge',
    category: 'Agents & Swarms',
    description: 'Zero-cloud local GPU orchestrator, dynamic model router, and token savings calculator.'
  },
  {
    id: 'headless-quote-layer',
    name: 'Headless Quote Layer',
    package: '@nymrel/headless-quote',
    github: 'https://github.com/nymrel/headless-quote-layer',
    category: 'Commerce & Micropayments',
    description: 'Visual quote calculator, dynamic range estimator, and lead capture engine.'
  },
  {
    id: 'nymrel-crawler-mesh',
    name: 'Crawler Mesh',
    package: '@nymrel/crawler-mesh',
    github: 'https://github.com/nymrel/nymrel-crawler-mesh',
    category: 'Agents & Swarms',
    description: 'High-throughput clean web crawler & Markdown AST extractor for AI agents.'
  },
  {
    id: 'agent-beacon',
    name: 'Agent Beacon',
    package: '@nymrel/agent-beacon',
    github: 'https://github.com/nymrel/agent-beacon',
    category: 'Agents & Swarms',
    description: 'Liveness telemetry, watchdog heartbeat monitor, and multi-agent fleet presence.'
  },
  {
    id: 'nymrel-swarm-protocol',
    name: 'Swarm Protocol',
    package: '@nymrel/swarm-protocol',
    github: 'https://github.com/nymrel/nymrel-swarm-protocol',
    category: 'Agents & Swarms',
    description: 'Distributed multi-agent lease coordinator with fencing generations and task bus.'
  },
  {
    id: 'nymrel-mcp-hub',
    name: 'Nymrel MCP Hub',
    package: '@nymrel/mcp-hub',
    github: 'https://github.com/nymrel/nymrel-mcp-hub',
    category: 'Agents & Swarms',
    description: 'Unified Model Context Protocol (MCP) server aggregating all 14 Nymrel open-source tools.'
  }
];

export function getEcosystemResourceContent(): string {
  return JSON.stringify({
    ecosystem: 'Nymrel Open-Source Agent Stack',
    totalRepositories: NYMREL_CATALOG.length,
    license: 'MIT 2026',
    designPhilosophy: 'Dual-Audience (Human UX + Machine Trust) & Warm Paper (#FAF8F2, #2A332E, #A8541F)',
    repositories: NYMREL_CATALOG
  }, null, 2);
}
