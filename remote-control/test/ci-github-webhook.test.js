import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGitHubCiWebhook } from '../src/ci-github-webhook.js';
import { hmacSha256 } from '../src/crypto.js';

const secret = 's'.repeat(32);

function signed(payload, eventName, extras = {}) {
  const rawBody = Buffer.from(JSON.stringify(payload), 'utf8');
  return normalizeGitHubCiWebhook({
    secret,
    rawBody,
    signatureHeader: `sha256=${hmacSha256(secret, rawBody)}`,
    deliveryId: extras.deliveryId ?? 'delivery-123',
    eventName,
    trustedRepositories: extras.trustedRepositories ?? ['nymrel/example']
  });
}

function repository() {
  return { full_name: 'nymrel/example' };
}

function pullRequestPayload({ headRepository = 'nymrel/example', action = 'synchronize', draft = false } = {}) {
  return {
    action,
    number: 42,
    repository: repository(),
    sender: { login: 'studio-agent' },
    pull_request: {
      draft,
      head: { sha: 'a'.repeat(40), ref: 'feature/ci', repo: { full_name: headRepository } },
      base: { ref: 'main', repo: repository() }
    }
  };
}

test('signed allowlisted branch push is eligible trusted studio input', () => {
  const result = signed({
    repository: repository(),
    sender: { login: 'studio-agent' },
    ref: 'refs/heads/main',
    after: 'a'.repeat(40),
    created: false,
    deleted: false,
    forced: false
  }, 'push');
  assert.equal(result.sourceTrust, 'trusted_studio');
  assert.equal(result.dispatchEligible, true);
  assert.equal(result.commitSha, 'a'.repeat(40));
});

test('signature mismatch is rejected before payload classification', () => {
  const rawBody = Buffer.from(JSON.stringify({ repository: repository() }));
  assert.throws(() => normalizeGitHubCiWebhook({
    secret,
    rawBody,
    signatureHeader: `sha256=${'0'.repeat(64)}`,
    deliveryId: 'delivery-1',
    eventName: 'push',
    trustedRepositories: ['nymrel/example']
  }), /signature mismatch/);
});

test('fork pull request stays untrusted even with a valid GitHub signature', () => {
  const result = signed(pullRequestPayload({ headRepository: 'outside/fork' }), 'pull_request');
  assert.equal(result.sourceTrust, 'untrusted_contribution');
  assert.equal(result.dispatchEligible, false);
  assert.equal(result.reason, 'fork_or_external_head');
});

test('same-repository non-draft pull request can become trusted input', () => {
  const result = signed(pullRequestPayload(), 'pull_request');
  assert.equal(result.sourceTrust, 'trusted_studio');
  assert.equal(result.dispatchEligible, true);
  assert.equal(result.pullRequestNumber, 42);
});

test('draft, unsupported PR actions, deleted refs, and non-branch pushes do not dispatch', () => {
  assert.equal(signed(pullRequestPayload({ draft: true }), 'pull_request').dispatchEligible, false);
  assert.equal(signed(pullRequestPayload({ action: 'closed' }), 'pull_request').dispatchEligible, false);

  const deleted = signed({
    repository: repository(),
    ref: 'refs/heads/old',
    after: '0'.repeat(40),
    deleted: true
  }, 'push');
  assert.equal(deleted.dispatchEligible, false);
  assert.equal(deleted.reason, 'deleted_ref');

  const tag = signed({
    repository: repository(),
    ref: 'refs/tags/v1.0.0',
    after: 'b'.repeat(40),
    deleted: false
  }, 'push');
  assert.equal(tag.dispatchEligible, false);
  assert.equal(tag.reason, 'non_branch_ref');
});
