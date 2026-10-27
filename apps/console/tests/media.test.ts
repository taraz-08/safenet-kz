import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MediaCapabilities, MediaDetails, MediaEvidence } from "../src/components/media-details";
import { ScanContent } from "../src/components/scan-detail";
import { Providers } from "../src/components/providers";
import { mediaMessage, translator } from "../src/lib/i18n";
import { mediaCopy, mediaReasonKeys } from "../src/lib/media-i18n";
import { frameThumbnail, isUploadedMedia, MAX_MEDIA_BYTES, MEDIA_ACCEPT, mediaCapabilities, mediaFileError, mediaRange, mediaTime, mediaUpload } from "../src/lib/media";
import { analysisSchema, evidenceSchema, healthSchema, isPublicTextScan, mediaSchema, scanSchema, settingsSchema, type Locale, type Media, type Scan } from "../src/lib/schema";

// Authored fixtures only. No evaluation data or live platform content.
const media: Media = {
  status: "partial", duration_seconds: 180, analyzed_seconds: 120, truncated: true, has_audio: true, has_video: true,
  audio: { status: "completed", model: "fixture-speech-model" },
  visual: { status: "partial", reason: "A sampled frame could not be read", model: "fixture-vision-model" },
  transcript: [{ start: 0, end: 2.5, text: "Fictional transcript" }],
  frames: [{ at: 0, text: "Fictional frame text", observations: ["An AI observation for review"], visual_status: "completed", ocr_confidence: 0, thumbnail_url: "/api/v1/scans/fixture/frames/0" }],
  limitations: ["Fixture sampling limitation"],
};
const scan = {
  id: "fixture", url: "https://example.org/post", title: "Fixture", platform: "instagram", mode: "live",
  status: "completed", stage: "completed", created_at: "2026-10-27T00:00:00Z", completed_at: null,
  score: null, level: null, category: null, text: "", analysis: null, error: null, review: null, agent_id: null,
  metadata: { origin: "public_url", collector: "public_http", content_scope: "public_page_text_and_metadata", media, provenance: "preserve" },
};

test("media schema preserves coverage, per-track reasons/models, time zero, OCR confidence and provenance", () => {
  const result = scanSchema.parse(scan);
  assert.deepEqual(result.metadata.media, media);
  assert.equal(result.metadata.provenance, "preserve");
  assert.equal(result.metadata.media?.transcript[0].start, 0);
  assert.equal(result.metadata.media?.frames[0].ocr_confidence, 0);
  assert.equal(isPublicTextScan(result), false);
});

test("completed, partial, unavailable, audio-only and silent-video results are accepted", () => {
  for (const status of ["completed", "partial", "unavailable"] as const) {
    assert.equal(mediaSchema.parse({ ...media, status }).status, status);
  }
  for (const flags of [{ has_audio: true, has_video: false }, { has_audio: false, has_video: true }]) {
    assert.ok(mediaSchema.safeParse({ ...media, ...flags, frames: [], transcript: [] }).success);
  }
  assert.ok(mediaSchema.safeParse({ ...media, status: "unavailable", duration_seconds: null, analyzed_seconds: 0, reason: "Runtime unavailable", audio: { status: "unavailable", model: null, reason: "Not installed" }, frames: [], transcript: [] }).success);
});

test("malformed media is rejected rather than silently stripping coverage", () => {
  for (const override of [{ status: "success" }, { analyzed_seconds: -1 }, { frames: [{ at: "0", text: "", observations: [], visual_status: "completed" }] }, { transcript: [{ start: 0, end: 1, text: 42 }] }]) {
    assert.equal(mediaSchema.safeParse({ ...media, ...override }).success, false);
  }
});

test("old public text scans retain their no-media note regardless of current runtime capabilities", () => {
  const old = scanSchema.parse({ ...scan, metadata: { ...scan.metadata, media: undefined } });
  assert.equal(isPublicTextScan(old), true);
  assert.equal(isPublicTextScan({ ...old, metadata: { ...old.metadata, media: null } }), true);
  for (const status of ["completed", "partial", "unavailable"] as const) {
    assert.equal(isPublicTextScan({ ...old, metadata: { ...old.metadata, media: { ...media, status } } }), false);
  }
});

