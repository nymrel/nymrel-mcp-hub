"""
nymrel_crawler_mesh.extractor
Semantic HTML to Clean Markdown & Structured Data Extractor
Copyright (c) 2026 Nymrel / JalenBuilds LLC
"""

import html
import math
import re
from datetime import datetime, timezone
from typing import Dict, List, Optional, Tuple
from urllib.parse import urljoin, urlparse

from .models import (
    DiscoveredImage,
    DiscoveredLink,
    DocumentMetadata,
    ExtractedCodeBlock,
    ExtractedTable,
    ExtractionResult,
)


def decode_html(text: str) -> str:
    if not text:
        return ""
    return html.unescape(text)


SAFE_LINK_SCHEMES = {"http", "https", "mailto", "tel"}
SAFE_IMAGE_SCHEMES = {"http", "https"}


def _strip_html_comments(value: str) -> str:
    output = []
    cursor = 0
    while cursor < len(value):
        start = value.find("<!--", cursor)
        if start < 0:
            output.append(value[cursor:])
            break
        output.append(value[cursor:start])
        end = value.find("-->", start + 4)
        if end < 0:
            break
        cursor = end + 3
    return "".join(output)


def _resolve_safe_reference(
    value: str,
    base_url: Optional[str],
    allowed_schemes: set[str],
    *,
    allow_fragment: bool = False,
) -> str:
    raw = value.strip()
    if not raw:
        return ""
    if allow_fragment and raw.startswith("#"):
        return raw

    parsed = urlparse(raw)
    if parsed.scheme and parsed.scheme.lower() not in allowed_schemes:
        return ""

    candidate = urljoin(base_url, raw) if base_url else raw
    parsed_candidate = urlparse(candidate)
    if parsed_candidate.scheme and parsed_candidate.scheme.lower() not in allowed_schemes:
        return ""
    return candidate


def _escape_markdown_destination(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace("(", "\\(")
        .replace(")", "\\)")
        .replace("\r", "")
        .replace("\n", "")
    )


def _escape_markdown_label(value: str) -> str:
    return value.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")


def _escape_yaml_double_quoted(value: str) -> str:
    return (
        value.replace("\\", "\\\\")
        .replace('"', '\\"')
        .replace("\r", "\\r")
        .replace("\n", "\\n")
    )


def _read_tag_attribute(tag: str, attribute_name: str) -> Optional[str]:
    lower = tag.lower()
    needle = attribute_name.lower()
    cursor = 0

    while cursor < len(lower):
        index = lower.find(needle, cursor)
        if index < 0:
            return None

        before = lower[index - 1] if index > 0 else ""
        after_index = index + len(needle)
        after = lower[after_index] if after_index < len(lower) else ""

        def is_name_char(char: str) -> bool:
            return char.isalnum() or char in "_:-"

        if (before and is_name_char(before)) or (after and is_name_char(after)):
            cursor = after_index
            continue

        position = after_index
        while position < len(tag) and tag[position].isspace():
            position += 1
        if position >= len(tag) or tag[position] != "=":
            cursor = after_index
            continue

        position += 1
        while position < len(tag) and tag[position].isspace():
            position += 1
        if position >= len(tag):
            return ""

        quote = tag[position]
        if quote in {'"', "'"}:
            end = tag.find(quote, position + 1)
            return tag[position + 1:] if end < 0 else tag[position + 1:end]

        end = position
        while end < len(tag) and not tag[end].isspace() and tag[end] != ">":
            end += 1
        return tag[position:end]

    return None


def _strip_tracking_images(value: str) -> str:
    lower = value.lower()
    output = []
    cursor = 0

    while cursor < len(value):
        start = lower.find("<img", cursor)
        while start >= 0:
            boundary_index = start + 4
            boundary = lower[boundary_index] if boundary_index < len(lower) else ""
            if not boundary or boundary.isspace() or boundary in "/>":
                break
            start = lower.find("<img", start + 4)

        if start < 0:
            output.append(value[cursor:])
            break

        end = value.find(">", start + 4)
        if end < 0:
            output.append(value[cursor:])
            break

        output.append(value[cursor:start])
        tag = value[start:end + 1]
        width = (_read_tag_attribute(tag, "width") or "").strip()
        height = (_read_tag_attribute(tag, "height") or "").strip()
        style = "".join((_read_tag_attribute(tag, "style") or "").lower().split())
        if width != "1" and height != "1" and "display:none" not in style:
            output.append(tag)
        cursor = end + 1

    return "".join(output)


