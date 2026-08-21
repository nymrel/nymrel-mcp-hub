/**
 * Automated Test Suite: MCP Tool Verification
 * Verifies registration and execution of all 14 Nymrel MCP tools
 */

import test from 'node:test';
import assert from 'node:assert';
import {
  ALL_MCP_TOOLS,
  dispatchToolCall,
  executeUcpAudit,
  executeSuretyGuard,
  executeSwarmClaim,
  executeMachineTrust,
  executeProofLedger,
  executeCrawler,
  executeBeacon,
  executeQuote,
  executeLocalForge,
  executeOpenUcp,
  executeSandstorm,
  executeA2ui,
  executeSwarmBus,
  executeProofVerify
} from '../src/tools/index.js';

test('MCP Tool Registry: Contains exactly 14 registered tools', () => {
  assert.strictEqual(ALL_MCP_TOOLS.length, 14);
  const toolNames = ALL_MCP_TOOLS.map(t => t.name);
  
  assert.ok(toolNames.includes('nymrel_ucp_audit'));
  assert.ok(toolNames.includes('nymrel_surety_guard'));
  assert.ok(toolNames.includes('nymrel_swarm_claim'));
  assert.ok(toolNames.includes('nymrel_machine_trust'));
  assert.ok(toolNames.includes('nymrel_proof_ledger'));
  assert.ok(toolNames.includes('nymrel_crawler_mesh'));
  assert.ok(toolNames.includes('nymrel_beacon_ping'));
  assert.ok(toolNames.includes('nymrel_headless_quote'));
  assert.ok(toolNames.includes('nymrel_local_forge'));
  assert.ok(toolNames.includes('nymrel_open_ucp'));
  assert.ok(toolNames.includes('nymrel_sandstorm'));
  assert.ok(toolNames.includes('nymrel_a2ui_render'));
  assert.ok(toolNames.includes('nymrel_swarm_bus'));
  assert.ok(toolNames.includes('nymrel_proof_verify'));
});

test('MCP Tool: nymrel_ucp_audit execution', async () => {
  const result = await executeUcpAudit({ url: 'https://nymrel.com' });
  assert.ok(result.content.length > 0);
  const parsed = JSON.parse(result.content[0].text!);
  assert.strictEqual(parsed.target, 'https://nymrel.com');
  assert.ok(parsed.overallScore >= 0 && parsed.overallScore <= 100);
  assert.ok(parsed.layers.discoveryCrawler > 0);
  assert.strictEqual(parsed.commerceReadiness, 'READY_FOR_AUTONOMOUS_PURCHASING');
});

test('MCP Tool: nymrel_surety_guard blocks dangerous commands and allows safe ones', async () => {
  const safeRes = await executeSuretyGuard({ command: 'npm run test' });
  const safeData = JSON.parse(safeRes.content[0].text!);
  assert.strictEqual(safeData.verdict, 'ALLOW');
  assert.strictEqual(safeData.isSafe, true);

  const dangerousRes = await executeSuretyGuard({ command: 'rm -rf /' });
  const dangerousData = JSON.parse(dangerousRes.content[0].text!);
  assert.strictEqual(dangerousData.verdict, 'BLOCK');
  assert.strictEqual(dangerousData.isSafe, false);
  assert.ok(dangerousData.violations.length > 0);
});

test('MCP Tool: nymrel_swarm_claim lock coordinator and fencing generations', async () => {
  const claimRes = await executeSwarmClaim({
    repoPath: 'C:\\Users\\johns\\Desktop\\nymrel-mcp-hub',
    agentId: 'codex-sol',
    role: 'mission_owner'
  });
  const claimData = JSON.parse(claimRes.content[0].text!);
  assert.strictEqual(claimData.success, true);
  assert.ok(claimData.fencingToken >= 1000);
  assert.strictEqual(claimData.role, 'mission_owner');

  // Conflict test by another agent
  const conflictRes = await executeSwarmClaim({
    repoPath: 'C:\\Users\\johns\\Desktop\\nymrel-mcp-hub',
    agentId: 'claude-opus'
  });
  const conflictData = JSON.parse(conflictRes.content[0].text!);
  assert.strictEqual(conflictData.success, false);
  assert.strictEqual(conflictData.currentHolder, 'codex-sol');
});

test('MCP Tool: nymrel_machine_trust generates JSON-LD entity graph and /llms.txt', async () => {
  const res = await executeMachineTrust({
    entityName: 'Nymrel MCP Hub',
    domain: 'https://nymrel.com',
    targetFormat: 'all'
  });
  const data = JSON.parse(res.content[0].text!);
  assert.ok(data.jsonLd);
  assert.ok(data.llmsTxt);
  assert.ok(data.robotsTxt);
  assert.strictEqual(data.jsonLd['@graph'][0].author.parentOrganization.name, 'JalenBuilds LLC');
  assert.ok(data.llmsTxt.includes('Nymrel MCP Hub'));
});

