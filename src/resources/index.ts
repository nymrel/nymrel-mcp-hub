/**
 * Master Registry of all Nymrel MCP Resources
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import { MCPResourceDefinition } from '../types/index.js';
import { statusResourceDefinition, getStatusResourceContent } from './statusResource.js';
import { ecosystemResourceDefinition, getEcosystemResourceContent } from './ecosystemResource.js';
import { llmsManifestResourceDefinition, getLlmsManifestResourceContent } from './llmsManifestResource.js';

export {
  statusResourceDefinition, getStatusResourceContent,
  ecosystemResourceDefinition, getEcosystemResourceContent,
  llmsManifestResourceDefinition, getLlmsManifestResourceContent
};

export const ALL_MCP_RESOURCES: MCPResourceDefinition[] = [
  statusResourceDefinition,
  ecosystemResourceDefinition,
  llmsManifestResourceDefinition
];

export function readResourceByUri(uri: string): { uri: string; mimeType: string; text: string } {
  const cleanUri = uri.toLowerCase();

  if (cleanUri === 'nymrel://status' || cleanUri === '/nymrel/status') {
    return {
      uri: statusResourceDefinition.uri,
      mimeType: statusResourceDefinition.mimeType,
      text: getStatusResourceContent()
    };
  }

  if (cleanUri === 'nymrel://ecosystem' || cleanUri === '/nymrel/ecosystem') {
    return {
      uri: ecosystemResourceDefinition.uri,
      mimeType: ecosystemResourceDefinition.mimeType,
      text: getEcosystemResourceContent()
    };
  }

  if (cleanUri === 'nymrel://llms-manifest' || cleanUri === '/nymrel/llms-manifest') {
    return {
      uri: llmsManifestResourceDefinition.uri,
      mimeType: llmsManifestResourceDefinition.mimeType,
      text: getLlmsManifestResourceContent()
    };
  }

  throw new Error(`Resource with URI "${uri}" not found in @nymrel/mcp-hub.`);
}
