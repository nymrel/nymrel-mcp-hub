"""
Pytest automated tests for Python MCP server and tool execution
"""

import json
import os
import subprocess
import sys
from pathlib import Path

from nymrel_mcp_hub.server import MCPServer

REPO_ROOT = Path(__file__).resolve().parents[1]
MODERN_VERSION = "2026-07-28"
PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion"
CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo"
CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities"
SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo"


def modern_params(**extra):
    return {
        **extra,
        "_meta": {
            PROTOCOL_VERSION_META_KEY: MODERN_VERSION,
            CLIENT_INFO_META_KEY: {"name": "nymrel-test-client", "version": "1.0.0"},
            CLIENT_CAPABILITIES_META_KEY: {},
        },
    }

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

    latest_legacy = server.handle_request({
        "jsonrpc": "2.0",
        "id": "legacy-latest",
        "method": "initialize",
        "params": {"protocolVersion": "2025-11-25"},
    })
    assert latest_legacy["result"]["protocolVersion"] == "2025-11-25"
    assert "resultType" not in latest_legacy["result"]

    earliest_legacy = server.handle_request({
        "jsonrpc": "2.0",
        "id": "legacy-earliest",
        "method": "initialize",
        "params": {"protocolVersion": "2024-10-07"},
    })
    assert earliest_legacy["result"]["protocolVersion"] == "2024-10-07"

    modern_counter_offer = server.handle_request({
        "jsonrpc": "2.0",
        "id": "legacy-counter-offer",
        "method": "initialize",
        "params": {"protocolVersion": MODERN_VERSION},
    })
    assert modern_counter_offer["result"]["protocolVersion"] == "2025-11-25"


def test_python_server_discover_advertises_modern_stateless_era():
    server = MCPServer()
    res = server.handle_request({
        "jsonrpc": "2.0",
        "id": "discover-1",
        "method": "server/discover",
        "params": modern_params(),
    })
    assert res["result"]["supportedVersions"] == [MODERN_VERSION]
    assert res["result"]["capabilities"] == {"tools": {}, "resources": {}, "prompts": {}}
    assert res["result"]["resultType"] == "complete"
    assert res["result"]["ttlMs"] == 3_600_000
    assert res["result"]["cacheScope"] == "public"
    assert res["result"]["_meta"][SERVER_INFO_META_KEY]["name"] == "@nymrel/mcp-hub"


def test_python_modern_inline_requests_are_validated_and_result_enveloped():
    server = MCPServer()
    list_res = server.handle_request({
        "jsonrpc": "2.0",
        "id": "modern-tools",
        "method": "tools/list",
        "params": modern_params(),
    })
    assert len(list_res["result"]["tools"]) == 14
    assert list_res["result"]["resultType"] == "complete"
    assert list_res["result"]["ttlMs"] == 300_000
    assert list_res["result"]["cacheScope"] == "public"

    call_res = server.handle_request({
        "jsonrpc": "2.0",
        "id": "modern-call",
        "method": "tools/call",
        "params": modern_params(
            name="nymrel_surety_guard",
            arguments={"command": "echo safe"},
        ),
    })
    assert call_res["result"]["resultType"] == "complete"
    assert "ttlMs" not in call_res["result"]
    assert call_res["result"]["content"][0]["type"] == "text"


def test_python_modern_metadata_failures_are_fail_closed():
    server = MCPServer()
    unsupported = server.handle_request({
        "jsonrpc": "2.0",
        "id": "unsupported-version",
        "method": "tools/list",
        "params": {
            "_meta": {
                PROTOCOL_VERSION_META_KEY: "2027-01-01",
                CLIENT_CAPABILITIES_META_KEY: {},
            }
        },
    })
    assert unsupported["error"]["code"] == -32022
    assert unsupported["error"]["data"] == {
        "supported": [MODERN_VERSION],
        "requested": "2027-01-01",
    }

    missing_capabilities = server.handle_request({
        "jsonrpc": "2.0",
        "id": "missing-capabilities",
        "method": "server/discover",
        "params": {"_meta": {PROTOCOL_VERSION_META_KEY: MODERN_VERSION}},
    })
    assert missing_capabilities["error"]["code"] == -32602

    malformed_client_info = server.handle_request({
        "jsonrpc": "2.0",
        "id": "malformed-client-info",
        "method": "server/discover",
        "params": {
            "_meta": {
                PROTOCOL_VERSION_META_KEY: MODERN_VERSION,
                CLIENT_CAPABILITIES_META_KEY: {},
                CLIENT_INFO_META_KEY: {"name": "missing-version"},
            }
        },
    })
    assert malformed_client_info["error"]["code"] == -32602


def test_python_ping_is_legacy_only_in_modern_era():
    server = MCPServer()
    res = server.handle_request({
        "jsonrpc": "2.0",
        "id": "modern-ping",
        "method": "ping",
        "params": modern_params(),
    })
    assert res["error"]["code"] == -32601

def test_python_mcp_tools_list():
    server = MCPServer()
    res = server.handle_request({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/list"
    })
    assert len(res["result"]["tools"]) == 14
    assert "resultType" not in res["result"]

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

    read_res = server.handle_request({
        "jsonrpc": "2.0",
        "id": "status-resource",
        "method": "resources/read",
        "params": {"uri": "nymrel://status"},
    })
    status_data = json.loads(read_res["result"]["contents"][0]["text"])
    assert status_data["server"] == "@nymrel/mcp-hub"
    assert status_data["protocolVersions"] == {
        "modern": MODERN_VERSION,
        "legacy": [
            "2025-11-25",
            "2025-06-18",
            "2025-03-26",
            "2024-11-05",
            "2024-10-07",
        ],
    }

    prompt_list = server.handle_request({"jsonrpc": "2.0", "id": 5, "method": "prompts/list"})
    assert len(prompt_list["result"]["prompts"]) == 3

def test_notification_unknown_method_is_silent():
    server = MCPServer()
    res = server.handle_request({"jsonrpc": "2.0", "method": "unknown/notification"})
    assert res is None

    modern_res = server.handle_request({
        "jsonrpc": "2.0",
        "method": "unknown/notification",
        "params": modern_params(),
    })
    assert modern_res is None

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

def test_stdio_notifications_are_silent_and_dual_era_shapes_are_preserved():
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
            + json.dumps({
                "jsonrpc": "2.0",
                "method": "unknown/modern-notification",
                "params": modern_params(),
            }) + "\n"
            + json.dumps({
                "jsonrpc": "2.0",
                "id": 41,
                "method": "tools/list",
                "params": modern_params(),
            }) + "\n"
            + json.dumps({"jsonrpc": "2.0", "id": 42, "method": "ping"}) + "\n",
            timeout=30,
        )
    finally:
        if proc.poll() is None:
            proc.kill()

    lines = [line for line in out.splitlines() if line.strip()]
    assert len(lines) == 2, f"expected exactly two stdout lines, got: {lines!r}"
    parsed = [json.loads(line) for line in lines]
    modern = next(message for message in parsed if message["id"] == 41)
    legacy = next(message for message in parsed if message["id"] == 42)
    assert modern["jsonrpc"] == "2.0"
    assert modern["result"]["resultType"] == "complete"
    assert modern["result"]["_meta"][SERVER_INFO_META_KEY]["name"] == "@nymrel/mcp-hub"
    assert legacy["jsonrpc"] == "2.0"
    assert legacy["result"] == {}
