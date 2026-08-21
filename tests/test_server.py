"""
Pytest automated tests for Python MCP server and tool execution
"""

import pytest
from nymrel_mcp_hub.server import MCPServer
from nymrel_mcp_hub.tools import ALL_TOOLS, dispatch_tool_call

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
