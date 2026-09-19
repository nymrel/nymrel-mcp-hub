import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { executeProofLedger, proofLedgerToolDefinition } from '../src/tools/proofLedgerTool.js';
import { executeProofVerify, proofVerifyToolDefinition } from '../src/tools/proofVerifyTool.js';
import { canonicalize } from '../src/vendor/proof-ledger/canonical.js';
import { ProofSigner } from '../src/vendor/proof-ledger/signer.js';
import { verifyReceipt } from '../src/vendor/proof-ledger/receipt.js';
import { MerkleTree } from '../src/vendor/proof-ledger/merkle.js';

const root = new URL('../../', import.meta.url);
const readJson = (path: string) => JSON.parse(readFileSync(new URL(path, root), 'utf8'));
const vectors = readJson('test/fixtures/protocol-v2-vectors.json');
const cases = readJson('test/fixtures/proof-security-cases.json');
const decode = (result: Awaited<ReturnType<typeof executeProofVerify>>) => JSON.parse(result.content[0].text!);

for (const row of cases) {
  test(`proof security: ${row.name}`, async () => {
    const response = await executeProofVerify(row.args);
    const result = decode(response);
    assert.equal(result.valid, row.valid);
    assert.equal(result.trusted, row.trusted);
    assert.equal(result.verified, row.trusted);
    assert.equal(Boolean(response.isError), !row.valid);
    if (row.canonicalParity) {
      const canonical = await verifyReceipt(row.args.receipt, row.args.publicKeyOrSecret === undefined ? {} : { publicKeyOrSecret: row.args.publicKeyOrSecret, expectedAlgorithm: row.args.expectedAlgorithm });
      for (const [key, value] of Object.entries(canonical)) {
        assert.deepEqual(key === 'warnings' ? result.warnings.slice(0, canonical.warnings.length) : result[key], value, key);
      }
    }
  });
}

test('upstream canonical vectors and independent RFC8032 Ed25519 vector', () => {
  for (const name of ['sample', 'numeric']) assert.equal(canonicalize(vectors.canonical[name]), vectors.canonical[name + 'Canonical']);
  const v = vectors.ed25519;
  assert.equal(ProofSigner.signPayload(v.message, v.secretKey, 'Ed25519'), v.signature);
  assert.equal(ProofSigner.verifySignature(v.message, v.signature, v.publicKey, 'Ed25519'), true);
  assert.equal(new MerkleTree(vectors.merkle.items).getRoot(), vectors.merkle.threeLeafRoot);
  assert.notEqual(new MerkleTree(['a', 'b', 'c']).getRoot(), new MerkleTree(['a', 'b', 'c', 'c']).getRoot());
});

for (const algorithm of ['HMAC-SHA256', 'Ed25519'] as const) {
  test(`generated ${algorithm} receipt authenticates and seals metadata/identity`, async () => {
    const privateKey = algorithm === 'Ed25519' ? vectors.ed25519.secretKey : vectors.protocolV2.secret;
    const publicKey = algorithm === 'Ed25519' ? vectors.ed25519.publicKey : privateKey;
    const receipt = decode(await executeProofLedger({ action: 'test', agentId: 'test-agent', payload: vectors.canonical.numeric, signingKey: privateKey, algorithm }));
    assert.equal(receipt.protocol, 'nymrel-proof-ledger');
    assert.equal(receipt.version, '2.0.0');
    assert.equal(JSON.stringify(receipt).includes(privateKey), false);
    assert.equal(decode(await executeProofVerify({ receipt, publicKeyOrSecret: publicKey, expectedAlgorithm: algorithm })).trusted, true);
    const tampered = structuredClone(receipt);
    tampered.metadata.payload = { forged: true };
    assert.equal(decode(await executeProofVerify({ receipt: tampered, publicKeyOrSecret: publicKey, expectedAlgorithm: algorithm })).valid, false);
  });
}

test('creation fails closed without supplied key or with invalid options', async () => {
  const base = { action: 'test', agentId: 'test-agent', payload: {}, signingKey: 'synthetic-test-secret', algorithm: 'HMAC-SHA256' };
  for (const args of [null, [], {}, { ...base, signingKey: null }, { ...base, signingKey: '' },
    { ...base, algorithm: 'fake' }, { ...base, algorithm: 'Ed25519' }, { ...base, keyId: '' },
    { ...base, prevProofHash: 'abc' }, { ...base, cwd: '/' }, { ...base, payload: [] }]) {
    const result = await executeProofLedger(args);
    assert.equal(result.isError, true);
    assert.equal(JSON.stringify(result).includes(base.signingKey), false);
  }
});

