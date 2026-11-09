#!/usr/bin/env node
/**
 * @nymrel/mcp-hub - Unified Model Context Protocol Server Entrypoint
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 * MIT License
 */

import { MCPServer } from '../dist/src/server.js';
import { ALL_MCP_TOOLS } from '../dist/src/tools/index.js';
import { ALL_MCP_RESOURCES } from '../dist/src/resources/index.js';
import { ALL_MCP_PROMPTS } from '../dist/src/prompts/index.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
@nymrel/mcp-hub v1.0.0 - Unified Model Context Protocol (MCP) Server
Exposes ${ALL_MCP_TOOLS.length} Nymrel tools through the TypeScript engine.

Usage:
  nymrel-mcp [options]

Options:
  --stdio            Run MCP JSON-RPC 2.0 stdio server (default)
  --list-tools       List all ${ALL_MCP_TOOLS.length} registered MCP tools with descriptions
  --list-resources   List all registered MCP resources
  --list-prompts     List all registered MCP prompt templates
  --version, -v      Print version
  --help, -h         Show this help message

Source-checkout quickstart:
  corepack npm@12.0.2 ci
  corepack npm@12.0.2 run build
  node ./bin/mcp-server.js --stdio

Registry publication is not asserted by this source checkout. See README.md for the
current distribution status and MCP-client configuration using an absolute local path.
`);
  process.exit(0);
}

if (args.includes('--version') || args.includes('-v')) {
  console.log('@nymrel/mcp-hub v1.0.0');
  process.exit(0);
}

if (args.includes('--list-tools')) {
  console.log(`\n=== @nymrel/mcp-hub: ${ALL_MCP_TOOLS.length} Registered Tools ===\n`);
  ALL_MCP_TOOLS.forEach((tool, idx) => {
    console.log(`${idx + 1}. [${tool.name}] - ${tool.description}`);
  });
  console.log('\nTotal tools:', ALL_MCP_TOOLS.length);
  process.exit(0);
}

if (args.includes('--list-resources')) {
  for (const resource of ALL_MCP_RESOURCES) {
    console.log(`[${resource.uri}] ${resource.name} - ${resource.description}`);
  }
  process.exit(0);
}

if (args.includes('--list-prompts')) {
  for (const prompt of ALL_MCP_PROMPTS) {
    console.log(`[${prompt.name}] - ${prompt.description}`);
  }
  process.exit(0);
}

// Default: Start stdio server
const server = new MCPServer();
server.startStdio();
