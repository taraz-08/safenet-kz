"""Offline public video acquisition: source identity, gates and bounded egress."""

import asyncio
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from safenet import media_fetch as mf, safe_fetch as sf


IG_ID = "AbC_123-x"
TT_ID = "7123456789012345678"
IG = f"https://www.instagram.com/reel/{IG_ID}/"
TT = f"https://www.tiktok.com/@public/video/{TT_ID}"
IG_CDN = "https://scontent.cdninstagram.com/video.mp4?public=1&part=2"
TT_CDN = "https://v16-webapp-prime.tiktok.com/video/tos/useast2a/abc"
TT_PLAY = "https://v16.tiktokcdn.com/video.mp4"
MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00\x00\x00\x08mdat"


def script(document, name=None):
    identifier = f' id="{name}"' if name else ""
    return f'<script type="application/json"{identifier}>{json.dumps(document)}</script>'


def ig_item(**overrides):
    return {"code": IG_ID, "media_type": 2, "video_versions": [{"url": IG_CDN}], **overrides}


def tt_item(**overrides):
    return {"id": TT_ID, "video": {"playAddr": TT_PLAY}, **overrides}


def tt_detail(item=None, **overrides):
    return script({"__DEFAULT_SCOPE__": {"webapp.video-detail": {
        "statusCode": 0, "itemInfo": {"itemStruct": item if item is not None else tt_item()}, **overrides,
    }}}, "__UNIVERSAL_DATA_FOR_REHYDRATION__")


def og(url=IG, video=IG_CDN):
    return f'<meta property="og:url" content="{url}"><meta property="og:video" content="{video}">'


class MediaFetchTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.target = Path(self.directory.name) / "video.mp4"

    async def run_page(self, html="", *, url=IG, status=200, final_url=None, callback=None):
        response = {"url": final_url or url, "status_code": status, "text": html, "headers": {}}
        downloaded = {"path": str(self.target), "url": TT_PLAY if url == TT else IG_CDN,
                      "download_bytes": len(MP4), "content_type": "video/mp4"}
        with patch.object(mf, "fetch_public", AsyncMock(return_value=response)) as page, \
             patch.object(mf, "download_public_binary", AsyncMock(return_value=downloaded)) as download:
            result = await mf.acquire_public_video(url, self.target, on_event=callback)
        return result, page, download

    def assert_no_video(self, result, download, status="unavailable"):
        self.assertEqual(result["status"], status)
        self.assertIsNone(result["path"])
        self.assertTrue(result["reason"])
        self.assertEqual(result["metadata"]["download_bytes"], 0)
        download.assert_not_awaited()
        self.assertEqual(list(self.target.parent.iterdir()), [])

    def test_limits_are_explicit_and_immutable(self):
        self.assertEqual(mf.MEDIA_FETCH_LIMITS.max_download_bytes, 64 * 1024 * 1024)
        self.assertEqual(mf.MEDIA_FETCH_LIMITS.timeout_seconds, 120)
        self.assertEqual(mf.MEDIA_FETCH_LIMITS.max_page_bytes, 2 * 1024 * 1024)
        with self.assertRaises(AttributeError):
            mf.MEDIA_FETCH_LIMITS.timeout_seconds = 500

    async def test_instagram_versions_are_selected_by_exact_shortcode(self):
        html = script({"related": [ig_item(code="different", video_versions=[{"url": "https://scontent.fbcdn.net/wrong.mp4"}])],
                       "data": {"items": [ig_item()]}})
        events = []
        async def callback(event):
            events.append(event["stage"])
        result, page, download = await self.run_page(html, callback=callback)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["path"], str(self.target))
        self.assertIsNone(result["reason"])
        self.assertEqual(result["metadata"]["source_id"], IG_ID)
        self.assertEqual(result["metadata"]["source_url"], IG)
        self.assertEqual(result["metadata"]["extraction"], "instagram_video_versions")
        self.assertEqual(download.await_args.args[0], IG_CDN)
        self.assertEqual(download.await_args.kwargs["allowed_host_suffixes"], mf.PLATFORM_VIDEO_HOST_SUFFIXES["instagram"])
        self.assertEqual(download.await_args.kwargs["max_bytes"], 64 * 1024 * 1024)
        self.assertFalse(page.await_args.kwargs["follow_redirects"])
        self.assertEqual(events, ["media_fetching", "media_extracting", "media_downloading"])

    async def test_instagram_graphql_video_url_and_html_escaped_og(self):
        cases = [
            (script({"graphql": {"shortcode_media": {"shortcode": IG_ID, "__typename": "GraphVideo", "video_url": IG_CDN}}}), "instagram_video_url"),
            (og(video=IG_CDN.replace("&", "&amp;")), "public_og_video"),
            (f'<link rel="canonical" href="/p/{IG_ID}/"><meta property="og:video:secure_url" content="{IG_CDN}">', "public_og_video"),
        ]
        for html, method in cases:
            with self.subTest(method=method):
                result, _, download = await self.run_page(html)
                self.assertEqual(result["status"], "completed")
                self.assertEqual(result["metadata"]["extraction"], method)
                self.assertEqual(download.await_args.args[0], IG_CDN)

    async def test_no_unscoped_recursive_video_or_related_carousel_selection(self):
        cases = [
            script(ig_item(code="other")), script(ig_item(code=IG_ID.lower())),
            script({"code": IG_ID, "carousel_media": [ig_item(code="other")]}),
            script({"video_versions": [{"url": IG_CDN}]}),
            script(ig_item(shortcode="different")),
            f'<video src="{IG_CDN}"></video>',
            f'<script>window._sharedData={json.dumps(ig_item())};</script>',
            f'<script src="https://example.com/script.js" type="application/json">{json.dumps(ig_item())}</script>',
            script(ig_item(media_type=8)), script(ig_item(is_video=False)),
            script(ig_item(media_type=8)) + og(), script(ig_item(is_video=False)) + og(),
        ]
        for html in cases:
            with self.subTest(html=html[:80]):
                result, _, download = await self.run_page(html)
                self.assert_no_video(result, download)

    async def test_og_requires_nonconflicting_canonical_identity(self):
        for html in (
            f'<meta property="og:video" content="{IG_CDN}">',
            og(url="https://www.instagram.com/reel/other/"),
            og() + '<link rel="canonical" href="/reel/other/">',
            og() + '<link rel="canonical" href="/public/">',
        ):
            result, _, download = await self.run_page(html)
            self.assert_no_video(result, download)

    async def test_tiktok_universal_and_sigi_select_only_requested_item(self):
        sigi = script({"ItemModule": {"wrong": tt_item(id="wrong", video={"playAddr": "https://v16.tiktokcdn.com/wrong.mp4"}),
                                      TT_ID: tt_item()}}, "SIGI_STATE")
        universal = tt_detail() + script({"related": tt_item(id="wrong")}, "OTHER_STATE")
        for html in (sigi, universal):
            result, _, download = await self.run_page(html, url=TT)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(download.await_args.args[0], TT_PLAY)
            self.assertEqual(download.await_args.kwargs["allowed_host_suffixes"], mf.PLATFORM_VIDEO_HOST_SUFFIXES["tiktok"])

    async def test_tiktok_playable_address_shapes_are_bounded(self):
        for video in (
            {"playAddr": {"urlList": [TT_PLAY]}},
            {"playAddr": {"UrlList": [TT_PLAY]}},
            {"bitrateInfo": [{"PlayAddr": {"UrlList": [TT_PLAY]}}]},
            {"downloadAddr": TT_PLAY},
        ):
            result, _, download = await self.run_page(tt_detail(tt_item(video=video)), url=TT)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(download.await_args.args[0], TT_PLAY)

    async def test_tiktok_does_not_use_related_items_or_mismatched_ids(self):
        for html in (
            tt_detail(tt_item(id="different")) + og(TT, TT_PLAY),
            script({"ItemModule": {TT_ID: tt_item(id="different")}}, "SIGI_STATE"),
            script({"ItemModule": {"different": tt_item(id="different")}}, "SIGI_STATE"),
            script({"__DEFAULT_SCOPE__": {"recommendations": tt_item()}}, "__UNIVERSAL_DATA_FOR_REHYDRATION__"),
            script({"itemInfo": {"itemStruct": tt_item()}}, "UNKNOWN_SCRIPT"),
            tt_detail(itemInfo={}) + og(TT, TT_PLAY),
        ):
            result, _, download = await self.run_page(html, url=TT)
            self.assert_no_video(result, download)

    async def test_tiktok_source_error_is_unavailable_even_with_og_video(self):
        result, _, download = await self.run_page(tt_detail(statusCode=10204, statusMsg="not found") + og(TT, TT_PLAY), url=TT)
        self.assert_no_video(result, download)
        self.assertIn("unavailable", result["reason"])

    async def test_all_access_gates_stop_before_embedded_media_download(self):
        gates = ["<title>Log in • Instagram</title>", "<h1>This account is private</h1>",
                 '<form id="challenge-form"></form>', '<input type="password">',
                 "<title>Just a moment...</title>", "<h1>Verify you are human</h1>",
                 "<p>Sign in to watch</p>", '<iframe src="https://example.com/recaptcha"></iframe>']
        for gate in gates:
            with self.subTest(gate=gate):
                result, _, download = await self.run_page(gate + og() + script(ig_item()))
                self.assert_no_video(result, download, "blocked")

    async def test_private_flags_are_checked_before_any_og_fallback(self):
        cases = [(IG, script(ig_item(user={"is_private": True})) + og()),
                 (IG, script([ig_item(), ig_item(owner={"is_private": True})]) + og()),
                 (TT, tt_detail(tt_item(privateItem=True)) + og(TT, TT_PLAY)),
                 (TT, tt_detail(tt_item(author={"privateAccount": True})) + og(TT, TT_PLAY)),
                 (TT, tt_detail(statusCode=1, statusMsg="This account is private") + og(TT, TT_PLAY)),
                 (TT, tt_detail(needLogin=True) + og(TT, TT_PLAY))]
        for url, html in cases:
            result, _, download = await self.run_page(html, url=url)
            self.assert_no_video(result, download, "blocked")

    async def test_unrelated_private_item_does_not_block_requested_public_video(self):
        result, _, download = await self.run_page(script([ig_item(code="other", is_private=True), ig_item()]))
        self.assertEqual(result["status"], "completed")
        download.assert_awaited_once()

    async def test_http_gates_and_source_errors_are_not_successes(self):
        for status in (401, 403, 407, 429, 451, 404, 500, 204, 206):
            result, _, download = await self.run_page(og() + script(ig_item()), status=status)
            self.assert_no_video(result, download, "blocked" if status in (401, 403, 407, 429, 451) else "unavailable")

    async def test_platform_specific_cdn_and_linkshim_policy(self):
        rejected = ["https://example.com/video.mp4", "https://cdninstagram.com.evil.example/video.mp4",
                    "https://evilcdninstagram.com/video.mp4", TT_PLAY,
                    "https://l.instagram.com/?u=" + IG_CDN, "http://scontent.cdninstagram.com/video.mp4",
                    "https://scontent.cdninstagram.com:444/video.mp4", "https://127.0.0.1/video.mp4",
                    "https://user:pass@scontent.cdninstagram.com/video.mp4", "file:///tmp/video.mp4"]
        for video in rejected:
            result, _, download = await self.run_page(og(video=video))
            self.assert_no_video(result, download, "blocked")
        for video in (IG_CDN, "https://www.tiktok.com/api/play/video",
                      "https://v16-webapp-prime.tiktok.com.evil.example/video.mp4",
                      "https://evilv16-webapp-prime.tiktok.com/video.mp4"):
            result, _, download = await self.run_page(tt_detail(tt_item(video={"playAddr": video})), url=TT)
            self.assert_no_video(result, download, "blocked")

    async def test_tiktok_observed_public_cdn_leaf_does_not_allow_platform_api(self):
        result, _, download = await self.run_page(tt_detail(tt_item(video={"playAddr": TT_CDN})), url=TT)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(download.await_args.args[0], TT_CDN)
        self.assertNotIn("tiktok.com", download.await_args.kwargs["allowed_host_suffixes"])

    async def test_playlist_and_dynamic_only_pages_are_unavailable(self):
        for html in ("<title>Instagram</title><p>Enable JavaScript</p>", "", og(video="https://scontent.fbcdn.net/video.m3u8"),
                     og(video="https://scontent.fbcdn.net/video.mpd")):
            result, _, download = await self.run_page(html)
            self.assert_no_video(result, download)

    async def test_unsupported_input_never_fetches_page(self):
        for url in ("https://www.instagram.com/public/", "https://www.tiktok.com/@public",
                    "https://vm.tiktok.com/abc", IG_CDN, "https://example.com/video.mp4",
                    "https://www.instagram.com/api/v1/media/123", "https://www.tiktok.com/@public/photo/123"):
            result, page, download = await self.run_page(url=url)
            self.assert_no_video(result, download)
            page.assert_not_awaited()

    async def test_permalink_query_cannot_request_private_json_or_send_tokens(self):
        for query in ("?__a=1&__d=dis", "?session_id=secret&access_token=secret", "?utm_source=share#tracking"):
            result, page, download = await self.run_page(script(ig_item()), url=IG + query, final_url=IG)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(page.await_args.args[0], IG)
            self.assertEqual(result["metadata"]["source_url"], IG)
            # CDN signatures from public HTML must remain intact.
            self.assertEqual(download.await_args.args[0], IG_CDN)

    async def test_unsafe_inputs_and_access_paths_never_fetch(self):
        for url in ("https://127.0.0.1/video.mp4", "http://www.instagram.com/reel/abc/",
                    "https://www.instagram.com/accounts/login/", "https://www.instagram.com/challenge/abc",
                    "https://www.tiktok.com/login", "https://www.tiktok.com:4310/@public/video/123"):
            result, page, download = await self.run_page(url=url)
            self.assert_no_video(result, download, "blocked")
            page.assert_not_awaited()

    async def test_page_redirect_cannot_visit_gate_or_change_video(self):
        for location, status in (("/accounts/login/", "blocked"), ("/challenge/", "blocked"),
                                 ("/reel/other/", "unavailable"), ("https://example.com/", "unavailable"),
                                 ("https://127.0.0.1/", "blocked"), ("/reel/abc/\n", "blocked")):
            response = {"url": IG, "status_code": 302, "text": "", "headers": {"location": location}}
            with patch.object(mf, "fetch_public", AsyncMock(return_value=response)) as page, \
                 patch.object(mf, "download_public_binary", new_callable=AsyncMock) as download:
                result = await mf.acquire_public_video(IG, self.target)
            self.assert_no_video(result, download, status)
            page.assert_awaited_once()

    async def test_same_video_page_redirect_is_allowed(self):
        redirect = {"url": IG, "status_code": 301, "text": "", "headers": {"location": f"https://instagram.com/p/{IG_ID}/"}}
        page = {"url": redirect["headers"]["location"], "status_code": 200, "headers": {}, "text": script(ig_item())}
        result = {"path": str(self.target), "url": IG_CDN, "download_bytes": len(MP4), "content_type": "video/mp4"}
        with patch.object(mf, "fetch_public", AsyncMock(side_effect=[redirect, page])) as fetch, \
             patch.object(mf, "download_public_binary", AsyncMock(return_value=result)):
            acquired = await mf.acquire_public_video(IG, self.target)
        self.assertEqual(acquired["status"], "completed")
        self.assertEqual(fetch.await_count, 2)

    async def test_json_and_page_budgets_fail_without_partial_selection(self):
        cases = [({"max_json_chars": 10}, script(ig_item())),
                 ({"max_json_nodes": 3}, script([ig_item(), {"many": [1, 2, 3]}])),
                 ({"max_json_depth": 2}, script({"nested": {"item": ig_item()}})),
                 ({"max_json_scripts": 1}, script(ig_item()) + script({})),
                 ({"max_page_bytes": 10}, script(ig_item()))]
        for limits, html in cases:
            with patch.object(mf, "MEDIA_FETCH_LIMITS", replace(mf.MEDIA_FETCH_LIMITS, **limits)):
                result, _, download = await self.run_page(html)
            self.assert_no_video(result, download)

    async def test_malformed_metadata_is_not_executed(self):
        for html in ('<script id="SIGI_STATE">window.secret()</script>',
                     '<script id="SIGI_STATE">{broken}</script>'):
            result, _, download = await self.run_page(html + og(TT, TT_PLAY), url=TT)
            self.assert_no_video(result, download)

    async def test_total_deadline_includes_page_and_callbacks(self):
        async def slow(*args, **kwargs):
            await asyncio.sleep(1)
        with patch.object(mf, "MEDIA_FETCH_LIMITS", replace(mf.MEDIA_FETCH_LIMITS, timeout_seconds=0.02)), \
             patch.object(mf, "fetch_public", slow), \
             patch.object(mf, "download_public_binary", new_callable=AsyncMock) as download:
            result = await mf.acquire_public_video(IG, self.target)
        self.assert_no_video(result, download)
        with patch.object(mf, "MEDIA_FETCH_LIMITS", replace(mf.MEDIA_FETCH_LIMITS, timeout_seconds=0.02)):
            result, page, download = await self.run_page(script(ig_item()), callback=slow)
        self.assert_no_video(result, download)
        page.assert_not_awaited()

    async def test_operator_cancellation_propagates(self):
        async def cancelled(event):
            raise asyncio.CancelledError()
        with self.assertRaises(asyncio.CancelledError):
            await self.run_page(script(ig_item()), callback=cancelled)

    async def test_page_cancellation_race_never_follows_another_redirect(self):
        async def cancelled_page(*args, **kwargs):
            asyncio.current_task().cancel()
            try:
                await asyncio.sleep(0)
            except asyncio.CancelledError:
                return {"url": IG, "status_code": 302, "headers": {"location": f"/p/{IG_ID}/"}, "text": ""}
        with patch.object(mf, "fetch_public", AsyncMock(side_effect=cancelled_page)) as page, \
             patch.object(mf, "download_public_binary", new_callable=AsyncMock) as download, \
             self.assertRaises(asyncio.CancelledError):
            await mf.acquire_public_video(IG, self.target)
        page.assert_awaited_once()
        download.assert_not_awaited()

    async def test_download_receives_only_remaining_total_budget(self):
        async def page(*args, **kwargs):
            await asyncio.sleep(0.04)
            return {"url": IG, "status_code": 200, "headers": {}, "text": script(ig_item())}
        downloaded = {"path": str(self.target), "url": IG_CDN, "download_bytes": len(MP4), "content_type": "video/mp4"}
        with patch.object(mf, "MEDIA_FETCH_LIMITS", replace(mf.MEDIA_FETCH_LIMITS, timeout_seconds=2.0)), \
             patch.object(mf, "fetch_public", side_effect=page), \
             patch.object(mf, "download_public_binary", AsyncMock(return_value=downloaded)) as download:
            result = await mf.acquire_public_video(IG, self.target)
        self.assertEqual(result["status"], "completed")
        self.assertLess(download.await_args.kwargs["timeout"], 1.99)

    async def test_downloader_block_and_failure_are_reported_truthfully(self):
        page = {"url": IG, "status_code": 200, "headers": {}, "text": script(ig_item())}
        for error, status in ((sf.BinaryAccessBlocked("Public video access blocked (HTTP 403)."), "blocked"),
                              (sf.UnsafeURL("Only public addresses allowed."), "blocked"),
                              (sf.FetchError("Video exceeds the download byte limit."), "unavailable")):
            with patch.object(mf, "fetch_public", AsyncMock(return_value=page)), \
                 patch.object(mf, "download_public_binary", AsyncMock(side_effect=error)):
                result = await mf.acquire_public_video(IG, self.target)
            self.assertEqual(result["status"], status)
            self.assertIsNone(result["path"])
            self.assertEqual(result["metadata"]["download_bytes"], 0)
            self.assertEqual(result["reason"], str(error))

    async def test_full_page_to_disk_flow_uses_only_anonymous_pinned_requests(self):
        class Stream(httpx.AsyncByteStream):
            def __init__(self, data=MP4):
                self.data = data

            async def __aiter__(self):
                yield self.data
        requests = []
        real_client = httpx.AsyncClient
        def reply(request):
            requests.append(request)
            if request.headers["host"] == "www.instagram.com":
                return httpx.Response(200, stream=Stream(script(ig_item()).encode()), headers={"content-type": "text/html", "set-cookie": "session=secret"})
            return httpx.Response(200, headers={"content-type": "video/mp4"}, stream=Stream())
        def factory(**kwargs):
            return real_client(**kwargs, transport=httpx.MockTransport(reply))
        with patch.object(sf, "_resolve", AsyncMock(return_value=["93.184.216.34"])) as resolve, \
             patch.object(sf.httpx, "AsyncClient", side_effect=factory):
            result = await mf.acquire_public_video(IG, self.target)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(self.target.read_bytes(), MP4)
        self.assertEqual(result["metadata"]["download_bytes"], len(MP4))
        self.assertEqual([call.args[0] for call in resolve.await_args_list], ["www.instagram.com", "scontent.cdninstagram.com"])
        self.assertEqual(len(requests), 2)
        for request in requests:
            self.assertEqual(request.url.host, "93.184.216.34")
            self.assertEqual(request.headers["user-agent"], "SafeNet-Public-Collector/1.0")
            self.assertNotIn("cookie", request.headers)
            self.assertNotIn("authorization", request.headers)
        self.assertEqual(list(self.target.parent.iterdir()), [self.target])



