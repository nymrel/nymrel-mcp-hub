"""
nymrel_crawler_mesh.cache
Content-Hash SHA-256 Caching Layer
Copyright (c) 2026 Nymrel / JalenBuilds LLC
"""

import hashlib
import json
import os
import threading
import time
from typing import Any, Dict, Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

def compute_sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()


def normalize_url_key(raw_url: str) -> str:
    try:
        parsed = urlparse(raw_url)
        # Strip tracking query params
        tracking_params = {
            "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
            "fbclid", "gclid", "msclkid", "mc_cid", "mc_eid"
        }
        query_items = parse_qsl(parsed.query)
        filtered_query = [(k, v) for k, v in query_items if k.lower() not in tracking_params]
        filtered_query.sort()
        new_query = urlencode(filtered_query)

        # Remove fragment
        return urlunparse((parsed.scheme.lower(), parsed.netloc.lower(), parsed.path, parsed.params, new_query, ""))
    except Exception:
        return raw_url.strip()


class ContentCache:
    def __init__(
        self,
        enabled: bool = True,
        cache_dir: str = ".crawler-cache",
        ttl_seconds: int = 86400,
        in_memory: bool = False,
        max_memory_entries: int = 5000,
    ):
        self.enabled = enabled
        self.cache_dir = os.path.abspath(cache_dir)
        self.ttl_seconds = ttl_seconds
        self.in_memory = in_memory
        self.max_memory_entries = max_memory_entries
        self.memory_store: Dict[str, Dict[str, Any]] = {}
        self._lock = threading.RLock()

    def get_disk_path(self, url_key: str) -> tuple[str, str]:
        h = compute_sha256(url_key)
        sub_dir = os.path.join(self.cache_dir, h[:2])
        meta_path = os.path.join(sub_dir, f"{h}.meta.json")
        body_path = os.path.join(sub_dir, f"{h}.body.html")
        return meta_path, body_path

    def get(self, raw_url: str) -> Optional[Dict[str, Any]]:
        with self._lock:
            return self._get_unlocked(raw_url)

    def _get_unlocked(self, raw_url: str) -> Optional[Dict[str, Any]]:
        if not self.enabled:
            return None

        url_key = normalize_url_key(raw_url)

        # 1. In-memory check
        if url_key in self.memory_store:
            entry = self.memory_store[url_key]
            if time.time() < entry["expires_at"]:
                return entry
            else:
                del self.memory_store[url_key]

        if self.in_memory:
            return None

        # 2. Filesystem check
        meta_path, body_path = self.get_disk_path(url_key)
        if not os.path.exists(meta_path):
            return None

        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)

            if time.time() >= meta.get("expires_at", 0):
                self.delete(raw_url)
                return None

            html = ""
            if os.path.exists(body_path):
                with open(body_path, "r", encoding="utf-8") as f:
                    html = f.read()

            entry = {**meta, "html": html}
            self._set_memory(url_key, entry)
            return entry
        except Exception:
            return None

    def set(self, raw_url: str, data: Dict[str, Any]) -> Dict[str, Any]:
        with self._lock:
            return self._set_unlocked(raw_url, data)

    def _set_unlocked(self, raw_url: str, data: Dict[str, Any]) -> Dict[str, Any]:
        if not self.enabled:
            return data

        url_key = normalize_url_key(raw_url)
        now = time.time()
        expires_at = now + self.ttl_seconds
        h = compute_sha256(data.get("html", "") or data.get("text", "") or url_key)

        entry = {
            **data,
            "url": url_key,
            "hash": h,
            "saved_at": now,
            "expires_at": expires_at,
        }

        self._set_memory(url_key, entry)

        if not self.in_memory:
            try:
                meta_path, body_path = self.get_disk_path(url_key)
                os.makedirs(os.path.dirname(meta_path), exist_ok=True)

                meta_only = {k: v for k, v in entry.items() if k != "html"}
                with open(meta_path, "w", encoding="utf-8") as f:
                    json.dump(meta_only, f, indent=2)

                with open(body_path, "w", encoding="utf-8") as f:
                    f.write(entry.get("html", ""))
            except Exception:
                pass

        return entry

    def _set_memory(self, key: str, entry: Dict[str, Any]) -> None:
        if len(self.memory_store) >= self.max_memory_entries:
            first_key = next(iter(self.memory_store))
            del self.memory_store[first_key]
        self.memory_store[key] = entry

    def has(self, raw_url: str) -> bool:
        return self.get(raw_url) is not None

    def delete(self, raw_url: str) -> bool:
        with self._lock:
            return self._delete_unlocked(raw_url)

    def _delete_unlocked(self, raw_url: str) -> bool:
        url_key = normalize_url_key(raw_url)
        self.memory_store.pop(url_key, None)

        if not self.in_memory:
            meta_path, body_path = self.get_disk_path(url_key)
            removed = False
            for p in (meta_path, body_path):
                if os.path.exists(p):
                    try:
                        os.remove(p)
                        removed = True
                    except OSError:
                        pass
            return removed
        return True

    def clear(self) -> None:
        with self._lock:
            self._clear_unlocked()

    def _clear_unlocked(self) -> None:
        self.memory_store.clear()
        if not self.in_memory and os.path.exists(self.cache_dir):
            import shutil
            try:
                shutil.rmtree(self.cache_dir)
            except OSError:
                pass

    def get_conditional_headers(self, raw_url: str) -> Dict[str, str]:
        entry = self.get(raw_url)
        headers = {}
        if entry:
            if "etag" in entry and entry["etag"]:
                headers["If-None-Match"] = entry["etag"]
            if "last_modified" in entry and entry["last_modified"]:
                headers["If-Modified-Since"] = entry["last_modified"]
        return headers
