/**
 * Nymrel Crawler Mesh MCP adapter.
 *
 * The network runtime is a verbatim, revision-pinned vendor copy of
 * nymrel/nymrel-crawler-mesh. This adapter owns only MCP input/output shaping.
 */

import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';
import { FirecrawlV2Compat } from '../vendor/crawler-mesh/firecrawl-compat.js';
import { extractMarkdown, extractMetadata } from '../vendor/crawler-mesh/extractor/index.js';
import type { CrawlOptions } from '../vendor/crawler-mesh/types.js';

const CANONICAL_CRAWLER_REPOSITORY = 'https://github.com/nymrel/nymrel-crawler-mesh';
const CANONICAL_CRAWLER_MERGE = '35634d2109bb8c33cb17e38acf70c584e891c2e6';
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_DEPTH = 2;
const MAX_DEPTH = 10;

type CrawlerAction = 'scrape' | 'map' | 'crawl';

export interface CrawlerToolArgs {
  action?: CrawlerAction;
  url?: string;
  html?: string;
  extractMetadata?: boolean;
  limit?: number;
  maxDepth?: number;
  search?: string;
  includeSubdomains?: boolean;
  crawlEntireDomain?: boolean;
  sitemap?: 'include' | 'skip';
}

export interface CrawlerRuntimeOptions extends CrawlOptions {}

export const crawlerToolDefinition: MCPToolDefinition = {
  name: 'nymrel_crawler_mesh',
  description: 'Nymrel-owned, zero-telemetry public-web scrape/map/crawl tool. Converts supplied HTML locally or fetches bounded public HTTP(S) URLs through Crawler Mesh with SSRF, redirect, robots, response-size, and concurrency protections.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['scrape', 'map', 'crawl'],
        description: 'Operation to run. Defaults to scrape.',
        default: 'scrape'
      },
      url: {
        type: 'string',
        description: 'Public HTTP(S) URL. Required for network scrape/map/crawl. Local/private targets are rejected.'
      },
      html: {
        type: 'string',
        description: 'Optional direct HTML payload for local scrape conversion. Cannot be combined with map/crawl.'
      },
      extractMetadata: {
        type: 'boolean',
        description: 'Whether to include extracted metadata. Defaults to true.',
        default: true
      },
      limit: {
        type: 'number',
        description: 'Maximum discovered/crawled pages for map/crawl. Default 20; hard cap 100.'
      },
      maxDepth: {
        type: 'number',
        description: 'Maximum crawl discovery depth. Default 2; hard cap 10.'
      },
      search: {
        type: 'string',
        description: 'Optional case-insensitive URL/title/description filter for map.'
      },
      includeSubdomains: {
        type: 'boolean',
        description: 'Allow matching subdomains for map/crawl. Default false for crawl and true for map compatibility.'
      },
      crawlEntireDomain: {
        type: 'boolean',
        description: 'For crawl, widen scope from the starting child path to the full same domain.'
      },
      sitemap: {
        type: 'string',
        enum: ['include', 'skip'],
        description: 'Whether sitemap discovery participates. Defaults to include.'
      }
    },
    additionalProperties: false
  }
};

function errorResult(message: string): ToolExecutionResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }]
  };
}

function textResult(value: unknown): ToolExecutionResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  };
}

function boundedInt(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

function validatedUrl(value: string | undefined): string {
  if (!value || !value.trim()) throw new TypeError('url is required for network crawler operations');
  const url = new URL(value.trim());
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new TypeError('url must use http or https');
  }
  return url.toString();
}

function directHtmlContent(html: string): string {
  const body = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return body?.[1] ?? html;
}

