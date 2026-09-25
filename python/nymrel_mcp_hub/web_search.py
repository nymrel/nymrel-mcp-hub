"""Normalized multi-provider public-web search for Nymrel agents."""

from __future__ import annotations

import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Dict, List, Mapping, Optional
from http.client import HTTPSConnection
from urllib.parse import urlencode, urlparse


PROVIDERS = ("exa", "tavily", "brave", "serpapi")
ENV_KEY = {
    "exa": "EXA_API_KEY",
    "tavily": "TAVILY_API_KEY",
    "brave": "BRAVE_SEARCH_API_KEY",
    "serpapi": "SERPAPI_API_KEY",
}
HttpJson = Callable[
    [str, str, Mapping[str, str], Optional[Dict[str, Any]], float],
    Dict[str, Any],
]


def _error(text: str) -> Dict[str, Any]:
    return {"isError": True, "content": [{"type": "text", "text": text}]}


def _trim(value: Any) -> Optional[str]:
    return value.strip() or None if isinstance(value, str) else None


def _domains(value: Any) -> List[str]:
    if value is None:
        return []
    if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
        raise ValueError("Domain filters must be arrays of strings.")
    result: List[str] = []
    for item in value:
        raw = item.strip().lower()
        if "://" in raw:
            raw = urlparse(raw).hostname or ""
        else:
            raw = raw.split("/", 1)[0]
        raw = raw.removeprefix("www.")
        if raw and raw not in result:
            result.append(raw)
    return result


def _validate(args: Dict[str, Any]) -> Dict[str, Any]:
    query = _trim(args.get("query"))
    if not query:
        raise ValueError("query must be a non-empty string.")

    provider = (_trim(args.get("provider")) or "auto").lower()
    if provider not in {"auto", *PROVIDERS}:
        raise ValueError("Unsupported provider.")

    mode = (_trim(args.get("mode")) or "search").lower()
    if mode not in {"search", "research", "serp_exact"}:
        raise ValueError("Unsupported mode.")

    max_results = args.get("maxResults", 8)
    if isinstance(max_results, bool) or not isinstance(max_results, int) or not 1 <= max_results <= 20:
        raise ValueError("maxResults must be an integer from 1 through 20.")

    freshness = args.get("freshnessDays")
    if freshness is not None and (
        isinstance(freshness, bool)
        or not isinstance(freshness, int)
        or not 1 <= freshness <= 3650
    ):
        raise ValueError("freshnessDays must be an integer from 1 through 3650.")

    country = _trim(args.get("country"))
    if country:
        country = country.upper()
        if len(country) != 2 or not country.isalpha():
            raise ValueError("country must be a two-letter code such as US.")

    language = _trim(args.get("language"))
    return {
        "query": query,
        "provider": provider,
        "mode": mode,
        "maxResults": max_results,
        "freshnessDays": freshness,
        "country": country,
        "language": language.lower() if language else None,
        "includeDomains": _domains(args.get("includeDomains")),
        "excludeDomains": _domains(args.get("excludeDomains")),
    }


def _order(provider: str, mode: str) -> List[str]:
    if provider != "auto":
        return [provider]
    if mode == "serp_exact":
        return ["serpapi", "brave", "exa", "tavily"]
    return ["exa", "tavily", "brave", "serpapi"]


def _default_http(
    url: str,
    method: str,
    headers: Mapping[str, str],
    payload: Optional[Dict[str, Any]],
    timeout: float,
) -> Dict[str, Any]:
    parsed = urlparse(url)
    allowed_hosts = {"api.exa.ai", "api.tavily.com", "api.search.brave.com", "serpapi.com"}
    if parsed.scheme != "https" or parsed.hostname not in allowed_hosts:
        raise RuntimeError("web search outbound request rejected by provider allowlist")

    path = parsed.path or "/"
    if parsed.query:
        path += "?" + parsed.query
    body = json.dumps(payload).encode("utf-8") if payload is not None else None
    request_headers = dict(headers)
    if body is not None:
        request_headers.setdefault("Content-Type", "application/json")

    connection = HTTPSConnection(parsed.hostname, parsed.port or 443, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=request_headers)
        response = connection.getresponse()
        raw = response.read().decode("utf-8", errors="replace")
        try:
            parsed_body: Any = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed_body = raw

        if response.status < 200 or response.status >= 300:
            if isinstance(parsed_body, str):
                detail = parsed_body
            elif isinstance(parsed_body, dict):
                nested = parsed_body.get("detail")
                detail = parsed_body.get("message") or parsed_body.get("error")
                if not detail and isinstance(nested, dict):
                    detail = nested.get("error") or nested.get("message")
                if not detail and isinstance(nested, str):
                    detail = nested
            else:
                detail = None
            raise RuntimeError(
                f"HTTP {response.status}: {str(detail or 'provider error')[:500]}"
            )
        if not isinstance(parsed_body, dict):
            raise RuntimeError("provider returned a non-object JSON response")
        return parsed_body
    finally:
        connection.close()

