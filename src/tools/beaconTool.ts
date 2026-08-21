/**
 * Agent Beacon Liveness Telemetry & Fleet Status Tool
 * Heartbeat monitor and multi-agent fleet presence registry
 * via @nymrel/agent-beacon
 */

import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';

export const beaconToolDefinition: MCPToolDefinition = {
  name: 'nymrel_beacon_ping',
  description: 'Registers agent liveness heartbeat, queries active fleet presence, and monitors multi-agent runtime health to prevent stalled/zombie processes.',
  inputSchema: {
    type: 'object',
    properties: {
      agentId: {
        type: 'string',
        description: 'Unique agent identifier emitting heartbeat'
      },
      role: {
        type: 'string',
        description: 'Agent role or surface name (e.g. "codex-sol", "claude-opus", "cursor-grok")'
      },
      status: {
        type: 'string',
        enum: ['online', 'busy', 'idle', 'offline'],
        description: 'Current agent execution state',
        default: 'online'
      },
      taskSummary: {
        type: 'string',
        description: 'Brief summary of active bounded task slice'
      },
      action: {
        type: 'string',
        enum: ['ping', 'fleet_status'],
        description: 'Whether to emit ping or query entire fleet status',
        default: 'ping'
      }
    },
    required: ['agentId']
  }
};

const fleetRegistry = new Map<string, {
  agentId: string;
  role: string;
  status: string;
  taskSummary: string;
  lastPing: number;
}>();

export async function executeBeacon(args: {
  agentId: string;
  role?: string;
  status?: string;
  taskSummary?: string;
  action?: 'ping' | 'fleet_status';
}): Promise<ToolExecutionResult> {
  const now = Date.now();
  const agentId = args.agentId;
  const role = args.role || 'autonomous_agent';
  const status = args.status || 'online';
  const taskSummary = args.taskSummary || 'Idle / executing in-bounds tasks';
  const action = args.action || 'ping';

  // Update or register agent
  fleetRegistry.set(agentId, {
    agentId,
    role,
    status,
    taskSummary,
    lastPing: now
  });

  // Filter out agents stale > 10 minutes
  const activeFleet: any[] = [];
  fleetRegistry.forEach((entry, id) => {
    const ageSeconds = Math.round((now - entry.lastPing) / 1000);
    if (ageSeconds < 600) {
      activeFleet.push({
        ...entry,
        lastSeenSecondsAgo: ageSeconds,
        healthy: ageSeconds < 120
      });
    } else {
      fleetRegistry.delete(id);
    }
  });

  const response = {
    action,
    queriedAt: new Date(now).toISOString(),
    reportingAgent: {
      agentId,
      role,
      status,
      heartbeatIntervalSeconds: 60
    },
    fleetSummary: {
      totalActiveAgents: activeFleet.length,
      healthyCount: activeFleet.filter(a => a.healthy).length,
      agents: activeFleet
    }
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(response, null, 2)
      }
    ]
  };
}
