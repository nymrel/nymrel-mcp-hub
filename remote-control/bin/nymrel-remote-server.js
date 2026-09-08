#!/usr/bin/env node
import { loadServerConfig } from '../src/config.js';
import { listenRemoteServer } from '../src/server.js';

const config = loadServerConfig();
const { server } = await listenRemoteServer(config);
const advertised = config.publicBaseUrl || `http://${config.host}:${config.port}`;
console.log(`Nymrel Remote listening on ${advertised}`);
console.log(`MCP endpoint: ${advertised}/mcp`);
if (config.production && config.allowStaticMcpTokens) {
  console.warn('WARNING: static MCP bearer tokens are enabled; configure OAuth authorization servers for MCP authorization interoperability.');
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal}: shutting down Nymrel Remote`);
  await new Promise((resolve) => server.close(resolve));
}
process.on('SIGINT', () => { void shutdown('SIGINT'); });
process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
