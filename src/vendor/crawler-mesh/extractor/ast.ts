/**
 * @nymrel/crawler-mesh
 * Semantic HTML AST Builder & Markdown Generator
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import type { AstNode, AstNodeType, ExtractedCodeBlock, ExtractedTable } from './types.js';
import { decodeHtmlEntities } from './html-cleaner.js';

interface HtmlToken {
  type: 'openTag' | 'closeTag' | 'selfClosingTag' | 'text' | 'comment';
  tagName?: string;
  attributes?: Record<string, string>;
  raw?: string;
  text?: string;
}

export function parseAttributes(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /([a-zA-Z0-9_:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match: RegExpExecArray | null;

  while ((match = attrRegex.exec(attrString)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attrs[name] = decodeHtmlEntities(value);
  }

  return attrs;
}

export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let cursor = 0;

  while (cursor < html.length) {
    if (html.startsWith('<!--', cursor)) {
      const end = html.indexOf('-->', cursor + 4);
      const stop = end === -1 ? html.length : end + 3;
      tokens.push({ type: 'comment', raw: html.slice(cursor, stop) });
      cursor = stop;
      continue;
    }

    if (html[cursor] !== '<') {
      const next = html.indexOf('<', cursor);
      const stop = next === -1 ? html.length : next;
      tokens.push({ type: 'text', text: html.slice(cursor, stop) });
      cursor = stop;
      continue;
    }

    const end = html.indexOf('>', cursor + 1);
    if (end === -1) {
      tokens.push({ type: 'text', text: html.slice(cursor) });
      break;
    }

    const raw = html.slice(cursor, end + 1);
    const inner = raw.slice(1, -1).trim();
    cursor = end + 1;

    if (!inner || inner.startsWith('!') || inner.startsWith('?')) {
      continue;
    }

    if (inner.startsWith('/')) {
      const closeMatch = /^\/\s*([\w:-]+)/.exec(inner);
      if (closeMatch) {
        tokens.push({ type: 'closeTag', tagName: closeMatch[1].toLowerCase() });
      }
      continue;
    }

    const openMatch = /^([\w:-]+)/.exec(inner);
    if (!openMatch) continue;

    const tagName = openMatch[1].toLowerCase();
    const remainder = inner.slice(openMatch[0].length);
    const explicitSelfClosing = /\/\s*$/.test(remainder);
    const attrString = explicitSelfClosing ? remainder.replace(/\/\s*$/, '') : remainder;
    const isSelfClosing =
      explicitSelfClosing || ['img', 'br', 'hr', 'input', 'meta', 'link'].includes(tagName);

    tokens.push({
      type: isSelfClosing ? 'selfClosingTag' : 'openTag',
      tagName,
      attributes: parseAttributes(attrString),
      raw
    });
  }

  return tokens;
}

const SAFE_LINK_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);
const SAFE_IMAGE_SCHEMES = new Set(['http:', 'https:']);

export function resolveSafeUrlReference(
  value: string,
  baseUrl?: string,
  kind: 'link' | 'image' = 'link'
): string {
  const raw = value.trim();
  if (!raw) return '';
  if (kind === 'link' && raw.startsWith('#')) return raw;

  const schemeMatch = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  const allowed = kind === 'image' ? SAFE_IMAGE_SCHEMES : SAFE_LINK_SCHEMES;
  if (schemeMatch && !allowed.has(`${schemeMatch[1].toLowerCase()}:`)) {
    return '';
  }

  if (!baseUrl || raw.startsWith('#')) return raw;

  try {
    const resolved = new URL(raw, baseUrl);
    return allowed.has(resolved.protocol.toLowerCase()) ? resolved.toString() : '';
  } catch {
    return '';
  }
}

function escapeMarkdownDestination(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/[\r\n]/g, '');
}

function escapeMarkdownLabel(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function escapeMarkdownTitle(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/[\r\n]+/g, ' ');
}

export class HtmlToAstParser {
  private baseUrl?: string;

  constructor(baseUrl?: string) {
    this.baseUrl = baseUrl;
  }

  private resolveUrl(href: string): string {
    return resolveSafeUrlReference(href, this.baseUrl, 'link');
  }

  private resolveImageUrl(src: string): string {
    return resolveSafeUrlReference(src, this.baseUrl, 'image');
  }

  public parse(html: string): AstNode {
    const tokens = tokenizeHtml(html);
    const root: AstNode = { type: 'root', children: [] };
    const stack: { node: AstNode; tagName?: string }[] = [{ node: root }];

    let inPre = false;
    let preContent = '';
    let preLang = '';

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const currentParent = stack[stack.length - 1].node;

      if (token.type === 'comment') {
        continue;
      }

      if (inPre) {
        if (token.type === 'closeTag' && (token.tagName === 'pre' || token.tagName === 'code')) {
          if (token.tagName === 'pre') {
            inPre = false;
            currentParent.children?.push({
              type: 'codeBlock',
              language: preLang,
              value: decodeHtmlEntities(preContent.trimEnd())
            });
            preContent = '';
            preLang = '';
          }
        } else {
          preContent += token.raw || token.text || '';
        }
        continue;
      }

      if (token.type === 'openTag' && token.tagName === 'pre') {
        inPre = true;
        preContent = '';
        preLang = '';
        // Check if next token is <code class="language-xyz">
        if (tokens[i + 1]?.type === 'openTag' && tokens[i + 1]?.tagName === 'code') {
          const codeClass = tokens[i + 1]?.attributes?.['class'] || '';
          const langMatch = codeClass.match(/language-([a-zA-Z0-9_-]+)/i);
          if (langMatch) {
            preLang = langMatch[1];
          }
          i++; // Skip inner code tag
        }
        continue;
      }

      if (token.type === 'openTag') {
        const tagName = token.tagName!;
        let node: AstNode | null = null;

        if (/^h([1-6])$/.test(tagName)) {
          const level = parseInt(tagName[1], 10);
          node = { type: 'heading', level, children: [] };
        } else if (tagName === 'p') {
          node = { type: 'paragraph', children: [] };
        } else if (tagName === 'blockquote') {
          node = { type: 'blockquote', children: [] };
        } else if (tagName === 'ul' || tagName === 'ol') {
          node = {
            type: 'list',
            ordered: tagName === 'ol',
            start: token.attributes?.['start'] ? parseInt(token.attributes['start'], 10) : 1,
            children: []
          };
        } else if (tagName === 'li') {
          node = { type: 'listItem', children: [] };
        } else if (tagName === 'table') {
          node = { type: 'table', children: [] };
        } else if (tagName === 'thead') {
          node = { type: 'tableHead', children: [] };
        } else if (tagName === 'tbody') {
          node = { type: 'tableBody', children: [] };
        } else if (tagName === 'tr') {
          node = { type: 'tableRow', children: [] };
        } else if (tagName === 'th' || tagName === 'td') {
          node = {
            type: 'tableCell',
            isHeader: tagName === 'th',
            align: (token.attributes?.['align'] as any) || null,
            children: []
          };
        } else if (tagName === 'code') {
          node = { type: 'inlineCode', children: [] };
        } else if (tagName === 'a') {
          const href = this.resolveUrl(token.attributes?.['href'] || '');
          if (href) {
            node = { type: 'link', href, title: token.attributes?.['title'], children: [] };
          }
        } else if (tagName === 'strong' || tagName === 'b') {
          node = { type: 'strong', children: [] };
        } else if (tagName === 'em' || tagName === 'i') {
          node = { type: 'emphasis', children: [] };
        } else if (tagName === 'del' || tagName === 's' || tagName === 'strike') {
          node = { type: 'strikethrough', children: [] };
        } else {
          // Pass-through container (div, span, section, etc.)
          node = { type: 'paragraph', children: [] };
        }

        if (node) {
          if (!currentParent.children) currentParent.children = [];
          currentParent.children.push(node);
          stack.push({ node, tagName });
        }
      } else if (token.type === 'closeTag') {
        const tagName = token.tagName!;
        // Find matching tag on stack
        for (let j = stack.length - 1; j > 0; j--) {
          if (stack[j].tagName === tagName) {
            stack.splice(j);
            break;
          }
        }
      } else if (token.type === 'selfClosingTag') {
        const tagName = token.tagName!;
        if (tagName === 'br') {
          if (!currentParent.children) currentParent.children = [];
          currentParent.children.push({ type: 'br' });
        } else if (tagName === 'hr') {
          if (!currentParent.children) currentParent.children = [];
          currentParent.children.push({ type: 'hr' });
        } else if (tagName === 'img') {
          const src = this.resolveImageUrl(token.attributes?.['src'] || '');
          const alt = token.attributes?.['alt'] || '';
          const title = token.attributes?.['title'];
          if (src) {
            if (!currentParent.children) currentParent.children = [];
            currentParent.children.push({ type: 'image', src, alt, title });
          }
        }
      } else if (token.type === 'text') {
        const text = decodeHtmlEntities(token.text || '');
        if (text) {
          if (!currentParent.children) currentParent.children = [];
          currentParent.children.push({ type: 'text', value: text });
        }
      }
    }

    return root;
  }
}

export function astToMarkdown(node: AstNode, listDepth: number = 0, isInsideTable: boolean = false): string {
  if (!node) return '';

  switch (node.type) {
    case 'root': {
      return (node.children || [])
        .map(child => astToMarkdown(child, listDepth, isInsideTable))
        .filter(s => s.trim().length > 0)
        .join('\n\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
    }

    case 'heading': {
      const hashes = '#'.repeat(node.level || 1);
      const text = renderInlineText(node.children || [], isInsideTable);
      return `${hashes} ${text}`;
    }

    case 'paragraph': {
      const text = renderInlineText(node.children || [], isInsideTable);
      return text.trim();
    }

    case 'blockquote': {
      const inner = (node.children || [])
        .map(child => astToMarkdown(child, listDepth, isInsideTable))
        .filter(Boolean)
        .join('\n\n');
      return inner
        .split('\n')
        .map(line => `> ${line}`)
        .join('\n');
    }

    case 'list': {
      const isOrdered = node.ordered ?? false;
      let counter = node.start ?? 1;
      const items = (node.children || []).map(child => {
        const prefix = isOrdered ? `${counter++}. ` : '- ';
        const indent = '  '.repeat(listDepth);
        const itemContent = astToMarkdown(child, listDepth + 1, isInsideTable);
        return `${indent}${prefix}${itemContent}`;
      });
      return items.join('\n');
    }

    case 'listItem': {
      return renderInlineText(node.children || [], isInsideTable);
    }

    case 'table': {
      return renderTableToMarkdown(node);
    }

    case 'codeBlock': {
      const lang = node.language || '';
      const code = node.value || '';
      return `\`\`\`${lang}\n${code}\n\`\`\``;
    }

    case 'hr': {
      return '---';
    }

    case 'br': {
      return '\n';
    }

    default:
      return renderInlineText([node], isInsideTable);
  }
}

function renderInlineText(children: AstNode[], isInsideTable: boolean): string {
  let result = '';

  for (const child of children) {
    switch (child.type) {
      case 'text':
        let val = child.value || '';
        if (isInsideTable) {
          val = val
            .replace(/\\/g, '\\\\')
            .replace(/\|/g, '\\|')
            .replace(/\r?\n/g, ' ');
        }
        result += val;
        break;
      case 'strong':
        result += `**${renderInlineText(child.children || [], isInsideTable).trim()}**`;
        break;
      case 'emphasis':
        result += `*${renderInlineText(child.children || [], isInsideTable).trim()}*`;
        break;
      case 'strikethrough':
        result += `~~${renderInlineText(child.children || [], isInsideTable).trim()}~~`;
        break;
      case 'inlineCode':
        result += `\`${renderInlineText(child.children || [], isInsideTable).trim()}\``;
        break;
      case 'link':
        const linkText = renderInlineText(child.children || [], isInsideTable).trim() || child.href || '';
        result += `[${linkText}](${escapeMarkdownDestination(child.href || '')})`;
        break;
      case 'image':
        result += `![${escapeMarkdownLabel(child.alt || '')}](${escapeMarkdownDestination(child.src || '')}${child.title ? ` "${escapeMarkdownTitle(child.title)}"` : ''})`;
        break;
      case 'br':
        result += isInsideTable ? ' ' : '\n';
        break;
      case 'hr':
        result += '\n---\n';
        break;
      default:
        if (child.children) {
          result += renderInlineText(child.children, isInsideTable);
        }
        break;
    }
  }

  return result;
}

function renderTableToMarkdown(tableNode: AstNode): string {
  const rows: AstNode[] = [];

  function collectRows(node: AstNode) {
    if (node.type === 'tableRow') {
      rows.push(node);
    } else if (node.children) {
      for (const child of node.children) {
        collectRows(child);
      }
    }
  }

  collectRows(tableNode);
  if (rows.length === 0) return '';

  const matrix: string[][] = [];
  let maxCols = 0;

  for (const row of rows) {
    const rowCells: string[] = [];
    for (const cell of row.children || []) {
      if (cell.type === 'tableCell') {
        const text = renderInlineText(cell.children || [], true).trim();
        rowCells.push(text || ' ');
      }
    }
    if (rowCells.length > maxCols) maxCols = rowCells.length;
    matrix.push(rowCells);
  }

  if (maxCols === 0) return '';

  // Pad rows to equal column length
  for (const row of matrix) {
    while (row.length < maxCols) {
      row.push(' ');
    }
  }

  // Calculate column widths
  const colWidths: number[] = new Array(maxCols).fill(3);
  for (const row of matrix) {
    for (let c = 0; c < maxCols; c++) {
      colWidths[c] = Math.max(colWidths[c], row[c].length);
    }
  }

  const lines: string[] = [];
  // First row
  const headerRow = matrix[0];
  const headerLine = '| ' + headerRow.map((cell, c) => cell.padEnd(colWidths[c])).join(' | ') + ' |';
  const separatorLine = '| ' + colWidths.map(w => '-'.repeat(w)).join(' | ') + ' |';

  lines.push(headerLine);
  lines.push(separatorLine);

  for (let r = 1; r < matrix.length; r++) {
    const rowLine = '| ' + matrix[r].map((cell, c) => cell.padEnd(colWidths[c])).join(' | ') + ' |';
    lines.push(rowLine);
  }

  return lines.join('\n');
}

export function extractTablesFromAst(tableNode: AstNode): ExtractedTable[] {
  const tables: ExtractedTable[] = [];

  function visit(node: AstNode) {
    if (node.type === 'table') {
      const rows: string[][] = [];
      let headers: string[] = [];

      for (const section of node.children || []) {
        for (const row of section.children || (section.type === 'tableRow' ? [section] : [])) {
          if (row.type === 'tableRow') {
            const cells = (row.children || [])
              .filter(c => c.type === 'tableCell')
              .map(c => renderInlineText(c.children || [], true).trim());

            const isHead = (row.children || []).some(c => c.isHeader) || section.type === 'tableHead';
            if (isHead && headers.length === 0) {
              headers = cells;
            } else {
              rows.push(cells);
            }
          }
        }
      }

      if (headers.length === 0 && rows.length > 0) {
        headers = rows.shift() || [];
      }

      tables.push({ headers, rows });
    } else if (node.children) {
      for (const child of node.children) {
        visit(child);
      }
    }
  }

  visit(tableNode);
  return tables;
}

export function extractCodeBlocksFromAst(node: AstNode): ExtractedCodeBlock[] {
  const blocks: ExtractedCodeBlock[] = [];

  function visit(n: AstNode) {
    if (n.type === 'codeBlock') {
      blocks.push({
        language: n.language || 'text',
        code: n.value || ''
      });
    } else if (n.children) {
      for (const child of n.children) {
        visit(child);
      }
    }
  }

  visit(node);
  return blocks;
}