def clean_html(raw_html: str, target_main_content: bool = True) -> str:
    cleaned = raw_html

    # 1. Remove comments with a bounded scanner rather than a backtracking regex.
    cleaned = _strip_html_comments(cleaned)

    # 2. Remove script, style, noscript, svg, iframe, canvas, audio, video, template, head
    tags_to_remove = [
        "script", "style", "noscript", "svg", "iframe", "canvas",
        "audio", "video", "template", "object", "embed", "head"
    ]
    for tag in tags_to_remove:
        cleaned = re.sub(rf"<{tag}\b[^>]*>[\s\S]*?</{tag}>", "", cleaned, flags=re.IGNORECASE)
        cleaned = re.sub(rf"<{tag}\b[^>]*\/?>", "", cleaned, flags=re.IGNORECASE)

    # 3. Remove layout containers (nav, footer, aside, menu, dialog)
    for tag in ["nav", "footer", "aside", "menu", "dialog"]:
        cleaned = re.sub(rf"<{tag}\b[^>]*>[\s\S]*?</{tag}>", "", cleaned, flags=re.IGNORECASE)

    # 4. Remove tracking pixels (1x1 images, display:none images) with a bounded scanner.
    cleaned = _strip_tracking_images(cleaned)

    # 5. Remove ad / cookie / popup / modal / newsletter / social banner elements
    noise_regex = (
        r"<(div|section|aside|span|p|ul|ol|form)\b([^>]*\b"
        r"(?:ad-container|ad-wrapper|ad-banner|adsbygoogle|cookie-banner|cookie-consent|cookie-notice|popup|modal|social-share|newsletter-signup)[^>]*)>"
        r"([\s\S]*?)</\1>"
    )
    cleaned = re.sub(noise_regex, "", cleaned, flags=re.IGNORECASE)

    # 6. Target main content if enabled (<article>, <main>, or [role="main"])
    if target_main_content:
        main_match = re.search(r"<(main|article)\b[^>]*>([\s\S]*?)</\1>", cleaned, flags=re.IGNORECASE)
        if main_match and len(main_match.group(2).strip()) > 0:
            cleaned = main_match.group(2)
        else:
            role_match = re.search(r"<([a-z0-9]+)\b[^>]*role=[\"']main[\"'][^>]*>([\s\S]*?)</\1>", cleaned, flags=re.IGNORECASE)
            if role_match and len(role_match.group(2).strip()) > 0:
                cleaned = role_match.group(2)

    return cleaned.strip()


def extract_metadata(raw_html: str, base_url: Optional[str] = None) -> DocumentMetadata:
    title = ""
    description = ""
    canonical = None
    author = None
    published_time = None
    modified_time = None
    language = None
    open_graph: Dict[str, str] = {}
    twitter_card: Dict[str, str] = {}
    keywords: List[str] = []

    # Title
    t_match = re.search(r"<title\b[^>]*>([\s\S]*?)</title>", raw_html, flags=re.IGNORECASE)
    if t_match:
        title = decode_html(t_match.group(1).strip())

    # Language
    l_match = re.search(r"<html\b[^>]*\blang=[\"']([^\"']+)[\"']", raw_html, flags=re.IGNORECASE)
    if l_match:
        language = l_match.group(1).strip()

    # Meta tags
    meta_tags = re.findall(r"<meta\b([^>]+)\/?>", raw_html, flags=re.IGNORECASE)
    for meta_attr in meta_tags:
        name_match = re.search(r"\b(?:name|property|http-equiv)=[\"']([^\"']+)[\"']", meta_attr, flags=re.IGNORECASE)
        content_match = re.search(r"\bcontent=[\"']([^\"']*)[\"']", meta_attr, flags=re.IGNORECASE)

        if name_match and content_match:
            key = name_match.group(1).lower()
            val = decode_html(content_match.group(1).strip())

            if key == "description":
                description = val
            elif key == "author":
                author = val
            elif key == "keywords":
                keywords.extend([k.strip() for k in val.split(",") if k.strip()])
            elif key.startswith("og:"):
                og_key = key[3:]
                open_graph[og_key] = val
                if og_key == "title" and not title:
                    title = val
                elif og_key == "description" and not description:
                    description = val
                elif og_key == "url" and not canonical:
                    canonical = val
            elif key.startswith("twitter:"):
                twitter_card[key[8:]] = val
            elif key in ("article:published_time", "published_time"):
                published_time = val
            elif key in ("article:modified_time", "modified_time"):
                modified_time = val
            elif key == "article:author" and not author:
                author = val

    # Canonical link
    c_match = re.search(r"<link\b[^>]*\brel=[\"']canonical[\"'][^>]*\bhref=[\"']([^\"']+)[\"']", raw_html, flags=re.IGNORECASE)
    if c_match:
        canonical = decode_html(c_match.group(1).strip())

    if not canonical and base_url:
        canonical = base_url

    if not published_time:
        time_match = re.search(r"<time\b[^>]*\bdatetime=[\"']([^\"']+)[\"']", raw_html, flags=re.IGNORECASE)
        if time_match:
            published_time = time_match.group(1).strip()

    return DocumentMetadata(
        title=title,
        description=description,
        canonical=canonical,
        author=author,
        published_time=published_time,
        modified_time=modified_time,
        language=language,
        open_graph=open_graph,
        twitter_card=twitter_card,
        keywords=keywords,
    )


