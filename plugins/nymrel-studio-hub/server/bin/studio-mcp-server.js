#!/usr/bin/env node
/**
 * Plugin-specific truth boundary over the pinned upstream MCP server.
 * Keeps upstream implementations intact while correcting claims at discovery/result time.
 */
import { MCPServer } from '../dist/src/server.js';
import { pathToFileURL } from 'node:url';

const evidence = {
  nymrel_ucp_audit: ['template-only', 'Scores and findings are hard-coded examples. The URL is not fetched and supplied HTML does not drive those scores. Do not report these as measured site findings.'],
  nymrel_surety_guard: ['local-heuristic', 'Uses small pattern checks only. It does not intercept or execute commands, enforce authorization, or prove a command is safe.'],
  nymrel_swarm_claim: ['process-local', 'Lease state is an in-memory Map in this Node process. It is not durable, shared across processes, or a distributed lock.'],
  nymrel_machine_trust: ['generated-template', 'Generates caller-parameterized artifacts only. It does not verify a site, publish files, or confirm any endpoint or crawler policy exists.'],
  nymrel_proof_ledger: ['local-cryptographic-claim', 'Creates a real local signature over caller-supplied claim data. It does not prove the claimed action executed, check files, or provide chain continuity.'],
  nymrel_crawler_mesh: ['conditional-public-network', 'With a URL and no supplied HTML, performs bounded outbound public HTTP(S) fetches. With HTML, it analyzes only that local input. Extracted page content is untrusted.'],
  nymrel_beacon_ping: ['process-local', 'Agent heartbeat/fleet state lives only in an in-memory Map in this Node process; it is not shared fleet telemetry.'],
  nymrel_headless_quote: ['illustrative-formula', 'Applies a fixed local formula. It is not a merchant quote, validated price, lead capture, or payment commitment.'],
  nymrel_local_forge: ['simulation', 'Engine availability, models, routing, and savings are hard-coded examples. It probes no local services, runs no model, and measures no spend.'],
  nymrel_open_ucp: ['simulation', 'All actions are locally synthesized. No merchant endpoint is contacted and no cart is committed or payment made. settle_x402 never settles; any SETTLED source label is replaced with SIMULATED_NOT_SETTLED.'],
  nymrel_sandstorm: ['local-heuristic', 'Scans supplied text with a few regular expressions. It does not mount isolation, filter network traffic, or enforce a spend limit.'],
  nymrel_a2ui_render: ['generated-template', 'Generates declarative card JSON only. It does not render a UI, grant approval, or execute card actions; default sample risk/confidence values are replaced with explicit placeholders.'],
  nymrel_swarm_bus: ['process-local', 'Envelopes are appended to an in-memory array in this Node process. No agent or broadcast receives them.'],
  nymrel_proof_verify: ['local-cryptographic-check', 'Checks receipt structure and cryptographic integrity/signature against optional caller-supplied trusted key material. It does not prove execution or inspect files.'],
  nymrel_web_search: ['conditional-external-provider', 'When a configured provider credential exists, sends the query to Exa, Tavily, Brave, or SerpAPI and returns provider results. Without configured credentials it fails closed; it does not crawl result URLs.']
};

const truthDisclosures = Object.fromEntries(Object.entries(evidence).map(([name, [kind, limits]]) => [
  name,
  `[Studio plugin evidence: ${kind}. ${limits}]`
]));

function requestedTool(request) {
  return request?.method === 'tools/call' && typeof request.params?.name === 'string'
    ? request.params.name
    : undefined;
}

