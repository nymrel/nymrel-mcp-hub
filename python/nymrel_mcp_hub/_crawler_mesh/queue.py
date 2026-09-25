"""
nymrel_crawler_mesh.queue
Deduplicated Crawl Queue and Domain Filter
Copyright (c) 2026 Nymrel / JalenBuilds LLC
"""

from collections import deque
from dataclasses import dataclass
from typing import Any, Deque, List, Optional, Set, Union
from urllib.parse import urlparse

from .cache import normalize_url_key


@dataclass
class QueueItem:
    url: str
    depth: int
    referrer: Optional[str] = None
    retry_count: int = 0


def is_url_allowed(
    url_str: str,
    start_domains: List[str],
    mode: str = "same-domain",
    allowed_domains: Optional[List[str]] = None,
    denied_patterns: Optional[List[Union[str, Any]]] = None,
) -> bool:
    try:
        parsed = urlparse(url_str)
    except Exception:
        return False

    if parsed.scheme not in ("http", "https"):
        return False

    pathname = parsed.path.lower()
    ignored_extensions = [
        ".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico",
        ".pdf", ".zip", ".tar", ".gz", ".mp3", ".mp4", ".avi", ".mov",
        ".css", ".js", ".woff", ".woff2", ".ttf", ".eot",
    ]
    if any(pathname.endswith(ext) for ext in ignored_extensions):
        return False

    if denied_patterns:
        for p in denied_patterns:
            if isinstance(p, str) and p in url_str:
                return False

    hostname = (parsed.hostname or "").lower()

    if allowed_domains:
        return any(d.lower() == hostname or hostname.endswith("." + d.lower()) for d in allowed_domains)

    if mode == "any":
        return True

    if not start_domains:
        return True

    if mode == "same-domain":
        clean_host = hostname[4:] if hostname.startswith("www.") else hostname
        for start_domain in start_domains:
            clean_start = start_domain.lower()[4:] if start_domain.lower().startswith("www.") else start_domain.lower()
            if clean_host == clean_start:
                return True
        return False

    if mode == "subdomains":
        clean_host = hostname[4:] if hostname.startswith("www.") else hostname
        for start_domain in start_domains:
            clean_start = start_domain.lower()[4:] if start_domain.lower().startswith("www.") else start_domain.lower()
            if clean_host == clean_start or clean_host.endswith("." + clean_start):
                return True
        return False

    return True


class CrawlQueue:
    def __init__(
        self,
        start_domains: Optional[List[str]] = None,
        domain_match_mode: str = "same-domain",
        allowed_domains: Optional[List[str]] = None,
        denied_patterns: Optional[List[Union[str, Any]]] = None,
        max_depth: int = 2,
    ):
        self.start_domains = [d.lower() for d in (start_domains or [])]
        self.domain_match_mode = domain_match_mode
        self.allowed_domains = allowed_domains or []
        self.denied_patterns = denied_patterns or []
        self.max_depth = max_depth

        self.queue: Deque[QueueItem] = deque()
        self.enqueued_urls: Set[str] = set()
        self.visited_urls: Set[str] = set()

    def set_start_domains(self, domains: List[str]) -> None:
        self.start_domains = [d.lower() for d in domains]

    def enqueue(self, item: QueueItem) -> bool:
        normalized = normalize_url_key(item.url)
        if normalized in self.enqueued_urls or normalized in self.visited_urls:
            return False

        if item.depth > self.max_depth:
            return False

        if not is_url_allowed(
            item.url,
            self.start_domains,
            self.domain_match_mode,
            self.allowed_domains,
            self.denied_patterns,
        ):
            return False

        self.enqueued_urls.add(normalized)
        self.queue.append(item)
        return True

    def dequeue(self) -> Optional[QueueItem]:
        if not self.queue:
            return None
        return self.queue.popleft()

    def mark_visited(self, url: str) -> None:
        normalized = normalize_url_key(url)
        self.visited_urls.add(normalized)

    def has_visited(self, url: str) -> bool:
        normalized = normalize_url_key(url)
        return normalized in self.visited_urls

    def is_empty(self) -> bool:
        return len(self.queue) == 0

    def size(self) -> int:
        return len(self.queue)

    def visited_count(self) -> int:
        return len(self.visited_urls)

    def clear(self) -> None:
        self.queue.clear()
        self.enqueued_urls.clear()
        self.visited_urls.clear()
