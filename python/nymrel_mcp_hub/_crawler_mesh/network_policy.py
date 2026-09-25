"""Fail-closed outbound HTTP policy for crawler-controlled requests."""

from __future__ import annotations

import http.client
import ipaddress
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, Mapping, Optional
from urllib.parse import urljoin, urlparse

DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024
DEFAULT_MAX_REDIRECTS = 5


class CrawlerSecurityError(RuntimeError):
    """A stable, redacted error for a rejected crawler request."""

    def __init__(self, code: str):
        self.code = code
        super().__init__(f"Crawler request rejected: {code}")


Resolver = Callable[[str], Iterable[str]]
UrlOpener = Callable[..., object]


@dataclass(frozen=True)
class ResolvedHttpTarget:
    url: str
    hostname: str
    addresses: tuple[str, ...]


def _default_resolver(hostname: str) -> Iterable[str]:
    try:
        return [str(ipaddress.ip_address(hostname))]
    except ValueError:
        records = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
        return sorted({record[4][0] for record in records})


@dataclass(frozen=True)
class NetworkPolicy:
    allow_private_networks: bool = False
    max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES
    max_redirects: int = DEFAULT_MAX_REDIRECTS
    resolver: Resolver = _default_resolver

    def __post_init__(self) -> None:
        if self.max_response_bytes <= 0 or self.max_redirects <= 0:
            raise ValueError("Network limits must be positive integers")

    def validate_url(self, raw_url: str) -> str:
        return self.resolve_target(raw_url).url

    def resolve_target(self, raw_url: str) -> ResolvedHttpTarget:
        try:
            parsed = urlparse(raw_url)
            parsed.port
        except (TypeError, ValueError) as error:
            raise CrawlerSecurityError("INVALID_URL") from error

        if parsed.scheme not in ("http", "https") or not parsed.hostname:
            raise CrawlerSecurityError("INVALID_URL")
        if parsed.username is not None or parsed.password is not None:
            raise CrawlerSecurityError("UNSAFE_URL_CREDENTIALS")

        try:
            try:
                raw_addresses = [str(ipaddress.ip_address(parsed.hostname))]
            except ValueError:
                raw_addresses = list(self.resolver(parsed.hostname))
        except Exception as error:
            raise CrawlerSecurityError("DNS_RESOLUTION_FAILED") from error

        addresses = []
        seen = set()
        try:
            for raw_address in raw_addresses:
                address = str(ipaddress.ip_address(raw_address))
                if address not in seen:
                    addresses.append(address)
                    seen.add(address)
        except ValueError as error:
            raise CrawlerSecurityError("DNS_RESOLUTION_FAILED") from error

        if not addresses:
            raise CrawlerSecurityError("DNS_RESOLUTION_FAILED")
        if not self.allow_private_networks and any(not ipaddress.ip_address(address).is_global for address in addresses):
            raise CrawlerSecurityError("PRIVATE_NETWORK_TARGET")

        return ResolvedHttpTarget(
            url=parsed.geturl(),
            hostname=parsed.hostname,
            addresses=tuple(addresses),
        )


@dataclass(frozen=True)
class HttpDocument:
    final_url: str
    status: int
    reason: str
    headers: Dict[str, str]
    text: str


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int, pinned_address: str, timeout: float):
        super().__init__(host, port=port, timeout=timeout)
        self._pinned_address = pinned_address
        self._create_connection = self._create_pinned_connection

    def _create_pinned_connection(self, address, timeout, source_address):  # type: ignore[no-untyped-def]
        return socket.create_connection(
            (self._pinned_address, address[1]),
            timeout=timeout,
            source_address=source_address,
        )


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int, pinned_address: str, timeout: float):
        super().__init__(host, port=port, timeout=timeout)
        self._pinned_address = pinned_address
        self._create_connection = self._create_pinned_connection

    def _create_pinned_connection(self, address, timeout, source_address):  # type: ignore[no-untyped-def]
        return socket.create_connection(
            (self._pinned_address, address[1]),
            timeout=timeout,
            source_address=source_address,
        )


class _PinnedResponse:
    def __init__(self, response: http.client.HTTPResponse, connection: http.client.HTTPConnection):
        self._response = response
        self._connection = connection
        self.status = response.status
        self.code = response.status
        self.reason = response.reason
        self.headers = response.headers

    def read(self, size: int = -1) -> bytes:
        return self._response.read(size)

    def close(self) -> None:
        try:
            self._response.close()
        finally:
            self._connection.close()


