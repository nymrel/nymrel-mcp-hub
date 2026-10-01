import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

type FakeElement = {
  dataset: Record<string, string>;
  disabled: boolean;
  hidden: boolean;
  textContent: string;
  addEventListener: (name: string, handler: () => unknown) => void;
};

function createHarness(createOperatorApp: any, fetchImpl: any) {
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
  const root = {
    querySelector(selector: string) {
      return elements.get(selector);
    },
    querySelectorAll() {
      return [];
    }
  };

  let copied = '';
  let downloaded: { filename: string; text: string } | undefined;
  const app = createOperatorApp({
    root,
    fetchImpl,
    copyText: async (text: string) => {
      copied = text;
    },
    downloadText: (filename: string, text: string) => {
      downloaded = { filename, text };
    }
  });

  return {
    app,
    elements,
    getCopied: () => copied,
    getDownloaded: () => downloaded
  };
}

function response(payload: unknown) {
  return { json: async () => payload };
}

const initialized = response({ result: { protocolVersion: '2025-11-25' } });

function verdict(value: 'ALLOW' | 'BLOCK') {
  return response({
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          verdict: value,
          violations: value === 'BLOCK' ? ['recursive deletion blocked'] : []
        })
      }]
    }
  });
}

async function loadOperatorApp() {
  const browserClientUrl = pathToFileURL(resolve('examples/alexa-web-client.mjs')).href;
  return (await import(browserClientUrl)).createOperatorApp;
}

test('a failed current run clears prior exportable evidence', async () => {
  const createOperatorApp = await loadOperatorApp();
  let failRequests = false;
  const harness = createHarness(createOperatorApp, async (_path: string, init: RequestInit) => {
    if (failRequests) throw new Error('transport failed');
    const request = JSON.parse(String(init.body));
    return request.method === 'initialize' ? initialized : verdict('ALLOW');
  });

  await harness.app.runScenario('safe');
  assert.equal(harness.app.getCurrentEvidence().decision, 'ALLOW');

  failRequests = true;
  await harness.app.runScenario('safe');

  assert.equal(harness.elements.get('#status')?.textContent, 'ERROR');
  assert.equal(harness.app.getCurrentEvidence(), null);
  assert.equal(harness.elements.get('#evidence')?.textContent, '');
  assert.equal(harness.elements.get('#evidence-panel')?.hidden, true);
  assert.equal(harness.elements.get('#copy-evidence')?.disabled, true);
  assert.equal(harness.elements.get('#download-evidence')?.disabled, true);

  await harness.app.copyEvidence();
  harness.app.downloadEvidence();
  assert.equal(harness.getCopied(), '');
  assert.equal(harness.getDownloaded(), undefined);
});

test('a delayed older ALLOW cannot overwrite a newer BLOCK', async () => {
  const createOperatorApp = await loadOperatorApp();
  let releaseSafe!: () => void;
  let announceSafe!: () => void;
  const safeGate = new Promise<void>((resolveGate) => {
    releaseSafe = resolveGate;
  });
  const safeStarted = new Promise<void>((resolveStarted) => {
    announceSafe = resolveStarted;
  });
  const harness = createHarness(createOperatorApp, async (_path: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body));
    if (request.method === 'initialize') return initialized;
    if (request.params.arguments.command === 'npm test') {
      announceSafe();
      await safeGate;
      return verdict('ALLOW');
    }
    return verdict('BLOCK');
  });

  const olderRun = harness.app.runScenario('safe');
  await safeStarted;

  assert.equal(harness.app.getCurrentEvidence(), null);
  assert.equal(harness.elements.get('#evidence-panel')?.hidden, true);
  assert.equal(harness.elements.get('#copy-evidence')?.disabled, true);
  assert.equal(harness.elements.get('#download-evidence')?.disabled, true);

  await harness.app.runScenario('blocked');
  assert.equal(harness.app.getCurrentEvidence().decision, 'BLOCK');
  assert.equal(harness.elements.get('#copy-evidence')?.disabled, false);
  assert.equal(harness.elements.get('#download-evidence')?.disabled, false);

  releaseSafe();
  await olderRun;

  assert.equal(harness.elements.get('#status')?.textContent, 'BLOCK');
  assert.equal(harness.app.getCurrentEvidence().decision, 'BLOCK');
});
