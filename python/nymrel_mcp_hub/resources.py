"""
Nymrel MCP Hub - Python Resources
"""

import json
from typing import Dict, Any, List
from .protocol import LEGACY_PROTOCOL_VERSIONS, MODERN_PROTOCOL_VERSION
from .tools import ALL_TOOLS

ALL_RESOURCES: List[Dict[str, Any]] = [
    {
        "uri": "nymrel://status",
        "name": "Nymrel MCP Hub Status",
        "mimeType": "application/json",
        "description": "Live MCP server telemetry and uptime."
    },
    {
        "uri": "nymrel://ecosystem",
        "name": "Nymrel Ecosystem Repository Catalog",
        "mimeType": "application/json",
        "description": "Structured directory metadata of the Nymrel open-source toolchain ecosystem."
    },
    {
        "uri": "nymrel://llms-manifest",
        "name": "Nymrel LLMs Manifest",
        "mimeType": "text/markdown",
        "description": "Clean semantic /llms.txt guide for autonomous LLMs."
    }
]

def read_resource(uri: str) -> Dict[str, str]:
    clean_uri = uri.lower()
    if "status" in clean_uri:
        return {
            "uri": "nymrel://status",
            "mimeType": "application/json",
            "text": json.dumps(
                {
                    "server": "@nymrel/mcp-hub",
                    "engine": "python",
                    "status": "ONLINE",
                    "registeredTools": len(ALL_TOOLS),
                    "protocolVersions": {
                        "modern": MODERN_PROTOCOL_VERSION,
                        "legacy": list(LEGACY_PROTOCOL_VERSIONS),
                    },
                },
                indent=2,
            )
        }
    if "ecosystem" in clean_uri:
        return {
            "uri": "nymrel://ecosystem",
            "mimeType": "application/json",
            "text": json.dumps({"ecosystem": "Nymrel Open-Source", "repositories": 14}, indent=2)
        }
    if "llms" in clean_uri:
        return {
            "uri": "nymrel://llms-manifest",
            "mimeType": "text/markdown",
            "text": (
                "# Nymrel LLMs Manifest\nUnified tools for autonomous AI agents.\n\n"
                "## Proof Trust\n"
                "Receipt creation requires signingKey and explicit HMAC-SHA256 or Ed25519 algorithm.\n"
                "Verification without a key checks envelope/Merkle consistency only: valid:true, trusted:false, verified:false. Metadata and identity are not authenticated.\n"
                "Authentication requires publicKeyOrSecret AND expectedAlgorithm from independently trusted key configuration, never inferred from the receipt.\n"
                "Matching signatures authenticate canonical fields, not execution or unknown extension fields. Ed25519 keys are raw 32-byte hex; no PEM.\n"
                "Old simulated/unsigned/v1 receipts fail. No disk checks, Git commands, chain continuity, or replay guarantee.\n"
                "Python runtime dependencies: cryptography and rfc8785.\n"
            )
        }
    raise ValueError(f"Resource {uri} not found")
