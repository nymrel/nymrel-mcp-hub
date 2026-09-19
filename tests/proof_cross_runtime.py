"""Run after npm build with the installed Python package: python tests/proof_cross_runtime.py."""
import json
from pathlib import Path
import subprocess

from nymrel_mcp_hub.tools import ALL_TOOLS, dispatch_tool_call

ROOT = Path(__file__).resolve().parents[1]
vectors = json.loads((ROOT / 'test/fixtures/protocol-v2-vectors.json').read_text(encoding='utf-8'))
cases = json.loads((ROOT / 'test/fixtures/proof-security-cases.json').read_text(encoding='utf-8'))


def node(requests):
    process = subprocess.run(['node', str(ROOT / 'test/proof-interop.mjs')], input=json.dumps(requests),
                             text=True, encoding='utf-8', capture_output=True, check=True, cwd=ROOT)
    return json.loads(process.stdout)


def decode(response):
    return json.loads(response['content'][0]['text'])


responses = node([{'operation': 'verify', 'args': row['args']} for row in cases])
for row, ts in zip(cases, responses, strict=True):
    py = dispatch_tool_call('nymrel_proof_verify', row['args'])
    assert decode(py) == decode(ts), row['name']
    assert bool(py.get('isError')) == bool(ts.get('isError')), row['name']

ts_definitions = node([{'operation': 'schemas'}])[0]
py_definitions = [next(tool for tool in ALL_TOOLS if tool['name'] == definition['name']) for definition in ts_definitions]
assert ts_definitions == py_definitions, 'Tool definitions diverged between runtimes'

for algorithm in ('HMAC-SHA256', 'Ed25519'):
    private = vectors['ed25519']['secretKey'] if algorithm == 'Ed25519' else vectors['protocolV2']['secret']
    public = vectors['ed25519']['publicKey'] if algorithm == 'Ed25519' else private
    args = {'action': 'cross-runtime', 'agentId': 'test-agent', 'payload': vectors['canonical']['numeric'],
            'algorithm': algorithm, 'signingKey': private}
    py_receipt = decode(dispatch_tool_call('nymrel_proof_ledger', args))
    ts_receipt = decode(node([{'operation': 'create', 'args': args}])[0])
    assert decode(node([{'operation': 'verify', 'args': {'receipt': py_receipt, 'publicKeyOrSecret': public, 'expectedAlgorithm': algorithm}}])[0])['trusted']
    assert decode(dispatch_tool_call('nymrel_proof_verify', {'receipt': ts_receipt, 'publicKeyOrSecret': public, 'expectedAlgorithm': algorithm}))['trusted']
    for malformed_key in ('bad-key', '0' * 64):
        request = {'receipt': ts_receipt, 'publicKeyOrSecret': malformed_key, 'expectedAlgorithm': algorithm}
        assert not decode(dispatch_tool_call('nymrel_proof_verify', request))['valid']
        assert not decode(node([{'operation': 'verify', 'args': request}])[0])['valid']

print(f'{len(cases)} exact cross-runtime verification cases, schema parity, and bidirectional HMAC/Ed25519 generation passed.')
