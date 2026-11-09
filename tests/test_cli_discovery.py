"""Finite discovery commands for people configuring an MCP client."""
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.parametrize(("flag", "expected"), [
    ("--list-tools", "15 Registered Nymrel Tools"),
    ("--list-resources", "nymrel://ecosystem"),
    ("--list-prompts", "secure-agent-command"),
])
def test_discovery_exits_without_stdin(flag, expected):
    result = subprocess.run(
        [sys.executable, "-m", "nymrel_mcp_hub.cli", flag],
        cwd=Path(__file__).resolve().parents[1],
        capture_output=True, text=True, timeout=3, check=False,
    )
    assert result.returncode == 0, result.stderr
    assert expected in result.stdout
    assert result.stderr == ""
