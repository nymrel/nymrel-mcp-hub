import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

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

test('Alexa+ web simulator renders decisions and exportable evidence through the real MCP adapter', async () => {
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
    assert.match(page.headers.get('content-security-policy') ?? '', /script-src 'self'/);
    assert.doesNotMatch(page.headers.get('content-security-policy') ?? '', /script-src 'unsafe-inline'/);
    assert.match(html, /Ask safely/);
    assert.match(html, /No command execution/);
    assert.match(html, /Copy evidence/);
    assert.match(html, /Download JSON/);

    const [clientModule, receiptModule] = await Promise.all([
      fetch(`${baseUrl}client.mjs`),
      fetch(`${baseUrl}alexa-web-receipt.mjs`)
    ]);
    assert.equal(clientModule.status, 200);
    assert.equal(receiptModule.status, 200);
    assert.match(await clientModule.text(), /createOperatorApp/);
    assert.match(await receiptModule.text(), /buildDecisionEvidence/);

    // The browser module intentionally remains a plain JavaScript fixture.
    const browserClientUrl = pathToFileURL(resolve('examples/alexa-web-client.mjs')).href;
    const { createOperatorApp } = await import(browserClientUrl);

    type FakeElement = {
      dataset: Record<string, string>;
      disabled: boolean;
      hidden: boolean;
      textContent: string;
      addEventListener: (name: string, handler: () => unknown) => void;
    };
    const element = (): FakeElement => ({
      dataset: {},
      disabled: true,
      hidden: true,
      textContent: '',
      addEventListener() {}
    });
    const elements = new Map<string, FakeElement>([
      ['#status', element()],
      ['#answer', element()],
      ['#evidence-panel', element()],
      ['#evidence', element()],
      ['#copy-evidence', element()],
      ['#download-evidence', element()]
    ]);
    const scenarioButtons = ['safe', 'blocked', 'restricted'].map((scenario) => ({
      ...element(),
      dataset: { scenario }
    }));
    const root = {
      querySelector(selector: string) {
        return elements.get(selector);
      },
      querySelectorAll(selector: string) {
        return selector === '[data-scenario]' ? scenarioButtons : [];
      }
    };
    let copied = '';
    let downloaded: { filename: string; text: string } | undefined;
    const app = createOperatorApp({
      root,
      fetchImpl: (path: string, init: RequestInit) => fetch(new URL(path, baseUrl), {
        ...init,
        headers: {
          ...(init.headers ?? {}),
          origin: baseUrl.slice(0, -1)
        }
      }),
      copyText: async (text: string) => {
        copied = text;
      },
      downloadText: (filename: string, text: string) => {
        downloaded = { filename, text };
      }
    });

    await app.runScenario('safe');
    assert.equal(elements.get('#status')?.textContent, 'ALLOW');
    assert.equal(app.getCurrentEvidence().decision, 'ALLOW');
    assert.equal(app.getCurrentEvidence().executed, false);
    assert.equal(elements.get('#evidence-panel')?.hidden, false);
    await app.copyEvidence();
    assert.deepEqual(JSON.parse(copied), app.getCurrentEvidence());
    app.downloadEvidence();
    assert.equal(downloaded?.filename, 'nymrel-operator-safe-evidence.json');
    assert.deepEqual(JSON.parse(downloaded?.text ?? ''), app.getCurrentEvidence());

    await app.runScenario('blocked');
    assert.equal(elements.get('#status')?.textContent, 'BLOCK');
    assert.equal(app.getCurrentEvidence().decision, 'BLOCK');
    assert.equal(app.getCurrentEvidence().executed, false);

    await app.runScenario('restricted');
    assert.equal(elements.get('#status')?.textContent, 'REFUSED');
    assert.equal(app.getCurrentEvidence().decision, 'REFUSED');
    assert.equal(app.getCurrentEvidence().errorCode, -32602);
    assert.equal(app.getCurrentEvidence().executed, false);
  } finally {
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
});
