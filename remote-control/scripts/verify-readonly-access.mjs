import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';
import {
  MODERN_PROTOCOL_VERSION, PROTOCOL_VERSION_META_KEY,
  CLIENT_CAPABILITIES_META_KEY, SERVER_INFO_META_KEY
} from '../src/mcp-protocol.js';

export const PLAN_SCHEMA = 'nymrel.remote.readonly-acceptance.v1';
export const ACCESS_TOKEN_ENV = 'NYMREL_REMOTE_READONLY_ACCESS_TOKEN';
const RESOURCE_PATH = '/chatgpt/readonly/mcp';
const READ_TOOLS = ['list_devices', 'read_file', 'list_directory', 'get_file_info', 'search_files', 'search_content', 'get_read_result'];
const PLAN_KEYS = ['schema', 'baseUrl', 'expectedIssuer', 'deviceId', 'deviceName', 'projectRoot', 'probeFile', 'lineCount', 'expectedLineSha256', 'deniedAncestor', 'nonsecretProbeApproved', 'hasPredefinedClient'];
const MAX_RESPONSE_BYTES = 256 * 1024;
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
class Stop extends Error { constructor(code) { super(code); this.code = code; } }
const insist = (condition, code) => { if (!condition) throw new Stop(code); };
const text = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && v === v.trim() && !/[\u0000-\u001f\u007f]/.test(v);

function httpsUrl(value, originOnly = false) {
  insist(text(value, 2048), 'INVALID_PLAN_URL');
  let url;
  try { url = new URL(value); } catch { throw new Stop('INVALID_PLAN_URL'); }
  insist(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'INVALID_PLAN_URL');
  insist(!isIP(url.hostname.replace(/^\[|\]$/g, '')) && url.hostname.includes('.') &&
    !/(^|\.)(localhost|local|internal)$/.test(url.hostname), 'INVALID_PLAN_URL');
  insist(!url.port || url.port === '443', 'INVALID_PLAN_URL');
  if (originOnly) insist(value === url.origin, 'INVALID_PLAN_URL');
  else insist(value === url.href || (url.pathname === '/' && value === url.origin), 'INVALID_PLAN_URL');
  return url;
}

function absoluteProjectPath(value) {
  insist(text(value, 2048), 'INVALID_PLAN_PATH');
  const win = /^[A-Za-z]:[\\/]/.test(value);
  const p = win ? path.win32 : path.posix;
  insist(win || value.startsWith('/'), 'INVALID_PLAN_PATH');
  insist(!value.startsWith('//') && !value.startsWith('\\\\'), 'INVALID_PLAN_PATH');
  const tail = win ? value.slice(2) : value;
  insist(!tail.includes(':') && !tail.split(/[\\/]/).some((v) => v === '.' || v === '..'), 'INVALID_PLAN_PATH');
  const normalized = p.normalize(value);
  insist(normalized === value && normalized !== p.parse(normalized).root, 'INVALID_PLAN_PATH');
  return { p, win, value: normalized, folded: win ? normalized.toLowerCase() : normalized };
}
function inside(parent, child) {
  if (parent.win !== child.win) return false;
  const relative = parent.p.relative(parent.folded, child.folded);
  return relative !== '' && !relative.startsWith('..') && !parent.p.isAbsolute(relative);
}
function stagedShareIndexProbe(root, file, denied) {
  if (!root.win || !file.win || !denied.win) return false;
  if (!/^[a-z]:\\users\\[^\\]+\\appdata\\local\\nymrel\\chatgptstudioshare-\d{8}$/.test(root.folded)) return false;
  return file.folded === root.folded + '\\index.md' &&
    denied.folded === path.win32.dirname(root.folded);
}

