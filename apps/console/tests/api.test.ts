import { afterEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { api, ApiError, json } from "../src/lib/api";
import { safeHref, overviewSchema, scanSchema } from "../src/lib/schema";
import { mediaUpload } from "../src/lib/media";

afterEach(() => mock.restoreAll());
test("multipart upload preserves local auth, browser boundary and an upload-sized timeout", async () => {
  const timeouts: number[] = [];
  mock.method(AbortSignal, "timeout", (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  let captured: RequestInit | undefined;
  mock.method(globalThis, "fetch", async (path: string, options: RequestInit) => { assert.equal(path, "/api/v1/media/scans"); captured = options; return Response.json({ id: "fixture" }, { status: 202 }); });
  const upload = mediaUpload(new File(["fixture"], "fixture.mp4"), "live", "kk");
  const result = await api("/media/scans", z.object({ id: z.string() }), { ...upload, headers: new Headers({ "Content-Type": "application/json", Authorization: "Bearer fixture-only" }) });
  assert.equal(result.id, "fixture");
  assert.equal(captured?.body, upload.body);
  assert.equal(captured?.credentials, "same-origin");
  assert.equal(new Headers(captured?.headers).get("Content-Type"), null);
  assert.equal(new Headers(captured?.headers).get("Authorization"), "Bearer fixture-only");
  assert.equal(new Headers(captured?.headers).get("Accept"), "application/json");
  assert.match(new Request("https://example.org/api/v1/media/scans", captured).headers.get("Content-Type")!, /^multipart\/form-data; boundary=/);
  assert.deepEqual(timeouts, [180000]);
});

test("upload errors preserve 413/401 status and caller cancellation", async () => {
  const upload = mediaUpload(new File(["fixture"], "fixture.wav"), "demo", "en");
  for (const status of [413, 401]) {
    mock.method(globalThis, "fetch", async () => Response.json({ detail: "Fixture upload error" }, { status }));
    await assert.rejects(api("/media/scans", z.unknown(), upload), (error: unknown) => error instanceof ApiError && error.status === status);
  }
  const controller = new AbortController(); controller.abort();
  mock.method(globalThis, "fetch", async (_path: string, options: RequestInit) => { options.signal!.throwIfAborted(); return Response.json({}); });
  await assert.rejects(api("/media/scans", z.unknown(), { ...upload, signal: controller.signal }), { name: "AbortError" });
});

test("upload transport timeout is reported as a timeout", async () => {
  const expired = new AbortController(); expired.abort(new DOMException("Expired", "TimeoutError"));
  mock.method(AbortSignal, "timeout", () => expired.signal);
  mock.method(globalThis, "fetch", async (_path: string, options: RequestInit) => { options.signal!.throwIfAborted(); return Response.json({}); });
  await assert.rejects(api("/media/scans", z.unknown(), mediaUpload(new File(["fixture"], "fixture.wav"), "live", "ru")), (error: unknown) => error instanceof ApiError && error.message === "timeout");
});

test("timeouts and cancellation while reading an upload response are not schema errors", async () => {
  const timeout = new AbortController();
  mock.method(AbortSignal, "timeout", () => timeout.signal);
  mock.method(globalThis, "fetch", async () => { const response = Response.json({}, { status: 202 }); mock.method(response, "json", async () => { timeout.abort(); throw new DOMException("Expired", "AbortError"); }); return response; });
  await assert.rejects(api("/media/scans", z.unknown(), mediaUpload(new File(["fixture"], "fixture.mp4"), "live", "en")), (error: unknown) => error instanceof ApiError && error.message === "timeout" && error.kind === "network");
  const navigation = new AbortController();
  mock.method(globalThis, "fetch", async () => { const response = Response.json({}, { status: 202 }); mock.method(response, "json", async () => { navigation.abort(); throw new DOMException("Cancelled", "AbortError"); }); return response; });
  await assert.rejects(api("/scans/fixture", z.unknown(), { signal: navigation.signal }), { name: "AbortError" });
});
test("transport keeps mutations same-origin, forwards the abort signal, and parses the contract", async () => {
  const calls: { path: string; options?: RequestInit }[] = [];
  mock.method(globalThis, "fetch", async (path: string, options?: RequestInit) => { calls.push({ path, options }); return Response.json({ authenticated: true }); });
  const result = await api("/session", z.object({ authenticated: z.boolean() }), json("POST", { code: "test-fixture-only" }));
  assert.equal(result.authenticated, true);
  assert.equal(calls[0].path, "/api/v1/session");
  assert.equal(calls[0].options?.credentials, "same-origin");
  assert.equal(calls[0].options?.cache, "no-store");
  assert.ok(calls[0].options?.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(calls[0].options?.body as string), { code: "test-fixture-only" });
});
test("permission errors retain HTTP status and the backend detail", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ detail: "Administrator session required" }, { status: 401 }));
  await assert.rejects(api("/scans", z.unknown(), json("POST", { text: "test fixture", mode: "demo" })), (error: unknown) => error instanceof ApiError && error.status === 401 && error.message === "Administrator session required");
});
test("a broken proxy is reported as an HTTP error, never as an empty result", async () => {
  mock.method(globalThis, "fetch", async () => new Response("Bad gateway", { status: 502 }));
  await assert.rejects(api("/overview?mode=live", overviewSchema), (error: unknown) => error instanceof ApiError && error.status === 502);
});
test("unreachable API has a recoverable network failure", async () => {
  mock.method(globalThis, "fetch", async () => { throw new TypeError("fetch failed"); });
  await assert.rejects(api("/overview?mode=live", overviewSchema), (error: unknown) => error instanceof ApiError && error.kind === "network");
});
test("invalid data is rejected rather than generating synthetic totals", async () => {
  mock.method(globalThis, "fetch", async () => Response.json({ mode: "live", totals: {} }));
  await assert.rejects(api("/overview?mode=live", overviewSchema), (error: unknown) => error instanceof ApiError && error.kind === "schema");
});
test("cancelled navigation remains cancellation instead of a connection failure", async () => {
  const controller = new AbortController(); controller.abort();
  const reason = new DOMException("Navigation cancelled", "AbortError");
  mock.method(globalThis, "fetch", async () => { throw reason; });
  await assert.rejects(api("/settings", z.unknown(), { signal: controller.signal }), reason);
});
test("unscored inaccessible material stays nullable and preserves historical provenance", () => {
  const scan = scanSchema.parse({ id: "test-only", url: "https://example.org", title: "Fixture", platform: "web", mode: "demo", status: "blocked", stage: "blocked", created_at: "2026-10-26T10:00:00Z", completed_at: null, score: null, level: null, category: null, text: "", analysis: null, error: "Access restricted", review: null, agent_id: null, metadata: { origin: "legacy_public_capture", captured_at: "2026-01-01T12:00:00Z", imported_at: "2026-10-26T10:00:00Z", content_scope: "profile_metadata_only" } });
  assert.equal(scan.score, null); assert.equal(scan.analysis, null); assert.equal(scan.metadata.origin, "legacy_public_capture"); assert.equal(scan.metadata.content_scope, "profile_metadata_only");
});
test("untrusted evidence and citations cannot become script or file links", () => {
  for (const href of ["javascript:alert(1)", "data:text/html,test", "file:///etc/passwd", "//example.org", "not a url"]) assert.equal(safeHref(href), undefined);
  assert.equal(safeHref("https://example.org/evidence"), "https://example.org/evidence");
});
