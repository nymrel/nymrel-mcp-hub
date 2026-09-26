/**
 * Firecrawl v2 compatibility facade backed by Nymrel Crawler Mesh.
 * Unsupported cloud-only options fail closed instead of silently changing semantics.
 */

import { CrawlerMesh } from './crawler/mesh.js';
import type { CrawlOptions, CrawlResult } from './types.js';

export type FirecrawlCompatFormat = 'markdown' | 'html' | 'rawHtml' | 'links';

export interface FirecrawlCompatScrapeRequest {
  url: string;
  formats?: Array<FirecrawlCompatFormat | { type: string }>;
  onlyMainContent?: boolean;
  timeout?: number;
}

export interface FirecrawlCompatMapRequest {
  url: string;
  limit?: number;
  search?: string;
  sitemap?: 'include' | 'skip' | 'only';
  includeSubdomains?: boolean;
}

export interface FirecrawlCompatCrawlRequest {
  url: string;
  limit?: number;
  maxDiscoveryDepth?: number;
  crawlEntireDomain?: boolean;
  allowSubdomains?: boolean;
  allowExternalLinks?: boolean;
  sitemap?: 'include' | 'skip' | 'only';
  includePaths?: string[];
  excludePaths?: string[];
  scrapeOptions?: Omit<FirecrawlCompatScrapeRequest, 'url'>;
}

export interface FirecrawlCompatMetadata {
  title: string;
  description: string;
  language?: string;
  sourceURL: string;
  url: string;
  statusCode: number;
  contentType: string;
  creditsUsed: 0;
  contentHash: string;
  provider: 'nymrel-crawler-mesh';
}

export interface FirecrawlCompatDocument {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  metadata: FirecrawlCompatMetadata;
}

export interface FirecrawlCompatScrapeResponse {
  success: true;
  data: FirecrawlCompatDocument;
}

export interface FirecrawlCompatMapLink {
  url: string;
  title: string;
  description: string;
}

export interface FirecrawlCompatMapResponse {
  success: true;
  links: FirecrawlCompatMapLink[];
}

export interface FirecrawlCompatCrawlResponse {
  success: true;
  status: 'completed';
  total: number;
  completed: number;
  creditsUsed: 0;
  data: FirecrawlCompatDocument[];
}

const SUPPORTED_FORMATS = new Set<FirecrawlCompatFormat>(['markdown', 'html', 'rawHtml', 'links']);

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeFormats(formats: FirecrawlCompatScrapeRequest['formats']): FirecrawlCompatFormat[] {
  if (!formats || formats.length === 0) return ['markdown'];
  const normalized: FirecrawlCompatFormat[] = [];
  for (const value of formats) {
    const type = typeof value === 'string' ? value : value?.type;
    if (!SUPPORTED_FORMATS.has(type as FirecrawlCompatFormat)) {
      throw new Error(`Unsupported Firecrawl v2 format: ${String(type)}`);
    }
    normalized.push(type as FirecrawlCompatFormat);
  }
  return [...new Set(normalized)];
}

function childScopeDenyPattern(rawUrl: string): RegExp | null {
  const parsed = new URL(rawUrl);
  const path = parsed.pathname.replace(/\/+$/, '') || '/';
  if (path === '/') return null;
  const origin = escapeRegex(parsed.origin);
  const exact = escapeRegex(path);
  const descendant = escapeRegex(`${path}/`);
  return new RegExp(`^${origin}(?!(?:${exact}(?:[?#]|$)|${descendant}))`);
}

function canonicalKey(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  parsed.hash = '';
  return parsed.toString();
}

function requireRootResult(rootUrl: string, results: CrawlResult[]): void {
  // A filtered map may be empty, but a failed seed acquisition is not success.
  if (!results.some(result => canonicalKey(result.url) === canonicalKey(rootUrl))) {
    throw new Error('CRAWL_ROOT_NOT_ACQUIRED');
  }
}

function inMapScope(root: URL, candidate: URL, includeSubdomains: boolean): boolean {
  const rootHost = root.hostname.toLowerCase().replace(/^www\./, '');
  const host = candidate.hostname.toLowerCase().replace(/^www\./, '');
  return host === rootHost || (includeSubdomains && host.endsWith(`.${rootHost}`));
}

function toDocument(result: CrawlResult, formats: FirecrawlCompatFormat[]): FirecrawlCompatDocument {
  const metadata: FirecrawlCompatMetadata = {
    title: result.metadata.title,
    description: result.metadata.description,
    language: result.metadata.language,
    sourceURL: result.url,
    url: result.canonicalUrl || result.url,
    statusCode: result.statusCode,
    contentType: result.contentType,
    creditsUsed: 0,
    contentHash: result.contentHash,
    provider: 'nymrel-crawler-mesh'
  };
  const document: FirecrawlCompatDocument = { metadata };
  if (formats.includes('markdown')) document.markdown = result.markdown;
  if (formats.includes('html')) document.html = result.html;
  if (formats.includes('rawHtml')) document.rawHtml = result.html;
  if (formats.includes('links')) {
    document.links = [...new Set(result.links.map(link => link.href).filter(Boolean))];
  }
  return document;
}

