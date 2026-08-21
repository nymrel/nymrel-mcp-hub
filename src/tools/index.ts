/**
 * Master Registry of all 14 Nymrel Open-Source MCP Tools
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';

import { ucpAuditToolDefinition, executeUcpAudit } from './ucpAuditTool.js';
import { suretyGuardToolDefinition, executeSuretyGuard } from './suretyGuardTool.js';
import { swarmClaimToolDefinition, executeSwarmClaim } from './swarmClaimTool.js';
import { machineTrustToolDefinition, executeMachineTrust } from './machineTrustTool.js';
import { proofLedgerToolDefinition, executeProofLedger } from './proofLedgerTool.js';
import { crawlerToolDefinition, executeCrawler } from './crawlerTool.js';
import { beaconToolDefinition, executeBeacon } from './beaconTool.js';
import { quoteToolDefinition, executeQuote } from './quoteTool.js';
import { localForgeToolDefinition, executeLocalForge } from './localForgeTool.js';
import { openUcpToolDefinition, executeOpenUcp } from './openUcpTool.js';
import { sandstormToolDefinition, executeSandstorm } from './sandstormTool.js';
import { a2uiToolDefinition, executeA2ui } from './a2uiTool.js';
import { swarmBusToolDefinition, executeSwarmBus } from './swarmBusTool.js';
import { proofVerifyToolDefinition, executeProofVerify } from './proofVerifyTool.js';

export {
  ucpAuditToolDefinition, executeUcpAudit,
  suretyGuardToolDefinition, executeSuretyGuard,
  swarmClaimToolDefinition, executeSwarmClaim,
  machineTrustToolDefinition, executeMachineTrust,
  proofLedgerToolDefinition, executeProofLedger,
  crawlerToolDefinition, executeCrawler,
  beaconToolDefinition, executeBeacon,
  quoteToolDefinition, executeQuote,
  localForgeToolDefinition, executeLocalForge,
  openUcpToolDefinition, executeOpenUcp,
  sandstormToolDefinition, executeSandstorm,
  a2uiToolDefinition, executeA2ui,
  swarmBusToolDefinition, executeSwarmBus,
  proofVerifyToolDefinition, executeProofVerify
};

export const ALL_MCP_TOOLS: MCPToolDefinition[] = [
  ucpAuditToolDefinition,
  suretyGuardToolDefinition,
  swarmClaimToolDefinition,
  machineTrustToolDefinition,
  proofLedgerToolDefinition,
  crawlerToolDefinition,
  beaconToolDefinition,
  quoteToolDefinition,
  localForgeToolDefinition,
  openUcpToolDefinition,
  sandstormToolDefinition,
  a2uiToolDefinition,
  swarmBusToolDefinition,
  proofVerifyToolDefinition
];

export async function dispatchToolCall(name: string, args: Record<string, any>): Promise<ToolExecutionResult> {
  switch (name) {
    case 'nymrel_ucp_audit':
    case 'ucp_audit':
      return executeUcpAudit(args as any);

    case 'nymrel_surety_guard':
    case 'surety_guard':
      return executeSuretyGuard(args as any);

    case 'nymrel_swarm_claim':
    case 'swarm_claim':
      return executeSwarmClaim(args as any);

    case 'nymrel_machine_trust':
    case 'machine_trust':
      return executeMachineTrust(args as any);

    case 'nymrel_proof_ledger':
    case 'proof_ledger':
      return executeProofLedger(args as any);

    case 'nymrel_crawler_mesh':
    case 'crawler_mesh':
      return executeCrawler(args as any);

    case 'nymrel_beacon_ping':
    case 'beacon_ping':
      return executeBeacon(args as any);

    case 'nymrel_headless_quote':
    case 'headless_quote':
      return executeQuote(args as any);

    case 'nymrel_local_forge':
    case 'local_forge':
      return executeLocalForge(args as any);

    case 'nymrel_open_ucp':
    case 'open_ucp':
      return executeOpenUcp(args as any);

    case 'nymrel_sandstorm':
    case 'sandstorm':
      return executeSandstorm(args as any);

    case 'nymrel_a2ui_render':
    case 'a2ui_render':
      return executeA2ui(args as any);

    case 'nymrel_swarm_bus':
    case 'swarm_bus':
      return executeSwarmBus(args as any);

    case 'nymrel_proof_verify':
    case 'proof_verify':
      return executeProofVerify(args as any);

    default:
      throw new Error(`Tool "${name}" is not registered in @nymrel/mcp-hub.`);
  }
}