def _start(now: datetime, days: Optional[int]) -> Optional[datetime]:
    return now - timedelta(days=days) if days else None


def _brave_freshness(days: Optional[int]) -> Optional[str]:
    if not days:
        return None
    if days <= 1:
        return "pd"
    if days <= 7:
        return "pw"
    if days <= 31:
        return "pm"
    if days <= 365:
        return "py"
    return None


def _serp_freshness(days: Optional[int]) -> Optional[str]:
    if not days:
        return None
    if days <= 1:
        return "qdr:d"
    if days <= 7:
        return "qdr:w"
    if days <= 31:
        return "qdr:m"
    if days <= 365:
        return "qdr:y"
    return None


def _normalized(rank: int, row: Dict[str, Any], provider: str) -> Optional[Dict[str, Any]]:
    url = row.get("link") if provider == "serpapi" else row.get("url")
    if not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
        return None
    snippet = (
        row.get("content")
        if provider == "tavily"
        else row.get("description")
        if provider == "brave"
        else row.get("snippet")
        if provider == "serpapi"
        else row.get("summary") or row.get("text") or (
            row.get("highlights", [""])[0] if row.get("highlights") else ""
        )
    )
    published = (
        row.get("publishedDate")
        if provider == "exa"
        else row.get("published_date")
        if provider == "tavily"
        else row.get("page_age") or row.get("age")
        if provider == "brave"
        else row.get("date")
    )
    result: Dict[str, Any] = {
        "rank": rank,
        "title": row.get("title", "") if isinstance(row.get("title"), str) else "",
        "url": url,
        "snippet": snippet.strip() if isinstance(snippet, str) else "",
    }
    if isinstance(published, str) and published.strip():
        result["publishedAt"] = published.strip()
    if isinstance(row.get("score"), (int, float)) and not isinstance(row.get("score"), bool):
        result["score"] = float(row["score"])
    return result


