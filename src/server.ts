/**
 * Model Context Protocol (MCP) JSON-RPC 2.0 Server
 * Implements MCP Specification 2024-11-05 for Claude Desktop, Cursor, Codex, and OpenAI agents
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import * as readline from 'node:readline';
import { JSONRPCRequest, JSONRPCResponse } from './types/index.js';
import { ALL_MCP_TOOLS, dispatchToolCall } from './tools/index.js';
import { ALL_MCP_RESOURCES, readResourceByUri } from './resources/index.js';
import { ALL_MCP_PROMPTS, renderPrompt } from './prompts/index.js';

export class MCPServer {
  private isRunning: boolean = false;
  private readonly serverName: string = '@nymrel/mcp-hub';
  private readonly serverVersion: string = '1.0.0';
  private readonly protocolVersion: string = '2024-11-05';

  async handleRequest(req: JSONRPCRequest): Promise<JSONRPCResponse | null> {
    const id = req.id ?? null;

    if (!req || typeof req !== 'object' || req.jsonrpc !== '2.0' || !req.method) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32600,
          message: 'Invalid Request: Expected JSON-RPC 2.0 request with method'
        }
      };
    }

    try {
      switch (req.method) {
        case 'initialize': {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: this.protocolVersion,
              capabilities: {
                tools: {
                  listChanged: false
                },
                resources: {
                  listChanged: false
                },
                prompts: {
                  listChanged: false
                }
              },
              serverInfo: {
                name: this.serverName,
                version: this.serverVersion
              },
              instructions: 'Unified Nymrel MCP Hub providing 14 zero-dependency agent tools, resources, and prompt templates.'
            }
          };
        }

        case 'notifications/initialized': {
          // MCP notification handshake - no return response required
          return null;
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
          const params = req.params || {};
          const toolName = params.name;
          const toolArgs = params.arguments || {};

          if (!toolName || typeof toolName !== 'string') {
            return {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: 'Invalid params: Missing or invalid "name" in tools/call request'
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
          const params = req.params || {};
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
          const params = req.params || {};
          const promptName = params.name;
          const promptArgs = params.arguments || {};

          if (!promptName || typeof promptName !== 'string') {
            return {
              jsonrpc: '2.0',
              id,
              error: {
                code: -32602,
                message: 'Invalid params: Missing or invalid "name" in prompts/get request'
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
    } catch (err: any) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32000,
          message: err.message || String(err)
        }
      };
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
