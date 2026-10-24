export const WEB_PROTOCOL_VERSION = '2025-11-25';

const LIMITATIONS = Object.freeze([
  'Local simulation; not evidence of Alexa+ platform validation.',
  'No inspected command was executed.',
  'No public endpoint, cloud service, account, credential, or external network was used.'
]);

export function buildDecisionEvidence({ scenario, tool, decision, reason, errorCode }) {
  if (![scenario, tool, decision, reason].every((value) => typeof value === 'string' && value.length > 0)) {
    throw new TypeError('Decision evidence requires non-empty scenario, tool, decision, and reason');
  }

  return Object.freeze({
    schemaVersion: 1,
    protocolVersion: WEB_PROTOCOL_VERSION,
    transport: 'loopback-streamable-http',
    source: 'live-local-mcp-response',
    scenario,
    tool,
    decision,
    ...(Number.isInteger(errorCode) ? { errorCode } : {}),
    reason,
    executed: false,
    limitations: [...LIMITATIONS]
  });
}

export function formatDecisionEvidence(evidence) {
  return `${JSON.stringify(evidence, null, 2)}\n`;
}