export async function executeCrawler(
  args: CrawlerToolArgs,
  runtimeOptions: CrawlerRuntimeOptions = {}
): Promise<ToolExecutionResult> {
  try {
    const action: CrawlerAction = args.action ?? 'scrape';
    const directHtml = typeof args.html === 'string' ? args.html : '';

    if (directHtml) {
      if (action !== 'scrape') {
        return errorResult('html is supported only with action="scrape".');
      }
      const baseUrl = args.url?.trim() || undefined;
      const sourceMetadata = extractMetadata(directHtml, baseUrl);
      const extraction = extractMarkdown(directHtmlContent(directHtml), {
        includeFrontmatter: false,
        targetMainContent: false,
        baseUrl
      });
      const metadata = {
        ...sourceMetadata,
        wordCount: extraction.metadata.wordCount,
        characterCount: extraction.metadata.characterCount,
        readingTimeMinutes: extraction.metadata.readingTimeMinutes,
        estimatedTokens: extraction.metadata.estimatedTokens
      };
      const rawTokens = Math.round(directHtml.length / 4);
      const cleanTokens = Math.round(extraction.markdown.length / 4);
      const tokenSavingsPercent = rawTokens > 0
        ? Math.round(((rawTokens - cleanTokens) / rawTokens) * 100)
        : 0;
      const result = {
        action: 'scrape',
        source: 'local-html',
        url: baseUrl ?? 'local-html-buffer',
        networkFetchPerformed: false,
        tokens: {
          rawHtmlEstimatedTokens: rawTokens,
          cleanMarkdownTokens: cleanTokens,
          tokenSavingsPercent: `${Math.max(0, tokenSavingsPercent)}%`
        },
        metadata: args.extractMetadata === false
          ? undefined
          : { ...metadata, networkFetchPerformed: false },
        markdown: extraction.markdown,
        text: extraction.text,
        links: extraction.links.map(link => link.href),
        tables: extraction.tables,
        codeBlocks: extraction.codeBlocks,
        canonicalCrawlerRepository: CANONICAL_CRAWLER_REPOSITORY,
        canonicalCrawlerMerge: CANONICAL_CRAWLER_MERGE
      };
      return textResult(result);
    }

    const url = validatedUrl(args.url);
    const limit = boundedInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, 'limit');
    const maxDepth = boundedInt(args.maxDepth, DEFAULT_DEPTH, 0, MAX_DEPTH, 'maxDepth');
    const crawler = new FirecrawlV2Compat({
      maxPages: limit,
      maxDepth,
      maxConcurrency: runtimeOptions.maxConcurrency ?? 5,
      delayMs: runtimeOptions.delayMs ?? 250,
      timeoutMs: runtimeOptions.timeoutMs ?? 15_000,
      userAgent: runtimeOptions.userAgent ?? 'NymrelMCPHub-CrawlerMesh/1.0 (+https://github.com/nymrel/nymrel-mcp-hub)',
      respectRobots: runtimeOptions.respectRobots ?? true,
      cache: runtimeOptions.cache ?? false,
      fetch: runtimeOptions.fetch,
      allowPrivateNetworks: runtimeOptions.allowPrivateNetworks ?? false,
      maxResponseBytes: runtimeOptions.maxResponseBytes,
      maxRedirects: runtimeOptions.maxRedirects,
      resolveHostname: runtimeOptions.resolveHostname
    });

    if (action === 'scrape') {
      const response = await crawler.scrape({
        url,
        formats: ['markdown', 'links'],
        onlyMainContent: true,
        timeout: runtimeOptions.timeoutMs
      });
      const responseData = args.extractMetadata === false
        ? (() => {
            const { metadata: _metadata, ...withoutMetadata } = response.data;
            return withoutMetadata;
          })()
        : response.data;
      return textResult({
        action,
        source: 'nymrel-crawler-mesh',
        networkFetchPerformed: true,
        success: response.success,
        data: responseData,
        canonicalCrawlerRepository: CANONICAL_CRAWLER_REPOSITORY,
        canonicalCrawlerMerge: CANONICAL_CRAWLER_MERGE
      });
    }

    if (action === 'map') {
      const response = await crawler.map({
        url,
        limit,
        search: args.search,
        sitemap: args.sitemap ?? 'include',
        includeSubdomains: args.includeSubdomains ?? true
      });
      return textResult({
        action,
        source: 'nymrel-crawler-mesh',
        networkFetchPerformed: true,
        ...response,
        canonicalCrawlerRepository: CANONICAL_CRAWLER_REPOSITORY,
        canonicalCrawlerMerge: CANONICAL_CRAWLER_MERGE
      });
    }

    const response = await crawler.crawl({
      url,
      limit,
      maxDiscoveryDepth: maxDepth,
      crawlEntireDomain: args.crawlEntireDomain ?? false,
      allowSubdomains: args.includeSubdomains ?? false,
      sitemap: args.sitemap ?? 'include',
      scrapeOptions: {
        formats: ['markdown', 'links'],
        onlyMainContent: true
      }
    });
    return textResult({
      action,
      source: 'nymrel-crawler-mesh',
      networkFetchPerformed: true,
      ...response,
      canonicalCrawlerRepository: CANONICAL_CRAWLER_REPOSITORY,
      canonicalCrawlerMerge: CANONICAL_CRAWLER_MERGE
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`Crawler Mesh request failed: ${message}`);
  }
}