export function validatePlan(input) {
  insist(record(input) && Object.keys(input).every((key) => PLAN_KEYS.includes(key) || key === 'verifiedDynamicClient') &&
    PLAN_KEYS.every((key) => Object.hasOwn(input, key)), 'INVALID_PLAN');
  insist(input.schema === PLAN_SCHEMA && input.nonsecretProbeApproved === true &&
    typeof input.hasPredefinedClient === 'boolean', 'INVALID_PLAN');
  insist(!Object.hasOwn(input, 'verifiedDynamicClient') ||
    (['cimd', 'dcr'].includes(input.verifiedDynamicClient) && !input.hasPredefinedClient), 'INVALID_PLAN');
  httpsUrl(input.baseUrl, true);
  httpsUrl(input.expectedIssuer);
  insist(text(input.deviceId, 256) && text(input.deviceName, 128), 'INVALID_DEVICE_PLAN');
  const root = absoluteProjectPath(input.projectRoot);
  const file = absoluteProjectPath(input.probeFile);
  const denied = absoluteProjectPath(input.deniedAncestor);
  insist(inside(root, file) && inside(denied, root), 'INVALID_PLAN_PATH');
  const stagedIndex = stagedShareIndexProbe(root, file, denied);
  insist(stagedIndex || !/(^|[\\/])(\.ssh|\.aws|\.azure|\.config|\.nymrel-remote|AppData)([\\/]|$)/i.test(input.probeFile), 'INVALID_PLAN_PATH');
  insist(stagedIndex || ['readme.md', 'agents.md', 'claude.md', 'presence.md'].includes(file.p.basename(file.value).toLowerCase()), 'INVALID_PROBE_FILE');
  insist(Number.isSafeInteger(input.lineCount) && input.lineCount >= 1 && input.lineCount <= 100, 'INVALID_LINE_COUNT');
  insist(typeof input.expectedLineSha256 === 'string' && /^[a-f0-9]{64}$/.test(input.expectedLineSha256), 'INVALID_PROBE_DIGEST');
  return structuredClone(input);
}

// A bounded, non-redirecting transport. Public discovery never receives the real token.
// This is origin pinning, not a DNS/IP egress sandbox.
export function boundedTransport(plan, fetchImpl = fetch, now = Date.now) {
  const origins = new Set([new URL(plan.baseUrl).origin, new URL(plan.expectedIssuer).origin]);
  const endpoint = `${plan.baseUrl}${RESOURCE_PATH}`;
  const deadline = now() + 90_000;
  let requests = 0;
  return async (input, init = {}) => {
    const url = new URL(input);
    insist(origins.has(url.origin) && url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash, 'UNAPPROVED_DESTINATION');
    const method = init.method || 'GET';
    insist(method === 'GET' || (method === 'POST' && url.href === endpoint), 'UNAPPROVED_METHOD');
    const headers = new Headers(init.headers);
    insist(!headers.has('authorization') || (method === 'POST' && url.href === endpoint), 'CREDENTIAL_DESTINATION_REFUSED');
    insist(++requests <= 24 && now() < deadline, 'REQUEST_BUDGET_EXHAUSTED');
    const timeout = Math.min(method === 'POST' ? 30_000 : 8_000, deadline - now());
    let response;
    try {
      response = await fetchImpl(url.href, { ...init, method, headers, redirect: 'error', signal: AbortSignal.timeout(timeout) });
    } catch { throw new Stop('NETWORK_OR_TIMEOUT'); }
    insist(response.status < 300 || response.status >= 400, 'REDIRECT_REFUSED');
    const declared = response.headers.get('content-length');
    if (declared !== null) insist(/^\d+$/.test(declared) && Number(declared) <= MAX_RESPONSE_BYTES, 'RESPONSE_TOO_LARGE');
    const reader = response.body?.getReader();
    const chunks = []; let size = 0;
    if (reader) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          insist(size <= MAX_RESPONSE_BYTES, 'RESPONSE_TOO_LARGE');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
    }
    // Do not expose response bodies, exception messages, paths, or token material in reports.
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
    return new Response(response.status === 204 || response.status === 304 ? null : bytes, { status: response.status, headers: response.headers });
  };
}

