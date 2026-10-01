import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const path = new URL('../examples/amazon-alexa-friction-log.fixture.json', import.meta.url);
const source = readFileSync(path, 'utf8');
assert(Buffer.byteLength(source) <= 32 * 1024, 'friction fixture must stay <= 32 KiB');

const document = JSON.parse(source);
assert.equal(document.schemaVersion, 1);
assert.equal(document.fixtureOnly, true);
assert.equal(document.competition, 'amazon-build-ship-shape-2026');
assert.equal(document.product, 'nymrel-operator-alexa');
assert(Array.isArray(document.entries));
assert(document.entries.length >= 1 && document.entries.length <= 25);

const allowedStatus = new Set(['observed', 'resolved-in-source', 'blocked-external', 'deferred']);
const secretKey = /(?:^|_)(?:token|password|credential|cookie|authorization|api_?key|private_?key)(?:$|_)/iu;
const secretValue = /(?:Bearer\s+[A-Za-z0-9._~+\/-]+=*|\bsk-[A-Za-z0-9_-]{12,}|\bghp_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}|BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY)/u;

function walk(value, pathParts = []) {
  if (typeof value === 'string') {
    assert.equal(secretValue.test(value), false, `friction fixture contains credential-like value at ${pathParts.join('.')}`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => walk(item, [...pathParts, String(index)]));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key !== 'secretFree') {
      assert.equal(secretKey.test(key), false, `friction fixture contains secret-bearing key at ${[...pathParts, key].join('.')}`);
    }
    walk(child, [...pathParts, key]);
  }
}

for (const [index, entry] of document.entries.entries()) {
  assert(entry && typeof entry === 'object' && !Array.isArray(entry));
  for (const key of ['id', 'stage', 'category', 'problem', 'resolution', 'status', 'source']) {
    assert.equal(typeof entry[key], 'string', `entry ${index} missing string ${key}`);
    assert(entry[key].length > 0, `entry ${index} has empty ${key}`);
  }
  assert.equal(entry.secretFree, true, `entry ${index} must declare secretFree:true`);
  assert.equal(entry.source, 'local-fixture', `entry ${index} must stay fixture-scoped`);
  assert(allowedStatus.has(entry.status), `entry ${index} has unsupported status`);
}

walk(document);
process.stdout.write(`Verified Alexa+ friction fixture: ${document.entries.length} entries, secret-free fixture scope.\n`);
