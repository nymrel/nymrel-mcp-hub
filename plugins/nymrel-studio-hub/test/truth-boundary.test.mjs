import test from 'node:test';
import assert from 'node:assert/strict';
import { StudioTruthfulMCPServer } from '../export/server/bin/studio-mcp-server.js';

const server = new StudioTruthfulMCPServer();
let id = 1;
async function request(method, params = {}) {
  return server.handleRequest({ jsonrpc: '2.0', id: id++, method, params });
}
async function call(name, args = {}) {
  const response = await request('tools/call', { name, arguments: args });
  assert.equal(response.error, undefined, JSON.stringify(response.error));
  const item = response.result?.content?.find((entry) => entry.type === 'text');
  assert.ok(item?.text, `no text returned by ${name}`);
  return JSON.parse(item.text);
}

test('tool discovery classifies every actual tool and removes false resource/prompt surfaces', async () => {
  const list = await request('tools/list');
  assert.equal(list.result.tools.length, 15);
  for (const tool of list.result.tools) {
    assert.match(tool.description, /\[Studio plugin evidence: [^\]]+\]/, tool.name);
  }
  assert.match(list.result.tools.find((tool) => tool.name === 'nymrel_open_ucp').description, /never settles/i);
  assert.match(list.result.tools.find((tool) => tool.name === 'nymrel_surety_guard').description, /does not intercept/i);
  assert.match(list.result.tools.find((tool) => tool.name === 'nymrel_ucp_audit').description, /not fetched/i);
  assert.deepEqual((await request('resources/list')).result.resources.map((item) => item.uri), ['nymrel://status']);
  assert.deepEqual((await request('prompts/list')).result.prompts, []);
  assert.ok((await request('prompts/get', { name: 'init-two-seat-mission' })).error);
  assert.ok((await request('resources/read', { uri: 'nymrel://ecosystem' })).error);
  assert.ok((await request('tools/call', { name: 'open_ucp', arguments: { action: 'settle_x402' } })).error);
});

