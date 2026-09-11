const DESTRUCTIVE = new Set([
  'shutdown', 'reboot', 'format', 'diskpart', 'delete_file', 'kill_process',
  'force_terminate', 'shutdown_device_agent'
]);

export const CAPABILITIES = Object.freeze({
  READ: 'read',
  WRITE: 'write',
  EXECUTE: 'execute',
  NETWORK: 'network',
  UNKNOWN: 'unknown'
});

// Source-controlled capability registry for known tool contracts. Unknown tools are denied
// until an operator explicitly maps them through NYMREL_REMOTE_TOOL_CAPABILITIES_JSON.
export const DEFAULT_TOOL_CAPABILITIES = Object.freeze({
  read_file: 'read',
  read_multiple_files: 'read',
  list_directory: 'read',
  get_file_info: 'read',
  start_search: 'read',
  get_more_search_results: 'read',
  stop_search: 'read',
  list_searches: 'read',
  list_sessions: 'read',
  list_processes: 'read',
  get_config: 'read',
  get_usage_stats: 'read',
  get_recent_tool_calls: 'read',
  write_file: 'write',
  write_pdf: 'write',
  edit_block: 'write',
  move_file: 'write',
  create_directory: 'write',
  set_config_value: 'write',
  start_process: 'execute',
  interact_with_process: 'execute',
  read_process_output: 'read',
  force_terminate: 'execute',
  kill_process: 'execute',
  shutdown: 'execute'
});

function capabilityValue(value) {
  return Object.values(CAPABILITIES).includes(value) ? value : CAPABILITIES.UNKNOWN;
}

function stringLooksNetworked(value) {
  if (typeof value !== 'string') return false;
  const text = value.trim();
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return true;
  // Treat UNC and network-style double-slash paths conservatively on every platform.
  if (/^(\\\\|\/\/)[^\\/]/.test(text)) return true;
  return false;
}

export function argsUseNetwork(value, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return false;
  if (stringLooksNetworked(value)) return true;
  if (Array.isArray(value)) return value.some((item) => argsUseNetwork(item, depth + 1));
  if (typeof value !== 'object') return false;
  if (value.isUrl === true) return true;
  for (const [key, child] of Object.entries(value)) {
    if (/^(url|uri|endpoint|host|hostname)$/i.test(key) && typeof child === 'string' && child) return true;
    if (argsUseNetwork(child, depth + 1)) return true;
  }
  return false;
}

export function classifyTool(tool, capabilities = {}) {
  const name = String(tool?.name ?? '');
  const mapped = capabilities[name];
  return capabilityValue(mapped);
}

export function isDestructiveTool(tool) {
  const explicit = tool?.annotations?.destructiveHint;
  if (explicit === true) return true;
  return DESTRUCTIVE.has(String(tool?.name ?? '').toLowerCase());
}

export class PolicyEngine {
  constructor({
    capabilities = DEFAULT_TOOL_CAPABILITIES,
    read = 'auto',
    write = 'operator',
    execute = 'operator',
    network = 'operator',
    unknown = 'deny',
    destructive = 'deny'
  } = {}) {
    this.capabilities = { ...capabilities };
    this.rules = { read, write, execute, network, unknown };
    this.destructive = destructive;
  }

  evaluate(principal, tool, args = {}) {
    const baseCapability = classifyTool(tool, this.capabilities);
    const network = argsUseNetwork(args);
    const requiredCapabilities = new Set([baseCapability]);
    if (network) requiredCapabilities.add(CAPABILITIES.NETWORK);
    const destructive = isDestructiveTool(tool);
    const scopes = new Set(principal?.scopes ?? []);
    const has = (scope) => scopes.has('*') || scopes.has(scope) || scopes.has('tools:*');

    if (baseCapability === CAPABILITIES.UNKNOWN) {
      return { decision: 'deny', reason: 'tool has no operator-approved capability mapping', capability: baseCapability, requiredCapabilities: [...requiredCapabilities], destructive };
    }
    for (const capability of requiredCapabilities) {
      if (!has(`tools:${capability}`)) {
        return { decision: 'deny', reason: `principal lacks tools:${capability}`, capability: network ? CAPABILITIES.NETWORK : baseCapability, requiredCapabilities: [...requiredCapabilities], destructive };
      }
    }

    if (destructive) {
      if (!scopes.has('*') && !scopes.has('tools:dangerous')) {
        return { decision: 'deny', reason: 'destructive tool requires tools:dangerous', capability: baseCapability, requiredCapabilities: [...requiredCapabilities], destructive };
      }
      return { decision: this.destructive, reason: `destructive policy: ${this.destructive}`, capability: baseCapability, requiredCapabilities: [...requiredCapabilities], destructive };
    }

    const effectiveCapability = network ? CAPABILITIES.NETWORK : baseCapability;
    const decision = this.rules[effectiveCapability] ?? this.rules.unknown;
    return { decision, reason: `${effectiveCapability} policy: ${decision}`, capability: effectiveCapability, requiredCapabilities: [...requiredCapabilities], destructive };
  }
}