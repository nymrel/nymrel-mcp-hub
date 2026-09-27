#!/usr/bin/env node
import { once } from 'node:events';
import {
  HTTP_PROTOCOL_VERSION,
  startMCPHttpServer
} from '../dist/src/http.js';

const DEMO_TOKEN = 'nymrel-local-demo-token';

function textResult(response) {
  const text = response?.result?.content?.find((item) => item?.type === 'text')?.text;
  if (typeof text !== 'string') {
    throw new Error('MCP tool response did not include text content');
  }
  return JSON.parse(text);
}

async function rpc(endpoint, id, method, params = {}) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${DEMO_TOKEN}`,
      'content-type': 'application/json',
      ...(method === 'initialize'
        ? {}
        : { 'mcp-protocol-version': HTTP_PROTOCOL_VERSION })
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params
    })
  });

  const body = await response.json();
  return {
    status: response.status,
    body
  };
}

async function main() {
  const server = startMCPHttpServer({
    host: '127.0.0.1',
    port: 0,
    bearerToken: DEMO_TOKEN
  });

  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address !== 'object') {
    throw new Error('Loopback demo server did not expose a TCP address');
  }

  const endpoint = `http://127.0.0.1:${address.port}/mcp`;

  try {
    const initialized = await rpc(endpoint, 1, 'initialize', {
      protocolVersion: HTTP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: 'nymrel-alexa-simulator',
        version: '1.0.0'
      }
    });

    if (
      initialized.status !== 200 ||
      initialized.body?.result?.protocolVersion !== HTTP_PROTOCOL_VERSION
    ) {
      throw new Error('MCP initialize handshake failed');
    }

    const safeQuestion =
      'Can Nymrel safely run the bounded verification command npm test?';
    const safeCall = await rpc(endpoint, 2, 'tools/call', {
      name: 'nymrel_surety_guard',
      arguments: {
        command: 'npm test',
        workingDirectory: '/workspace/nymrel-mcp-hub',
        strict: true
      }
    });
    const safeResult = textResult(safeCall.body);

    const destructiveQuestion =
      'Delete the entire machine so we can start over.';
    const blockedCall = await rpc(endpoint, 3, 'tools/call', {
      name: 'nymrel_surety_guard',
      arguments: {
        command: 'rm -rf /',
        workingDirectory: '/workspace/nymrel-mcp-hub',
        strict: true
      }
    });
    const blockedResult = textResult(blockedCall.body);

    const unavailableCall = await rpc(endpoint, 4, 'tools/call', {
      name: 'nymrel_swarm_claim',
      arguments: {}
    });

    if (safeResult.verdict !== 'ALLOW') {
      throw new Error('Expected the bounded verification command to be allowed');
    }
    if (blockedResult.verdict !== 'BLOCK' || blockedCall.body?.result?.isError !== true) {
      throw new Error('Expected the destructive command to fail closed');
    }
    if (unavailableCall.body?.error?.code !== -32602) {
      throw new Error('Expected the hosted allowlist to reject an unavailable tool');
    }

    const transcript = {
      schemaVersion: 1,
      mode: 'local-synthetic-simulation',
      protocolVersion: HTTP_PROTOCOL_VERSION,
      transport: 'loopback-streamable-http',
      success: {
        user: safeQuestion,
        tool: 'nymrel_surety_guard',
        verdict: safeResult.verdict,
        assistant:
          'Yes. The requested test command is bounded and passed the strict pre-execution safety check.'
      },
      safeRefusal: {
        user: destructiveQuestion,
        tool: 'nymrel_surety_guard',
        verdict: blockedResult.verdict,
        violation: blockedResult.violations?.[0] ?? 'destructive command',
        assistant:
          'I will not run that command. Nymrel blocked it before execution because it targets recursive deletion outside a bounded worktree.'
      },
      hostedBoundary: {
        requestedTool: 'nymrel_swarm_claim',
        errorCode: unavailableCall.body.error.code,
        assistant:
          'That tool is not exposed through the reviewed Alexa+ hosted allowlist.'
      },
      limitations: [
        'This is a deterministic local simulator, not evidence of Alexa+ platform validation.',
        'No public endpoint, cloud service, account, credential, or external network is used.',
        'The simulator does not execute either inspected command.'
      ]
    };

    process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

main().catch((error) => {
  process.stderr.write(`[nymrel-alexa-simulator] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
