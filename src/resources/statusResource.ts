/**
 * MCP Resource: /nymrel/status
 * Real-time MCP hub telemetry, runtime health, and memory stats
 */

import * as os from 'node:os';
import { MCPResourceDefinition } from '../types/index.js';
import { ALL_MCP_TOOLS } from '../tools/index.js';

export const statusResourceDefinition: MCPResourceDefinition = {
  uri: 'nymrel://status',
  name: 'Nymrel MCP Hub Status',
  mimeType: 'application/json',
  description: 'Live MCP server telemetry, runtime uptime, registered tool count, and memory health.'
};

export function getStatusResourceContent(): string {
  const mem = process.memoryUsage();
  const status = {
    server: '@nymrel/mcp-hub',
    version: '1.0.0',
    protocolVersion: '2024-11-05',
    status: 'HEALTHY_ONLINE',
    registeredToolsCount: ALL_MCP_TOOLS.length,
    registeredTools: ALL_MCP_TOOLS.map(t => t.name),
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      memoryRssMb: +(mem.rss / (1024 * 1024)).toFixed(2),
      memoryHeapUsedMb: +(mem.heapUsed / (1024 * 1024)).toFixed(2),
      cpuCores: os.cpus().length
    },
    organization: {
      brand: 'Nymrel',
      parentEntity: 'JalenBuilds LLC',
      contact: 'contact@jalenbuilds.com'
    },
    timestamp: new Date().toISOString()
  };

  return JSON.stringify(status, null, 2);
}
