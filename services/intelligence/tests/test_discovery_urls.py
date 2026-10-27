"""Offline URL-shape regressions; no platform requests or evaluation corpus."""

from itertools import repeat

import pytest

from safenet.discovery_urls import public_content_url, public_content_urls


@pytest.mark.parametrize("platform,url,expected", [
    ("instagram", "http://M.INSTAGRAM.COM:80/Public.Name/?igsh=share#bio", "https://www.instagram.com/public.name/"),
    ("instagram", "https://instagram.com/p/AbC_123-/?img_index=2", "https://www.instagram.com/p/AbC_123-/"),
    ("instagram", "https://www.instagram.com/reel/AbC123/?igsh=share", "https://www.instagram.com/reel/AbC123/"),
    ("instagram", "https://www.instagram.com/public.name/reel/AbC123/", "https://www.instagram.com/reel/AbC123/"),
    ("instagram", "https://instagram.com/Public.Name/p/AbC123/", "https://www.instagram.com/p/AbC123/"),
    ("instagram", "https://instagram.com/reels/AbC123/", "https://www.instagram.com/reel/AbC123/"),
    ("instagram", "https://www.instagram.com/%70ublic/", "https://www.instagram.com/public/"),
    ("tiktok", "https://m.tiktok.com/@Public.Name/?lang=en#bio", "https://www.tiktok.com/@public.name"),
    ("tiktok", "https://tiktok.com/@Public.Name/video/7456789012345678901?is_from_webapp=1", "https://www.tiktok.com/@public.name/video/7456789012345678901"),
    ("tiktok", "https://tiktok.com/@Public.Name/photo/7456789012345678901?lang=ru", "https://www.tiktok.com/@public.name/photo/7456789012345678901"),
    ("youtube", "https://m.youtube.com/watch?utm_source=test&v=AbC_def-123&t=20#comments", "https://www.youtube.com/watch?v=AbC_def-123"),
    ("youtube", "https://youtu.be/AbC_def-123?si=tracking", "https://www.youtube.com/watch?v=AbC_def-123"),
    ("youtube", "https://youtube.com/shorts/AbC_def-123/", "https://www.youtube.com/watch?v=AbC_def-123"),
    ("youtube", "https://youtube.com/@Public.Handle/?sub_confirmation=1", "https://www.youtube.com/@public.handle"),
    ("youtube", "https://youtube.com/channel/UCabcdefghijklmnopqrstuv/?view_as=subscriber", "https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv"),
    ("threads", "https://threads.net/@Public.Name/post/AbC_123-?xmt=tracking", "https://www.threads.com/@public.name/post/AbC_123-"),
    ("threads", "https://www.threads.com/@Public.Name/", "https://www.threads.com/@public.name"),
    ("telegram", "https://t.me/s/PublicChannel/123?single#post", "https://t.me/s/publicchannel/123"),
    ("telegram", "https://t.me/PublicChannel/123?single", "https://t.me/s/publicchannel/123"),
    ("telegram", "https://www.telegram.me/PublicChannel", "https://t.me/s/publicchannel"),
    ("telegram", "http://t.me/s/PublicChannel/?before=123", "https://t.me/s/publicchannel"),
])
def test_public_sources_are_canonical_and_idempotent(platform, url, expected):
    assert public_content_url(url, platform) == expected
    assert public_content_url(expected, platform) == expected


