/**
 * Model Context Protocol (MCP) JSON-RPC 2.0 Server
 * Serves the MCP 2026-07-28 stateless era and initialize-based legacy revisions.
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import * as readline from 'node:readline';
import { JSONRPCRequest, JSONRPCResponse } from './types/index.js';
import { ALL_MCP_TOOLS, dispatchToolCall } from './tools/index.js';
import { ALL_MCP_RESOURCES, readResourceByUri } from './resources/index.js';
import { ALL_MCP_PROMPTS, renderPrompt } from './prompts/index.js';
import {
  classifyProtocolRequest,
  isRecord,
  legacyCapabilities,
  MODERN_PROTOCOL_VERSION,
  modernCapabilities,
  negotiateLegacyProtocolVersion,
  SERVER_INFO,
  SERVER_INSTRUCTIONS,
  stampModernSuccess,
  type MCPProtocolEra
} from './protocol.js';

export class MCPServer {
  private isRunning: boolean = false;

  async handleRequest(req: JSONRPCRequest): Promise<JSONRPCResponse | null> {
    // JSON-RPC 2.0 section 4.1: a Notification is a valid Request object
    // WITHOUT an "id" member and MUST NOT be answered. An explicit
    // "id": null is a Request, not a Notification, and stays response-bearing.
    const isObject = !!req && typeof req === 'object';
    const hasIdMember = isObject && 'id' in req;
    const isNotification = isObject && !hasIdMember;
    const id = hasIdMember ? ((req as JSONRPCRequest).id ?? null) : null;

    if (
      !req ||
      typeof req !== 'object' ||
      req.jsonrpc !== '2.0' ||
      typeof req.method !== 'string' ||
      req.method.length === 0
    ) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32600,
          message: 'Invalid Request: Expected JSON-RPC 2.0 request with method'
        }
      };
    }

    const protocol = classifyProtocolRequest(req, id);
    if (protocol.error) return isNotification ? null : protocol.error;

    try {
      const response = await this.executeMethod(req, id, protocol.era);
      const encoded = protocol.era === 'modern'
        ? stampModernSuccess(response, req.method)
        : response;
      return isNotification ? null : encoded;
    } catch (err: any) {
      // Even on handler failure a notification must stay unanswered.
      if (isNotification) return null;
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: protocol.era === 'modern' ? -32603 : -32000,
          message: err.message || String(err)
        }
      };
    }
  }

  private async executeMethod(
    req: JSONRPCRequest,
    id: string | number | null,
    era: MCPProtocolEra
  ): Promise<JSONRPCResponse> {
    if (era === 'modern' && ['initialize', 'notifications/initialized', 'ping'].includes(req.method)) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Method not supported by MCP ${MODERN_PROTOCOL_VERSION}: ${req.method}`
        }
      };
    }

    switch (req.method) {
      case 'server/discover': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            supportedVersions: [MODERN_PROTOCOL_VERSION],
            capabilities: modernCapabilities(),
            instructions: SERVER_INSTRUCTIONS
          }
        };
      }

      case 'initialize': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiateLegacyProtocolVersion(req.params),
            capabilities: legacyCapabilities(),
            serverInfo: SERVER_INFO,
            instructions: SERVER_INSTRUCTIONS
          }
        };
      }

      case 'ping': {
        return {
          jsonrpc: '2.0',
          id,
          result: {}
        };
      }

      case 'tools/list': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: ALL_MCP_TOOLS
          }
        };
      }

      case 'tools/call': {
        const params = isRecord(req.params) ? req.params : {};
        const toolName = params.name;
        const toolArgs = params.arguments === undefined ? {} : params.arguments;

        if (!toolName || typeof toolName !== 'string' || !isRecord(toolArgs)) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: 'Invalid params: tools/call requires a string "name" and object "arguments"'
            }
          };
        }

        const executionResult = await dispatchToolCall(toolName, toolArgs);

        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: executionResult.content,
            isError: executionResult.isError || false
          }
        };
      }

      case 'resources/list': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            resources: ALL_MCP_RESOURCES
          }
        };
      }

      case 'resources/read': {
        const params = isRecord(req.params) ? req.params : {};
        const uri = params.uri;

        if (!uri || typeof uri !== 'string') {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: 'Invalid params: Missing or invalid "uri" in resources/read request'
            }
          };
        }

        const resource = readResourceByUri(uri);

        return {
          jsonrpc: '2.0',
          id,
          result: {
            contents: [
              {
                uri: resource.uri,
                mimeType: resource.mimeType,
                text: resource.text
              }
            ]
          }
        };
      }

      case 'prompts/list': {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            prompts: ALL_MCP_PROMPTS
          }
        };
      }

      case 'prompts/get': {
        const params = isRecord(req.params) ? req.params : {};
        const promptName = params.name;
        const promptArgs = params.arguments === undefined ? {} : params.arguments;

        if (!promptName || typeof promptName !== 'string' || !isRecord(promptArgs)) {
          return {
            jsonrpc: '2.0',
            id,
            error: {
              code: -32602,
              message: 'Invalid params: prompts/get requires a string "name" and object "arguments"'
            }
          };
        }

        const rendered = renderPrompt(promptName, promptArgs);

        return {
          jsonrpc: '2.0',
          id,
          result: {
            description: rendered.description,
            messages: rendered.messages
          }
        };
      }

      default: {
        return {
          jsonrpc: '2.0',
          id,
          error: {
            code: -32601,
            message: `Method not found: ${req.method}`
          }
        };
      }
    }
  }

  startStdio(): void {
    if (this.isRunning) return;
    this.isRunning = true;

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false
    });

    rl.on('line', async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const req = JSON.parse(trimmed) as JSONRPCRequest;
        const res = await this.handleRequest(req);
        if (res) {
          process.stdout.write(JSON.stringify(res) + '\n');
        }
      } catch (err: any) {
        const errRes: JSONRPCResponse = {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32700,
            message: `Parse error: ${err.message}`
          }
        };
        process.stdout.write(JSON.stringify(errRes) + '\n');
      }
    });

    process.stderr.write(`[@nymrel/mcp-hub] Server online and listening on stdio (14 tools, 3 resources, 3 prompts registered)\n`);
  }
}
