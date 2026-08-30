"""
Nymrel MCP Hub - Python JSON-RPC 2.0 MCPServer
"""

import sys
import json
from typing import Dict, Any, Optional
from .tools import ALL_TOOLS, dispatch_tool_call
from .resources import ALL_RESOURCES, read_resource
from .prompts import ALL_PROMPTS, render_prompt
from .protocol import (
    MODERN_PROTOCOL_VERSION,
    SERVER_INFO,
    SERVER_INSTRUCTIONS,
    classify_protocol_request,
    legacy_capabilities,
    modern_capabilities,
    negotiate_legacy_protocol_version,
    stamp_modern_success,
)

class MCPServer:
    def handle_request(self, req: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        # JSON-RPC 2.0 section 4.1: a Notification is a valid Request object
        # WITHOUT an "id" member and MUST NOT be answered. An explicit
        # "id": null is a Request, not a Notification, and stays response-bearing.
        is_dict = isinstance(req, dict)
        has_id_member = is_dict and "id" in req
        is_notification = is_dict and not has_id_member
        req_id = req.get("id") if has_id_member else None

        if (
            not is_dict
            or req.get("jsonrpc") != "2.0"
            or not isinstance(req.get("method"), str)
            or not req["method"]
        ):
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32600, "message": "Invalid Request"}
            }

        era, protocol_error = classify_protocol_request(req, req_id)
        if protocol_error is not None:
            return None if is_notification else protocol_error

        try:
            response = self._execute_method(req, req_id, era)
            if era == "modern":
                response = stamp_modern_success(response, req["method"])
        except Exception as e:
            # Even on handler failure a notification must stay unanswered.
            if is_notification:
                return None
            response = {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32603 if era == "modern" else -32000, "message": str(e)}
            }
        return None if is_notification else response

    def _execute_method(self, req: Dict[str, Any], req_id: Any, era: str) -> Dict[str, Any]:
        method = req["method"]

        if era == "modern" and method in {"initialize", "notifications/initialized", "ping"}:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": -32601,
                    "message": f"Method not supported by MCP {MODERN_PROTOCOL_VERSION}: {method}",
                },
            }

        if method == "server/discover":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "supportedVersions": [MODERN_PROTOCOL_VERSION],
                    "capabilities": modern_capabilities(),
                    "instructions": SERVER_INSTRUCTIONS,
                },
            }

        if method == "initialize":
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "result": {
                    "protocolVersion": negotiate_legacy_protocol_version(req.get("params")),
                    "capabilities": legacy_capabilities(),
                    "serverInfo": dict(SERVER_INFO),
                }
            }

        if method == "ping":
            return {"jsonrpc": "2.0", "id": req_id, "result": {}}

        if method == "tools/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"tools": ALL_TOOLS}}

        if method == "tools/call":
            params = req.get("params") if isinstance(req.get("params"), dict) else {}
            name = params.get("name")
            args = params.get("arguments", {})
            if not isinstance(name, str) or not isinstance(args, dict):
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32602,
                        "message": (
                            'Invalid params: tools/call requires a string "name" '
                            'and object "arguments"'
                        ),
                    },
                }
            tool_res = dispatch_tool_call(name, args)
            return {"jsonrpc": "2.0", "id": req_id, "result": tool_res}

        if method == "resources/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"resources": ALL_RESOURCES}}

        if method == "resources/read":
            params = req.get("params") if isinstance(req.get("params"), dict) else {}
            uri = params.get("uri")
            if not isinstance(uri, str):
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32602,
                        "message": 'Invalid params: resources/read requires a string "uri"',
                    },
                }
            content = read_resource(uri)
            return {"jsonrpc": "2.0", "id": req_id, "result": {"contents": [content]}}

        if method == "prompts/list":
            return {"jsonrpc": "2.0", "id": req_id, "result": {"prompts": ALL_PROMPTS}}

        if method == "prompts/get":
            params = req.get("params") if isinstance(req.get("params"), dict) else {}
            name = params.get("name")
            args = params.get("arguments", {})
            if not isinstance(name, str) or not isinstance(args, dict):
                return {
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": {
                        "code": -32602,
                        "message": (
                            'Invalid params: prompts/get requires a string "name" '
                            'and object "arguments"'
                        ),
                    },
                }
            res = render_prompt(name, args)
            return {"jsonrpc": "2.0", "id": req_id, "result": res}

        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {"code": -32601, "message": f"Method not found: {method}"}
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