test("evidence retains all modalities, timestamps, model and other provenance without changing weights", () => {
  const base = { code: "fixture", label: "Fixture", quote: "Fictional quote", weight: 7, source_url: "" };
  assert.deepEqual(evidenceSchema.parse(base), base);
  for (const modality of ["speech", "frame_text", "page_text"] as const) {
    const full = { ...base, modality, start_seconds: 0, end_seconds: 2.5, model: "fixture", extra_provenance: "keep" };
    assert.deepEqual(evidenceSchema.parse(full), full);
  }
});

test("media capability schemas retain installed/runtime details without manufacturing availability", () => {
  const capabilities = { video_analysis: true, audio_transcription: false, media_processing: { ffmpeg: { installed: true }, speech: { runtime: "unavailable", reason: "Model not loaded" } } };
  const base = { status: "ok", database: "ready", queue: "ready", llm: null, browser: null, version: "fixture" };
  assert.deepEqual(mediaCapabilities(healthSchema.parse({ ...base, capabilities })), capabilities);
  assert.deepEqual(mediaCapabilities(healthSchema.parse({ ...base, ...capabilities })), capabilities);
  assert.deepEqual(mediaCapabilities(settingsSchema.parse({ capabilities, retention_days: 30, mode: "live", queue: "ready", llm: null, browser: null })), capabilities);
  assert.equal(mediaCapabilities(healthSchema.parse(base)).video_analysis, undefined);
  assert.equal(mediaCapabilities(undefined).audio_transcription, undefined);
});

test("upload validation accepts supported extensions case-insensitively up to exactly 64 MiB", () => {
  for (const extension of MEDIA_ACCEPT.split(",")) {
    assert.equal(mediaFileError({ name: `fixture${extension.toUpperCase()}`, size: MAX_MEDIA_BYTES }), null);
  }
  assert.equal(mediaFileError(null), "mediaFileRequired");
  assert.equal(mediaFileError({ name: "empty.mp4", size: 0 }), "mediaFileEmpty");
  assert.equal(mediaFileError({ name: "large.mp4", size: MAX_MEDIA_BYTES + 1 }), "mediaFileTooLarge");
  assert.equal(mediaFileError({ name: "fake.mp4.exe", size: 1 }), "mediaFileType");
});

test("multipart fields preserve user mode/locale and optional original reference", () => {
  const file = new File(["fixture"], "fixture.mp4", { type: "video/mp4" });
  for (const mode of ["live", "demo"] as const) for (const locale of ["ru", "kk", "en"] as const) {
    const upload = mediaUpload(file, mode, locale);
    assert.equal(upload.method, "POST");
    const body = upload.body as FormData;
    assert.equal(body.get("file"), file);
    assert.equal(body.get("mode"), mode);
    assert.equal(body.get("locale"), locale);
    assert.equal(body.has("source_url"), false);
  }
  assert.equal((mediaUpload(file, "live", "ru", " https://example.org/post ").body as FormData).get("source_url"), "https://example.org/post");
});

test("uploaded references are never labelled independently collected", () => {
  for (const origin of ["user_upload", "user_uploaded_media", "media_upload", "uploaded_media", "synthetic_media"]) {
    const uploaded = { platform: "instagram", metadata: { origin } } as Pick<Scan, "platform" | "metadata">;
    assert.equal(isUploadedMedia(uploaded), true);
    assert.equal(isPublicTextScan({ ...uploaded, mode: "live", status: "completed", url: "https://example.org/post" }), false);
  }
  assert.equal(isUploadedMedia({ platform: "instagram", metadata: { origin: "public_url", media } }), false);
});

test("time formatting preserves zero, fractions and missing bounds", () => {
  assert.equal(mediaRange(0, 2.5), "00:00–00:02.5");
  assert.equal(mediaRange(0), "00:00");
  assert.equal(mediaRange(null, 0), "00:00");
  assert.equal(mediaRange(undefined, undefined), null);
  assert.equal(mediaTime(null), "—");
  assert.equal(mediaTime(3661), "1:01:01");
  assert.equal(frameThumbnail("fixture/id", 0), "/api/v1/scans/fixture%2Fid/frames/0");
});

