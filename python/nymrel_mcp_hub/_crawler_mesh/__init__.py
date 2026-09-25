"""
nymrel-crawler-mesh
Zero-Telemetry High-Throughput Web Crawler & Markdown/JSON Extractor for AI Agents
Copyright (c) 2026 Nymrel / JalenBuilds LLC
"""

from typing import Any

from .cache import ContentCache
from .crawler import CrawlerMesh
from .extractor import clean_html, extract_markdown, extract_metadata
from .models import (
    BenchmarkResult,
    CrawlResult,
    CrawlSummary,
    DiscoveredImage,
    DiscoveredLink,
    DocumentMetadata,
    ExtractedCodeBlock,
    ExtractedTable,
    ExtractionResult,
    SitemapEntry,
    SitemapResult,
)
from .queue import CrawlQueue
from .rate_limiter import PoliteRateLimiter
from .robots import RobotsParser
from .sitemap import fetch_and_parse_sitemap, parse_sitemap_xml
from .network_policy import CrawlerSecurityError, NetworkPolicy

__version__ = "1.0.0"
__author__ = "Nymrel / JalenBuilds LLC <contact@nymrel.com>"

__all__ = [
    "CrawlerMesh",
    "RobotsParser",
    "ContentCache",
    "PoliteRateLimiter",
    "CrawlQueue",
    "crawl_url",
    "extract_markdown",
    "extract_metadata",
    "clean_html",
    "parse_sitemap",
    "fetch_and_parse_sitemap",
    "CrawlResult",
    "ExtractionResult",
    "DocumentMetadata",
    "DiscoveredLink",
    "DiscoveredImage",
    "ExtractedTable",
    "ExtractedCodeBlock",
    "SitemapEntry",
    "SitemapResult",
    "CrawlSummary",
    "BenchmarkResult",
    "CrawlerSecurityError",
    "NetworkPolicy",
]


def crawl_url(url: str, **kwargs: Any) -> CrawlResult:
    """Convenience synchronous function to crawl and extract markdown from a single URL."""
    mesh = CrawlerMesh(**kwargs)
    return mesh.crawl_url_sync(url)


def parse_sitemap(xml_content: str) -> SitemapResult:
    """Convenience function to parse XML sitemap string."""
    return parse_sitemap_xml(xml_content)