def _request_path(raw_url: str) -> str:
    parsed = urlparse(raw_url)
    path = parsed.path or "/"
    if parsed.params:
        path = f"{path};{parsed.params}"
    if parsed.query:
        path = f"{path}?{parsed.query}"
    return path


def _default_open(
    request: urllib.request.Request,
    target: ResolvedHttpTarget,
    timeout: float,
):
    parsed = urlparse(target.url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    connection_type = _PinnedHTTPSConnection if parsed.scheme == "https" else _PinnedHTTPConnection
    last_error: Optional[Exception] = None

    for address in target.addresses:
        connection = connection_type(target.hostname, port, address, timeout)
        try:
            connection.request(
                request.get_method(),
                _request_path(target.url),
                body=request.data,
                headers=dict(request.header_items()),
            )
            return _PinnedResponse(connection.getresponse(), connection)
        except Exception as error:
            connection.close()
            last_error = error

    if last_error is not None:
        raise last_error
    raise CrawlerSecurityError("DNS_RESOLUTION_FAILED")


def _header_map(response: object) -> Dict[str, str]:
    headers = getattr(response, "headers", {})
    items = headers.items() if hasattr(headers, "items") else []
    return {str(key).lower(): str(value) for key, value in items}


def _close_response(response: object) -> None:
    close = getattr(response, "close", None)
    if callable(close):
        close()


def _read_limited(response: object, max_bytes: int) -> str:
    headers = _header_map(response)
    declared_length = headers.get("content-length")
    if declared_length:
        try:
            if int(declared_length) > max_bytes:
                raise CrawlerSecurityError("RESPONSE_TOO_LARGE")
        except ValueError:
            pass

    read = getattr(response, "read", None)
    if not callable(read):
        return ""
    body = read(max_bytes + 1)
    if len(body) > max_bytes:
        raise CrawlerSecurityError("RESPONSE_TOO_LARGE")
    return body.decode("utf-8", errors="replace")


def _without_sensitive_headers(headers: Mapping[str, str]) -> Dict[str, str]:
    sensitive = {"authorization", "cookie", "proxy-authorization"}
    return {key: value for key, value in headers.items() if key.lower() not in sensitive}


def _without_host_header(headers: Mapping[str, str]) -> Dict[str, str]:
    return {key: value for key, value in headers.items() if key.lower() != "host"}


def _origin(raw_url: str) -> tuple[str, str, int]:
    parsed = urlparse(raw_url)
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    return parsed.scheme, parsed.hostname or "", port


def fetch_http_text(
    raw_url: str,
    *,
    headers: Optional[Mapping[str, str]] = None,
    timeout_sec: float = 15.0,
    policy: Optional[NetworkPolicy] = None,
    opener: Optional[UrlOpener] = None,
) -> HttpDocument:
    """Fetch one bounded text document, validating every redirect destination."""

    active_policy = policy or NetworkPolicy()
    current_target = active_policy.resolve_target(raw_url)
    current_url = current_target.url
    # The validated URL, not caller input, owns HTTP authority routing.
    request_headers = _without_host_header(headers or {})

    for redirect_count in range(active_policy.max_redirects + 1):
        request = urllib.request.Request(current_url, headers=request_headers)
        response: object
        try:
            if opener is None:
                response = _default_open(request, current_target, timeout_sec)
            else:
                response = opener(request, timeout=timeout_sec)
        except urllib.error.HTTPError as error:
            if error.code not in (301, 302, 303, 307, 308, 304):
                raise
            response = error

        status = int(getattr(response, "status", getattr(response, "code", 200)))
        response_headers = _header_map(response)

        if status in (301, 302, 303, 307, 308):
            location = response_headers.get("location")
            _close_response(response)
            if not location:
                raise CrawlerSecurityError("INVALID_URL")
            if redirect_count >= active_policy.max_redirects:
                raise CrawlerSecurityError("TOO_MANY_REDIRECTS")

            current_target = active_policy.resolve_target(urljoin(current_url, location))
            next_url = current_target.url
            if _origin(next_url) != _origin(current_url):
                request_headers = _without_sensitive_headers(request_headers)
            current_url = next_url
            continue

        try:
            text = "" if status == 304 else _read_limited(response, active_policy.max_response_bytes)
            return HttpDocument(
                final_url=current_url,
                status=status,
                reason=str(getattr(response, "reason", "")),
                headers=response_headers,
                text=text,
            )
        finally:
            _close_response(response)

    raise CrawlerSecurityError("TOO_MANY_REDIRECTS")