test("rendered media clearly separates sampled coverage, transcript, model observations and limitations in every locale", () => {
  for (const locale of ["ru", "kk", "en"] as Locale[]) {
    const t = translator(locale);
    const html = renderToStaticMarkup(createElement(MediaDetails, { media, scanId: "fixture", t, canViewFrames: true }));
    for (const content of [t("mediaPartial"), t("mediaLimits"), t("mediaTruncated"), t("mediaSampled"), t("mediaObservations"), t("mediaObservationsNotice"), "fixture-speech-model", "fixture-vision-model", "Fixture sampling limitation", "00:00–02:00", "00:00–00:02.5", "/api/v1/scans/fixture/frames/0"]) {
      assert.ok(html.includes(content), `${locale}: ${content}`);
    }
    assert.ok(!html.includes("evidence-list"));
    assert.ok(!html.includes(t("publicTextCoverage")));
  }
});

test("unavailable media and missing transcript/frames remain explicit", () => {
  const t = translator("en");
  const html = renderToStaticMarkup(createElement(MediaDetails, { media: { ...media, status: "unavailable", reason: "Decoder unavailable", duration_seconds: null, analyzed_seconds: 0, frames: [], transcript: [] }, scanId: "fixture", t }));
  for (const content of [t("mediaUnavailable"), t("mediaNoTranscript"), t("mediaNoFrames"), "Decoder unavailable"]) assert.ok(html.includes(content));
  const audio = renderToStaticMarkup(createElement(MediaDetails, { media: { ...media, status: "completed", has_video: false, frames: [] }, scanId: "fixture", t }));
  assert.ok(audio.includes(t("mediaAudioCaution")));
  assert.ok(!audio.includes(t("mediaNoFrames")));
});

test("runtime display follows actual flags and shows unknown when health has not arrived", () => {
  const t = translator("en");
  const unknown = renderToStaticMarkup(createElement(MediaCapabilities, { capabilities: mediaCapabilities(undefined), t }));
  assert.ok(unknown.includes(t("capabilityUnknown")));
  assert.ok(!unknown.includes(t("enabled")));
  const html = renderToStaticMarkup(createElement(MediaCapabilities, { capabilities: { video_analysis: true, audio_transcription: false, media_processing: { runtime: "unavailable" } }, t }));
  for (const content of [t("enabled"), t("disabled"), t("unavailable")]) assert.ok(html.includes(content));
});

test("all media UI and processing stages have RU, KK and EN translations", () => {
  for (const [key, translations] of Object.entries(mediaCopy)) {
    assert.equal(translations.length, 3, key);
    assert.ok(translations.every((value) => value.length > 0), key);
  }
});

test("sparse early media failures still render on failed unscored scans", () => {
  const failure = { status: "unavailable", reason: "Download unavailable", transcript: [], frames: [], audio: { status: "unavailable", reason: "Download unavailable" }, visual: { status: "unavailable", reason: "Download unavailable" }, limitations: ["Download unavailable"] };
  const failed = scanSchema.parse({ ...scan, status: "failed", error: "Download unavailable", analysis: null, score: null, metadata: { origin: "uploaded_media", media: failure } });
  const html = renderToStaticMarkup(createElement(Providers, { children: createElement(ScanContent, { scan: failed }) }));
  const t = translator("ru");
  assert.ok(html.includes(t("mediaUnavailable")));
  assert.ok(html.includes(t("mediaCoverage")));
  assert.ok(html.includes(t("uploadedMediaNotice")));
  assert.ok(html.includes("Download unavailable"));
  assert.ok(!html.includes(t("trackAbsent")));
  assert.ok(!html.includes("score-orbit"));
});

