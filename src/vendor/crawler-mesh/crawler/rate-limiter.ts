/**
 * @nymrel/crawler-mesh
 * Polite Domain-Aware Rate Limiter & Concurrency Controller
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import type { DomainRateLimitState } from './types.js';

export function extractDomain(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    return parsed.hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
}

export class PoliteRateLimiter {
  private defaultDelayMs: number;
  private maxConcurrencyPerDomain: number;
  private domainStates: Map<string, DomainRateLimitState> = new Map();

  constructor(options: { defaultDelayMs?: number; maxConcurrencyPerDomain?: number } = {}) {
    this.defaultDelayMs = options.defaultDelayMs ?? 250;
    this.maxConcurrencyPerDomain = options.maxConcurrencyPerDomain ?? 3;
  }

  private getOrCreateState(domain: string): DomainRateLimitState {
    let state = this.domainStates.get(domain);
    if (!state) {
      state = {
        domain,
        lastRequestTime: 0,
        activeRequests: 0,
        delayMs: this.defaultDelayMs,
        consecutiveFailures: 0,
        backoffUntil: 0
      };
      this.domainStates.set(domain, state);
    }
    return state;
  }

  public setDomainDelay(domain: string, delayMs: number): void {
    const state = this.getOrCreateState(domain.toLowerCase());
    state.delayMs = Math.max(delayMs, 0);
  }

  public async acquire(url: string): Promise<void> {
    const domain = extractDomain(url);
    const state = this.getOrCreateState(domain);

    while (true) {
      const now = Date.now();

      // Check if in backoff period
      if (now < state.backoffUntil) {
        const waitTime = state.backoffUntil - now;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      // Check per-domain concurrency
      if (state.activeRequests >= this.maxConcurrencyPerDomain) {
        await new Promise(resolve => setTimeout(resolve, 50));
        continue;
      }

      // Check minimum delay since last request
      const timeSinceLast = now - state.lastRequestTime;
      if (timeSinceLast < state.delayMs) {
        const waitTime = state.delayMs - timeSinceLast;
        await new Promise(resolve => setTimeout(resolve, waitTime));
        continue;
      }

      // Slot acquired
      state.activeRequests++;
      state.lastRequestTime = Date.now();
      break;
    }
  }

  public release(url: string, statusCode?: number, retryAfterSec?: number): void {
    const domain = extractDomain(url);
    const state = this.getOrCreateState(domain);

    state.activeRequests = Math.max(0, state.activeRequests - 1);
    state.lastRequestTime = Date.now();

    if (statusCode === 429 || statusCode === 503) {
      state.consecutiveFailures++;
      if (retryAfterSec && retryAfterSec > 0) {
        state.backoffUntil = Date.now() + retryAfterSec * 1000;
      } else {
        // Exponential backoff: 2s, 4s, 8s, 16s... + random jitter
        const base = Math.min(30000, 2000 * Math.pow(2, state.consecutiveFailures - 1));
        const jitter = Math.random() * 1000;
        state.backoffUntil = Date.now() + base + jitter;
      }
    } else if (statusCode && statusCode >= 200 && statusCode < 400) {
      state.consecutiveFailures = 0;
      state.backoffUntil = 0;
    }
  }

  public reset(): void {
    this.domainStates.clear();
  }
}
