"""
nymrel_crawler_mesh.models
Core Data Models and Type Definitions
Copyright (c) 2026 Nymrel / JalenBuilds LLC
"""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class DocumentMetadata:
    title: str = ""
    description: str = ""
    canonical: Optional[str] = None
    author: Optional[str] = None
    published_time: Optional[str] = None
    modified_time: Optional[str] = None
    language: Optional[str] = None
    open_graph: Dict[str, str] = field(default_factory=dict)
    twitter_card: Dict[str, str] = field(default_factory=dict)
    keywords: List[str] = field(default_factory=list)
    word_count: int = 0
    character_count: int = 0
    reading_time_minutes: int = 0
    estimated_tokens: int = 0


@dataclass
class DiscoveredLink:
    href: str
    text: str = ""
    is_internal: bool = False
    rel: Optional[str] = None


@dataclass
class DiscoveredImage:
    src: str
    alt: str = ""
    title: Optional[str] = None


@dataclass
class ExtractedTable:
    headers: List[str] = field(default_factory=list)
    rows: List[List[str]] = field(default_factory=list)
    caption: Optional[str] = None


@dataclass
class ExtractedCodeBlock:
    language: str
    code: str


@dataclass
class ExtractionResult:
    markdown: str
    text: str
    metadata: DocumentMetadata
    links: List[DiscoveredLink] = field(default_factory=list)
    images: List[DiscoveredImage] = field(default_factory=list)
    tables: List[ExtractedTable] = field(default_factory=list)
    code_blocks: List[ExtractedCodeBlock] = field(default_factory=list)
    headings: List[Dict[str, Any]] = field(default_factory=list)


@dataclass
class CrawlResult:
    url: str
    status_code: int
    status_text: str
    headers: Dict[str, str]
    content_type: str
    from_cache: bool
    content_hash: str
    duration_ms: float
    depth: int
    markdown: str
    text: str
    html: str
    metadata: DocumentMetadata
    links: List[DiscoveredLink] = field(default_factory=list)
    images: List[DiscoveredImage] = field(default_factory=list)
    tables: List[ExtractedTable] = field(default_factory=list)
    code_blocks: List[ExtractedCodeBlock] = field(default_factory=list)
    canonical_url: Optional[str] = None
    error: Optional[str] = None


@dataclass
class SitemapEntry:
    loc: str
    lastmod: Optional[str] = None
    changefreq: Optional[str] = None
    priority: Optional[float] = None


@dataclass
class SitemapResult:
    urls: List[SitemapEntry] = field(default_factory=list)
    sitemaps: List[str] = field(default_factory=list)
    errors: List[str] = field(default_factory=list)


@dataclass
class CrawlSummary:
    start_url: str
    total_crawled: int
    total_queued: int
    total_cached: int
    total_errors: int
    duration_ms: float
    results: List[CrawlResult] = field(default_factory=list)


@dataclass
class BenchmarkResult:
    target_url: str
    total_requests: int
    successful_requests: int
    failed_requests: int
    total_duration_ms: float
    requests_per_second: float
    avg_latency_ms: float
    min_latency_ms: float
    max_latency_ms: float
    p95_latency_ms: float
    avg_markdown_extraction_ms: float
    total_bytes_downloaded: int
    cache_hit_rate: float
