/**
 * @nymrel/crawler-mesh
 * Deduplicated Priority & FIFO Crawl Queue
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import type { QueueItem } from './types.js';
import { normalizeUrlKey } from '../cache/index.js';

export function isUrlAllowed(
  urlStr: string,
  startDomains: string[],
  mode: 'same-domain' | 'subdomains' | 'any' = 'same-domain',
  allowedDomains: string[] = [],
  deniedPatterns: (string | RegExp)[] = []
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return false;
  }

  // Only crawl http and https
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  // Skip static non-document assets
  const pathname = parsed.pathname.toLowerCase();
  const ignoredExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico',
    '.pdf', '.zip', '.tar', '.gz', '.mp3', '.mp4', '.avi', '.mov',
    '.css', '.js', '.woff', '.woff2', '.ttf', '.eot'
  ];
  if (ignoredExtensions.some(ext => pathname.endsWith(ext))) {
    return false;
  }

  // Check denied patterns
  for (const pattern of deniedPatterns) {
    if (typeof pattern === 'string') {
      if (urlStr.includes(pattern)) return false;
    } else if (pattern instanceof RegExp) {
      if (pattern.test(urlStr)) return false;
    }
  }

  const hostname = parsed.hostname.toLowerCase();

  // If explicit allowedDomains list is provided
  if (allowedDomains.length > 0) {
    return allowedDomains.some(d => d.toLowerCase() === hostname || hostname.endsWith('.' + d.toLowerCase()));
  }

  if (mode === 'any') {
    return true;
  }

  if (startDomains.length === 0) {
    return true;
  }

  if (mode === 'same-domain') {
    return startDomains.some(startDomain => {
      const cleanStart = startDomain.toLowerCase().replace(/^www\./, '');
      const cleanHost = hostname.replace(/^www\./, '');
      return cleanHost === cleanStart;
    });
  }

  if (mode === 'subdomains') {
    return startDomains.some(startDomain => {
      const cleanStart = startDomain.toLowerCase().replace(/^www\./, '');
      return hostname === cleanStart || hostname.endsWith('.' + cleanStart);
    });
  }

  return true;
}

export class CrawlQueue {
  private queue: QueueItem[] = [];
  private visitedUrls: Set<string> = new Set();
  private enqueuedUrls: Set<string> = new Set();
  private startDomains: string[] = [];
  private domainMatchMode: 'same-domain' | 'subdomains' | 'any';
  private allowedDomains: string[];
  private deniedPatterns: (string | RegExp)[];
  private maxDepth: number;

  constructor(options: {
    startDomains?: string[];
    domainMatchMode?: 'same-domain' | 'subdomains' | 'any';
    allowedDomains?: string[];
    deniedPatterns?: (string | RegExp)[];
    maxDepth?: number;
  } = {}) {
    this.startDomains = options.startDomains || [];
    this.domainMatchMode = options.domainMatchMode || 'same-domain';
    this.allowedDomains = options.allowedDomains || [];
    this.deniedPatterns = options.deniedPatterns || [];
    this.maxDepth = options.maxDepth ?? 2;
  }

  public setStartDomains(domains: string[]): void {
    this.startDomains = domains.map(d => d.toLowerCase());
  }

  public enqueue(item: QueueItem): boolean {
    const normalized = normalizeUrlKey(item.url);

    if (this.enqueuedUrls.has(normalized) || this.visitedUrls.has(normalized)) {
      return false;
    }

    if (item.depth > this.maxDepth) {
      return false;
    }

    if (!isUrlAllowed(item.url, this.startDomains, this.domainMatchMode, this.allowedDomains, this.deniedPatterns)) {
      return false;
    }

    this.enqueuedUrls.add(normalized);
    this.queue.push({
      ...item,
      url: item.url
    });
    return true;
  }

  public dequeue(): QueueItem | undefined {
    return this.queue.shift();
  }

  public markVisited(url: string): void {
    const normalized = normalizeUrlKey(url);
    this.visitedUrls.add(normalized);
  }

  public hasVisited(url: string): boolean {
    const normalized = normalizeUrlKey(url);
    return this.visitedUrls.has(normalized);
  }

  public isEmpty(): boolean {
    return this.queue.length === 0;
  }

  public size(): number {
    return this.queue.length;
  }

  public visitedCount(): number {
    return this.visitedUrls.size;
  }

  public clear(): void {
    this.queue = [];
    this.visitedUrls.clear();
    this.enqueuedUrls.clear();
  }
}