export class FirecrawlV2Compat {
  private readonly mesh: CrawlerMesh;
  private readonly maxPages: number;

  constructor(options: CrawlOptions = {}) {
    this.maxPages = Math.max(1, options.maxPages ?? 50);
    this.mesh = new CrawlerMesh({ ...options, cache: options.cache ?? false });
  }

  public async scrape(request: FirecrawlCompatScrapeRequest): Promise<FirecrawlCompatScrapeResponse> {
    const formats = normalizeFormats(request.formats);
    const result = await this.mesh.crawlUrl(request.url, {
      timeoutMs: request.timeout,
      cache: false,
      extractorOptions: {
        includeFrontmatter: false,
        targetMainContent: request.onlyMainContent ?? true
      }
    });
    return { success: true, data: toDocument(result, formats) };
  }

  public async map(request: FirecrawlCompatMapRequest): Promise<FirecrawlCompatMapResponse> {
    if (request.sitemap === 'only') {
      throw new Error('Firecrawl sitemap=only is not yet supported by the compatibility facade');
    }
    const limit = Math.max(1, Math.min(request.limit ?? this.maxPages, this.maxPages));
    const includeSubdomains = request.includeSubdomains ?? true;
    const root = new URL(request.url);
    const summary = await this.mesh.crawl(request.url, {
      maxPages: limit,
      maxDepth: 2,
      cache: false,
      includeSitemaps: request.sitemap !== 'skip',
      domainMatchMode: includeSubdomains ? 'subdomains' : 'same-domain',
      extractorOptions: { includeFrontmatter: false, targetMainContent: true }
    });
    requireRootResult(request.url, summary.results);

    const search = (request.search ?? '').trim().toLowerCase();
    const found = new Map<string, FirecrawlCompatMapLink>();
    const add = (url: string, title = '', description = '') => {
      let parsed: URL;
      try {
        parsed = new URL(url, root);
      } catch {
        return;
      }
      if (!inMapScope(root, parsed, includeSubdomains)) return;
      parsed.hash = '';
      const key = canonicalKey(parsed.toString());
      const haystack = `${key} ${title} ${description}`.toLowerCase();
      if (search && !haystack.includes(search)) return;
      if (!found.has(key)) found.set(key, { url: key, title, description });
    };

    for (const result of summary.results) {
      add(result.url, result.metadata.title, result.metadata.description);
      for (const link of result.links) add(link.href, link.text, '');
    }

    return { success: true, links: [...found.values()].slice(0, limit) };
  }

  public async crawl(request: FirecrawlCompatCrawlRequest): Promise<FirecrawlCompatCrawlResponse> {
    if (request.allowExternalLinks) {
      throw new Error('Firecrawl allowExternalLinks is not yet supported by the compatibility facade');
    }
    if (request.sitemap === 'only') {
      throw new Error('Firecrawl sitemap=only is not yet supported by the compatibility facade');
    }
    if ((request.includePaths?.length ?? 0) > 0 || (request.excludePaths?.length ?? 0) > 0) {
      throw new Error('Firecrawl includePaths/excludePaths are not yet supported by the compatibility facade');
    }

    const formats = normalizeFormats(request.scrapeOptions?.formats);
    const limit = Math.max(1, Math.min(request.limit ?? this.maxPages, this.maxPages));
    const deniedPatterns: RegExp[] = [];
    if (!(request.crawlEntireDomain ?? false)) {
      const childOnly = childScopeDenyPattern(request.url);
      if (childOnly) deniedPatterns.push(childOnly);
    }

    const summary = await this.mesh.crawl(request.url, {
      maxPages: limit,
      maxDepth: Math.max(0, request.maxDiscoveryDepth ?? 10),
      cache: false,
      includeSitemaps: request.sitemap !== 'skip',
      domainMatchMode: request.allowSubdomains ? 'subdomains' : 'same-domain',
      deniedPatterns,
      extractorOptions: {
        includeFrontmatter: false,
        targetMainContent: request.scrapeOptions?.onlyMainContent ?? true
      }
    });
    requireRootResult(request.url, summary.results);

    return {
      success: true,
      status: 'completed',
      total: summary.results.length,
      completed: summary.results.length,
      creditsUsed: 0,
      data: summary.results.map(result => toDocument(result, formats))
    };
  }
}
