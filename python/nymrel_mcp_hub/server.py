"""
Nymrel MCP Hub - Python JSON-RPC 2.0 MCPServer
"""

import sys
import json
from typing import Dict, Any, Optional
from .tools import ALL_TOOLS, dispatch_tool_call
from .resources import ALL_RESOURCES, read_resource
from .prompts import ALL_PROMPTS, render_prompt

class MCPServer:
    def __init__(self):
        self.server_name = "@nymrel/mcp-hub"
        self.server_version = "1.0.0"
        self.protocol_version = "2024-11-05"

    def handle_request(self, req: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        req_id = req.get("id")
        method = req.get("method")

        if not method or req.get("jsonrpc") != "2.0":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32600, "message": "Invalid Request"}
            }

        try:
            if method == "initialize":
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "result": {
                        "protocolVersion": self.protocol_version,
                        "capabilities": {
                            "tools": {"listChanged": False},
                            "resources": {"listChanged": False},
                            "prompts": {"listChanged": False}
                        },
                        "serverInfo": {
                            "name": self.server_name,
                            "version": self.server_version
                        }
                    }
                }

            if method == "notifications/initialized":
                return None

            if method == "ping":
                return {"jsonrpc": "2.0", "id": req_id, "result": {}}

            if method == "tools/list":
                return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": ALL_TOOLS}}

            if method == "tools/call":
                params = req.get("params", {})
                name = params.get("name")
                args = params.get("arguments", {})
                if not name:
                    return {
                        "jsonrpc": "2.0",
                        "id": req_id,
                        "error": {"code": -32602, "message": "Missing tool name"}
                    }
                tool_res = dispatch_tool_call(name, args)
                return {"jsonrpc": "2.0", "id": req_id, "result": tool_res}

            if method == "resources/list":
                return {"jsonrpc": "2.0", "id": req_id, "result": {"resources": ALL_RESOURCES}}

            if method == "resources/read":
                params = req.get("params", {})
                uri = params.get("uri")
                content = read_resource(uri)
                return {"jsonrpc": "2.0", "id": req_id, "result": {"contents": [content]}}

            if method == "prompts/list":
                return {"jsonrpc": "2.0", "id": req_id, "result": {"prompts": ALL_PROMPTS}}

            if method == "prompts/get":
                params = req.get("params", {})
                name = params.get("name")
                args = params.get("arguments", {})
                res = render_prompt(name, args)
                return {"jsonrpc": "2.0", "id": req_id, "result": res}

            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32601, "message": f"Method not found: {method}"}
            }

        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32000, "message": str(e)}
            }

    def start_stdio(self):
        sys.stderr.write("[nymrel-mcp-hub py] MCP Server listening on stdio\n")
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
                res = self.handle_request(req)
                if res is not None:
                    sys.stdout.write(json.dumps(res) + "\n")
                    sys.stdout.flush()
            except Exception as err:
                err_res = {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": f"Parse error: {err}"}
                }
                sys.stdout.write(json.dumps(err_res) + "\n")
                sys.stdout.flush()
