"""
nymrel_crawler_mesh.rate_limiter
Polite Domain-Aware Rate Limiter & Concurrency Controller
Copyright (c) 2026 Nymrel / JalenBuilds LLC
"""

import asyncio
import random
import time
from dataclasses import dataclass
from typing import Dict, Optional
from urllib.parse import urlparse


@dataclass
class DomainState:
    domain: str
    last_request_time: float = 0.0
    active_requests: int = 0
    delay_sec: float = 0.25
    consecutive_failures: int = 0
    backoff_until: float = 0.0


def extract_domain(url_str: str) -> str:
    try:
        return urlparse(url_str).hostname.lower() if urlparse(url_str).hostname else "unknown"
    except Exception:
        return "unknown"


class PoliteRateLimiter:
    def __init__(self, default_delay_ms: int = 250, max_concurrency_per_domain: int = 3):
        self.default_delay_sec = default_delay_ms / 1000.0
        self.max_concurrency_per_domain = max_concurrency_per_domain
        self.domain_states: Dict[str, DomainState] = {}
        self._lock = asyncio.Lock()

    def _get_state(self, domain: str) -> DomainState:
        if domain not in self.domain_states:
            self.domain_states[domain] = DomainState(
                domain=domain,
                delay_sec=self.default_delay_sec,
            )
        return self.domain_states[domain]

    def set_domain_delay(self, domain: str, delay_sec: float) -> None:
        state = self._get_state(domain.lower())
        state.delay_sec = max(0.0, delay_sec)

    async def acquire(self, url: str) -> None:
        domain = extract_domain(url)
        while True:
            now = time.time()
            state = self._get_state(domain)

            if now < state.backoff_until:
                wait_time = state.backoff_until - now
                await asyncio.sleep(wait_time)
                continue

            if state.active_requests >= self.max_concurrency_per_domain:
                await asyncio.sleep(0.05)
                continue

            time_since_last = now - state.last_request_time
            if time_since_last < state.delay_sec:
                wait_time = state.delay_sec - time_since_last
                await asyncio.sleep(wait_time)
                continue

            state.active_requests += 1
            state.last_request_time = time.time()
            break

    def release(self, url: str, status_code: Optional[int] = None, retry_after_sec: Optional[float] = None) -> None:
        domain = extract_domain(url)
        state = self._get_state(domain)
        state.active_requests = max(0, state.active_requests - 1)
        state.last_request_time = time.time()

        if status_code in (429, 503):
            state.consecutive_failures += 1
            if retry_after_sec and retry_after_sec > 0:
                state.backoff_until = time.time() + retry_after_sec
            else:
                base = min(30.0, 2.0 * (2 ** (state.consecutive_failures - 1)))
                jitter = random.uniform(0.1, 1.0)
                state.backoff_until = time.time() + base + jitter
        elif status_code and 200 <= status_code < 400:
            state.consecutive_failures = 0
            state.backoff_until = 0.0