IMAGE = "https://scontent.cdninstagram.com/post.jpg"
TT_IMAGE = "https://p16-sign-va.tiktokcdn.com/post.jpeg?public=1"


def image_page(**overrides):
    item = {"shortcode": IG_ID, "__typename": "GraphImage", "is_video": False,
            "display_url": IMAGE, "owner": {"username": "public", "is_private": False}, **overrides}
    return (f'<link rel="canonical" href="/p/{IG_ID}/"><meta property="og:image" content="{IMAGE}">'
            + script({"graphql": {"shortcode_media": item}}))


class ImageFallbackTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.target = Path(self.directory.name) / "media.mp4"

    async def acquire(self, html, *, url=IG):
        response = {"url": url, "status_code": 200, "text": html, "headers": {}}
        downloaded = {"path": str(self.target.with_suffix(".image")), "url": IMAGE,
                      "content_type": "image/jpeg", "download_bytes": 200}
        with patch.object(mf, "fetch_public", AsyncMock(return_value=response)), \
             patch.object(mf, "_download_public_image", AsyncMock(return_value=downloaded)) as image, \
             patch.object(mf, "download_public_binary", new_callable=AsyncMock) as video:
            result = await mf.acquire_public_media(url, self.target)
        return result, image, video

    async def test_realistic_instagram_graphimage_and_og_are_post_bound(self):
        result, image, video = await self.acquire(image_page())
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["metadata"]["media_kind"], "image")
        self.assertEqual(result["metadata"]["coverage"], "public_preview_image")
        self.assertEqual(result["metadata"]["extraction"], "public_og_post_image")
        self.assertEqual(image.await_args.args[0], IMAGE)
        self.assertEqual(image.await_args.args[1].suffix, ".image")
        self.assertEqual(image.await_args.kwargs["max_bytes"], 16 * 1024 * 1024)
        self.assertFalse(result["metadata"]["authenticated"])
        video.assert_not_awaited()

    async def test_instagram_video_poster_without_playable_video(self):
        html = script(ig_item(video_versions=[], image_versions2={"candidates": [{"url": IMAGE, "width": 1080, "height": 1920}]}))
        result, image, video = await self.acquire(html)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["metadata"]["coverage"], "public_preview_image")
        image.assert_awaited_once()
        video.assert_not_awaited()

    async def test_tiktok_cover_or_first_photo_only(self):
        for url, item in ((TT, tt_item(video={"cover": TT_IMAGE})),
                         (TT.replace("/video/", "/photo/"), tt_item(video={}, imagePost={"images": [
                             {"imageURL": {"urlList": [TT_IMAGE]}}, {"imageURL": {"urlList": [TT_IMAGE + "second"]}}]}))):
            result, image, video = await self.acquire(tt_detail(item), url=url)
            self.assertEqual(result["status"], "completed")
            self.assertEqual(image.await_args.args[0], TT_IMAGE)
            self.assertEqual(result["metadata"]["media_kind"], "image")
            video.assert_not_awaited()

    async def test_gates_private_identity_avatar_and_ambiguous_og_never_download(self):
        cases = [
            '<input type="password">' + image_page(),
            '<h1>Verify you are human</h1>' + image_page(),
            image_page(owner={"is_private": True}),
            image_page(shortcode="wrong"),
            image_page(code="other"),
            image_page() + '<link rel="canonical" href="/p/other/">',
            image_page(owner={"profile_pic_url": IMAGE}),
            image_page(display_url="https://scontent.cdninstagram.com/avatar.jpg"),
            image_page(display_url=None, thumbnail_src=None, profile_pic_url=IMAGE),
            f'<link rel="canonical" href="{IG}"><meta property="og:image" content="{IMAGE}">',
            script({"code": IG_ID, "owner": {"profile_pic_url": IMAGE}}),
            script({"code": IG_ID, "media_type": 8, "carousel_media": [ig_item(code="other", display_url=IMAGE)]}),
        ]
        for html in cases:
            with self.subTest(html=html[:80]):
                result, image, video = await self.acquire(html)
                self.assertNotEqual(result["status"], "completed")
                self.assertIsNone(result["path"])
                image.assert_not_awaited(); video.assert_not_awaited()
        for item in (tt_item(id="wrong", video={"cover": TT_IMAGE}),
                     tt_item(privateItem=True, video={"cover": TT_IMAGE}),
                     tt_item(video={"cover": TT_IMAGE}, author={"avatarThumb": TT_IMAGE})):
            result, image, _ = await self.acquire(tt_detail(item), url=TT)
            self.assertNotEqual(result["status"], "completed")
            image.assert_not_awaited()

    async def test_later_private_item_cannot_hide_behind_first_photo(self):
        html = image_page() + script(ig_item(owner={"is_private": True}))
        result, image, _ = await self.acquire(html)
        self.assertEqual(result["status"], "blocked")
        image.assert_not_awaited()

    async def test_download_block_does_not_trigger_image_fallback(self):
        response = {"url": IG, "status_code": 200, "headers": {}, "text": script(ig_item(display_url=IMAGE))}
        with patch.object(mf, "fetch_public", AsyncMock(return_value=response)), \
             patch.object(mf, "download_public_binary", AsyncMock(side_effect=sf.BinaryAccessBlocked("blocked"))), \
             patch.object(mf, "_download_public_image", new_callable=AsyncMock) as image:
            result = await mf.acquire_public_media(IG, self.target)
        self.assertEqual(result["status"], "blocked")
        image.assert_not_awaited()

    async def network(self, handler, *, html=None):
        class Stream(httpx.AsyncByteStream):
            def __init__(self, data): self.data = data
            async def __aiter__(self): yield self.data
        requests = []
        real_client = httpx.AsyncClient
        def reply(request):
            requests.append(request)
            if request.headers["host"] == "www.instagram.com":
                return httpx.Response(200, stream=Stream((html or image_page()).encode()), headers={"content-type": "text/html", "set-cookie": "session=secret"})
            status, headers, body = handler(request)
            return httpx.Response(status, headers=headers, stream=Stream(body))
        def factory(**kwargs): return real_client(**kwargs, transport=httpx.MockTransport(reply))
        with patch.object(sf, "_resolve", AsyncMock(return_value=["93.184.216.34"])) as resolve, \
             patch.object(sf.httpx, "AsyncClient", side_effect=factory):
            result = await mf.acquire_public_media(IG, self.target)
        return result, requests, resolve

    async def test_actual_png_written_atomically_through_pinned_anonymous_https(self):
        import io
        from PIL import Image
        output = io.BytesIO(); Image.new("RGB", (20, 20), "white").save(output, format="PNG")
        data = output.getvalue()
        result, requests, resolve = await self.network(lambda _: (200, {"content-type": "image/png"}, data))
        self.assertEqual(result["status"], "completed")
        self.assertEqual(Path(result["path"]).read_bytes(), data)
        self.assertEqual(result["metadata"]["download_bytes"], len(data))
        self.assertFalse(self.target.exists())
        self.assertEqual([c.args[0] for c in resolve.await_args_list], ["www.instagram.com", "scontent.cdninstagram.com"])
        self.assertEqual(len(requests), 2)
        for request in requests:
            self.assertEqual(request.url.host, "93.184.216.34")
            self.assertNotIn("cookie", request.headers); self.assertNotIn("authorization", request.headers)
            self.assertEqual(request.extensions["sni_hostname"], request.headers["host"])
        self.assertEqual(list(self.target.parent.iterdir()), [self.target.with_suffix(".image")])

    async def test_image_redirect_policy_stops_before_disallowed_host(self):
        for destination in ("https://127.0.0.1/secret.png", "https://cdninstagram.com.evil.test/x.png", "http://scontent.cdninstagram.com/x.png", "https://www.instagram.com/accounts/login/"):
            result, requests, _ = await self.network(lambda _: (302, {"location": destination}, b""))
            self.assertEqual(result["status"], "blocked")
            self.assertEqual(len(requests), 2)
            self.assertIsNone(result["path"])
            self.assertEqual(list(self.target.parent.iterdir()), [])

    async def test_image_body_limits_mime_signature_and_status_fail_closed(self):
        png = b"\x89PNG\r\n\x1a\n" + bytes(100)
        cases = [
            (200, {"content-type": "image/png", "content-length": "999999999"}, png),
            (200, {"content-type": "image/png"}, png),
            (200, {"content-type": "image/svg+xml"}, b"<svg/>"),
            (200, {"content-type": "image/jpeg"}, b"<html>login required</html>"),
            (200, {"content-type": "image/png", "content-encoding": "gzip"}, b"x"),
            (200, {"content-type": "image/png", "content-length": "20"}, png[:16]),
            (403, {"content-type": "image/png"}, png),
        ]
        for status, headers, body in cases:
            with patch.object(mf, "MEDIA_FETCH_LIMITS", replace(mf.MEDIA_FETCH_LIMITS, max_download_bytes=32)):
                result, _, _ = await self.network(lambda _: (status, headers, body))
            self.assertNotEqual(result["status"], "completed")
            self.assertEqual(result["metadata"]["download_bytes"], 0)
            self.assertIsNone(result["path"])
            self.assertEqual(list(self.target.parent.iterdir()), [])

    async def test_page_redirect_still_checks_identity_before_image(self):
        page = {"url": IG, "status_code": 302, "headers": {"location": "/p/other/"}, "text": ""}
        with patch.object(mf, "fetch_public", AsyncMock(return_value=page)) as fetch, \
             patch.object(mf, "_download_public_image", new_callable=AsyncMock) as image:
            result = await mf.acquire_public_media(IG, self.target)
        self.assertEqual(result["status"], "unavailable")
        fetch.assert_awaited_once(); image.assert_not_awaited()


    async def test_image_cancellation_removes_partial_and_preserves_old_file(self):
        self.target.with_suffix(".image").write_bytes(b"existing evidence")
        class CancelledStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b"\x89PNG\r\n\x1a\n" + bytes(64 * 1024)
                raise asyncio.CancelledError()
        real_client = httpx.AsyncClient
        def factory(**kwargs):
            return real_client(**kwargs, transport=httpx.MockTransport(lambda _: httpx.Response(200,
                headers={"content-type": "image/png"}, stream=CancelledStream())))
        page = {"url": IG, "status_code": 200, "headers": {}, "text": image_page()}
        with patch.object(mf, "fetch_public", AsyncMock(return_value=page)), \
             patch.object(sf, "_resolve", AsyncMock(return_value=["93.184.216.34"])), \
             patch.object(sf.httpx, "AsyncClient", side_effect=factory), \
             self.assertRaises(asyncio.CancelledError):
            await mf.acquire_public_media(IG, self.target)
        self.assertEqual(self.target.with_suffix(".image").read_bytes(), b"existing evidence")
        self.assertEqual(list(self.target.parent.iterdir()), [self.target.with_suffix(".image")])

    async def test_image_total_deadline_covers_stream_and_cleans_temp(self):
        class SlowStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield b"\x89PNG\r\n\x1a\n" + bytes(64 * 1024)
                await asyncio.sleep(1)
                yield b"remaining"
        real_client = httpx.AsyncClient
        def factory(**kwargs):
            return real_client(**kwargs, transport=httpx.MockTransport(lambda _: httpx.Response(200,
                headers={"content-type": "image/png"}, stream=SlowStream())))
        page = {"url": IG, "status_code": 200, "headers": {}, "text": image_page()}
        with patch.object(mf, "fetch_public", AsyncMock(return_value=page)), \
             patch.object(sf, "_resolve", AsyncMock(return_value=["93.184.216.34"])), \
             patch.object(sf.httpx, "AsyncClient", side_effect=factory), \
             patch.object(mf, "MEDIA_FETCH_LIMITS", replace(mf.MEDIA_FETCH_LIMITS, timeout_seconds=.05)):
            result = await mf.acquire_public_media(IG, self.target)
        self.assertEqual(result["status"], "unavailable")
        self.assertIsNone(result["path"])
        self.assertEqual(list(self.target.parent.iterdir()), [])

    async def test_approved_image_redirect_keeps_pinning_and_cookie_isolation(self):
        import io
        from PIL import Image
        data = io.BytesIO(); Image.new("RGB", (10, 10)).save(data, format="JPEG")
        def reply(request):
            if request.headers["host"] == "scontent.cdninstagram.com":
                return 302, {"location": "https://scontent.fbcdn.net/post.jpg", "set-cookie": "session=secret"}, b""
            return 200, {"content-type": "image/jpeg"}, data.getvalue()
        result, requests, resolve = await self.network(reply)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["metadata"]["media_host"], "scontent.fbcdn.net")
        self.assertEqual(len(requests), 3)
        self.assertEqual(resolve.await_args_list[-1].args[0], "scontent.fbcdn.net")
        self.assertNotIn("cookie", requests[-1].headers)
        self.assertEqual(requests[-1].url.host, "93.184.216.34")


if __name__ == "__main__":
    unittest.main()