test("score, summary and main evidence precede media coverage and collapsed frames", () => {
  const scored = scanSchema.parse({ ...scan, score: 80, level: "high", category: "pyramid", analysis: {
    score: 80, level: "high", category: "pyramid", summary: "Primary result summary", method: "rules_media", language: "ru",
    evidence: [{ code: "fixture", label: "Primary signal", quote: "Primary evidence quotation", weight: 80, source_url: "", modality: "speech", start_seconds: 0, end_seconds: 2 }],
    recommendations: [], limitations: [],
  } });
  const html = renderToStaticMarkup(createElement(Providers, { children: createElement(ScanContent, { scan: scored }) }));
  const coverageAt = html.indexOf('class="media-details"');
  assert.ok(coverageAt > 0);
  for (const content of ["<strong>80</strong>", "Primary result summary", "Primary evidence quotation"]) {
    assert.ok(html.indexOf(content) >= 0 && html.indexOf(content) < coverageAt, content);
  }
  assert.match(html, /<details class="media-frames-disclosure"><summary>/);
});

test("six frames start collapsed, with scene model status separate from recognized OCR", () => {
  const sixFrames = { ...media, frames: Array.from({ length: 6 }, (_, i) => ({ ...media.frames[0], at: i * 20, text: `Recognized fixture text ${i}`, visual_status: "unavailable", ocr_confidence: 0.87 })) };
  for (const locale of ["ru", "kk", "en"] as const) {
    const t = translator(locale);
    const html = renderToStaticMarkup(createElement(MediaDetails, { media: sixFrames, scanId: "fixture", t, canViewFrames: true }));
    const disclosure = html.match(/<details class="media-frames-disclosure">([\s\S]*?)<\/details>/)?.[1];
    assert.ok(disclosure);
    assert.ok(disclosure.includes(`<summary>${t("mediaFrames")} <span class="count-label">6</span></summary>`));
    assert.equal(disclosure.split(`${t("mediaSceneAnalysis")}: ${t("unavailable")}`).length - 1, 6);
    assert.ok(disclosure.includes("Recognized fixture text 5"));
    assert.ok(disclosure.includes("87%"));
    assert.ok(disclosure.includes("/api/v1/scans/fixture/frames/5"));
  }
});

test("scene model timeout does not imply transcription or OCR stopped", () => {
  const partial = { ...media, visual: { ...media.visual, reason: "vision_timeout" }, limitations: ["vision_timeout"] };
  for (const locale of ["ru", "kk", "en"] as const) {
    const t = translator(locale);
    const html = renderToStaticMarkup(createElement(MediaDetails, { media: partial, scanId: "fixture", t }));
    assert.equal(mediaMessage("vision_timeout", t), t("mediaVisionTimeout"));
    assert.ok(html.includes(t("mediaVisionTimeout")));
    assert.ok(!html.includes(t("mediaTimeLimit")));
    assert.ok(html.includes("Fictional transcript"));
    assert.ok(html.includes("Fictional frame text"));
  }
  assert.equal(mediaMessage("vision_timeout", translator("ru")), "Модель описания сцен не уложилась в лимит; речь и OCR см. отдельно.");
});

test("protected thumbnails require analyst access and ignore external thumbnail URLs", () => {
  const t = translator("en");
  const unauthenticated = renderToStaticMarkup(createElement(MediaDetails, { media, scanId: "fixture", t, canViewFrames: false }));
  assert.ok(unauthenticated.includes(t("mediaPreviewLogin")));
  assert.ok(!unauthenticated.includes("<img"));
  const otherOrigin = { ...media, frames: [{ ...media.frames[0], thumbnail_url: "https://external.example/pixel" }] };
  const authenticated = renderToStaticMarkup(createElement(MediaDetails, { media: otherOrigin, scanId: "fixture", t, canViewFrames: true }));
  assert.ok(authenticated.includes("/api/v1/scans/fixture/frames/0"));
  assert.ok(!authenticated.includes("external.example"));
});

test("all 60 media evidence windows retain modality/time and do not become additional score rows", () => {
  const evidence = { code: "fixture", label: "Fixture indicator", quote: "Fictional match", weight: 8, source_url: "https://example.org/post", modality: "speech", start_seconds: 0, end_seconds: 2 };
  const result = analysisSchema.parse({ score: 8, level: "low", category: "pyramid", summary: "Fixture", evidence: [evidence], media_evidence: Array.from({ length: 60 }, (_, index) => ({ ...evidence, quote: `Window ${index}` })), recommendations: [], method: "rules_media", limitations: [], language: "en" });
  assert.equal(result.media_evidence?.length, 60);
  assert.equal(result.evidence.length, 1);
  for (const locale of ["ru", "kk", "en"] as const) {
    const t = translator(locale);
    const html = renderToStaticMarkup(createElement(MediaEvidence, { evidence: result.media_evidence!, t }));
    assert.ok(html.includes(t("mediaEvidenceNotice")));
    assert.ok(html.includes("Window 59"));
    assert.ok(html.includes("00:00–00:02"));
    assert.ok(html.includes(t("speech")));
    assert.ok(!html.includes(`8 ${t("points")}`));
  }
});

