"""
Nymrel MCP Hub - Python Resources
"""

import json
from typing import Dict, Any, List

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
        "description": "Structured directory metadata of all 14 Nymrel open-source toolchains."
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
            "text": json.dumps({"server": "@nymrel/mcp-hub", "engine": "python", "status": "ONLINE", "registeredTools": 14}, indent=2)
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
            "text": "# Nymrel LLMs Manifest\nUnified tools for autonomous AI agents."
        }
    raise ValueError(f"Resource {uri} not found")
