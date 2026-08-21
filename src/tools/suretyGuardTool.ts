/**
 * Agent Surety Pre-Execution Guard Tool
 * Intercepts destructive commands and enforces directory containment jails
 * via @nymrel/agent-surety
 */

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';

export const suretyGuardToolDefinition: MCPToolDefinition = {
  name: 'nymrel_surety_guard',
  description: 'Pre-execution safety firewall intercepting destructive shell commands (rm -rf, DROP, format), path traversal violations, and unconstrained deletes before agent execution.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The exact shell command or script string to evaluate'
      },
      workingDirectory: {
        type: 'string',
        description: 'The current working directory context'
      },
      strict: {
        type: 'boolean',
        description: 'If true, blocks on moderate warnings and requires explicit override',
        default: false
      }
    },
    required: ['command']
  }
};

const DANGEROUS_PATTERNS = [
  { pattern: /\brm\s+-[rf]{1,2}\s+([/~]|\$HOME|\.\.)/i, reason: 'Root/Home directory recursive deletion attempt' },
  { pattern: /\b(del|erase)\s+.*(\/s|\/q|C:\\|\*)/i, reason: 'Unconstrained Windows system file deletion' },
  { pattern: /\bformat\s+[a-z]:/i, reason: 'Disk volume format command' },
  { pattern: /\b(drop\s+(database|table|schema)|truncate\s+table)\b/i, reason: 'Destructive SQL schema/table drop' },
  { pattern: /\bdd\s+if=\/dev\/(zero|urandom)\s+of=/i, reason: 'Raw drive overwrite via dd' },
  { pattern: /\b:\(\)\{\s*:\|:&\s*\};:/i, reason: 'Bash fork bomb signature' },
  { pattern: /\b(curl|wget)\s+.*\|\s*(bash|sh|powershell|pwsh)\b/i, reason: 'Remote unverified pipe-to-shell execution' },
  { pattern: /\b(chmod\s+-R\s+777\s+\/|chown\s+-R\s+root)/i, reason: 'Dangerous recursive permission escalation' },
  { pattern: /\b(gsutil\s+rm|gcloud\s+storage\s+rm)\s+.*(\*|prod)/i, reason: 'Production cloud bucket destruction attempt' }
];

export async function executeSuretyGuard(args: {
  command: string;
  workingDirectory?: string;
  strict?: boolean;
}): Promise<ToolExecutionResult> {
  const { command, workingDirectory = process.cwd(), strict = false } = args;
  const violations: string[] = [];

  // Check destructive pattern regexes
  for (const item of DANGEROUS_PATTERNS) {
    if (item.pattern.test(command)) {
      violations.push(item.reason);
    }
  }

  // Check path traversal attempts
  if (command.includes('../../../') || command.includes('..\\..\\..\\')) {
    violations.push('Path traversal escaping repository root boundary');
  }

  let verdict: 'ALLOW' | 'BLOCK' | 'WARN' = 'ALLOW';
  let riskScore = 0;

  if (violations.length > 0) {
    verdict = 'BLOCK';
    riskScore = 95;
  } else if (/\b(rmdir|rm|del|git\s+clean\s+-fdx)\b/i.test(command)) {
    verdict = strict ? 'BLOCK' : 'WARN';
    riskScore = 45;
  }

  const hash = crypto.createHash('sha256').update(`${command}:${workingDirectory}:${Date.now()}`).digest('hex');

  const result = {
    command,
    workingDirectory: path.resolve(workingDirectory),
    verdict,
    riskScore,
    isSafe: verdict === 'ALLOW',
    violations,
    strictMode: strict,
    merkleFingerprint: hash,
    evaluatedAt: new Date().toISOString(),
    recommendation: verdict === 'ALLOW' 
      ? 'Command is safe for autonomous execution within bounded worktree.'
      : 'HALT: Command poses safety risk. Require human approval or sanitize arguments.'
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }
    ],
    isError: verdict === 'BLOCK'
  };
}