def extract_links_and_images(
    raw_html: str, base_url: Optional[str] = None
) -> Tuple[List[DiscoveredLink], List[DiscoveredImage]]:
    links: List[DiscoveredLink] = []
    images: List[DiscoveredImage] = []

    base_hostname = urlparse(base_url).hostname if base_url else None

    # Links
    a_matches = re.finditer(r"<a\b([^>]*)>([\s\S]*?)</a>", raw_html, flags=re.IGNORECASE)
    for m in a_matches:
        attrs = m.group(1)
        text = decode_html(re.sub(r"<[^>]+>", "", m.group(2)).strip())
        href_match = re.search(r'\bhref=["\']([^"\']+)["\']', attrs, flags=re.IGNORECASE)
        rel_match = re.search(r'\brel=["\']([^"\']+)["\']', attrs, flags=re.IGNORECASE)

        if href_match:
            href = _resolve_safe_reference(
                href_match.group(1),
                base_url,
                SAFE_LINK_SCHEMES,
                allow_fragment=False,
            )
            if href:
                is_internal = False
                if base_hostname:
                    is_internal = urlparse(href).hostname == base_hostname

                links.append(
                    DiscoveredLink(
                        href=href,
                        text=text,
                        is_internal=is_internal,
                        rel=rel_match.group(1) if rel_match else None,
                    )
                )

    # Images
    img_matches = re.finditer(r"<img\b([^>]+)\/?>", raw_html, flags=re.IGNORECASE)
    for m in img_matches:
        attrs = m.group(1)
        src_match = re.search(r'\bsrc=["\']([^"\']+)["\']', attrs, flags=re.IGNORECASE)
        alt_match = re.search(r'\balt=["\']([^"\']*)["\']', attrs, flags=re.IGNORECASE)
        title_match = re.search(r'\btitle=["\']([^"\']*)["\']', attrs, flags=re.IGNORECASE)

        if src_match:
            src = _resolve_safe_reference(
                src_match.group(1),
                base_url,
                SAFE_IMAGE_SCHEMES,
            )
            if src:
                images.append(
                    DiscoveredImage(
                        src=src,
                        alt=decode_html(alt_match.group(1)) if alt_match else "",
                        title=decode_html(title_match.group(1)) if title_match else None,
                    )
                )

    return links, images


