"""
nymrel_crawler_mesh.crawler
High-Throughput Web Crawler Engine
Copyright (c) 2026 Nymrel / JalenBuilds LLC
"""

import asyncio
import time
from typing import Any, Callable, Dict, List, Optional, Union
from urllib.parse import urlparse

from .cache import ContentCache, compute_sha256
from .extractor import extract_markdown
from .models import (
    BenchmarkResult,
    CrawlResult,
    CrawlSummary,
    DocumentMetadata,
)
from .queue import CrawlQueue, QueueItem
from .rate_limiter import PoliteRateLimiter, extract_domain
from .robots import RobotsParser
from .sitemap import fetch_and_parse_sitemap
from .network_policy import NetworkPolicy, Resolver, UrlOpener, fetch_http_text


class CrawlerMesh:
    def __init__(
        self,
        max_depth: int = 2,
        max_pages: int = 50,
        max_concurrency: int = 5,
        delay_ms: int = 250,
        timeout_sec: float = 15.0,
        user_agent: str = "NymrelCrawlerMesh/1.0 (+https://github.com/nymrel/nymrel-crawler-mesh; AI Data Engine)",
        respect_robots: bool = True,
        cache: bool = True,
        cache_dir: str = ".crawler-cache",
        cache_ttl_sec: int = 86400,
        domain_match_mode: str = "same-domain",
        allowed_domains: Optional[List[str]] = None,
        denied_patterns: Optional[List[Union[str, Any]]] = None,
        include_sitemaps: bool = False,
        headers: Optional[Dict[str, str]] = None,
        allow_private_networks: bool = False,
        max_response_bytes: int = 10 * 1024 * 1024,
        max_redirects: int = 5,
        resolver: Optional[Resolver] = None,
        url_opener: Optional[UrlOpener] = None,
    ):
        self.max_depth = max_depth
        self.max_pages = max_pages
        self.max_concurrency = max_concurrency
        self.delay_ms = delay_ms
        self.timeout_sec = timeout_sec
        self.user_agent = user_agent
        self.respect_robots = respect_robots
        self.include_sitemaps = include_sitemaps
        self.domain_match_mode = domain_match_mode
        self.allowed_domains = allowed_domains or []
        self.denied_patterns = denied_patterns or []
        self.headers = headers or {}
        policy_args: Dict[str, Any] = {
            "allow_private_networks": allow_private_networks,
            "max_response_bytes": max_response_bytes,
            "max_redirects": max_redirects,
        }
        if resolver is not None:
            policy_args["resolver"] = resolver
        self.network_policy = NetworkPolicy(**policy_args)
        self.url_opener = url_opener

        self.cache = ContentCache(
            enabled=cache,
            cache_dir=cache_dir,
            ttl_seconds=cache_ttl_sec,
        )
        self.rate_limiter = PoliteRateLimiter(
            default_delay_ms=delay_ms,
            max_concurrency_per_domain=max_concurrency,
        )
        self.robots_cache: Dict[str, RobotsParser] = {}
        self._robots_locks: Dict[str, asyncio.Lock] = {}

    async def _get_robots_parser(self, url_str: str) -> Optional[RobotsParser]:
        """Resolve the robots.txt parser for a URL without blocking the event loop."""
        if not self.respect_robots:
            return None

        try:
            parsed = urlparse(url_str)
            origin = f"{parsed.scheme}://{parsed.netloc}"
        except Exception:
            return None

        if origin in self.robots_cache:
            return self.robots_cache[origin]

        # Serialize per-origin so concurrent tasks share one fetch (cache semantics).
        lock = self._robots_locks.get(origin)
        if lock is None:
            lock = asyncio.Lock()
            self._robots_locks[origin] = lock

        async with lock:
            if origin in self.robots_cache:
                return self.robots_cache[origin]
            # Blocking network I/O and parsing run on a worker thread. Shared
            # crawler state is updated back on the event-loop thread.
            parser, crawl_delay = await asyncio.to_thread(
                self._fetch_robots_parser, origin
            )
            if crawl_delay is not None and crawl_delay > 0:
                self.rate_limiter.set_domain_delay(extract_domain(url_str), crawl_delay)
            self.robots_cache[origin] = parser
            return parser

    def _fetch_robots_parser(self, origin: str) -> tuple[RobotsParser, Optional[float]]:
        """Synchronous robots.txt fetch/parse; must only run off the event loop."""
        robots_url = f"{origin}/robots.txt"
        parser = RobotsParser()
        crawl_delay: Optional[float] = None
        try:
            robots_policy = NetworkPolicy(
                allow_private_networks=self.network_policy.allow_private_networks,
                max_response_bytes=min(self.network_policy.max_response_bytes, 1024 * 1024),
                max_redirects=self.network_policy.max_redirects,
                resolver=self.network_policy.resolver,
            )
            document = fetch_http_text(
                robots_url,
                headers={"User-Agent": self.user_agent},
                timeout_sec=min(self.timeout_sec, 5.0),
                policy=robots_policy,
                opener=self.url_opener,
            )
            if 200 <= document.status < 300:
                parser.parse(document.text)
                crawl_delay = parser.get_crawl_delay(self.user_agent)
        except Exception:
            pass

        return parser, crawl_delay

    async def crawl_url(
        self,
        raw_url: str,
        timeout_sec: Optional[float] = None,
        use_cache: Optional[bool] = None,
        respect_robots: Optional[bool] = None,
    ) -> CrawlResult:
        start_time = time.time()
        timeout = timeout_sec if timeout_sec is not None else self.timeout_sec
        should_cache = use_cache if use_cache is not None else self.cache.enabled
        check_robots = respect_robots if respect_robots is not None else self.respect_robots

        await asyncio.to_thread(self.network_policy.validate_url, raw_url)

        # 1. Robots.txt check
        if check_robots:
            robots = await self._get_robots_parser(raw_url)
            if robots and not robots.is_allowed(raw_url, self.user_agent):
                raise PermissionError("Crawl disallowed by robots.txt")

        # 2. Cache check
        if should_cache:
            cached = await asyncio.to_thread(self.cache.get, raw_url)
            if cached:
                meta = cached.get("metadata", {})
                doc_meta = DocumentMetadata(**meta) if isinstance(meta, dict) else DocumentMetadata()
                return CrawlResult(
                    url=cached["url"],
                    status_code=cached["status_code"],
                    status_text=cached.get("status_text", "OK"),
                    headers=cached.get("headers", {}),
                    content_type=cached.get("content_type", "text/html"),
                    from_cache=True,
                    content_hash=cached.get("hash", ""),
                    duration_ms=(time.time() - start_time) * 1000.0,
                    depth=0,
                    markdown=cached.get("markdown", ""),
                    text=cached.get("text", ""),
                    html=cached.get("html", ""),
                    metadata=doc_meta,
                    canonical_url=doc_meta.canonical,
                )

        # 3. Rate limiter acquire
        await self.rate_limiter.acquire(raw_url)

        req_headers = {
            "User-Agent": self.user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            **self.headers,
        }
        if should_cache:
            req_headers.update(await asyncio.to_thread(self.cache.get_conditional_headers, raw_url))

        status_code = 0
        status_text = ""
        resp_headers: Dict[str, str] = {}
        html = ""
        final_url = raw_url

        try:
            document = await asyncio.to_thread(
                fetch_http_text,
                raw_url,
                headers=req_headers,
                timeout_sec=timeout,
                policy=self.network_policy,
                opener=self.url_opener,
            )
            status_code = document.status
            status_text = document.reason
            resp_headers = document.headers
            html = document.text
            final_url = document.final_url

            if status_code == 304:
                cached = await asyncio.to_thread(self.cache.get, raw_url)
                if cached:
                    self.rate_limiter.release(raw_url, status_code)
                    meta = cached.get("metadata", {})
                    doc_meta = DocumentMetadata(**meta) if isinstance(meta, dict) else DocumentMetadata()
                    return CrawlResult(
                        url=raw_url,
                        status_code=200,
                        status_text="OK (304 Not Modified)",
                        headers=resp_headers,
                        content_type=cached.get("content_type", "text/html"),
                        from_cache=True,
                        content_hash=cached.get("hash", ""),
                        duration_ms=(time.time() - start_time) * 1000.0,
                        depth=0,
                        markdown=cached.get("markdown", ""),
                        text=cached.get("text", ""),
                        html=cached.get("html", ""),
                        metadata=doc_meta,
                        canonical_url=doc_meta.canonical,
                    )
            if status_code >= 400:
                raise RuntimeError(f"Crawler request failed with HTTP {status_code}")
            self.rate_limiter.release(raw_url, status_code)
        except Exception as err:
            self.rate_limiter.release(raw_url, status_code or 500)
            raise err

        # 4. Extract
        extraction = await asyncio.to_thread(extract_markdown, html, base_url=final_url)
        duration_ms = (time.time() - start_time) * 1000.0
        cache_data = {
            "status_code": status_code,
            "status_text": status_text,
            "headers": resp_headers,
            "content_type": resp_headers.get("content-type", "text/html"),
            "html": html,
            "markdown": extraction.markdown,
            "text": extraction.text,
            "metadata": extraction.metadata.__dict__,
            "etag": resp_headers.get("etag"),
            "last_modified": resp_headers.get("last-modified"),
        }
        if should_cache:
            cache_entry = await asyncio.to_thread(self.cache.set, raw_url, cache_data)
            content_hash = cache_entry.get("hash", "")
        else:
            content_hash = compute_sha256(html)

        return CrawlResult(
            url=raw_url,
            status_code=status_code,
            status_text=status_text,
            headers=resp_headers,
            content_type=resp_headers.get("content-type", "text/html"),
            from_cache=False,
            content_hash=content_hash,
            duration_ms=duration_ms,
            depth=0,
            markdown=extraction.markdown,
            text=extraction.text,
            html=html,
            metadata=extraction.metadata,
            links=extraction.links,
            images=extraction.images,
            tables=extraction.tables,
            code_blocks=extraction.code_blocks,
            canonical_url=extraction.metadata.canonical,
        )

    async def crawl(
        self,
        start_url: Union[str, List[str]],
        max_depth: Optional[int] = None,
        max_pages: Optional[int] = None,
        on_page: Optional[Callable[[CrawlResult], None]] = None,
    ) -> CrawlSummary:
        start_time = time.time()
        start_urls = [start_url] if isinstance(start_url, str) else list(start_url)
        eff_max_depth = max_depth if max_depth is not None else self.max_depth
        eff_max_pages = max_pages if max_pages is not None else self.max_pages

        start_domains = []
        for u in start_urls:
            try:
                host = urlparse(u).hostname
                if host:
                    start_domains.append(host)
            except Exception:
                pass

        queue = CrawlQueue(
            start_domains=start_domains,
            domain_match_mode=self.domain_match_mode,
            allowed_domains=self.allowed_domains,
            denied_patterns=self.denied_patterns,
            max_depth=eff_max_depth,
        )

        for u in start_urls:
            queue.enqueue(QueueItem(url=u, depth=0))

        if self.include_sitemaps:
            sitemap_jobs = []
            for u in start_urls:
                try:
                    origin = f"{urlparse(u).scheme}://{urlparse(u).netloc}"
                    sitemap_jobs.append(
                        asyncio.to_thread(
                            fetch_and_parse_sitemap,
                            f"{origin}/sitemap.xml",
                            user_agent=self.user_agent,
                            timeout_sec=self.timeout_sec,
                            policy=self.network_policy,
                            opener=self.url_opener,
                        )
                    )
                except Exception:
                    pass

            if sitemap_jobs:
                # Fetch/parse off the event loop; independent origins overlap.
                sitemap_results = await asyncio.gather(*sitemap_jobs, return_exceptions=True)
                for sitemap_res in sitemap_results:
                    try:
                        if isinstance(sitemap_res, BaseException):
                            raise sitemap_res
                        for entry in sitemap_res.urls:
                            queue.enqueue(QueueItem(url=entry.loc, depth=1))
                    except Exception:
                        pass

        results: List[CrawlResult] = []
        cached_count = 0
        error_count = 0
        reserved_pages = 0

        async def worker():
            nonlocal cached_count, error_count, reserved_pages
            while not queue.is_empty() and reserved_pages < eff_max_pages:
                item = queue.dequeue()
                if not item:
                    break

                if queue.has_visited(item.url):
                    continue

                queue.mark_visited(item.url)
                reserved_pages += 1

                try:
                    res = await self.crawl_url(item.url)
                    res.depth = item.depth
                    results.append(res)
                    if res.from_cache:
                        cached_count += 1

                    if on_page:
                        on_page(res)

                    if item.depth < eff_max_depth:
                        for link in res.links:
                            if link.is_internal and link.href:
                                queue.enqueue(QueueItem(url=link.href, depth=item.depth + 1, referrer=item.url))
                except Exception:
                    error_count += 1

        workers = [worker() for _ in range(self.max_concurrency)]
        await asyncio.gather(*workers)

        return CrawlSummary(
            start_url=start_urls[0] if start_urls else "",
            total_crawled=len(results),
            total_queued=queue.size() + len(results),
            total_cached=cached_count,
            total_errors=error_count,
            duration_ms=(time.time() - start_time) * 1000.0,
            results=results,
        )

    def crawl_sync(self, start_url: Union[str, List[str]], **kwargs: Any) -> CrawlSummary:
        return asyncio.run(self.crawl(start_url, **kwargs))

    def crawl_url_sync(self, raw_url: str, **kwargs: Any) -> CrawlResult:
        return asyncio.run(self.crawl_url(raw_url, **kwargs))

    async def benchmark(self, target_url: str, count: int = 20, concurrency: int = 5) -> BenchmarkResult:
        latencies: List[float] = []
        extraction_times: List[float] = []
        success_count = 0
        fail_count = 0
        total_bytes = 0
        cache_hits = 0

        start_bench = time.time()
        if count <= 0 or concurrency <= 0:
            raise ValueError("Benchmark count and concurrency must be positive")

        next_index = 0

        async def run_worker():
            nonlocal next_index
            nonlocal success_count, fail_count, total_bytes, cache_hits
            while True:
                idx = next_index
                next_index += 1
                if idx >= count:
                    return
                t0 = time.time()
                try:
                    res = await self.crawl_url(target_url, use_cache=idx > 0)
                    lat = (time.time() - t0) * 1000.0
                    latencies.append(lat)
                    extraction_times.append(res.duration_ms)
                    total_bytes += len(res.html)
                    if res.from_cache:
                        cache_hits += 1
                    success_count += 1
                except Exception:
                    fail_count += 1

        workers = [run_worker() for _ in range(min(count, concurrency))]
        await asyncio.gather(*workers)

        total_duration_ms = max(1.0, (time.time() - start_bench) * 1000.0)
        latencies.sort()

        avg_lat = sum(latencies) / len(latencies) if latencies else 0.0
        min_lat = latencies[0] if latencies else 0.0
        max_lat = latencies[-1] if latencies else 0.0
        p95_idx = int(len(latencies) * 0.95)
        p95_lat = latencies[p95_idx] if latencies else max_lat
        avg_extract = sum(extraction_times) / len(extraction_times) if extraction_times else 0.0

        return BenchmarkResult(
            target_url=target_url,
            total_requests=count,
            successful_requests=success_count,
            failed_requests=fail_count,
            total_duration_ms=round(total_duration_ms, 2),
            requests_per_second=round((count / (total_duration_ms / 1000.0)), 2),
            avg_latency_ms=round(avg_lat, 2),
            min_latency_ms=round(min_lat, 2),
            max_latency_ms=round(max_lat, 2),
            p95_latency_ms=round(p95_lat, 2),
            avg_markdown_extraction_ms=round(avg_extract, 2),
            total_bytes_downloaded=total_bytes,
            cache_hit_rate=round((cache_hits / count) * 100.0, 1),
        )

    def clear_cache(self) -> None:
        self.cache.clear()
