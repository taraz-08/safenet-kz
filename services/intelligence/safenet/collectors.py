"""Public collectors. Source text is untrusted evidence, never agent instructions.

No authentication, CAPTCHA solving, stealth, scrolling, clicking or private APIs.
Playwright is an optional, offline static renderer of an already validated HTTP
response. It never has independent egress and cannot bypass a blocked response.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import json
import os
import re
import signal
import subprocess
import sys
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlencode, urljoin, urlsplit

from bs4 import BeautifulSoup, Comment, SoupStrainer

from .safe_fetch import FetchError, UnsafeURL, fetch_public, normalize_url, validate_url

MAX_TEXT_CHARS = 20_000
MAX_LINKS = 40
MAX_LINK_CANDIDATES = 160
MAX_TELEGRAM_POSTS = 20
MAX_THREADS_POSTS = 20
MAX_JSON_SCRIPTS = 128
MAX_JSON_CHARS = 2 * 1024 * 1024
MAX_JSON_NODES = 20_000
COLLECT_TIMEOUT = 35.0
BROWSER_TIMEOUT = 8.0
RENDER_WORKER_GRACE = 3.0
PLATFORM_HOSTS = {
    "tiktok": frozenset({"tiktok.com", "www.tiktok.com", "m.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"}),
    "instagram": frozenset({"instagram.com", "www.instagram.com", "m.instagram.com"}),
    "youtube": frozenset({"youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"}),
    "threads": frozenset({"threads.net", "www.threads.net", "threads.com", "www.threads.com"}),
    "telegram": frozenset({"t.me", "www.t.me", "telegram.me", "www.telegram.me"}),
}
_BLOCKED_HTTP = {401, 403, 407, 429, 451}
_ACCESS_PATH = re.compile(r"/(?:accounts/login|login|signin|sign-in|checkpoint|captcha|consent)(?:/|$)", re.I)
_GATE = re.compile(
    r"verify (?:that )?you(?:'re| are) (?:a )?human|confirm (?:that )?you(?:'re| are) (?:a )?human|"
    r"complete (?:the |this )?(?:captcha|security check)|checking your browser|"
    r"unusual traffic|automated (?:queries|requests)|access denied|request blocked|"
    r"(?:log|sign) in to (?:continue|view|see|watch)|login required|"
    r"(?:this|the) account is private|this content (?:isn't|is not) available|"
    r"before you continue to (?:youtube|google)|"
    r"подтвердите,? что вы (?:человек|не робот)|проверка безопасности|"
    r"войдите,? чтобы (?:продолжить|посмотреть)|вход в аккаунт|доступ (?:ограничен|запрещен)|"
    r"это закрытый аккаунт|аккаунт закрыт|адам екеніңізді растаңыз", re.I,
)
_SHELL = re.compile(
    r"^(?:youtube|instagram|tiktok|threads|telegram|log in|sign in|sign up|"
    r"enable javascript|please enable javascript|you need to enable javascript to run this app)[.!\s]*$", re.I,
)
_GENERIC_DESCRIPTION = re.compile(
    r"^(?:enjoy the videos and music you love|create an account or log in to instagram|"
    r"log in to instagram|join instagram|tiktok - make your day|say more with threads|"
    r"смотрите любимые видео|смотрите видео и слушайте музыку|"
    r"өзіңізге ұнайтын бейнелер мен музыканы тамашалаңыз)", re.I,
)
_TELEGRAM_CONTACT_SHELL = re.compile(
    r"(?:If you have Telegram\s*,\s*you can contact @[A-Za-z0-9_]+ right away\.?|"
    r"You can (?:view and join|contact) @[A-Za-z0-9_]+ right away\.?)", re.I,
)
_INSTAGRAM_UI = re.compile(
    r"^(?:show more posts from .+|see (?:instagram )?photos and videos from .+|"
    r"posts(?: reels)?(?: tagged)?|reels|tagged|log in|sign up|"
    r"[\d.,\s]+[kmbмк]?(?:\s*(?:тыс|млн)\.?)?\s*(?:followers?|following|posts?|"
    r"подписчик\w*|подписок|публикаци\w*|жазылушы|жазылым|жарияланым))$", re.I,
)
_YOUTUBE_ASSIGNMENT = re.compile(
    r'''(?:^|[;\n])\s*(?:(?:var|let|const)\s+)?(?:'''
    r'''(?P<bare>ytInitialPlayerResponse|ytInitialData)|'''
    r'''window\s*\[\s*["'](?P<window>ytInitialPlayerResponse|ytInitialData)["']\s*\])\s*=\s*(?=\{)'''
)


async def _emit(callback, stage: str, message: str) -> None:
    if callback is not None:
        # Event consumers must not turn a bounded collector into an unbounded job.
        await asyncio.wait_for(callback({"stage": stage, "message": message}), timeout=2.0)


def _metadata(platform: str) -> dict:
    result = {
        "platform": platform, "collector": "public_http", "source_trust": "untrusted_public_content",
        "collected_at": datetime.now(timezone.utc).isoformat(), "authenticated": False,
        "content_scope": "public_page_text_and_metadata", "links_dns_validated": False,
        "screenshot_reason": "No verified safe screenshot captured.",
        "browser": "not_used", "javascript_enabled": False,
        "limitations": [
            "Only public static text and metadata are collected; page JavaScript and interactive navigation are disabled.",
            "Video, audio, transcripts and screenshots are not collected.",
        ],
    }
    if platform in {"instagram", "tiktok"}:
        result["terms_notice"] = "Automated public collection may conflict with platform terms; see ADR 0003."
    return result


def _result(status: str, url: str, metadata: dict, *, reason: str | None = None,
            title: str = "", text: str = "", links: list[str] | None = None) -> dict:
    return {"status": status, "url": url, "title": title[:500], "text": text[:MAX_TEXT_CHARS],
            "links": links or [], "metadata": metadata, "reason": reason, "screenshot_path": None}


def _platform(url: str, requested: str) -> str:
    target = normalize_url(url)
    if requested not in {"web", *PLATFORM_HOSTS}:
        raise UnsafeURL("Unsupported public collector platform.")
    if requested != "web":
        if target.host not in PLATFORM_HOSTS[requested]:
            raise UnsafeURL("URL does not belong to the requested public platform.")
        return requested
    return next((name for name, hosts in PLATFORM_HOSTS.items() if target.host in hosts), "web")


def _access_path(url: str, platform: str) -> bool:
    path = unquote(urlsplit(url).path)
    if _ACCESS_PATH.search(path):
        return True
    # TikTok /challenge/<tag> is a public hashtag page, not a CAPTCHA route.
    if platform == "instagram" and re.match(r"/challenge(?:/|$)", path, re.I):
        return True
    return platform == "telegram" and bool(re.match(r"/(?:\+|joinchat/|c/)", path, re.I))


def _soup(html: str) -> BeautifulSoup:
    soup = BeautifulSoup(html, "html.parser")
    for node in soup.find_all(["script", "style", "template", "noscript"]):
        node.decompose()
    for node in soup.find_all(string=lambda s: isinstance(s, Comment)):
        node.extract()
    for node in list(soup.find_all(True)):
        if node.attrs is None:
            continue
        style = re.sub(r"\s+", "", str(node.get("style", ""))).lower()
        if node.has_attr("hidden") or str(node.get("aria-hidden", "")).lower() == "true" or "display:none" in style or "visibility:hidden" in style:
            node.decompose()
    return soup


def _blocked(soup: BeautifulSoup, url: str, status: int, platform: str) -> str | None:
    if status in _BLOCKED_HTTP:
        return f"Public access blocked (HTTP {status}); no login or challenge bypass attempted."
    if _access_path(url, platform):
        return "Authentication, consent, challenge or private-invite URL; public collection stopped."
    if soup.select_one(
        "#challenge-form, #challenge-running, .g-recaptcha, .h-captcha, "
        "iframe[src*='recaptcha'], iframe[src*='hcaptcha'], form[action*='/challenge']"
    ):
        return "An access challenge is present; public collection stopped."
    visible = soup.get_text(" ", strip=True)[:MAX_TEXT_CHARS]
    headings = " ".join(n.get_text(" ", strip=True) for n in soup.find_all(["title", "h1", "h2"], limit=12))
    title = soup.title.get_text(" ", strip=True) if soup.title else ""
    if re.fullmatch(r"just a moment[.!\s]*|attention required!?\s*\|?\s*cloudflare|security check", title, re.I):
        return "The public page is an access-verification interstitial."
    if platform != "web" and re.match(r"^(?:log\s?in|sign\s?in|вход|войти)(?:\s|[|•–-]|$)", title, re.I):
        return "The platform returned a login page; anonymous collection stopped."
    if _GATE.search(headings) or (len(visible) < 1600 and _GATE.search(visible)):
        return "The public page requires login, consent, verification, or denies access."
    if soup.select_one("input[type='password']") and (
        len(visible) < 1600 or re.search(r"(?:log|sign)\s*in|вход|войти", headings, re.I)
    ):
        return "Login form prevents anonymous public collection."
    return None


def _safe_links(candidates, base: str) -> list[str]:
    links: list[str] = []
    seen: set[str] = set()
    for index, value in enumerate(candidates):
        if index >= MAX_LINK_CANDIDATES or len(links) >= MAX_LINKS:
            break
        if not isinstance(value, str) or not value or value.startswith("#"):
            continue
        # Check before urljoin, which silently strips tabs/newlines.
        if "\\" in value or any(c.isspace() or ord(c) < 33 or ord(c) == 127 for c in value):
            continue
        try:
            link = normalize_url(urljoin(base, value)).url
        except (UnsafeURL, ValueError):
            continue
        if link not in seen:
            seen.add(link)
            links.append(link)
    return links


def _source_links(candidates, url: str, platform: str) -> list[str]:
    """Keep inert source links, not login/footer destinations or tracking wrappers."""
    values = []
    for index, value in enumerate(candidates):
        if index >= MAX_LINK_CANDIDATES:
            break
        if not isinstance(value, str) or not value or value.startswith("#"):
            continue
        if "\\" in value or any(c.isspace() or ord(c) < 33 or ord(c) == 127 for c in value):
            continue
        try:
            target = normalize_url(urljoin(url, value))
            parts = urlsplit(target.url)
            if platform == "instagram" and target.host == "l.instagram.com":
                value = parse_qs(parts.query).get("u", [""])[0]
                # Decode, validate and retain the destination; never visit it.
                target = normalize_url(value)
            elif platform == "youtube" and target.host in PLATFORM_HOSTS[platform] and parts.path == "/redirect":
                value = parse_qs(parts.query).get("q", [""])[0]
                target = normalize_url(value)
            if target.host in PLATFORM_HOSTS[platform]:
                path = urlsplit(target.url).path
                if _access_path(target.url, platform) or path == "/":
                    continue
                if platform == "youtube" and _youtube_resource(target.url) is None:
                    continue
                if platform == "instagram" and re.match(r"/(?:accounts|about|legal|developer|explore|direct)(?:/|$)", path):
                    continue
            values.append(value)
        except (UnsafeURL, ValueError):
            continue
    return _safe_links(values, url)


def _json_objects(value):
    """Walk only bounded JSON containers; never interpret script expressions."""
    stack = [iter([value])]
    count = 0
    while stack and count < MAX_JSON_NODES:
        try:
            item = next(stack[-1])
        except StopIteration:
            stack.pop()
            continue
        count += 1
        if isinstance(item, dict):
            yield item
            if len(stack) < 64:
                stack.append(iter(item.values()))
        elif isinstance(item, list) and len(stack) < 64:
            stack.append(iter(item))


def _embedded_documents(html: str, platform: str):
    scripts = BeautifulSoup(html, "html.parser", parse_only=SoupStrainer("script"))
    remaining = MAX_JSON_CHARS
    for node in scripts.find_all("script", limit=MAX_JSON_SCRIPTS):
        raw = node.string or ""
        if not raw or len(raw) > remaining or node.get("src"):
            continue
        if platform in {"instagram", "threads"}:
            if node.get("type") != "application/json":
                continue
            remaining -= len(raw)
            try:
                yield platform, json.loads(raw)
            except (ValueError, RecursionError):
                continue
        else:
            for index, match in enumerate(_YOUTUBE_ASSIGNMENT.finditer(raw)):
                if index >= 4 or len(raw) > remaining:
                    break
                remaining -= len(raw)
                try:
                    value, _ = json.JSONDecoder().raw_decode(raw[match.end():])
                    if isinstance(value, dict):
                        yield match.group("bare") or match.group("window"), value
                except (ValueError, RecursionError):
                    continue


def _text_field(value) -> str:
    return value.strip() if isinstance(value, str) else ""


def _threads_resource(url: str) -> tuple[str, str | None] | None:
    try:
        target = normalize_url(url)
    except (UnsafeURL, ValueError):
        return None
    if target.host not in PLATFORM_HOSTS["threads"]:
        return None
    match = re.fullmatch(r"/@([A-Za-z0-9_.]{1,30})(?:/post/([A-Za-z0-9_-]{1,64}))?/?",
                         unquote(urlsplit(target.url).path))
    return (match[1].casefold(), match[2]) if match else None


def _threads_json_metadata(html: str, url: str, soup: BeautifulSoup) -> dict:
    """Only source-owned fields in public HTML hydration; no API requests."""
    missing = {"status": "unavailable", "reason": "No identity-verified public Threads profile or post text was present."}
    resource = _threads_resource(url)
    if resource is None:
        return missing
    # Canonical metadata, when supplied, must agree with the requested resource.
    for node in soup.select('meta[property="og:url"], link[rel="canonical"]', limit=8):
        if _threads_resource(str(node.get("content") or node.get("href") or "")) != resource:
            return missing
    selected = None
    posts: dict[str, str] = {}
    for _, document in _embedded_documents(html, "threads"):
        for box in _json_objects(document):
            # Observed public Relay hydration: __bbox.result.data.user / media.
            # Do not pick users, quotes, replies or recommended posts recursively.
            result = box.get("result")
            data = result.get("data") if isinstance(result, dict) else None
            if not isinstance(data, dict):
                continue
            if resource[1] is None and len(posts) < MAX_THREADS_POSTS:
                feed = data.get("mediaData")
                edges = feed.get("edges") if isinstance(feed, dict) else None
                for edge in edges[:MAX_LINK_CANDIDATES] if isinstance(edges, list) else []:
                    node = edge.get("node") if isinstance(edge, dict) else None
                    items = node.get("thread_items") if isinstance(node, dict) else None
                    item = items[0] if isinstance(items, list) and items else None
                    media = item.get("post") if isinstance(item, dict) else None
                    if not isinstance(media, dict):
                        continue
                    author, info, caption = media.get("user"), media.get("text_post_app_info"), media.get("caption")
                    code = _text_field(media.get("code"))
                    if (not isinstance(author, dict) or not isinstance(info, dict) or not isinstance(caption, dict)
                            or _text_field(author.get("username")).casefold() != resource[0]
                            or author.get("text_post_app_is_private") is not False
                            or author.get("is_private") is True or author.get("gating")
                            or info.get("is_post_unavailable") is not False or info.get("is_reply") is not False
                            or any(info.get(key) for key in ("post_unavailable_reason", "post_tombstone_info", "attachment_tombstone_info"))
                            or not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", code)):
                        continue
                    text = _text_field(caption.get("text"))
                    if text:
                        if code in posts and posts[code] != text:
                            return missing
                        posts[code] = text
                    if len(posts) >= MAX_THREADS_POSTS:
                        break
            source = data.get("media" if resource[1] else "user")
            if not isinstance(source, dict):
                continue
            owner = source.get("user") if resource[1] else source
            if not isinstance(owner, dict) or _text_field(owner.get("username")).casefold() != resource[0]:
                continue
            if resource[1] and source.get("code") != resource[1]:
                continue
            if owner.get("text_post_app_is_private") is True or owner.get("is_private") is True or owner.get("gating"):
                return {"status": "blocked", "reason": "The requested Threads source is private or gated; collection stopped."}
            if owner.get("text_post_app_is_private") is not False:
                continue
            if resource[1]:
                info = source.get("text_post_app_info")
                if not isinstance(info, dict):
                    continue
                if info.get("is_post_unavailable") or info.get("post_unavailable_reason") or info.get("post_tombstone_info") or info.get("attachment_tombstone_info"):
                    return {"status": "blocked", "reason": "Threads marks the requested post as restricted or unavailable."}
                if info.get("is_post_unavailable") is not False:
                    continue
                caption = source.get("caption")
                description = _text_field(caption.get("text")) if isinstance(caption, dict) else ""
                links = []
            else:
                description = _text_field(source.get("biography"))
                bio_links = source.get("bio_links")
                links = [item.get("url") for item in bio_links[:MAX_LINK_CANDIDATES] if isinstance(item, dict)] if isinstance(bio_links, list) else []
            candidate = {"description": description, "profile_name": _text_field(owner.get("full_name"))[:500],
                         "links": links, "content_scope": "public_threads_post" if resource[1] else "public_threads_profile_metadata"}
            # Conflicting copies are not a reliable source; fail closed.
            if selected is not None and selected != candidate:
                return missing
            selected = candidate
    if selected is not None and resource[1] is None and len(selected["description"]) < 20 and posts:
        # A profile without a bio can still expose its own public preview posts.
        # Attribute every collected caption to its code; never use reply/quote text.
        source_urls = [f"https://www.threads.com/@{resource[0]}/post/{code}" for code in posts]
        selected.update({"description": "\n\n".join(posts.values()), "visible_texts": list(posts.values()),
                         "links": source_urls, "source_post_urls": source_urls, "posts_collected": len(posts),
                         "post_limit": MAX_THREADS_POSTS, "content_scope": "public_threads_profile_posts"})
    return selected or missing


def _threads_more_prompt(soup: BeautifulSoup, url: str, embedded: dict) -> None:
    """Exclude only the observed optional upsell beside verified visible text.

    All HTTP/path/challenge/title/password/genuine gate checks still run below.
    A hidden JSON profile alone can never turn a login wall into evidence.
    """
    resource = _threads_resource(url)
    if (resource is None or resource[1] or embedded.get("status")
            or len(embedded.get("description", "")) < 20
            or soup.select_one("input[type='password']")):
        return
    # Compare words to tolerate a decorative sticker in the public biography.
    words = lambda text: " ".join(re.findall(r"\w+", text.casefold()))
    visible = words(soup.get_text(" ", strip=True)[:MAX_TEXT_CHARS])
    source_texts = embedded.get("visible_texts", [embedded["description"]])
    if not any(len(words(value)) >= 20 and words(value) in visible for value in source_texts):
        return
    prompt = re.compile(r"^\s*Log in to see more from " + re.escape(resource[0]) + r"\.\s*$", re.I)
    for node in soup.find_all(string=prompt, limit=4):
        if not any(parent.name in {"title", "h1", "h2", "form"} or parent.get("role") == "dialog" for parent in node.parents):
            node.extract()


def _public_json_metadata(html: str, url: str, platform: str) -> dict:
    """Read source-owned fields from JSON already served in the public HTML."""
    if platform not in {"instagram", "youtube"}:
        return {}
    resource = _youtube_resource(url) if platform == "youtube" else None
    path = unquote(urlsplit(url).path).strip("/").split("/")
    if platform == "youtube" and resource is None:
        return {}
    if platform == "instagram" and (len(path) != 1 or not re.fullmatch(r"[A-Za-z0-9_.]{1,30}", path[0])):
        return {}
    for name, document in _embedded_documents(html, platform):
        if platform == "instagram":
            for user in _json_objects(document):
                if _text_field(user.get("username")).casefold() != path[0].casefold():
                    continue
                if user.get("is_private") is True:
                    return {"status": "blocked", "reason": "The public page identifies a private Instagram profile; collection stopped."}
                if "biography" not in user:
                    continue
                links = [user.get("external_url")]
                bio_links = user.get("bio_links")
                if isinstance(bio_links, list):
                    links.extend(item.get("url") for item in bio_links[:MAX_LINK_CANDIDATES] if isinstance(item, dict))
                return {"description": _text_field(user.get("biography")), "profile_name": _text_field(user.get("full_name"))[:500], "links": links,
                        "content_scope": "public_instagram_profile_metadata"}
        elif resource[0] == "videos" and name == "ytInitialPlayerResponse":
            playability = document.get("playabilityStatus")
            status = playability.get("status") if isinstance(playability, dict) else None
            if isinstance(status, str) and status not in {"OK", "LIVE_STREAM_OFFLINE"}:
                return {"status": "blocked" if status in {"LOGIN_REQUIRED", "AGE_CHECK_REQUIRED", "CONTENT_CHECK_REQUIRED"} else "unavailable",
                        "reason": "YouTube reports that the requested video is restricted or unavailable; no access bypass attempted."}
            video = document.get("videoDetails")
            if isinstance(video, dict) and video.get("videoId") == resource[1]["id"]:
                return {"title": _text_field(video.get("title")), "description": _text_field(video.get("shortDescription")),
                        "content_scope": "public_youtube_video_metadata"}
        elif resource[0] == "channels" and name == "ytInitialData":
            channel = document.get("metadata")
            channel = channel.get("channelMetadataRenderer") if isinstance(channel, dict) else None
            if not isinstance(channel, dict):
                continue
            if "id" in resource[1] and channel.get("externalId") != resource[1]["id"]:
                continue
            if "forHandle" in resource[1]:
                owners = channel.get("ownerUrls")
                if not isinstance(owners, list) or not any(
                    urlsplit(owner).hostname in PLATFORM_HOSTS["youtube"]
                    and unquote(urlsplit(owner).path).strip("/").casefold() == resource[1]["forHandle"].casefold()
                    for owner in _safe_links(owners, url)
                ):
                    continue
            return {"title": _text_field(channel.get("title")), "description": _text_field(channel.get("description")),
                    "content_scope": "public_youtube_channel_metadata"}
    return {}


def _description(value: str, platform: str) -> str:
    if _SHELL.fullmatch(value) or _GENERIC_DESCRIPTION.match(value):
        return ""
    if platform == "telegram" and _TELEGRAM_CONTACT_SHELL.fullmatch(value.strip()):
        return ""
    if platform == "instagram":
        bio = re.search(r"(?:on|в) Instagram:\s*(.*)", value, re.I | re.S)
        if bio:
            return bio[1].strip().strip('"“”«»').strip()
        if re.search(r"(?:see|watch) (?:instagram )?photos and videos from|followers.*following.*posts", value, re.I):
            return ""
    return value


def _telegram_posts(soup: BeautifulSoup, url: str) -> tuple[str, list[str], dict] | None:
    path = urlsplit(url).path.strip("/").split("/")
    if path and path[0] == "s":
        path = path[1:]
    channel = path[0] if path else ""
    post_id = path[1] if len(path) > 1 and path[1].isdigit() else None
    requested = f"{channel}/{post_id}" if post_id else None
    nodes = soup.select(".tgme_widget_message_text", limit=MAX_LINK_CANDIDATES)
    if not nodes and requested is None:
        return None
    paragraphs: list[str] = []
    source_urls: list[str] = []
    links: list[str] = []
    # Bound traversal even if a malicious preview contains thousands of widgets.
    for node in nodes:
        container = node.find_parent(class_="tgme_widget_message")
        source = str(container.get("data-post", "")) if container else ""
        if source and not re.fullmatch(r"[A-Za-z0-9_]{1,64}/[0-9]{1,20}", source):
            continue
        if requested and source.lower() != requested.lower():
            continue
        if source and source.split("/", 1)[0].lower() != channel.lower():
            continue
        text = node.get_text(" ", strip=True)
        if not text:
            continue
        paragraphs.append(text)
        if source:
            source_urls.append("https://t.me/" + source)
        links.extend(n.get("href") for n in node.find_all("a", href=True, limit=MAX_LINK_CANDIDATES))
        if requested or len(paragraphs) >= MAX_TELEGRAM_POSTS:
            break
    metadata = {
        "content_scope": "public_telegram_post" if requested else "public_telegram_channel_posts",
        "posts_collected": len(paragraphs), "post_limit": 1 if requested else MAX_TELEGRAM_POSTS,
        "source_post_urls": source_urls,
    }
    if requested:
        metadata["requested_post"] = requested
    # Preserve source post URLs before outbound links so the link cap cannot
    # discard attribution for later posts in a channel preview.
    return "\n\n".join(paragraphs), _safe_links(source_urls + links, url), metadata


def _extract(soup: BeautifulSoup, url: str, platform: str, metadata: dict | None = None,
             embedded: dict | None = None) -> tuple[str, str, list[str], bool]:
    title_node = soup.find("meta", attrs={"property": "og:title"})
    title = str(title_node.get("content", "")) if title_node else ""
    if not title and soup.title:
        title = soup.title.get_text(" ", strip=True)
    if platform in {"instagram", "youtube", "threads"} and metadata is not None:
        metadata.update({"content_scope": f"public_{platform}_page_metadata", "extraction_source": "public_html_metadata"})
        if platform == "threads" and embedded and embedded.get("content_scope") == "public_threads_profile_posts":
            metadata["limitations"].append("Only the author's identified preview posts in this public document are collected; replies, quotes and additional feed pages are excluded.")
        else:
            metadata["limitations"].append("Only the requested page's public text/metadata is inspected; other posts, channel uploads and comments are not collected.")
    if embedded:
        title = embedded.get("title") or title
        description = _description(embedded.get("description", ""), platform)
        if metadata is not None:
            metadata.update({"content_scope": embedded["content_scope"], "extraction_source": "embedded_public_json"})
            if platform == "threads" and "source_post_urls" in embedded:
                metadata.update({key: embedded[key] for key in ("source_post_urls", "posts_collected", "post_limit")})
        # A title, account identity or follower count alone is not a source check.
        if len(description) < 20:
            return title[:500], "", [], False
        # A verified profile's display name is source text too. Keep it next to
        # the bio so an explicit gaming name can contextualize a deposit offer;
        # the description-length guard above still rejects identity-only shells.
        content = ((title + "\n\n" + description).strip() if platform == "youtube" else
                   "\n".join(part for part in [embedded.get("profile_name", ""), description] if part))
        candidates = embedded.get("links", []) + re.findall(r"https?://[^\s<>\"']+", description[:MAX_TEXT_CHARS])
        links = _source_links(candidates, url, platform)
        return title[:500], content[:MAX_TEXT_CHARS], links, len(content) > MAX_TEXT_CHARS
    if platform == "telegram":
        posts = _telegram_posts(soup, url)
        if posts is not None:
            content, links, scope = posts
            if metadata is not None:
                metadata.update(scope)
            return title[:500], content[:MAX_TEXT_CHARS], links, len(content) > MAX_TEXT_CHARS
        if metadata is not None:
            metadata["content_scope"] = "public_telegram_profile_description"
    descriptions: list[str] = []
    for attrs in ({"property": "og:description"}, {"name": "description"}, {"name": "twitter:description"}):
        node = soup.find("meta", attrs=attrs)
        value = _description(str(node.get("content", "")).strip(), platform) if node else ""
        if value and value not in descriptions and not _SHELL.fullmatch(value):
            descriptions.append(value)
    # A language-independent identity check also rejects localized YouTube shells.
    youtube_identity = bool(title.strip()) and not re.fullmatch(r"\s*[-–—|•]?\s*youtube[.!\s]*", title, re.I)
    if platform == "youtube" and not youtube_identity:
        descriptions = []
    candidates = [n.get("href") for n in soup.find_all("a", href=True, limit=MAX_LINK_CANDIDATES)]
    if platform in {"instagram", "youtube"}:
        candidates = re.findall(r"https?://[^\s<>\"']+", "\n".join(descriptions)[:MAX_TEXT_CHARS]) + candidates
        links = _source_links(candidates, url, platform)
    else:
        links = _safe_links(candidates, url)
    for node in soup.find_all(["title", "nav", "header", "footer", "form", "button", "iframe", "object", "embed"]):
        node.decompose()
    if platform == "telegram":
        root = soup.select_one(".tgme_widget_message_text, .tgme_page_description")
    else:
        root = soup.find("main") or soup.find("article")
    # Social-app body text is typically menus and footers; without an actual
    # content root or source metadata it cannot establish a successful scan.
    if root is None and platform in {"instagram", "youtube"}:
        content = "\n\n".join(descriptions)
        return title[:500], content[:MAX_TEXT_CHARS], links, len(content) > MAX_TEXT_CHARS
    root = root or soup.body or soup
    # Skip document-head text so a title or a metadata-only shell is not a body.
    if root is soup and soup.head:
        soup.head.decompose()
    body = root.get_text(" ", strip=True)
    if platform == "telegram":
        body = _description(body, platform)
    if platform == "instagram":
        body = " ".join(line for line in root.stripped_strings if not _INSTAGRAM_UI.fullmatch(line))
    if platform == "youtube" and not youtube_identity:
        body = ""
    if platform == "youtube" and root.name != "article" and not descriptions:
        body = ""
    if _SHELL.fullmatch(body):
        body = ""
    pieces = descriptions + ([body] if body and body not in descriptions else [])
    content = "\n\n".join(pieces)
    return title[:500], content[:MAX_TEXT_CHARS], links, len(content) > MAX_TEXT_CHARS


def _browser_document(html: str) -> str:
    """Inert static render: no refresh, frames, forms, scripts or external assets."""
    soup = _soup(html)
    for node in soup.find_all(["meta", "base", "link", "iframe", "frame", "frameset", "object", "embed", "form", "img", "video", "audio", "source", "svg", "math"]):
        node.decompose()
    for node in soup.find_all(True):
        node.attrs = {key: value for key, value in node.attrs.items()
                      if key in {"class", "id", "lang", "dir", "role"}}
    return str(soup)


async def _render_public_page_in_process(url: str, html: str, platform: str, on_event=None) -> dict:
    # Check BEFORE importing/launching a browser; web/telegram never use it.
    if platform not in {"tiktok", "instagram", "youtube", "threads"}:
        return {"browser": "not_used"}
    target = normalize_url(url)
    if target.host not in PLATFORM_HOSTS[platform] or _access_path(target.url, platform):
        raise UnsafeURL("Browser navigation is restricted to public platform pages.")
    if os.getenv("SAFENET_BROWSER_ENABLED", "true").lower() in {"0", "false", "off"}:
        return {"browser": "disabled"}
    try:
        from playwright.async_api import Error as PlaywrightError, async_playwright
    except ImportError:
        return {"browser": "unavailable", "browser_reason": "Playwright is not installed."}

    browser = None
    try:
        async with asyncio.timeout(BROWSER_TIMEOUT):
            async with async_playwright() as driver:
                await _emit(on_event, "static_render_starting", "Starting an offline static renderer for the fetched public document.")
                browser = await driver.chromium.launch(headless=True, args=[
                    "--disable-background-networking", "--disable-quic",
                    "--host-resolver-rules=MAP * ~NOTFOUND",
                ])
                try:
                    context = await browser.new_context(
                        java_script_enabled=False, service_workers="block", offline=True,
                        accept_downloads=False, permissions=[],
                    )
                    document_served = False
                    page = None

                    async def route_request(route):
                        nonlocal document_served
                        request = route.request
                        try:
                            candidate = normalize_url(request.url)
                            allowed = (
                                not document_served and request.method == "GET"
                                and request.resource_type == "document" and request.is_navigation_request()
                                and request.frame == page.main_frame and candidate.url == target.url
                                and candidate.host in PLATFORM_HOSTS[platform]
                            )
                        except (UnsafeURL, ValueError):
                            allowed = False
                        if not allowed:
                            await route.abort("blockedbyclient")
                            return
                        document_served = True
                        # Already fetched via fetch_public: no route.continue(),
                        # route.fetch(), page.request or browser DNS is ever used.
                        await route.fulfill(status=200, body=_browser_document(html), headers={
                            "content-type": "text/html; charset=utf-8",
                            "content-security-policy": "default-src 'none'; script-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'; sandbox",
                            "x-dns-prefetch-control": "off", "referrer-policy": "no-referrer",
                        })

                    await context.route("**/*", route_request)
                    # WebSockets have a separate routing API. Refuse an older
                    # browser adapter rather than silently leaving that path open.
                    if not hasattr(context, "route_web_socket"):
                        return {"browser": "unavailable", "browser_reason": "Playwright lacks WebSocket interception."}
                    async def close_socket(route):
                        await route.close()
                    await context.route_web_socket("**/*", close_socket)
                    page = await context.new_page()
                    await _emit(on_event, "static_rendering", "Rendering the safely fetched static public document; JavaScript and network egress are disabled.")
                    await page.goto(target.url, wait_until="domcontentloaded", timeout=5000)
                    if not document_served or page.url != target.url:
                        return {"browser": "unavailable", "browser_reason": "Static render did not stay on the validated document."}
                    return {"browser": "offline_static_renderer", "browser_status": "completed"}
                finally:
                    await asyncio.wait_for(browser.close(), timeout=2.0)
    except (PlaywrightError, TimeoutError, OSError):
        # Browser driver exceptions can contain source URLs or local paths.
        return {"browser": "unavailable", "browser_reason": "Safe static browser rendering is unavailable or timed out."}


async def _stop_renderer(process) -> None:
    """Stop only this collector's worker tree, including a stuck browser driver."""
    if process.returncode is not None:
        return
    try:
        if os.name == "nt":
            # Chromium/driver shutdown can ignore asyncio cancellation on Windows.
            # A numeric PID of our own child is the sole target; no shell is used.
            killer = await asyncio.create_subprocess_exec(
                str(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "taskkill.exe"),
                "/PID", str(process.pid), "/T", "/F", stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL, creationflags=subprocess.CREATE_NO_WINDOW,
            )
            await asyncio.wait_for(killer.wait(), timeout=3.0)
        else:
            os.killpg(process.pid, signal.SIGKILL)
    except (OSError, TimeoutError):
        if process.returncode is None:
            process.kill()
    await asyncio.wait_for(process.wait(), timeout=2.0)


