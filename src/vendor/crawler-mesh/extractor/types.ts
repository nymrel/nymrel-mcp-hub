/**
 * @nymrel/crawler-mesh
 * Extractor Types
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC
 */

import type {
  DiscoveredImage,
  DiscoveredLink,
  DocumentMetadata,
  ExtractedCodeBlock,
  ExtractedTable,
  ExtractionResult,
  ExtractorOptions
} from '../types.js';

export type {
  DiscoveredImage,
  DiscoveredLink,
  DocumentMetadata,
  ExtractedCodeBlock,
  ExtractedTable,
  ExtractionResult,
  ExtractorOptions
};

export type AstNodeType =
  | 'root'
  | 'heading'
  | 'paragraph'
  | 'blockquote'
  | 'list'
  | 'listItem'
  | 'table'
  | 'tableHead'
  | 'tableBody'
  | 'tableRow'
  | 'tableCell'
  | 'codeBlock'
  | 'inlineCode'
  | 'link'
  | 'image'
  | 'strong'
  | 'emphasis'
  | 'strikethrough'
  | 'hr'
  | 'br'
  | 'text';

export interface AstNode {
  type: AstNodeType;
  level?: number; // 1-6 for headings
  ordered?: boolean; // for lists
  start?: number; // for ordered lists
  href?: string; // for links
  src?: string; // for images
  alt?: string; // for images
  title?: string;
  language?: string; // for codeBlock
  align?: 'left' | 'center' | 'right' | null; // for tableCell
  isHeader?: boolean; // for tableCell
  value?: string; // for text, inlineCode, codeBlock
  children?: AstNode[];
}
