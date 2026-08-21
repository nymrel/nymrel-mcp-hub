/**
 * A2UI Warm Paper Decision Card Generator Tool
 * Google Agent-to-UI (A2UI v0.8) declarative JSON spec generator
 * via a2ui-warm-paper
 */

import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';

export const a2uiToolDefinition: MCPToolDefinition = {
  name: 'nymrel_a2ui_render',
  description: 'Generates Google A2UI v0.8 declarative JSON decision cards, diff inspectors, and parameter tables in signature Nymrel Warm Paper aesthetics (#FAF8F2, #2A332E, #A8541F).',
  inputSchema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Human-facing title of the decision or review card'
      },
      summary: {
        type: 'string',
        description: 'Concise explanation of the action needing human approval'
      },
      category: {
        type: 'string',
        enum: ['approval', 'diff_review', 'parameter_tuning', 'confirmation'],
        description: 'Card interaction type',
        default: 'approval'
      },
      fields: {
        type: 'array',
        description: 'List of key-value attributes to display',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string' },
            value: { type: 'string' }
          }
        }
      },
      actions: {
        type: 'array',
        description: 'List of available human actions (default: ["Approve", "Deny", "Amend"])',
        items: {
          type: 'string'
        }
      }
    },
    required: ['title', 'summary']
  }
};

export async function executeA2ui(args: {
  title: string;
  summary: string;
  category?: 'approval' | 'diff_review' | 'parameter_tuning' | 'confirmation';
  fields?: Array<{ label: string; value: string }>;
  actions?: string[];
}): Promise<ToolExecutionResult> {
  const category = args.category || 'approval';
  const actions = args.actions || ['Approve', 'Deny', 'Amend'];

  const a2uiSpec = {
    schemaVersion: '0.8.0',
    type: 'a2ui.card.decision',
    theme: {
      name: 'Nymrel Warm Paper',
      surfaceBg: '#FAF8F2',
      headerBg: '#F4F0E6',
      textPrimary: '#2A332E',
      accent: '#A8541F',
      border: '1px solid rgba(42, 51, 46, 0.15)',
      borderRadius: '8px'
    },
    header: {
      title: args.title,
      badge: category.toUpperCase(),
      timestamp: new Date().toISOString()
    },
    body: {
      summary: args.summary,
      attributes: args.fields || [
        { label: 'Risk Level', value: 'Low / Reversible' },
        { label: 'Confidence', value: '96%' },
        { label: 'Authority Boundary', value: 'Command Studio Mission Packet' }
      ]
    },
    actions: actions.map((actName, idx) => ({
      id: `act-${idx + 1}`,
      label: actName,
      style: actName === 'Approve' ? 'primary' : actName === 'Deny' ? 'danger' : 'secondary',
      color: actName === 'Approve' ? '#2A332E' : actName === 'Deny' ? '#A8541F' : '#5A635E'
    }))
  };

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(a2uiSpec, null, 2)
      }
    ]
  };
}
