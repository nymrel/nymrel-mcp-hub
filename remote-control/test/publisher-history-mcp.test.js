import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatgptReadonlyMcpEdge, PUBLISHER_HISTORY_TOOLS } from '../src/chatgpt-readonly-profile.js';

test('read-only ChatGPT profile adds Publisher history tools only when the client is configured', async () => {
  const calls = [];
  const publisherHistoryClient = {
    async listRecent(tenant, args) { calls.push({ method: 'recent', tenant, args }); return [{ externalId: '123' }]; },
    async findExactText(tenant, args) { calls.push({ method: 'exact', tenant, args }); return []; },
    async listSyncs(tenant, args) { calls.push({ method: 'syncs', tenant, args }); return [{ status: 'completed' }]; }
  };
  const broker = new Proxy({}, {
    get() { return async () => { throw new Error('Remote broker must not be used for Publisher history tools'); }; }
  });
  const edge = new ChatgptReadonlyMcpEdge({ broker, syncWaitMs: 0, publisherHistoryClient });
  const tools = await edge.listTools({ tenant: 't1' });
  for (const tool of PUBLISHER_HISTORY_TOOLS) {
    assert.ok(tools.some((item) => item.name === tool.name));
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.deepEqual(tool.securitySchemes, [{ type: 'oauth2', scopes: ['devices:read', 'tools:read'] }]);
  }

  const result = await edge.callTool(
    { tenant: 't1', scopes: ['devices:read', 'tools:read'] },
    'publisher_list_history',
    { brandId: 'draftadynasty', sinceAt: '2026-09-24T00:00:00Z', limit: 25, ignored: 'not-forwarded' }
  );
  assert.deepEqual(result.structuredContent.result, [{ externalId: '123' }]);
  assert.deepEqual(calls, [{
    method: 'recent',
    tenant: 't1',
    args: {
      brandId: 'draftadynasty',
      channel: 'x',
      sinceAt: '2026-09-24T00:00:00Z',
      limit: 25
    }
  }]);
});

test('Publisher history MCP tools reject missing tenant context before upstream access', async () => {
  let touched = false;
  const client = {
    async listRecent() { touched = true; return []; },
    async findExactText() { touched = true; return []; },
    async listSyncs() { touched = true; return []; }
  };
  const edge = new ChatgptReadonlyMcpEdge({ broker: {}, syncWaitMs: 0, publisherHistoryClient: client });
  await assert.rejects(
    edge.callTool({ scopes: ['devices:read', 'tools:read'] }, 'publisher_list_history', { brandId: 'draftadynasty' }),
    (error) => error?.code === 'PUBLISHER_HISTORY_BRAND_DENIED'
  );
  assert.equal(touched, false);
});
