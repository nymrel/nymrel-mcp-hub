/**
 * @nymrel/crawler-mesh
 * Core Type Definitions
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

export interface CrawlOptions {
  /** Maximum crawling depth (0 = start url only). Default: 2 */
  maxDepth?: number;
  /** Maximum number of total pages to crawl. Default: 50 */
  maxPages?: number;
  /** Maximum concurrent requests. Default: 5 */
  maxConcurrency?: number;
  /** Delay in milliseconds between requests to the same domain. Default: 250 */
  delayMs?: number;
  /** Request timeout in milliseconds. Default: 15000 */
  timeoutMs?: number;
  /** Custom User-Agent string. Default: NymrelCrawlerMesh/1.0 AI Data Engine */
  userAgent?: string;
  /** Whether to respect robots.txt rules. Default: true */
  respectRobots?: boolean;
  /** Enable content-hash caching. Default: true */
  cache?: boolean;
  /** Cache storage directory for filesystem cache. Default: .crawler-cache */
  cacheDir?: string;
  /** Cache TTL in seconds. Default: 86400 (24h) */
  cacheTtl?: number;
  /** Allowed domain matching mode: 'same-domain' | 'subdomains' | 'any'. Default: 'same-domain' */
  domainMatchMode?: 'same-domain' | 'subdomains' | 'any';
  /** Explicit whitelist of allowed domains */
  allowedDomains?: string[];
  /** Blacklist of domains or URL regexes to ignore */
  deniedPatterns?: (string | RegExp)[];
  /** Whether to automatically discover and parse sitemaps. Default: false */
  includeSitemaps?: boolean;
  /** Options passed to the HTML-to-Markdown extractor */
  extractorOptions?: ExtractorOptions;
  /** Extra HTTP request headers */
  headers?: Record<string, string>;
  /** Custom fetch implementation */
  fetch?: typeof globalThis.fetch;
  /** Allow private, loopback, link-local, and other non-global targets. Default: false */
  allowPrivateNetworks?: boolean;
  /** Maximum response body size in bytes. Default: 10485760 (10 MiB) */
  maxResponseBytes?: number;
  /** Maximum redirects followed after validating every destination. Default: 5 */
  maxRedirects?: number;
  /** Resolver override for deterministic tests and controlled runtimes */
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

export interface SingleCrawlOptions {
  timeoutMs?: number;
  userAgent?: string;
  respectRobots?: boolean;
  cache?: boolean;
  cacheDir?: string;
  cacheTtl?: number;
  headers?: Record<string, string>;
  extractorOptions?: ExtractorOptions;
  fetch?: typeof globalThis.fetch;
  allowPrivateNetworks?: boolean;
  maxResponseBytes?: number;
  maxRedirects?: number;
  resolveHostname?: (hostname: string) => Promise<string[]>;
}

export interface CrawlResult {
  url: string;
  canonicalUrl?: string;
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  contentType: string;
  fromCache: boolean;
  contentHash: string;
  durationMs: number;
  depth: number;
  markdown: string;
  text: string;
  html: string;
  metadata: DocumentMetadata;
  links: DiscoveredLink[];
  images: DiscoveredImage[];
  tables: ExtractedTable[];
  codeBlocks: ExtractedCodeBlock[];
  error?: string;
}

export interface DocumentMetadata {
  title: string;
  description: string;
  canonical?: string;
  author?: string;
  publishedTime?: string;
  modifiedTime?: string;
  language?: string;
  openGraph: Record<string, string>;
  twitterCard: Record<string, string>;
  keywords: string[];
  wordCount: number;
  characterCount: number;
  readingTimeMinutes: number;
  estimatedTokens: number;
}

export interface DiscoveredLink {
  href: string;
  text: string;
  isInternal: boolean;
  rel?: string;
}

export interface DiscoveredImage {
  src: string;
  alt: string;
  title?: string;
}

export interface ExtractedTable {
  headers: string[];
  rows: string[][];
  caption?: string;
}

export interface ExtractedCodeBlock {
  language: string;
  code: string;
}

export interface ExtractorOptions {
  /** Include YAML frontmatter in generated markdown. Default: true */
  includeFrontmatter?: boolean;
  /** Remove hyperlinks from markdown output, keeping only anchor text. Default: false */
  stripLinks?: boolean;
  /** Remove images from markdown output. Default: false */
  stripImages?: boolean;
  /** Keep original HTML tables instead of converting to Markdown tables. Default: false */
  rawHtmlTables?: boolean;
  /** Custom list of CSS classes/IDs to remove */
  customRemoveSelectors?: string[];
  /** Base URL for resolving relative links */
  baseUrl?: string;
  /** Target main content container only (article, main, #content). Default: true */
  targetMainContent?: boolean;
}

export interface ExtractionResult {
  markdown: string;
  text: string;
  metadata: DocumentMetadata;
  links: DiscoveredLink[];
  images: DiscoveredImage[];
  tables: ExtractedTable[];
  codeBlocks: ExtractedCodeBlock[];
  headings: { level: number; text: string; id?: string }[];
}

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq?: string;
  priority?: number;
}

export interface SitemapResult {
  urls: SitemapEntry[];
  sitemaps: string[];
  errors: string[];
}

export interface CrawlProgress {
  crawledCount: number;
  queuedCount: number;
  cachedCount: number;
  errorCount: number;
  currentUrl?: string;
  elapsedMs: number;
}

export interface CrawlSummary {
  startUrl: string;
  totalCrawled: number;
  totalQueued: number;
  totalCached: number;
  totalErrors: number;
  durationMs: number;
  results: CrawlResult[];
}

export interface BenchmarkResult {
  targetUrl: string;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalDurationMs: number;
  requestsPerSecond: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  p95LatencyMs: number;
  avgMarkdownExtractionMs: number;
  totalBytesDownloaded: number;
  cacheHitRate: number;
}