def _call(
    provider: str,
    args: Dict[str, Any],
    key: str,
    http_json: HttpJson,
    timeout: float,
    now: datetime,
) -> Dict[str, Any]:
    if provider == "exa":
        payload: Dict[str, Any] = {"query": args["query"], "numResults": args["maxResults"]}
        if args["includeDomains"]:
            payload["includeDomains"] = args["includeDomains"]
        if args["excludeDomains"]:
            payload["excludeDomains"] = args["excludeDomains"]
        start = _start(now, args["freshnessDays"])
        if start:
            payload["startPublishedDate"] = start.isoformat().replace("+00:00", "Z")
        body = http_json(
            "https://api.exa.ai/search",
            "POST",
            {"Content-Type": "application/json", "x-api-key": key},
            payload,
            timeout,
        )
    elif provider == "tavily":
        payload = {
            "query": args["query"],
            "search_depth": "advanced" if args["mode"] == "research" else "basic",
            "max_results": args["maxResults"],
            "include_published_date": True,
            "include_answer": False,
            "include_raw_content": False,
            "include_images": False,
            "safe_search": True,
        }
        if args["includeDomains"]:
            payload["include_domains"] = args["includeDomains"]
        if args["excludeDomains"]:
            payload["exclude_domains"] = args["excludeDomains"]
        if args["language"]:
            payload["language"] = args["language"]
            payload["filter_by_language"] = True
        start = _start(now, args["freshnessDays"])
        if start:
            payload["start_date"] = start.date().isoformat()
        body = http_json(
            "https://api.tavily.com/search",
            "POST",
            {"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
            payload,
            timeout,
        )
    elif provider == "brave":
        params = {"q": args["query"], "count": str(args["maxResults"])}
        if args["country"]:
            params["country"] = args["country"]
        if args["language"]:
            params["search_lang"] = args["language"]
        fresh = _brave_freshness(args["freshnessDays"])
        if fresh:
            params["freshness"] = fresh
        body = http_json(
            "https://api.search.brave.com/res/v1/web/search?" + urlencode(params),
            "GET",
            {"Accept": "application/json", "X-Subscription-Token": key},
            None,
            timeout,
        )
    else:
        params = {
            "engine": "google",
            "q": args["query"],
            "api_key": key,
            "num": str(args["maxResults"]),
        }
        if args["country"]:
            params["gl"] = args["country"].lower()
        if args["language"]:
            params["hl"] = args["language"]
        fresh = _serp_freshness(args["freshnessDays"])
        if fresh:
            params["tbs"] = fresh
        body = http_json(
            "https://serpapi.com/search.json?" + urlencode(params),
            "GET",
            {},
            None,
            timeout,
        )

    rows = (
        (body.get("web") or {}).get("results")
        if provider == "brave"
        else body.get("organic_results")
        if provider == "serpapi"
        else body.get("results")
    )
    results = []
    for index, row in enumerate(rows if isinstance(rows, list) else [], 1):
        if not isinstance(row, dict):
            continue
        rank = row.get("position") if provider == "serpapi" and isinstance(row.get("position"), int) else index
        item = _normalized(rank, row, provider)
        if item:
            results.append(item)

    request_id = (
        body.get("request_id")
        or body.get("requestId")
        or (body.get("search_metadata") or {}).get("id")
        or (body.get("query") or {}).get("id")
    )
    response_ms = None
    if provider == "tavily":
        try:
            response_ms = round(float(body.get("response_time")) * 1000)
        except (TypeError, ValueError):
            pass
    return {"results": results, "requestId": request_id, "responseTimeMs": response_ms}


def _matches(url: str, domain: str) -> bool:
    host = (urlparse(url).hostname or "").lower().removeprefix("www.")
    return host == domain or host.endswith("." + domain)


def execute_web_search(
    raw_args: Dict[str, Any],
    *,
    environ: Optional[Mapping[str, str]] = None,
    http_json: Optional[HttpJson] = None,
    now: Optional[datetime] = None,
    timeout: float = 15.0,
) -> Dict[str, Any]:
    try:
        args = _validate(raw_args)
    except ValueError as exc:
        return _error(str(exc))

    env = environ if environ is not None else os.environ
    request_json = http_json or _default_http
    timestamp = now or datetime.now(timezone.utc)
    if timestamp.tzinfo is None:
        timestamp = timestamp.replace(tzinfo=timezone.utc)
    attempts: List[Dict[str, Any]] = []

    for provider in _order(args["provider"], args["mode"]):
        key = _trim(env.get(ENV_KEY[provider]))
        if not key:
            attempts.append({
                "provider": provider,
                "status": "missing_configuration",
                "reason": f"Set {ENV_KEY[provider]} in the MCP server environment.",
            })
            if args["provider"] != "auto":
                break
            continue

        try:
            response = _call(provider, args, key, request_json, timeout, timestamp)
            results = [
                item for item in response["results"]
                if (
                    not args["includeDomains"]
                    or any(_matches(item["url"], domain) for domain in args["includeDomains"])
                )
                and not any(_matches(item["url"], domain) for domain in args["excludeDomains"])
            ][: args["maxResults"]]
            for rank, item in enumerate(results, 1):
                item["rank"] = rank

            attempts.append({"provider": provider, "status": "success"})
            payload = {
                "schemaVersion": "1.0",
                "query": args["query"],
                "mode": args["mode"],
                "providerUsed": provider,
                "retrievedAt": timestamp.astimezone(timezone.utc).isoformat().replace("+00:00", "Z"),
                "requestId": response.get("requestId"),
                "responseTimeMs": response.get("responseTimeMs"),
                "resultCount": len(results),
                "results": results,
                "attempts": attempts,
                "policy": {
                    "credentials": "server-environment-only",
                    "fabricatedResults": False,
                    "resultUrlsFetched": False,
                    "escalation": (
                        "Use nymrel_crawler_mesh for extraction/crawling; use a privileged "
                        "browser service only for interaction or JavaScript execution."
                    ),
                },
            }
            return {"content": [{"type": "text", "text": json.dumps(payload, indent=2)}]}
        except Exception as exc:
            attempts.append({"provider": provider, "status": "failed", "reason": str(exc)[:700]})
            if args["provider"] != "auto":
                break

    configured = [provider for provider in PROVIDERS if _trim(env.get(ENV_KEY[provider]))]
    return _error(json.dumps({
        "error": (
            "All eligible web-search provider attempts failed."
            if configured
            else "No web-search provider is configured."
        ),
        "query": args["query"],
        "mode": args["mode"],
        "attempts": attempts,
        "configuredProviders": configured,
        "requiredEnvironmentVariables": ENV_KEY,
        "policy": {"credentials": "server-environment-only", "fabricatedResults": False},
    }, indent=2))
