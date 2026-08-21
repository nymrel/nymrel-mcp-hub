/**
 * Swarm Protocol Lease & Lock Claim Tool
 * Claims directory locks and manages two-seat mission states with fencing generations
 * via @nymrel/swarm-protocol
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';

export const swarmClaimToolDefinition: MCPToolDefinition = {
  name: 'nymrel_swarm_claim',
  description: 'Claims directory locks, coordinates distributed agent leases with fencing tokens, and manages two-seat Command Studio mission state.',
  inputSchema: {
    type: 'object',
    properties: {
      repoPath: {
        type: 'string',
        description: 'Absolute or relative repository path to claim exclusive write access on'
      },
      agentId: {
        type: 'string',
        description: 'Unique agent identifier making the claim (e.g. "codex-cli", "claude-code", "cursor")'
      },
      role: {
        type: 'string',
        enum: ['mission_owner', 'studio_controller', 'worker_luna', 'worker_terra', 'researcher'],
        description: 'Two-seat command studio role',
        default: 'mission_owner'
      },
      missionId: {
        type: 'string',
        description: 'Optional mission tracking ID'
      },
      ttlSeconds: {
        type: 'number',
        description: 'Lease duration in seconds before expiration (default 300)',
        default: 300
      },
      action: {
        type: 'string',
        enum: ['claim', 'release', 'renew', 'status'],
        description: 'Lease management action',
        default: 'claim'
      }
    },
    required: ['repoPath', 'agentId']
  }
};

// In-memory active lease registry
const activeLeases = new Map<string, {
  claimId: string;
  repoPath: string;
  agentId: string;
  role: string;
  missionId: string;
  fencingToken: number;
  acquiredAt: number;
  expiresAt: number;
}>();

let globalFencingCounter = 1000;

export async function executeSwarmClaim(args: {
  repoPath: string;
  agentId: string;
  role?: string;
  missionId?: string;
  ttlSeconds?: number;
  action?: 'claim' | 'release' | 'renew' | 'status';
}): Promise<ToolExecutionResult> {
  const normalizedPath = path.resolve(args.repoPath);
  const action = args.action || 'claim';
  const ttl = (args.ttlSeconds || 300) * 1000;
  const now = Date.now();

  const existing = activeLeases.get(normalizedPath);

  if (action === 'status') {
    const isLocked = Boolean(existing && existing.expiresAt > now);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            repoPath: normalizedPath,
            isLocked,
            activeLease: isLocked ? existing : null,
            queriedAt: new Date(now).toISOString()
          }, null, 2)
        }
      ]
    };
  }

  if (action === 'release') {
    if (existing && existing.agentId === args.agentId) {
      activeLeases.delete(normalizedPath);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Lease for ${normalizedPath} successfully released by ${args.agentId}.`,
              releasedClaimId: existing.claimId
            }, null, 2)
          }
        ]
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            message: `No active lease held by ${args.agentId} for ${normalizedPath}.`
          }, null, 2)
        }
      ]
    };
  }

  if (action === 'renew') {
    if (existing && existing.agentId === args.agentId) {
      existing.expiresAt = now + ttl;
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              message: `Lease renewed for ${normalizedPath}.`,
              lease: existing
            }, null, 2)
          }
        ]
      };
    }
  }

  // Action: claim
  if (existing && existing.expiresAt > now && existing.agentId !== args.agentId) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: false,
            error: 'CONFLICT: Resource path is actively locked by another agent.',
            currentHolder: existing.agentId,
            expiresInSeconds: Math.round((existing.expiresAt - now) / 1000),
            fencingToken: existing.fencingToken
          }, null, 2)
        }
      ],
      isError: true
    };
  }

  globalFencingCounter += 1;
  const claimId = `claim-${crypto.randomBytes(4).toString('hex')}`;
  const newLease = {
    claimId,
    repoPath: normalizedPath,
    agentId: args.agentId,
    role: args.role || 'mission_owner',
    missionId: args.missionId || `mission-${Date.now()}`,
    fencingToken: globalFencingCounter,
    acquiredAt: now,
    expiresAt: now + ttl
  };

  activeLeases.set(normalizedPath, newLease);

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          success: true,
          claimId,
          fencingToken: globalFencingCounter,
          role: newLease.role,
          missionId: newLease.missionId,
          repoPath: normalizedPath,
          acquiredAt: new Date(now).toISOString(),
          expiresAt: new Date(now + ttl).toISOString(),
          coordinationStatus: 'EXCLUSIVE_LOCK_ACQUIRED'
        }, null, 2)
      }
    ]
  };
}
