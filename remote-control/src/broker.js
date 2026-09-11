import { EventEmitter } from 'node:events';
import { deepClone, jsonSize } from './canonical.js';
import { randomCode, randomId, sha256 } from './crypto.js';
import { ConflictError, ForbiddenError, NotFoundError, PolicyDeniedError, UnauthorizedError } from './errors.js';
import { normalizeToolCatalog, projectDeviceTool, projectToolName } from './schema.js';

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'expired', 'unknown']);
const DEVICE_SCOPES = ['device:register', 'device:heartbeat', 'device:events', 'call:claim', 'call:complete', 'device:refresh'];

function nowIso(now = Date.now()) { return new Date(now).toISOString(); }
function hasScope(principal, scope) {
  const scopes = new Set(principal?.scopes ?? []);
  return scopes.has('*') || scopes.has(scope);
}

function publicDevice(device, heartbeatTtlMs, now = Date.now()) {
  const lastSeenMs = device.lastSeen ? Date.parse(device.lastSeen) : 0;
  const live = !device.revokedAt && lastSeenMs > 0 && now - lastSeenMs <= heartbeatTtlMs;
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    status: device.revokedAt ? 'revoked' : (live ? device.status : 'offline'),
    lastSeen: device.lastSeen,
    mcpReady: !!device.mcpReady,
    toolCount: Array.isArray(device.tools) ? device.tools.length : 0,
    toolCatalogHash: device.toolCatalogHash ?? null,
    createdAt: device.createdAt,
    revokedAt: device.revokedAt ?? null
  };
}

export class RemoteBroker extends EventEmitter {
  constructor({ store, tokenService, cipher, audit, policy, config }) {
    super();
    this.store = store;
    this.tokenService = tokenService;
    this.cipher = cipher;
    this.audit = audit;
    this.policy = policy;
    this.config = config;
    this.waiters = new Map();
  }

  async init() {
    await this.store.init();
    return this;
  }

