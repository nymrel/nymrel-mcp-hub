/**
 * @nymrel/crawler-mesh
 * Cache Types
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import type { DocumentMetadata, ExtractedCodeBlock, ExtractedTable, DiscoveredImage, DiscoveredLink } from '../types.js';

export interface CacheEntry {
  url: string;
  hash: string;
  statusCode: number;
  statusText: string;
  headers: Record<string, string>;
  contentType: string;
  html: string;
  markdown: string;
  text: string;
  metadata: DocumentMetadata;
  links: DiscoveredLink[];
  images: DiscoveredImage[];
  tables: ExtractedTable[];
  codeBlocks: ExtractedCodeBlock[];
  etag?: string;
  lastModified?: string;
  savedAt: number;
  expiresAt: number;
}

export interface CacheOptions {
  enabled?: boolean;
  cacheDir?: string;
  ttlSeconds?: number;
  inMemory?: boolean;
  maxMemoryEntries?: number;
}

export interface CacheDriver {
  get(url: string): Promise<CacheEntry | null>;
  set(url: string, entry: Omit<CacheEntry, 'hash' | 'savedAt' | 'expiresAt'>): Promise<CacheEntry>;
  has(url: string): Promise<boolean>;
  delete(url: string): Promise<boolean>;
  clear(): Promise<void>;
  computeHash(content: string): string;
}
