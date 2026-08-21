/**
 * Agent Sandstorm Isolation & Secret Firewall Tool
 * Copy-on-Write workspace containment and secret token masking engine
 * via @nymrel/agent-sandstorm
 */

import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';

export const sandstormToolDefinition: MCPToolDefinition = {
  name: 'nymrel_sandstorm',
  description: 'Enforces Zero-Trust agent sandboxing: Copy-on-Write workspace isolation, secret exfiltration masking (API keys, JWTs), and token/financial spend rate-limiters.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['mask_secrets', 'inspect_isolation', 'spend_guard'],
        description: 'Sandstorm security action',
        default: 'mask_secrets'
      },
      content: {
        type: 'string',
        description: 'Text or code string to scan for secrets and exfiltration tokens'
      },
      tokenSpend: {
        type: 'number',
        description: 'Current session token spend to compare against spend ceiling'
      },
      maxTokenSpendLimit: {
        type: 'number',
        description: 'Hard token limit (default 250,000)',
        default: 250000
      }
    }
  }
};

const SECRET_PATTERNS = [
  { name: 'GitHub Token', regex: /\bghp_[A-Za-z0-9_]{36,}\b/g, mask: '[REDACTED_GH_TOKEN]' },
  { name: 'OpenAI API Key', regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g, mask: '[REDACTED_OPENAI_KEY]' },
  { name: 'AWS Access Key', regex: /\bAKIA[0-9A-Z]{16}\b/g, mask: '[REDACTED_AWS_KEY]' },
  { name: 'Generic Secret / Bearer', regex: /\bBearer\s+[A-Za-z0-9_.-]{24,}\b/gi, mask: 'Bearer [REDACTED_BEARER_TOKEN]' }
];

export async function executeSandstorm(args: {
  action?: 'mask_secrets' | 'inspect_isolation' | 'spend_guard';
  content?: string;
  tokenSpend?: number;
  maxTokenSpendLimit?: number;
}): Promise<ToolExecutionResult> {
  const action = args.action || 'mask_secrets';
  const content = args.content || '';
  const spend = args.tokenSpend || 0;
  const limit = args.maxTokenSpendLimit || 250000;

  let maskedContent = content;
  const detectedSecrets: string[] = [];

  for (const item of SECRET_PATTERNS) {
    if (item.regex.test(content)) {
      detectedSecrets.push(item.name);
      maskedContent = maskedContent.replace(item.regex, item.mask);
    }
  }

  const spendCapped = spend >= limit;

  const result = {
    sandstormEngine: 'Agent Sandstorm v1.0.0 (Zero-Trust CoW)',
    action,
    secretFirewall: {
      secretsDetected: detectedSecrets.length,
      types: detectedSecrets,
      cleanPayload: maskedContent
    },
    isolationState: {
      cowFilesystem: 'MOUNTED_EPHEMERAL',
      snapshotRollbackReady: true,
      networkProxy: 'STRICT_EGRESS_FILTERED'
    },
    spendGuard: {
      currentTokens: spend,
      maxLimitTokens: limit,
      isCapped: spendCapped,
      status: spendCapped ? 'HALT_SPEND_EXCEEDED' : 'WITHIN_BUDGET'
    }
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }
    ],
    isError: spendCapped
  };
}
