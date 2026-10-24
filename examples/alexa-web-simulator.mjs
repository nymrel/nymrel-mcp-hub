#!/usr/bin/env node
import { createServer } from 'node:http';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import {
  createMCPHttpHandler,
  HTTP_PROTOCOL_VERSION
} from '../dist/src/http.js';

const rawPort = process.env.NYMREL_ALEXA_WEB_PORT ?? '8788';
const port = Number.parseInt(rawPort, 10);
const clientSource = await readFile(new URL('./alexa-web-client.mjs', import.meta.url));
const receiptSource = await readFile(new URL('./alexa-web-receipt.mjs', import.meta.url));

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write('[nymrel-alexa-web] NYMREL_ALEXA_WEB_PORT must be an integer from 0 to 65535\n');
  process.exit(2);
}

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Nymrel Operator — Alexa+ local simulator</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #f4f0e8; color: #24302b; }
    main { width: min(760px, calc(100% - 32px)); margin: 48px auto; }
    .eyebrow { color: #7a4e2d; font-size: .78rem; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    h1 { margin: 8px 0 12px; font-size: clamp(2rem, 7vw, 4rem); line-height: .96; }
    .lede { max-width: 58ch; color: #526059; line-height: 1.6; }
    .actions { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); margin: 28px 0; }
    button { border: 1px solid #24302b; border-radius: 14px; background: #fffdf8; color: inherit; cursor: pointer; font: inherit; font-weight: 750; padding: 16px; text-align: left; }
    button:hover, button:focus-visible { background: #e8f2ea; outline: 3px solid #b86a36; outline-offset: 2px; }
    .panel { min-height: 170px; border: 1px solid #c9c1b5; border-radius: 18px; background: #fffdf8; padding: 22px; box-shadow: 0 14px 40px rgb(36 48 43 / .08); }
    .label { color: #6d756f; font-size: .78rem; font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
    #status { display: inline-block; margin: 8px 0 16px; border-radius: 999px; background: #e2e8e3; padding: 6px 10px; font-size: .85rem; font-weight: 800; }
    #answer { font-size: 1.2rem; line-height: 1.5; }
    #evidence-panel { margin-top: 20px; border-top: 1px solid #ded8cf; padding-top: 18px; }
    #evidence { overflow: auto; max-height: 260px; border-radius: 12px; background: #24302b; color: #eaf1eb; padding: 14px; font-size: .78rem; line-height: 1.45; }
    .evidence-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 12px; }
    .evidence-actions button { padding: 10px 14px; }
    button:disabled { cursor: not-allowed; opacity: .5; }
    footer { margin-top: 18px; color: #6d756f; font-size: .85rem; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Nymrel Operator · Local simulation</div>
    <h1>Ask safely.<br>Act deliberately.</h1>
    <p class="lede">A same-origin browser proof for the reviewed Nymrel MCP surface. It inspects requests and explains the result; it never executes the commands shown here.</p>
    <div class="actions" aria-label="Simulation scenarios">
      <button type="button" data-scenario="safe">Check a bounded command</button>
      <button type="button" data-scenario="blocked">Refuse a destructive command</button>
      <button type="button" data-scenario="restricted">Try a restricted tool</button>
    </div>
    <section class="panel" aria-live="polite" aria-atomic="true">
      <div class="label">Assistant response</div>
      <div id="status">Ready</div>
      <div id="answer">Choose a scenario to run the real local MCP workflow.</div>
      <div id="evidence-panel" hidden>
        <div class="label">Decision evidence</div>
        <pre id="evidence"></pre>
        <div class="evidence-actions">
          <button type="button" id="copy-evidence" disabled>Copy evidence</button>
          <button type="button" id="download-evidence" disabled>Download JSON</button>
        </div>
      </div>
    </section>
    <footer>Loopback only · MCP ${HTTP_PROTOCOL_VERSION} · No command execution · Not evidence of Alexa+ platform validation</footer>
  </main>
  <script type="module" src="/client.mjs"></script>
</body>
</html>`;

const mcpHandler = createMCPHttpHandler();
const server = createServer((req, res) => {
  const requestUrl = new URL(req.url ?? '/', 'http://localhost');
  if (requestUrl.pathname === '/mcp') {
    void mcpHandler(req, res);
    return;
  }

  const browserModule = requestUrl.pathname === '/client.mjs'
    ? clientSource
    : requestUrl.pathname === '/alexa-web-receipt.mjs'
      ? receiptSource
      : undefined;
  if (req.method === 'GET' && browserModule) {
    res.writeHead(200, {
      'content-type': 'text/javascript; charset=utf-8',
      'content-length': String(browserModule.byteLength),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff'
    });
    res.end(browserModule);
    return;
  }

  if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(html)),
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff'
    });
    res.end(html);
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  res.end('Not found');
});

server.listen(port, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
if (!address || typeof address !== 'object') throw new Error('Simulator did not expose a TCP address');

process.stdout.write(`[nymrel-alexa-web] http://127.0.0.1:${address.port}/\n`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
