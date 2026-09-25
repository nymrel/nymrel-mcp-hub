/**
 * Crawler Mesh MCP adapter.
 *
 * HTML conversion is implemented locally. URL crawling must be backed by the
 * canonical nymrel/nymrel-crawler-mesh runtime; until that package is linked
 * into this distribution, URL-only requests fail closed rather than returning
 * fabricated evidence.
 */

import { MCPToolDefinition, ToolExecutionResult } from '../types/index.js';

const CANONICAL_CRAWLER_REPOSITORY = 'https://github.com/nymrel/nymrel-crawler-mesh';
const CANONICAL_CRAWLER_MERGE = '360b6152267ebb6ca7bb9452e6240d2f4982f562';

export const crawlerToolDefinition: MCPToolDefinition = {
  name: 'nymrel_crawler_mesh',
  description: 'Convert supplied HTML into compact Markdown locally. Public URL crawling is fail-closed until the canonical Nymrel Crawler Mesh runtime is linked into this MCP distribution.',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Source URL metadata for supplied HTML. URL-only crawling currently fails closed instead of fabricating content.'
      },
      html: {
        type: 'string',
        description: 'Direct HTML payload to convert to compact Markdown.'
      },
      extractMetadata: {
        type: 'boolean',
        description: 'Reserved compatibility flag. Basic title/canonical metadata is always returned for local HTML conversion.',
        default: true
      }
    },
    additionalProperties: false
  }
};

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

function extractTitle(html: string): string {
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripTags(match[1]) : '';
}

function cleanHtmlToMarkdown(html: string): string {
  let clean = html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<svg\b[^<]*(?:(?!<\/svg>)<[^<]*)*<\/svg>/gi, '')
    .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, '')
    .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, '');

  clean = clean.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n');
  clean = clean.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n');
  clean = clean.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n');
  clean = clean.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n');
  clean = clean.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n');
  clean = clean.replace(/<br\s*[\/]?>/gi, '\n');
  clean = clean.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '- $1\n');
  clean = clean.replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n');
  clean = clean.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  clean = clean.replace(/<a\s+(?:[^>]*?\s+)?href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  clean = clean.replace(/<[^>]+>/g, '');
  clean = decodeEntities(clean);
  clean = clean.replace(/\n{3,}/g, '\n\n').trim();

  return clean || '# Extracted Content\n\nNo visible text content extracted from payload.';
}

function errorResult(message: string): ToolExecutionResult {
  return {
    isError: true,
    content: [{ type: 'text', text: message }]
  };
}

export async function executeCrawler(args: {
  url?: string;
  html?: string;
  extractMetadata?: boolean;
}): Promise<ToolExecutionResult> {
  const targetUrl = typeof args.url === 'string' && args.url.trim()
    ? args.url.trim()
    : 'local-html-buffer';
  const rawHtml = typeof args.html === 'string' ? args.html : '';

  if (!rawHtml) {
    if (targetUrl !== 'local-html-buffer') {
      return errorResult(
        [
          'URL crawling is unavailable in this MCP package until the canonical Nymrel Crawler Mesh runtime is linked.',
          'No placeholder or synthetic page was returned.',
          `Canonical source: ${CANONICAL_CRAWLER_REPOSITORY}`,
          `Verified merge: ${CANONICAL_CRAWLER_MERGE}`
        ].join('\n')
      );
    }
    return errorResult('Provide an "html" payload for local conversion or a URL once the canonical crawler runtime is linked.');
  }

  const markdown = cleanHtmlToMarkdown(rawHtml);
  const rawTokens = Math.round(rawHtml.length / 4);
  const cleanTokens = Math.round(markdown.length / 4);
  const tokenSavingsPercent = rawTokens > 0
    ? Math.round(((rawTokens - cleanTokens) / rawTokens) * 100)
    : 0;

  const result = {
    url: targetUrl,
    extractedAt: new Date().toISOString(),
    tokens: {
      rawHtmlEstimatedTokens: rawTokens,
      cleanMarkdownTokens: cleanTokens,
      tokenSavingsPercent: `${Math.max(0, tokenSavingsPercent)}%`
    },
    metadata: {
      title: extractTitle(rawHtml) || 'Extracted Document',
      canonical: targetUrl,
      crawlerEngine: 'Nymrel MCP local HTML adapter',
      canonicalCrawlerRepository: CANONICAL_CRAWLER_REPOSITORY,
      canonicalCrawlerMerge: CANONICAL_CRAWLER_MERGE,
      networkFetchPerformed: false
    },
    markdown
  };

  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  };
}