test('vendored core and fixtures match reviewed upstream source digests', () => {
  const manifest = readJson('docs/proof-ledger/SOURCE.json');
  assert.equal(manifest.revision, 'c0cd721c7435421e9203af0852da7596397b762d');
  for (const entry of manifest.files) {
    const source = readFileSync(new URL(entry.destination, root), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(source).digest('hex'), entry.sha256, entry.destination);
  }
});

test('schemas require signing material and expose only explicit verification key', () => {
  assert(proofLedgerToolDefinition.inputSchema.required?.includes('signingKey'));
  assert('publicKeyOrSecret' in proofVerifyToolDefinition.inputSchema.properties);
  assert.equal(proofVerifyToolDefinition.inputSchema.additionalProperties, false);
});

test('creation rejects the same Unicode-only blank text in both runtimes', async () => {
  const base = { action: 'test', agentId: 'fixture', signingKey: 'synthetic-secret', algorithm: 'HMAC-SHA256', payload: {} };
  for (const value of ['\u001f', '\u0085', '\ufeff']) {
    for (const field of ['action', 'agentId', 'signingKey', 'keyId']) {
      assert.equal((await executeProofLedger({ ...base, [field]: value })).isError, true);
    }
  }
  assert.equal((await executeProofLedger({ ...base, action: '\u0085test\ufeff' })).isError, undefined);
});

test('Ed25519 public material cannot authenticate an attacker HMAC receipt', async () => {
  for (const publicKey of [vectors.ed25519.publicKey, '-----BEGIN PUBLIC KEY-----\npublic-test-material\n-----END PUBLIC KEY-----']) {
    const receipt = decode(await executeProofLedger({ action: 'forged', agentId: 'victim', payload: {}, signingKey: publicKey, algorithm: 'HMAC-SHA256' }));
    assert.equal(decode(await executeProofVerify({ receipt, publicKeyOrSecret: publicKey, expectedAlgorithm: 'Ed25519' })).trusted, false);
    assert.equal(decode(await executeProofVerify({ receipt, publicKeyOrSecret: publicKey })).valid, false);
  }
});

test('receipt creation never invokes Git or any subprocess', async () => {
  const original = childProcess.execSync;
  let calls = 0;
  childProcess.execSync = (() => { calls++; throw new Error('Must not execute'); }) as typeof original;
  syncBuiltinESMExports();
  try {
    const response = await executeProofLedger({ action: 'test', agentId: 'test', payload: {}, signingKey: 'synthetic-test-secret', algorithm: 'HMAC-SHA256' });
    assert.equal(Boolean(response.isError), false);
    assert.equal(decode(response).environment.git, undefined);
    assert.equal(calls, 0);
  } finally {
    childProcess.execSync = original;
    syncBuiltinESMExports();
  }
});

test('nonportable JSON and excessive nesting fail before signing or trust', async () => {
  const base = { action: 'test', agentId: 'test', payload: {}, signingKey: 'synthetic-test-secret', algorithm: 'HMAC-SHA256' };
  let deep: unknown = null;
  for (let i = 0; i < 70; i++) deep = { child: deep };
  for (const extra of [deep, NaN, Infinity, 1e20, '\ud800']) {
    assert.equal((await executeProofLedger({ ...base, payload: { extra } })).isError, true);
    assert.equal(decode(await executeProofVerify({ receipt: { ...vectors.protocolV2.receipt, extra } })).valid, false);
  }
  for (const field of ['signingKey', 'action', 'agentId']) {
    assert.equal((await executeProofLedger({ ...base, [field]: '\ud800' })).isError, true);
  }
  assert.equal((await executeProofLedger({ ...base, algorithm: undefined })).isError, true);
});

test('creation reserves verification headroom at depth, value-count and byte limits', async () => {
  const base = { action: 'test', agentId: 'test', signingKey: 'synthetic-test-secret', algorithm: 'HMAC-SHA256' };
  let nearDepth: any = null;
  for (let i = 0; i < 62; i++) nearDepth = { child: nearDepth };
  for (const payload of [nearDepth, { items: Array(9970).fill(null) }, { text: 'x'.repeat(1048200) }]) {
    assert.equal((await executeProofLedger({ ...base, payload })).isError, true);
  }
  const receipt = decode(await executeProofLedger({ ...base, payload: { items: Array(9800).fill(null) } }));
  assert.equal(decode(await executeProofVerify({ receipt, publicKeyOrSecret: base.signingKey, expectedAlgorithm: base.algorithm })).trusted, true);
});

test('unsigned extension warning accompanies authenticated core', async () => {
  const receipt = { ...vectors.protocolV2.receipt, approval: 'attacker-added' };
  const result = decode(await executeProofVerify({ receipt, publicKeyOrSecret: vectors.protocolV2.secret, expectedAlgorithm: 'HMAC-SHA256' }));
  assert.equal(result.trusted, true);
  assert(result.warnings.some((warning: string) => warning.includes('extension fields are not authenticated')));
});
