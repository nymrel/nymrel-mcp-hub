"""
nymrel_crawler_mesh.sitemap
XML Sitemap & Sitemap Index Parser
Copyright (c) 2026 Nymrel / JalenBuilds LLC
"""

import re
from typing import Optional

from .models import SitemapEntry, SitemapResult
from .network_policy import NetworkPolicy, UrlOpener, fetch_http_text


def parse_sitemap_xml(xml_content: str) -> SitemapResult:
    result = SitemapResult()

    # 1. Check for sitemapindex
    if re.search(r"<sitemapindex\b", xml_content, re.IGNORECASE):
        sitemap_blocks = re.findall(r"<sitemap\b[^>]*>(.*?)</sitemap>", xml_content, re.IGNORECASE | re.DOTALL)
        for block in sitemap_blocks:
            loc_match = re.search(r"<loc\b[^>]*>(.*?)</loc>", block, re.IGNORECASE | re.DOTALL)
            if loc_match:
                loc = loc_match.group(1).strip()
                if loc and loc not in result.sitemaps:
                    result.sitemaps.append(loc)

    # 2. Check for urlset
    url_blocks = re.findall(r"<url\b[^>]*>(.*?)</url>", xml_content, re.IGNORECASE | re.DOTALL)
    for block in url_blocks:
        loc_match = re.search(r"<loc\b[^>]*>(.*?)</loc>", block, re.IGNORECASE | re.DOTALL)
        if not loc_match:
            continue

        loc = loc_match.group(1).strip()
        if not loc:
            continue

        lastmod_match = re.search(r"<lastmod\b[^>]*>(.*?)</lastmod>", block, re.IGNORECASE | re.DOTALL)
        changefreq_match = re.search(r"<changefreq\b[^>]*>(.*?)</changefreq>", block, re.IGNORECASE | re.DOTALL)
        priority_match = re.search(r"<priority\b[^>]*>(.*?)</priority>", block, re.IGNORECASE | re.DOTALL)

        priority = None
        if priority_match:
            try:
                priority = float(priority_match.group(1).strip())
            except ValueError:
                pass

        entry = SitemapEntry(
            loc=loc,
            lastmod=lastmod_match.group(1).strip() if lastmod_match else None,
            changefreq=changefreq_match.group(1).strip() if changefreq_match else None,
            priority=priority,
        )
        result.urls.append(entry)

    return result


def fetch_and_parse_sitemap(
    sitemap_url: str,
    user_agent: str = "NymrelCrawlerMesh/1.0 (+https://github.com/nymrel/nymrel-crawler-mesh)",
    timeout_sec: float = 15.0,
    max_depth: int = 2,
    current_depth: int = 0,
    max_sitemaps: int = 100,
    max_urls: int = 50_000,
    policy: Optional[NetworkPolicy] = None,
    opener: Optional[UrlOpener] = None,
) -> SitemapResult:
    active_policy = policy or NetworkPolicy()
    visited = set()
    seen_urls = set()

    def walk(url: str, depth: int) -> SitemapResult:
        result = SitemapResult()
        if url in visited or len(visited) >= max(1, max_sitemaps):
            return result
        visited.add(url)

        try:
            document = fetch_http_text(
                url,
                headers={
                    "User-Agent": user_agent,
                    "Accept": "application/xml, text/xml, */*",
                },
                timeout_sec=timeout_sec,
                policy=active_policy,
                opener=opener,
            )
            if not 200 <= document.status < 300:
                result.errors.append(f"Sitemap request failed with HTTP {document.status}")
                return result

            parsed = parse_sitemap_xml(document.text)
            for entry in parsed.urls:
                if len(seen_urls) >= max(1, max_urls):
                    break
                if entry.loc in seen_urls:
                    continue
                seen_urls.add(entry.loc)
                result.urls.append(entry)
            remaining_sitemaps = max(0, max_sitemaps - len(visited))
            child_sitemaps = parsed.sitemaps[:remaining_sitemaps]
            result.sitemaps.extend(child_sitemaps)

            if child_sitemaps and depth < max_depth:
                for child_sitemap in child_sitemaps:
                    child_result = walk(child_sitemap, depth + 1)
                    result.urls.extend(child_result.urls)
                    result.errors.extend(child_result.errors)
        except Exception as error:
            result.errors.append(f"Sitemap request failed: {type(error).__name__}")

        return result

    return walk(sitemap_url, current_depth)
