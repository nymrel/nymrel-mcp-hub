import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import test from 'node:test';
import {
  HTTP_PROTOCOL_VERSION,
  startMCPHttpServer
} from '../src/http.js';

async function withServer(
  run: (baseUrl: string) => Promise<void>,
  options: {
    allowedOrigins?: string[];
    bearerToken?: string;
    hostedToolAllowlist?: string[];
  } = {}
): Promise<void> {
  const server = startMCPHttpServer({
    host: '127.0.0.1',
    port: 0,
    ...options
  });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    await run(`http://127.0.0.1:${address.port}/mcp`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: Record<string, string | string[] | undefined> }> {
  const parsed = new URL(url);
  const payload = JSON.stringify(body);

  return await new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': String(Buffer.byteLength(payload)),
          ...headers
        }
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers
          });
        });
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

function initializeRequest() {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: HTTP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'http-test',
        version: '1.0.0'
      }
    }
  };
}

test('HTTP transport negotiates MCP 2025-11-25 without creating a session', async () => {
  await withServer(async (url) => {
    const response = await post(url, initializeRequest());
    assert.equal(response.status, 200);
    assert.equal(response.headers['mcp-session-id'], undefined);

    const payload = JSON.parse(response.body);
    assert.equal(payload.result.protocolVersion, HTTP_PROTOCOL_VERSION);
    assert.equal(payload.result.serverInfo.name, '@nymrel/mcp-hub');
  });
});

test('HTTP transport requires the negotiated protocol header after initialize', async () => {
  await withServer(async (url) => {
    const response = await post(url, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
      params: {}
    });

    assert.equal(response.status, 400);
    const payload = JSON.parse(response.body);
    assert.equal(payload.error.code, -32022);
  });
});

test('HTTP transport exposes only the hosted tool allowlist', async () => {
  await withServer(
    async (url) => {
      const response = await post(
        url,
        {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {}
        },
        {
          'mcp-protocol-version': HTTP_PROTOCOL_VERSION
        }
      );

      assert.equal(response.status, 200);
      const payload = JSON.parse(response.body);
      assert.deepEqual(
        payload.result.tools.map((tool: { name: string }) => tool.name),
        ['nymrel_ucp_audit', 'nymrel_machine_trust']
      );
    },
    {
      hostedToolAllowlist: ['nymrel_ucp_audit', 'nymrel_machine_trust']
    }
  );
});

test('HTTP transport blocks stdio-only tools before dispatch', async () => {
  await withServer(async (url) => {
    const response = await post(
      url,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'nymrel_proof_ledger',
          arguments: {}
        }
      },
      {
        'mcp-protocol-version': HTTP_PROTOCOL_VERSION
      }
    );

    assert.equal(response.status, 200);
    const payload = JSON.parse(response.body);
    assert.equal(payload.error.code, -32602);
    assert.match(payload.error.message, /not available over hosted transport/);
  });
});

test('HTTP transport rejects an unapproved Origin', async () => {
  await withServer(
    async (url) => {
      const response = await post(url, initializeRequest(), {
        origin: 'https://evil.example'
      });
      assert.equal(response.status, 403);
    },
    {
      allowedOrigins: ['https://allowed.example']
    }
  );
});

test('HTTP transport supports bearer authentication without reflecting credentials', async () => {
  await withServer(
    async (url) => {
      const denied = await post(url, initializeRequest());
      assert.equal(denied.status, 401);
      assert.equal(denied.body.includes('top-secret'), false);

      const allowed = await post(url, initializeRequest(), {
        authorization: 'Bearer top-secret'
      });
      assert.equal(allowed.status, 200);
    },
    {
      bearerToken: 'top-secret'
    }
  );
});

test('HTTP notifications receive 202 with no JSON-RPC response body', async () => {
  await withServer(async (url) => {
    const response = await post(
      url,
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {}
      },
      {
        'mcp-protocol-version': HTTP_PROTOCOL_VERSION
      }
    );

    assert.equal(response.status, 202);
    assert.equal(response.body, '');
  });
});