test('MCP Tool: nymrel_proof_ledger and nymrel_proof_verify round-trip', async () => {
  const proofRes = await executeProofLedger({
    action: 'test_execution',
    agentId: 'antigravity-gemini',
    payload: { testRun: true, status: 'pass' }
  });
  const receipt = JSON.parse(proofRes.content[0].text!);
  assert.ok(receipt.receiptId);
  assert.ok(receipt.leafHash);
  assert.ok(receipt.merkleRoot);

  const verifyRes = await executeProofVerify({ receipt });
  const verifyData = JSON.parse(verifyRes.content[0].text!);
  assert.strictEqual(verifyData.verified, true);
  assert.strictEqual(verifyData.verificationVerdict, 'PROOF_VALID_AND_TAMPER_FREE');
});

test('MCP Tool: nymrel_crawler_mesh extracts clean markdown', async () => {
  const html = '<html><body><h1>Clean Title</h1><p>Test paragraph with <a href="https://nymrel.com">link</a></p></body></html>';
  const res = await executeCrawler({ html });
  const data = JSON.parse(res.content[0].text!);
  assert.ok(data.markdown.includes('# Clean Title'));
  assert.ok(data.markdown.includes('[link](https://nymrel.com)'));
  assert.ok(data.tokens.cleanMarkdownTokens > 0);
});

test('MCP Tool: nymrel_beacon_ping tracks fleet health', async () => {
  const res = await executeBeacon({
    agentId: 'test-runner-01',
    role: 'tester',
    status: 'online',
    taskSummary: 'Executing automated test suite'
  });
  const data = JSON.parse(res.content[0].text!);
  assert.strictEqual(data.reportingAgent.agentId, 'test-runner-01');
  assert.ok(data.fleetSummary.totalActiveAgents >= 1);
});

test('MCP Tool: nymrel_headless_quote pricing engine', async () => {
  const res = await executeQuote({ preset: 'software', scope: 'medium', featuresCount: 3 });
  const data = JSON.parse(res.content[0].text!);
  assert.ok(data.pricing.estimatedCost > 0);
  assert.ok(data.timeline.estimatedDeliveryDays > 0);
  assert.strictEqual(data.preset, 'software');
});

test('MCP Tool: nymrel_local_forge tier routing and savings', async () => {
  const res = await executeLocalForge({ taskDescription: 'Architect multi-repo security firewall', tokensProcessed: 50000 });
  const data = JSON.parse(res.content[0].text!);
  assert.strictEqual(data.routingDecision.assignedTier, 'SOL');
  assert.ok(data.economicsLedger.netDollarsConserved.length > 0);
});

test('MCP Tool: nymrel_open_ucp x402 challenge', async () => {
  const res = await executeOpenUcp({ action: 'quote' });
  const data = JSON.parse(res.content[0].text!);
  assert.strictEqual(data.x402HeaderChallenge.status, 402);
  assert.ok(data.cartSummary.finalPayableUsd > 0);
});

test('MCP Tool: nymrel_sandstorm secret masking firewall', async () => {
  const secretString = 'Exporting token ghp_1234567890abcdef1234567890abcdef1234 and key sk-12345678901234567890123456';
  const res = await executeSandstorm({ content: secretString });
  const data = JSON.parse(res.content[0].text!);
  assert.strictEqual(data.secretFirewall.secretsDetected, 2);
  assert.ok(data.secretFirewall.cleanPayload.includes('[REDACTED_GH_TOKEN]'));
  assert.ok(data.secretFirewall.cleanPayload.includes('[REDACTED_OPENAI_KEY]'));
});

test('MCP Tool: nymrel_a2ui_render Warm Paper decision card', async () => {
  const res = await executeA2ui({
    title: 'Deploy Production Candidate',
    summary: 'Deploy nymrel-mcp-hub v1.0.0 to GitHub',
    category: 'approval'
  });
  const data = JSON.parse(res.content[0].text!);
  assert.strictEqual(data.schemaVersion, '0.8.0');
  assert.strictEqual(data.theme.surfaceBg, '#FAF8F2');
  assert.strictEqual(data.theme.textPrimary, '#2A332E');
});

test('MCP Tool: nymrel_swarm_bus dispatches envelopes', async () => {
  const res = await executeSwarmBus({
    fromAgent: 'codex-sol',
    toAgent: 'claude-opus',
    topic: 'frontend-review',
    payload: { ready: true }
  });
  const data = JSON.parse(res.content[0].text!);
  assert.strictEqual(data.dispatched, true);
  assert.strictEqual(data.deliveredTo, 'claude-opus');
});

test('MCP Tool: dispatchToolCall handles aliases and errors', async () => {
  const direct = await dispatchToolCall('nymrel_surety_guard', { command: 'ls' });
  assert.ok(direct.content.length > 0);

  const alias = await dispatchToolCall('surety_guard', { command: 'ls' });
  assert.ok(alias.content.length > 0);

  await assert.rejects(async () => {
    await dispatchToolCall('unknown_fake_tool', {});
  }, /not registered/);
});
