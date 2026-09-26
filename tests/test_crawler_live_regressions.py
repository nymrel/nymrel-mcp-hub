"""Deterministic regressions for defects found by the real-network canary."""
import json
from email.message import Message

import pytest

from nymrel_mcp_hub.crawler_tool import execute_crawler


class Response:
    def __init__(self, body, status=200, location=None):
        self.body = body.encode()
        self.status = status
        self.code = status
        self.reason = "fixture"
        self.headers = Message()
        self.headers["content-type"] = "text/html"
        if location:
            self.headers["location"] = location

    def read(self, size=-1):
        return self.body if size < 0 else self.body[:size]

    def close(self):
        pass


def run(action, *, status=200, limit=2, search="", redirect=False):
    calls = []

    def opener(request, timeout):
        url = request.full_url
        if url.endswith("/robots.txt"):
            return Response("User-agent: *\nAllow: /\n")
        calls.append(url)
        if redirect:
            return Response("", 302, "http://127.0.0.1/private")
        if url == "https://example.com/":
            return Response(
                '<html><head><title>Stable</title></head><body><main><h1>Root</h1>'
                '<a href="/a">A</a><a href="/b">B</a><a href="/c">C</a>'
                '</main></body></html>', status,
            )
        return Response("child failure", 503)

    result = execute_crawler(
        {"action": action, "url": "https://example.com/", "limit": limit,
         "sitemap": "skip", "maxDepth": 1, "search": search},
        resolver=lambda host: ["93.184.216.34"], url_opener=opener,
    )
    return result, calls


@pytest.mark.parametrize("action", ["map", "crawl"])
@pytest.mark.parametrize("status", [403, 503])
def test_root_http_error_is_not_successful_empty_result(action, status):
    result, calls = run(action, status=status)
    assert result.get("isError") is True
    assert f"HTTP {status}" in result["content"][0]["text"]
    assert calls == ["https://example.com/"]


def test_filtered_map_with_acquired_root_can_be_empty():
    result, _ = run("map", search="does-not-match")
    assert not result.get("isError")
    assert json.loads(result["content"][0]["text"])["links"] == []


@pytest.mark.parametrize("action", ["map", "crawl"])
def test_failed_child_consumes_budget_without_erasing_root(action):
    result, calls = run(action, limit=2)
    assert not result.get("isError")
    assert len(calls) == 2
    assert calls[0] == "https://example.com/"
    payload = json.loads(result["content"][0]["text"])
    assert payload["success"] is True
    if action == "crawl":
        assert payload["completed"] == 1


def test_network_markdown_has_no_synthetic_frontmatter_and_is_repeatable():
    first, _ = run("scrape")
    second, _ = run("scrape")
    first_data = json.loads(first["content"][0]["text"])["data"]
    second_data = json.loads(second["content"][0]["text"])["data"]
    assert not first_data["markdown"].startswith("---")
    assert first_data["markdown"] == second_data["markdown"]
    assert first_data["metadata"]["contentHash"] == second_data["metadata"]["contentHash"]
    assert first_data["metadata"]["title"] == "Stable"
    assert first_data["metadata"]["creditsUsed"] == 0


@pytest.mark.parametrize("action", ["scrape", "map", "crawl"])
def test_private_redirect_stays_rejected_at_root(action):
    result, calls = run(action, redirect=True)
    assert result.get("isError") is True
    assert "PRIVATE_NETWORK_TARGET" in result["content"][0]["text"]
    assert calls == ["https://example.com/"]
