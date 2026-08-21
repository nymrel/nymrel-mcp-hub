/**
 * Pre-Built MCP Agent Prompt Templates
 * Standardized workflow prompts for Claude Code, Cursor, Codex, and OpenAI agents
 */

import { MCPPromptDefinition, MCPPromptMessage } from '../types/index.js';

export const auditWebsiteUcpPrompt: MCPPromptDefinition = {
  name: 'audit-website-ucp',
  description: 'Audits a target website URL for AI Agent Commerce Readiness across 7 structural layers and generates an actionable remediation plan.',
  arguments: [
    {
      name: 'targetUrl',
      description: 'The target website URL to audit (e.g. "https://nymrel.com")',
      required: true
    },
    {
      name: 'focusArea',
      description: 'Specific layer focus (e.g. "json-ld", "x402-payments", "all")',
      required: false
    }
  ]
};

export const secureAgentCommandPrompt: MCPPromptDefinition = {
  name: 'secure-agent-command',
  description: 'Evaluates and sanitizes a proposed shell command through Surety Guard and Sandstorm secret masking before execution.',
  arguments: [
    {
      name: 'command',
      description: 'The exact bash/powershell command string to verify',
      required: true
    },
    {
      name: 'worktreePath',
      description: 'The local repository or directory boundary path',
      required: false
    }
  ]
};

export const initTwoSeatMissionPrompt: MCPPromptDefinition = {
  name: 'init-two-seat-mission',
  description: 'Sets up a two-seat Command Studio mission with designated Mission Owner, Studio Controller, lease claim, and task bus routing.',
  arguments: [
    {
      name: 'missionGoal',
      description: 'Clear description of the mission objective, done-when criteria, and validation floor',
      required: true
    },
    {
      name: 'targetRepoPath',
      description: 'Absolute path to target repo worktree',
      required: true
    },
    {
      name: 'ownerAgentId',
      description: 'Agent surface acting as Mission Owner (default: "codex-sol")',
      required: false
    }
  ]
};

export function renderPrompt(name: string, args: Record<string, string>): { description: string; messages: MCPPromptMessage[] } {
  switch (name) {
    case 'audit-website-ucp': {
      const url = args.targetUrl || 'https://nymrel.com';
      const focus = args.focusArea || 'all';
      return {
        description: auditWebsiteUcpPrompt.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please perform a comprehensive 7-layer AI Agent Commerce Readiness audit for ${url} (Focus: ${focus}).

Instructions:
1. Invoke tool "nymrel_ucp_audit" with url: "${url}".
2. Check for Schema.org JSON-LD parentOrganization entity graph (Nymrel -> JalenBuilds LLC).
3. Verify crawler permissions for OAI-SearchBot, ClaudeBot, and GPTBot.
4. Assess x402 payment header support and /llms.txt clarity.
5. Provide a prioritized markdown checklist of recommendations.`
            }
          }
        ]
      };
    }

    case 'secure-agent-command': {
      const cmd = args.command || 'echo "hello"';
      const path = args.worktreePath || process.cwd();
      return {
        description: secureAgentCommandPrompt.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please verify the safety of this proposed terminal command before executing:
Command: \`${cmd}\`
Working Directory: \`${path}\`

Instructions:
1. Call "nymrel_surety_guard" with command: \`${cmd}\` and workingDirectory: \`${path}\`.
2. Call "nymrel_sandstorm" with content: \`${cmd}\` to ensure zero exposed API keys or tokens.
3. If verdict is ALLOW, execute the command and generate an RFC-6962 proof via "nymrel_proof_ledger".
4. If verdict is BLOCK, halt immediately and explain the safety violation.`
            }
          }
        ]
      };
    }

    case 'init-two-seat-mission': {
      const goal = args.missionGoal || 'Implement feature slice with full test coverage';
      const repo = args.targetRepoPath || process.cwd();
      const owner = args.ownerAgentId || 'codex-sol';
      return {
        description: initTwoSeatMissionPrompt.description,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Initialize two-seat Command Studio session for mission: "${goal}".
Target Repo: \`${repo}\`
Designated Mission Owner: \`${owner}\`

Instructions:
1. Call "nymrel_swarm_claim" with repoPath: "${repo}", agentId: "${owner}", role: "mission_owner".
2. Emit an initial heartbeat via "nymrel_beacon_ping".
3. Dispatch a kickoff envelope via "nymrel_swarm_bus" to announce lane ownership.
4. Render an A2UI human-in-the-loop kickoff card via "nymrel_a2ui_render".`
            }
          }
        ]
      };
    }

    default:
      throw new Error(`Prompt template "${name}" not recognized in @nymrel/mcp-hub.`);
  }
}
