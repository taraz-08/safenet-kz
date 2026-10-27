"""Offline security-boundary tests: no real sockets or browser origins visited."""
import asyncio
import os
from pathlib import Path
import ssl
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

import httpx

from safenet import safe_fetch as sf


PUBLIC_IP = "93.184.216.34"


class RawStream(httpx.AsyncByteStream):
    def __init__(self, chunks):
        self.chunks = chunks

    async def __aiter__(self):
        for chunk in self.chunks:
            yield chunk


class PublicFetchTests(unittest.IsolatedAsyncioTestCase):
    async def test_rejects_unsafe_syntax_and_literal_addresses_before_dns(self):
        denied = [
            "file:///etc/passwd", "ftp://example.com/a", "data:text/html,x", "//example.com/",
            "http://user:secret@example.com/", "http://example.com@127.0.0.1/",
            "http://example.com:4310/", "https://example.com:80/", "http://example.com:443/",
            "http://example.com:/", "https://example.com:bad/", "https://%65xample.com/",
            "http://127.0.0.1/", "http://127.5.6.7/", "http://0.0.0.0/", "http://10.0.0.2/",
            "http://172.16.0.1/", "http://192.168.0.1/", "http://169.254.169.254/",
            "http://100.100.100.200/", "http://192.0.0.8/", "http://224.0.0.1/",
            "http://240.0.0.1/", "http://198.18.0.1/", "http://192.0.2.1/",
            "http://2130706433/", "http://0177.0.0.1/", "http://127.1/", "http://0x7f000001/",
            "http://[::]/", "http://[::1]/", "http://[fc00::1]/", "http://[fe80::1]/",
            "http://[::ffff:127.0.0.1]/", "http://[::ffff:192.168.1.1]/",
            "http://[::ffff:7f00:1]/", "http://[64:ff9b::7f00:1]/",
            "http://[2002:7f00:1::]/", "http://[2001::1]/", "http://[ff02::1]/",
            "http://[fe80::1%25eth0]/", "http://localhost/", "http://x.localhost/",
            "http://machine.internal/", "http://metadata.google.internal/", "http://singlelabel/",
            " http://example.com/", "http://example.com/\r\nX-Test:foo",
            "http://example.com\\@localhost/", "http://example.com/\tpath",
            "http://example.com/" + "x" * 2048,
        ]
        with patch.object(sf, "_resolve", new_callable=AsyncMock) as resolver:
            for url in denied:
                with self.subTest(url=url):
                    with self.assertRaises(sf.UnsafeURL):
                        await sf.validate_url(url)
            resolver.assert_not_awaited()

    async def test_all_dns_answers_are_checked_including_mapped_and_mixed(self):
        for addresses in ([PUBLIC_IP, "127.0.0.1"], ["10.0.0.1", PUBLIC_IP],
                          [PUBLIC_IP, "::ffff:169.254.169.254"], [PUBLIC_IP, "fc00::1"],
                          [PUBLIC_IP, "64:ff9b::a00:1"]):
            with self.subTest(addresses=addresses), patch.object(sf, "_resolve", AsyncMock(return_value=addresses)):
                with self.assertRaises(sf.UnsafeURL):
                    await sf.validate_url("https://example.com/")

    async def test_public_ipv4_ipv6_and_mapped_ipv4_are_pinned(self):
        for literal, expected in ((PUBLIC_IP, PUBLIC_IP),
                                  ("[2606:4700:4700::1111]", "2606:4700:4700::1111"),
                                  ("[::ffff:93.184.216.34]", PUBLIC_IP)):
            with self.subTest(literal=literal), patch.object(sf, "_resolve", new_callable=AsyncMock) as resolver:
                target = await sf.validate_url(f"https://{literal}/")
                self.assertEqual(target.addresses, (expected,))
                resolver.assert_not_awaited()

    async def test_canonicalization_and_dns_failure(self):
        with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP, PUBLIC_IP])):
            target = await sf.validate_url("HTTPS://EXAMPLE.COM.:443/path?q=value#fragment")
        self.assertEqual(target.url, "https://example.com/path?q=value")
        self.assertEqual(target.addresses, (PUBLIC_IP,))
        for error in (OSError("dns unavailable"), TimeoutError()):
            with patch.object(sf, "_resolve", AsyncMock(side_effect=error)):
                with self.assertRaises(sf.FetchError):
                    await sf.validate_url("https://example.com/")

    async def test_rebinding_same_host_redirect_is_revalidated(self):
        first = {"url": "https://example.com/", "status_code": 302, "text": "", "headers": {"location": "/next"}}
        with patch.object(sf, "_resolve", AsyncMock(side_effect=[[PUBLIC_IP], ["127.0.0.1"]])) as resolver, \
             patch.object(sf, "_request_once", AsyncMock(return_value=first)) as request:
            with self.assertRaises(sf.UnsafeURL):
                await sf.fetch_public("https://example.com/")
        self.assertEqual(resolver.await_count, 2)
        self.assertEqual(request.await_count, 1)

    async def test_redirect_each_hop_rejects_unsafe_destination(self):
        for location in ("http://127.0.0.1/", "https://[::ffff:7f00:1]/", "https://example.com:4310/",
                         "file:///etc/passwd", "https://user:password@example.com/", "http://example.com/plain",
                         "https://example.com/\npath", "https://example.com\\@127.0.0.1/"):
            response = {"status_code": 302, "text": "", "headers": {"location": location}}
            with self.subTest(location=location), patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
                 patch.object(sf, "_request_once", AsyncMock(return_value=response)) as request:
                with self.assertRaises(sf.UnsafeURL):
                    await sf.fetch_public("https://example.com/")
                self.assertEqual(request.await_count, 1)

    async def test_platform_redirect_allowlist_checked_before_dns(self):
        response = {"status_code": 302, "text": "", "headers": {"location": "https://www.elevenlabs.io/"}}
        with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])) as resolver, \
             patch.object(sf, "_request_once", AsyncMock(return_value=response)):
            with self.assertRaises(sf.UnsafeURL):
                await sf.fetch_public("https://www.youtube.com/", allowed_hosts={"www.youtube.com"})
        self.assertEqual(resolver.await_count, 1)

    async def test_redirect_limits_and_loops(self):
        for response in ({"status_code": 302, "text": "", "headers": {"location": "/"}},
                         {"status_code": 302, "text": "", "headers": {}}):
            with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
                 patch.object(sf, "_request_once", AsyncMock(return_value=response)):
                with self.assertRaises(sf.FetchError):
                    await sf.fetch_public("https://example.com/")
        responses = [{"status_code": 302, "text": "", "headers": {"location": f"/hop-{i}"}}
                     for i in range(sf.MAX_REDIRECTS + 1)]
        with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
             patch.object(sf, "_request_once", AsyncMock(side_effect=responses)) as request:
            with self.assertRaises(sf.FetchError):
                await sf.fetch_public("https://example.com/")
        self.assertEqual(request.await_count, sf.MAX_REDIRECTS + 1)

    async def test_total_time_bound_and_sanitized_errors(self):
        async def slow(*args):
            await asyncio.sleep(0.1)
        with patch.object(sf, "FETCH_TIMEOUT", 0.005), patch.object(sf, "_resolve", slow):
            with self.assertRaisesRegex(sf.FetchError, "time limit"):
                await sf.fetch_public("https://example.com/")
        with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
             patch.object(sf, "_request_once", AsyncMock(side_effect=httpx.ConnectError("SECRET"))):
            with self.assertRaises(sf.FetchError) as error:
                await sf.fetch_public("https://example.com/")
            self.assertNotIn("SECRET", str(error.exception))

    async def test_actual_transport_connects_numeric_ip_with_original_tls_host(self):
        """Exercise real httpx/httpcore request machinery, replacing only sockets."""
        class Wire:
            def __init__(self):
                self.written = bytearray()
                self.tls = None
                self.response = b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\nContent-Type: text/plain\r\n\r\nhello"

            async def read(self, max_bytes, timeout=None):
                data, self.response = self.response[:max_bytes], self.response[max_bytes:]
                return data

            async def write(self, buffer, timeout=None):
                self.written.extend(buffer)

            async def aclose(self):
                pass

            async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
                self.tls = (ssl_context, server_hostname)
                return self

            def get_extra_info(self, key):
                return None

        class Backend:
            def __init__(self):
                self.calls = []
                self.wire = Wire()

            async def connect_tcp(self, **kwargs):
                self.calls.append(kwargs)
                return self.wire

        backend = Backend()
        real_client = httpx.AsyncClient
        options = []
        def client_factory(**kwargs):
            options.append(kwargs.copy())
            transport = httpx.AsyncHTTPTransport(trust_env=False)
            transport._pool._network_backend = backend
            return real_client(**kwargs, transport=transport)

        with patch.dict(os.environ, {"HTTPS_PROXY": "http://127.0.0.1:4310", "ALL_PROXY": "http://127.0.0.1:4310"}), \
             patch.object(sf, "_resolve", AsyncMock(side_effect=[[PUBLIC_IP], ["127.0.0.1"]])) as resolver, \
             patch.object(sf.httpx, "AsyncClient", side_effect=client_factory):
            result = await sf.fetch_public("https://example.com/path?x=1")
        self.assertEqual(result["url"], "https://example.com/path?x=1")
        self.assertEqual(result["text"], "hello")
        resolver.assert_awaited_once()
        self.assertEqual(backend.calls[0]["host"], PUBLIC_IP)
        self.assertEqual(backend.calls[0]["port"], 443)
        self.assertIn(b"Host: example.com\r\n", backend.wire.written)
        self.assertEqual(backend.wire.tls[1], "example.com")
        self.assertEqual(backend.wire.tls[0].verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(backend.wire.tls[0].check_hostname)
        self.assertFalse(options[0]["trust_env"])
        self.assertFalse(options[0]["follow_redirects"])

    async def test_streamed_body_and_content_boundaries(self):
        cases = [
            ({"content-length": "9999999"}, [b"tiny"]),
            ({"content-length": "invalid"}, [b"tiny"]),
            ({}, [b"a" * 8, b"b" * 9]),
            ({"content-encoding": "gzip"}, [b"compressed bomb"]),
            ({"content-type": "application/octet-stream"}, [b"binary"]),
        ]
        real_client = httpx.AsyncClient
        for headers, chunks in cases:
            def factory(**kwargs):
                return real_client(**kwargs, transport=httpx.MockTransport(
                    lambda request: httpx.Response(200, headers=headers, stream=RawStream(chunks))))
            with self.subTest(headers=headers), patch.object(sf, "MAX_BODY_BYTES", 16), \
                 patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
                 patch.object(sf.httpx, "AsyncClient", side_effect=factory):
                with self.assertRaises(sf.FetchError):
                    await sf.fetch_public("https://example.com/")

    async def test_no_secret_headers_follow_redirects_and_no_host_override(self):
        with self.assertRaises(sf.UnsafeURL):
            await sf.fetch_public("https://example.com/", request_headers={"Host": "localhost"})
        with self.assertRaises(sf.UnsafeURL):
            await sf.fetch_public("https://example.com/", request_headers={"X-Goog-Api-Key": "SECRET"})
        response = {"url": "https://www.googleapis.com/", "status_code": 302, "text": "", "headers": {"location": "https://evil.example.com/"}}
        with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
             patch.object(sf, "_request_once", AsyncMock(return_value=response)) as request:
            result = await sf.fetch_public("https://www.googleapis.com/", allowed_hosts={"www.googleapis.com"},
                follow_redirects=False, request_headers={"X-Goog-Api-Key": "SECRET"})
        self.assertEqual(result["status_code"], 302)
        request.assert_awaited_once()

    async def test_youtube_documents_have_a_bounded_exact_host_budget(self):
        real_client = httpx.AsyncClient
        cases = [
            ("www.youtube.com", {}, [b"a" * 16, b"b" * 16], True),
            ("youtube.com", {"content-length": "32"}, [b"a" * 32], True),
            ("m.youtube.com", {}, [b"a" * 32], True),
            ("www.youtube.com", {}, [b"a" * 32, b"b"], False),
            ("www.youtube.com", {"content-length": "33"}, [b"tiny"], False),
            ("youtube.com.attacker.example", {}, [b"a" * 17], False),
            ("notyoutube.com", {}, [b"a" * 17], False),
            ("example.com", {}, [b"a" * 16], True),
            ("example.com", {}, [b"a" * 17], False),
        ]
        for host, headers, chunks, accepted in cases:
            def factory(**kwargs):
                return real_client(**kwargs, transport=httpx.MockTransport(
                    lambda request: httpx.Response(200, headers=headers, stream=RawStream(chunks))))
            with self.subTest(host=host, headers=headers, accepted=accepted), \
                 patch.object(sf, "MAX_BODY_BYTES", 16), patch.object(sf, "MAX_YOUTUBE_BODY_BYTES", 32), \
                 patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
                 patch.object(sf.httpx, "AsyncClient", side_effect=factory):
                if accepted:
                    result = await sf.fetch_public(f"https://{host}/")
                    self.assertEqual(result["text"], b"".join(chunks).decode())
                else:
                    with self.assertRaises(sf.FetchError):
                        await sf.fetch_public(f"https://{host}/")

    async def test_larger_budget_does_not_follow_youtube_redirect_to_other_host(self):
        real_client = httpx.AsyncClient
        def reply(request):
            if request.headers["host"] == "www.youtube.com":
                return httpx.Response(302, headers={"location": "https://example.com/final"})
            return httpx.Response(200, stream=RawStream([b"a" * 17]))
        def factory(**kwargs):
            return real_client(**kwargs, transport=httpx.MockTransport(reply))
        with patch.object(sf, "MAX_BODY_BYTES", 16), patch.object(sf, "MAX_YOUTUBE_BODY_BYTES", 32), \
             patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
             patch.object(sf.httpx, "AsyncClient", side_effect=factory):
            with self.assertRaises(sf.FetchError):
                await sf.fetch_public("https://www.youtube.com/start")

    async def test_blocked_status_survives_compressed_or_nontext_error_body(self):
        real_client = httpx.AsyncClient
        def factory(**kwargs):
            return real_client(**kwargs, transport=httpx.MockTransport(lambda request: httpx.Response(
                403, headers={"content-encoding": "gzip", "content-type": "application/octet-stream"},
                stream=RawStream([b"not actually compressed"]))))
        with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
             patch.object(sf.httpx, "AsyncClient", side_effect=factory):
            result = await sf.fetch_public("https://example.com/")
        self.assertEqual(result["status_code"], 403)
        self.assertEqual(result["text"], "")

    async def test_idn_authority_is_canonical_before_dns_and_host_header(self):
        with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])) as resolver:
            target = await sf.validate_url("https://пример.com/path")
        self.assertEqual(target.host, "xn--e1afmkfd.com")
        self.assertEqual(target.authority, "xn--e1afmkfd.com")
        resolver.assert_awaited_once_with("xn--e1afmkfd.com", 443)


