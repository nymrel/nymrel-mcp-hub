import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { connect } from 'node:net';
import test from 'node:test';
import {
  drainMCPHttpServer,
  HTTP_PROTOCOL_VERSION,
  startMCPHttpServer
} from '../src/http.js';

type ServerOptions = {
  allowedOrigins?: string[];
  bearerToken?: string;
  hostedToolAllowlist?: string[];
  maxBodyBytes?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  maxConcurrentRequests?: number;
  rateLimitWindowMs?: number;
  rateLimitMaxRequests?: number;
  maxJsonDepth?: number;
};

async function withServer(
  run: (baseUrl: string) => Promise<void>,
  options: ServerOptions = {}
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
    if (server.listening) {
      await drainMCPHttpServer(server);
    }
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

function initializeRequest(extra: Record<string, unknown> = {}) {
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
      },
      ...extra
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

test('HTTP hosted tools disclose their evidence limits and refuse unreviewed methods', async () => {
  await withServer(async (url) => {
    const headers = { 'mcp-protocol-version': HTTP_PROTOCOL_VERSION };
    const listed = await post(url, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, headers);
    const tools = JSON.parse(listed.body).result.tools;
    assert.deepEqual(tools.map((tool: { name: string }) => tool.name), [
      'nymrel_ucp_audit', 'nymrel_surety_guard', 'nymrel_machine_trust', 'nymrel_proof_verify'
    ]);
    for (const tool of tools) {
      assert.match(tool.description, /Hosted evidence:/);
      assert.doesNotMatch(tool.description, /Audits any URL|firewall intercepting/i);
      assert.deepEqual(tool.annotations, {
        readOnlyHint: true, destructiveHint: false, openWorldHint: false
      });
    }
    const resources = await post(url, { jsonrpc: '2.0', id: 5, method: 'resources/list' }, headers);
    assert.equal(JSON.parse(resources.body).error.code, -32601);
  });
  assert.throws(() => startMCPHttpServer({ hostedToolAllowlist: ['nymrel_open_ucp'] }), /no reviewed evidence boundary/);
});

test('HTTP UCP audit of an unfetched URL cannot report a measured purchasing grade', async () => {
  await withServer(async (url) => {
    const response = await post(url, {
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'nymrel_ucp_audit', arguments: { url: 'https://example.invalid/' } }
    }, { 'mcp-protocol-version': HTTP_PROTOCOL_VERSION });
    assert.equal(response.status, 200);
    const report = JSON.parse(JSON.parse(response.body).result.content[0].text);
    assert.equal(report.auditStatus, 'NOT_MEASURED_TEMPLATE_ONLY');
    assert.equal(report.overallScore, null);
    assert.equal(report.letterGrade, 'NOT_ASSESSED');
    assert.equal(report.commerceReadiness, 'NOT_ASSESSED_NO_PAGE_FETCH');
    assert.equal(report.networkFetchPerformed, false);
    assert.ok(report.findings.every((finding: { status: string }) => finding.status === 'UNVERIFIED_TEMPLATE'));
    assert.equal(report._hostedEvidence.classification, 'template-only');
  });
});

test('HTTP local heuristic, generated artifacts, and proof checks carry truthful scope', async () => {
  await withServer(async (url) => {
    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await post(url, {
        jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args }
      }, { 'mcp-protocol-version': HTTP_PROTOCOL_VERSION });
      assert.equal(response.status, 200);
      return JSON.parse(JSON.parse(response.body).result.content[0].text);
    };
    const guard = await call('nymrel_surety_guard', { command: 'echo hello' });
    assert.equal(guard.verdict, 'ALLOW');
    assert.equal(guard.isSafe, null);
    assert.equal(guard.commandExecuted, false);
    assert.equal(guard.authorizationGranted, false);
    assert.match(guard.recommendation, /does not authorize or execute/);
    assert.equal(guard._hostedEvidence.classification, 'local-heuristic');

    const generated = await call('nymrel_machine_trust', { domain: 'https://example.invalid', targetFormat: 'llms_txt' });
    assert.equal(generated.artifactStatus, 'GENERATED_NOT_PUBLISHED_OR_VERIFIED');
    assert.match(generated.llmsTxt, /not verified as deployed/);
    assert.doesNotMatch(generated.llmsTxt, /Full read access authorized/);
    assert.equal(generated._hostedEvidence.classification, 'generated-template');

    const proof = await call('nymrel_proof_verify', { receipt: {} });
    assert.equal(proof.executionVerified, false);
    assert.equal(proof.filesInspected, false);
    assert.equal(proof._hostedEvidence.classification, 'local-cryptographic-check');
  });
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