def html_to_markdown(html_content: str, base_url: Optional[str] = None) -> Tuple[str, List[ExtractedTable], List[ExtractedCodeBlock]]:
    tables: List[ExtractedTable] = []
    code_blocks: List[ExtractedCodeBlock] = []

    text = html_content

    # 1. Code blocks: <pre><code class="language-py">...</code></pre>
    def replace_code_block(match: re.Match) -> str:
        attrs = match.group(1) or ""
        inner = match.group(2) or ""
        lang = ""
        lang_match = re.search(r'class=["\'][^"\']*language-([a-zA-Z0-9_-]+)', attrs, re.I)
        if lang_match:
            lang = lang_match.group(1)

        clean_code = decode_html(re.sub(r"<[^>]+>", "", inner)).strip("\r\n")
        code_blocks.append(ExtractedCodeBlock(language=lang or "text", code=clean_code))
        return f"\n\n```{lang}\n{clean_code}\n```\n\n"

    text = re.sub(
        r'<pre\b[^>]*>(?:\s*<code\b([^>]*)>)?([\s\S]*?)(?:</code>\s*)?</pre>',
        replace_code_block,
        text,
        flags=re.IGNORECASE,
    )

    # 2. Tables: <table>...</table>
    def replace_table(match: re.Match) -> str:
        table_html = match.group(0)
        rows_data: List[List[str]] = []
        headers: List[str] = []

        row_matches = re.findall(r"<tr\b[^>]*>([\s\S]*?)</tr>", table_html, re.I)
        for r_idx, row_content in enumerate(row_matches):
            cells = re.findall(r"<(th|td)\b[^>]*>([\s\S]*?)</\1>", row_content, re.I)
            row_cells = [decode_html(re.sub(r"<[^>]+>", "", c[1]).strip()) for c in cells]
            if not row_cells:
                continue

            is_header_row = any(c[0].lower() == "th" for c in cells) or (r_idx == 0 and not headers)
            if is_header_row and not headers:
                headers = row_cells
            else:
                rows_data.append(row_cells)

        if not headers and rows_data:
            headers = rows_data.pop(0)

        if not headers:
            return ""

        tables.append(ExtractedTable(headers=headers, rows=rows_data))

        max_cols = max(len(headers), max((len(r) for r in rows_data), default=0))
        # Pad
        headers.extend([" "] * (max_cols - len(headers)))
        for r in rows_data:
            r.extend([" "] * (max_cols - len(r)))

        col_widths = [max(3, len(h)) for h in headers]
        for r in rows_data:
            for c_idx, cell in enumerate(r):
                col_widths[c_idx] = max(col_widths[c_idx], len(cell))

        lines = []
        header_line = "| " + " | ".join(h.ljust(col_widths[i]) for i, h in enumerate(headers)) + " |"
        sep_line = "| " + " | ".join("-" * col_widths[i] for i in range(max_cols)) + " |"
        lines.append(header_line)
        lines.append(sep_line)

        for r in rows_data:
            r_line = "| " + " | ".join(cell.ljust(col_widths[i]) for i, cell in enumerate(r)) + " |"
            lines.append(r_line)

        return "\n\n" + "\n".join(lines) + "\n\n"

    text = re.sub(r"<table\b[^>]*>([\s\S]*?)</table>", replace_table, text, flags=re.IGNORECASE)

    # 3. Headings: <h1> to <h6>
    for level in range(6, 0, -1):
        hashes = "#" * level
        text = re.sub(
            rf"<h{level}\b[^>]*>([\s\S]*?)</h{level}>",
            lambda m: f"\n\n{hashes} {decode_html(re.sub(r'<[^>]+>', '', m.group(1)).strip())}\n\n",
            text,
            flags=re.IGNORECASE,
        )

    # 4. Blockquotes
    text = re.sub(
        r"<blockquote\b[^>]*>([\s\S]*?)</blockquote>",
        lambda m: "\n\n" + "\n".join(f"> {line}" for line in decode_html(re.sub(r"<[^>]+>", "", m.group(1))).strip().splitlines()) + "\n\n",
        text,
        flags=re.IGNORECASE,
    )

    # 5. Lists: <ul>, <ol>, <li>
    text = re.sub(r"<li\b[^>]*>([\s\S]*?)</li>", lambda m: f"\n- {m.group(1).strip()}", text, flags=re.IGNORECASE)
    text = re.sub(r"</?(ul|ol)\b[^>]*>", "\n", text, flags=re.IGNORECASE)

    # 6. Formatting: bold, italic, strikethrough, inline code
    text = re.sub(r"<(strong|b)\b[^>]*>([\s\S]*?)</\1>", lambda m: f"**{m.group(2).strip()}**", text, flags=re.IGNORECASE)
    text = re.sub(r"<(em|i)\b[^>]*>([\s\S]*?)</\1>", lambda m: f"*{m.group(2).strip()}*", text, flags=re.IGNORECASE)
    text = re.sub(r"<(del|s|strike)\b[^>]*>([\s\S]*?)</\1>", lambda m: f"~~{m.group(2).strip()}~~", text, flags=re.IGNORECASE)
    text = re.sub(r"<code\b[^>]*>([\s\S]*?)</code>", lambda m: f"`{decode_html(m.group(1))}`", text, flags=re.IGNORECASE)

    # 7. Links: <a href="...">...</a>
    def replace_link(m: re.Match) -> str:
        attrs = m.group(1)
        inner = m.group(2).strip()
        h_match = re.search(r'\bhref=["\']([^"\']+)["\']', attrs, re.I)
        if not h_match:
            return inner
        href = _resolve_safe_reference(
            h_match.group(1),
            base_url,
            SAFE_LINK_SCHEMES,
            allow_fragment=True,
        )
        if not href:
            return inner
        clean_inner = re.sub(r"<[^>]+>", "", inner).strip() or href
        return f"[{clean_inner}]({_escape_markdown_destination(href)})"

    text = re.sub(r"<a\b([^>]*)>([\s\S]*?)</a>", replace_link, text, flags=re.IGNORECASE)

    # 8. Images: <img src="..." alt="...">
    def replace_img(m: re.Match) -> str:
        attrs = m.group(1)
        s_match = re.search(r'\bsrc=["\']([^"\']+)["\']', attrs, re.I)
        a_match = re.search(r'\balt=["\']([^"\']*)["\']', attrs, re.I)
        if not s_match:
            return ""
        src = _resolve_safe_reference(
            s_match.group(1),
            base_url,
            SAFE_IMAGE_SCHEMES,
        )
        if not src:
            return ""
        alt = decode_html(a_match.group(1)) if a_match else ""
        return f"![{_escape_markdown_label(alt)}]({_escape_markdown_destination(src)})"

    text = re.sub(r"<img\b([^>]+)\/?>", replace_img, text, flags=re.IGNORECASE)

    # 9. Paragraphs, breaks, hr
    text = re.sub(r"<hr\b[^>]*\/?>", "\n\n---\n\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<br\b[^>]*\/?>", "\n", text, flags=re.IGNORECASE)
    text = re.sub(r"<p\b[^>]*>([\s\S]*?)</p>", lambda m: f"\n\n{m.group(1).strip()}\n\n", text, flags=re.IGNORECASE)

    # 10. Strip remaining HTML tags
    text = re.sub(r"<[^>]+>", "", text)
    text = decode_html(text)

    # Clean whitespace
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()

    return text, tables, code_blocks


