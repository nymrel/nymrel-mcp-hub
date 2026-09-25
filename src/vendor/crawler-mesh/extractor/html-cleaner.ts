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

  // 4. Remove tracking pixels (1x1 images, display:none images)
  cleaned = cleaned.replace(/<img\b[^>]*\b(width=["']1["']|height=["']1["']|style=["'][^"']*display:\s*none[^"']*["'])[^>]*\/?>/gi, '');

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
