"""Regression corpus shared with the TypeScript adapter."""
import hashlib
import json
from pathlib import Path

import pytest

from nymrel_mcp_hub.tools import dispatch_tool_call
from nymrel_mcp_hub._proof_ledger.canonical import canonicalize
from nymrel_mcp_hub._proof_ledger.receipt import verify_receipt
from nymrel_mcp_hub._proof_ledger.signer import ProofSigner
from nymrel_mcp_hub._proof_ledger.merkle import MerkleTree

ROOT = Path(__file__).resolve().parents[1]
VECTORS = json.loads((ROOT / 'test/fixtures/protocol-v2-vectors.json').read_text(encoding='utf-8'))
CASES = json.loads((ROOT / 'test/fixtures/proof-security-cases.json').read_text(encoding='utf-8'))


def call(name, args):
    response = dispatch_tool_call('nymrel_' + name, args)
    return response, json.loads(response['content'][0]['text'])


@pytest.mark.parametrize('row', CASES, ids=lambda row: row['name'])
def test_security_cases(row):
    response, result = call('proof_verify', row['args'])
    assert result['valid'] is row['valid']
    assert result['trusted'] is row['trusted']
    assert result['verified'] is row['trusted']
    assert bool(response.get('isError')) is not row['valid']
    if row.get('canonicalParity'):
        expected = verify_receipt(row['args']['receipt'], public_key_or_secret=row['args'].get('publicKeyOrSecret'), expected_algorithm=row['args'].get('expectedAlgorithm'))
        actual = {key: result[key] for key in expected}
        actual['warnings'] = actual['warnings'][:len(expected['warnings'])]
        assert actual == expected


def test_independent_vectors():
    for name in ('sample', 'numeric'):
        assert canonicalize(VECTORS['canonical'][name]) == VECTORS['canonical'][name + 'Canonical']
    v = VECTORS['ed25519']
    assert ProofSigner.sign_payload(v['message'], v['secretKey'], 'Ed25519') == v['signature']
    assert ProofSigner.verify_signature(v['message'], v['signature'], v['publicKey'], 'Ed25519')
    assert MerkleTree(VECTORS['merkle']['items']).get_root() == VECTORS['merkle']['threeLeafRoot']
    assert MerkleTree(['a', 'b', 'c']).get_root() != MerkleTree(['a', 'b', 'c', 'c']).get_root()


@pytest.mark.parametrize('algorithm', ['HMAC-SHA256', 'Ed25519'])
def test_generated_receipts(algorithm):
    private = VECTORS['ed25519']['secretKey'] if algorithm == 'Ed25519' else VECTORS['protocolV2']['secret']
    public = VECTORS['ed25519']['publicKey'] if algorithm == 'Ed25519' else private
    response, receipt = call('proof_ledger', {'action': 'test', 'agentId': 'test-agent', 'payload': VECTORS['canonical']['numeric'], 'signingKey': private, 'algorithm': algorithm})
    assert not response.get('isError')
    assert private not in json.dumps(receipt)
    assert call('proof_verify', {'receipt': receipt, 'publicKeyOrSecret': public, 'expectedAlgorithm': algorithm})[1]['trusted']
    receipt['metadata']['payload'] = {'forged': True}
    assert not call('proof_verify', {'receipt': receipt, 'publicKeyOrSecret': public, 'expectedAlgorithm': algorithm})[1]['valid']


def test_creation_rejects_invalid_inputs_without_echoing_key():
    base = {'action': 'test', 'agentId': 'test-agent', 'payload': {}, 'signingKey': 'synthetic-test-secret', 'algorithm': 'HMAC-SHA256'}
    for args in [None, [], {}, *({**base, **change} for change in [
        {'signingKey': None}, {'signingKey': ''}, {'algorithm': 'fake'}, {'algorithm': 'Ed25519'},
        {'keyId': ''}, {'prevProofHash': 'abc'}, {'cwd': '/'}, {'payload': []},
    ])]:
        response, _ = call('proof_ledger', args)
        assert response['isError']
        assert base['signingKey'] not in json.dumps(response)


def test_upstream_source_digests():
    manifest = json.loads((ROOT / 'docs/proof-ledger/SOURCE.json').read_text())
    assert manifest['revision'] == '09a49a0e66d9443bff979f4d77cf7c0310ef0d8f'
    for entry in manifest['files']:
        content = (ROOT / entry['destination']).read_bytes().replace(b'\r\n', b'\n')
        assert hashlib.sha256(content).hexdigest() == entry['sha256'], entry['destination']


