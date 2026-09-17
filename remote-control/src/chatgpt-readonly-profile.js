import { NotFoundError } from './errors.js';
import { ChatgptMcpEdge, CHATGPT_REMOTE_TOOLS } from './chatgpt-mcp-edge.js';

export const CHATGPT_READONLY_SCOPES = Object.freeze(['devices:read', 'tools:read']);

export const CHATGPT_READONLY_TOOL_NAMES = Object.freeze([
  'list_devices',
  'read_file',
  'list_directory',
  'get_file_info',
  'search_files',
  'search_content'
]);

const READONLY_NAME_SET = new Set(CHATGPT_READONLY_TOOL_NAMES);

export const CHATGPT_READONLY_TOOLS = Object.freeze(
  CHATGPT_REMOTE_TOOLS
    .filter((tool) => READONLY_NAME_SET.has(tool.name))
    .map((tool) => structuredClone(tool))
);

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
    return super.callTool(principal, name, args, context);
  }
}
