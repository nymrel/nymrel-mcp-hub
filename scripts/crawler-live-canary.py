#!/usr/bin/env python3
"""Bounded public-network canary; not evidence of a hosted deployment.

Run from a built MCP Hub checkout. No injected resolver, fetch, or opener.
Only fixed public fixtures and one loopback rejection input are accepted.
"""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parents[1]
BASE = {"url": "https://example.com/", "limit": 1, "maxDepth": 0,
        "sitemap": "skip", "includeSubdomains": False}
PUBLIC_REDIRECT = "https://httpbingo.org/redirect-to?url=https%3A%2F%2Fexample.com%2F"
PRIVATE_REDIRECT = "https://httpbingo.org/redirect-to?url=http%3A%2F%2F127.0.0.1%2F"
CASES = [
    ("scrape", {**BASE, "action": "scrape"}, "document"),
    ("map", {**BASE, "action": "map"}, "map"),
    ("crawl", {**BASE, "action": "crawl"}, "crawl"),
    ("public-redirect", {**BASE, "action": "scrape", "url": PUBLIC_REDIRECT}, "document"),
    ("private-root", {**BASE, "action": "scrape", "url": "http://127.0.0.1/"}, "PRIVATE_NETWORK_TARGET"),
    ("private-redirect", {**BASE, "action": "scrape", "url": PRIVATE_REDIRECT}, "PRIVATE_NETWORK_TARGET"),
    ("page-cap", {**BASE, "action": "crawl", "limit": 101}, "between 1 and 100"),
    *[(f"{action}-http-error", {**BASE, "action": action, "url": "https://httpbingo.org/status/503"}, "http-error")
      for action in ("scrape", "map", "crawl")],
]
PY_WORKER = """import json, sys
from nymrel_mcp_hub.tools import dispatch_tool_call
print(json.dumps(dispatch_tool_call('nymrel_crawler_mesh', json.load(sys.stdin))))
"""
NODE_WORKER = """import { executeCrawler } from './dist/src/tools/crawlerTool.js';
let raw = ''; for await (const chunk of process.stdin) raw += chunk;
console.log(JSON.stringify(await executeCrawler(JSON.parse(raw))));
"""


def check_result(result: dict, expected: str) -> dict:
    text = str((result.get("content") or [{}])[0].get("text") or "")
    if expected in {"PRIVATE_NETWORK_TARGET", "between 1 and 100"}:
        if result.get("isError") is not True or expected not in text:
            raise ValueError(f"expected rejection {expected}; got: {text[:180]}")
        return {"rejection": expected}
    if expected == "http-error":
        if result.get("isError") is True and any(code in text.lower() for code in ("503", "http", "robots")):
            return {"rejection": text[:200]}
        raise ValueError(f"HTTP failure not surfaced as tool error: {text[:240]}")
    if result.get("isError"):
        raise ValueError(text[:240])
    data = json.loads(text)
    if data.get("networkFetchPerformed") is not True or data.get("success") is not True:
        raise ValueError("no successful network acquisition receipt")
    if data.get("source") != "nymrel-crawler-mesh":
        raise ValueError("unexpected provider")
    if expected == "map":
        links = data.get("links") or []
        if len(links) != 1 or urlparse(links[0]["url"]).hostname != "example.com":
            raise ValueError("map empty, out of scope, or over budget")
        return {"link_count": len(links), "urls": [item["url"] for item in links]}
    documents = data.get("data") if expected == "crawl" else [data.get("data")]
    if not isinstance(documents, list) or len(documents) != 1:
        raise ValueError("empty or over-budget crawl")
    rows = []
    for document in documents:
        metadata = document.get("metadata") or {}
        markdown = document.get("markdown") or ""
        if metadata.get("creditsUsed") != 0 or metadata.get("statusCode") != 200:
            raise ValueError("missing zero-credit / HTTP 200 evidence")
        if "Example Domain" not in markdown:
            raise ValueError("expected page content missing")
        final_url = metadata.get("url") or metadata.get("sourceURL") or ""
        if urlparse(final_url).hostname != "example.com":
            raise ValueError("unexpected final URL")
        rows.append({"final_url": final_url, "http_status": 200, "credits_used": 0,
                     "content_chars": len(markdown),
                     "content_sha256": hashlib.sha256(markdown.encode()).hexdigest()})
    return {"documents": rows}


def main() -> int:
    env = {key: value for key, value in os.environ.items() if key != "FIRECRAWL_API_KEY"}
    env["PYTHONPATH"] = str(ROOT / "python")
    rows = []
    for engine in ("python", "node"):
        for name, args, expected in CASES:
            started = time.monotonic()
            row = {"engine": engine, "case": name, "passed": False}
            command = [sys.executable, "-c", PY_WORKER] if engine == "python" else ["node", "--input-type=module", "-e", NODE_WORKER]
            try:
                completed = subprocess.run(command, input=json.dumps(args), text=True,
                                           capture_output=True, timeout=35, cwd=ROOT, env=env,
                                           check=False)
                if completed.returncode:
                    raise ValueError(f"worker exit {completed.returncode}: {completed.stderr[-240:]}")
                if len(completed.stdout) > 1_000_000:
                    raise ValueError("worker output cap exceeded")
                row.update(check_result(json.loads(completed.stdout), expected), passed=True)
            except (OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as error:
                row["error"] = str(error)[:400]
            row["elapsed_ms"] = round((time.monotonic() - started) * 1000)
            rows.append(row)
            print(json.dumps(row), flush=True)
    sha = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True,
                         capture_output=True, check=True, timeout=5).stdout.strip()
    report = {"schema_version": "nymrel.crawler-live-canary.v1", "source_commit": sha,
              "generated_at": datetime.now(timezone.utc).isoformat(),
              "firecrawl_key_passed": False, "runtime_network_injected": False,
              "hosted_deployment_verified": False, "case_count": len(rows),
              "passed": sum(row["passed"] for row in rows), "rows": rows}
    output = ROOT / "crawler-live-canary.json"
    output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print("CANARY_SUMMARY " + json.dumps({key: value for key, value in report.items() if key != "rows"}))
    return 0 if all(row["passed"] for row in rows) else 1


if __name__ == "__main__":
    raise SystemExit(main())
