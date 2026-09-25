"""A new subprocess finding must not be masked by the reviewed vendor exceptions."""
import copy
import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('bandit_gate', ROOT / 'scripts/check-bandit.py')
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
proof_reviewed = json.loads(
    (ROOT / 'docs/proof-ledger/bandit-reviewed.json').read_text()
)['findings']
crawler_reviewed = json.loads(
    (ROOT / 'docs/crawler-mesh/bandit-reviewed.json').read_text()
)['findings']
reviewed = gate.load_reviewed_findings()


def test_exact_reviewed_findings_only():
    assert len(proof_reviewed) == 9
    assert len(crawler_reviewed) == 6
    assert len(reviewed) == 15
    assert gate.unexpected_findings(reviewed, reviewed) == []
    for field, value in [('filename', 'python/nymrel_mcp_hub/proof_tools.py'),
                         ('line_number', 999), ('code', 'unreviewed subprocess'),
                         ('test_id', 'B602'), ('issue_severity', 'HIGH')]:
        changed = copy.deepcopy(reviewed[0])
        changed[field] = value
        assert gate.unexpected_findings([changed], reviewed) == [changed]
    assert len(gate.unexpected_findings(reviewed + reviewed, reviewed)) == 15


def test_windows_paths_match_linux_paths():
    windows = copy.deepcopy(reviewed)
    for item in windows:
        item['filename'] = item['filename'].replace('/', '\\')
    assert gate.unexpected_findings(windows, reviewed) == []
