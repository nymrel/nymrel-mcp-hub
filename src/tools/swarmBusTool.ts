/**
 * Swarm Protocol Inter-Agent Task Bus Dispatcher
 * Studio task bus message queuing, envelope dispatch, and broadcasting
 * via @nymrel/swarm-protocol
 */

import * as crypto from 'node:crypto';
import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';

export const swarmBusToolDefinition: MCPToolDefinition = {
  name: 'nymrel_swarm_bus',
  description: 'Dispatches structured message envelopes across the multi-agent studio task bus for inter-agent coordination (handoffs, reviews, broadcasts).',
  inputSchema: {
    type: 'object',
    properties: {
      fromAgent: {
        type: 'string',
        description: 'Sender agent ID (e.g. "codex-sol", "cursor-grok", "claude-opus")'
      },
      toAgent: {
        type: 'string',
        description: 'Target recipient agent ID or "*" for studio-wide broadcast'
      },
      topic: {
        type: 'string',
        description: 'Communication topic / lane subject'
      },
      messageType: {
        type: 'string',
        enum: ['handoff', 'review_request', 'decision_broadcast', 'heartbeat', 'telemetry'],
        description: 'Type of bus message envelope',
        default: 'handoff'
      },
      payload: {
        type: 'object',
        description: 'Structured data payload to dispatch'
      }
    },
    required: ['fromAgent', 'toAgent', 'topic', 'payload']
  }
};

const busMessageLog: any[] = [];

export async function executeSwarmBus(args: {
  fromAgent: string;
  toAgent: string;
  topic: string;
  messageType?: string;
  payload: any;
}): Promise<ToolExecutionResult> {
  const envelopeId = `env-${crypto.randomBytes(4).toString('hex')}`;
  const timestamp = new Date().toISOString();

  const envelope = {
    envelopeId,
    timestamp,
    protocol: 'Nymrel-Swarm-Bus/v1.0',
    header: {
      from: args.fromAgent,
      to: args.toAgent,
      topic: args.topic,
      messageType: args.messageType || 'handoff'
    },
    payload: args.payload,
    merkleFingerprint: crypto.createHash('sha256').update(`${envelopeId}:${timestamp}`).digest('hex')
  };

  busMessageLog.push(envelope);

  const result = {
    dispatched: true,
    envelopeId,
    deliveredTo: args.toAgent === '*' ? 'STUDIO_BROADCAST_ALL' : args.toAgent,
    timestamp,
    queuedMessagesCount: busMessageLog.length,
    envelope
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
}