async function defaultPublicCheck(baseUrl, options) {
  const { checkProductionCutover } = await import('./check-production-cutover.mjs');
  return checkProductionCutover(baseUrl, options);
}
function usableResult(result) {
  insist(record(result) && result.resultType === 'complete', 'MCP_RESULT_INCOMPLETE');
  insist(result._meta?.[SERVER_INFO_META_KEY]?.name === '@nymrel/remote-control', 'MCP_SERVER_MISMATCH');
  insist(!result.structuredContent?.pending && !result.structuredContent?.approvalRequired &&
    !result.structuredContent?.call, 'DEVICE_CALL_NOT_COMPLETED');
  insist(result.isError !== true && record(result.structuredContent), 'DEVICE_TOOL_FAILED');
  return result.structuredContent;
}
function deniedByRoot(result, expectedPath) {
  if (!record(result) || result.resultType !== 'complete' || result.isError !== true) return false;
  if (result._meta?.[SERVER_INFO_META_KEY]?.name !== '@nymrel/remote-control') return false;
  const data = result.structuredContent;
  if (!record(data) || data.pending || data.approvalRequired ||
      (data.call && data.call.status !== 'failed')) return false;
  // The native backend can return either a tool error or a broker-recorded failed call.
  const message = data?.error?.message ?? (data?.call?.status === 'failed' ? data.call.error : null);
  const prefix = 'Path is outside allowed directories: ';
  if (typeof message !== 'string' || !message.startsWith(prefix)) return false;
  try {
    const denied = absoluteProjectPath(message.slice(prefix.length));
    const expected = absoluteProjectPath(expectedPath);
    return denied.win === expected.win && denied.folded === expected.folded;
  } catch { return false; }
}

