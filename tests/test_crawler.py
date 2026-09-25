import json
from email.message import Message

from nymrel_mcp_hub.crawler_tool import execute_crawler
from nymrel_mcp_hub.tools import dispatch_tool_call


class FakeResponse:
    def __init__(self, body="", status=200, headers=None, reason="OK"):
        self._body = body.encode("utf-8")
        self.status = status
        self.code = status
        self.reason = reason
        message = Message()
        for key, value in (headers or {}).items():
            message[key] = value
        self.headers = message

    def read(self, size=-1):
        if size < 0:
            return self._body
        return self._body[:size]

    def close(self):
        return None


PAGES = {
    "https://example.com/": (
        '<html><head><title>Home</title></head><body><main><h1>Home</h1>'
        '<a href="/docs">Docs</a><a href="https://api.example.com/reference">'
        "API</a></main></body></html>"
    ),
    "https://example.com/docs": (
        '<html><head><title>Docs</title></head><body><main><h1>Docs</h1>'
        '<a href="/docs/a">A</a><a href="/pricing">Pricing</a>'
        "</main></body></html>"
    ),
    "https://example.com/docs/a": (
        "<html><head><title>Doc A</title></head>"
        "<body><main><p>Child page</p></main></body></html>"
    ),
    "https://example.com/pricing": (
        "<html><head><title>Pricing</title></head>"
        "<body><main><p>Pricing</p></main></body></html>"
    ),
    "https://api.example.com/reference": (
        "<html><head><title>API Reference</title></head>"
        "<body><main><p>Reference</p></main></body></html>"
    ),
}


def public_resolver(hostname):
    if hostname == "private.example.com":
        return ["127.0.0.1"]
    return ["93.184.216.34"]


def fake_opener(request, timeout):
    url = request.full_url
    if url.endswith("/robots.txt"):
        return FakeResponse("User-agent: *\nAllow: /\n", headers={"Content-Type": "text/plain"})
    if url == "https://redirect.example.com/":
        return FakeResponse("", status=302, headers={"Location": "http://127.0.0.1/secret"})
    body = PAGES.get(url)
    if body is None:
        return FakeResponse("Not Found", status=404, reason="Not Found")
    return FakeResponse(body, headers={"Content-Type": "text/html; charset=utf-8"})


def payload(result):
    assert not result.get("isError"), result
    return json.loads(result["content"][0]["text"])


def test_python_crawler_local_html_preserves_title_heading_and_tokens():
    html = (
        "<html><head><title>Clean Source</title></head><body>"
        '<h1>Clean Title</h1><p>Test <a href="https://nymrel.com">link</a></p>'
        "</body></html>"
    )
    data = payload(execute_crawler({"html": html, "url": "https://example.com/source"}))
    assert data["networkFetchPerformed"] is False
    assert data["metadata"]["title"] == "Clean Source"
    assert "# Clean Title" in data["markdown"]
    assert data["tokens"]["cleanMarkdownTokens"] > 0


def test_python_crawler_scrape_uses_real_runtime_zero_credits():
    data = payload(
        execute_crawler(
            {"action": "scrape", "url": "https://example.com/"},
            resolver=public_resolver,
            url_opener=fake_opener,
        )
    )
    assert data["networkFetchPerformed"] is True
    assert data["data"]["metadata"]["provider"] == "nymrel-crawler-mesh"
    assert data["data"]["metadata"]["creditsUsed"] == 0
    assert "# Home" in data["data"]["markdown"]


def test_python_crawler_map_filters_discovered_links():
    data = payload(
        execute_crawler(
            {
                "action": "map",
                "url": "https://example.com/",
                "search": "api",
                "sitemap": "skip",
                "limit": 10,
            },
            resolver=public_resolver,
            url_opener=fake_opener,
        )
    )
    assert [item["url"] for item in data["links"]] == [
        "https://api.example.com/reference"
    ]


def test_python_crawler_child_scope_and_whole_domain():
    child = payload(
        execute_crawler(
            {
                "action": "crawl",
                "url": "https://example.com/docs",
                "sitemap": "skip",
                "limit": 10,
                "maxDepth": 2,
            },
            resolver=public_resolver,
            url_opener=fake_opener,
        )
    )
    assert sorted(item["metadata"]["sourceURL"] for item in child["data"]) == [
        "https://example.com/docs",
        "https://example.com/docs/a",
    ]

    whole = payload(
        execute_crawler(
            {
                "action": "crawl",
                "url": "https://example.com/docs",
                "sitemap": "skip",
                "limit": 10,
                "maxDepth": 1,
                "crawlEntireDomain": True,
            },
            resolver=public_resolver,
            url_opener=fake_opener,
        )
    )
    assert sorted(item["metadata"]["sourceURL"] for item in whole["data"]) == [
        "https://example.com/docs",
        "https://example.com/docs/a",
        "https://example.com/pricing",
    ]


def test_python_crawler_private_dns_fails_before_opener():
    calls = 0

    def opener(request, timeout):
        nonlocal calls
        calls += 1
        return FakeResponse("should not run")

    result = execute_crawler(
        {"action": "scrape", "url": "https://private.example.com/"},
        resolver=public_resolver,
        url_opener=opener,
    )
    assert result["isError"] is True
    assert "PRIVATE_NETWORK_TARGET" in result["content"][0]["text"]
    assert calls == 0


def test_python_crawler_private_root_fails_for_map_and_crawl():
    for action in ("map", "crawl"):
        result = execute_crawler(
            {"action": action, "url": "https://private.example.com/", "sitemap": "skip"},
            resolver=public_resolver,
            url_opener=fake_opener,
        )
        assert result["isError"] is True
        assert "PRIVATE_NETWORK_TARGET" in result["content"][0]["text"]


def test_python_crawler_rejects_redirect_to_private_target():
    result = execute_crawler(
        {"action": "scrape", "url": "https://redirect.example.com/"},
        resolver=public_resolver,
        url_opener=fake_opener,
    )
    assert result["isError"] is True
    assert "PRIVATE_NETWORK_TARGET" in result["content"][0]["text"]


def test_python_crawler_hard_caps():
    too_many = execute_crawler(
        {"action": "crawl", "url": "https://example.com/", "limit": 101},
        resolver=public_resolver,
        url_opener=fake_opener,
    )
    assert too_many["isError"] is True
    assert "limit must be an integer between 1 and 100" in too_many["content"][0]["text"]

    too_deep = execute_crawler(
        {"action": "crawl", "url": "https://example.com/", "maxDepth": 11},
        resolver=public_resolver,
        url_opener=fake_opener,
    )
    assert too_deep["isError"] is True
    assert "maxDepth must be an integer between 0 and 10" in too_deep["content"][0]["text"]


def test_python_mcp_dispatch_routes_crawler_tool():
    html = "<html><body><h1>Dispatch Works</h1></body></html>"
    result = dispatch_tool_call("nymrel_crawler_mesh", {"html": html})
    data = payload(result)
    assert data["source"] == "local-html"
    assert "# Dispatch Works" in data["markdown"]
