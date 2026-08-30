"""
Pytest automated tests for Python MCP server and tool execution
"""

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from nymrel_mcp_hub.server import MCPServer
from nymrel_mcp_hub.tools import ALL_TOOLS, dispatch_tool_call

REPO_ROOT = Path(__file__).resolve().parents[1]

def test_python_mcp_initialize():
    server = MCPServer()
    res = server.handle_request({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {"protocolVersion": "2024-11-05"}
    })
    assert res["id"] == 1
    assert res["result"]["protocolVersion"] == "2024-11-05"
    assert res["result"]["serverInfo"]["name"] == "@nymrel/mcp-hub"

def test_python_mcp_tools_list():
    server = MCPServer()
    res = server.handle_request({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list"
    })
    assert len(res["result"]["tools"]) == 14

def test_python_mcp_tool_execution():
    server = MCPServer()
    res = server.handle_request({
        "jsonrpc": "2.0",
        "id": 3,
        "method": "tools/call",
        "params": {
            "name": "nymrel_surety_guard",
            "arguments": {"command": "echo safe"}
        }
    })
    assert res["id"] == 3
    assert res["result"]["content"][0]["type"] == "text"

def test_python_mcp_resources_and_prompts():
    server = MCPServer()
    res_list = server.handle_request({"jsonrpc": "2.0", "id": 4, "method": "resources/list"})
    assert len(res_list["result"]["resources"]) == 3

    prompt_list = server.handle_request({"jsonrpc": "2.0", "id": 5, "method": "prompts/list"})
    assert len(prompt_list["result"]["prompts"]) == 3

def test_notification_unknown_method_is_silent():
    server = MCPServer()
    res = server.handle_request({"jsonrpc": "2.0", "method": "unknown/notification"})
    assert res is None

def test_notifications_initialized_remains_silent():
    server = MCPServer()
    res = server.handle_request({"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert res is None

def test_explicit_id_null_is_a_request_not_a_notification():
    server = MCPServer()
    res = server.handle_request({"jsonrpc": "2.0", "id": None, "method": "ping"})
    assert res is not None
    assert res["id"] is None
    assert res["result"] == {}

    res_unknown = server.handle_request({"jsonrpc": "2.0", "id": None, "method": "unknown/method"})
    assert res_unknown is not None
    assert res_unknown["id"] is None
    assert res_unknown["error"]["code"] == -32601

def test_invalid_request_still_responds_32600():
    server = MCPServer()
    res = server.handle_request({"jsonrpc": "1.0", "method": "ping"})
    assert res is not None
    assert res["id"] is None
    assert res["error"]["code"] == -32600

def test_stdio_notification_does_not_corrupt_following_request():
    env = {**os.environ, "PYTHONPATH": str(REPO_ROOT / "python")}
    proc = subprocess.Popen(
        [sys.executable, "-m", "nymrel_mcp_hub.cli"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        env=env,
        text=True,
    )
    try:
        out, _ = proc.communicate(
            json.dumps({"jsonrpc": "2.0", "method": "unknown/notification"}) + "\n"
            + json.dumps({"jsonrpc": "2.0", "id": 42, "method": "ping"}) + "\n",
            timeout=30,
        )
    finally:
        if proc.poll() is None:
            proc.kill()

    lines = [line for line in out.splitlines() if line.strip()]
    assert len(lines) == 1, f"expected exactly one stdout line, got: {lines!r}"
    parsed = json.loads(lines[0])
    assert parsed["jsonrpc"] == "2.0"
    assert parsed["id"] == 42
    assert parsed["result"] == {}