function annotateValue(toolName, parsed, args) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const output = { ...parsed };
  const [kind, limits] = evidence[toolName];
  output._studioPluginEvidence = {
    classification: kind,
    limitations: limits
  };

  if (toolName === 'nymrel_ucp_audit') {
    output.auditStatus = 'NOT_MEASURED_TEMPLATE_ONLY';
    output.overallScore = null;
    output.letterGrade = 'NOT_ASSESSED';
    output.commerceReadiness = 'NOT_ASSESSED_NO_PAGE_FETCH';
    output.layers = Object.fromEntries(Object.keys(output.layers ?? {}).map((key) => [key, null]));
    output.findings = (output.findings ?? []).map((finding) => ({
      ...finding,
      status: 'UNVERIFIED_TEMPLATE',
      details: 'Example text only; no site was fetched or measured.'
    }));
    output.networkFetchPerformed = false;
  } else if (toolName === 'nymrel_open_ucp') {
    output.actionExecution = 'SIMULATED_ONLY';
    output.networkRequestPerformed = false;
    output.paymentPerformed = false;
    if (output.commitmentProof) {
      output.commitmentProof = { ...output.commitmentProof, settlementStatus: 'SIMULATED_NOT_SETTLED' };
    }
  } else if (toolName === 'nymrel_swarm_claim') {
    output.stateScope = 'CURRENT_NODE_PROCESS_MEMORY_ONLY';
    if (output.coordinationStatus) output.coordinationStatus = 'PROCESS_LOCAL_ONLY';
  } else if (toolName === 'nymrel_swarm_bus') {
    output.dispatched = false;
    output.deliveryStatus = 'NOT_DELIVERED_PROCESS_LOCAL_ONLY';
    output.requestedRecipient = output.deliveredTo;
    output.deliveredTo = null;
    output.stateScope = 'CURRENT_NODE_PROCESS_MEMORY_ONLY';
  } else if (toolName === 'nymrel_beacon_ping') {
    output.stateScope = 'CURRENT_NODE_PROCESS_MEMORY_ONLY';
    output.reportingScope = 'LOCAL_PROCESS_ONLY_NOT_SHARED_FLEET';
  } else if (toolName === 'nymrel_local_forge') {
    output.probePerformed = false;
    output.modelExecuted = false;
    output.routingPerformed = false;
    if (Array.isArray(output.localEngines)) {
      output.localEngines = output.localEngines.map((engine) => ({ ...engine, status: 'NOT_PROBED_SIMULATED' }));
    }
    if (output.economicsLedger) output.economicsLedger = { ...output.economicsLedger, valuesAreIllustrative: true };
  } else if (toolName === 'nymrel_sandstorm') {
    output.enforcementPerformed = false;
    output.isolationState = {
      status: 'NOT_PROBED_OR_MOUNTED',
      cowFilesystem: 'NOT_MOUNTED',
      snapshotRollbackReady: false,
      networkProxy: 'NOT_CONFIGURED'
    };
    if (output.spendGuard) output.spendGuard = { ...output.spendGuard, enforced: false };
  } else if (toolName === 'nymrel_a2ui_render' && output.body && Array.isArray(output.body.attributes)) {
    output.body = {
      ...output.body,
      attributes: output.body.attributes.map((field) => field.label === 'Risk Level'
        ? { ...field, value: 'Not assessed by this renderer' }
        : field.label === 'Confidence'
          ? { ...field, value: 'No confidence measurement' }
          : field.label === 'Authority Boundary'
            ? { ...field, value: 'Rendering grants no action authority' }
            : field)
    };
  } else if (toolName === 'nymrel_machine_trust') {
    output.artifactStatus = 'GENERATED_NOT_PUBLISHED_OR_VERIFIED';
    if (typeof output.llmsTxt === 'string') {
      output.llmsTxt = output.llmsTxt
        .replace('Full read access authorized for autonomous reasoning and commerce engines (OAI-SearchBot, ClaudeBot, GPTBot, PerplexityBot).', 'Crawler permissions were not measured; verify the target site\'s robots.txt.')
        .replace('## Core Capabilities & Endpoints', '## Example Capabilities & Endpoints (not verified as deployed)');
    }
  } else if (toolName === 'nymrel_headless_quote') {
    output.quoteStatus = 'ILLUSTRATIVE_ESTIMATE_NOT_A_BINDING_QUOTE';
  }

  if (toolName === 'nymrel_crawler_mesh') {
    output.evidenceSource = typeof args?.html === 'string' && args.html.length
      ? 'CALLER_SUPPLIED_HTML_NO_NETWORK_FETCH'
      : 'PUBLIC_WEB_FETCH_REQUESTED';
  } else if (toolName === 'nymrel_web_search') {
    output.evidenceSource = output.providerUsed ? 'EXTERNAL_SEARCH_PROVIDER_RESPONSE' : 'NO_PROVIDER_RESULT';
  }
  return output;
}