test('every canonical tool result carries a machine-readable evidence boundary', async () => {
  const key = 'a'.repeat(64);
  const savedSearchKeys = ['EXA_API_KEY', 'TAVILY_API_KEY', 'BRAVE_SEARCH_API_KEY', 'SERPAPI_API_KEY']
    .map((name) => [name, process.env[name]]);
  for (const [name] of savedSearchKeys) delete process.env[name];
  try {
    const receiptWithLabel = await call('nymrel_proof_ledger', {
      action: 'test-claim', agentId: 'boundary-test', payload: { statement: 'test only' },
      signingKey: key, algorithm: 'HMAC-SHA256'
    });
    const { _studioPluginEvidence, ...receipt } = receiptWithLabel;
    const cases = [
      ['nymrel_ucp_audit', { url: 'https://example.invalid/' }],
      ['nymrel_surety_guard', { command: 'echo test' }],
      ['nymrel_swarm_claim', { repoPath: 'C:\\boundary-test', agentId: 'boundary-test', action: 'status' }],
      ['nymrel_machine_trust', { targetFormat: 'jsonld' }],
      ['nymrel_proof_ledger', { action: 'test', agentId: 'test', payload: {}, signingKey: key, algorithm: 'HMAC-SHA256' }],
      ['nymrel_crawler_mesh', { html: '<html><body><h1>local fixture</h1></body></html>' }],
      ['nymrel_beacon_ping', { agentId: 'boundary-test', action: 'fleet_status' }],
      ['nymrel_headless_quote', {}],
      ['nymrel_local_forge', {}],
      ['nymrel_open_ucp', { action: 'quote' }],
      ['nymrel_sandstorm', { content: 'test' }],
      ['nymrel_a2ui_render', { title: 'test', summary: 'test' }],
      ['nymrel_swarm_bus', { fromAgent: 'a', toAgent: 'b', topic: 'test', payload: {} }],
      ['nymrel_proof_verify', { receipt, publicKeyOrSecret: key, expectedAlgorithm: 'HMAC-SHA256' }],
      ['nymrel_web_search', { query: 'boundary test' }]
    ];
    for (const [name, args] of cases) {
      const result = await call(name, args);
      assert.ok(result._studioPluginEvidence?.classification, `${name} has no evidence marker`);
      if (name === 'nymrel_crawler_mesh') assert.equal(result.evidenceSource, 'CALLER_SUPPLIED_HTML_NO_NETWORK_FETCH');
      if (name === 'nymrel_web_search') assert.equal(result.evidenceSource, 'NO_PROVIDER_RESULT');
    }
  } finally {
    for (const [name, value] of savedSearchKeys) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('OpenUCP settle_x402 output is explicitly simulated and reports no payment or network action', async () => {
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('network must not be used'); };
  try {
    const output = await call('nymrel_open_ucp', { action: 'settle_x402', merchantEndpoint: 'https://merchant.invalid/pay' });
    assert.equal(output.action, 'settle_x402');
    assert.equal(output.commitmentProof.settlementStatus, 'SIMULATED_NOT_SETTLED');
    assert.equal(output.paymentPerformed, false);
    assert.equal(output.networkRequestPerformed, false);
    assert.equal(output._studioPluginEvidence.classification, 'simulation');
    assert.equal(fetchCalls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('UCP audit is labelled as template-only, has no scores, and makes no network request', async () => {
  const previousFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => { fetchCalls++; throw new Error('network must not be used'); };
  try {
    const output = await call('nymrel_ucp_audit', { url: 'https://example.invalid/' });
    assert.equal(output.auditStatus, 'NOT_MEASURED_TEMPLATE_ONLY');
    assert.equal(output.overallScore, null);
    assert.equal(output.letterGrade, 'NOT_ASSESSED');
    assert.equal(output.networkFetchPerformed, false);
    assert.ok(output.findings.every((finding) => finding.status === 'UNVERIFIED_TEMPLATE'));
    assert.equal(output._studioPluginEvidence.classification, 'template-only');
    assert.equal(fetchCalls, 0);
  } finally { globalThis.fetch = previousFetch; }
});

test('swarm lease, heartbeat, and bus results cannot be mistaken for shared coordination', async () => {
  const lease = await call('nymrel_swarm_claim', { repoPath: 'C:\\hub-test-only', agentId: 'plugin-boundary-test', action: 'status' });
  assert.equal(lease.stateScope, 'CURRENT_NODE_PROCESS_MEMORY_ONLY');
  assert.match(lease._studioPluginEvidence.limitations, /not durable, shared across processes/i);
  const heartbeat = await call('nymrel_beacon_ping', { agentId: 'plugin-boundary-test', action: 'fleet_status' });
  assert.equal(heartbeat.reportingScope, 'LOCAL_PROCESS_ONLY_NOT_SHARED_FLEET');
  const envelope = await call('nymrel_swarm_bus', { fromAgent: 'a', toAgent: 'b', topic: 'test', payload: {} });
  assert.equal(envelope.dispatched, false);
  assert.equal(envelope.deliveryStatus, 'NOT_DELIVERED_PROCESS_LOCAL_ONLY');
  assert.equal(envelope.deliveredTo, null);
});

test('dangerous boundary claims are replaced with measured or non-enforcement values', async () => {
  const forge = await call('nymrel_local_forge', { action: 'status' });
  assert.equal(forge.probePerformed, false);
  assert.ok(forge.localEngines.every((engine) => engine.status === 'NOT_PROBED_SIMULATED'));
  const sandstorm = await call('nymrel_sandstorm', { action: 'inspect_isolation' });
  assert.equal(sandstorm.enforcementPerformed, false);
  assert.equal(sandstorm.isolationState.cowFilesystem, 'NOT_MOUNTED');
  const card = await call('nymrel_a2ui_render', { title: 'Approval', summary: 'Please review' });
  assert.equal(card.body.attributes.find((field) => field.label === 'Confidence').value, 'No confidence measurement');
  const guard = await call('nymrel_surety_guard', { command: 'rm file.txt' });
  assert.equal(guard._studioPluginEvidence.classification, 'local-heuristic');
});

test('status resource identifies local process scope and reports only local process health', async () => {
  const status = await request('resources/read', { uri: 'nymrel://status' });
  const content = JSON.parse(status.result.contents[0].text);
  assert.equal(content.status, 'LOCAL_PROCESS_RESPONDING');
  assert.match(content.studioPluginEvidence, /do not establish remote service or fleet health/i);
});
