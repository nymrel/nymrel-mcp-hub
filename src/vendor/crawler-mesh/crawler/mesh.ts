/**
 * @nymrel/crawler-mesh
 * Core High-Throughput Crawler Engine
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import { EventEmitter } from 'node:events';
import { ContentCache } from '../cache/index.js';
import type { CacheEntry } from '../cache/types.js';
import { extractMarkdown } from '../extractor/index.js';
import type {
  BenchmarkResult,
  CrawlOptions,
  CrawlProgress,
  CrawlResult,
  CrawlSummary,
  SingleCrawlOptions
} from '../types.js';
import { extractDomain, PoliteRateLimiter } from './rate-limiter.js';
import { CrawlQueue } from './queue.js';
import { RobotsParser } from './robots.js';
import { fetchAndParseSitemap } from './sitemap.js';
import {
  assertSafeHttpUrl,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_MAX_RESPONSE_BYTES,
  fetchWithPolicy,
  readResponseText,
  type NetworkPolicyOptions
} from './network-policy.js';

export class CrawlerMesh extends EventEmitter {
  private config: CrawlOptions;
  private cache: ContentCache;
  private rateLimiter: PoliteRateLimiter;
  private robotsCache: Map<string, RobotsParser> = new Map();
  private robotsInFlight: Map<string, Promise<RobotsParser>> = new Map();

  constructor(options: CrawlOptions = {}) {
    super();
    this.config = {
      maxDepth: options.maxDepth ?? 2,
      maxPages: options.maxPages ?? 50,
      maxConcurrency: options.maxConcurrency ?? 5,
      delayMs: options.delayMs ?? 250,
      timeoutMs: options.timeoutMs ?? 15000,
      userAgent: options.userAgent || 'NymrelCrawlerMesh/1.0 (+https://github.com/nymrel/nymrel-crawler-mesh; AI Data Engine)',
      respectRobots: options.respectRobots ?? true,
      cache: options.cache ?? true,
      cacheDir: options.cacheDir || '.crawler-cache',
      cacheTtl: options.cacheTtl ?? 86400,
      domainMatchMode: options.domainMatchMode || 'same-domain',
      allowedDomains: options.allowedDomains || [],
      deniedPatterns: options.deniedPatterns || [],
      includeSitemaps: options.includeSitemaps ?? false,
      extractorOptions: options.extractorOptions || {},
      headers: options.headers || {},
      fetch: options.fetch,
      allowPrivateNetworks: options.allowPrivateNetworks ?? false,
      maxResponseBytes: options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      maxRedirects: options.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
      resolveHostname: options.resolveHostname
    };

    this.cache = new ContentCache({
      enabled: this.config.cache,
      cacheDir: this.config.cacheDir,
      ttlSeconds: this.config.cacheTtl
    });

    this.rateLimiter = new PoliteRateLimiter({
      defaultDelayMs: this.config.delayMs,
      maxConcurrencyPerDomain: this.config.maxConcurrency
    });
  }

  private applyRobotsDelay(parser: RobotsParser, urlStr: string, userAgent: string): void {
    const crawlDelay = parser.getCrawlDelay(userAgent);
    if (crawlDelay !== undefined && crawlDelay > 0) {
      this.rateLimiter.setDomainDelay(extractDomain(urlStr), crawlDelay * 1000);
    }
  }

  private async getRobotsParser(
    urlStr: string,
    userAgent: string,
    fetchFn: typeof globalThis.fetch | undefined,
    networkOptions: NetworkPolicyOptions,
    timeoutMs: number
  ): Promise<RobotsParser | null> {
    if (!this.config.respectRobots) return null;

    let origin = '';
    try {
      origin = new URL(urlStr).origin;
    } catch {
      return null;
    }

    const cached = this.robotsCache.get(origin);
    if (cached) {
      this.applyRobotsDelay(cached, urlStr, userAgent);
      return cached;
    }

    const inFlight = this.robotsInFlight.get(origin);
    if (inFlight) {
      const parser = await inFlight;
      this.applyRobotsDelay(parser, urlStr, userAgent);
      return parser;
    }

    const pending = this.loadRobotsParser(origin, userAgent, fetchFn, networkOptions, timeoutMs);
    this.robotsInFlight.set(origin, pending);
    try {
      const parser = await pending;
      this.applyRobotsDelay(parser, urlStr, userAgent);
      return parser;
    } finally {
      this.robotsInFlight.delete(origin);
    }
  }

  private async loadRobotsParser(
    origin: string,
    userAgent: string,
    fetchFn: typeof globalThis.fetch | undefined,
    networkOptions: NetworkPolicyOptions,
    timeoutMs: number
  ): Promise<RobotsParser> {
    const parser = new RobotsParser();
    try {
      const { response } = await fetchWithPolicy(`${origin}/robots.txt`, {
        headers: {
          'User-Agent': userAgent
        }
      }, {
        fetch: fetchFn,
        timeoutMs: Math.min(timeoutMs, 5_000),
        ...networkOptions
      });

      if (response.ok) {
        const text = await readResponseText(
          response,
          Math.min(networkOptions.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES, 1024 * 1024)
        );
        parser.parse(text);
      } else {
        await response.body?.cancel();
      }
    } catch {
      // A missing/unavailable robots.txt is treated as allow-all. Target policy
      // is independently enforced before the page request.
    }

    this.robotsCache.set(origin, parser);
    return parser;
  }

  public async crawlUrl(rawUrl: string, options: SingleCrawlOptions = {}): Promise<CrawlResult> {
    const startTime = Date.now();
    const fetchFn = options.fetch ?? this.config.fetch;
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs ?? 15000;
    const userAgent = options.userAgent || this.config.userAgent || 'NymrelCrawlerMesh/1.0';
    const respectRobots = options.respectRobots ?? this.config.respectRobots ?? true;
    const useCache = options.cache ?? this.config.cache ?? true;
    const networkOptions = {
      allowPrivateNetworks: options.allowPrivateNetworks ?? this.config.allowPrivateNetworks,
      maxResponseBytes: options.maxResponseBytes ?? this.config.maxResponseBytes,
      maxRedirects: options.maxRedirects ?? this.config.maxRedirects,
      resolveHostname: options.resolveHostname ?? this.config.resolveHostname
    };

    const safeUrl = await assertSafeHttpUrl(rawUrl, networkOptions);

    // 1. Check robots.txt
    if (respectRobots) {
      const robots = await this.getRobotsParser(rawUrl, userAgent, fetchFn, networkOptions, timeoutMs);
      if (robots && !robots.isAllowed(rawUrl, userAgent)) {
        throw new Error('Crawl disallowed by robots.txt');
      }
    }

    // 2. Check cache
    if (useCache) {
      const cached = await this.cache.get(rawUrl);
      if (cached) {
        const result: CrawlResult = {
          url: cached.url,
          canonicalUrl: cached.metadata.canonical,
          statusCode: cached.statusCode,
          statusText: cached.statusText,
          headers: cached.headers,
          contentType: cached.contentType,
          fromCache: true,
          contentHash: cached.hash,
          durationMs: Date.now() - startTime,
          depth: 0,
          markdown: cached.markdown,
          text: cached.text,
          html: cached.html,
          metadata: cached.metadata,
          links: cached.links,
          images: cached.images,
          tables: cached.tables,
          codeBlocks: cached.codeBlocks
        };
        this.emit('cached', result);
        return result;
      }
    }

    // 3. Rate limiter acquire
    await this.rateLimiter.acquire(rawUrl);

    let response: Response;
    let html = '';
    let statusCode = 0;
    let statusText = '';
    const headersRecord: Record<string, string> = {};
    let contentType = 'text/html';

    try {
      const conditionalHeaders = useCache ? this.cache.getConditionalHeaders(rawUrl) : {};

      const reqHeaders: Record<string, string> = {
        'User-Agent': userAgent,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        ...this.config.headers,
        ...options.headers,
        ...conditionalHeaders
      };

      const safeFetch = await fetchWithPolicy(safeUrl, { headers: reqHeaders }, {
        fetch: fetchFn,
        timeoutMs,
        ...networkOptions
      });
      response = safeFetch.response;
      const finalUrl = safeFetch.finalUrl;

      statusCode = response.status;
      statusText = response.statusText;

      response.headers.forEach((val, key) => {
        headersRecord[key.toLowerCase()] = val;
      });

      contentType = headersRecord['content-type'] || 'text/html';

      // 304 Not Modified support
      if (statusCode === 304) {
        const revalidatedEntry = await this.cache.get(rawUrl);
        if (revalidatedEntry) {
          await response.body?.cancel();
          this.rateLimiter.release(rawUrl, 304);
          return {
            url: rawUrl,
            canonicalUrl: revalidatedEntry.metadata.canonical,
            statusCode: 200,
            statusText: 'OK (304 Not Modified)',
            headers: headersRecord,
            contentType: revalidatedEntry.contentType,
            fromCache: true,
            contentHash: revalidatedEntry.hash,
            durationMs: Date.now() - startTime,
            depth: 0,
            markdown: revalidatedEntry.markdown,
            text: revalidatedEntry.text,
            html: revalidatedEntry.html,
            metadata: revalidatedEntry.metadata,
            links: revalidatedEntry.links,
            images: revalidatedEntry.images,
            tables: revalidatedEntry.tables,
            codeBlocks: revalidatedEntry.codeBlocks
          };
        }
      }

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${statusCode} ${statusText}`);
      }

      html = await readResponseText(
        response,
        networkOptions.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES
      );
      this.rateLimiter.release(rawUrl, statusCode);

      // Use the validated final redirect destination to resolve relative links.
      safeUrl.href = finalUrl;
    } catch (err: any) {
      this.rateLimiter.release(rawUrl, statusCode || 500);
      throw err;
    }

    // 4. Extract clean Markdown & structured data
    const extraction = extractMarkdown(html, {
      ...this.config.extractorOptions,
      ...options.extractorOptions,
      baseUrl: safeUrl.toString()
    });

    const contentHash = this.cache.computeHash(html);
    const durationMs = Date.now() - startTime;

    const result: CrawlResult = {
      url: rawUrl,
      canonicalUrl: extraction.metadata.canonical,
      statusCode,
      statusText,
      headers: headersRecord,
      contentType,
      fromCache: false,
      contentHash,
      durationMs,
      depth: 0,
      markdown: extraction.markdown,
      text: extraction.text,
      html,
      metadata: extraction.metadata,
      links: extraction.links,
      images: extraction.images,
      tables: extraction.tables,
      codeBlocks: extraction.codeBlocks
    };

    // 5. Store in cache
    if (useCache) {
      await this.cache.set(rawUrl, {
        url: rawUrl,
        statusCode,
        statusText,
        headers: headersRecord,
        contentType,
        html,
        markdown: extraction.markdown,
        text: extraction.text,
        metadata: extraction.metadata,
        links: extraction.links,
        images: extraction.images,
        tables: extraction.tables,
        codeBlocks: extraction.codeBlocks,
        etag: headersRecord['etag'],
        lastModified: headersRecord['last-modified']
      });
    }

    this.emit('page', result);
    return result;
  }

  public async crawl(
    startUrl: string | string[],
    options: Partial<CrawlOptions> = {}
  ): Promise<CrawlSummary> {
    const startTime = Date.now();
    const effectiveConfig = { ...this.config, ...options };
    const startUrls = Array.isArray(startUrl) ? startUrl : [startUrl];

    const startDomains = startUrls.map(u => {
      try {
        return new URL(u).hostname;
      } catch {
        return '';
      }
    }).filter(Boolean);

    const queue = new CrawlQueue({
      startDomains,
      domainMatchMode: effectiveConfig.domainMatchMode,
      allowedDomains: effectiveConfig.allowedDomains,
      deniedPatterns: effectiveConfig.deniedPatterns,
      maxDepth: effectiveConfig.maxDepth
    });

    // Seed initial URLs
    for (const url of startUrls) {
      queue.enqueue({ url, depth: 0 });
    }

    // Discover sitemap if configured
    if (effectiveConfig.includeSitemaps) {
      const sitemapJobs = startUrls.map(async url => {
        try {
          const origin = new URL(url).origin;
          const sitemapUrl = `${origin}/sitemap.xml`;
          const sitemapData = await fetchAndParseSitemap(sitemapUrl, {
            fetch: effectiveConfig.fetch,
            userAgent: effectiveConfig.userAgent,
            timeoutMs: effectiveConfig.timeoutMs,
            maxResponseBytes: effectiveConfig.maxResponseBytes,
            maxRedirects: effectiveConfig.maxRedirects,
            allowPrivateNetworks: effectiveConfig.allowPrivateNetworks,
            resolveHostname: effectiveConfig.resolveHostname
          });
          for (const entry of sitemapData.urls) {
            queue.enqueue({ url: entry.loc, depth: 1 });
          }
        } catch {
          // ignore sitemap discovery errors
        }
      });
      await Promise.all(sitemapJobs);
    }

    const results: CrawlResult[] = [];
    let cachedCount = 0;
    let errorCount = 0;
    const maxPages = effectiveConfig.maxPages ?? 50;
    const maxConcurrency = effectiveConfig.maxConcurrency ?? 5;
    let reservedPages = 0;

    const reserveNext = () => {
      while (!queue.isEmpty() && reservedPages < maxPages) {
        const item = queue.dequeue();
        if (!item) return undefined;
        if (queue.hasVisited(item.url)) continue;
        queue.markVisited(item.url);
        reservedPages += 1;
        return item;
      }
      return undefined;
    };

    const worker = async () => {
      while (true) {
        const item = reserveNext();
        if (!item) break;

        try {
          const result = await this.crawlUrl(item.url, {
            timeoutMs: effectiveConfig.timeoutMs,
            userAgent: effectiveConfig.userAgent,
            respectRobots: effectiveConfig.respectRobots,
            cache: effectiveConfig.cache,
            headers: effectiveConfig.headers,
            extractorOptions: effectiveConfig.extractorOptions,
            fetch: effectiveConfig.fetch,
            allowPrivateNetworks: effectiveConfig.allowPrivateNetworks,
            maxResponseBytes: effectiveConfig.maxResponseBytes,
            maxRedirects: effectiveConfig.maxRedirects,
            resolveHostname: effectiveConfig.resolveHostname
          });

          result.depth = item.depth;
          results.push(result);
          if (result.fromCache) cachedCount++;

          const progress: CrawlProgress = {
            crawledCount: results.length,
            queuedCount: queue.size(),
            cachedCount,
            errorCount,
            currentUrl: item.url,
            elapsedMs: Date.now() - startTime
          };
          this.emit('progress', progress);

          // Enqueue discovered links and let CrawlQueue enforce the configured
          // same-domain/subdomain/any policy. The default same-domain behavior
          // stays unchanged, while broader modes now work as configured.
          if (item.depth < (effectiveConfig.maxDepth ?? 2)) {
            for (const link of result.links) {
              if (link.href) {
                queue.enqueue({
                  url: link.href,
                  depth: item.depth + 1,
                  referrer: item.url
                });
              }
            }
          }
        } catch (err: any) {
          errorCount++;
          if (this.listenerCount('error') > 0) {
            this.emit('error', { url: item.url, error: err, depth: item.depth });
          }
        }
      }
    };

    const workers = Array.from({ length: maxConcurrency }, () => worker());
    await Promise.all(workers);

    const summary: CrawlSummary = {
      startUrl: Array.isArray(startUrl) ? startUrl[0] : startUrl,
      totalCrawled: results.length,
      totalQueued: queue.size() + results.length,
      totalCached: cachedCount,
      totalErrors: errorCount,
      durationMs: Date.now() - startTime,
      results
    };

    this.emit('done', summary);
    return summary;
  }

  public async *crawlStream(
    startUrl: string | string[],
    options: Partial<CrawlOptions> = {}
  ): AsyncIterable<CrawlResult> {
    const summary = await this.crawl(startUrl, options);
    for (const result of summary.results) {
      yield result;
    }
  }

  public async benchmark(
    targetUrl: string,
    count: number = 20,
    concurrency: number = 5
  ): Promise<BenchmarkResult> {
    const latencies: number[] = [];
    const extractionTimes: number[] = [];
    let successCount = 0;
    let failCount = 0;
    let totalBytes = 0;
    let cacheHits = 0;

    const startBench = Date.now();
    if (!Number.isSafeInteger(count) || count <= 0 || !Number.isSafeInteger(concurrency) || concurrency <= 0) {
      throw new TypeError('Benchmark count and concurrency must be positive safe integers');
    }

    let nextIndex = 0;
    const worker = async () => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= count) return;

        const iterStart = Date.now();
        try {
          const result = await this.crawlUrl(targetUrl, { cache: index > 0 });
          const latency = Date.now() - iterStart;
          latencies.push(latency);
          extractionTimes.push(result.durationMs);
          totalBytes += result.html.length;
          if (result.fromCache) cacheHits++;
          successCount++;
        } catch {
          failCount++;
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(count, concurrency) }, () => worker()));

    const totalDurationMs = Math.max(1, Date.now() - startBench);
    latencies.sort((a, b) => a - b);

    const avgLatencyMs = latencies.length > 0 ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const minLatencyMs = latencies[0] || 0;
    const maxLatencyMs = latencies[latencies.length - 1] || 0;
    const p95Index = Math.floor(latencies.length * 0.95);
    const p95LatencyMs = latencies[p95Index] || maxLatencyMs;
    const avgMarkdownExtractionMs = extractionTimes.length > 0
      ? extractionTimes.reduce((a, b) => a + b, 0) / extractionTimes.length
      : 0;

    return {
      targetUrl,
      totalRequests: count,
      successfulRequests: successCount,
      failedRequests: failCount,
      totalDurationMs,
      requestsPerSecond: parseFloat(((count / totalDurationMs) * 1000).toFixed(2)),
      avgLatencyMs: parseFloat(avgLatencyMs.toFixed(2)),
      minLatencyMs,
      maxLatencyMs,
      p95LatencyMs,
      avgMarkdownExtractionMs: parseFloat(avgMarkdownExtractionMs.toFixed(2)),
      totalBytesDownloaded: totalBytes,
      cacheHitRate: parseFloat(((cacheHits / count) * 100).toFixed(1))
    };
  }

  public async clearCache(): Promise<void> {
    await this.cache.clear();
  }
}
