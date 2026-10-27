"""Bounded, anonymous public HTTP. DNS validation and connection share an IP pin.

Never pass a validated hostname to an ordinary HTTP client afterwards: doing so
would resolve it again and reintroduce DNS rebinding. Each redirect gets a new
validation and its own connection; TLS still verifies the ORIGINAL hostname.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import ipaddress
import math
import os
from pathlib import Path
import re
import socket
import tempfile
from collections.abc import Collection, Mapping
from urllib.parse import urljoin, urlsplit, urlunsplit

import httpx

MAX_URL_LENGTH = 2048
MAX_BODY_BYTES = 2 * 1024 * 1024
# Real channel documents can exceed 2 MiB before their public metadata arrives.
# This remains a hard raw-byte bound and applies only to these exact hosts.
MAX_YOUTUBE_BODY_BYTES = 8 * 1024 * 1024
_YOUTUBE_DOCUMENT_HOSTS = frozenset({"youtube.com", "www.youtube.com", "m.youtube.com"})
MAX_REDIRECTS = 4
FETCH_TIMEOUT = 20.0
DNS_TIMEOUT = 4.0
REDIRECT_CODES = frozenset({301, 302, 303, 307, 308})
_LOCAL_SUFFIXES = ("localhost", "local", "internal", "home", "lan", "arpa", "onion", "invalid", "test")
_V6_GLOBAL = ipaddress.ip_network("2000::/3")
_V6_SPECIAL = tuple(ipaddress.ip_network(n) for n in ("2001::/23", "2002::/16", "3fff::/20"))


class UnsafeURL(ValueError):
    """The supplied URL or any redirect/DNS answer violates public egress policy."""


class FetchError(RuntimeError):
    """An unavailable, oversized, unsupported, or timed-out public response."""


@dataclass(frozen=True)
class ValidatedURL:
    url: str
    scheme: str
    host: str
    port: int
    addresses: tuple[str, ...] = ()

    @property
    def authority(self) -> str:
        return f"[{self.host}]" if ":" in self.host else self.host


def _public_ip(value: str) -> str:
    try:
        address = ipaddress.ip_address(value)
    except ValueError as exc:
        raise UnsafeURL("Invalid IP address.") from exc
    if "%" in value:
        raise UnsafeURL("Scoped IP addresses are not allowed.")
    # Check mapped IPv4 before IPv6 classification (Python versions differ).
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped:
        return _public_ip(str(address.ipv4_mapped))
    if (not address.is_global or address.is_multicast or address.is_reserved
            or address.is_loopback or address.is_link_local or address.is_unspecified):
        raise UnsafeURL("Only globally routable public IP addresses are allowed.")
    if isinstance(address, ipaddress.IPv4Address):
        if address in ipaddress.ip_network("192.0.0.0/24"):
            raise UnsafeURL("Special-purpose addresses are not allowed.")
    elif address not in _V6_GLOBAL or any(address in net for net in _V6_SPECIAL):
        # Excludes NAT64, Teredo, 6to4 and other embedded/routed IPv4 mechanisms.
        raise UnsafeURL("Special-purpose IPv6 addresses are not allowed.")
    return str(address)


def normalize_url(url: str) -> ValidatedURL:
    """Strict syntax/literal-IP check only; callers MUST still validate DNS.

    Also used for inert extracted links. It does not assert that a DNS name is
    public; links are evidence, never automatically scheduled or navigated.
    """
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        raise UnsafeURL("URL is empty or exceeds the length limit.")
    if any(ord(c) < 33 or ord(c) == 127 or c.isspace() for c in url) or "\\" in url:
        raise UnsafeURL("Whitespace, controls and backslashes are not allowed in URLs.")
    try:
        parts = urlsplit(url)
        if parts.scheme.lower() not in {"http", "https"} or not parts.netloc:
            raise UnsafeURL("Only absolute HTTP(S) URLs are allowed.")
        if "@" in parts.netloc or "%" in parts.netloc:
            raise UnsafeURL("Credentials and escaped authorities are not allowed.")
        host = parts.hostname
        scheme = parts.scheme.lower()
        port = parts.port
    except ValueError as exc:
        raise UnsafeURL("Malformed URL authority.") from exc
    if not host or parts.netloc.endswith(":"):
        raise UnsafeURL("Malformed URL authority.")
    default_port = 443 if scheme == "https" else 80
    if port is not None and port != default_port:
        raise UnsafeURL("Only the default HTTP(S) port is allowed.")
    try:
        literal = ipaddress.ip_address(host)
    except ValueError:
        literal = None
    if literal is not None:
        _public_ip(host)
        host = str(literal)
    else:
        if ":" in host or "[" in parts.netloc or "]" in parts.netloc:
            raise UnsafeURL("Malformed IP address.")
        try:
            host = host.rstrip(".").encode("idna").decode("ascii").lower()
        except UnicodeError as exc:
            raise UnsafeURL("Malformed hostname.") from exc
        labels = host.split(".")
        if (len(host) > 253 or len(labels) < 2
                or any(not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?", label) for label in labels)
                or not re.search(r"[a-z]", labels[-1])
                or all(re.fullmatch(r"(?:0x[0-9a-f]+|[0-9]+)", label) for label in labels)
                or any(host == suffix or host.endswith("." + suffix) for suffix in _LOCAL_SUFFIXES)):
            raise UnsafeURL("Only fully qualified public hostnames are allowed.")
    authority = f"[{host}]" if ":" in host else host
    normalized = urlunsplit((scheme, authority, parts.path or "/", parts.query, ""))
    # Make the HTTP parser agree with our security parser before resolving DNS.
    try:
        parsed = httpx.URL(normalized)
        if parsed.raw_host.decode("ascii") != host or parsed.port not in (None, default_port):
            raise UnsafeURL("Ambiguous URL authority.")
    except httpx.InvalidURL as exc:
        raise UnsafeURL("Malformed HTTP URL.") from exc
    return ValidatedURL(str(parsed), scheme, host, default_port)


async def _resolve(host: str, port: int) -> list[str]:
    records = await asyncio.get_running_loop().getaddrinfo(
        host, port, family=socket.AF_UNSPEC, type=socket.SOCK_STREAM, proto=socket.IPPROTO_TCP,
    )
    return [record[4][0] for record in records]


async def validate_url(url: str) -> ValidatedURL:
    """Validate EVERY A/AAAA answer; return the addresses to pin, never cache DNS."""
    target = normalize_url(url)
    try:
        ipaddress.ip_address(target.host)
    except ValueError:
        try:
            answers = await asyncio.wait_for(_resolve(target.host, target.port), DNS_TIMEOUT)
        except (OSError, TimeoutError) as exc:
            raise FetchError("Public hostname could not be resolved in time.") from exc
    else:
        answers = [target.host]
    if not answers or len(answers) > 64:
        raise FetchError("DNS returned no usable bounded address set.")
    addresses = tuple(dict.fromkeys(_public_ip(answer) for answer in answers))
    return ValidatedURL(target.url, target.scheme, target.host, target.port, addresses)


def _check_hosts(target: ValidatedURL, allowed_hosts: Collection[str] | None) -> None:
    if allowed_hosts is not None and target.host not in allowed_hosts:
        raise UnsafeURL("Navigation leaves the permitted public platform hosts.")


async def _request_once(target: ValidatedURL, request_headers: Mapping[str, str]) -> dict:
    body_limit = MAX_YOUTUBE_BODY_BYTES if target.host in _YOUTUBE_DOCUMENT_HOSTS else MAX_BODY_BYTES
    # Numeric destination prevents a second hostname lookup at connect time.
    pinned = httpx.URL(target.url).copy_with(host=target.addresses[0])
    headers = {
        "Host": target.authority,
        "User-Agent": "SafeNet-Public-Collector/1.0",
        "Accept": "text/html,application/xhtml+xml,application/json,text/plain;q=0.9",
        "Accept-Encoding": "identity",
        **request_headers,
    }
    # One client per hop prevents cookies and cross-host pooled TLS reuse. Never
    # read HTTP_PROXY/HTTPS_PROXY/ALL_PROXY or environment certificate overrides.
    async with httpx.AsyncClient(
        trust_env=False, follow_redirects=False, verify=True,
        timeout=httpx.Timeout(10.0, connect=5.0),
        limits=httpx.Limits(max_connections=1, max_keepalive_connections=0),
    ) as client:
        async with client.stream(
            "GET", pinned, headers=headers, extensions={"sni_hostname": target.host},
        ) as response:
            response_headers = dict(response.headers)
            if response.status_code in REDIRECT_CODES | {401, 403, 407, 429, 451}:
                return {"url": target.url, "status_code": response.status_code,
                        "text": "", "headers": response_headers}
            if response.headers.get("content-encoding", "identity").lower() not in {"", "identity"}:
                raise FetchError("Compressed response refused to keep decoding resource-bounded.")
            length = response.headers.get("content-length")
            if length is not None:
                if not length.isascii() or not length.isdigit() or len(length) > 12:
                    raise FetchError("Invalid response size header.")
                if int(length) > body_limit:
                    raise FetchError("Response exceeds the byte limit.")
            media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if media_type and media_type not in {"text/html", "application/xhtml+xml", "text/plain", "application/json", "text/json"}:
                raise FetchError("Response is not a supported text document.")
            body = bytearray()
            async for chunk in response.aiter_raw():
                if len(body) + len(chunk) > body_limit:
                    raise FetchError("Response exceeds the byte limit.")
                body.extend(chunk)
            # Decode only after the raw-byte bound. No unbounded decompressors.
            encoding = response.encoding or "utf-8"
            try:
                text = bytes(body).decode(encoding, errors="replace")
            except (LookupError, ValueError):
                text = bytes(body).decode("utf-8", errors="replace")
            return {"url": target.url, "status_code": response.status_code,
                    "text": text, "headers": response_headers}


async def fetch_public(
    url: str, *, allowed_hosts: Collection[str] | None = None,
    follow_redirects: bool = True, request_headers: Mapping[str, str] | None = None,
) -> dict:
    """Anonymous bounded GET. Validate and pin each redirect, including same-host.

    Optional host restrictions are exact, not suffix matches. Secret API headers
    are supported only with redirects disabled and an explicit host allowlist.
    """
    extra_headers = dict(request_headers or {})
    if any(name.lower() not in {"accept", "x-goog-api-key"} for name in extra_headers):
        raise UnsafeURL("Only supported collector request headers are allowed.")
    if extra_headers and (follow_redirects or not allowed_hosts):
        raise UnsafeURL("Custom headers require an exact allowlist and no redirects.")
    if any("\r" in str(value) or "\n" in str(value) for value in extra_headers.values()):
        raise UnsafeURL("Invalid request header.")
    try:
        async with asyncio.timeout(FETCH_TIMEOUT):
            current = url
            seen: set[str] = set()
            for hop in range(MAX_REDIRECTS + 1):
                _check_hosts(normalize_url(current), allowed_hosts)
                target = await validate_url(current)
                if target.url in seen:
                    raise FetchError("Redirect loop detected.")
                seen.add(target.url)
                result = await _request_once(target, extra_headers)
                if result["status_code"] not in REDIRECT_CODES or not follow_redirects:
                    return result
                location = result["headers"].get("location")
                if not location:
                    raise FetchError("Redirect has no destination.")
                if hop == MAX_REDIRECTS:
                    raise FetchError("Redirect limit exceeded.")
                if any(ord(c) < 33 or ord(c) == 127 or c.isspace() for c in location) or "\\" in location:
                    raise UnsafeURL("Malformed redirect destination.")
                next_url = urljoin(target.url, location)
                if target.scheme == "https" and urlsplit(next_url).scheme.lower() != "https":
                    raise UnsafeURL("HTTPS downgrade redirects are not allowed.")
                current = next_url
    except (TimeoutError, httpx.HTTPError, OSError) as exc:
        # Do not return raw exception strings: API URLs and headers may be secret.
        raise FetchError("Public HTTP request failed or exceeded its time limit.") from exc
    raise FetchError("No public response obtained.")


# Binary acquisition is deliberately separate from fetch_public: text callers
# retain their existing content, timeout, byte and exact-host semantics.
MAX_BINARY_BYTES = 64 * 1024 * 1024
BINARY_FETCH_TIMEOUT = 120.0
BINARY_CHUNK_BYTES = 64 * 1024
MAX_MP4_HEADER_BYTES = 4096
BINARY_MIME_TYPES = frozenset({"video/mp4"})
_MP4_BRANDS = frozenset({b"isom", b"iso2", b"iso3", b"iso4", b"iso5", b"iso6",
                         b"mp41", b"mp42", b"avc1", b"M4V ", b"MSNV"})


class BinaryAccessBlocked(FetchError):
    """The public media server explicitly denied anonymous access."""


def check_binary_url(url: str, allowed_host_suffixes: Collection[str]) -> ValidatedURL:
    """Syntax + label-boundary CDN policy, BEFORE DNS; does not resolve the URL.

    Suffixes are trusted application policy, never values supplied by a page.
    Each subsequent connection must still call validate_url and pin its result.
    """
    target = normalize_url(url)
    if target.scheme != "https":
        raise UnsafeURL("Public video requires HTTPS on its default port.")
    if not allowed_host_suffixes or not any(
        target.host == suffix or target.host.endswith("." + suffix)
        for suffix in allowed_host_suffixes
        if isinstance(suffix, str) and suffix and not suffix.startswith(".")
    ):
        raise UnsafeURL("Video destination is outside the source platform's permitted CDNs.")
    return target


def _mp4_header_valid(prefix: bytes, *, complete: bool = False) -> bool:
    """Check a bounded ISO BMFF file-type box, without invoking any decoder.

    True means the entire ftyp box is present and has a supported video-container
    brand. False means more prefix bytes are needed. This is container sniffing,
    not a claim that the file contains a decodable video stream.
    """
    if len(prefix) < 8:
        if complete:
            raise FetchError("Video is empty or has a truncated MP4 header.")
        return False
    size = int.from_bytes(prefix[:4], "big")
    if prefix[4:8] != b"ftyp" or not 16 <= size <= MAX_MP4_HEADER_BYTES or size % 4:
        raise FetchError("Public media does not have a supported bounded MP4 header.")
    if len(prefix) < size:
        if complete:
            raise FetchError("Public media has a truncated MP4 file-type box.")
        return False
    brands = {bytes(prefix[8:12]), *(bytes(prefix[i:i + 4]) for i in range(16, size, 4))}
    if not brands.intersection(_MP4_BRANDS):
        raise FetchError("Public media is not a supported MP4 video container.")
    return True


def _check_acquisition_deadline(deadline: float, initial_cancels: int) -> None:
    # asyncio.wait_for (used by DNS on Python 3.11) can swallow cancellation if
    # its future completed concurrently. Never let that race authorize a new
    # connection or a commit after the enclosing operation was cancelled.
    task = asyncio.current_task()
    if task is not None and task.cancelling() > initial_cancels:
        raise asyncio.CancelledError()
    if asyncio.get_running_loop().time() >= deadline:
        raise TimeoutError()


async def _download_binary_once(target: ValidatedURL, destination, max_bytes: int,
                                deadline: float, initial_cancels: int) -> dict:
    pinned = httpx.URL(target.url).copy_with(host=target.addresses[0])
    headers = {"Host": target.authority, "User-Agent": "SafeNet-Public-Collector/1.0",
               "Accept": "video/mp4", "Accept-Encoding": "identity"}
    async with httpx.AsyncClient(
        trust_env=False, follow_redirects=False, verify=True,
        timeout=httpx.Timeout(15.0, connect=5.0),
        limits=httpx.Limits(max_connections=1, max_keepalive_connections=0),
    ) as client:
        _check_acquisition_deadline(deadline, initial_cancels)
        async with client.stream(
            "GET", pinned, headers=headers, extensions={"sni_hostname": target.host},
        ) as response:
            if response.status_code in REDIRECT_CODES:
                return {"status_code": response.status_code, "headers": dict(response.headers)}
            if response.status_code in {401, 403, 407, 429, 451}:
                raise BinaryAccessBlocked(f"Public video access blocked (HTTP {response.status_code}).")
            if response.status_code != 200:
                raise FetchError(f"Public video source returned HTTP {response.status_code}.")
            if response.headers.get("content-encoding", "identity").lower() not in {"", "identity"}:
                raise FetchError("Compressed video response refused.")
            media_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
            if media_type not in BINARY_MIME_TYPES:
                raise FetchError("Public video response is not video/mp4; playlists and other MIME types are refused.")
            length = response.headers.get("content-length")
            expected = None
            if length is not None:
                if not length.isascii() or not length.isdigit() or len(length) > 12:
                    raise FetchError("Invalid video size header.")
                expected = int(length)
                if expected > max_bytes:
                    raise FetchError("Video exceeds the download byte limit.")
            total = 0
            prefix = bytearray()
            header_valid = False
            # Read raw bytes only. No decompression, range requests, manifests,
            # ffmpeg, av, or any other decoder/network-capable media tool.
            async for chunk in response.aiter_raw(chunk_size=BINARY_CHUNK_BYTES):
                _check_acquisition_deadline(deadline, initial_cancels)
                if total + len(chunk) > max_bytes:
                    raise FetchError("Video exceeds the download byte limit.")
                total += len(chunk)
                if not header_valid:
                    prefix.extend(chunk[:MAX_MP4_HEADER_BYTES - len(prefix)])
                    header_valid = _mp4_header_valid(prefix)
                destination.write(chunk)
            _mp4_header_valid(prefix, complete=True)
            if expected is not None and total != expected:
                raise FetchError("Public video ended before its declared size or exceeded it.")
            return {"status_code": 200, "url": target.url, "download_bytes": total,
                    "content_type": media_type}


async def download_public_binary(
    url: str, target_path: Path, *, allowed_host_suffixes: Collection[str],
    max_bytes: int = MAX_BINARY_BYTES, timeout: float = BINARY_FETCH_TIMEOUT,
) -> dict:
    """Atomically save one anonymous MP4 with DNS-pinned, bounded HTTPS hops.

    The parent directory must already exist. A unique sibling temporary file is
    removed on every failure/cancellation. The existing target is replaced only
    after the whole validated response completes. Limits may only be reduced.
    Returns path, url, download_bytes and content_type; raises FetchError or
    UnsafeURL on failure. No cookies, caller headers, proxy, retry or decoding.
    """
    if isinstance(max_bytes, bool) or not isinstance(max_bytes, int) or not 1 <= max_bytes <= MAX_BINARY_BYTES:
        raise ValueError("Binary byte limit must be within the hard download bound.")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not math.isfinite(timeout) or not 0 < timeout <= BINARY_FETCH_TIMEOUT:
        raise ValueError("Binary deadline must be within the hard time bound.")
    target_path = Path(target_path)
    if target_path.suffix.lower() != ".mp4":
        raise FetchError("Public video target must use the .mp4 extension.")
    temporary: Path | None = None
    deadline = asyncio.get_running_loop().time() + timeout
    initial_cancels = asyncio.current_task().cancelling()
    try:
        async with asyncio.timeout_at(deadline):
            current = url
            seen: set[str] = set()
            for hop in range(MAX_REDIRECTS + 1):
                check_binary_url(current, allowed_host_suffixes)
                target = await validate_url(current)
                _check_acquisition_deadline(deadline, initial_cancels)
                if target.url in seen:
                    raise FetchError("Video redirect loop detected.")
                seen.add(target.url)
                if temporary is None:
                    # mkstemp creates exclusively with restrictive permissions.
                    fd, name = tempfile.mkstemp(prefix=".safenet-video-", suffix=".part", dir=target_path.parent)
                    temporary = Path(name)
                    try:
                        destination = os.fdopen(fd, "wb")
                    except BaseException:
                        os.close(fd)
                        raise
                else:
                    destination = temporary.open("wb")
                with destination:
                    result = await _download_binary_once(target, destination, max_bytes, deadline, initial_cancels)
                if result["status_code"] not in REDIRECT_CODES:
                    # Deliver any pending cancellation/deadline BEFORE commit.
                    await asyncio.sleep(0)
                    _check_acquisition_deadline(deadline, initial_cancels)
                    os.replace(temporary, target_path)
                    temporary = None
                    return {"path": str(target_path), "url": result["url"],
                            "download_bytes": result["download_bytes"], "content_type": result["content_type"]}
                location = result["headers"].get("location")
                if not location:
                    raise FetchError("Video redirect has no destination.")
                if hop == MAX_REDIRECTS:
                    raise FetchError("Video redirect limit exceeded.")
                if any(ord(c) < 33 or ord(c) == 127 or c.isspace() for c in location) or "\\" in location:
                    raise UnsafeURL("Malformed video redirect destination.")
                current = urljoin(target.url, location)
    except (TimeoutError, httpx.HTTPError, OSError) as exc:
        raise FetchError("Public video download failed or exceeded its time/resource limit.") from exc
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    raise FetchError("No public video response obtained.")