def test_shared_unicode_blank_creation_fields():
    base = dict(action='test', agentId='fixture', signingKey='synthetic-secret', algorithm='HMAC-SHA256', payload={})
    for value in ('\u001f', '\u0085', '\ufeff'):
        for field in ('action', 'agentId', 'signingKey', 'keyId'):
            assert call('proof_ledger', {**base, field: value})[0]['isError']
    assert not call('proof_ledger', {**base, 'action': '\u0085test\ufeff'})[0].get('isError')


def test_ed25519_algorithm_confusion_is_rejected():
    for public in [VECTORS['ed25519']['publicKey'], '-----BEGIN PUBLIC KEY-----\npublic-test-material\n-----END PUBLIC KEY-----']:
        _, receipt = call('proof_ledger', {'action': 'forged', 'agentId': 'victim', 'payload': {}, 'signingKey': public, 'algorithm': 'HMAC-SHA256'})
        assert not call('proof_verify', {'receipt': receipt, 'publicKeyOrSecret': public, 'expectedAlgorithm': 'Ed25519'})[1]['trusted']
        assert not call('proof_verify', {'receipt': receipt, 'publicKeyOrSecret': public})[1]['valid']


def test_creation_never_invokes_git(monkeypatch):
    import subprocess
    calls = []

    def forbidden(*args, **kwargs):
        calls.append(args)
        raise AssertionError('Must not execute')

    monkeypatch.setattr(subprocess, 'check_output', forbidden)
    response, receipt = call('proof_ledger', {'action': 'test', 'agentId': 'test', 'payload': {}, 'signingKey': 'synthetic-test-secret', 'algorithm': 'HMAC-SHA256'})
    assert not response.get('isError')
    assert 'git' not in receipt['environment']
    assert not calls


def test_nonportable_json_and_excessive_nesting_fail():
    base = {'action': 'test', 'agentId': 'test', 'payload': {}, 'signingKey': 'synthetic-test-secret', 'algorithm': 'HMAC-SHA256'}
    deep = None
    for _ in range(70):
        deep = {'child': deep}
    for extra in [deep, float('nan'), float('inf'), 1e20, '\ud800']:
        assert call('proof_ledger', {**base, 'payload': {'extra': extra}})[0]['isError']
        assert not call('proof_verify', {'receipt': {**VECTORS['protocolV2']['receipt'], 'extra': extra}})[1]['valid']
    for field in ('signingKey', 'action', 'agentId'):
        assert call('proof_ledger', {**base, field: '\ud800'})[0]['isError']
    assert call('proof_ledger', {key: value for key, value in base.items() if key != 'algorithm'})[0]['isError']


def test_creation_reserves_verification_headroom():
    base = {'action': 'test', 'agentId': 'test', 'signingKey': 'synthetic-test-secret', 'algorithm': 'HMAC-SHA256'}
    near_depth = None
    for _ in range(62):
        near_depth = {'child': near_depth}
    for payload in [near_depth, {'items': [None] * 9970}, {'text': 'x' * 1048200}]:
        assert call('proof_ledger', {**base, 'payload': payload})[0]['isError']
    _, receipt = call('proof_ledger', {**base, 'payload': {'items': [None] * 9800}})
    assert call('proof_verify', {'receipt': receipt, 'publicKeyOrSecret': base['signingKey'], 'expectedAlgorithm': base['algorithm']})[1]['trusted']


def test_unsigned_extension_warning():
    receipt = {**VECTORS['protocolV2']['receipt'], 'approval': 'attacker-added'}
    _, result = call('proof_verify', {'receipt': receipt, 'publicKeyOrSecret': VECTORS['protocolV2']['secret'], 'expectedAlgorithm': 'HMAC-SHA256'})
    assert result['trusted']
    assert any('extension fields are not authenticated' in warning for warning in result['warnings'])


def test_unknown_tool_cannot_echo_signing_material_as_success():
    response = dispatch_tool_call('nymrel_proof_verifiy', {'signingKey': 'do-not-echo-test-key'})
    assert response['isError']
    assert 'do-not-echo-test-key' not in json.dumps(response)
