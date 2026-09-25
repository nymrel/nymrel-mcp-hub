/**
 * @nymrel/crawler-mesh
 * HTML Sanitizer & Noise Stripper
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

const NAMED_HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  '#39': "'",
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  laquo: '«',
  raquo: '»'
};

export function decodeHtmlEntities(text: string): string {
  if (!text) return '';
  return text.replace(
    /&(?:amp|lt|gt|quot|#39|apos|nbsp|mdash|ndash|hellip|laquo|raquo|#\d+|#x[0-9a-fA-F]+);/g,
    (entity) => {
      const token = entity.slice(1, -1);
      if (token.startsWith('#x')) {
        const codePoint = Number.parseInt(token.slice(2), 16);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
      }
      if (token.startsWith('#')) {
        const codePoint = Number.parseInt(token.slice(1), 10);
        return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
      }
      return NAMED_HTML_ENTITIES[token] ?? entity;
    }
  );
}

function stripHtmlComments(input: string): string {
  let output = '';
  let cursor = 0;

  while (cursor < input.length) {
    const start = input.indexOf('<!--', cursor);
    if (start === -1) {
      output += input.slice(cursor);
      break;
    }

    output += input.slice(cursor, start);
    const end = input.indexOf('-->', start + 4);
    if (end === -1) {
      break;
    }
    cursor = end + 3;
  }

  return output;
}

function readTagAttribute(tag: string, attributeName: string): string | undefined {
  const lower = tag.toLowerCase();
  const needle = attributeName.toLowerCase();
  let cursor = 0;

  while (cursor < lower.length) {
    const index = lower.indexOf(needle, cursor);
    if (index === -1) return undefined;

    const before = index === 0 ? '' : lower[index - 1];
    const after = lower[index + needle.length] ?? '';
    const isNameChar = (char: string) => /[a-z0-9_:-]/i.test(char);
    if ((before && isNameChar(before)) || (after && isNameChar(after))) {
      cursor = index + needle.length;
      continue;
    }

    let position = index + needle.length;
    while (position < tag.length && /\s/.test(tag[position])) position++;
    if (tag[position] !== '=') {
      cursor = index + needle.length;
      continue;
    }

    position++;
    while (position < tag.length && /\s/.test(tag[position])) position++;
    const quote = tag[position];
    if (quote === '"' || quote === "'") {
      const end = tag.indexOf(quote, position + 1);
      return end === -1 ? tag.slice(position + 1) : tag.slice(position + 1, end);
    }

    let end = position;
    while (end < tag.length && !/[\s>]/.test(tag[end])) end++;
    return tag.slice(position, end);
  }

  return undefined;
}

function stripTrackingImages(input: string): string {
  const lower = input.toLowerCase();
  let output = '';
  let cursor = 0;

  while (cursor < input.length) {
    let start = lower.indexOf('<img', cursor);
    while (start !== -1) {
      const boundary = lower[start + 4] ?? '';
      if (!boundary || /[\s/>]/.test(boundary)) break;
      start = lower.indexOf('<img', start + 4);
    }

    if (start === -1) {
      output += input.slice(cursor);
      break;
    }

    const end = input.indexOf('>', start + 4);
    if (end === -1) {
      output += input.slice(cursor);
      break;
    }

    output += input.slice(cursor, start);
    const tag = input.slice(start, end + 1);
    const width = readTagAttribute(tag, 'width')?.trim();
    const height = readTagAttribute(tag, 'height')?.trim();
    const style = readTagAttribute(tag, 'style')?.toLowerCase().replace(/\s+/g, '') ?? '';
    const tracking = width === '1' || height === '1' || style.includes('display:none');

    if (!tracking) output += tag;
    cursor = end + 1;
  }

  return output;
}

export interface CleanHtmlOptions {
  baseUrl?: string;
  targetMainContent?: boolean;
  customRemoveSelectors?: string[];
}

export function cleanHtml(html: string, options: CleanHtmlOptions = {}): string {
  let cleaned = html;

  // 1. Remove HTML comments
  cleaned = stripHtmlComments(cleaned);

  // 2. Remove script, style, noscript, svg, iframe, canvas, audio, video, template, object, embed
  const tagsToRemove = [
    'script', 'style', 'noscript', 'svg', 'iframe', 'canvas', 'audio',
    'video', 'template', 'object', 'embed', 'head'
  ];
  for (const tag of tagsToRemove) {
    const regex = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    cleaned = cleaned.replace(regex, '');
    // Self-closing / unclosed instances
    cleaned = cleaned.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
  }

  // 3. Remove layout containers (nav, header, footer, aside, menu, dialog)
  const layoutTags = ['nav', 'footer', 'aside', 'menu', 'dialog'];
  for (const tag of layoutTags) {
    const regex = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    cleaned = cleaned.replace(regex, '');
  }

  // 4. Remove tracking pixels (1x1 images, display:none images) with a bounded scanner.
  cleaned = stripTrackingImages(cleaned);

  // 5. Remove ad / cookie / popup / modal / newsletter / social banner elements by class/id/role heuristics
  const noisePatterns = [
    /(?:class|id)=["'][^"']*\b(ad-container|ad-wrapper|ad-banner|adsbygoogle|banner-ad|cookie-banner|cookie-consent|cookie-notice|popup-overlay|modal-overlay|newsletter-signup|social-share|share-buttons|site-footer|disclaimer-banner)\b[^"']*["']/gi,
    /role=["'](?:banner|navigation|dialog|alertdialog|contentinfo)["']/gi,
    /aria-hidden=["']true["']/gi
  ];

  // Helper: recursively strip matched divs/sections with noisy classes
  const noiseRegex = /<(div|section|aside|div|span|p|ul|ol|form)\b([^>]*\b(?:ad-container|ad-wrapper|ad-banner|adsbygoogle|cookie-banner|cookie-consent|cookie-notice|popup|modal|social-share|newsletter-signup)[^>]*)>([\s\S]*?)<\/\1>/gi;
  cleaned = cleaned.replace(noiseRegex, '');

  // 6. Target main content if enabled (<article>, <main>, or [role="main"])
  if (options.targetMainContent !== false) {
    const mainMatch = cleaned.match(/<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i);
    if (mainMatch && mainMatch[2].trim().length > 0) {
      cleaned = mainMatch[2];
    } else {
      const roleMainMatch = cleaned.match(/<([a-z0-9]+)\b[^>]*role=["']main["'][^>]*>([\s\S]*?)<\/\1>/i);
      if (roleMainMatch && roleMainMatch[2].trim().length > 0) {
        cleaned = roleMainMatch[2];
      }
    }
  }

  return cleaned.trim();
}
