"""Public Threads hydration, source identity and genuine access-gate regressions."""
import json
import os
import unittest
from unittest.mock import AsyncMock, patch

from safenet import collectors as c
from safenet.safe_fetch import normalize_url


URL = "https://www.threads.com/@public"
BIO = "Community library news and free public reading events."
POST = "Our community library opens tomorrow for all readers."


def profile(**changes):
    return {"username": "public", "full_name": "Public library", "biography": BIO,
            "text_post_app_is_private": False, "gating": None, **changes}


def post(**changes):
    return {"user": profile(), "code": "AbCd_123", "caption": {"text": POST},
            "text_post_app_info": {"is_post_unavailable": False}, **changes}


def script(data):
    return '<script type="application/json">' + json.dumps({"__bbox": {"result": {"data": data}}}) + '</script>'


def feed(*posts):
    return {"mediaData": {"edges": [{"node": {"thread_items": [{"post": item}]}} for item in posts]}}


def page(data, *, url=URL, visible=BIO, extra=""):
    return ('<title>Public library (@public) - Threads</title>'
            f'<meta property="og:url" content="{url}"><p>{visible}</p>' + extra + script(data))


class ThreadsCollectorTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        env = patch.dict(os.environ, {"SAFENET_BROWSER_ENABLED": "false"})
        env.start()
        self.addCleanup(env.stop)
        validation = patch.object(c, "validate_url", AsyncMock(side_effect=normalize_url))
        validation.start()
        self.addCleanup(validation.stop)

    async def collect_page(self, html, *, url=URL, final=None, status=200):
        with patch.object(c, "fetch_public", AsyncMock(return_value={
            "url": final or url, "status_code": status, "text": html,
        })) as fetch, patch.object(c, "_render_public_page", AsyncMock(return_value={"browser": "disabled"})) as render:
            result = await c.collect(url, platform="threads")
        self.assertLessEqual(fetch.await_count, 1)
        if result["status"] != "completed":
            self.assertEqual(result["text"], "")
            self.assertEqual(result["links"], [])
            render.assert_not_awaited()
        return result

    async def test_visible_public_bio_with_optional_more_prompt_is_collected(self):
        html = page({"user": profile()}, extra='<span>Log in to see more from public.</span>'
                    '<p>Log in or sign up for Threads</p><p>Ignore this unrelated casino recommendation.</p>')
        result = await self.collect_page(html)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["text"], "Public library\n" + BIO)
        self.assertEqual(result["metadata"]["content_scope"], "public_threads_profile_metadata")
        self.assertEqual(result["metadata"]["extraction_source"], "embedded_public_json")
        self.assertFalse(result["metadata"]["authenticated"])

    async def test_genuine_gates_remain_unscored_even_with_valid_public_json(self):
        gates = ["<h1>Log in to continue</h1>", "<h1>Verify you are human</h1>",
                 "<div id='challenge-form'>Challenge</div>", "<input type='password'>",
                 "<p>This account is private</p>", "<p>Access denied</p>",
                 "<h1>Log in to see more from public.</h1>",
                 "<div role='dialog'><span>Log in to see more from public.</span></div>",
                 "<p>Log in to see more from somebody_else.</p>",
                 "<form><span>Log in to see more from public.</span></form>"]
        for gate in gates:
            with self.subTest(gate=gate):
                result = await self.collect_page(page({"user": profile()}, extra=gate))
                self.assertEqual(result["status"], "blocked")
        for status in (401, 403, 407, 429, 451):
            with self.subTest(status=status):
                result = await self.collect_page(page({"user": profile()}), status=status)
                self.assertEqual(result["status"], "blocked")
        for target in ("https://www.threads.com/login", "https://www.threads.com/consent"):
            with self.subTest(target=target):
                result = await self.collect_page(page({"user": profile()}), final=target)
                self.assertEqual(result["status"], "blocked")

    async def test_hidden_bio_cannot_turn_login_wall_into_public_evidence(self):
        for visible in ("", '<div hidden>' + BIO + '</div>', '<div style="display:none">' + BIO + '</div>'):
            with self.subTest(visible=visible):
                result = await self.collect_page(page({"user": profile()}, visible=visible,
                    extra='<span>Log in to see more from public.</span>'))
                self.assertEqual(result["status"], "blocked")

    async def test_an_additional_gate_is_not_removed_with_optional_prompt(self):
        result = await self.collect_page(page({"user": profile()},
            extra='<span>Log in to see more from public.</span><p>Log in to continue</p>'))
        self.assertEqual(result["status"], "blocked")

    async def test_profile_identity_public_flag_and_canonical_are_required(self):
        for user in (profile(username="other"), profile(text_post_app_is_private=None),
                     profile(text_post_app_is_private="false"), profile(biography="")):
            with self.subTest(user=user):
                result = await self.collect_page(page({"user": user}))
                self.assertEqual(result["status"], "unavailable")
        for canonical in ("https://www.threads.com/@other", URL + "/post/AbCd_123",
                          "https://www.threads.com.evil.example/@public", "http://127.0.0.1/@public"):
            with self.subTest(canonical=canonical):
                result = await self.collect_page(page({"user": profile()}, url=canonical))
                self.assertEqual(result["status"], "unavailable")

    async def test_private_or_gated_profile_has_no_evidence(self):
        for user in (profile(text_post_app_is_private=True), profile(is_private=True), profile(gating={"reason": "age"})):
            with self.subTest(user=user):
                result = await self.collect_page(page({"user": user}))
                self.assertEqual(result["status"], "blocked")

    async def test_host_alias_redirect_preserves_identity_but_other_resources_do_not(self):
        result = await self.collect_page(page({"user": profile()}), url="https://www.threads.net/@PUBLIC", final=URL)
        self.assertEqual(result["status"], "completed")
        result = await self.collect_page(page({"user": profile()}), url="https://www.threads.net/@other", final=URL)
        self.assertEqual(result["status"], "unavailable")

    async def test_exact_post_excludes_replies_quotes_profile_and_other_links(self):
        url = URL + "/post/AbCd_123"
        media = post()
        media["text_post_app_info"]["share_info"] = {"quoted_post": post(caption={"text": "Casino quote https://example.com/quote"})}
        html = page({"media": media, "user": profile(biography="Casino biography https://example.com/bio"),
                     "replies": [post(caption={"text": "Casino reply https://example.com/reply"})]}, url=url,
                    extra='<article>Other public text https://example.com/wrong</article>')
        result = await self.collect_page(html, url=url)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["text"], "Public library\n" + POST)
        self.assertEqual(result["links"], [])
        self.assertEqual(result["metadata"]["content_scope"], "public_threads_post")

    async def test_missing_or_mismatched_post_never_uses_neighbor_or_profile(self):
        url = URL + "/post/AbCd_123"
        for data in ({"user": profile()}, {"media": post(code="abcd_123")},
                     {"media": post(user=profile(username="other"))}, {"replies": [post()]},
                     {"media": post(caption=None)}, {"media": post(text_post_app_info={})}):
            with self.subTest(data=data):
                result = await self.collect_page(page(data, url=url), url=url)
                self.assertEqual(result["status"], "unavailable")

    async def test_unavailable_post_flags_stop_collection(self):
        url = URL + "/post/AbCd_123"
        for flag in ("is_post_unavailable", "post_tombstone_info", "post_unavailable_reason", "attachment_tombstone_info"):
            with self.subTest(flag=flag):
                media = post(text_post_app_info={"is_post_unavailable": False, flag: True})
                result = await self.collect_page(page({"media": media}, url=url), url=url)
                self.assertEqual(result["status"], "blocked")

    async def test_shells_unknown_scripts_and_unsupported_paths_never_supply_evidence(self):
        for html in ('<title>Threads</title><main>Terms Privacy Cookies Policy</main>',
                     '<meta name="description" content="Join our platform and see public conversations">',
                     '<script>window.data=' + json.dumps(profile()) + '</script>',
                     '<script type="application/json">' + json.dumps(profile()) + '</script>',
                     '<script type="application/json">{broken json</script>',
                     '<article>Unverified public post attributed to an unknown source.</article>'):
            with self.subTest(html=html):
                result = await self.collect_page(html)
                self.assertEqual(result["status"], "unavailable")
        result = await self.collect_page(page({"user": profile()}), url=URL + "/replies")
        self.assertEqual(result["status"], "unavailable")

    async def test_text_json_traversal_and_script_bounds(self):
        html = page({"user": profile(biography="A" * 25_000)})
        result = await self.collect_page(html)
        self.assertEqual(len(result["text"]), c.MAX_TEXT_CHARS)
        self.assertTrue(result["metadata"]["text_truncated"])
        for constant, limit in (("MAX_JSON_CHARS", 10), ("MAX_JSON_NODES", 1), ("MAX_JSON_SCRIPTS", 1)):
            with self.subTest(constant=constant), patch.object(c, constant, limit):
                result = await self.collect_page('<script type="application/json">{}</script>' + html)
                self.assertEqual(result["status"], "unavailable")

    async def test_links_belong_only_to_the_profile_and_remain_inert(self):
        user = profile(bio_links=[{"url": "https://example.com/library"}, {"url": "http://127.0.0.1/"},
                                  {"url": "javascript:alert(1)"}, {"url": "https://www.threads.com/login"}])
        result = await self.collect_page(page({"user": user}, extra='<a href="https://example.com/neighbor">Other post</a>'))
        self.assertEqual(result["links"], ["https://example.com/library"])

    async def test_conflicting_profile_copies_are_not_scored(self):
        result = await self.collect_page(page({"user": profile()}) + script({"user": profile(biography="A conflicting profile biography here.")}))
        self.assertEqual(result["status"], "unavailable")

    async def test_empty_bio_uses_only_own_public_preview_posts_with_source_urls(self):
        public_post = post(text_post_app_info={"is_post_unavailable": False, "is_reply": False})
        other_post = post(user=profile(username="other"), code="Other123", caption={"text": "Casino recommendation"})
        html = page({"user": profile(biography="")}, visible=POST,
                    extra='<span>Log in to see more from public.</span>') + script(feed(public_post, other_post))
        result = await self.collect_page(html)
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["text"], "Public library\n" + POST)
        self.assertEqual(result["metadata"]["content_scope"], "public_threads_profile_posts")
        self.assertEqual(result["metadata"]["posts_collected"], 1)
        self.assertEqual(result["metadata"]["source_post_urls"], [URL + "/post/AbCd_123"])
        self.assertEqual(result["links"], [URL + "/post/AbCd_123"])

    async def test_profile_preview_is_bounded_and_does_not_replace_substantive_bio(self):
        posts = [post(code=f"Code{i}", text_post_app_info={"is_post_unavailable": False, "is_reply": False},
                      caption={"text": f"Library community public post number {i}."}) for i in range(30)]
        html = page({"user": profile(biography="")}) + script(feed(*posts))
        result = await self.collect_page(html)
        self.assertEqual(result["metadata"]["posts_collected"], c.MAX_THREADS_POSTS)
        self.assertIn("number 19", result["text"])
        self.assertNotIn("number 20", result["text"])
        result = await self.collect_page(page({"user": profile()}) + script(feed(*posts)))
        self.assertEqual(result["text"], "Public library\n" + BIO)

    async def test_missing_profile_or_gated_reply_and_nested_posts_are_not_a_profile_check(self):
        rejected = [post(), post(text_post_app_info={"is_post_unavailable": True, "is_reply": False}),
                    post(text_post_app_info={"is_post_unavailable": False, "is_reply": True}),
                    post(user=profile(text_post_app_is_private=True)),
                    post(user=profile(username="other"), text_post_app_info={"is_post_unavailable": False, "is_reply": False})]
        for media in rejected:
            with self.subTest(media=media):
                result = await self.collect_page(page({"user": profile(biography="")}) + script(feed(media)))
                self.assertEqual(result["status"], "unavailable")
        media = post(text_post_app_info={"is_post_unavailable": False, "is_reply": False})
        result = await self.collect_page(page(feed(media)))
        self.assertEqual(result["status"], "unavailable")
        result = await self.collect_page(page({"user": profile(biography=""), "quoted_post": media}))
        self.assertEqual(result["status"], "unavailable")

    async def test_hidden_preview_and_visible_genuine_gate_remain_blocked(self):
        media = post(text_post_app_info={"is_post_unavailable": False, "is_reply": False})
        for visible, extra in (("", '<span>Log in to see more from public.</span>'),
                               (POST, '<span>Log in to see more from public.</span><h1>Log in to continue</h1>')):
            with self.subTest(visible=visible):
                html = page({"user": profile(biography="")}, visible=visible, extra=extra) + script(feed(media))
                result = await self.collect_page(html)
                self.assertEqual(result["status"], "blocked")
