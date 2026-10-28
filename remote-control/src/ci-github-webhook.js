import { constantTimeEqual, hmacSha256 } from './crypto.js';

const REPOSITORY_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const DELIVERY_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const PR_ACTIONS = new Set(['opened', 'reopened', 'synchronize', 'ready_for_review']);

function parseSignedPayload({ secret, signatureHeader, rawBody }) {
  if ((typeof secret !== 'string' && !Buffer.isBuffer(secret)) || Buffer.byteLength(secret) < 32) {
    throw new Error('GitHub webhook secret must contain at least 32 bytes');
  }
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ''), 'utf8');
  if (body.length === 0 || body.length > MAX_WEBHOOK_BYTES) throw new Error('GitHub webhook body size is invalid');
  const match = /^sha256=([0-9a-f]{64})$/i.exec(String(signatureHeader ?? ''));
  if (!match) throw new Error('GitHub webhook signature header is invalid');
  const expected = hmacSha256(secret, body);
  if (!constantTimeEqual(expected, match[1].toLowerCase())) throw new Error('GitHub webhook signature mismatch');
  try {
    return JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('GitHub webhook body is not valid JSON');
  }
}

function repositoryName(value, label) {
  if (typeof value !== 'string' || !REPOSITORY_RE.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function commitSha(value, label) {
  if (typeof value !== 'string' || !SHA_RE.test(value)) throw new Error(`${label} is invalid`);
  return value.toLowerCase();
}

function trustFor(repository, headRepository, trusted) {
  if (!trusted.has(repository)) return { sourceTrust: 'untrusted_contribution', reason: 'repository_not_allowlisted' };
  if (headRepository && headRepository !== repository) return { sourceTrust: 'untrusted_contribution', reason: 'fork_or_external_head' };
  return { sourceTrust: 'trusted_studio', reason: 'allowlisted_same_repository' };
}

export function normalizeGitHubCiWebhook({
  secret,
  signatureHeader,
  rawBody,
  deliveryId,
  eventName,
  trustedRepositories = []
}) {
  if (typeof deliveryId !== 'string' || !DELIVERY_RE.test(deliveryId)) throw new Error('GitHub delivery id is invalid');
  if (!['push', 'pull_request'].includes(eventName)) throw new Error('GitHub event is not supported for CI');
  const payload = parseSignedPayload({ secret, signatureHeader, rawBody });
  const repository = repositoryName(payload?.repository?.full_name, 'GitHub repository.full_name');
  const trusted = new Set(trustedRepositories.map((item) => repositoryName(item, 'trusted repository')));
  const sender = typeof payload?.sender?.login === 'string' ? payload.sender.login : null;

  if (eventName === 'push') {
    const deleted = payload.deleted === true || /^0{40}$/.test(String(payload.after ?? ''));
    const ref = typeof payload.ref === 'string' ? payload.ref : '';
    const trust = trustFor(repository, null, trusted);
    if (deleted) {
      return {
        schema: 'nymrel.ci.github-trigger/v1',
        deliveryId, eventName, repository, ref, sender,
        sourceTrust: trust.sourceTrust,
        dispatchEligible: false,
        reason: 'deleted_ref'
      };
    }
    const sha = commitSha(payload.after, 'GitHub push after SHA');
    const branchRef = ref.startsWith('refs/heads/');
    return {
      schema: 'nymrel.ci.github-trigger/v1',
      deliveryId,
      eventName,
      repository,
      ref,
      commitSha: sha,
      sender,
      sourceTrust: trust.sourceTrust,
      dispatchEligible: branchRef && trust.sourceTrust === 'trusted_studio',
      reason: !branchRef ? 'non_branch_ref' : trust.reason,
      forced: payload.forced === true,
      created: payload.created === true
    };
  }

  const action = String(payload.action ?? '');
  const number = Number(payload.number);
  if (!Number.isInteger(number) || number < 1) throw new Error('GitHub pull request number is invalid');
  const baseRepository = repositoryName(payload?.pull_request?.base?.repo?.full_name, 'GitHub PR base repository');
  if (baseRepository !== repository) throw new Error('GitHub PR base repository does not match webhook repository');
  const headRepository = repositoryName(payload?.pull_request?.head?.repo?.full_name, 'GitHub PR head repository');
  const sha = commitSha(payload?.pull_request?.head?.sha, 'GitHub PR head SHA');
  const trust = trustFor(repository, headRepository, trusted);
  const supportedAction = PR_ACTIONS.has(action);
  const draft = payload?.pull_request?.draft === true;
  return {
    schema: 'nymrel.ci.github-trigger/v1',
    deliveryId,
    eventName,
    action,
    repository,
    pullRequestNumber: number,
    commitSha: sha,
    ref: String(payload?.pull_request?.head?.ref ?? ''),
    baseRef: String(payload?.pull_request?.base?.ref ?? ''),
    headRepository,
    sender,
    draft,
    sourceTrust: trust.sourceTrust,
    dispatchEligible: supportedAction && !draft && trust.sourceTrust === 'trusted_studio',
    reason: !supportedAction ? 'unsupported_pr_action' : draft ? 'draft_pull_request' : trust.reason
  };
}