@pytest.mark.parametrize("platform,urls", [
    ("instagram", [
        "https://www.instagram.com/", "https://www.instagram.com/?next=/public/",
        "https://www.instagram.com/accounts/login/?next=/public/",
        "https://www.instagram.com/accounts/emailsignup/", "https://instagram.com/signup/",
        "https://instagram.com/login/", "https://instagram.com/LOGin/",
        "https://instagram.com/%6Cogin/", "https://instagram.com/challenge/",
        "https://instagram.com/direct/inbox/", "https://instagram.com/explore/",
        "https://instagram.com/reels/", "https://instagram.com/p/", "https://instagram.com/stories/public/123/",
        "https://instagram.com/privacy/", "https://instagram.com/legal/terms/",
        "https://instagram.com/public/followers/", "https://instagram.com/public/saved/",
        "https://instagram.com/api/v1/users/", "https://instagram.com/graphql/",
        "https://l.instagram.com/?u=https%3A%2F%2Fwww.instagram.com%2Fpublic%2F",
        "https://help.instagram.com/public/", "https://business.instagram.com/public/",
        "https://www.instagram.com/accounts/reel/AbC123/",
    ]),
    ("tiktok", [
        "https://www.tiktok.com/", "https://www.tiktok.com/login", "https://www.tiktok.com/signup",
        "https://www.tiktok.com/foryou", "https://www.tiktok.com/explore",
        "https://www.tiktok.com/search?q=public", "https://www.tiktok.com/tag/public",
        "https://www.tiktok.com/@public/live", "https://www.tiktok.com/@public/video/abc",
        "https://www.tiktok.com/@public/photo/abc", "https://www.tiktok.com/@public/photo/123/extra",
        "https://vm.tiktok.com/Z123456/", "https://vt.tiktok.com/Z123456/",
        "https://www.tiktok.com/t/Z123456/", "https://www.tiktok.com/@public/video/123/extra",
    ]),
    ("youtube", [
        "https://www.youtube.com/", "https://www.youtube.com/feed/subscriptions",
        "https://www.youtube.com/results?search_query=public", "https://www.youtube.com/redirect?q=https://example.com",
        "https://www.youtube.com/playlist?list=public", "https://www.youtube.com/watch",
        "https://www.youtube.com/watch?v=short", "https://www.youtube.com/watch?v=abcdefghijk&v=ABCDEFGHIJK",
        "https://www.youtube.com/watch?v=&v=abcdefghijk", "https://youtu.be/",
        "https://youtu.be/abcdefghijk/extra", "https://youtu.be/@public",
        "https://www.youtube.com/channel/invalid", "https://www.youtube.com/@public/about",
        "https://studio.youtube.com/channel/UCabcdefghijklmnopqrstuv",
    ]),
    ("threads", [
        "https://www.threads.com/", "https://www.threads.net/login/",
        "https://www.threads.com/search", "https://www.threads.com/@public/post/",
        "https://www.threads.com/@public/post/AbC123/extra", "https://www.threads.com/@public/followers",
    ]),
    ("telegram", [
        "https://t.me/", "https://t.me/s/", "https://t.me/login", "https://t.me/share/url?url=public",
        "https://t.me/+privateInvite", "https://t.me/joinchat/privateInvite",
        "https://t.me/c/12345/678", "https://t.me/s/c/123", "https://t.me/s/joinchat/123",
        "https://t.me/iv?url=https://example.com&rhash=123", "https://t.me/addstickers/public",
        "https://t.me/proxy?server=example.com", "https://t.me/boost/public",
        "https://t.me/publicbot?start=payload", "https://t.me/publicbot?startapp=payload",
        "https://t.me/s/publicchannel/0", "https://t.me/s/publicchannel/-12",
        "https://t.me/s/publicchannel/123/extra", "https://t.me/s/publicchannel/not-a-post",
    ]),
])
def test_authentication_navigation_and_private_routes_are_not_sources(platform, urls):
    for url in urls:
        assert public_content_url(url, platform) is None, url


@pytest.mark.parametrize("url", [
    None, 42, True, [], {}, b"https://instagram.com/public/", "", "/public/",
    "//instagram.com/public/", "javascript:alert(1)", "ftp://instagram.com/public/",
    "https://instagram.com.attacker.example/public/", "https://evilinstagram.com/public/",
    "https://evil.instagram.com/public/", "https://instagram.com@evil.example/public/",
    "https://evil.example@instagram.com/public/", "https://@instagram.com/public/",
    "https://user:password@instagram.com/public/", "https://instagram.com:444/public/",
    "https://instagram.com:broken/public/", "https://instagram.com:99999/public/",
    "https://[instagram.com/public/", "https://instagram.com./public/",
    "https://instagram.com\\@evil.example/public/", "https://instagram.com/pub\nlic/",
    "\nhttps://instagram.com/public/", "https://instagram.com/public/\x00",
    "https://instagram.com/public%2Freel/AbC123/", "https://instagram.com/%252e%252e/public/",
    "https://instagram.com/%ff/", "https://instagram.com//public/",
    "https://instagram.com/../public/", "https://instagram.com/%2e%2e/",
    "https://instagram.com/public/?tracking=" + "x" * 2048,
])
def test_malformed_and_host_spoofing_urls_fail_closed(url):
    assert public_content_url(url, "instagram") is None


def test_platform_mismatch_and_unsupported_platform_fail_closed():
    assert public_content_url("https://www.instagram.com/public/", "tiktok") is None
    assert public_content_url("https://example.com/public/", "web") is None
    assert public_content_url("https://www.instagram.com/public/", None) is None
    assert public_content_url("https://www.instagram.com/public/", []) is None


def test_list_filter_skips_bad_entries_and_deduplicates_aliases_in_order():
    assert public_content_urls([
        None, "https://www.instagram.com/", "https://www.instagram.com/login/",
        "http://instagram.com/Public/?igsh=1", "https://m.instagram.com/public/",
        "https://instagram.com/p/AbC123?utm_source=test", "https://instagram.com/public/p/AbC123/",
        "https://tiktok.com/@other", "https://instagram.com/other/",
    ], "instagram") == [
        "https://www.instagram.com/public/", "https://www.instagram.com/p/AbC123/",
        "https://www.instagram.com/other/",
    ]


@pytest.mark.parametrize("urls", [None, 1, "https://instagram.com/public/", {"https://instagram.com/public/": True}])
def test_malformed_seed_containers_are_empty(urls):
    assert public_content_urls(urls, "instagram") == []


def test_list_filter_bounds_input_work_and_output_size():
    # Infinite duplicate or invalid candidates must not stall a scheduler tick.
    assert public_content_urls(repeat("https://instagram.com/login/"), "instagram") == []
    assert public_content_urls(repeat("https://instagram.com/public/"), "instagram") == ["https://www.instagram.com/public/"]
    urls = [f"https://instagram.com/user_{n}/" for n in range(250)]
    assert len(public_content_urls(urls, "instagram", limit=1000)) == 100
    assert len(public_content_urls(urls, "instagram", limit=10)) == 10
    assert public_content_urls(urls, "instagram", limit=0) == []
