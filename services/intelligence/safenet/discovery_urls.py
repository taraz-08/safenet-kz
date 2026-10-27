"""Bounded, offline selection of public content URL shapes for monitoring.

This does not prove that an account/post is public or available. Collectors must
still validate DNS/redirects and stop at private content, login or CAPTCHA gates.
No redirects (including link shims and opaque short links) are resolved here.
"""

import re
from collections.abc import Iterable, Mapping
from itertools import islice
from urllib.parse import parse_qs, unquote, urlsplit


MAX_URL_LENGTH = 2048
MAX_SEEDS = 100
MAX_CANDIDATES = 200

# Exact aliases only: e.g. l.instagram.com is a redirector, not a source.
_HOSTS = {
    "instagram": {"instagram.com", "www.instagram.com", "m.instagram.com"},
    "tiktok": {"tiktok.com", "www.tiktok.com", "m.tiktok.com"},
    "youtube": {"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"},
    "threads": {"threads.com", "www.threads.com", "threads.net", "www.threads.net"},
    "telegram": {"t.me", "www.t.me", "telegram.me", "www.telegram.me"},
}
_INSTAGRAM_NAV = frozenset("""
    about accounts ads api auth business captcha challenge checkpoint consent
    create data developer developers direct directory download emails explore
    favorites graphql help home legal login logout news notifications oauth oauth2
    p press privacy push reel reels register search settings share share_story sh
    shop signin signup static stories support terms tv web
""".split())
_TELEGRAM_NAV = frozenset("""
    a addemoji addlist addstickers addtheme auth bg boost c confirmphone contact faq
    giftcode invoice iv joinchat k login logout msg msg_url oauth passport premium
    proxy s setlanguage share socks stars
""".split())
_TELEGRAM_ACTIONS = {"start", "startgroup", "startchannel", "startapp", "game", "attach", "choose", "boost"}
_CODE = r"[A-Za-z0-9_-]{1,64}"
_VIDEO_ID = r"[A-Za-z0-9_-]{11}"
_POST_ID = r"[1-9][0-9]{0,19}"


def _username(value: str, max_length: int = 30) -> bool:
    return bool(re.fullmatch(r"[A-Za-z0-9_][A-Za-z0-9_.]{0," + str(max_length - 1) + r"}", value)
                and not value.endswith(".") and ".." not in value)


