"""Acquire one public Instagram/TikTok MP4 or verified post preview image.

Only a permalink's anonymous HTML can authorize a platform CDN download. No
short-link expansion, arbitrary direct URLs, related posts, private APIs,
cookies, browser, playlist processing or media decoding are used here.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import tempfile
from types import MappingProxyType
from urllib.parse import urljoin, urlsplit, urlunsplit

from bs4 import BeautifulSoup, SoupStrainer
import httpx

from . import collectors
from .safe_fetch import (
    BINARY_FETCH_TIMEOUT, MAX_BINARY_BYTES, MAX_BODY_BYTES, MAX_REDIRECTS,
    REDIRECT_CODES, BinaryAccessBlocked, FetchError, UnsafeURL,
    _check_acquisition_deadline, check_binary_url, download_public_binary, fetch_public, normalize_url, validate_url,
)


@dataclass(frozen=True)
class MediaFetchLimits:
    max_download_bytes: int = MAX_BINARY_BYTES
    timeout_seconds: float = BINARY_FETCH_TIMEOUT
    max_page_bytes: int = MAX_BODY_BYTES
    max_redirects: int = MAX_REDIRECTS
    max_json_chars: int = 2 * 1024 * 1024
    max_json_scripts: int = 128
    max_json_nodes: int = 20_000
    max_json_depth: int = 64
    max_video_candidates: int = 16


MEDIA_FETCH_LIMITS = MediaFetchLimits()
# Label-boundary suffixes, not arbitrary substrings or page-supplied policies.
# New CDN families require an explicit policy change and regression tests.
PLATFORM_VIDEO_HOST_SUFFIXES = MappingProxyType({
    "instagram": frozenset({"cdninstagram.com", "fbcdn.net"}),
    "tiktok": frozenset({"tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokv.com",
                         # Observed in the anonymous HTML of TikTok's official
                         # embed-example permalink; never allow all tiktok.com.
                         "v16-webapp-prime.tiktok.com"}),
})
_PERMALINK = {
    "instagram": re.compile(r"/(?:p|reel|reels|tv)/([A-Za-z0-9_-]{1,64})/?$"),
    "tiktok": re.compile(r"/@[A-Za-z0-9_.]{1,30}/(?:video|photo)/([0-9]{1,30})/?$"),
}


class NoPublicVideo(FetchError):
    """Only missing video data permits trying a verified still-image asset."""


def _permalink(url: str) -> tuple[str, str, str]:
    target = normalize_url(url)
    if target.scheme != "https":
        raise UnsafeURL("Public video permalinks require HTTPS on its default port.")
    platform = next((name for name in _PERMALINK if target.host in collectors.PLATFORM_HOSTS[name]), None)
    if platform is None:
        raise FetchError("Only Instagram or TikTok video permalinks are supported.")
    if collectors._access_path(target.url, platform):
        raise BinaryAccessBlocked("Login, consent or challenge URLs are not public video sources.")
    parts = urlsplit(target.url)
    match = _PERMALINK[platform].fullmatch(parts.path)
    if not match:
        raise FetchError("A public video permalink is required; profiles, short links and direct media URLs are unsupported.")
    # The video identity is entirely in the path. Do not send tracking tokens,
    # login hints or private JSON switches such as Instagram's __a/__d flags.
    public_page = urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))
    return platform, match[1], public_page


async def _page(url: str, platform: str, source_id: str, *, deadline: float,
                initial_cancels: int) -> dict:
    """Follow only identity-preserving page redirects, stopping before gates."""
    current = url
    seen = set()
    for hop in range(MEDIA_FETCH_LIMITS.max_redirects + 1):
        _check_acquisition_deadline(deadline, initial_cancels)
        actual_platform, actual_id, current = _permalink(current)
        if (actual_platform, actual_id) != (platform, source_id):
            raise FetchError("Public page redirected to a different video identity.")
        if current in seen:
            raise FetchError("Public video page redirect loop detected.")
        seen.add(current)
        response = await fetch_public(current, allowed_hosts=collectors.PLATFORM_HOSTS[platform], follow_redirects=False)
        _check_acquisition_deadline(deadline, initial_cancels)
        if response["status_code"] not in REDIRECT_CODES:
            return response
        location = response["headers"].get("location")
        if not location:
            raise FetchError("Public video page redirect has no destination.")
        if hop == MEDIA_FETCH_LIMITS.max_redirects:
            raise FetchError("Public video page redirect limit exceeded.")
        if "\\" in location or any(c.isspace() or ord(c) < 33 or ord(c) == 127 for c in location):
            raise UnsafeURL("Malformed public video page redirect.")
        current = urljoin(current, location)
    raise FetchError("No public video page obtained.")


def _check_page_identity(soup: BeautifulSoup, page_url: str, platform: str, source_id: str) -> bool:
    """All declared canonical identities must agree; OG needs one such identity."""
    declared = [node.get("content") for node in soup.select('meta[property="og:url"]')]
    declared.extend(node.get("href") for node in soup.select('link[rel~="canonical"]'))
    if len(declared) > MEDIA_FETCH_LIMITS.max_video_candidates:
        raise FetchError("Too many canonical video identities in the public page.")
    for value in declared:
        if not isinstance(value, str) or not value or "\\" in value or any(c.isspace() or ord(c) < 33 or ord(c) == 127 for c in value):
            raise FetchError("Public page has an invalid canonical video identity.")
        other_platform, other_id, _ = _permalink(urljoin(page_url, value))
        if (other_platform, other_id) != (platform, source_id):
            raise FetchError("Public page metadata identifies a different video.")
    return bool(declared)


def _documents(html: str, platform: str):
    scripts = BeautifulSoup(html, "html.parser", parse_only=SoupStrainer("script"))
    nodes = scripts.find_all("script", limit=MEDIA_FETCH_LIMITS.max_json_scripts + 1)
    if len(nodes) > MEDIA_FETCH_LIMITS.max_json_scripts:
        raise FetchError("Public page exceeds the embedded-script limit.")
    remaining = MEDIA_FETCH_LIMITS.max_json_chars
    for node in nodes:
        if node.get("src"):
            continue
        if platform == "instagram":
            if node.get("type") != "application/json":
                continue
        elif node.get("id") not in {"__UNIVERSAL_DATA_FOR_REHYDRATION__", "SIGI_STATE"}:
            continue
        raw = node.string or ""
        remaining -= len(raw)
        if remaining < 0:
            raise FetchError("Public page exceeds the embedded-JSON byte/character limit.")
        try:
            value = json.loads(raw)
        except (ValueError, RecursionError):
            # An authoritative TikTok item that cannot be checked must not be
            # replaced by an unverified OG/related-video fallback.
            if platform == "tiktok":
                raise FetchError("Public TikTok video metadata is malformed.") from None
            continue
        yield node.get("id"), value


def _objects(document, budget: list[int]):
    stack = [iter([document])]
    while stack:
        try:
            item = next(stack[-1])
        except StopIteration:
            stack.pop()
            continue
        budget[0] -= 1
        if budget[0] < 0:
            raise FetchError("Public video JSON exceeds the node limit.")
        if isinstance(item, (dict, list)):
            if len(stack) >= MEDIA_FETCH_LIMITS.max_json_depth:
                raise FetchError("Public video JSON exceeds the depth limit.")
            if isinstance(item, dict):
                yield item
                stack.append(iter(item.values()))
            else:
                stack.append(iter(item))


def _check_item_access(item: dict) -> None:
    owners = [item] + [item.get(key) for key in ("user", "owner", "author")]
    for owner in owners:
        if isinstance(owner, dict) and any(owner.get(flag) is True for flag in (
            "is_private", "isPrivate", "privateItem", "privateAccount", "isPrivateAccount",
            "loginRequired", "requires_login", "needLogin",
        )):
            raise BinaryAccessBlocked("The source identifies this video or its owner as private or login-restricted.")


def _address_values(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        values = value.get("urlList", value.get("UrlList", []))
        if isinstance(values, list):
            return [entry for entry in values[:MEDIA_FETCH_LIMITS.max_video_candidates] if isinstance(entry, str)]
    return []


def _tiktok_item(name: str, document, source_id: str) -> dict | None:
    if not isinstance(document, dict):
        raise FetchError("Public TikTok metadata has no video object.")
    if name == "__UNIVERSAL_DATA_FOR_REHYDRATION__":
        scope = document.get("__DEFAULT_SCOPE__")
        detail = scope.get("webapp.video-detail", scope.get("webapp.photo-detail")) if isinstance(scope, dict) else None
        if not isinstance(detail, dict):
            return None
        _check_item_access(detail)
        if detail.get("statusCode") not in (None, 0, "0"):
            message = str(detail.get("statusMsg", ""))[:1000]
            if collectors._GATE.search(message) or re.search(r"\bprivate\b|\blogin\b|\bcaptcha\b", message, re.I):
                raise BinaryAccessBlocked("TikTok reports that public video access is restricted.")
            raise FetchError("TikTok reports that this video is unavailable.")
        info = detail.get("itemInfo")
        item = info.get("itemStruct") if isinstance(info, dict) else None
        if not isinstance(item, dict):
            raise FetchError("TikTok public video detail contains no playable item.")
    else:
        items = document.get("ItemModule")
        item = items.get(source_id) if isinstance(items, dict) else None
        if not isinstance(item, dict):
            return None
    if str(item.get("id", "")) != source_id:
        raise FetchError("TikTok public metadata identifies a different video.")
    _check_item_access(item)
    return item


def _extract_video(html: str, soup: BeautifulSoup, page_url: str, platform: str, source_id: str) -> tuple[str, str]:
    canonical = _check_page_identity(soup, page_url, platform, source_id)
    candidates: list[tuple[str, str]] = []
    budget = [MEDIA_FETCH_LIMITS.max_json_nodes]

    def add(value, method):
        for address in _address_values(value):
            if len(candidates) < MEDIA_FETCH_LIMITS.max_video_candidates:
                candidates.append((address, method))

    # Finish checking identity/visibility BEFORE selecting any playable URL.
    for name, document in _documents(html, platform):
        if platform == "instagram":
            for item in _objects(document, budget):
                ids = [item[key] for key in ("shortcode", "code") if isinstance(item.get(key), str)]
                if source_id not in ids:
                    continue
                if any(value != source_id for value in ids):
                    raise FetchError("Instagram video metadata has conflicting identities.")
                _check_item_access(item)
                if item.get("is_video") is False or item.get("media_type") in (1, 8):
                    raise NoPublicVideo("The requested Instagram item is not a standalone video.")
                versions = item.get("video_versions")
                if isinstance(versions, list):
                    for version in versions[:MEDIA_FETCH_LIMITS.max_video_candidates]:
                        if isinstance(version, dict):
                            add(version.get("url"), "instagram_video_versions")
                if item.get("is_video") is True or item.get("__typename") == "GraphVideo" or item.get("media_type") == 2:
                    add(item.get("video_url"), "instagram_video_url")
        else:
            item = _tiktok_item(name, document, source_id)
            if item is None:
                continue
            video = item.get("video")
            if isinstance(video, dict):
                add(video.get("playAddr"), "tiktok_item_play_addr")
                bitrates = video.get("bitrateInfo")
                if isinstance(bitrates, list):
                    for bitrate in bitrates[:MEDIA_FETCH_LIMITS.max_video_candidates]:
                        if isinstance(bitrate, dict):
                            add(bitrate.get("PlayAddr"), "tiktok_item_bitrate")
                add(video.get("downloadAddr"), "tiktok_item_download_addr")
    if canonical:
        for node in soup.select('meta[property="og:video:secure_url"], meta[property="og:video:url"], meta[property="og:video"]')[:MEDIA_FETCH_LIMITS.max_video_candidates]:
            add(node.get("content"), "public_og_video")
    refused = False
    for address, method in candidates:
        try:
            target = check_binary_url(address, PLATFORM_VIDEO_HOST_SUFFIXES[platform])
        except UnsafeURL:
            refused = True
            continue
        if urlsplit(target.url).path.lower().endswith((".m3u8", ".mpd", ".m3u")):
            continue
        return target.url, method
    if refused:
        raise UnsafeURL("Public page video URLs do not satisfy the platform CDN policy.")
    raise NoPublicVideo("No identity-matched public MP4 URL is available in the anonymous page HTML.")


def _extract_image(html, soup, page_url, platform, source_id):
    """Require a post-owned image field; a bare OG image may be an avatar."""
    canonical = _check_page_identity(soup, page_url, platform, source_id)
    candidates, avatars = [], set()
    budget = [MEDIA_FETCH_LIMITS.max_json_nodes]

    def add(value, method):
        for address in _address_values(value):
            if len(candidates) < MEDIA_FETCH_LIMITS.max_video_candidates:
                candidates.append((address, method))

    for name, document in _documents(html, platform):
        objects = list(_objects(document, budget))
        for obj in objects:
            for key in ("profile_pic_url", "profile_pic_url_hd", "avatar", "avatarThumb", "avatarMedium", "avatarLarger"):
                avatars.update(_address_values(obj.get(key)))
        if platform == "instagram":
            for item in objects:
                ids = [item[key] for key in ("shortcode", "code") if isinstance(item.get(key), str)]
                if source_id not in ids:
                    continue
                if any(value != source_id for value in ids):
                    raise FetchError("Instagram image metadata has conflicting identities.")
                _check_item_access(item)
                if item.get("media_type") not in (1, 2, 8) and item.get("__typename") not in {"GraphImage", "GraphVideo", "GraphSidecar"} and not isinstance(item.get("is_video"), bool):
                    continue
                add(item.get("display_url"), "instagram_post_image")
                add(item.get("thumbnail_src"), "instagram_post_preview")
                images = item.get("image_versions2")
                versions = images.get("candidates") if isinstance(images, dict) else None
                if isinstance(versions, list):
                    for version in versions[:MEDIA_FETCH_LIMITS.max_video_candidates]:
                        if isinstance(version, dict):
                            add(version.get("url"), "instagram_post_image")
        else:
            item = _tiktok_item(name, document, source_id)
            if item is None:
                continue
            video = item.get("video")
            if isinstance(video, dict):
                for key in ("originCover", "cover"):
                    add(video.get(key), "tiktok_post_preview")
            image_post = item.get("imagePost")
            images = image_post.get("images") if isinstance(image_post, dict) else None
            if isinstance(images, list) and images and isinstance(images[0], dict):
                # A slideshow is not fully analyzed: only its first public still.
                add(images[0].get("imageURL"), "tiktok_first_post_image")
    if canonical:
        owned = {address for address, _ in candidates}
        for node in soup.select('meta[property="og:image"], meta[property="og:image:secure_url"]')[:MEDIA_FETCH_LIMITS.max_video_candidates]:
            if node.get("content") in owned:
                candidates.insert(0, (node["content"], "public_og_post_image"))
    for address, method in candidates:
        if address in avatars or re.search(r"(?:avatar|profile[_-]?(?:pic|image))", address, re.I):
            continue
        target = check_binary_url(address, PLATFORM_VIDEO_HOST_SUFFIXES[platform])
        return target.url, method
    raise FetchError("No identity-matched post photo or poster is available; unverified OG images and profile avatars are not evidence.")


async def _download_public_image(url, target_path, *, allowed_host_suffixes, max_bytes, deadline, initial_cancels):
    """Separate raster transport; the existing MP4 downloader stays strict."""
    from .media_worker import image_format
    mime_formats = {"image/jpeg": "JPEG", "image/png": "PNG", "image/webp": "WEBP"}
    if not 1 <= max_bytes <= MAX_BINARY_BYTES:
        raise FetchError("Image byte limit exceeds the hard bound.")
    temporary = None
    current, seen = url, set()
    try:
        for hop in range(MEDIA_FETCH_LIMITS.max_redirects + 1):
            _check_acquisition_deadline(deadline, initial_cancels)
            check_binary_url(current, allowed_host_suffixes)
            target = await validate_url(current)
            _check_acquisition_deadline(deadline, initial_cancels)
            if target.url in seen:
                raise FetchError("Image redirect loop detected.")
            seen.add(target.url)
            pinned = httpx.URL(target.url).copy_with(host=target.addresses[0])
            async with httpx.AsyncClient(trust_env=False, follow_redirects=False, verify=True,
                    timeout=httpx.Timeout(15, connect=5),
                    limits=httpx.Limits(max_connections=1, max_keepalive_connections=0)) as client:
                _check_acquisition_deadline(deadline, initial_cancels)
                async with client.stream("GET", pinned, extensions={"sni_hostname": target.host},
                        headers={"Host": target.authority, "User-Agent": "SafeNet-Public-Collector/1.0",
                                 "Accept": ", ".join(mime_formats), "Accept-Encoding": "identity"}) as response:
                    if response.status_code in REDIRECT_CODES:
                        location = response.headers.get("location", "")
                        if hop == MEDIA_FETCH_LIMITS.max_redirects or not location:
                            raise FetchError("Image redirect limit or missing destination.")
                        if "\\" in location or any(c.isspace() or ord(c) < 33 or ord(c) == 127 for c in location):
                            raise UnsafeURL("Malformed image redirect.")
                        current = urljoin(target.url, location)
                        continue
                    if response.status_code in {401, 403, 407, 429, 451}:
                        raise BinaryAccessBlocked("Public image access restricted.")
                    if response.status_code != 200:
                        raise FetchError("Public image source did not return HTTP 200.")
                    content_type = response.headers.get("content-type", "").split(";", 1)[0].strip().lower()
                    if content_type not in mime_formats or response.headers.get("content-encoding", "identity").lower() not in {"", "identity"}:
                        raise FetchError("Public image must be uncompressed JPEG, PNG or WebP.")
                    length = response.headers.get("content-length")
                    if length is not None and (not length.isascii() or not length.isdigit() or len(length) > 12 or int(length) > max_bytes):
                        raise FetchError("Invalid image size or image exceeds download byte limit.")
                    fd, name = tempfile.mkstemp(prefix=".safenet-image-", suffix=".part", dir=target_path.parent)
                    temporary = Path(name)
                    total, prefix = 0, bytearray()
                    try:
                        output = os.fdopen(fd, "wb")
                    except BaseException:
                        os.close(fd)
                        raise
                    with output:
                        async for chunk in response.aiter_raw(chunk_size=64 * 1024):
                            _check_acquisition_deadline(deadline, initial_cancels)
                            total += len(chunk)
                            if total > max_bytes:
                                raise FetchError("Image exceeds the download byte limit.")
                            prefix.extend(chunk[:max(0, 16 - len(prefix))])
                            if len(prefix) >= 16 and image_format(prefix) != mime_formats[content_type]:
                                raise FetchError("Public image signature disagrees with its MIME type.")
                            output.write(chunk)
                    if image_format(prefix) != mime_formats[content_type] or (length is not None and total != int(length)):
                        raise FetchError("Truncated image or unsupported image signature.")
                    await asyncio.sleep(0)
                    _check_acquisition_deadline(deadline, initial_cancels)
                    os.replace(temporary, target_path)
                    temporary = None
                    return {"path": str(target_path), "url": target.url, "download_bytes": total, "content_type": content_type}
    except httpx.HTTPError as exc:
        raise FetchError("Public image download failed.") from exc
    finally:
        if temporary is not None:
            temporary.unlink(missing_ok=True)
    raise FetchError("No public image response obtained.")


async def acquire_public_video(url: str, target_path: Path, on_event=None) -> dict:
    """Compatibility entry point: strictly video, never a substituted photo."""
    return await _acquire_public_media(url, target_path, on_event, allow_image=False)


async def acquire_public_media(url: str, target_path: Path, on_event=None) -> dict:
    """Video first; if HTML has no video, obtain one verified public still.

    Caller must use the returned path and metadata.media_kind/coverage. Image
    fallback is saved beside the requested .mp4 target as .image; it never proves
    the original video was analyzed. No fallback after blocked/failed downloads.
    """
    return await _acquire_public_media(url, target_path, on_event, allow_image=True)


async def _acquire_public_media(url: str, target_path: Path, on_event=None, *, allow_image=False) -> dict:
    """Return {status, path, reason, metadata}; path is present only on success.

    target_path must end in .mp4 and its parent must exist. The caller owns the
    completed file. download_bytes counts committed media bytes (zero on failure).
    on_event is an optional async callback receiving {stage, message}, bounded to
    two seconds by the existing collector helper. Cancellation propagates and
    cleans temporary files. The 120-second deadline includes page + callbacks +
    binary acquisition; it is not reset on redirects.
    """
    metadata = {"source_url": url, "download_bytes": 0, "collector": "public_video_http",
                "authenticated": False, "javascript_enabled": False,
                "source_trust": "untrusted_public_content",
                "max_download_bytes": MEDIA_FETCH_LIMITS.max_download_bytes,
                "timeout_seconds": MEDIA_FETCH_LIMITS.timeout_seconds}

    def result(status, reason=None, path=None):
        return {"status": status, "path": path, "reason": reason, "metadata": metadata}

    deadline = asyncio.get_running_loop().time() + MEDIA_FETCH_LIMITS.timeout_seconds
    initial_cancels = asyncio.current_task().cancelling()
    try:
        async with asyncio.timeout_at(deadline):
            platform, source_id, source_url = _permalink(url)
            if not allow_image and platform == "tiktok" and "/photo/" in urlsplit(source_url).path:
                raise FetchError("A public video permalink is required.")
            metadata.update(platform=platform, source_id=source_id, source_url=source_url)
            target_path = Path(target_path)
            if target_path.suffix.lower() != ".mp4":
                raise FetchError("Public video target must use the .mp4 extension.")
            await collectors._emit(on_event, "media_fetching", "Fetching the anonymous public video permalink.")
            _check_acquisition_deadline(deadline, initial_cancels)
            response = await _page(source_url, platform, source_id, deadline=deadline, initial_cancels=initial_cancels)
            _check_acquisition_deadline(deadline, initial_cancels)
            metadata.update(page_url=response["url"], http_status=response["status_code"])
            html = response["text"]
            if len(html) > MEDIA_FETCH_LIMITS.max_page_bytes:
                raise FetchError("Public video page exceeds its document limit.")
            soup = collectors._soup(html)
            blocked = collectors._blocked(soup, response["url"], response["status_code"], platform)
            if blocked:
                raise BinaryAccessBlocked(blocked)
            if response["status_code"] != 200:
                raise FetchError(f"Public video page returned HTTP {response['status_code']}.")
            actual_platform, actual_id, _ = _permalink(response["url"])
            if (actual_platform, actual_id) != (platform, source_id):
                raise FetchError("Public page identifies a different video.")
            await collectors._emit(on_event, "media_extracting", "Checking public video identity, access gates and the source CDN.")
            _check_acquisition_deadline(deadline, initial_cancels)
            media_kind = "video"
            try:
                media_url, extraction = _extract_video(html, soup, response["url"], platform, source_id)
            except NoPublicVideo:
                if not allow_image:
                    raise
                media_url, extraction = _extract_image(html, soup, response["url"], platform, source_id)
                media_kind = "image"
            _check_acquisition_deadline(deadline, initial_cancels)
            metadata.update(extraction=extraction, media_host=urlsplit(media_url).hostname,
                            media_kind=media_kind, coverage="public_preview_image" if media_kind == "image" else "public_video")
            await collectors._emit(on_event, "media_downloading", "Downloading one bounded public media file through DNS-pinned HTTPS.")
            _check_acquisition_deadline(deadline, initial_cancels)
            if media_kind == "image":
                downloaded = await _download_public_image(media_url, target_path.with_suffix(".image"),
                    allowed_host_suffixes=PLATFORM_VIDEO_HOST_SUFFIXES[platform],
                    max_bytes=min(MEDIA_FETCH_LIMITS.max_download_bytes, 16 * 1024 * 1024),
                    deadline=deadline, initial_cancels=initial_cancels)
            else:
                downloaded = await download_public_binary(media_url, target_path,
                    allowed_host_suffixes=PLATFORM_VIDEO_HOST_SUFFIXES[platform],
                    max_bytes=MEDIA_FETCH_LIMITS.max_download_bytes,
                    timeout=min(MEDIA_FETCH_LIMITS.timeout_seconds, deadline - asyncio.get_running_loop().time()))
            metadata.update(download_bytes=downloaded["download_bytes"], content_type=downloaded["content_type"],
                            media_host=urlsplit(downloaded["url"]).hostname)
            return result("completed", path=downloaded["path"])
    except (BinaryAccessBlocked, UnsafeURL) as exc:
        metadata["retry_after_seconds"] = 900
        return result("blocked", str(exc))
    except FetchError as exc:
        return result("unavailable", str(exc))
    except (TimeoutError, OSError, RecursionError):
        return result("unavailable", "Public video acquisition failed or exceeded its time/resource limit.")
