import { test } from "node:test";
import assert from "node:assert/strict";
import { isPublicTextScan, type Scan } from "../src/lib/schema";

const completedScan: Pick<Scan, "status" | "mode" | "url" | "platform" | "metadata"> = {
  status: "completed", mode: "live", url: "https://example.org/post", platform: "web", metadata: {},
};

test("completed public text collections show the media coverage note, with or without an explicit public_url origin", () => {
  for (const origin of [undefined, "public_url"]) {
    for (const content_scope of [
      "public_page_text_and_metadata", "official_public_snippet", "available page text only",
      "public_instagram_profile_metadata", "public_youtube_video_metadata", "public_youtube_channel_metadata",
      "public_instagram_page_metadata", "public_youtube_page_metadata",
      "public_telegram_post", "public_telegram_channel_posts", "public_telegram_profile_description",
      "public_threads_post", "public_threads_profile_metadata", "public_threads_profile_posts",
    ]) {
      assert.equal(isPublicTextScan({ ...completedScan, metadata: { origin, content_scope } }), true, content_scope);
    }
    for (const collector of ["public_http", "youtube_data_api"]) {
      assert.equal(isPublicTextScan({ ...completedScan, metadata: { origin, collector } }), true, collector);
    }
  }
});

test("legacy imports never inherit the current text-only claim, even when their metadata resembles a current scan", () => {
  for (const content_scope of ["public_page_text_and_metadata", "official_public_snippet", "video_frame_ocr", undefined]) {
    assert.equal(isPublicTextScan({ ...completedScan, metadata: {
      origin: "legacy_public_capture", content_scope, collector: "public_http",
      legacy_provenance: { method: "ocr" },
    } }), false);
  }
});

test("manual, synthetic and unfinished scans do not claim completed public collection", () => {
  const scan = { ...completedScan, metadata: { origin: "public_url", collector: "public_http" } };
  for (const status of ["queued", "running", "blocked", "failed", "cancelled"] as const) {
    assert.equal(isPublicTextScan({ ...scan, status }), false, status);
  }
  assert.equal(isPublicTextScan({ ...scan, mode: "demo" }), false);
  assert.equal(isPublicTextScan({ ...scan, url: "" }), false);
  assert.equal(isPublicTextScan({ ...scan, platform: "manual" }), false);
  for (const origin of ["manual", "synthetic", "unknown_import"]) {
    assert.equal(isPublicTextScan({ ...scan, metadata: { ...scan.metadata, origin } }), false, origin);
  }
});

test("unknown or media-bearing scopes cannot inherit a text-only claim from collector metadata", () => {
  for (const content_scope of ["video_frames_and_audio", "video_frame_ocr", "unknown", "", { text: true, audio: true }]) {
    assert.equal(isPublicTextScan({ ...completedScan, metadata: {
      origin: "public_url", collector: "public_http", content_scope,
    } }), false);
  }
  for (const metadata of [{}, { origin: "public_url" }, { collector: "unknown" }]) {
    assert.equal(isPublicTextScan({ ...completedScan, metadata }), false);
  }
});