def extract_markdown(
    raw_html: str,
    base_url: Optional[str] = None,
    include_frontmatter: bool = True,
    strip_links: bool = False,
    strip_images: bool = False,
    target_main_content: bool = True,
) -> ExtractionResult:
    metadata = extract_metadata(raw_html, base_url)
    links, images = extract_links_and_images(raw_html, base_url)

    cleaned = clean_html(raw_html, target_main_content=target_main_content)
    markdown, tables, code_blocks = html_to_markdown(cleaned, base_url)

    if strip_links:
        markdown = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", markdown)
    if strip_images:
        markdown = re.sub(r"!\[[^\]]*\]\([^)]+\)", "", markdown)

    # Headings
    headings = []
    for h_match in re.finditer(r"^(#{1,6})\s+(.+)$", markdown, re.MULTILINE):
        headings.append({"level": len(h_match.group(1)), "text": h_match.group(2).strip()})

    # Stats
    plain_text = re.sub(r"^#+\s+", "", markdown, flags=re.MULTILINE)
    plain_text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", plain_text)
    plain_text = re.sub(r"[*_~`]", "", plain_text).strip()

    char_count = len(plain_text)
    words = plain_text.split()
    word_count = len(words)
    reading_time = max(1, round(word_count / 200))
    estimated_tokens = math.ceil(char_count / 3.8)

    metadata.character_count = char_count
    metadata.word_count = word_count
    metadata.reading_time_minutes = reading_time
    metadata.estimated_tokens = estimated_tokens

    if include_frontmatter:
        fm = ["---"]
        if metadata.title:
            fm.append(f'title: "{_escape_yaml_double_quoted(metadata.title)}"')
        if metadata.description:
            fm.append(f'description: "{_escape_yaml_double_quoted(metadata.description)}"')
        if metadata.canonical:
            fm.append(f'canonical: "{_escape_yaml_double_quoted(metadata.canonical)}"')
        if metadata.author:
            fm.append(f'author: "{_escape_yaml_double_quoted(metadata.author)}"')
        if metadata.published_time:
            fm.append(f'published: "{_escape_yaml_double_quoted(metadata.published_time)}"')
        if metadata.language:
            fm.append(f'language: "{_escape_yaml_double_quoted(metadata.language)}"')
        fm.append(f"words: {word_count}")
        fm.append(f"tokens: {estimated_tokens}")
        fm.append(f'extractedAt: "{datetime.now(timezone.utc).isoformat()}"')
        fm.append("---\n")

        markdown = "\n".join(fm) + "\n" + markdown

    return ExtractionResult(
        markdown=markdown.strip(),
        text=plain_text,
        metadata=metadata,
        links=links,
        images=images,
        tables=tables,
        code_blocks=code_blocks,
        headings=headings,
    )