  #appendAudit(state, receipt) {
    if (state.receipts.length >= this.config.maxReceipts) throw new Error('Audit receipt capacity reached; archive/recovery is required before new mutations');
    return this.audit.append(state, receipt);
  }

  #deviceIdFromPrincipal(principal) {
    if (!principal || principal.typ !== 'device' || !String(principal.sub).startsWith('device:')) throw new UnauthorizedError('Device token required');
    return principal.sub.slice('device:'.length);
  }

  #deviceFromState(state, principal) {
    const deviceId = this.#deviceIdFromPrincipal(principal);
    const device = state.devices[deviceId];
    if (!device || device.revokedAt) throw new UnauthorizedError('Device is revoked or missing');
    if (device.tenantId !== principal.tenant || device.tokenVersion !== principal.tokenVersion) throw new UnauthorizedError('Device token is stale');
    return device;
  }

  #toolForCall(state, call) {
    const device = state.devices[call.deviceId];
    if (!device || device.revokedAt) throw new UnauthorizedError('Device is revoked or missing');
    const tool = (device.tools ?? []).find((item) => item.name === call.toolName);
    if (!tool || tool.schemaHash !== call.schemaHash) throw new ConflictError('Tool contract changed before execution');
    return { device, tool };
  }

  async startPairing({ deviceName, platform = 'unknown' }) {
    if (!deviceName || typeof deviceName !== 'string' || deviceName.length > 128) throw new Error('deviceName is required');
    const deviceCode = randomId('devcode_');
    const userCode = `${randomCode(4)}-${randomCode(4)}`;
    const deviceCodeHash = sha256(deviceCode);
    const userCodeHash = sha256(userCode.toUpperCase());
    const createdAt = Date.now();
    await this.store.transaction((state) => {
      if (Object.keys(state.pairings).length >= this.config.maxPairings) throw new Error('Pairing capacity reached');
      state.pairings[deviceCodeHash] = {
        id: randomId('pair_'), deviceCodeHash, userCodeHash,
        deviceName: deviceName.slice(0, 128), platform: String(platform).slice(0, 64),
        status: 'pending', createdAt: nowIso(createdAt), expiresAt: nowIso(createdAt + this.config.pairingTtlMs)
      };
      this.#appendAudit(state, { event: 'pairing.started', status: 'pending', metadata: { platform: String(platform).slice(0, 64) } });
    });
    return { device_code: deviceCode, user_code: userCode, expires_in: Math.floor(this.config.pairingTtlMs / 1000), interval: 3 };
  }

  async approvePairing(principal, userCode) {
    if (!hasScope(principal, 'devices:pair')) throw new ForbiddenError('devices:pair scope required');
    const hash = sha256(String(userCode ?? '').toUpperCase());
    let approved;
    await this.store.transaction((state) => {
      const pairing = Object.values(state.pairings).find((item) => item.userCodeHash === hash);
      if (!pairing) throw new NotFoundError('Pairing code not found');
      if (Date.parse(pairing.expiresAt) <= Date.now()) throw new ConflictError('Pairing code expired');
      if (pairing.status !== 'pending') throw new ConflictError(`Pairing is ${pairing.status}`);
      pairing.status = 'approved';
      pairing.approvedAt = nowIso();
      pairing.approvedBy = principal.sub;
      pairing.tenantId = principal.tenant;
      approved = { id: pairing.id, deviceName: pairing.deviceName, status: pairing.status };
      this.#appendAudit(state, { event: 'pairing.approved', tenantId: principal.tenant, principal: principal.sub, status: 'approved', metadata: { pairingId: pairing.id } });
    });
    return approved;
  }

  async pollPairing(deviceCode) {
    const deviceCodeHash = sha256(String(deviceCode ?? ''));
    let response;
    await this.store.transaction((state) => {
      const pairing = state.pairings[deviceCodeHash];
      if (!pairing) throw new NotFoundError('Pairing session not found');
      if (Date.parse(pairing.expiresAt) <= Date.now()) {
        pairing.status = 'expired';
        response = { status: 'expired' };
        return;
      }
      if (pairing.status === 'pending') { response = { status: 'pending' }; return; }
      if (pairing.status === 'consumed' && pairing.deviceId && pairing.deviceToken) {
        response = { status: 'approved', device_id: pairing.deviceId, device_token: this.cipher.open(pairing.deviceToken, `${pairing.id}:device-token`) };
        return;
      }
      if (pairing.status !== 'approved') throw new ConflictError(`Pairing is ${pairing.status}`);
      const deviceId = randomId('dev_');
      const device = {
        id: deviceId, tenantId: pairing.tenantId, name: pairing.deviceName, platform: pairing.platform,
        status: 'offline', mcpReady: false, tokenVersion: 1, tools: [], toolCatalogHash: null,
        createdAt: nowIso(), lastSeen: null, revokedAt: null
      };
      state.devices[deviceId] = device;
      pairing.status = 'consumed';
      pairing.deviceId = deviceId;
      pairing.consumedAt = nowIso();
      const token = this.tokenService.mint({ subject: `device:${deviceId}`, tenantId: device.tenantId, type: 'device', tokenVersion: device.tokenVersion, ttlSec: 90 * 24 * 60 * 60, scopes: DEVICE_SCOPES });
      pairing.deviceToken = this.cipher.seal(token, `${pairing.id}:device-token`);
      response = { status: 'approved', device_id: deviceId, device_token: token };
      this.#appendAudit(state, { event: 'device.paired', tenantId: device.tenantId, deviceId, status: 'offline', metadata: { pairingId: pairing.id, platform: device.platform } });
    });
    return response;
  }

  async assertDevicePrincipal(principal) {
    const state = await this.store.read();
    return deepClone(this.#deviceFromState(state, principal));
  }

  async refreshDeviceToken(principal) {
    if (!hasScope(principal, 'device:refresh')) throw new ForbiddenError('device:refresh scope required');
    let current;
    await this.store.transaction((state) => {
      const device = this.#deviceFromState(state, principal);
      current = deepClone(device);
      this.#appendAudit(state, { event: 'device.token_refreshed', tenantId: device.tenantId, principal: principal.sub, deviceId: device.id, status: device.status });
    });
    const token = this.tokenService.mint({ subject: `device:${current.id}`, tenantId: current.tenantId, type: 'device', tokenVersion: current.tokenVersion, ttlSec: 90 * 24 * 60 * 60, scopes: DEVICE_SCOPES });
    return { device_id: current.id, device_token: token, expires_in: 90 * 24 * 60 * 60 };
  }

  async registerDevice(principal, { deviceName, platform, tools, mcpReady = true }) {
    if (!hasScope(principal, 'device:register')) throw new ForbiddenError('device:register scope required');
    if (!Array.isArray(tools)) throw new Error('tools must be an array');
    if (tools.length > this.config.maxToolsPerDevice) throw new Error('tool catalog exceeds configured limit');
    const { tools: normalizedTools, hash: catalogHash } = normalizeToolCatalog(tools, { maxSchemaBytes: this.config.maxToolSchemaBytes });
    let result;
    let deviceId;
    await this.store.transaction((state) => {
      const device = this.#deviceFromState(state, principal);
      deviceId = device.id;
      device.name = String(deviceName || device.name).slice(0, 128);
      device.platform = String(platform || device.platform).slice(0, 64);
      device.tools = normalizedTools;
      device.toolCatalogHash = catalogHash;
      device.status = mcpReady ? 'online' : 'degraded';
      device.mcpReady = !!mcpReady;
      device.lastSeen = nowIso();
      result = publicDevice(device, this.config.heartbeatTtlMs);
      this.#appendAudit(state, { event: 'device.registered', tenantId: device.tenantId, deviceId: device.id, status: device.status, metadata: { toolCount: normalizedTools.length, toolCatalogHash: catalogHash } });
    });
    this.emit('device', { deviceId, type: 'registered' });
    return result;
  }

  async heartbeat(principal, { mcpReady = true, toolCatalogHash = undefined } = {}) {
    if (!hasScope(principal, 'device:heartbeat')) throw new ForbiddenError('device:heartbeat scope required');
    let result;
    await this.store.transaction((state) => {
      const device = this.#deviceFromState(state, principal);
      if (toolCatalogHash && device.toolCatalogHash && toolCatalogHash !== device.toolCatalogHash) {
        device.status = 'degraded'; device.mcpReady = false;
      } else {
        device.status = mcpReady ? 'online' : 'degraded'; device.mcpReady = !!mcpReady;
      }
      device.lastSeen = nowIso();
      result = publicDevice(device, this.config.heartbeatTtlMs);
    });
    return result;
  }

  async listDevices(principal) {
    if (!hasScope(principal, 'devices:read')) throw new ForbiddenError('devices:read scope required');
    const state = await this.store.read();
    return Object.values(state.devices).filter((device) => device.tenantId === principal.tenant)
      .map((device) => publicDevice(device, this.config.heartbeatTtlMs)).sort((a, b) => a.name.localeCompare(b.name));
  }

  async revokeDevice(principal, deviceId) {
    if (!hasScope(principal, 'devices:revoke')) throw new ForbiddenError('devices:revoke scope required');
    let result;
    await this.store.transaction((state) => {
      const device = state.devices[deviceId];
      if (!device || device.tenantId !== principal.tenant) throw new NotFoundError('Device not found');
      device.revokedAt = nowIso();
      device.status = 'revoked';
      device.mcpReady = false;
      device.tokenVersion += 1;
      result = publicDevice(device, this.config.heartbeatTtlMs);
      this.#appendAudit(state, { event: 'device.revoked', tenantId: principal.tenant, principal: principal.sub, deviceId, status: 'revoked' });
    });
    this.emit('device', { deviceId, type: 'revoked' });
    return result;
  }

  async projectedTools(principal) {
    if (!hasScope(principal, 'devices:read')) throw new ForbiddenError('devices:read scope required');
    const state = await this.store.read();
    const out = [];
    const names = new Set();
    for (const device of Object.values(state.devices)) {
      if (device.tenantId !== principal.tenant || device.revokedAt) continue;
      for (const tool of device.tools ?? []) {
        const projected = projectDeviceTool(publicDevice(device, this.config.heartbeatTtlMs), tool);
        if (names.has(projected.name)) throw new Error('Projected tool name collision detected');
        names.add(projected.name);
        out.push(projected);
      }
    }
    return out;
  }

  async resolveProjectedTool(principal, projectedName) {
    const state = await this.store.read();
    for (const device of Object.values(state.devices)) {
      if (device.tenantId !== principal.tenant || device.revokedAt) continue;
      for (const tool of device.tools ?? []) if (projectToolName(device, tool) === projectedName) return { device, tool };
    }
    throw new NotFoundError('Remote tool not found');
  }

  async createCall(principal, projectedName, args) {
    if (principal.typ !== 'user') throw new UnauthorizedError('User token required');
    const resolved = await this.resolveProjectedTool(principal, projectedName);
    const policy = this.policy.evaluate(principal, resolved.tool, args);
    if (policy.decision === 'deny') throw new PolicyDeniedError(policy.reason, { projectedName, capability: policy.capability, destructive: policy.destructive });
    if (!['auto', 'operator'].includes(policy.decision)) throw new PolicyDeniedError('Unsupported policy decision');
    const callId = randomId('call_');
    const createdMs = Date.now();
    const argsHash = sha256(args ?? {});
    const encryptedArgs = this.cipher.seal(args ?? {}, `${callId}:args`);
    const status = policy.decision === 'auto' ? 'queued' : 'awaiting_approval';
    let created;
    await this.store.transaction((state) => {
      if (Object.keys(state.calls).length >= this.config.maxCalls) throw new Error('Call capacity reached');
      const device = state.devices[resolved.device.id];
      if (!device || device.tenantId !== principal.tenant || device.revokedAt) throw new ConflictError('Device revoked or missing');
      const deviceView = publicDevice(device, this.config.heartbeatTtlMs);
      if (deviceView.status !== 'online' || !deviceView.mcpReady) throw new ConflictError('Device is offline or its local MCP is not ready');
      const tool = (device.tools ?? []).find((item) => item.name === resolved.tool.name && item.schemaHash === resolved.tool.schemaHash);
      if (!tool) throw new ConflictError('Tool contract changed before call creation');
      const call = {
        id: callId, tenantId: principal.tenant, principal: principal.sub, deviceId: device.id,
        projectedName, toolName: tool.name, schemaHash: tool.schemaHash, status, policy,
        argsHash, args: encryptedArgs, result: null, resultHash: null, error: null, errorHash: null, errorCode: null,
        createdAt: nowIso(createdMs), expiresAt: nowIso(createdMs + this.config.callTtlMs), approvedAt: null,
        approvedBy: null, claimedAt: null, completedAt: null, version: 1
      };
      state.calls[callId] = call;
      created = deepClone(call);
      this.#appendAudit(state, { event: 'call.created', tenantId: principal.tenant, principal: principal.sub, deviceId: device.id, callId, toolName: tool.name, status, policy, argsHash });
    });
    if (status === 'queued') this.#notifyQueued(created);
    return this.#publicCall(created, { includeResult: false });
  }

  async approveCall(principal, callId) {
    if (!hasScope(principal, 'calls:approve')) throw new ForbiddenError('calls:approve scope required');
    let queued;
    let expired = false;
    await this.store.transaction((state) => {
      const call = state.calls[callId];
      if (!call || call.tenantId !== principal.tenant) throw new NotFoundError('Call not found');
      if (call.status !== 'awaiting_approval') throw new ConflictError(`Call is ${call.status}`);
      if (Date.parse(call.expiresAt) <= Date.now()) {
        this.#expireCall(state, call, principal.sub); expired = true; return;
      }
      this.#toolForCall(state, call);
      call.status = 'queued'; call.approvedAt = nowIso(); call.approvedBy = principal.sub; call.version += 1;
      queued = deepClone(call);
      this.#appendAudit(state, { event: 'call.approved', tenantId: principal.tenant, principal: principal.sub, deviceId: call.deviceId, callId, toolName: call.toolName, status: call.status, policy: call.policy, argsHash: call.argsHash });
    });
    if (expired) throw new ConflictError('Call expired');
    this.#notifyQueued(queued);
    return this.#publicCall(queued, { includeResult: false });
  }

  async getOwnCall(principal, callId, { includeResult = true } = {}) {
    if (principal.typ !== 'user') throw new UnauthorizedError('User token required');
    const state = await this.store.read();
    const call = state.calls[callId];
    if (!call || call.tenantId !== principal.tenant || call.principal !== principal.sub) throw new NotFoundError('Call not found');
    return this.#publicCall(call, { includeResult });
  }

  async approveOwnCall(principal, callId) {
    if (principal.typ !== 'user') throw new UnauthorizedError('User token required');
    if (!hasScope(principal, 'calls:approve')) throw new ForbiddenError('calls:approve scope required');
    let queued;
    let expired = false;
    await this.store.transaction((state) => {
      const call = state.calls[callId];
      if (!call || call.tenantId !== principal.tenant || call.principal !== principal.sub) throw new NotFoundError('Call not found');
      if (call.status !== 'awaiting_approval') throw new ConflictError(`Call is ${call.status}`);
      if (Date.parse(call.expiresAt) <= Date.now()) { this.#expireCall(state, call, principal.sub); expired = true; return; }
      this.#toolForCall(state, call);
      call.status = 'queued'; call.approvedAt = nowIso(); call.approvedBy = principal.sub; call.version += 1;
      queued = deepClone(call);
      this.#appendAudit(state, { event: 'call.approved', tenantId: principal.tenant, principal: principal.sub, deviceId: call.deviceId, callId, toolName: call.toolName, status: call.status, policy: call.policy, argsHash: call.argsHash, metadata: { approvalChannel: 'mcp-mrtr' } });
    });
    if (expired) throw new ConflictError('Call expired');
    this.#notifyQueued(queued);
    return this.#publicCall(queued, { includeResult: false });
  }

  async cancelOwnCall(principal, callId, reason = 'declined') {
    if (principal.typ !== 'user') throw new UnauthorizedError('User token required');
    let cancelled;
    await this.store.transaction((state) => {
      const call = state.calls[callId];
      if (!call || call.tenantId !== principal.tenant || call.principal !== principal.sub) throw new NotFoundError('Call not found');
      if (call.status !== 'awaiting_approval') throw new ConflictError(`Call is ${call.status}`);
      const detail = { code: 'OPERATOR_DECLINED', message: `Operator ${String(reason).slice(0, 64)}` };
      call.status = 'cancelled'; call.errorCode = detail.code; call.errorHash = sha256(detail); call.error = this.cipher.seal(detail, `${call.id}:error`);
      call.completedAt = nowIso(); call.version += 1; cancelled = deepClone(call);
      this.#appendAudit(state, { event: 'call.cancelled', tenantId: call.tenantId, principal: principal.sub, deviceId: call.deviceId, callId, toolName: call.toolName, status: 'cancelled', policy: call.policy, argsHash: call.argsHash, metadata: { reason: String(reason).slice(0, 64), approvalChannel: 'mcp-mrtr' } });
    });
    this.#settleWaiters(callId);
    return this.#publicCall(cancelled, { includeResult: false });
  }

  async listQueuedForDevice(principal) {
    const state = await this.store.read();
    const device = this.#deviceFromState(state, principal);
    const now = Date.now();
    return Object.values(state.calls).filter((call) => call.deviceId === device.id && call.status === 'queued' && Date.parse(call.expiresAt) > now)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((call) => ({ callId: call.id, version: call.version, toolName: call.toolName }));
  }

  async claimCall(principal, callId) {
    if (!hasScope(principal, 'call:claim')) throw new ForbiddenError('call:claim scope required');
    let claimed;
    let expired = false;
    await this.store.transaction((state) => {
      const device = this.#deviceFromState(state, principal);
      const call = state.calls[callId];
      if (!call || call.deviceId !== device.id || call.tenantId !== device.tenantId) throw new NotFoundError('Call not found');
      if (Date.parse(call.expiresAt) <= Date.now()) {
        if (!TERMINAL.has(call.status)) this.#expireCall(state, call, principal.sub);
        expired = true; return;
      }
      if (call.status !== 'queued') throw new ConflictError(`Call is ${call.status}`);
      this.#toolForCall(state, call);
      call.status = 'executing'; call.claimedAt = nowIso(); call.version += 1; claimed = deepClone(call);
      this.#appendAudit(state, { event: 'call.claimed', tenantId: call.tenantId, principal: principal.sub, deviceId: device.id, callId, toolName: call.toolName, status: 'executing', policy: call.policy, argsHash: call.argsHash });
    });
    if (expired) throw new ConflictError('Call expired');
    return { callId: claimed.id, toolName: claimed.toolName, schemaHash: claimed.schemaHash, args: this.cipher.open(claimed.args, `${claimed.id}:args`), expiresAt: claimed.expiresAt, version: claimed.version };
  }

  async completeCall(principal, callId, result) {
    if (!hasScope(principal, 'call:complete')) throw new ForbiddenError('call:complete scope required');
    if (jsonSize(result) > this.config.maxBodyBytes) throw new Error('result exceeds configured body limit');
    const resultHash = sha256(result);
    let completed;
    await this.store.transaction((state) => {
      const device = this.#deviceFromState(state, principal);
      const call = state.calls[callId];
      if (!call || call.deviceId !== device.id || call.tenantId !== device.tenantId) throw new NotFoundError('Call not found');
      if (call.status === 'completed') {
        if (call.resultHash !== resultHash) throw new ConflictError('Call already completed with a different result');
        completed = deepClone(call); return;
      }
      if (!['executing', 'unknown'].includes(call.status)) throw new ConflictError(`Call is ${call.status}`);
      call.status = 'completed'; call.resultHash = resultHash; call.result = this.cipher.seal(result, `${callId}:result`);
      call.error = null; call.errorHash = null; call.errorCode = null; call.completedAt = nowIso(); call.version += 1; completed = deepClone(call);
      this.#appendAudit(state, { event: 'call.completed', tenantId: call.tenantId, principal: principal.sub, deviceId: device.id, callId, toolName: call.toolName, status: 'completed', policy: call.policy, argsHash: call.argsHash, resultHash });
    });
    this.#settleWaiters(callId); this.emit('result', { callId, status: 'completed' });
    return this.#publicCall(completed, { includeResult: true });
  }

  async failCall(principal, callId, error) {
    if (!hasScope(principal, 'call:complete')) throw new ForbiddenError('call:complete scope required');
    const detail = { code: String(error?.code || error?.name || 'LOCAL_EXECUTION_FAILED').slice(0, 128), message: String(error?.message ?? error ?? 'Remote tool failed').slice(0, 2000) };
    const errorHash = sha256(detail);
    let failed;
    await this.store.transaction((state) => {
      const device = this.#deviceFromState(state, principal);
      const call = state.calls[callId];
      if (!call || call.deviceId !== device.id || call.tenantId !== device.tenantId) throw new NotFoundError('Call not found');
      if (call.status === 'failed') { if (call.errorHash !== errorHash) throw new ConflictError('Call already failed with different detail'); failed = deepClone(call); return; }
      if (call.status !== 'executing') throw new ConflictError(`Call is ${call.status}`);
      call.status = 'failed'; call.errorCode = detail.code; call.errorHash = errorHash; call.error = this.cipher.seal(detail, `${callId}:error`);
      call.completedAt = nowIso(); call.version += 1; failed = deepClone(call);
      this.#appendAudit(state, { event: 'call.failed', tenantId: call.tenantId, principal: principal.sub, deviceId: device.id, callId, toolName: call.toolName, status: 'failed', policy: call.policy, argsHash: call.argsHash, metadata: { errorClass: detail.code } });
    });
    this.#settleWaiters(callId); this.emit('result', { callId, status: 'failed' });
    return this.#publicCall(failed, { includeResult: false });
  }

  async markCallUnknown(principal, callId, reason = 'execution_outcome_unknown') {
    if (!hasScope(principal, 'call:complete')) throw new ForbiddenError('call:complete scope required');
    let unknown;
    await this.store.transaction((state) => {
      const device = this.#deviceFromState(state, principal);
      const call = state.calls[callId];
      if (!call || call.deviceId !== device.id || call.tenantId !== device.tenantId) throw new NotFoundError('Call not found');
      if (call.status === 'unknown') { unknown = deepClone(call); return; }
      if (call.status !== 'executing') throw new ConflictError(`Call is ${call.status}`);
      call.status = 'unknown'; call.errorCode = 'EXECUTION_OUTCOME_UNKNOWN'; call.errorHash = null; call.error = null;
      call.completedAt = nowIso(); call.version += 1; unknown = deepClone(call);
      this.#appendAudit(state, { event: 'call.unknown', tenantId: call.tenantId, principal: principal.sub, deviceId: device.id, callId, toolName: call.toolName, status: 'unknown', policy: call.policy, argsHash: call.argsHash, metadata: { reason: String(reason).slice(0, 64) } });
    });
    this.#settleWaiters(callId); this.emit('result', { callId, status: 'unknown' });
    return this.#publicCall(unknown, { includeResult: false });
  }

  async getCall(principal, callId, { includeResult = true } = {}) {
    if (!hasScope(principal, 'calls:read')) throw new ForbiddenError('calls:read scope required');
    const state = await this.store.read(); const call = state.calls[callId];
    if (!call || call.tenantId !== principal.tenant) throw new NotFoundError('Call not found');
    return this.#publicCall(call, { includeResult });
  }

  async listCalls(principal, { limit = 50 } = {}) {
    if (!hasScope(principal, 'calls:read')) throw new ForbiddenError('calls:read scope required');
    const state = await this.store.read();
    return Object.values(state.calls).filter((call) => call.tenantId === principal.tenant)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)).slice(0, Math.max(1, Math.min(200, limit)))
      .map((call) => this.#publicCall(call, { includeResult: false }));
  }

  async waitForCall(principal, callId, timeoutMs = this.config.syncWaitMs) {
    const current = await this.getCall(principal, callId, { includeResult: true });
    if (TERMINAL.has(current.status) || timeoutMs <= 0) return current;
    await this.#wait(callId, timeoutMs);
    return this.getCall(principal, callId, { includeResult: true });
  }

  async waitForOwnCall(principal, callId, timeoutMs = this.config.syncWaitMs) {
    const current = await this.getOwnCall(principal, callId, { includeResult: true });
    if (TERMINAL.has(current.status) || timeoutMs <= 0) return current;
    await this.#wait(callId, timeoutMs);
    return this.getOwnCall(principal, callId, { includeResult: true });
  }

  async #wait(callId, timeoutMs) {
    await new Promise((resolve) => {
      const set = this.waiters.get(callId) ?? new Set(); set.add(resolve); this.waiters.set(callId, set);
      const timer = setTimeout(() => { set.delete(resolve); if (set.size === 0) this.waiters.delete(callId); resolve(); }, timeoutMs);
      timer.unref?.();
    });
  }

  async verifyAudit(principal) {
    if (!hasScope(principal, 'audit:read')) throw new ForbiddenError('audit:read scope required');
    const state = await this.store.read();
    const receipts = state.receipts.filter((receipt) => !receipt.tenantId || receipt.tenantId === principal.tenant);
    const full = this.audit.verify(state.receipts);
    return { ...full, visibleReceipts: receipts.length, stateRevision: state.revision };
  }

  async cleanup(now = Date.now()) {
    const settledCallIds = [];
    const offlineDeviceIds = [];
    await this.store.transaction((state) => {
      for (const [key, pairing] of Object.entries(state.pairings)) {
        if (!['consumed', 'expired'].includes(pairing.status) && Date.parse(pairing.expiresAt) <= now) pairing.status = 'expired';
        const terminalAt = Date.parse(pairing.consumedAt || pairing.expiresAt || pairing.createdAt);
        if (['consumed', 'expired'].includes(pairing.status) && Number.isFinite(terminalAt) && now - terminalAt > this.config.pairingRetentionMs) delete state.pairings[key];
      }
      for (const [callId, call] of Object.entries(state.calls)) {
        if (!TERMINAL.has(call.status) && Date.parse(call.expiresAt) <= now) {
          if (call.status === 'executing') {
            call.status = 'unknown'; call.errorCode = 'EXECUTION_OUTCOME_UNKNOWN'; call.completedAt = nowIso(now); call.version += 1;
            this.#appendAudit(state, { event: 'call.unknown', tenantId: call.tenantId, deviceId: call.deviceId, callId: call.id, toolName: call.toolName, status: 'unknown', policy: call.policy, argsHash: call.argsHash, metadata: { reason: 'execution_lease_expired' } });
          } else this.#expireCall(state, call);
          settledCallIds.push(call.id);
        }
        const terminalAt = Date.parse(call.completedAt || call.expiresAt || call.createdAt);
        if (TERMINAL.has(call.status) && Number.isFinite(terminalAt) && now - terminalAt > this.config.terminalCallRetentionMs) delete state.calls[callId];
      }
      for (const device of Object.values(state.devices)) {
        if (device.revokedAt || !device.lastSeen) continue;
        if (now - Date.parse(device.lastSeen) > this.config.heartbeatTtlMs && device.status !== 'offline') {
          device.status = 'offline'; device.mcpReady = false; offlineDeviceIds.push(device.id);
        }
      }
    });
    for (const callId of settledCallIds) this.#settleWaiters(callId);
    for (const deviceId of offlineDeviceIds) this.emit('device', { deviceId, type: 'offline' });
    return { settledCalls: settledCallIds.length, offlineDevices: offlineDeviceIds.length };
  }

  #expireCall(state, call, principal = null) {
    call.status = 'expired'; call.errorCode = 'CALL_EXPIRED'; call.completedAt = nowIso(); call.version += 1;
    this.#appendAudit(state, { event: 'call.expired', tenantId: call.tenantId, principal, deviceId: call.deviceId, callId: call.id, toolName: call.toolName, status: 'expired', policy: call.policy, argsHash: call.argsHash });
  }

  #notifyQueued(call) { this.emit('call', { deviceId: call.deviceId, callId: call.id }); }
  #settleWaiters(callId) { const set = this.waiters.get(callId); if (!set) return; this.waiters.delete(callId); for (const resolve of set) resolve(); }

  #publicCall(call, { includeResult }) {
    const out = {
      id: call.id, deviceId: call.deviceId, toolName: call.toolName, projectedName: call.projectedName,
      schemaHash: call.schemaHash, status: call.status, policy: call.policy, argsHash: call.argsHash,
      resultHash: call.resultHash, error: call.errorCode ?? null, createdAt: call.createdAt, expiresAt: call.expiresAt,
      approvedAt: call.approvedAt, approvedBy: call.approvedBy, claimedAt: call.claimedAt, completedAt: call.completedAt, version: call.version
    };
    if (includeResult && call.status === 'completed' && call.result) out.result = this.cipher.open(call.result, `${call.id}:result`);
    if (includeResult && call.error) out.errorDetail = this.cipher.open(call.error, `${call.id}:error`);
    return out;
  }
}