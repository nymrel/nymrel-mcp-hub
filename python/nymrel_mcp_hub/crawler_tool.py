"""Thin MCP adapter for the pinned Nymrel Crawler Mesh Python runtime."""

from __future__ import annotations

import re
from collections import deque
from dataclasses import asdict
from typing import Any, Callable, Iterable, Optional
from urllib.parse import urlparse, urlunparse

from ._crawler_mesh.crawler import CrawlerMesh
from ._crawler_mesh.extractor import extract_markdown, extract_metadata
from ._crawler_mesh.sitemap import fetch_and_parse_sitemap

CANONICAL_REPOSITORY = "https://github.com/nymrel/nymrel-crawler-mesh"
CANONICAL_REVISION = "35634d2109bb8c33cb17e38acf70c584e891c2e6"
DEFAULT_LIMIT = 20
MAX_LIMIT = 100
DEFAULT_DEPTH = 2
MAX_DEPTH = 10
USER_AGENT = (
    "NymrelMCPHub-CrawlerMesh/1.0 "
    "(+https://github.com/nymrel/nymrel-mcp-hub)"
)


def _error(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": message}], "isError": True}


def _ok(payload: dict[str, Any]) -> dict[str, Any]:
    import json

    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2)}]}


def _bounded_int(
    value: Any,
    fallback: int,
    minimum: int,
    maximum: int,
    name: str,
) -> int:
    if value is None:
        return fallback
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be an integer between {minimum} and {maximum}")
    if value < minimum or value > maximum:
        raise ValueError(f"{name} must be an integer between {minimum} and {maximum}")
    return value


def _validated_url(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("url is required for network crawler operations")
    parsed = urlparse(value.strip())
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("url must use http or https")
    return parsed.geturl()


def _canonical_url(value: str) -> str:
    parsed = urlparse(value)
    return urlunparse(
        (
            parsed.scheme.lower(),
            parsed.netloc.lower(),
            parsed.path or "/",
            parsed.params,
            parsed.query,
            "",
        )
    )


def _body_html(value: str) -> str:
    match = re.search(r"<body\b[^>]*>([\s\S]*?)</body>", value, re.IGNORECASE)
    return match.group(1) if match else value


def _scope_allows(
    root: str,
    candidate: str,
    *,
    include_subdomains: bool,
    crawl_entire_domain: bool,
) -> bool:
    root_parsed = urlparse(root)
    candidate_parsed = urlparse(candidate)
    root_host = (root_parsed.hostname or "").lower()
    host = (candidate_parsed.hostname or "").lower()
    same_host = host == root_host
    subdomain = include_subdomains and host.endswith("." + root_host)
    if not same_host and not subdomain:
        return False
    if crawl_entire_domain or subdomain:
        return True

    root_path = root_parsed.path or "/"
    candidate_path = candidate_parsed.path or "/"
    if root_path == "/":
        return True
    prefix = root_path.rstrip("/") + "/"
    return candidate_path == root_path or candidate_path.startswith(prefix)


def _metadata(result: Any) -> dict[str, Any]:
    meta = result.metadata
    return {
        "title": meta.title,
        "description": meta.description,
        "language": meta.language,
        "sourceURL": result.url,
        "url": result.canonical_url or result.url,
        "statusCode": result.status_code,
        "contentType": result.content_type,
        "creditsUsed": 0,
        "contentHash": result.content_hash,
        "provider": "nymrel-crawler-mesh",
    }


def _document(result: Any, include_metadata: bool = True) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "markdown": result.markdown,
        "links": [link.href for link in result.links if link.href],
    }
    if include_metadata:
        payload["metadata"] = _metadata(result)
    return payload


def _new_mesh(
    *,
    limit: int,
    max_depth: int,
    resolver: Optional[Callable[[str], Iterable[str]]] = None,
    url_opener: Optional[Callable[..., object]] = None,
) -> CrawlerMesh:
    return CrawlerMesh(
        max_depth=max_depth,
        max_pages=limit,
        max_concurrency=5,
        delay_ms=250,
        timeout_sec=15.0,
        user_agent=USER_AGENT,
        respect_robots=True,
        cache=False,
        include_sitemaps=False,
        allow_private_networks=False,
        resolver=resolver,
        url_opener=url_opener,
    )


