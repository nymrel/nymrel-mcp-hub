const READ_PREFIXES = ['read_', 'list_', 'get_', 'find_', 'search_', 'inspect_', 'view_'];
const READ_NAMES = new Set(['ping']);
const NETWORK_PREFIXES = ['fetch_', 'http_', 'web_', 'download_', 'request_', 'url_'];
const WRITE_PREFIXES = ['write_', 'edit_', 'move_', 'rename_', 'create_', 'delete_', 'remove_', 'patch_', 'update_'];
const EXEC_PREFIXES = ['start_', 'run_', 'execute_', 'interact_', 'kill_', 'terminate_', 'shutdown_', 'restart_'];
const DESTRUCTIVE = new Set([
  'shutdown', 'reboot', 'format', 'diskpart', 'delete_file', 'kill_process', 'force_terminate', 'shutdown_device_agent'
]);

export const CAPABILITIES = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  EXECUTE: 'execute',
  NETWORK: 'network',
  UNKNOWN: 'unknown'
});

export function classifyTool(tool) {
  const explicit = tool?._meta?.['nymrel/capability'] ?? tool?.annotations?.['nymrel/capability'];
  if (Object.values(CAPABILITIES).includes(explicit)) return explicit;
  const name = String(tool?.name ?? '').toLowerCase();
  if (READ_NAMES.has(name)) return CAPABILITIES.READ;
  if (NETWORK_PREFIXES.some((prefix) => name.startsWith(prefix))) return CAPABILITIES.NETWORK;
  if (READ_PREFIXES.some((prefix) => name.startsWith(prefix))) return CAPABILITIES.READ;
  if (WRITE_PREFIXES.some((prefix) => name.startsWith(prefix))) return CAPABILITIES.WRITE;
  if (EXEC_PREFIXES.some((prefix) => name.startsWith(prefix))) return CAPABILITIES.EXECUTE;
  return CAPABILITIES.UNKNOWN;
}

export function isDestructiveTool(tool) {
  const explicit = tool?._meta?.['nymrel/destructive'] ?? tool?.annotations?.destructiveHint;
  if (explicit === true) return true;
  return DESTRUCTIVE.has(String(tool?.name ?? '').toLowerCase());
}

export class PolicyEngine {
  constructor({
    read = 'auto',
    write = 'operator',
    execute = 'operator',
    network = 'operator',
    unknown = 'deny',
    destructive = 'deny'
  } = {}) {
    this.rules = { read, write, execute, network, unknown };
    this.destructive = destructive;
  }

  evaluate(principal, tool, args = {}) {
    let capability = classifyTool(tool);
    if (capability === CAPABILITIES.READ && args && typeof args === 'object') {
      const directUrl = typeof args.url === 'string' || typeof args.uri === 'string';
      if (args.isUrl === true || directUrl) capability = CAPABILITIES.NETWORK;
    }
    const destructive = isDestructiveTool(tool);
    const scopes = new Set(principal?.scopes ?? []);
    const has = (scope) => scopes.has('*') || scopes.has(scope);

    if (!has(`tools:${capability}`) && !has('tools:*')) {
      return { decision: 'deny', reason: `principal lacks tools:${capability}`, capability, destructive };
    }

    if (destructive) {
      if (!has('tools:dangerous')) return { decision: 'deny', reason: 'destructive tool requires tools:dangerous', capability, destructive };
      return { decision: this.destructive, reason: `destructive policy: ${this.destructive}`, capability, destructive };
    }

    const decision = this.rules[capability] ?? this.rules.unknown;
    return { decision, reason: `${capability} policy: ${decision}`, capability, destructive };
  }
}