def public_content_url(url: str, platform: str) -> str | None:
    """Return a canonical HTTPS source URL, or None for unsupported/noncontent input.

    Accepts absolute HTTP(S) URLs on exact platform hosts. Tracking queries and
    fragments are removed; only YouTube's video ID survives. Instagram supports
    profiles and p/reel posts (also username-qualified posts), TikTok profiles and
    videos, YouTube watch/shorts/youtu.be videos and handle/channel profiles,
    Threads profiles/posts, and Telegram channel/post links (canonical /s/ preview).
    Identifier case is preserved for posts/videos/channels; usernames are lowered.
    """
    if not isinstance(platform, str) or platform not in _HOSTS:
        return None
    if not isinstance(url, str) or not url or len(url) > MAX_URL_LENGTH:
        return None
    # urlsplit silently removes some control characters; reject them first.
    if re.search(r"[\x00-\x1f\x7f\\]", url):
        return None
    url = url.strip()
    try:
        parts = urlsplit(url)
        host = parts.hostname
        if parts.scheme not in {"http", "https"} or host not in _HOSTS[platform]:
            return None
        # Reject credentials, non-default/invalid ports and ambiguous authorities.
        default_port = "443" if parts.scheme == "https" else "80"
        if parts.netloc.lower() not in {host, host + ":" + default_port}:
            return None
        # Decode only once; encoded separators must not create new path segments.
        if re.search(r"%(?:2f|5c|25)", parts.path, re.I):
            return None
        path = unquote(parts.path, errors="strict")
        if (not path.startswith("/") or "//" in path
                or any(segment in {".", ".."} for segment in path.split("/"))):
            return None
        segments = path.strip("/").split("/")

        if platform == "instagram":
            if len(segments) == 1 and _username(segments[0]) and segments[0].lower() not in _INSTAGRAM_NAV:
                return "https://www.instagram.com/" + segments[0].lower() + "/"
            if len(segments) == 3 and _username(segments[0]) and segments[0].lower() not in _INSTAGRAM_NAV:
                segments = segments[1:]
            if len(segments) == 2 and segments[0] in {"p", "reel", "reels"} and re.fullmatch(_CODE, segments[1]):
                kind = "p" if segments[0] == "p" else "reel"
                return f"https://www.instagram.com/{kind}/{segments[1]}/"

        elif platform == "tiktok":
            if segments[0].startswith("@") and _username(segments[0][1:], 24):
                profile = "https://www.tiktok.com/@" + segments[0][1:].lower()
                if len(segments) == 1:
                    return profile
                if len(segments) == 3 and segments[1] in {"video", "photo"} and re.fullmatch(_POST_ID, segments[2]):
                    return profile + "/" + segments[1] + "/" + segments[2]

        elif platform == "youtube":
            video = None
            if host == "youtu.be":
                if len(segments) == 1:
                    video = segments[0]
            elif segments == ["watch"]:
                query = parse_qs(parts.query, keep_blank_values=True, max_num_fields=32)
                ids = query.get("v", [])
                if len(ids) == 1:
                    video = ids[0]
            elif len(segments) == 2 and segments[0] == "shorts":
                video = segments[1]
            elif len(segments) == 2 and segments[0] == "channel" and re.fullmatch(r"UC[A-Za-z0-9_-]{22}", segments[1]):
                return "https://www.youtube.com/channel/" + segments[1]
            elif len(segments) == 1 and re.fullmatch(r"@[A-Za-z0-9_][A-Za-z0-9_.-]{0,29}", segments[0]):
                return "https://www.youtube.com/" + segments[0].lower()
            if video and re.fullmatch(_VIDEO_ID, video):
                return "https://www.youtube.com/watch?v=" + video

        elif platform == "threads":
            if segments[0].startswith("@") and _username(segments[0][1:]):
                profile = "https://www.threads.com/@" + segments[0][1:].lower()
                if len(segments) == 1:
                    return profile
                if len(segments) == 3 and segments[1] == "post" and re.fullmatch(_CODE, segments[2]):
                    return profile + "/post/" + segments[2]

        elif platform == "telegram":
            if segments[0] == "s":
                segments = segments[1:]
            if len(segments) not in {1, 2} or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,31}", segments[0]):
                return None
            if segments[0].lower() in _TELEGRAM_NAV:
                return None
            query = parse_qs(parts.query, keep_blank_values=True, max_num_fields=32)
            if _TELEGRAM_ACTIONS.intersection(key.lower() for key in query):
                return None
            channel = "https://t.me/s/" + segments[0].lower()
            if len(segments) == 1:
                return channel
            if re.fullmatch(_POST_ID, segments[1]):
                return channel + "/" + segments[1]
    except (ValueError, UnicodeError):
        return None
    return None


def public_content_urls(urls: Iterable[str] | None, platform: str, *, limit: int = MAX_SEEDS) -> list[str]:
    """Filter/deduplicate in order, inspecting at most 200 inputs and keeping <=100.

    Invalid entries/containers are ignored, including malformed persisted seeds.
    The caller may impose a smaller output limit (e.g. for a discovery batch).
    """
    if limit <= 0 or isinstance(urls, (str, bytes, Mapping)):
        return []
    try:
        candidates = iter(urls)
    except TypeError:
        return []
    result = []
    seen = set()
    for candidate in islice(candidates, MAX_CANDIDATES):
        canonical = public_content_url(candidate, platform)
        if canonical is not None and canonical not in seen:
            result.append(canonical)
            seen.add(canonical)
            if len(result) >= min(limit, MAX_SEEDS):
                break
    return result
