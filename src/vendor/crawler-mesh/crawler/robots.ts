/**
 * @nymrel/crawler-mesh
 * RFC 9309 Compliant robots.txt Parser
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import type { RobotsRule, UserAgentRules } from './types.js';

function patternToRegex(pattern: string): RegExp {
  // Escape special regex characters except * and $
  let escaped = pattern.replace(/[-[\]{}()+?.,\\^|#\s]/g, '\\$&');
  // Replace * with .*
  escaped = escaped.replace(/\*/g, '.*');
  // Handle end anchor $
  if (escaped.endsWith('\\$')) {
    escaped = escaped.slice(0, -2) + '$';
  } else if (!escaped.endsWith('$')) {
    // Prefix match
    escaped = '^' + (escaped.startsWith('/') ? '' : '/') + escaped;
  } else {
    escaped = '^' + (escaped.startsWith('/') ? '' : '/') + escaped;
  }
  return new RegExp(escaped);
}

export class RobotsParser {
  private userAgentGroups: Map<string, UserAgentRules> = new Map();
  private sitemaps: string[] = [];

  constructor(robotsTxtContent?: string) {
    if (robotsTxtContent) {
      this.parse(robotsTxtContent);
    }
  }

  public parse(content: string): void {
    this.userAgentGroups.clear();
    this.sitemaps = [];

    const lines = content.split(/\r?\n/);
    let currentUserAgents: string[] = [];
    let isReadingUserAgents = false;

    for (let rawLine of lines) {
      // Strip comments
      const commentIndex = rawLine.indexOf('#');
      if (commentIndex !== -1) {
        rawLine = rawLine.substring(0, commentIndex);
      }
      const line = rawLine.trim();
      if (!line) continue;

      const colonIndex = line.indexOf(':');
      if (colonIndex === -1) continue;

      const field = line.substring(0, colonIndex).trim().toLowerCase();
      const value = line.substring(colonIndex + 1).trim();

      if (field === 'user-agent') {
        const ua = value.toLowerCase();
        if (!isReadingUserAgents) {
          currentUserAgents = [];
          isReadingUserAgents = true;
        }
        if (!currentUserAgents.includes(ua)) {
          currentUserAgents.push(ua);
        }
        if (!this.userAgentGroups.has(ua)) {
          this.userAgentGroups.set(ua, { userAgent: ua, rules: [] });
        }
      } else if (field === 'sitemap') {
        isReadingUserAgents = false;
        if (value && !this.sitemaps.includes(value)) {
          this.sitemaps.push(value);
        }
      } else if (field === 'disallow' || field === 'allow') {
        isReadingUserAgents = false;
        if (currentUserAgents.length === 0) {
          currentUserAgents = ['*'];
          if (!this.userAgentGroups.has('*')) {
            this.userAgentGroups.set('*', { userAgent: '*', rules: [] });
          }
        }

        const isAllow = field === 'allow';
        if (value === '') {
          // "Disallow:" with empty value means allow everything
          if (!isAllow) {
            for (const ua of currentUserAgents) {
              const group = this.userAgentGroups.get(ua);
              if (group) {
                group.rules.push({
                  pattern: '',
                  regex: /^/,
                  allow: true,
                  specificity: 0
                });
              }
            }
          }
          continue;
        }

        const rule: RobotsRule = {
          pattern: value,
          regex: patternToRegex(value),
          allow: isAllow,
          specificity: value.length
        };

        for (const ua of currentUserAgents) {
          const group = this.userAgentGroups.get(ua);
          if (group) {
            group.rules.push(rule);
          }
        }
      } else if (field === 'crawl-delay') {
        const delay = parseFloat(value);
        if (!isNaN(delay) && delay >= 0) {
          for (const ua of currentUserAgents) {
            const group = this.userAgentGroups.get(ua);
            if (group) {
              group.crawlDelay = delay;
            }
          }
        }
      }
    }
  }

  private findMatchingGroup(userAgent: string): UserAgentRules | undefined {
    const targetUa = userAgent.toLowerCase();

    // 1. Exact match
    if (this.userAgentGroups.has(targetUa)) {
      return this.userAgentGroups.get(targetUa);
    }

    // 2. Substring match (e.g. "NymrelCrawlerMesh/1.0" matches "nymrelcrawlermesh")
    for (const [uaKey, group] of this.userAgentGroups.entries()) {
      if (uaKey !== '*' && targetUa.includes(uaKey)) {
        return group;
      }
    }

    // 3. Fallback to wildcard '*'
    return this.userAgentGroups.get('*');
  }

  public isAllowed(urlStr: string, userAgent: string = '*'): boolean {
    let pathname = '/';
    try {
      const parsed = new URL(urlStr, 'http://localhost');
      pathname = parsed.pathname + parsed.search;
    } catch {
      pathname = urlStr.startsWith('/') ? urlStr : '/' + urlStr;
    }

    const group = this.findMatchingGroup(userAgent);
    if (!group || group.rules.length === 0) {
      return true;
    }

    // Match rules against pathname
    let matchedRule: RobotsRule | null = null;

    for (const rule of group.rules) {
      if (rule.regex.test(pathname)) {
        if (!matchedRule) {
          matchedRule = rule;
        } else if (rule.specificity > matchedRule.specificity) {
          matchedRule = rule;
        } else if (rule.specificity === matchedRule.specificity) {
          // Allow takes precedence over Disallow on equal specificity (RFC 9309)
          if (rule.allow) {
            matchedRule = rule;
          }
        }
      }
    }

    if (!matchedRule) {
      return true;
    }

    return matchedRule.allow;
  }

  public getCrawlDelay(userAgent: string = '*'): number | undefined {
    const group = this.findMatchingGroup(userAgent);
    return group?.crawlDelay;
  }

  public getSitemaps(): string[] {
    return [...this.sitemaps];
  }
}
