import {
  buildDecisionEvidence,
  formatDecisionEvidence,
  WEB_PROTOCOL_VERSION
} from './alexa-web-receipt.mjs';

function defaultCopy(text) {
  if (!globalThis.navigator?.clipboard?.writeText) {
    throw new Error('Clipboard access is unavailable in this browser');
  }
  return globalThis.navigator.clipboard.writeText(text);
}

function defaultDownload(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function createOperatorApp({
  root,
  fetchImpl = globalThis.fetch,
  copyText = defaultCopy,
  downloadText = defaultDownload
}) {
  if (!root || typeof fetchImpl !== 'function') {
    throw new TypeError('Operator app requires a document root and fetch implementation');
  }

  const status = root.querySelector('#status');
  const answer = root.querySelector('#answer');
  const evidencePanel = root.querySelector('#evidence-panel');
  const evidenceOutput = root.querySelector('#evidence');
  const copyButton = root.querySelector('#copy-evidence');
  const downloadButton = root.querySelector('#download-evidence');
  let currentEvidence = null;
  let nextId = 1;
  let activeRun = 0;

  async function rpc(method, params = {}) {
    const headers = { 'content-type': 'application/json', accept: 'application/json' };
    if (method !== 'initialize') headers['mcp-protocol-version'] = WEB_PROTOCOL_VERSION;
    const response = await fetchImpl('/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params })
    });
    return response.json();
  }

  function toolResult(payload) {
    const text = payload?.result?.content?.find((item) => item?.type === 'text')?.text;
    return typeof text === 'string' ? JSON.parse(text) : null;
  }

  async function initialize() {
    const payload = await rpc('initialize', {
      protocolVersion: WEB_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'nymrel-alexa-web-simulator', version: '1.0.0' }
    });
    if (payload?.result?.protocolVersion !== WEB_PROTOCOL_VERSION) {
      throw new Error('MCP handshake failed');
    }
  }

  function clearEvidence() {
    currentEvidence = null;
    evidenceOutput.textContent = '';
    evidencePanel.hidden = true;
    copyButton.disabled = true;
    copyButton.textContent = 'Copy evidence';
    downloadButton.disabled = true;
  }

  function renderDecision(run, statusText, answerText, evidence) {
    if (run !== activeRun) return;
    status.textContent = statusText;
    answer.textContent = answerText;
    currentEvidence = evidence;
    evidenceOutput.textContent = formatDecisionEvidence(evidence);
    evidencePanel.hidden = false;
    copyButton.disabled = false;
    downloadButton.disabled = false;
  }

  async function runScenario(name) {
    const run = ++activeRun;
    clearEvidence();
    status.textContent = 'Checking';
    answer.textContent = 'Running the local MCP safety workflow…';

    try {
      await initialize();
      if (run !== activeRun) return;

      if (name === 'restricted') {
        const payload = await rpc('tools/call', { name: 'nymrel_swarm_claim', arguments: {} });
        if (run !== activeRun) return;
        if (payload?.error?.code !== -32602) throw new Error('Unexpected hosted boundary response');
        const message = 'That tool is not exposed through the reviewed Alexa+ hosted allowlist.';
        renderDecision(run, 'REFUSED', message, buildDecisionEvidence({
          scenario: name,
          tool: 'nymrel_swarm_claim',
          decision: 'REFUSED',
          errorCode: payload.error.code,
          reason: message
        }));
        return;
      }

      const destructive = name === 'blocked';
      const payload = await rpc('tools/call', {
        name: 'nymrel_surety_guard',
        arguments: {
          command: destructive ? 'rm -rf /' : 'npm test',
          workingDirectory: '/workspace/nymrel-mcp-hub',
          strict: true
        }
      });
      if (run !== activeRun) return;
      const result = toolResult(payload);

      if (result?.verdict === 'ALLOW') {
        const message = 'Yes. The requested test command is bounded and passed the strict pre-execution safety check.';
        renderDecision(run, 'ALLOW', message, buildDecisionEvidence({
          scenario: name,
          tool: 'nymrel_surety_guard',
          decision: result.verdict,
          reason: message
        }));
      } else if (result?.verdict === 'BLOCK') {
        const message = 'I will not run that command. Nymrel blocked it before execution because it targets recursive deletion outside a bounded worktree.';
        renderDecision(run, 'BLOCK', message, buildDecisionEvidence({
          scenario: name,
          tool: 'nymrel_surety_guard',
          decision: result.verdict,
          reason: result.violations?.[0] ?? message
        }));
      } else {
        throw new Error('Unexpected tool verdict');
      }
    } catch (error) {
      if (run !== activeRun) return;
      status.textContent = 'ERROR';
      answer.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  async function copyEvidence() {
    if (!currentEvidence) return;
    await copyText(formatDecisionEvidence(currentEvidence));
    copyButton.textContent = 'Copied';
  }

  function downloadEvidence() {
    if (!currentEvidence) return;
    downloadText(
      `nymrel-operator-${currentEvidence.scenario}-evidence.json`,
      formatDecisionEvidence(currentEvidence)
    );
  }

  root.querySelectorAll('[data-scenario]').forEach((button) => {
    button.addEventListener('click', () => runScenario(button.dataset.scenario));
  });
  copyButton.addEventListener('click', copyEvidence);
  downloadButton.addEventListener('click', downloadEvidence);

  return {
    copyEvidence,
    downloadEvidence,
    getCurrentEvidence: () => currentEvidence,
    runScenario
  };
}

if (typeof document !== 'undefined') {
  createOperatorApp({ root: document });
}
