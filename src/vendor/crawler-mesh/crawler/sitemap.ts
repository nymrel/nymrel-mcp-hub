/**
 * @nymrel/crawler-mesh
 * High-Performance XML Sitemap & Sitemap Index Parser
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import type { SitemapEntry, SitemapResult } from './types.js';
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  fetchWithPolicy,
  readResponseText,
  type NetworkPolicyOptions
} from './network-policy.js';

export function parseSitemapXml(xmlContent: string): SitemapResult {
  const result: SitemapResult = {
    urls: [],
    sitemaps: [],
    errors: []
  };

  // 1. Check for sitemap index (<sitemapindex>)
  if (/<sitemapindex\b/i.test(xmlContent)) {
    const sitemapBlocks = xmlContent.match(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi) || [];
    for (const block of sitemapBlocks) {
      const locMatch = block.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i);
      if (locMatch) {
        const loc = locMatch[1].trim();
        if (loc && !result.sitemaps.includes(loc)) {
          result.sitemaps.push(loc);
        }
      }
    }
  }

  // 2. Check for urlset (<urlset>)
  const urlBlocks = xmlContent.match(/<url\b[^>]*>([\s\S]*?)<\/url>/gi) || [];
  for (const block of urlBlocks) {
    const locMatch = block.match(/<loc\b[^>]*>([\s\S]*?)<\/loc>/i);
    if (!locMatch) continue;

    const loc = locMatch[1].trim();
    if (!loc) continue;

    const lastmodMatch = block.match(/<lastmod\b[^>]*>([\s\S]*?)<\/lastmod>/i);
    const changefreqMatch = block.match(/<changefreq\b[^>]*>([\s\S]*?)<\/changefreq>/i);
    const priorityMatch = block.match(/<priority\b[^>]*>([\s\S]*?)<\/priority>/i);

    const entry: SitemapEntry = {
      loc,
      lastmod: lastmodMatch ? lastmodMatch[1].trim() : undefined,
      changefreq: changefreqMatch ? changefreqMatch[1].trim() : undefined,
      priority: priorityMatch ? parseFloat(priorityMatch[1].trim()) : undefined
    };

    result.urls.push(entry);
  }

  return result;
}

export interface SitemapFetchOptions extends NetworkPolicyOptions {
  userAgent?: string;
  timeoutMs?: number;
  maxDepth?: number;
  maxSitemaps?: number;
  maxUrls?: number;
  fetch?: typeof globalThis.fetch;
}

interface SitemapTraversalState {
  visited: Set<string>;
  seenUrls: Set<string>;
  maxSitemaps: number;
  maxUrls: number;
}

export async function fetchAndParseSitemap(
  sitemapUrl: string,
  options: SitemapFetchOptions = {}
): Promise<SitemapResult> {
  const state: SitemapTraversalState = {
    visited: new Set(),
    seenUrls: new Set(),
    maxSitemaps: Math.max(1, options.maxSitemaps ?? 100),
    maxUrls: Math.max(1, options.maxUrls ?? 50_000)
  };
  return fetchSitemapTree(sitemapUrl, options, state, 0);
}

async function fetchSitemapTree(
  sitemapUrl: string,
  options: SitemapFetchOptions,
  state: SitemapTraversalState,
  currentDepth: number
): Promise<SitemapResult> {
  const result: SitemapResult = {
    urls: [],
    sitemaps: [],
    errors: []
  };

  if (state.visited.has(sitemapUrl) || state.visited.size >= state.maxSitemaps) return result;
  state.visited.add(sitemapUrl);

  try {
    const { response } = await fetchWithPolicy(sitemapUrl, {
      headers: {
        'User-Agent': options.userAgent || 'NymrelCrawlerMesh/1.0 (+https://github.com/nymrel/nymrel-crawler-mesh)',
        'Accept': 'application/xml, text/xml, */*'
      }
    }, options);

    if (!response.ok) {
      await response.body?.cancel();
      result.errors.push(`Sitemap request failed with HTTP ${response.status}`);
      return result;
    }

    const xml = await readResponseText(
      response,
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
    );
    const parsed = parseSitemapXml(xml);

    for (const entry of parsed.urls) {
      if (state.seenUrls.size >= state.maxUrls) break;
      if (state.seenUrls.has(entry.loc)) continue;
      state.seenUrls.add(entry.loc);
      result.urls.push(entry);
    }
    const remainingSitemaps = Math.max(0, state.maxSitemaps - state.visited.size);
    const childSitemaps = parsed.sitemaps.slice(0, remainingSitemaps);
    result.sitemaps.push(...childSitemaps);

    // Recursively parse child sitemaps if under maxDepth
    if (childSitemaps.length > 0 && currentDepth < (options.maxDepth ?? 2)) {
      const childResults = await Promise.all(
        childSitemaps.map(child => fetchSitemapTree(child, options, state, currentDepth + 1))
      );
      for (const childResult of childResults) {
        result.urls.push(...childResult.urls);
        result.errors.push(...childResult.errors);
      }
    }
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.name : 'UnknownError';
    result.errors.push(`Sitemap request failed: ${reason}`);
  }

  return result;
}