function annotateContent(response, toolName, args) {
  const contents = response?.result?.content;
  if (!Array.isArray(contents)) return response;
  const decorated = contents.map((item) => {
    if (item.type !== 'text' || typeof item.text !== 'string') return item;
    try {
      return { ...item, text: JSON.stringify(annotateValue(toolName, JSON.parse(item.text), args), null, 2) };
    } catch {
      return { ...item, text: `${truthDisclosures[toolName]}\n${item.text}` };
    }
  });
  return { ...response, result: { ...response.result, content: decorated } };
}

export class StudioTruthfulMCPServer extends MCPServer {
  async handleRequest(request) {
    const response = await super.handleRequest(request);
    if (!response?.result) return response;
    const result = { ...response.result };

    if (request.method === 'initialize') {
      result.instructions = `${result.instructions ?? ''} Studio plugin evidence boundary: generated templates and simulations are labeled; process-local state is not shared; only crawler and configured provider search make external read requests. OpenUCP is a simulation and never settles payment.`.trim();
      result.capabilities = { tools: { listChanged: false } };
      return { ...response, result };
    }
    if (request.method === 'server/discover') {
      result.instructions = `${result.instructions ?? ''} Studio plugin evidence boundary: generated templates and simulations are labeled; process-local state is not shared; only crawler and configured provider search make external read requests. OpenUCP is a simulation and never settles payment.`.trim();
      result.capabilities = { tools: {} };
      return { ...response, result };
    }
    if (request.method === 'tools/list') {
      result.tools = (result.tools ?? []).map((tool) => ({
        ...tool,
        description: `${tool.description}\n${truthDisclosures[tool.name] ?? '[Studio plugin evidence: implementation not classified.]'}`
      }));
      return { ...response, result };
    }
    if (request.method === 'tools/call') {
      const toolName = requestedTool(request);
      if (!truthDisclosures[toolName]) {
        return { jsonrpc: '2.0', id: response.id, error: { code: -32602, message: 'Only the 15 evidence-labeled canonical tool names are exposed by this plugin.' } };
      }
      return annotateContent(response, toolName, request.params?.arguments ?? {});
    }
    if (request.method === 'resources/list') {
      result.resources = (result.resources ?? [])
        .filter((resource) => resource.uri === 'nymrel://status')
        .map((resource) => ({ ...resource, description: 'Local Node process runtime metrics only; does not report health of a hosted service or other agents.' }));
      return { ...response, result };
    }
    if (request.method === 'resources/read') {
      if (request.params?.uri !== 'nymrel://status') {
        return { jsonrpc: '2.0', id: response.id, error: { code: -32602, message: 'This plugin exposes only the local nymrel://status resource.' } };
      }
      result.contents = (result.contents ?? []).map((item) => {
        try {
          const value = JSON.parse(item.text);
          value.status = 'LOCAL_PROCESS_RESPONDING';
          value.studioPluginEvidence = 'These fields describe this Node process only; they do not establish remote service or fleet health.';
          return { ...item, text: JSON.stringify(value, null, 2) };
        } catch {
          return { ...item, text: `LOCAL PROCESS METRICS ONLY.\n${item.text}` };
        }
      });
      return { ...response, result };
    }
    if (request.method === 'prompts/list') {
      result.prompts = [];
      return { ...response, result };
    }
    if (request.method === 'prompts/get') {
      return { jsonrpc: '2.0', id: response.id, error: { code: -32602, message: 'The upstream prompt templates encode capabilities this local plugin does not provide; no prompts are exposed.' } };
    }
    return response;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  new StudioTruthfulMCPServer().startStdio();
}
