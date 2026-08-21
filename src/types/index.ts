/**
 * Model Context Protocol (MCP) TypeScript Type Definitions
 * Specification Version: 2024-11-05
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface MCPToolParameterProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: {
    type: string;
    properties?: Record<string, MCPToolParameterProperty>;
    required?: string[];
  };
  properties?: Record<string, MCPToolParameterProperty>;
  required?: string[];
  default?: any;
}

export interface MCPToolInputSchema {
  type: 'object';
  properties: Record<string, MCPToolParameterProperty>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: MCPToolInputSchema;
  tags?: string[];
}

export interface MCPResourceDefinition {
  uri: string;
  name: string;
  mimeType: string;
  description: string;
}

export interface MCPPromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface MCPPromptDefinition {
  name: string;
  description: string;
  arguments?: MCPPromptArgument[];
}

export interface MCPPromptMessage {
  role: 'user' | 'assistant' | 'system';
  content: {
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  };
}

export interface ToolExecutionResult {
  content: Array<{
    type: 'text' | 'image' | 'resource';
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
}
