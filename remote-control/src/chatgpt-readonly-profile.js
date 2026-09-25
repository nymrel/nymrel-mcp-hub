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

function readonlyOAuthSecuritySchemes() {
  return [{ type: 'oauth2', scopes: [...CHATGPT_READONLY_SCOPES] }];
}

function withReadonlyOAuth(tool) {
  return { ...structuredClone(tool), securitySchemes: readonlyOAuthSecuritySchemes() };
}

export const PUBLISHER_HISTORY_TOOLS = Object.freeze([
  withReadonlyOAuth({
    name: 'publisher_list_history',
    description: 'List exact recent public publication history for one authorized Nymrel brand. Use this for dedupe and readback before preparing new social content.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['brandId'],
      properties: {
        brandId: { type: 'string', minLength: 1, maxLength: 512 },
        sinceAt: { type: 'string', minLength: 1, maxLength: 40 },
        untilAt: { type: 'string', minLength: 1, maxLength: 40 },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 }
      }
    },
    annotations: { title: 'List Publisher history', readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  }),
  withReadonlyOAuth({
    name: 'publisher_find_exact_text',
    description: 'Check whether exact copy already exists in the public history for one authorized Nymrel brand.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['brandId', 'canonicalText'],
      properties: {
        brandId: { type: 'string', minLength: 1, maxLength: 512 },
        canonicalText: { type: 'string', minLength: 1, maxLength: 262144 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 }
      }
    },
    annotations: { title: 'Find exact Publisher copy', readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  }),
  withReadonlyOAuth({
    name: 'publisher_list_syncs',
    description: 'List recent public-history synchronization runs and coverage for one authorized Nymrel brand.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['brandId'],
      properties: {
        brandId: { type: 'string', minLength: 1, maxLength: 512 },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }
      }
    },
    annotations: { title: 'List Publisher history syncs', readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  })
]);

export const CHATGPT_READONLY_TOOLS = Object.freeze([
  ...CHATGPT_REMOTE_TOOLS
    .filter((tool) => READONLY_NAME_SET.has(tool.name))
    .map(withReadonlyOAuth),
  {
    name: 'get_read_result',
    description: 'Retrieve the result of your pending Nymrel Remote read using its callId. If a file inspection returns pending, use this tool instead of submitting that inspection again. It never starts a new device operation. If still pending, wait briefly before checking again.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['callId'],
      properties: { callId: { type: 'string', minLength: 1, maxLength: 256 } }
    },
    annotations: { title: 'Get remote read result', readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    securitySchemes: readonlyOAuthSecuritySchemes()
  }
]);

const READONLY_BY_NAME = new Map(CHATGPT_READONLY_TOOLS.map((tool) => [tool.name, tool]));
const PUBLISHER_BY_NAME = new Map(PUBLISHER_HISTORY_TOOLS.map((tool) => [tool.name, tool]));
const READONLY_SOURCE_PROFILES = new Set(['chatgpt-readonly', 'nymrel-plugin-readonly']);

function textResult(value) {
  const structuredContent = { result: value };
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent,
    isError: false
  };
}

function optionalStamp(value, key) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length < 1 || value.length > 40 || !Number.isFinite(Date.parse(value))) {
    throw new NymrelRemoteError(`${key} must be a valid timestamp`, { code: 'INVALID_ARGUMENTS', status: 400 });
  }
  return value;
}

function boundedLimit(value, fallback, max) {
  const limit = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > max) {
    throw new NymrelRemoteError('limit is invalid', { code: 'INVALID_ARGUMENTS', status: 400 });
  }
  return limit;
}

export class ChatgptReadonlyMcpEdge extends ChatgptMcpEdge {
  constructor({ sourceProfile = 'chatgpt-readonly', publisherHistoryClient = null, ...options } = {}) {
    super(options);
    if (!READONLY_SOURCE_PROFILES.has(sourceProfile)) throw new Error('Invalid read-only source profile');
    if (publisherHistoryClient !== null &&
        (typeof publisherHistoryClient.listRecent !== 'function' ||
         typeof publisherHistoryClient.findExactText !== 'function' ||
         typeof publisherHistoryClient.listSyncs !== 'function')) {
      throw new Error('Invalid Publisher history client');
    }
    this.sourceProfile = sourceProfile;
    this.publisherHistoryClient = publisherHistoryClient;
  }

  async listTools(_principal) {
    const tools = CHATGPT_READONLY_TOOLS.map((tool) => structuredClone(tool));
    if (this.publisherHistoryClient) tools.push(...PUBLISHER_HISTORY_TOOLS.map((tool) => structuredClone(tool)));
    return tools;
  }
  schemaForTool(name) {
    if (this.publisherHistoryClient && PUBLISHER_BY_NAME.has(name)) return PUBLISHER_BY_NAME.get(name).inputSchema;
    return READONLY_BY_NAME.get(name)?.inputSchema || null;
  }

  async callTool(principal, name, args = {}, context = {}) {
    if (this.publisherHistoryClient && PUBLISHER_BY_NAME.has(name)) {
      return this.#publisherTool(principal, name, args);
    }
    if (!READONLY_BY_NAME.has(name)) {
      throw new NotFoundError('Nymrel read-only ChatGPT tool not found');
    }
    if (name === 'get_read_result') {
      if (typeof args.callId !== 'string' || !args.callId || args.callId.length > 256 ||
          Object.keys(args).some((key) => key !== 'callId')) {
        throw new NymrelRemoteError('get_read_result requires only a callId string of 1–256 characters', { code: 'INVALID_ARGUMENTS' });
      }
      return this.#withContinuation(formatCallResult(await this.broker.getReadonlyCall(principal, args.callId, { sourceProfile: this.sourceProfile })));
    }
    const result = await super.callTool(principal, name, args, { ...context, sourceProfile: this.sourceProfile });
    return this.#withContinuation(result);
  }

  async #publisherTool(principal, name, args) {
    if (typeof principal?.tenant !== 'string' || !principal.tenant ||
        typeof args?.brandId !== 'string' || !args.brandId || args.brandId.length > 512) {
      throw new NymrelRemoteError('Publisher history requires an authorized tenant and brand', {
        code: 'PUBLISHER_HISTORY_BRAND_DENIED', status: 404
      });
    }
    if (name === 'publisher_list_history') {
      const result = await this.publisherHistoryClient.listRecent(principal.tenant, {
        brandId: args.brandId,
        channel: 'x',
        ...(args.sinceAt !== undefined ? { sinceAt: optionalStamp(args.sinceAt, 'sinceAt') } : {}),
        ...(args.untilAt !== undefined ? { untilAt: optionalStamp(args.untilAt, 'untilAt') } : {}),
        limit: boundedLimit(args.limit, 100, 500)
      });
      return textResult(result);
    }
    if (name === 'publisher_find_exact_text') {
      if (typeof args.canonicalText !== 'string' || args.canonicalText.length < 1 ||
          Buffer.byteLength(args.canonicalText) > 256 * 1024) {
        throw new NymrelRemoteError('canonicalText is invalid', { code: 'INVALID_ARGUMENTS', status: 400 });
      }
      const result = await this.publisherHistoryClient.findExactText(principal.tenant, {
        brandId: args.brandId,
        channel: 'x',
        canonicalText: args.canonicalText,
        limit: boundedLimit(args.limit, 20, 50)
      });
      return textResult(result);
    }
    const result = await this.publisherHistoryClient.listSyncs(principal.tenant, {
      brandId: args.brandId,
      channel: 'x',
      limit: boundedLimit(args.limit, 20, 100)
    });
    return textResult(result);
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