def _sitemap_urls(
    root: str,
    mesh: CrawlerMesh,
    *,
    include_subdomains: bool,
    crawl_entire_domain: bool,
    url_opener: Optional[Callable[..., object]],
) -> list[str]:
    parsed = urlparse(root)
    origin = f"{parsed.scheme}://{parsed.netloc}"
    try:
        result = fetch_and_parse_sitemap(
            f"{origin}/sitemap.xml",
            user_agent=USER_AGENT,
            timeout_sec=15.0,
            policy=mesh.network_policy,
            opener=url_opener,
        )
    except Exception:
        return []

    urls: list[str] = []
    for entry in result.urls:
        candidate = _canonical_url(entry.loc)
        if _scope_allows(
            root,
            candidate,
            include_subdomains=include_subdomains,
            crawl_entire_domain=crawl_entire_domain,
        ):
            candidate_allowed = True
            try:
                mesh.network_policy.validate_url(candidate)
            except Exception:
                candidate_allowed = False
            if not candidate_allowed:
                continue
            urls.append(candidate)
    return urls


def _crawl_documents(
    root: str,
    *,
    limit: int,
    max_depth: int,
    include_subdomains: bool,
    crawl_entire_domain: bool,
    use_sitemap: bool,
    resolver: Optional[Callable[[str], Iterable[str]]],
    url_opener: Optional[Callable[..., object]],
) -> list[Any]:
    mesh = _new_mesh(
        limit=limit,
        max_depth=max_depth,
        resolver=resolver,
        url_opener=url_opener,
    )
    # Root rejection is fatal; only later page failures are non-fatal.
    mesh.network_policy.validate_url(root)
    queue: deque[tuple[str, int]] = deque([(_canonical_url(root), 0)])
    queued = {_canonical_url(root)}
    if use_sitemap:
        for candidate in _sitemap_urls(
            root,
            mesh,
            include_subdomains=include_subdomains,
            crawl_entire_domain=crawl_entire_domain,
            url_opener=url_opener,
        ):
            if candidate not in queued:
                queue.append((candidate, 1))
                queued.add(candidate)

    results: list[Any] = []
    visited: set[str] = set()
    while queue and len(results) < limit:
        current, depth = queue.popleft()
        if current in visited:
            continue
        visited.add(current)
        result = None
        try:
            result = mesh.crawl_url_sync(current)
        except Exception:
            result = None
        if result is None:
            continue
        result.depth = depth
        results.append(result)

        if depth >= max_depth:
            continue
        for link in result.links:
            if not link.href:
                continue
            candidate = _canonical_url(link.href)
            if candidate in visited or candidate in queued:
                continue
            if not _scope_allows(
                root,
                candidate,
                include_subdomains=include_subdomains,
                crawl_entire_domain=crawl_entire_domain,
            ):
                continue
            queued.add(candidate)
            queue.append((candidate, depth + 1))
    return results


