import { deepClone, jsonSize } from './canonical.js';
import { sha256 } from './crypto.js';

const TOOL_NAME_RE = /^[A-Za-z0-9_.:/-]{1,128}$/;

export function validateRegisteredTool(tool, { maxSchemaBytes = 128 * 1024 } = {}) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) throw new Error('tool must be an object');
  if (typeof tool.name !== 'string' || !TOOL_NAME_RE.test(tool.name)) throw new Error('tool.name is invalid');
  if (tool.description !== undefined && typeof tool.description !== 'string') throw new Error(`tool ${tool.name} description must be a string`);
  if (!tool.inputSchema || typeof tool.inputSchema !== 'object' || Array.isArray(tool.inputSchema)) {
    throw new Error(`tool ${tool.name} inputSchema must be an object`);
  }
  if (jsonSize(tool.inputSchema) > maxSchemaBytes) throw new Error(`tool ${tool.name} schema exceeds limit`);
  collectMcpHeaderBindings(tool.inputSchema); // reject malformed HTTP mirroring annotations before exposure
  const normalized = {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: deepClone(tool.inputSchema)
  };
  if (tool.annotations && typeof tool.annotations === 'object' && !Array.isArray(tool.annotations)) {
    const allowed = {};
    for (const key of ['title', 'readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
      if (Object.hasOwn(tool.annotations, key)) allowed[key] = tool.annotations[key];
    }
    normalized.annotations = allowed;
  }
  normalized.schemaHash = sha256(normalized.inputSchema);
  return normalized;
}

export function slug(value, max = 32) {
  const out = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
  return (out || 'item').slice(0, max);
}

export function projectToolName(device, tool) {
  const devicePart = slug(device.name, 20);
  const deviceSuffix = sha256(device.id).slice(0, 8);
  const toolPart = slug(tool.name, 48);
  return `remote_${devicePart}_${deviceSuffix}__${toolPart}`;
}

export function projectDeviceTool(device, tool) {
  return {
    name: projectToolName(device, tool),
    description: `[${device.name}] ${tool.description || tool.name}`,
    inputSchema: deepClone(tool.inputSchema),
    ...(tool.annotations ? { annotations: deepClone(tool.annotations) } : {}),
    _meta: {
      'nymrel/deviceId': device.id,
      'nymrel/originalToolName': tool.name,
      'nymrel/schemaHash': tool.schemaHash,
      'nymrel/deviceStatus': device.status
    }
  };
}

export function schemasEqualProjected(tool, projected) {
  return JSON.stringify(tool.inputSchema) === JSON.stringify(projected.inputSchema)
    && tool.schemaHash === projected?._meta?.['nymrel/schemaHash'];
}

export function normalizeToolCatalog(tools, options = {}) {
  if (!Array.isArray(tools)) throw new Error('tools must be an array');
  const normalized = tools.map((tool) => validateRegisteredTool(tool, options));
  const names = new Set();
  for (const tool of normalized) {
    if (names.has(tool.name)) throw new Error(`duplicate tool name: ${tool.name}`);
    names.add(tool.name);
  }
  return {
    tools: normalized,
    hash: sha256(normalized.map((tool) => ({ name: tool.name, schemaHash: tool.schemaHash })))
  };
}

const HTTP_TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function collectMcpHeaderBindings(schema) {
  const bindings = [];
  const seen = new Set();

  function walk(value, path, staticallyReachable, isProperty) {
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, path, false, false);
      return;
    }

    if (Object.hasOwn(value, 'x-mcp-header')) {
      const headerName = value['x-mcp-header'];
      if (!staticallyReachable || !isProperty) throw new Error('x-mcp-header is only valid on statically reachable properties');
      if (typeof headerName !== 'string' || !headerName || !HTTP_TOKEN_RE.test(headerName)) {
        throw new Error(`Invalid x-mcp-header value at ${path.join('.') || '<root>'}`);
      }
      if (!['string', 'integer', 'boolean'].includes(value.type)) {
        throw new Error(`x-mcp-header property ${path.join('.')} must have primitive type string, integer, or boolean`);
      }
      const dedupe = headerName.toLowerCase();
      if (seen.has(dedupe)) throw new Error(`Duplicate x-mcp-header: ${headerName}`);
      seen.add(dedupe);
      bindings.push({ headerName, path: [...path], type: value.type });
    }

    for (const [key, child] of Object.entries(value)) {
      if (key === 'x-mcp-header') continue;
      if (key === 'properties' && child && typeof child === 'object' && !Array.isArray(child)) {
        for (const [propertyName, propertySchema] of Object.entries(child)) {
          walk(propertySchema, [...path, propertyName], staticallyReachable, true);
        }
      } else if (child && typeof child === 'object') {
        walk(child, path, false, false);
      }
    }
  }

  walk(schema, [], true, false);
  return bindings;
}
