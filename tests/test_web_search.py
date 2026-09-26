import json
from datetime import datetime, timezone

from nymrel_mcp_hub.web_search import execute_web_search


def test_web_search_fails_closed_without_configured_provider():
    result = execute_web_search({"query": "agent web search"}, environ={})
    assert result["isError"] is True
    data = json.loads(result["content"][0]["text"])
    assert data["error"] == "No web-search provider is configured."
    assert data["configuredProviders"] == []
    assert data["policy"]["fabricatedResults"] is False


def test_web_search_normalizes_tavily_without_leaking_key():
    captured = {}

    def fake_http(url, method, headers, payload, timeout):
        captured.update(
            {
                "url": url,
                "method": method,
                "headers": dict(headers),
                "payload": payload,
                "timeout": timeout,
            }
        )
        return {
            "results": [
                {
                    "title": "Tavily Docs",
                    "url": "https://docs.tavily.com/example",
                    "content": "Agent-oriented search result.",
                    "score": 0.91,
                    "published_date": "2026-09-24T12:00:00Z",
                }
            ],
            "response_time": "0.42",
            "request_id": "req-test",
        }

    result = execute_web_search(
        {
            "query": "agent search",
            "provider": "tavily",
            "includeDomains": ["docs.tavily.com"],
        },
        environ={"TAVILY_API_KEY": "tvly-secret-test"},
        http_json=fake_http,
        now=datetime(2026, 9, 24, 20, 0, tzinfo=timezone.utc),
    )

    assert result.get("isError") is None
    assert captured["headers"]["Authorization"] == "Bearer tvly-secret-test"
    assert "tvly-secret-test" not in result["content"][0]["text"]
    data = json.loads(result["content"][0]["text"])
    assert data["providerUsed"] == "tavily"
    assert data["resultCount"] == 1
    assert data["results"][0]["url"] == "https://docs.tavily.com/example"
    assert data["responseTimeMs"] == 420
    assert data["policy"]["resultUrlsFetched"] is False


def test_web_search_auto_falls_back_after_provider_failure():
    def fake_http(url, method, headers, payload, timeout):
        if "api.exa.ai" in url:
            raise RuntimeError("HTTP 503: temporary failure")
        return {
            "web": {
                "results": [
                    {
                        "title": "Fallback",
                        "url": "https://example.com/fallback",
                        "description": "Brave fallback result.",
                    }
                ]
            }
        }

    result = execute_web_search(
        {"query": "fallback test"},
        environ={
            "EXA_API_KEY": "exa-secret-test",
            "BRAVE_SEARCH_API_KEY": "brave-secret-test",
        },
        http_json=fake_http,
    )

    assert result.get("isError") is None
    data = json.loads(result["content"][0]["text"])
    assert data["providerUsed"] == "brave"
    assert [(item["provider"], item["status"]) for item in data["attempts"]] == [
        ("exa", "failed"),
        ("tavily", "missing_configuration"),
        ("brave", "success"),
    ]