test("waiting worker progress and unprobed runtime are translated in all locales", () => {
  for (const locale of ["ru", "kk", "en"] as const) {
    const t = translator(locale);
    assert.notEqual(t("waiting_media"), "waiting_media");
    const html = renderToStaticMarkup(createElement(MediaCapabilities, { capabilities: { video_analysis: true, audio_transcription: false, media_processing: { visual_model_status: "configured_not_probed" } }, t }));
    assert.ok(html.includes(t("configured_not_probed")));
  }
});

test("OCR confidence is a 0..1 fraction rendered as a percentage, including zero", () => {
  for (const confidence of [0, 0.87, 1]) {
    const parsed = mediaSchema.parse({ ...media, frames: [{ ...media.frames[0], ocr_confidence: confidence }] });
    const html = renderToStaticMarkup(createElement(MediaDetails, { media: parsed, scanId: "fixture", t: translator("ru") }));
    assert.ok(html.includes(`${Math.round(confidence * 100)}%`));
  }
  assert.equal(mediaSchema.safeParse({ ...media, frames: [{ ...media.frames[0], ocr_confidence: 87 }] }).success, false);
});

test("worker limitation/reason codes have friendly copy while JSON retains the original values", () => {
  const codes = Object.keys(mediaReasonKeys);
  const parsed = mediaSchema.parse({ ...media, reason: "worker_time_budget_exceeded", limitations: codes, audio: { status: "unavailable", reason: "whisper_model_missing" }, visual: { status: "partial", reason: "ocr_timeout" } });
  for (const locale of ["ru", "kk", "en"] as const) {
    const t = translator(locale);
    for (const code of codes) assert.notEqual(mediaMessage(code, t), code);
    assert.equal(mediaMessage("future_worker_failure", t), t("mediaOtherLimitation"));
    assert.equal(mediaMessage("An already readable explanation.", t), "An already readable explanation.");
    const html = renderToStaticMarkup(createElement(MediaDetails, { media: parsed, scanId: "fixture", t }));
    assert.ok(html.includes(t("mediaSixFrames")));
    assert.ok(html.includes(t("mediaObservationsNotice")));
    for (const code of codes) assert.ok(!html.includes(code), code);
  }
  assert.deepEqual(parsed.limitations, codes);
  assert.equal(parsed.audio.reason, "whisper_model_missing");
});


test("photo uploads accept JPEG PNG WebP but reject SVG and GIF", () => {
  for (const name of ["photo.JPG", "photo.jpeg", "screen.png", "photo.webp"]) {
    assert.equal(mediaFileError({ name, size: 100 }), null);
  }
  for (const name of ["photo.svg", "photo.gif", "photo.png.exe"]) {
    assert.equal(mediaFileError({ name, size: 100 }), "mediaFileType");
  }
});

test("still image coverage never renders fake duration, audio or video timeline", () => {
  const photo = mediaSchema.parse({ ...media, has_image: true, has_video: false, has_audio: false,
    duration_seconds: null, analyzed_seconds: 0, truncated: false, transcript: [] });
  for (const locale of ["ru", "kk", "en"] as const) {
    const t = translator(locale);
    const html = renderToStaticMarkup(createElement(MediaDetails, { media: photo, scanId: "image-fixture", t }));
    assert.ok(html.includes(t("mediaImage")));
    assert.ok(html.includes(t("mediaImageCaution")));
    assert.ok(!html.includes(t("mediaDuration")));
    assert.ok(!html.includes(t("mediaAudio")));
    assert.ok(!html.includes(t("mediaSampled")));
    assert.ok(!html.includes("00:00"));
    assert.ok(!html.includes(t("mediaImageCompleted"))); // Partial remains partial.
  }
});
