#!/usr/bin/env python3
"""Exercise both real MCP stdio entry points against fixed public fixtures.

Source-checkout proof only: never asserts hosted deployment, registry publication,
or a connected client's tool activation. The child environment is allowlisted.
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODERN = "2026-07-28"
LEGACY = "2025-11-25"
IDENTITY = "@nymrel/mcp-hub"
CLIENT = {"name": "nymrel-crawler-stdio-canary", "version": "1.0.0"}
BASE = {"url": "https://example.com/", "limit": 1, "maxDepth": 0,
        "sitemap": "skip", "includeSubdomains": False}
MAX_LINE_BYTES = 1_000_000
REQUEST_TIMEOUT = 40


def child_env() -> dict[str, str]:
    keys = {"PATH", "HOME", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
            "LD_LIBRARY_PATH", "LANG", "LC_ALL", "SSL_CERT_FILE", "SSL_CERT_DIR"}
    env = {key: value for key, value in os.environ.items() if key in keys}
    env["PYTHONPATH"] = str(ROOT / "python")
    env["PYTHONUNBUFFERED"] = "1"
    return env


async def request(process, request_id, method, params, version):
    payload = dict(params)
    if version == MODERN:
        payload["_meta"] = {
            "io.modelcontextprotocol/protocolVersion": MODERN,
            "io.modelcontextprotocol/clientCapabilities": {},
            "io.modelcontextprotocol/clientInfo": CLIENT,
        }
    wire = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": payload}
    process.stdin.write((json.dumps(wire) + "\n").encode())
    await process.stdin.drain()
    # Strict request/response sequencing also catches unintended notification replies.
    raw = await asyncio.wait_for(process.stdout.readline(), REQUEST_TIMEOUT)
    if not raw or len(raw) > MAX_LINE_BYTES:
        raise ValueError("stdio_empty_or_oversized_response")
    reply = json.loads(raw)
    if reply.get("id") != request_id or reply.get("jsonrpc") != "2.0":
        raise ValueError("stdio_response_identity_mismatch")
    if "error" in reply or not isinstance(reply.get("result"), dict):
        raise ValueError("protocol_request_failed:" + method)
    result = reply["result"]
    if version == MODERN:
        identity = (result.get("_meta") or {}).get("io.modelcontextprotocol/serverInfo") or {}
        if result.get("resultType") != "complete" or identity.get("name") != IDENTITY:
            raise ValueError("modern_response_envelope_mismatch")
    return result


def inspect_tool_result(result, action):
    if action == "private-root":
        text = str((result.get("content") or [{}])[0].get("text") or "")
        if result.get("isError") is not True or "PRIVATE_NETWORK_TARGET" not in text:
            raise ValueError("private_target_not_rejected")
        return {"rejection": "PRIVATE_NETWORK_TARGET"}
    if result.get("isError"):
        raise ValueError("crawler_returned_tool_error")
    data = json.loads(result["content"][0]["text"])
    if data.get("success") is not True or data.get("networkFetchPerformed") is not True:
        raise ValueError("missing_live_acquisition_success")
    if data.get("source") != "nymrel-crawler-mesh":
        raise ValueError("unexpected_acquisition_provider")
    if action == "map":
        urls = [row["url"] for row in data.get("links", [])]
        if urls != [BASE["url"]]:
            raise ValueError("unexpected_map_result_or_budget")
        return {"urls": urls, "result_count": len(urls)}
    documents = data.get("data") if action == "crawl" else [data.get("data")]
    if not isinstance(documents, list) or len(documents) != 1:
        raise ValueError("unexpected_document_count")
    document = documents[0]
    metadata = document.get("metadata") or {}
    text = document.get("markdown") or ""
    if metadata.get("statusCode") != 200 or metadata.get("creditsUsed") != 0:
        raise ValueError("missing_http_status_or_zero_credits")
    if metadata.get("sourceURL") != BASE["url"] or "Example Domain" not in text:
        raise ValueError("source_or_content_mismatch")
    return {"source_url": metadata["sourceURL"], "http_status": 200,
            "credits_used": 0, "content_chars": len(text),
            "content_sha256": hashlib.sha256(text.encode()).hexdigest()}


async def session(engine, version):
    command = ([sys.executable, "-m", "nymrel_mcp_hub.cli", "--stdio"]
               if engine == "python" else ["node", str(ROOT / "bin/mcp-server.js"), "--stdio"])
    process = await asyncio.create_subprocess_exec(
        *command, cwd=ROOT, env=child_env(), stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
        limit=MAX_LINE_BYTES,
    )
    rows = []
    started = time.monotonic()
    stage = "discovery"
    try:
        if version == LEGACY:
            result = await request(process, 1, "initialize", {
                "protocolVersion": version, "capabilities": {}, "clientInfo": CLIENT,
            }, version)
            if result.get("protocolVersion") != version or result.get("serverInfo", {}).get("name") != IDENTITY:
                raise ValueError("legacy_initialization_mismatch")
            process.stdin.write(b'{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
            await process.stdin.drain()
        else:
            result = await request(process, 1, "server/discover", {}, version)
            if version not in result.get("supportedVersions", []):
                raise ValueError("modern_discovery_mismatch")
        if "tools" not in result.get("capabilities", {}):
            raise ValueError("tools_capability_missing")
        rows.append({"case": stage, "passed": True, "server_name": IDENTITY})
        stage = "tools-list"
        result = await request(process, 2, "tools/list", {}, version)
        matches = [t for t in result.get("tools", []) if t.get("name") == "nymrel_crawler_mesh"]
        if len(matches) != 1:
            raise ValueError("crawler_registration_missing_or_duplicate")
        schema = matches[0].get("inputSchema", {})
        actions = schema.get("properties", {}).get("action", {}).get("enum", [])
        if set(actions) != {"scrape", "map", "crawl"}:
            raise ValueError("crawler_schema_mismatch")
        rows.append({"case": stage, "passed": True, "crawler_registered": True})
        first_hash = None
        for index, action in enumerate(("scrape", "scrape-repeat", "map", "crawl", "private-root"), 3):
            stage = action
            args = {**BASE, "action": "scrape" if action in {"scrape-repeat", "private-root"} else action}
            if action == "private-root":
                args["url"] = "http://127.0.0.1/"
            result = await request(process, index, "tools/call", {
                "name": "nymrel_crawler_mesh", "arguments": args,
            }, version)
            details = inspect_tool_result(result, action)
            if action == "scrape":
                first_hash = details["content_sha256"]
                await asyncio.sleep(1.1)  # Cross a timestamp boundary for the former hash defect.
            elif action == "scrape-repeat" and details["content_sha256"] != first_hash:
                raise ValueError("unstable_markdown_hash")
            rows.append({"case": action, "passed": True, **details})
    except (ValueError, KeyError, TypeError, OSError, TimeoutError) as error:
        rows.append({"case": stage, "passed": False, "error": type(error).__name__ + ":" + str(error)[:180]})
    finally:
        process.stdin.close()
        try:
            await asyncio.wait_for(process.wait(), 5)
        except TimeoutError:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), 3)
            except TimeoutError:
                process.kill()
                await process.wait()
    return {"engine": engine, "protocol_version": version,
            "entrypoint": "python-module-cli" if engine == "python" else "node-bin-cli",
            "elapsed_ms": round((time.monotonic() - started) * 1000),
            "checks": rows, "passed": len(rows) == 7 and all(row["passed"] for row in rows)}


async def main():
    sessions = []
    for engine in ("python", "node"):
        for version in (LEGACY, MODERN):
            try:
                row = await asyncio.wait_for(session(engine, version), 180)
            except (OSError, TimeoutError) as error:
                row = {"engine": engine, "protocol_version": version, "passed": False,
                       "checks": [], "error": type(error).__name__}
            sessions.append(row)
            print(json.dumps(row), flush=True)
    sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True,
                         text=True, timeout=5, check=True).stdout.strip()
    report = {"schema_version": "nymrel.crawler-stdio-canary.v1", "source_commit": sha,
              "generated_at": datetime.now(timezone.utc).isoformat(),
              "network_injected": False, "child_environment": "allowlist_no_provider_credentials",
              "hosted_deployment_verified": False, "chatgpt_tool_activation_verified": False,
              "planned_checks": 28, "passed_checks": sum(c["passed"] for s in sessions for c in s["checks"]),
              "sessions": sessions}
    (ROOT / "crawler-stdio-canary.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("STDIO_CANARY_SUMMARY " + json.dumps({k: v for k, v in report.items() if k != "sessions"}))
    return 0 if all(s["passed"] for s in sessions) else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