/** Run only read-only protocol operations. The CLI report is deliberately not a release attestation. */
export async function verifyReadonlyAccess({ plan: input, accessToken, fetchImpl = fetch, publicCheck = defaultPublicCheck, now = Date.now } = {}) {
  const report = { schema: 'nymrel.remote.readonly-acceptance-result.v1', status: 'blocked',
    checkedAt: new Date(now()).toISOString(), client: 'operator-cli', checks: [], failure: null,
    chatgptVerified: false, refreshVerified: false, allRootsCertified: false, productionReady: false };
  const passed = (name) => report.checks.push({ name, passed: true });
  try {
    const plan = validatePlan(input); passed('plan_valid');
    const transport = boundedTransport(plan, fetchImpl, now);
    const metadataUrl = `${plan.baseUrl}/.well-known/oauth-protected-resource${RESOURCE_PATH}`;
    const response = await transport(metadataUrl);
    insist(response.status === 200, 'READONLY_ROUTE_NOT_PUBLISHED');
    const metadata = await response.json();
    insist(metadata.resource === `${plan.baseUrl}${RESOURCE_PATH}` &&
      Array.isArray(metadata.authorization_servers) && metadata.authorization_servers.length === 1 &&
      metadata.authorization_servers[0] === plan.expectedIssuer, 'ISSUER_OR_RESOURCE_MISMATCH');
    passed('expected_issuer_and_resource');
    const readiness = await publicCheck(plan.baseUrl, { profile: 'readonly', requireOAuth: true,
      hasPredefinedClient: plan.hasPredefinedClient, verifiedDynamicClient: plan.verifiedDynamicClient ?? null, fetchImpl: transport });
    insist(readiness?.status === 'ready' && readiness?.profile === 'readonly' && readiness?.requireOAuth === true, 'PUBLIC_CUTOVER_BLOCKED');
    // The strict probe fetches metadata independently: bind its observed issuer too.
    const issuerCheck = readiness.checks?.find((item) => item.name === 'authorization-server metadata');
    insist(issuerCheck?.passed === true && issuerCheck.detail?.issuer === plan.expectedIssuer &&
      issuerCheck.detail?.expectedIssuer === plan.expectedIssuer, 'STRICT_ISSUER_PIN_MISMATCH');
    passed('strict_public_cutover');
    insist(typeof accessToken === 'string' && accessToken.length >= 16 && accessToken.length <= 16384 &&
      /^[A-Za-z0-9._~+\/-]+=*$/.test(accessToken), 'ACCESS_TOKEN_REQUIRED');
    let sequence = 0;
    const rpc = async (method, params = {}) => {
      const id = ++sequence;
      const body = { jsonrpc: '2.0', id, method, params: { ...params,
        _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_META_KEY]: {} } } };
      const reply = await transport(`${plan.baseUrl}${RESOURCE_PATH}`, { method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream',
          'mcp-protocol-version': MODERN_PROTOCOL_VERSION, 'mcp-method': method,
          ...(method === 'tools/call' ? { 'mcp-name': params.name } : {}), authorization: `Bearer ${accessToken}` },
        body: JSON.stringify(body) });
      insist(reply.status !== 401 && reply.status !== 403, 'AUTHORIZATION_REJECTED');
      insist(reply.status === 200 && /\bapplication\/json\b/i.test(reply.headers.get('content-type') || ''), 'MCP_HTTP_FAILED');
      const data = await reply.json();
      insist(data.jsonrpc === '2.0' && data.id === id && !Object.hasOwn(data, 'error') && record(data.result), 'MCP_PROTOCOL_FAILED');
      return data.result;
    };
    const catalog = await rpc('tools/list');
    insist(catalog.resultType === 'complete' && catalog._meta?.[SERVER_INFO_META_KEY]?.name === '@nymrel/remote-control' &&
      Array.isArray(catalog.tools) && catalog.tools.length === READ_TOOLS.length && !catalog.nextCursor, 'READONLY_CATALOG_MISMATCH');
    const names = catalog.tools.map((tool) => tool.name);
    insist(new Set(names).size === names.length && READ_TOOLS.every((name) => names.includes(name)) &&
      catalog.tools.every((tool) => tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false && tool.annotations?.openWorldHint === false), 'READONLY_CATALOG_MISMATCH');
    passed('readonly_tool_catalog');
    const devices = usableResult(await rpc('tools/call', { name: 'list_devices', arguments: {} })).devices;
    insist(Array.isArray(devices), 'DEVICE_LIST_INVALID');
    const matched = devices.filter((device) => device.id === plan.deviceId);
    insist(matched.length === 1 && matched[0].name === plan.deviceName && matched[0].status === 'online' && matched[0].mcpReady === true, 'DEVICE_IDENTITY_OR_READINESS_FAILED');
    passed('exact_device_online');
    const denial = await rpc('tools/call', { name: 'get_file_info', arguments: { device: plan.deviceId, path: plan.deniedAncestor } });
    insist(deniedByRoot(denial, plan.deniedAncestor), 'ROOT_DENIAL_NOT_PROVEN'); passed('ancestor_metadata_denied');
    const window = usableResult(await rpc('tools/call', { name: 'read_file',
      arguments: { device: plan.deviceId, path: plan.probeFile, offset: 0, length: plan.lineCount } }));
    const returnedPath = absoluteProjectPath(window.path);
    const requestedPath = absoluteProjectPath(plan.probeFile);
    insist(returnedPath.win === requestedPath.win && returnedPath.folded === requestedPath.folded, 'PROBE_PATH_MISMATCH');
    insist(typeof window.text === 'string' && window.start === 0 && Number.isSafeInteger(window.totalLines) &&
      window.totalLines > 0 && window.end === Math.min(plan.lineCount, window.totalLines) &&
      window.text.split('\n').length === window.end, 'PROBE_WINDOW_INVALID');
    insist(createHash('sha256').update(window.text, 'utf8').digest('hex') === plan.expectedLineSha256, 'PROBE_DIGEST_MISMATCH');
    passed('known_nonsecret_file_matches'); report.status = 'roundtrip_pass';
  } catch (error) {
    report.failure = error instanceof Stop ? error.code : 'VALIDATION_OR_TRANSPORT_FAILED';
  }
  return report;
}

export async function runCli(argv = process.argv.slice(2), env = process.env, write = (value) => console.log(value)) {
  // The token is never a command-line argument, child-process argument, or written artifact.
  const token = env[ACCESS_TOKEN_ENV];
  delete env[ACCESS_TOKEN_ENV];
  if (argv.length !== 2 || argv[0] !== '--plan') {
    write(JSON.stringify({ status: 'blocked', failure: 'USAGE: --plan <private-plan.json>' })); return 2;
  }
  let input;
  try {
    const handle = await fs.open(argv[1], 'r');
    try {
      insist((await handle.stat()).isFile(), 'PLAN_NOT_REGULAR_FILE');
      const bytes = Buffer.alloc(32769); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      insist(bytesRead <= 32768, 'PLAN_TOO_LARGE');
      input = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    } finally { await handle.close(); }
  } catch { write(JSON.stringify({ status: 'blocked', failure: 'PLAN_UNREADABLE_OR_INVALID' })); return 2; }
  const result = await verifyReadonlyAccess({ plan: input, accessToken: token });
  write(JSON.stringify(result, null, 2));
  return result.status === 'roundtrip_pass' ? 0 : 1;
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) process.exitCode = await runCli();
