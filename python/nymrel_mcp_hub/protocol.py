"""Dual-era MCP protocol negotiation and response envelopes."""

from typing import Any, Dict, Optional, Tuple

MODERN_PROTOCOL_VERSION = "2026-07-28"
LEGACY_PROTOCOL_VERSIONS = (
    "2025-11-25",
    "2025-06-18",
    "2025-03-26",
    "2024-11-05",
    "2024-10-07",
)
PREFERRED_LEGACY_PROTOCOL_VERSION = LEGACY_PROTOCOL_VERSIONS[0]

PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion"
CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo"
CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities"
SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo"

SERVER_INFO = {
    "name": "@nymrel/mcp-hub",
    "version": "1.0.0",
}
SERVER_INSTRUCTIONS = (
    "Unified Nymrel MCP Hub providing 14 zero-dependency agent tools, resources, "
    "and prompt templates."
)


def legacy_capabilities() -> Dict[str, Any]:
    return {
        "tools": {"listChanged": False},
        "resources": {"listChanged": False},
        "prompts": {"listChanged": False},
    }


def modern_capabilities() -> Dict[str, Any]:
    return {"tools": {}, "resources": {}, "prompts": {}}


def negotiate_legacy_protocol_version(params: Any) -> str:
    requested = params.get("protocolVersion") if isinstance(params, dict) else None
    return requested if requested in LEGACY_PROTOCOL_VERSIONS else PREFERRED_LEGACY_PROTOCOL_VERSION


def _invalid_params(request_id: Any, message: str) -> Dict[str, Any]:
    return {
        "jsonrpc": "2.0",
        "id": request_id,
        "error": {"code": -32602, "message": message},
    }


def classify_protocol_request(
    request: Dict[str, Any], request_id: Any
) -> Tuple[str, Optional[Dict[str, Any]]]:
    params = request.get("params") if isinstance(request.get("params"), dict) else None
    meta = params.get("_meta") if params and isinstance(params.get("_meta"), dict) else None
    has_modern_version_marker = meta is not None and PROTOCOL_VERSION_META_KEY in meta
    is_modern_candidate = request.get("method") == "server/discover" or has_modern_version_marker

    if not is_modern_candidate:
        return "legacy", None

    if params is None or meta is None:
        return "modern", _invalid_params(
            request_id,
            "Invalid params: modern MCP requests require a params._meta object",
        )

    requested_version = meta.get(PROTOCOL_VERSION_META_KEY)
    if not isinstance(requested_version, str):
        return "modern", _invalid_params(
            request_id,
            f"Invalid params: {PROTOCOL_VERSION_META_KEY} must be a string",
        )

    if requested_version != MODERN_PROTOCOL_VERSION:
        return "modern", {
            "jsonrpc": "2.0",
            "id": request_id,
            "error": {
                "code": -32022,
                "message": f"Unsupported MCP protocol version: {requested_version}",
                "data": {
                    "supported": [MODERN_PROTOCOL_VERSION],
                    "requested": requested_version,
                },
            },
        }

    if not isinstance(meta.get(CLIENT_CAPABILITIES_META_KEY), dict):
        return "modern", _invalid_params(
            request_id,
            f"Invalid params: {CLIENT_CAPABILITIES_META_KEY} must be an object",
        )

    client_info = meta.get(CLIENT_INFO_META_KEY)
    if client_info is not None and (
        not isinstance(client_info, dict)
        or not isinstance(client_info.get("name"), str)
        or not isinstance(client_info.get("version"), str)
    ):
        return "modern", _invalid_params(
            request_id,
            f"Invalid params: {CLIENT_INFO_META_KEY} must contain string name and version fields",
        )

    return "modern", None


def stamp_modern_success(response: Dict[str, Any], method: str) -> Dict[str, Any]:
    result = response.get("result")
    if not isinstance(result, dict):
        return response

    existing_meta = result.get("_meta") if isinstance(result.get("_meta"), dict) else {}
    stamped_result = {
        **result,
        "resultType": "complete",
        "_meta": {**existing_meta, SERVER_INFO_META_KEY: dict(SERVER_INFO)},
    }

    if method == "server/discover":
        stamped_result.update({"ttlMs": 3_600_000, "cacheScope": "public"})
    elif method in {"tools/list", "resources/list", "prompts/list"}:
        stamped_result.update({"ttlMs": 300_000, "cacheScope": "public"})

    return {**response, "result": stamped_result}
