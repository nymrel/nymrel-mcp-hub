import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';

async function waitForUrl(child: ReturnType<typeof spawn>): Promise<string> {
  let output = '';
  const stdout = child.stdout;
  if (!stdout) throw new Error('Web simulator stdout was not captured');
  stdout.setEncoding('utf8');

  for await (const chunk of stdout) {
    output += chunk;
    const match = output.match(/http:\/\/127\.0\.0\.1:\d+\//);
    if (match) return match[0];
  }

  throw new Error('Web simulator exited before reporting its URL');
}

async function rpc(baseUrl: string, id: number, method: string, params: object = {}) {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/json',
    origin: baseUrl.slice(0, -1)
  };
  if (method !== 'initialize') headers['mcp-protocol-version'] = '2025-11-25';

  const response = await fetch(`${baseUrl}mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params })
  });
  return { status: response.status, payload: await response.json() };
}

test('Alexa+ web simulator serves UI and same-origin MCP decisions', async () => {
  const child = spawn(process.execPath, ['examples/alexa-web-simulator.mjs'], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH ?? '',
      NYMREL_ALEXA_WEB_PORT: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    const baseUrl = await waitForUrl(child);
    const page = await fetch(baseUrl);
    const html = await page.text();

    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy') ?? '', /connect-src 'self'/);
    assert.match(html, /Ask safely/);
    assert.match(html, /No command execution/);

    const initialized = await rpc(baseUrl, 1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'web-test', version: '1.0.0' }
    });
    assert.equal(initialized.status, 200);
    assert.equal(initialized.payload.result.protocolVersion, '2025-11-25');

    const safe = await rpc(baseUrl, 2, 'tools/call', {
      name: 'nymrel_surety_guard',
      arguments: { command: 'npm test', workingDirectory: '/workspace', strict: true }
    });
    const safeResult = JSON.parse(safe.payload.result.content[0].text);
    assert.equal(safeResult.verdict, 'ALLOW');

    const blocked = await rpc(baseUrl, 3, 'tools/call', {
      name: 'nymrel_surety_guard',
      arguments: { command: 'rm -rf /', workingDirectory: '/workspace', strict: true }
    });
    const blockedResult = JSON.parse(blocked.payload.result.content[0].text);
    assert.equal(blockedResult.verdict, 'BLOCK');
    assert.equal(blocked.payload.result.isError, true);

    const restricted = await rpc(baseUrl, 4, 'tools/call', {
      name: 'nymrel_swarm_claim',
      arguments: {}
    });
    assert.equal(restricted.status, 200);
    assert.equal(restricted.payload.error.code, -32602);
    assert.match(restricted.payload.error.message, /not available over hosted transport/i);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
