/**
 * @nymrel/crawler-mesh
 * Crawler Subsystem Types
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import type {
  BenchmarkResult,
  CrawlOptions,
  CrawlProgress,
  CrawlResult,
  CrawlSummary,
  DocumentMetadata,
  ExtractorOptions,
  SingleCrawlOptions,
  SitemapEntry,
  SitemapResult
} from '../types.js';

export type {
  BenchmarkResult,
  CrawlOptions,
  CrawlProgress,
  CrawlResult,
  CrawlSummary,
  DocumentMetadata,
  ExtractorOptions,
  SingleCrawlOptions,
  SitemapEntry,
  SitemapResult
};

export interface QueueItem {
  url: string;
  depth: number;
  referrer?: string;
  retryCount?: number;
}

export interface DomainRateLimitState {
  domain: string;
  lastRequestTime: number;
  activeRequests: number;
  delayMs: number;
  consecutiveFailures: number;
  backoffUntil: number;
}

export interface RobotsRule {
  pattern: string;
  regex: RegExp;
  allow: boolean;
  specificity: number;
}

export interface UserAgentRules {
  userAgent: string;
  rules: RobotsRule[];
  crawlDelay?: number;
}

export interface MeshEvents {
  'page': (result: CrawlResult) => void;
  'progress': (progress: CrawlProgress) => void;
  'error': (error: { url: string; error: Error; depth: number }) => void;
  'cached': (result: CrawlResult) => void;
  'done': (summary: CrawlSummary) => void;
}
