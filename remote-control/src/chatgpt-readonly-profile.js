import { NymrelRemoteError, NotFoundError } from './errors.js';
import { ChatgptMcpEdge, CHATGPT_REMOTE_TOOLS } from './chatgpt-mcp-edge.js';
import { formatCallResult } from './mcp-edge.js';

export const CHATGPT_READONLY_SCOPES = Object.freeze(['devices:read', 'tools:read']);

export const CHATGPT_READONLY_TOOL_NAMES = Object.freeze([
  'list_devices',
  'read_file',
  'list_directory',
  'get_file_info',
  'search_files',
  'search_content',
  'get_read_result'
]);

const READONLY_NAME_SET = new Set(CHATGPT_READONLY_TOOL_NAMES);

export const CHATGPT_READONLY_TOOLS = Object.freeze([
  ...CHATGPT_REMOTE_TOOLS
    .filter((tool) => READONLY_NAME_SET.has(tool.name))
    .map((tool) => structuredClone(tool)),
  {
    name: 'get_read_result',
    description: 'Retrieve the result of your pending Nymrel Remote read using its callId. If a file inspection returns pending, use this tool instead of submitting that inspection again. It never starts a new device operation. If still pending, wait briefly before checking again.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['callId'],
      properties: { callId: { type: 'string', minLength: 1, maxLength: 256 } }
    },
    annotations: { title: 'Get remote read result', readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  }
]);

const READONLY_BY_NAME = new Map(CHATGPT_READONLY_TOOLS.map((tool) => [tool.name, tool]));

export class ChatgptReadonlyMcpEdge extends ChatgptMcpEdge {
  async listTools(_principal) {
    return CHATGPT_READONLY_TOOLS.map((tool) => structuredClone(tool));
  }
  schemaForTool(name) {
    return READONLY_BY_NAME.get(name)?.inputSchema || null;
  }

  async callTool(principal, name, args = {}, context = {}) {
    if (!READONLY_BY_NAME.has(name)) {
      throw new NotFoundError('Nymrel Remote read-only ChatGPT tool not found');
    }
    if (name === 'get_read_result') {
      if (typeof args.callId !== 'string' || !args.callId || args.callId.length > 256 ||
          Object.keys(args).some((key) => key !== 'callId')) {
        throw new NymrelRemoteError('get_read_result requires only a callId string of 1–256 characters', { code: 'INVALID_ARGUMENTS' });
      }
      return this.#withContinuation(formatCallResult(await this.broker.getReadonlyCall(principal, args.callId)));
    }
    const result = await super.callTool(principal, name, args, { ...context, sourceProfile: 'chatgpt-readonly' });
    return this.#withContinuation(result);
  }

  #withContinuation(result) {
    if (result.structuredContent?.pending !== true) return result;
    const callId = result.structuredContent.call?.id;
    if (typeof callId !== 'string') return result;
    return {
      ...result,
      content: [...result.content, { type: 'text', text: `Use get_read_result with callId ${callId} to retrieve this read. Do not resubmit the original inspection while it is pending.` }]
    };
  }
}