def execute_crawler(
    args: dict[str, Any],
    *,
    resolver: Optional[Callable[[str], Iterable[str]]] = None,
    url_opener: Optional[Callable[..., object]] = None,
) -> dict[str, Any]:
    """Execute the Python MCP crawler with deterministic injection for tests."""

    try:
        action = args.get("action", "scrape")
        if action not in ("scrape", "map", "crawl"):
            raise ValueError('action must be "scrape", "map", or "crawl"')

        direct_html = args.get("html")
        if direct_html is not None:
            if not isinstance(direct_html, str):
                raise ValueError("html must be a string")
            if action != "scrape":
                raise ValueError('html is supported only with action="scrape"')
            base_url = args.get("url") if isinstance(args.get("url"), str) else None
            source_meta = extract_metadata(direct_html, base_url)
            extraction = extract_markdown(
                _body_html(direct_html),
                base_url=base_url,
                include_frontmatter=False,
                target_main_content=False,
            )
            source_meta.word_count = extraction.metadata.word_count
            source_meta.character_count = extraction.metadata.character_count
            source_meta.reading_time_minutes = extraction.metadata.reading_time_minutes
            source_meta.estimated_tokens = extraction.metadata.estimated_tokens
            raw_tokens = round(len(direct_html) / 4)
            clean_tokens = round(len(extraction.markdown) / 4)
            savings = (
                round(((raw_tokens - clean_tokens) / raw_tokens) * 100)
                if raw_tokens > 0
                else 0
            )
            payload: dict[str, Any] = {
                "action": "scrape",
                "source": "local-html",
                "url": base_url or "local-html-buffer",
                "networkFetchPerformed": False,
                "tokens": {
                    "rawHtmlEstimatedTokens": raw_tokens,
                    "cleanMarkdownTokens": clean_tokens,
                    "tokenSavingsPercent": f"{max(0, savings)}%",
                },
                "markdown": extraction.markdown,
                "text": extraction.text,
                "links": [link.href for link in extraction.links if link.href],
                "tables": [asdict(table) for table in extraction.tables],
                "codeBlocks": [asdict(block) for block in extraction.code_blocks],
                "canonicalCrawlerRepository": CANONICAL_REPOSITORY,
                "canonicalCrawlerMerge": CANONICAL_REVISION,
            }
            if args.get("extractMetadata", True):
                metadata = asdict(source_meta)
                metadata["networkFetchPerformed"] = False
                payload["metadata"] = metadata
            return _ok(payload)

        url = _validated_url(args.get("url"))
        limit = _bounded_int(args.get("limit"), DEFAULT_LIMIT, 1, MAX_LIMIT, "limit")
        max_depth = _bounded_int(
            args.get("maxDepth"),
            DEFAULT_DEPTH,
            0,
            MAX_DEPTH,
            "maxDepth",
        )
        use_sitemap = args.get("sitemap", "include") != "skip"

        if action == "scrape":
            mesh = _new_mesh(
                limit=1,
                max_depth=0,
                resolver=resolver,
                url_opener=url_opener,
            )
            result = mesh.crawl_url_sync(url)
            return _ok(
                {
                    "action": action,
                    "source": "nymrel-crawler-mesh",
                    "networkFetchPerformed": True,
                    "success": True,
                    "data": _document(
                        result,
                        include_metadata=args.get("extractMetadata", True),
                    ),
                    "canonicalCrawlerRepository": CANONICAL_REPOSITORY,
                    "canonicalCrawlerMerge": CANONICAL_REVISION,
                }
            )

        if action == "map":
            results = _crawl_documents(
                url,
                limit=limit,
                max_depth=2,
                include_subdomains=args.get("includeSubdomains", True),
                crawl_entire_domain=True,
                use_sitemap=use_sitemap,
                resolver=resolver,
                url_opener=url_opener,
            )
            search = str(args.get("search", "")).strip().lower()
            found: dict[str, dict[str, str]] = {}
            for result in results:
                candidates = [
                    (
                        _canonical_url(result.url),
                        result.metadata.title,
                        result.metadata.description,
                    )
                ]
                candidates.extend(
                    (_canonical_url(link.href), link.text, "")
                    for link in result.links
                    if link.href
                )
                for candidate, title, description in candidates:
                    if not _scope_allows(
                        url,
                        candidate,
                        include_subdomains=args.get("includeSubdomains", True),
                        crawl_entire_domain=True,
                    ):
                        continue
                    haystack = f"{candidate} {title} {description}".lower()
                    if search and search not in haystack:
                        continue
                    found.setdefault(
                        candidate,
                        {
                            "url": candidate,
                            "title": title,
                            "description": description,
                        },
                    )
                    if len(found) >= limit:
                        break
                if len(found) >= limit:
                    break
            return _ok(
                {
                    "action": action,
                    "source": "nymrel-crawler-mesh",
                    "networkFetchPerformed": True,
                    "success": True,
                    "links": list(found.values())[:limit],
                    "canonicalCrawlerRepository": CANONICAL_REPOSITORY,
                    "canonicalCrawlerMerge": CANONICAL_REVISION,
                }
            )

        results = _crawl_documents(
            url,
            limit=limit,
            max_depth=max_depth,
            include_subdomains=args.get("includeSubdomains", False),
            crawl_entire_domain=args.get("crawlEntireDomain", False),
            use_sitemap=use_sitemap,
            resolver=resolver,
            url_opener=url_opener,
        )
        return _ok(
            {
                "action": action,
                "source": "nymrel-crawler-mesh",
                "networkFetchPerformed": True,
                "success": True,
                "status": "completed",
                "total": len(results),
                "completed": len(results),
                "creditsUsed": 0,
                "data": [
                    _document(
                        result,
                        include_metadata=args.get("extractMetadata", True),
                    )
                    for result in results
                ],
                "canonicalCrawlerRepository": CANONICAL_REPOSITORY,
                "canonicalCrawlerMerge": CANONICAL_REVISION,
            }
        )
    except Exception as error:
        return _error(f"Crawler Mesh request failed: {error}")
