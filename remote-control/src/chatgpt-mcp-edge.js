import { ConflictError, ForbiddenError, NotFoundError } from './errors.js';
import { RemoteMcpEdge } from './mcp-edge.js';
import { NATIVE_TOOLS } from './native-local-client.js';

const DEVICE_PROPERTY = Object.freeze({
  type: 'string',
  minLength: 1,
  maxLength: 256,
  description: 'Paired device id or exact device name. Omit only when exactly one eligible device is available.'
});

const PUBLIC_NATIVE_NAMES = new Set([
  'read_file',
  'list_directory',
  'get_file_info',
  'search_files',
  'search_content',
  'write_file',
  'edit_block',
  'start_process',
  'read_process_output',
  'interact_with_process',
  'list_sessions',
  'list_processes',
  'kill_process'
]);

const MANAGEMENT_TOOLS = Object.freeze([
  {
    name: 'list_devices',
    target: 'nymrel_remote_list_devices',
    description: 'Use this when the user wants to see paired Nymrel Remote devices and current reachability before working with one.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { title: 'List remote devices', readOnlyHint: true, openWorldHint: false, destructiveHint: false }
  }
]);

const MANAGEMENT_BY_NAME = new Map(MANAGEMENT_TOOLS.map((tool) => [tool.name, tool]));
const NATIVE_BY_NAME = new Map(NATIVE_TOOLS.map((tool) => [tool.name, tool]));

function nativeAnnotations(name) {
  const readOnly = new Set([
    'read_file', 'list_directory', 'get_file_info', 'search_files', 'search_content',
    'list_sessions', 'list_processes'
  ]).has(name);
  const destructive = new Set([
    'write_file', 'edit_block', 'start_process', 'interact_with_process', 'kill_process'
  ]).has(name);
  const openWorld = name === 'start_process' || name === 'interact_with_process';
  return {
    title: name.replaceAll('_', ' '),
    readOnlyHint: readOnly,
    openWorldHint: openWorld,
    destructiveHint: destructive
  };
}

function withDeviceSchema(schema) {
  const clone = structuredClone(schema);
  clone.type = 'object';
  clone.properties = { device: structuredClone(DEVICE_PROPERTY), ...(clone.properties || {}) };
  clone.additionalProperties = false;
  return clone;
}

function stableNativeTool(tool) {
  return {
    name: tool.name,
    description: `Use this when the user explicitly wants Nymrel Remote to ${tool.description.charAt(0).toLowerCase()}${tool.description.slice(1)} Select the target with the optional device argument.`,
    inputSchema: withDeviceSchema(tool.inputSchema),
    annotations: nativeAnnotations(tool.name)
  };
}

const STABLE_NATIVE_TOOLS = Object.freeze(
  NATIVE_TOOLS.filter((tool) => PUBLIC_NATIVE_NAMES.has(tool.name)).map(stableNativeTool)
);
const STABLE_BY_NAME = new Map(STABLE_NATIVE_TOOLS.map((tool) => [tool.name, tool]));

export const CHATGPT_REMOTE_TOOLS = Object.freeze([
  ...MANAGEMENT_TOOLS.map(({ target: _target, ...tool }) => structuredClone(tool)),
  ...STABLE_NATIVE_TOOLS.map((tool) => structuredClone(tool))
]);

function hasScope(principal, scope) {
  const scopes = new Set(principal?.scopes || []);
  return scopes.has('*') || scopes.has('tools:*') || scopes.has(scope);
}

export class ChatgptMcpEdge extends RemoteMcpEdge {
  async listTools(_principal) {
    return CHATGPT_REMOTE_TOOLS.map((tool) => structuredClone(tool));
  }

  schemaForTool(name) {
    return MANAGEMENT_BY_NAME.get(name)?.inputSchema || STABLE_BY_NAME.get(name)?.inputSchema || null;
  }

  async callTool(principal, name, args = {}, context = {}) {
    const management = MANAGEMENT_BY_NAME.get(name);
    if (management) return super.callTool(principal, management.target, args, context);

    if (!STABLE_BY_NAME.has(name)) throw new NotFoundError('Nymrel Remote ChatGPT tool not found');
    if (nativeAnnotations(name).openWorldHint && !hasScope(principal, 'tools:network')) {
      throw new ForbiddenError('tools:network scope required');
    }
    const selector = typeof args.device === 'string' && args.device ? args.device : null;
    const { device: _device, ...nativeArgs } = args;
    const projectedName = await this.#resolveProjectedName(principal, name, selector);
    return super.callTool(principal, projectedName, nativeArgs, context);
  }

  async #resolveProjectedName(principal, nativeName, selector) {
    const devices = await this.broker.listDevices(principal);
    const projected = await this.broker.projectedTools(principal);
    const capableIds = new Set(
      projected
        .filter((tool) => tool?._meta?.['nymrel/originalToolName'] === nativeName)
        .map((tool) => tool?._meta?.['nymrel/deviceId'])
        .filter(Boolean)
    );
    const candidates = devices.filter((device) => device.status !== 'revoked' && capableIds.has(device.id));

    let selected;
    if (selector) {
      selected = candidates.find((device) => device.id === selector);
      if (!selected) {
        const exact = candidates.filter((device) => device.name === selector);
        const folded = exact.length ? exact : candidates.filter((device) => device.name.toLowerCase() === selector.toLowerCase());
        if (folded.length > 1) throw new ConflictError(`Device name is ambiguous: ${selector}`);
        selected = folded[0];
      }
      if (!selected) throw new NotFoundError(`Paired device not found or does not expose ${nativeName}: ${selector}`);
    } else {
      const online = candidates.filter((device) => device.status === 'online' && device.mcpReady);
      const pool = online.length ? online : candidates;
      if (pool.length !== 1) {
        throw new ConflictError('device is required when more than one eligible Nymrel Remote device is available');
      }
      [selected] = pool;
    }

    const tool = projected.find((item) =>
      item?._meta?.['nymrel/deviceId'] === selected.id && item?._meta?.['nymrel/originalToolName'] === nativeName
    );
    if (!tool) throw new NotFoundError(`Device ${selected.name} no longer exposes ${nativeName}`);
    return tool.name;
  }
}