test('HTTP transport accepts the exact same-origin browser host', async () => {
  await withServer(async (url) => {
    const parsed = new URL(url);
    const response = await post(url, initializeRequest(), {
      origin: parsed.origin
    });
    assert.equal(response.status, 200);
  });
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

test('non-loopback hosting requires bearer authentication before bind', () => {
  assert.throws(
    () =>
      startMCPHttpServer({
        host: '0.0.0.0',
        port: 0,
        allowedHosts: ['example.test']
      }),
    /requires bearer authentication/
  );
});

test('HTTP transport rejects JSON deeper than the configured nesting limit', async () => {
  await withServer(
    async (url) => {
      const response = await post(url, initializeRequest({
        nested: { one: { two: { three: true } } }
      }));
      assert.equal(response.status, 400);
      assert.match(JSON.parse(response.body).error.message, /nesting limit/);
    },
    { maxJsonDepth: 4 }
  );
});

test('HTTP transport bounds serialized responses', async () => {
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
        { 'mcp-protocol-version': HTTP_PROTOCOL_VERSION }
      );
      assert.equal(response.status, 500);
      assert.equal(JSON.parse(response.body).error.code, -32024);
    },
    { maxResponseBytes: 256 }
  );
});

test('HTTP transport rate limit fails closed with retry-after', async () => {
  await withServer(
    async (url) => {
      const first = await post(url, initializeRequest());
      assert.equal(first.status, 200);

      const second = await post(url, initializeRequest());
      assert.equal(second.status, 429);
      assert.equal(second.headers['retry-after'], '60');
    },
    {
      rateLimitMaxRequests: 1,
      rateLimitWindowMs: 60_000
    }
  );
});

test('HTTP transport rejects concurrent work above the configured bound', async () => {
  await withServer(
    async (url) => {
      const parsed = new URL(url);
      const first = request({
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'content-length': '100'
        }
      });
      first.on('error', () => {});
      first.flushHeaders();
      await new Promise((resolve) => setTimeout(resolve, 20));

      const second = await post(url, initializeRequest());
      assert.equal(second.status, 503);
      assert.equal(second.headers['retry-after'], '1');
      first.destroy();
    },
    {
      maxConcurrentRequests: 1,
      requestTimeoutMs: 1_000
    }
  );
});

test('HTTP transport times out an incomplete request body', async () => {
  await withServer(
    async (url) => {
      const parsed = new URL(url);
      const response = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              accept: 'application/json',
              'content-length': '100'
            }
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8')
              })
            );
          }
        );
        req.on('error', reject);
        req.flushHeaders();
      });

      assert.equal(response.status, 504);
      assert.match(JSON.parse(response.body).error.message, /timed out/);
    },
    { requestTimeoutMs: 25 }
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

test('HTTP rejects valid JSON that is not a request object and remains available', async () => {
  await withServer(async (url) => {
    for (const value of [null, [], 42]) {
      const response = await post(url, value);
      assert.equal(response.status, 400);
      assert.equal(JSON.parse(response.body).error.code, -32600);
    }
    const valid = await post(url, initializeRequest());
    assert.equal(valid.status, 200);
    assert.equal(JSON.parse(valid.body).result.protocolVersion, HTTP_PROTOCOL_VERSION);
  });
});

test('HTTP server drains deterministically without forcing idle work', async () => {
  const server = startMCPHttpServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const result = await drainMCPHttpServer(server, 100);
  assert.deepEqual(result, { forced: false });
  assert.equal(server.listening, false);
});

test('HTTP drain closes sockets with incomplete headers at its deadline', async () => {
  const server = startMCPHttpServer({ host: '127.0.0.1', port: 0, requestTimeoutMs: 5_000 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const socket = connect(address.port, '127.0.0.1');
  socket.on('error', () => {});
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  try {
    await once(socket, 'connect');
    socket.write('POST /mcp HTTP/1.1\r\nHost: localhost\r\n');
    const result = await Promise.race([
      drainMCPHttpServer(server, 50),
      new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error('drain exceeded 300 ms')), 300);
      })
    ]);
    assert.deepEqual(result, { forced: true });
  } finally {
    clearTimeout(watchdog);
    socket.destroy();
    server.closeAllConnections();
  }
});
