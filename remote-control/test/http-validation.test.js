import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeMcpHeaderValue, HeaderMismatchError, validateModernMcpHeaders } from '../src/mcp-http-validation.js';
import { CLIENT_CAPABILITIES_META_KEY, MODERN_PROTOCOL_VERSION, PROTOCOL_VERSION_META_KEY } from '../src/mcp-protocol.js';

test('modern routing headers mirror protocol, method, tool, and x-mcp-header arguments', () => {
  const body = {
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: {
      name: 'remote_pc__do', arguments: { workspace: 'alpha', count: 3, enabled: true },
      _meta: { [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_META_KEY]: {} }
    }
  };
  const schema = { type: 'object', properties: {
    workspace: { type: 'string', 'x-mcp-header': 'Workspace' },
    count: { type: 'integer', 'x-mcp-header': 'Count' },
    enabled: { type: 'boolean', 'x-mcp-header': 'Enabled' }
  } };
  const headers = {
    'mcp-protocol-version': MODERN_PROTOCOL_VERSION,
    'mcp-method': 'tools/call', 'mcp-name': 'remote_pc__do',
    'mcp-param-workspace': 'alpha', 'mcp-param-count': '3', 'mcp-param-enabled': 'true'
  };
  assert.doesNotThrow(() => validateModernMcpHeaders(headers, body, schema));
  assert.throws(() => validateModernMcpHeaders({ ...headers, 'mcp-param-count': '04' }, body, schema), HeaderMismatchError);
  assert.throws(() => validateModernMcpHeaders({ ...headers, 'mcp-name': 'wrong' }, body, schema), HeaderMismatchError);
});

test('base64 sentinel decoding is canonical and supports non-ASCII mirrored values', () => {
  const value = 'résumé/東京';
  const encoded = Buffer.from(value, 'utf8').toString('base64');
  assert.equal(decodeMcpHeaderValue(`=?base64?${encoded}?=`), value);
  assert.throws(() => decodeMcpHeaderValue(' padded '), /base64 encoded/);
});