async def _render_public_page(url: str, html: str, platform: str, on_event=None) -> dict:
    """Render in a disposable worker so native browser teardown is time-bounded."""
    if platform not in {"tiktok", "instagram", "youtube", "threads"}:
        return {"browser": "not_used"}
    target = normalize_url(url)
    if target.host not in PLATFORM_HOSTS[platform] or _access_path(target.url, platform):
        raise UnsafeURL("Browser navigation is restricted to public platform pages.")
    if os.getenv("SAFENET_BROWSER_ENABLED", "true").lower() in {"0", "false", "off"}:
        return {"browser": "disabled"}
    try:
        from playwright.async_api import async_playwright  # noqa: F401 -- capability check only
    except ImportError:
        return {"browser": "unavailable", "browser_reason": "Playwright is not installed."}

    process = None
    unavailable = {"browser": "unavailable", "browser_reason": "Safe static browser rendering is unavailable or timed out."}
    try:
        async with asyncio.timeout(BROWSER_TIMEOUT + RENDER_WORKER_GRACE):
            options = ({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt"
                       else {"start_new_session": True})
            process = await asyncio.create_subprocess_exec(
                sys.executable, "-c", "from safenet.collectors import _renderer_worker; _renderer_worker()",
                cwd=str(Path(__file__).resolve().parent.parent), stdin=asyncio.subprocess.PIPE,
                stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL, limit=8192, **options,
            )
            payload = json.dumps({"url": target.url, "html": html, "platform": platform}).encode("utf-8")
            process.stdin.write(payload)
            await process.stdin.drain()
            process.stdin.close()
            result = None
            # Only small, trusted event/result records cross this pipe. Source
            # text is stdin data, never interpolated into Python or shell code.
            for _ in range(12):
                line = await process.stdout.readline()
                if not line:
                    break
                record = json.loads(line)
                if "event" in record:
                    await _emit(on_event, record["event"]["stage"], record["event"]["message"])
                elif "result" in record:
                    result = record["result"]
                    break
            await process.wait()
            return result if process.returncode == 0 and isinstance(result, dict) else unavailable
    except (OSError, TimeoutError, ValueError):
        return unavailable
    finally:
        if process is not None:
            await _stop_renderer(process)


def _renderer_worker() -> None:
    """Private subprocess entry point; no source instructions are executed."""
    # fetch_public bounds source bytes to 2 MiB; JSON escaping can expand them.
    payload = json.loads(sys.stdin.buffer.read(16 * 1024 * 1024 + 1))
    async def event(item):
        print(json.dumps({"event": item}), flush=True)
    result = asyncio.run(_render_public_page_in_process(
        payload["url"], payload["html"], payload["platform"], event,
    ))
    print(json.dumps({"result": result}), flush=True)


def _youtube_resource(url: str) -> tuple[str, dict] | None:
    parts = urlsplit(url)
    path = parts.path.strip("/").split("/")
    video = None
    if parts.hostname == "youtu.be":
        video = path[0]
    elif parts.path == "/watch":
        video = parse_qs(parts.query).get("v", [None])[0]
    elif path[0] in {"shorts", "embed", "live"} and len(path) > 1:
        video = path[1]
    if video and re.fullmatch(r"[A-Za-z0-9_-]{11}", video):
        return "videos", {"id": video}
    if path[0] == "channel" and len(path) > 1 and re.fullmatch(r"UC[A-Za-z0-9_-]{22}", path[1]):
        return "channels", {"id": path[1]}
    if path[0].startswith("@") and re.fullmatch(r"@[A-Za-z0-9_.-]{3,30}", path[0]):
        return "channels", {"forHandle": path[0]}
    return None


async def _youtube_api(url: str, key: str, metadata: dict, on_event) -> dict | None:
    resource = _youtube_resource(url)
    if resource is None:
        metadata["youtube_api"] = "unsupported_url"
        return None
    endpoint, params = resource
    # The key is a header, never a URL, event, metadata item or exception message.
    api_url = "https://www.googleapis.com/youtube/v3/" + endpoint + "?" + urlencode({"part": "snippet", **params})
    metadata.update({"collector": "youtube_data_api", "youtube_api": "configured", "content_scope": "official_public_snippet"})
    await _emit(on_event, "fetching", "Requesting the official YouTube public snippet API.")
    response = await fetch_public(api_url, allowed_hosts={"www.googleapis.com"}, follow_redirects=False,
                                  request_headers={"X-Goog-Api-Key": key})
    code = response["status_code"]
    if code != 200:
        metadata["youtube_api"] = "blocked" if code in _BLOCKED_HTTP else "unavailable"
        return _result(metadata["youtube_api"], url, metadata,
                       reason=f"Official YouTube API returned HTTP {code}; no browser fallback attempted.")
    await _emit(on_event, "extracting", "Extracting the official public snippet returned by YouTube.")
    try:
        payload = json.loads(response["text"])
        items = payload.get("items", [])
        if not isinstance(items, list) or not items:
            return _result("unavailable", url, metadata, reason="YouTube API returned no public resource.")
        snippet = items[0]["snippet"]
        title = snippet.get("title", "")
        description = snippet.get("description", "")
        if not isinstance(title, str) or not isinstance(description, str):
            raise ValueError("Invalid snippet types")
    except (ValueError, TypeError, KeyError, AttributeError, IndexError, RecursionError):
        return _result("unavailable", url, metadata, reason="YouTube API returned an invalid public snippet.")
    content = (title + "\n\n" + description).strip()
    if len(description.strip()) < 20:
        return _result("unavailable", url, metadata, title=title,
                       reason="YouTube API returned no substantive public description; a title alone is not a completed check.")
    metadata.update({"youtube_api": "completed", "text_truncated": len(content) > MAX_TEXT_CHARS})
    links = _safe_links(re.findall(r"https?://[^\s<>\"']+", description[:MAX_TEXT_CHARS]), url)
    return _result("completed", url, metadata, title=title, text=content, links=links)


async def collect(url: str, *, platform: str = "web", on_event=None) -> dict:
    """Collect one anonymous public URL using the SAFENET-AI-CONTRACT interface.

    Unsupported/unsafe destinations raise UnsafeURL; inaccessible content has no
    evidence text. Events correspond only to operations actually attempted.
    """
    platform = _platform(url, platform)
    metadata = _metadata(platform)
    current = normalize_url(url).url
    try:
        async with asyncio.timeout(COLLECT_TIMEOUT):
            await _emit(on_event, "validating", "Validating the public destination and all DNS addresses.")
            current = (await validate_url(current)).url
            if _access_path(current, platform):
                result = _result("blocked", current, metadata, reason="Login, challenge, consent or private-invite URL is not a public source.")
            else:
                key = os.getenv("SAFENET_YOUTUBE_API_KEY", "").strip() if platform == "youtube" else ""
                metadata["youtube_api"] = "configured" if key else "disabled"
                result = await _youtube_api(current, key, metadata, on_event) if key else None
                if result is None:
                    await _emit(on_event, "fetching", "Fetching the anonymous public document through validated IP-pinned HTTP.")
                    response = await fetch_public(current, allowed_hosts=PLATFORM_HOSTS.get(platform))
                    requested = current
                    current = response["url"]
                    metadata["http_status"] = response["status_code"]
                    soup = _soup(response["text"])
                    threads = (_threads_json_metadata(response["text"], current, soup)
                               if platform == "threads" and 200 <= response["status_code"] < 300 else {})
                    if platform == "threads" and _threads_resource(requested) != _threads_resource(current):
                        threads = {"status": "unavailable", "reason": "Threads redirected to a different source identity; no text was collected."}
                    if threads:
                        _threads_more_prompt(soup, current, threads)
                    blocked = _blocked(soup, current, response["status_code"], platform)
                    if platform == "threads" and soup.select_one("input[type='password']"):
                        blocked = blocked or "Login form prevents anonymous public collection."
                    embedded = ((threads if platform == "threads" else _public_json_metadata(response["text"], current, platform))
                                if not blocked and 200 <= response["status_code"] < 300 else {})
                    if blocked:
                        metadata["retry_after_seconds"] = 900
                        result = _result("blocked", current, metadata, reason=blocked)
                    elif not 200 <= response["status_code"] < 300:
                        result = _result("unavailable", current, metadata, reason=f"Public source returned HTTP {response['status_code']}.")
                    elif embedded.get("status"):
                        if embedded["status"] == "blocked":
                            metadata["retry_after_seconds"] = 900
                        result = _result(embedded["status"], current, metadata, reason=embedded["reason"])
                    else:
                        await _emit(on_event, "extracting", "Extracting bounded public text and inert source links.")
                        title, content, links, truncated = _extract(soup, current, platform, metadata, embedded)
                        metadata["text_truncated"] = truncated
                        if len(content.strip()) < 20:
                            reason = ("Requested public Telegram post was not present in the fetched document."
                                      if metadata.get("requested_post") and metadata.get("posts_collected") == 0 else
                                      "No substantive public text obtained; the page may require JavaScript, login, or app access.")
                            result = _result("unavailable", current, metadata, title=title,
                                reason=reason)
                        else:
                            metadata.update(await _render_public_page(current, response["text"], platform, on_event))
                            result = _result("completed", current, metadata, title=title, text=content, links=links)
            await _emit(on_event, result["status"], result["reason"] or "Public source text collected; ready for evidence-based analysis.")
            return result
    except UnsafeURL:
        raise
    except (FetchError, TimeoutError, OSError, RecursionError) as exc:
        if metadata.get("collector") == "youtube_data_api":
            metadata["youtube_api"] = "unavailable"
        result = _result("unavailable", current, metadata, reason="Public collection failed or exceeded its bounded time/resource limit.")
        if isinstance(exc, FetchError) and str(exc) == "Response exceeds the byte limit.":
            metadata["fetch_failure"] = "response_too_large"
            result["reason"] = "Public response exceeds the configured safe-fetch byte limit; no partial document was analyzed."
        # A failed event sink must not strand a completed bounded operation.
        try:
            await _emit(on_event, "unavailable", result["reason"])
        except (TimeoutError, OSError):
            pass
        return result
