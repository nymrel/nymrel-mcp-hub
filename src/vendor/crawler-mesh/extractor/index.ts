/**
 * @nymrel/crawler-mesh
 * Semantic Markdown & Structured Data Extractor
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import { cleanHtml, decodeHtmlEntities } from './html-cleaner.js';
import {
  astToMarkdown,
  extractCodeBlocksFromAst,
  extractTablesFromAst,
  HtmlToAstParser,
  resolveSafeUrlReference,
  tokenizeHtml
} from './ast.js';
import type {
  DiscoveredImage,
  DiscoveredLink,
  DocumentMetadata,
  ExtractionResult,
  ExtractorOptions
} from './types.js';

export * from './types.js';
export * from './html-cleaner.js';
export * from './ast.js';

export function extractMetadata(html: string, baseUrl?: string): DocumentMetadata {
  let title = '';
  let description = '';
  let canonical = '';
  let author = '';
  let publishedTime = '';
  let modifiedTime = '';
  let language = '';
  const openGraph: Record<string, string> = {};
  const twitterCard: Record<string, string> = {};
  const keywords: string[] = [];

  // Extract <title>
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    title = decodeHtmlEntities(titleMatch[1].trim());
  }

  // Extract <html lang="...">
  const langMatch = html.match(/<html\b[^>]*\blang=["']([^"']+)["']/i);
  if (langMatch) {
    language = langMatch[1].trim();
  }

  // Extract <meta> tags
  const metaRegex = /<meta\b([^>]+)\/?>/gi;
  let metaMatch: RegExpExecArray | null;

  while ((metaMatch = metaRegex.exec(html)) !== null) {
    const metaAttrs = metaMatch[1];
    const nameMatch = metaAttrs.match(/\b(?:name|property|http-equiv)=["']([^"']+)["']/i);
    const contentMatch = metaAttrs.match(/\bcontent=["']([^"']*)["']/i);

    if (nameMatch && contentMatch) {
      const key = nameMatch[1].toLowerCase();
      const val = decodeHtmlEntities(contentMatch[1].trim());

      if (key === 'description') description = val;
      else if (key === 'author') author = val;
      else if (key === 'keywords') {
        keywords.push(...val.split(',').map(k => k.trim()).filter(Boolean));
      } else if (key.startsWith('og:')) {
        openGraph[key.substring(3)] = val;
        if (key === 'og:title' && !title) title = val;
        if (key === 'og:description' && !description) description = val;
        if (key === 'og:url' && !canonical) canonical = val;
      } else if (key.startsWith('twitter:')) {
        twitterCard[key.substring(8)] = val;
      } else if (key === 'article:published_time' || key === 'published_time') {
        publishedTime = val;
      } else if (key === 'article:modified_time' || key === 'modified_time') {
        modifiedTime = val;
      } else if (key === 'article:author') {
        if (!author) author = val;
      }
    }
  }

  // Extract <link rel="canonical" href="...">
  const canonicalMatch = html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*\bhref=["']([^"']+)["']/i);
  if (canonicalMatch) {
    canonical = decodeHtmlEntities(canonicalMatch[1].trim());
  }

  // Fallback to baseUrl if canonical is not specified
  if (!canonical && baseUrl) {
    canonical = baseUrl;
  }

  // Extract <time> tag if published time still missing
  if (!publishedTime) {
    const timeMatch = html.match(/<time\b[^>]*\bdatetime=["']([^"']+)["']/i);
    if (timeMatch) {
      publishedTime = timeMatch[1].trim();
    }
  }

  return {
    title,
    description,
    canonical: canonical || undefined,
    author: author || undefined,
    publishedTime: publishedTime || undefined,
    modifiedTime: modifiedTime || undefined,
    language: language || undefined,
    openGraph,
    twitterCard,
    keywords,
    wordCount: 0,
    characterCount: 0,
    readingTimeMinutes: 0,
    estimatedTokens: 0
  };
}

export function extractLinksAndImages(
  html: string,
  baseUrl?: string
): { links: DiscoveredLink[]; images: DiscoveredImage[] } {
  const links: DiscoveredLink[] = [];
  const images: DiscoveredImage[] = [];
  const tokens = tokenizeHtml(html);

  let currentLink: { href: string; text: string; rel?: string } | null = null;
  let baseHostname = '';
  if (baseUrl) {
    try {
      baseHostname = new URL(baseUrl).hostname;
    } catch {
      // ignore
    }
  }

  for (const token of tokens) {
    if (token.type === 'openTag' && token.tagName === 'a') {
      let href = token.attributes?.['href'] || '';
      const rel = token.attributes?.['rel'];

      if (href && !href.startsWith('#')) {
        href = resolveSafeUrlReference(href, baseUrl, 'link');
        if (href) {
          currentLink = { href, text: '', rel };
        }
      }
    } else if (token.type === 'closeTag' && token.tagName === 'a') {
      if (currentLink) {
        let isInternal = false;
        if (baseHostname && currentLink.href) {
          try {
            isInternal = new URL(currentLink.href).hostname === baseHostname;
          } catch {
            isInternal = false;
          }
        }
        links.push({
          href: currentLink.href,
          text: currentLink.text.trim(),
          isInternal,
          rel: currentLink.rel
        });
        currentLink = null;
      }
    } else if (token.type === 'text' && currentLink) {
      currentLink.text += decodeHtmlEntities(token.text || '');
    } else if (token.type === 'selfClosingTag' && token.tagName === 'img') {
      let src = token.attributes?.['src'] || '';
      const alt = token.attributes?.['alt'] || '';
      const title = token.attributes?.['title'];

      if (src) {
        src = resolveSafeUrlReference(src, baseUrl, 'image');
        if (src) {
          images.push({ src, alt, title });
        }
      }
    }
  }

  return { links, images };
}

function escapeYamlDoubleQuoted(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

export function extractMarkdown(
  rawHtml: string,
  options: ExtractorOptions = {}
): ExtractionResult {
  const metadata = extractMetadata(rawHtml, options.baseUrl);
  const { links, images } = extractLinksAndImages(rawHtml, options.baseUrl);

  // Clean HTML
  const cleaned = cleanHtml(rawHtml, {
    baseUrl: options.baseUrl,
    targetMainContent: options.targetMainContent,
    customRemoveSelectors: options.customRemoveSelectors
  });

  // Build AST
  const parser = new HtmlToAstParser(options.baseUrl);
  const ast = parser.parse(cleaned);

  // Generate Markdown
  let markdown = astToMarkdown(ast);

  // Strip links or images if requested
  if (options.stripLinks) {
    markdown = markdown.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
  }
  if (options.stripImages) {
    markdown = markdown.replace(/!\[[^\]]*\]\([^)]+\)/g, '');
  }

  // Extract structured artifacts
  const tables = extractTablesFromAst(ast);
  const codeBlocks = extractCodeBlocksFromAst(ast);

  // Extract headings
  const headings: { level: number; text: string; id?: string }[] = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  let hMatch: RegExpExecArray | null;
  while ((hMatch = headingRegex.exec(markdown)) !== null) {
    headings.push({
      level: hMatch[1].length,
      text: hMatch[2].trim()
    });
  }

  // Calculate text statistics
  const plainText = markdown
    .replace(/^#+\s+/gm, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .trim();

  const charCount = plainText.length;
  const wordCount = plainText.split(/\s+/).filter(Boolean).length;
  const readingTimeMinutes = Math.max(1, Math.round(wordCount / 200));
  // Accurate token estimation for English text (~3.8 characters per LLM token)
  const estimatedTokens = Math.ceil(charCount / 3.8);

  metadata.characterCount = charCount;
  metadata.wordCount = wordCount;
  metadata.readingTimeMinutes = readingTimeMinutes;
  metadata.estimatedTokens = estimatedTokens;

  // Add YAML Frontmatter if requested (default: true)
  if (options.includeFrontmatter !== false) {
    const frontmatterLines: string[] = ['---'];
    if (metadata.title) frontmatterLines.push(`title: "${escapeYamlDoubleQuoted(metadata.title)}"`);
    if (metadata.description) frontmatterLines.push(`description: "${escapeYamlDoubleQuoted(metadata.description)}"`);
    if (metadata.canonical) frontmatterLines.push(`canonical: "${escapeYamlDoubleQuoted(metadata.canonical)}"`);
    if (metadata.author) frontmatterLines.push(`author: "${escapeYamlDoubleQuoted(metadata.author)}"`);
    if (metadata.publishedTime) frontmatterLines.push(`published: "${escapeYamlDoubleQuoted(metadata.publishedTime)}"`);
    if (metadata.language) frontmatterLines.push(`language: "${escapeYamlDoubleQuoted(metadata.language)}"`);
    frontmatterLines.push(`words: ${wordCount}`);
    frontmatterLines.push(`tokens: ${estimatedTokens}`);
    frontmatterLines.push(`extractedAt: "${new Date().toISOString()}"`);
    frontmatterLines.push('---\n');

    markdown = frontmatterLines.join('\n') + '\n' + markdown;
  }

  return {
    markdown: markdown.trim(),
    text: plainText,
    metadata,
    links,
    images,
    tables,
    codeBlocks,
    headings
  };
}
