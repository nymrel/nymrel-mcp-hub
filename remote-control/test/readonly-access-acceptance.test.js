import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { PLAN_SCHEMA, ACCESS_TOKEN_ENV, validatePlan, verifyReadonlyAccess, boundedTransport, runCli } from '../scripts/verify-readonly-access.mjs';

const TOKEN = 'fixture-only-no-live-credential';
const CONTENT = '# Fixture README\nNonsecret acceptance fixture.';
const hash = (s) => createHash('sha256').update(s).digest('hex');
const SERVER_KEY = 'io.modelcontextprotocol/serverInfo';
const NAMES = ['list_devices', 'read_file', 'list_directory', 'get_file_info', 'search_files', 'search_content', 'get_read_result'];
const config = (extra = {}) => ({ schema: PLAN_SCHEMA, baseUrl: 'https://remote.example.test',
  expectedIssuer: 'https://issuer.example.test/', deviceId: 'fixture-device-1', deviceName: 'JalenPC',
  projectRoot: 'C:\\Users\\fixture\\projects\\builderwars', probeFile: 'C:\\Users\\fixture\\projects\\builderwars\\README.md',
  lineCount: 2, expectedLineSha256: hash(CONTENT), deniedAncestor: 'C:\\Users\\fixture',
  nonsecretProbeApproved: true, hasPredefinedClient: false, ...extra });
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const result = (data = {}) => ({ resultType: 'complete', _meta: { [SERVER_KEY]: { name: '@nymrel/remote-control', version: '0.1.0' } }, ...data });
const structured = (value, extra = {}) => result({ content: [{ type: 'text', text: 'not printed' }], structuredContent: value, isError: false, ...extra });
function fixture({ mutate, publicStatus = 'ready', metadataStatus = 200, plan = config(), metadataChange } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    if (init.method === 'GET') {
      assert.equal(new Headers(init.headers).has('authorization'), false);
      let metadata = { resource: `${plan.baseUrl}/chatgpt/readonly/mcp`, authorization_servers: [plan.expectedIssuer] };
      if (metadataChange) metadata = metadataChange(metadata);
      return json(metadata, metadataStatus);
    }
    assert.equal(url, `${plan.baseUrl}/chatgpt/readonly/mcp`);
    assert.equal(init.redirect, 'error');
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${TOKEN}`);
    assert.equal(new Headers(init.headers).get('mcp-method'), body.method);
    assert.equal(body.params._meta['io.modelcontextprotocol/protocolVersion'], '2026-07-28');
    let value;
    if (body.method === 'tools/list') value = result({ tools: NAMES.map((name) => ({ name,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } })) });
    else if (body.params.name === 'list_devices') value = structured({ devices: [{ id: plan.deviceId, name: plan.deviceName, status: 'online', mcpReady: true }] });
    else if (body.params.name === 'get_file_info') value = structured({ call: { status: 'failed', error: `Path is outside allowed directories: ${plan.deniedAncestor}` } }, { isError: true });
    else if (body.params.name === 'read_file') value = structured({ path: plan.probeFile, text: CONTENT, start: 0, end: 2, totalLines: 2 });
    else assert.fail('unexpected operation');
    let envelope = { jsonrpc: '2.0', id: body.id, result: value };
    if (mutate) envelope = mutate(envelope, body);
    return envelope instanceof Response ? envelope : json(envelope);
  };
  const publicCheck = async (_base, options) => {
    assert.equal(options.requireOAuth, true); assert.equal(options.profile, 'readonly');
    assert.equal(typeof options.fetchImpl, 'function');
    return { status: publicStatus, profile: 'readonly', requireOAuth: true, checks: [
      { name: 'authorization-server metadata', passed: true, detail: { issuer: plan.expectedIssuer, expectedIssuer: plan.expectedIssuer } }
    ] };
  };
  return { plan, fetchImpl, publicCheck, accessToken: TOKEN, calls };
}
async function expectBlocked(f, failure) {
  const report = await verifyReadonlyAccess(f);
  assert.equal(report.status, 'blocked'); assert.equal(report.failure, failure);
  return report;
}

test('valid plan is cloned and Windows-safe; unknown fields and approvals fail closed', () => {
  const p = config(); assert.deepEqual(validatePlan(p), p); assert.notEqual(validatePlan(p), p);
  for (const extra of [{ arbitrary: true }, { nonsecretProbeApproved: false }, { schema: 'wrong' }, { hasPredefinedClient: 'yes' }]) assert.throws(() => validatePlan(config(extra)));
});
test('URLs reject HTTP, credentials, queries, fragments, private/literal hosts and base paths', () => {
  for (const baseUrl of ['http://remote.example.test', 'https://a:b@remote.example.test', 'https://remote.example.test?x=1', 'https://remote.example.test/#a', 'https://127.0.0.1', 'https://localhost', 'https://foo.internal', 'https://remote.example.test/path', 'https://remote.example.test:8080', 'https://remote.example.test/']) assert.throws(() => validatePlan(config({ baseUrl })));
  assert.equal(validatePlan(config()).expectedIssuer, 'https://issuer.example.test/');
  assert.equal(validatePlan(config({ expectedIssuer: 'https://issuer.example.test' })).expectedIssuer, 'https://issuer.example.test');
});
test('invalid file plans, traversal, UNC, ADS, credentials and non-markdown probes refused', () => {
  for (const extra of [
    { probeFile: 'C:\\Users\\fixture\\projects\\builderwars\\..\\README.md' },
    { probeFile: '\\\\host\\share\\README.md' }, { probeFile: 'C:\\Users\\fixture\\projects\\builderwars\\README.md:stream' },
    { probeFile: 'C:\\Users\\fixture\\projects\\builderwars\\.ssh\\README.md' },
    { probeFile: 'C:\\Users\\fixture\\projects\\builderwars\\.env' },
    { deniedAncestor: 'C:\\unrelated' }, { projectRoot: 'C:\\Users\\fixture' },
    { lineCount: 0 }, { lineCount: 101 }, { lineCount: 1.5 }, { expectedLineSha256: 'not-a-hash' }
  ]) assert.throws(() => validatePlan(config(extra)));
});
test('POSIX projects supported without claiming platform-specific confinement', () => {
  assert.ok(validatePlan(config({ projectRoot: '/srv/projects/demo', probeFile: '/srv/projects/demo/README.md', deniedAncestor: '/srv' })));
});
test('the staged ChatGPTStudio share permits only its INDEX probe under AppData', () => {
  const share = 'C:\\Users\\fixture\\AppData\\Local\\Nymrel\\ChatGPTStudioShare-20260922';
  const parent = 'C:\\Users\\fixture\\AppData\\Local\\Nymrel';
  const plan = config({ projectRoot: share, probeFile: `${share}\\INDEX.md`, deniedAncestor: parent,
    deviceName: 'JalenPC-ChatGPTStudio' });
  assert.deepEqual(validatePlan(plan), plan);
  for (const extra of [
    { projectRoot: parent, probeFile: `${parent}\\INDEX.md` },
    { projectRoot: `${parent}\\OtherShare-20260922`, probeFile: `${parent}\\OtherShare-20260922\\INDEX.md` },
    { projectRoot: `${parent}\\ChatGPTStudioShare-today`, probeFile: `${parent}\\ChatGPTStudioShare-today\\INDEX.md` },
    { probeFile: `${share}\\README.md` },
    { probeFile: `${share}\\secrets\\INDEX.md` },
    { deniedAncestor: 'C:\\Users\\fixture\\AppData\\Local' }
  ]) assert.throws(() => validatePlan({ ...plan, ...extra }));
});
test('the staged ChatGPTStudio INDEX plan completes the bounded read-only fixture', async () => {
  const share = 'C:\\Users\\fixture\\AppData\\Local\\Nymrel\\ChatGPTStudioShare-20260922';
  const plan = config({ projectRoot: share, probeFile: `${share}\\INDEX.md`,
    deniedAncestor: 'C:\\Users\\fixture\\AppData\\Local\\Nymrel', deviceName: 'JalenPC-ChatGPTStudio' });
  const f = fixture({ plan });
  const report = await verifyReadonlyAccess(f);
  assert.equal(report.status, 'roundtrip_pass');
  assert.deepEqual(f.calls.filter((call) => call.body?.method === 'tools/call').map((call) => call.body.params.name),
    ['list_devices', 'get_file_info', 'read_file']);
});
test('success uses only exact-id reads, proves root refusal first, and leaks no private material', async () => {
  const f = fixture(); const report = await verifyReadonlyAccess(f);
  assert.equal(report.status, 'roundtrip_pass');
  assert.deepEqual(report.checks.map((c) => c.name), ['plan_valid', 'expected_issuer_and_resource', 'strict_public_cutover', 'readonly_tool_catalog', 'exact_device_online', 'ancestor_metadata_denied', 'known_nonsecret_file_matches']);
  assert.deepEqual(f.calls.filter((c) => c.body?.method === 'tools/call').map((c) => c.body.params.name), ['list_devices', 'get_file_info', 'read_file']);
  for (const c of f.calls.filter((c) => ['get_file_info', 'read_file'].includes(c.body?.params.name))) assert.equal(c.body.params.arguments.device, f.plan.deviceId);
  const output = JSON.stringify(report);
  for (const secret of [TOKEN, CONTENT, f.plan.probeFile, f.plan.deviceId, f.plan.expectedLineSha256, f.plan.expectedIssuer]) assert.equal(output.includes(secret), false);
  for (const key of ['chatgptVerified', 'refreshVerified', 'allRootsCertified', 'productionReady']) assert.equal(report[key], false);
});
test('missing route and wrong issuer stop before any credentialed call', async () => {
  const a = fixture({ metadataStatus: 404 }); await expectBlocked(a, 'READONLY_ROUTE_NOT_PUBLISHED'); assert.equal(a.calls.length, 1);
  const b = fixture({ metadataChange: (m) => ({ ...m, authorization_servers: ['https://other.example.test/'] }) });
  await expectBlocked(b, 'ISSUER_OR_RESOURCE_MISMATCH'); assert.equal(b.calls.length, 1);
});
test('failed strict public check stops before token transmission', async () => {
  const f = fixture({ publicStatus: 'blocked' }); await expectBlocked(f, 'PUBLIC_CUTOVER_BLOCKED'); assert.equal(f.calls.length, 1);
});
test('missing/malformed access token fails after public checks without authenticated traffic', async () => {
  for (const accessToken of [undefined, '', 'Bearer bad', 'bad\r\nheader', 'x'.repeat(16385)]) {
    const f = fixture(); await expectBlocked({ ...f, accessToken }, 'ACCESS_TOKEN_REQUIRED'); assert.equal(f.calls.length, 1);
  }
});
test('401 and 403 are authorization failures, not root-denial evidence', async () => {
  for (const status of [401, 403]) await expectBlocked(fixture({ mutate: () => json({ private: TOKEN }, status) }), 'AUTHORIZATION_REJECTED');
});
test('HTTP errors, SSE, mismatched RPC IDs and JSON-RPC errors fail closed', async () => {
  await expectBlocked(fixture({ mutate: () => json({}, 500) }), 'MCP_HTTP_FAILED');
  await expectBlocked(fixture({ mutate: () => new Response('data: private', { headers: { 'content-type': 'text/event-stream' } }) }), 'MCP_HTTP_FAILED');
  await expectBlocked(fixture({ mutate: (e) => ({ ...e, id: 999 }) }), 'MCP_PROTOCOL_FAILED');
  await expectBlocked(fixture({ mutate: (e) => ({ ...e, error: { message: TOKEN } }) }), 'MCP_PROTOCOL_FAILED');
});
test('catalog must be complete, unique, read-only, and have exactly seven tools', async () => {
  for (const edit of [
    (r) => { r.tools.push({ name: 'write_file' }); },
    (r) => { r.tools[0] = r.tools[1]; },
    (r) => { r.tools[0].annotations.readOnlyHint = false; },
    (r) => { r.tools[0].annotations.openWorldHint = true; },
    (r) => { r.nextCursor = 'more'; },
    (r) => { r.resultType = 'input_required'; }
  ]) await expectBlocked(fixture({ mutate: (e, b) => { if (b.method === 'tools/list') edit(e.result); return e; } }), 'READONLY_CATALOG_MISMATCH');
});
test('wrong device identity, duplicate IDs, offline or unready devices are not connectivity proof', async () => {
  for (const edit of [
    (d) => { d[0].name = 'OtherPC'; }, (d) => { d[0].id = 'other'; },
    (d) => { d[0].status = 'offline'; }, (d) => { d[0].mcpReady = false; }, (d) => { d.push(d[0]); }
  ]) await expectBlocked(fixture({ mutate: (e, b) => { if (b.params.name === 'list_devices') edit(e.result.structuredContent.devices); return e; } }), 'DEVICE_IDENTITY_OR_READINESS_FAILED');
});
test('root refusal accepts native tool error as well as failed broker call', async () => {
  const f = fixture({ mutate: (e, b) => {
    if (b.params.name === 'get_file_info') e.result = structured({ error: { message: `Path is outside allowed directories: ${config().deniedAncestor}` } }, { isError: true });
    return e;
  }});
  assert.equal((await verifyReadonlyAccess(f)).status, 'roundtrip_pass');
});
test('generic errors, nonexistent paths, approvals, and successful metadata do not prove confinement', async () => {
  for (const value of [structured({ error: { message: 'ENOENT: no such file' } }, { isError: true }),
    structured({ path: 'private', type: 'directory' }), structured({ pending: true, call: { status: 'queued' } }),
    structured({ error: { message: 'Permission denied' } }, { isError: true })]) {
    const f = fixture({ mutate: (e, b) => { if (b.params.name === 'get_file_info') e.result = value; return e; } });
    await expectBlocked(f, 'ROOT_DENIAL_NOT_PROVEN'); assert.equal(f.calls.some((c) => c.body?.params.name === 'read_file'), false);
  }
});
test('pending read is held without retry/recreating a durable call', async () => {
  const f = fixture({ mutate: (e, b) => { if (b.params.name === 'read_file') e.result = structured({ pending: true, call: { status: 'queued' } }); return e; } });
  await expectBlocked(f, 'DEVICE_CALL_NOT_COMPLETED'); assert.equal(f.calls.filter((c) => c.body?.params.name === 'read_file').length, 1);
});
test('wrong path, line window or digest refuses success', async () => {
  for (const [changes, code] of [
    [{ path: 'C:\\Users\\fixture\\projects\\other\\README.md' }, 'PROBE_PATH_MISMATCH'],
    [{ start: 1 }, 'PROBE_WINDOW_INVALID'], [{ end: 100 }, 'PROBE_WINDOW_INVALID'],
    [{ text: 'wrong\nbytes' }, 'PROBE_DIGEST_MISMATCH']
  ]) await expectBlocked(fixture({ mutate: (e, b) => { if (b.params.name === 'read_file') Object.assign(e.result.structuredContent, changes); return e; } }), code);
});
test('runtime failures never print raw exception, token, or file data', async () => {
  const f = fixture(); f.publicCheck = async () => { throw new Error(`${TOKEN} ${CONTENT}`); };
  const r = await expectBlocked(f, 'VALIDATION_OR_TRANSPORT_FAILED'); assert.equal(JSON.stringify(r).includes(TOKEN), false);
});
test('transport forbids off-origin requests and bearer credentials on discovery', async () => {
  let called = false;
  const t = boundedTransport(config(), async () => { called = true; return json({}); });
  await assert.rejects(t('https://evil.example.test/'), /UNAPPROVED_DESTINATION/);
  await assert.rejects(t('https://issuer.example.test/', { headers: { authorization: TOKEN } }), /CREDENTIAL_DESTINATION_REFUSED/);
  await assert.rejects(t('https://issuer.example.test/token', { method: 'POST' }), /UNAPPROVED_METHOD/);
  assert.equal(called, false);
});
test('transport refuses redirects and oversized declared or streamed payloads', async () => {
  await assert.rejects(boundedTransport(config(), async () => new Response(null, { status: 302 }))('https://remote.example.test/'), /REDIRECT_REFUSED/);
  await assert.rejects(boundedTransport(config(), async () => json({}, 200, { 'content-length': '300000' }))('https://remote.example.test/'), /RESPONSE_TOO_LARGE/);
  await assert.rejects(boundedTransport(config(), async () => new Response('x'.repeat(262145)))('https://remote.example.test/'), /RESPONSE_TOO_LARGE/);
});
test('transport has a bounded request count and total deadline', async () => {
  const t = boundedTransport(config(), async () => json({}));
  for (let i = 0; i < 24; i++) await t('https://remote.example.test/');
  await assert.rejects(t('https://remote.example.test/'), /REQUEST_BUDGET_EXHAUSTED/);
  let clock = 0; const late = boundedTransport(config(), async () => json({}), () => clock); clock = 90_001;
  await assert.rejects(late('https://remote.example.test/'), /REQUEST_BUDGET_EXHAUSTED/);
});
test('CLI does not accept token arguments or echo them and removes token from inherited environment', async () => {
  const output = []; const env = { [ACCESS_TOKEN_ENV]: TOKEN };
  assert.equal(await runCli(['--token', TOKEN], env, (v) => output.push(v)), 2);
  assert.equal(Object.hasOwn(env, ACCESS_TOKEN_ENV), false); assert.equal(output.join('').includes(TOKEN), false);
});
test('CLI reports unreadable configuration without echoing the path', async () => {
  const output = []; const privatePath = '/private/token-containing-name.json';
  assert.equal(await runCli(['--plan', privatePath], {}, (v) => output.push(v)), 2);
  assert.equal(output.join('').includes(privatePath), false);
});


test('an out-of-root error for another path or a contradictory pending result cannot pass', async () => {
  for (const data of [
    { error: { message: 'Path is outside allowed directories: C:\\Other' } },
    { error: { message: `Path is outside allowed directories: ${config().deniedAncestor}` }, pending: true },
    { error: { message: `Path is outside allowed directories: ${config().deniedAncestor}` }, call: { status: 'queued' } }
  ]) {
    const f = fixture({ mutate: (e, b) => { if (b.params.name === 'get_file_info') e.result = structured(data, { isError: true }); return e; } });
    await expectBlocked(f, 'ROOT_DENIAL_NOT_PROVEN');
    assert.equal(f.calls.some((c) => c.body?.params.name === 'read_file'), false);
  }
});

test('same-origin issuer drift during the strict probe blocks before token transmission', async () => {
  const f = fixture();
  f.publicCheck = async () => ({ status: 'ready', profile: 'readonly', requireOAuth: true, checks: [
    { name: 'authorization-server metadata', passed: true, detail: { issuer: 'https://issuer.example.test/other', expectedIssuer: 'https://issuer.example.test/other' } }
  ] });
  await expectBlocked(f, 'STRICT_ISSUER_PIN_MISMATCH');
  assert.equal(f.calls.length, 1);
});


test('verified dynamic onboarding is validated and forwarded to the strict public probe', async () => {
  for (const method of ['cimd', 'dcr']) {
    const f = fixture({ plan: config({ verifiedDynamicClient: method }) });
    const original = f.publicCheck;
    f.publicCheck = async (base, options) => {
      assert.equal(options.verifiedDynamicClient, method);
      assert.equal(options.hasPredefinedClient, false);
      return original(base, options);
    };
    assert.equal((await verifyReadonlyAccess(f)).status, 'roundtrip_pass');
  }
  assert.throws(() => validatePlan(config({ verifiedDynamicClient: 'auto' })), /INVALID_PLAN/);
  assert.throws(() => validatePlan(config({ verifiedDynamicClient: 'cimd', hasPredefinedClient: true })), /INVALID_PLAN/);
});