class PublicBinaryFetchTests(unittest.IsolatedAsyncioTestCase):
    URL = "https://scontent.cdninstagram.com/public.mp4?signature=secret"
    SUFFIXES = frozenset({"cdninstagram.com", "fbcdn.net"})
    MP4 = b"\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom" + b"\x00\x00\x00\x08mdat"

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.target = Path(self.directory.name) / "video.mp4"
        self.real_client = httpx.AsyncClient

    def factory(self, handler):
        return lambda **kwargs: self.real_client(**kwargs, transport=httpx.MockTransport(handler))

    async def download(self, url=None, **kwargs):
        return await sf.download_public_binary(url or self.URL, self.target,
                                              allowed_host_suffixes=self.SUFFIXES, **kwargs)

    def assert_preserved(self):
        self.assertEqual(self.target.read_bytes(), b"original")
        self.assertEqual(list(self.target.parent.iterdir()), [self.target])

    async def test_valid_mp4_is_streamed_atomically_with_bounded_headers(self):
        self.target.write_bytes(b"original")
        requests = []
        owner = self
        class ObservedStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                for chunk in (owner.MP4[:4], owner.MP4[4:10], owner.MP4[10:]):
                    owner.assertEqual(owner.target.read_bytes(), b"original")
                    yield chunk
        def reply(request):
            requests.append(request)
            return httpx.Response(200, headers={"content-type": "Video/MP4; charset=binary", "content-length": str(len(self.MP4))},
                                  stream=ObservedStream())
        with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
             patch.object(sf.httpx, "AsyncClient", side_effect=self.factory(reply)), \
             patch.object(sf, "BINARY_CHUNK_BYTES", 5):
            result = await self.download()
        self.assertEqual(self.target.read_bytes(), self.MP4)
        self.assertEqual(result, {"path": str(self.target), "url": self.URL,
                                 "download_bytes": len(self.MP4), "content_type": "video/mp4"})
        self.assertEqual(list(self.target.parent.iterdir()), [self.target])
        self.assertEqual(requests[0].url.host, PUBLIC_IP)
        self.assertEqual(requests[0].headers["host"], "scontent.cdninstagram.com")
        self.assertEqual(requests[0].headers["accept-encoding"], "identity")
        self.assertEqual(requests[0].extensions["sni_hostname"], "scontent.cdninstagram.com")

    async def test_size_mime_encoding_and_magic_failures_preserve_target(self):
        cases = [
            ({"content-length": "999999999"}, [self.MP4]),
            ({"content-length": "invalid"}, [self.MP4]),
            ({"content-length": "-1"}, [self.MP4]),
            ({"content-length": "１２"}, [self.MP4]),
            ({"content-length": "0000000000000000001"}, [self.MP4]),
            ({"content-length": "2"}, [self.MP4]),
            ({"content-length": str(len(self.MP4) + 1)}, [self.MP4]),
            ({}, [self.MP4, b"a" * 50]),
            ({"content-encoding": "gzip"}, [self.MP4]),
            ({"content-encoding": "br"}, [self.MP4]),
            ({"content-type": "text/html"}, [self.MP4]),
            ({"content-type": "application/octet-stream"}, [self.MP4]),
            ({"content-type": "application/vnd.apple.mpegurl"}, [b"#EXTM3U\nhttps://127.0.0.1/x"]),
            ({"content-type": "application/dash+xml"}, [b"<MPD/>"]),
            ({"content-type": ""}, [self.MP4]),
            ({}, [b"<html>Access denied</html>"]),
            ({}, [b"#EXTM3U\nhttps://127.0.0.1/internal"]),
            ({}, [b"\x00\x00\x00\x18ftypavif\x00\x00\x00\x00avifmif1"]),
            ({}, [b"\x00\x00\x00\x18ftypM4A \x00\x00\x00\x00M4A M4B "]),
            ({}, [b"\x00\x00\xff\xffftypmp42"]),
            ({}, [b"\x00\x00\x00\x18ftypmp42"]),
            ({}, [b"\x00\x00\x00\x00ftypmp42"]),
            ({}, [b"\x00\x00\x00\x01ftypmp42"]),
            ({}, [b""]),
        ]
        for headers, chunks in cases:
            self.target.write_bytes(b"original")
            def reply(request):
                return httpx.Response(200, headers={"content-type": "video/mp4", **headers}, stream=RawStream(chunks))
            # httpx headers accept bytes for malformed non-ASCII header tests.
            if headers.get("content-length") == "１２":
                headers = {"content-length": "１２".encode("utf-8")}
            with self.subTest(headers=headers, prefix=chunks[0][:16]), \
                 patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
                 patch.object(sf.httpx, "AsyncClient", side_effect=self.factory(reply)), \
                 patch.object(sf, "BINARY_CHUNK_BYTES", 8):
                with self.assertRaises(sf.FetchError):
                    await self.download(max_bytes=len(self.MP4) + 4)
            self.assert_preserved()

    async def test_known_oversize_or_wrong_mime_never_reads_body(self):
        class ForbiddenStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                raise AssertionError("Must not read rejected body")
                yield b""
        for headers in ({"content-type": "video/mp4", "content-length": str(sf.MAX_BINARY_BYTES + 1)},
                        {"content-type": "text/html"}, {"content-type": "video/mp4", "content-encoding": "gzip"}):
            def reply(request):
                return httpx.Response(200, headers=headers, stream=ForbiddenStream())
            with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
                 patch.object(sf.httpx, "AsyncClient", side_effect=self.factory(reply)):
                with self.assertRaises(sf.FetchError):
                    await self.download()
            self.assertFalse(self.target.exists())
            self.assertEqual(list(self.target.parent.iterdir()), [])

    async def test_exact_byte_limit_succeeds_and_first_excess_chunk_fails(self):
        for extra in (b"", b"x"):
            self.target.write_bytes(b"original")
            def reply(request):
                return httpx.Response(200, headers={"content-type": "video/mp4"}, stream=RawStream([self.MP4, extra]))
            with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
                 patch.object(sf.httpx, "AsyncClient", side_effect=self.factory(reply)):
                if extra:
                    with self.assertRaises(sf.FetchError):
                        await self.download(max_bytes=len(self.MP4))
                    self.assert_preserved()
                else:
                    result = await self.download(max_bytes=len(self.MP4))
                    self.assertEqual(result["download_bytes"], len(self.MP4))

    async def test_hard_limits_cannot_be_increased_or_disabled(self):
        with patch.object(sf, "_resolve", new_callable=AsyncMock) as resolve:
            for options in ({"max_bytes": sf.MAX_BINARY_BYTES + 1}, {"max_bytes": 0}, {"max_bytes": True},
                            {"max_bytes": 1.5}, {"timeout": 121}, {"timeout": 0}, {"timeout": True},
                            {"timeout": float("inf")}, {"timeout": float("nan")}):
                with self.subTest(options=options), self.assertRaises(ValueError):
                    await self.download(**options)
        resolve.assert_not_awaited()
        self.assertEqual(list(self.target.parent.iterdir()), [])

    async def test_cdn_policy_and_default_ports_checked_before_dns(self):
        urls = ["https://example.com/a.mp4", "https://cdninstagram.com.evil.example/a.mp4",
                "https://evilcdninstagram.com/a.mp4", "http://scontent.cdninstagram.com/a.mp4",
                "https://scontent.cdninstagram.com:444/a.mp4", "https://scontent.cdninstagram.com:80/a.mp4",
                "https://user:pass@scontent.cdninstagram.com/a.mp4", "https://127.0.0.1/a.mp4",
                "https://scontent.cdninstagram.com\\@127.0.0.1/a.mp4", "file:///tmp/a.mp4"]
        with patch.object(sf, "_resolve", new_callable=AsyncMock) as resolve:
            for url in urls:
                with self.subTest(url=url), self.assertRaises(sf.UnsafeURL):
                    await self.download(url)
            with self.assertRaises(sf.UnsafeURL):
                await sf.download_public_binary(self.URL, self.target, allowed_host_suffixes=set())
        resolve.assert_not_awaited()
        self.assertEqual(list(self.target.parent.iterdir()), [])

    async def test_mixed_or_private_dns_answers_never_open_connection(self):
        for addresses in ([PUBLIC_IP, "127.0.0.1"], [PUBLIC_IP, "169.254.169.254"],
                          [PUBLIC_IP, "fc00::1"], [PUBLIC_IP, "::ffff:10.0.0.1"],
                          [PUBLIC_IP, "64:ff9b::a00:1"], [PUBLIC_IP, "2002:7f00:1::"]):
            with self.subTest(addresses=addresses), \
                 patch.object(sf, "_resolve", AsyncMock(return_value=addresses)), \
                 patch.object(sf.httpx, "AsyncClient") as client, self.assertRaises(sf.UnsafeURL):
                await self.download()
            client.assert_not_called()
        self.assertEqual(list(self.target.parent.iterdir()), [])

    async def test_each_redirect_revalidates_dns_including_same_host(self):
        requests = []
        def reply(request):
            requests.append(request)
            return httpx.Response(302, headers={"location": "/second.mp4"})
        self.target.write_bytes(b"original")
        with patch.object(sf, "_resolve", AsyncMock(side_effect=[[PUBLIC_IP], [PUBLIC_IP, "127.0.0.1"]])) as resolve, \
             patch.object(sf.httpx, "AsyncClient", side_effect=self.factory(reply)), self.assertRaises(sf.UnsafeURL):
            await self.download()
        self.assertEqual(resolve.await_count, 2)
        self.assertEqual(len(requests), 1)
        self.assert_preserved()

    async def test_redirect_host_policy_checked_before_second_dns(self):
        for location in ("https://example.com/a.mp4", "https://v16.tiktokcdn.com/a.mp4",
                         "http://scontent.fbcdn.net/a.mp4", "https://scontent.fbcdn.net:444/a.mp4",
                         "https://user:secret@scontent.fbcdn.net/a.mp4", "https://scontent.fbcdn.net/a\n.mp4",
                         "https://scontent.fbcdn.net\\@127.0.0.1/a.mp4", "file:///tmp/video.mp4"):
            def reply(request):
                return httpx.Response(302, headers={"location": location})
            with self.subTest(location=location), patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])) as resolve, \
                 patch.object(sf.httpx, "AsyncClient", side_effect=self.factory(reply)), self.assertRaises((sf.UnsafeURL, sf.FetchError)):
                await self.download()
            resolve.assert_awaited_once()
            self.assertEqual(list(self.target.parent.iterdir()), [])

    async def test_allowed_redirect_has_fresh_client_pin_and_no_cookies(self):
        requests, options = [], []
        def reply(request):
            requests.append(request)
            if len(requests) == 1:
                return httpx.Response(302, headers={"location": "/final.mp4", "set-cookie": "session=secret; Path=/"})
            return httpx.Response(200, headers={"content-type": "video/mp4"}, stream=RawStream([self.MP4]))
        def factory(**kwargs):
            options.append(kwargs)
            return self.factory(reply)(**kwargs)
        with patch.dict(os.environ, {"HTTPS_PROXY": "http://127.0.0.1:4310", "SSL_CERT_FILE": "missing-file"}), \
             patch.object(sf, "_resolve", AsyncMock(side_effect=[[PUBLIC_IP], ["8.8.8.8"]])) as resolve, \
             patch.object(sf.httpx, "AsyncClient", side_effect=factory):
            result = await self.download()
        self.assertEqual(resolve.await_count, 2)
        self.assertEqual([r.url.host for r in requests], [PUBLIC_IP, "8.8.8.8"])
        self.assertEqual(len(options), 2)
        for request, config in zip(requests, options):
            self.assertNotIn("cookie", request.headers)
            self.assertNotIn("authorization", request.headers)
            self.assertNotIn("referer", request.headers)
            self.assertFalse(config["trust_env"])
            self.assertFalse(config["follow_redirects"])
            self.assertTrue(config["verify"])
        self.assertEqual(result["url"], "https://scontent.cdninstagram.com/final.mp4")

    async def test_redirect_limit_loop_and_missing_location_cleanup(self):
        for mode in ("limit", "loop", "missing"):
            calls = []
            def reply(request):
                calls.append(request)
                headers = {} if mode == "missing" else {"location": self.URL if mode == "loop" else f"/hop{len(calls)}.mp4"}
                return httpx.Response(302, headers=headers)
            with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
                 patch.object(sf.httpx, "AsyncClient", side_effect=self.factory(reply)), self.assertRaises(sf.FetchError):
                await self.download()
            self.assertEqual(len(calls), sf.MAX_REDIRECTS + 1 if mode == "limit" else 1)
            self.assertEqual(list(self.target.parent.iterdir()), [])

    async def test_blocked_http_is_distinct_from_unavailable_and_body_is_not_read(self):
        class ForbiddenStream(httpx.AsyncByteStream):
            async def __aiter__(self):
                raise AssertionError("Error body must not be read")
                yield b""
        for status in (401, 403, 407, 429, 451, 404, 500, 204, 206):
            def reply(request):
                return httpx.Response(status, headers={"content-encoding": "gzip"}, stream=ForbiddenStream())
            expected = sf.BinaryAccessBlocked if status in (401, 403, 407, 429, 451) else sf.FetchError
            with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
                 patch.object(sf.httpx, "AsyncClient", side_effect=self.factory(reply)), self.assertRaises(expected) as error:
                await self.download()
            self.assertIn(f"HTTP {status}", str(error.exception))
            self.assertEqual(list(self.target.parent.iterdir()), [])

    async def test_stalled_stream_deadline_preserves_target_and_closes_temp(self):
        self.target.write_bytes(b"original")
        class Stalled(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield PublicBinaryFetchTests.MP4
                await asyncio.sleep(1)
        def reply(request):
            return httpx.Response(200, headers={"content-type": "video/mp4"}, stream=Stalled())
        with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
             patch.object(sf.httpx, "AsyncClient", side_effect=self.factory(reply)), \
             patch.object(sf, "BINARY_CHUNK_BYTES", 8), self.assertRaises(sf.FetchError):
            await self.download(timeout=0.03)
        self.assert_preserved()

    async def test_cancelled_stream_propagates_and_cleans_partial_file(self):
        self.target.write_bytes(b"original")
        class Cancelled(httpx.AsyncByteStream):
            async def __aiter__(self):
                yield PublicBinaryFetchTests.MP4
                raise asyncio.CancelledError()
        def reply(request):
            return httpx.Response(200, headers={"content-type": "video/mp4"}, stream=Cancelled())
        with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
             patch.object(sf.httpx, "AsyncClient", side_effect=self.factory(reply)), \
             patch.object(sf, "BINARY_CHUNK_BYTES", 8), self.assertRaises(asyncio.CancelledError):
            await self.download()
        self.assert_preserved()

    async def test_dns_cancellation_race_cannot_start_connection(self):
        async def cancelled_dns(url):
            asyncio.current_task().cancel()
            try:
                await asyncio.sleep(0)
            except asyncio.CancelledError:
                # Reproduce wait_for's completed-future cancellation race.
                return sf.ValidatedURL(url, "https", "scontent.cdninstagram.com", 443, (PUBLIC_IP,))
        self.target.write_bytes(b"original")
        with patch.object(sf, "validate_url", cancelled_dns), \
             patch.object(sf.httpx, "AsyncClient") as client, self.assertRaises(asyncio.CancelledError):
            await self.download()
        client.assert_not_called()
        self.assert_preserved()

    async def test_network_and_disk_errors_are_sanitized_and_atomic(self):
        self.target.write_bytes(b"original")
        def reply(request):
            return httpx.Response(200, headers={"content-type": "video/mp4"}, stream=RawStream([self.MP4]))
        for failure in ("network", "commit"):
            with patch.object(sf, "_resolve", AsyncMock(return_value=[PUBLIC_IP])), \
                 patch.object(sf.httpx, "AsyncClient", side_effect=self.factory(reply)), \
                 patch.object(sf.os, "replace", side_effect=OSError("SECRET FILE PATH")) if failure == "commit" else \
                 patch.object(sf, "_download_binary_once", AsyncMock(side_effect=httpx.ReadError("SECRET URL"))):
                with self.assertRaises(sf.FetchError) as error:
                    await self.download()
            self.assertNotIn("SECRET", str(error.exception))
            self.assert_preserved()

    async def test_target_requires_mp4_extension(self):
        with patch.object(sf, "_resolve", new_callable=AsyncMock) as resolve:
            for suffix in (".html", ".m3u8", ".webm", ""):
                with self.assertRaises(sf.FetchError):
                    await sf.download_public_binary(self.URL, self.target.with_suffix(suffix), allowed_host_suffixes=self.SUFFIXES)
        resolve.assert_not_awaited()

    async def test_actual_binary_transport_pins_ip_and_verifies_original_tls_name(self):
        owner = self
        class Wire:
            def __init__(self):
                self.written = bytearray()
                self.tls = None
                self.response = (f"HTTP/1.1 200 OK\r\nContent-Type: video/mp4\r\nContent-Length: {len(owner.MP4)}\r\n\r\n".encode() + owner.MP4)
            async def read(self, max_bytes, timeout=None):
                data, self.response = self.response[:max_bytes], self.response[max_bytes:]
                return data
            async def write(self, buffer, timeout=None):
                self.written.extend(buffer)
            async def aclose(self):
                pass
            async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
                self.tls = ssl_context, server_hostname
                return self
            def get_extra_info(self, key):
                return None
        class Backend:
            def __init__(self):
                self.calls = []
                self.wire = Wire()
            async def connect_tcp(self, **kwargs):
                self.calls.append(kwargs)
                return self.wire
        backend = Backend()
        def factory(**kwargs):
            transport = httpx.AsyncHTTPTransport(trust_env=False)
            transport._pool._network_backend = backend
            return self.real_client(**kwargs, transport=transport)
        with patch.object(sf, "_resolve", AsyncMock(side_effect=[[PUBLIC_IP], ["127.0.0.1"]])) as resolve, \
             patch.object(sf.httpx, "AsyncClient", side_effect=factory):
            result = await self.download()
        resolve.assert_awaited_once()
        self.assertEqual(backend.calls[0]["host"], PUBLIC_IP)
        self.assertEqual(backend.calls[0]["port"], 443)
        self.assertEqual(backend.wire.tls[1], "scontent.cdninstagram.com")
        self.assertEqual(backend.wire.tls[0].verify_mode, ssl.CERT_REQUIRED)
        self.assertTrue(backend.wire.tls[0].check_hostname)
        self.assertIn(b"Host: scontent.cdninstagram.com\r\n", backend.wire.written)
        self.assertEqual(result["download_bytes"], len(self.MP4))


if __name__ == "__main__":
    unittest.main()
