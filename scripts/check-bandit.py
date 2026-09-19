"""Run the full scanner; recognize only exact reviewed vendor Git-context findings."""
from collections import Counter
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]


def finding_key(item):
    return (
        item['filename'].replace('\\', '/').removeprefix('./'),
        item['test_id'], item['line_number'], item['code'],
        item['issue_severity'], item['issue_confidence'], item['issue_text'],
    )


def unexpected_findings(actual, reviewed):
    """Count occurrences so duplicate/new findings cannot hide behind one approval."""
    allowed = Counter(finding_key(item) for item in reviewed)
    unexpected = []
    for item in actual:
        key = finding_key(item)
        if allowed[key]:
            allowed[key] -= 1
        else:
            unexpected.append(item)
    return unexpected


def main():
    process = subprocess.run(
        [sys.executable, '-m', 'bandit', '-q', '-r', 'python/nymrel_mcp_hub', '-f', 'json'],
        capture_output=True, text=True, encoding='utf-8', cwd=ROOT, check=False,
    )
    if process.returncode not in (0, 1):
        print(process.stderr, file=sys.stderr)
        return 1
    report = json.loads(process.stdout)
    reviewed = json.loads((ROOT / 'docs/proof-ledger/bandit-reviewed.json').read_text())
    unexpected = unexpected_findings(report['results'], reviewed['findings'])
    if report['errors'] or unexpected:
        print(json.dumps({'errors': report['errors'], 'unexpected': unexpected}, indent=2))
        return 1
    print(f"Bandit scanned all runtime sources: {len(report['results'])} exact reviewed vendor findings; no new findings.")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
