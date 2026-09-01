#!/usr/bin/env node
/**
 * @nymrel/mcp-hub - Unified Model Context Protocol Server Entrypoint
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 * MIT License
 */

import { MCPServer } from '../dist/src/server.js';
import { ALL_MCP_TOOLS } from '../dist/src/tools/index.js';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  console.log(`
@nymrel/mcp-hub v1.0.0 - Unified Model Context Protocol (MCP) Server
Exposes 14 Nymrel tools through a zero-runtime-dependency TypeScript engine.

Usage:
  nymrel-mcp [options]

Options:
  --stdio            Run MCP JSON-RPC 2.0 stdio server (default)
  --list-tools       List all 14 registered MCP tools with descriptions
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
  console.log('\n=== @nymrel/mcp-hub: 14 Registered Tools ===\n');
  ALL_MCP_TOOLS.forEach((tool, idx) => {
    console.log(`${idx + 1}. [${tool.name}] - ${tool.description}`);
  });
  console.log('\nTotal tools:', ALL_MCP_TOOLS.length);
  process.exit(0);
}

// Default: Start stdio server
const server = new MCPServer();
server.startStdio();
