import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCiPlan, validateCiManifest } from '../src/ci-contract.js';

const fixture = {
  version: 1,
  jobs: [
    { id: 'lint', command: 'npm run lint' },
    { id: 'test', command: 'npm test', dependsOn: ['lint'], timeoutSeconds: 1200 },
    { id: 'package', command: 'npm pack --dry-run', dependsOn: ['test'], requiresNetwork: false }
  ]
};

test('normalizes and hashes a manifest deterministically', () => {
  const first = validateCiManifest(fixture);
  const second = validateCiManifest(JSON.parse(JSON.stringify(fixture)));
  assert.equal(first.manifestHash, second.manifestHash);
  assert.equal(first.manifest.jobs[0].cwd, '.');
  assert.equal(first.manifest.jobs[0].timeoutSeconds, 900);
});

test('builds dependency-ordered selected plans', () => {
  const { plan } = buildCiPlan(fixture, { selectedJobs: ['package'], platform: process.platform });
  assert.deepEqual(plan.jobs.map((job) => job.id), ['lint', 'test', 'package']);
});

test('denies network-requiring jobs unless runner policy allows network', () => {
  const manifest = { version: 1, jobs: [{ id: 'install', command: 'npm ci', requiresNetwork: true }] };
  assert.throws(() => buildCiPlan(manifest), /runner policy denies/);
  assert.equal(buildCiPlan(manifest, { allowNetwork: true }).plan.jobs[0].id, 'install');
});

test('rejects repository escapes and dependency cycles', () => {
  assert.throws(() => validateCiManifest({ version: 1, jobs: [{ id: 'bad', command: 'x', cwd: '../outside' }] }), /inside the repository/);
  assert.throws(() => validateCiManifest({ version: 1, jobs: [
    { id: 'a', command: 'x', dependsOn: ['b'] },
    { id: 'b', command: 'x', dependsOn: ['a'] }
  ] }), /dependency cycle/);
});

test('rejects environment values and unknown capabilities in repository-controlled manifests', () => {
  assert.throws(() => validateCiManifest({ version: 1, jobs: [{ id: 'x', command: 'x', env: { TOKEN: 'secret' } }] }), /env is not supported/);
});
