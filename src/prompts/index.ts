/**
 * Master Registry of all Nymrel MCP Prompt Templates
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import { MCPPromptDefinition } from '../types/index.js';
import {
  auditWebsiteUcpPrompt,
  secureAgentCommandPrompt,
  initTwoSeatMissionPrompt,
  renderPrompt
} from './promptTemplates.js';

export {
  auditWebsiteUcpPrompt,
  secureAgentCommandPrompt,
  initTwoSeatMissionPrompt,
  renderPrompt
};

export const ALL_MCP_PROMPTS: MCPPromptDefinition[] = [
  auditWebsiteUcpPrompt,
  secureAgentCommandPrompt,
  initTwoSeatMissionPrompt
];
