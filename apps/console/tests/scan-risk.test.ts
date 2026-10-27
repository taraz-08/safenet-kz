import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Providers } from "../src/components/providers";
import { ScanContent } from "../src/components/scan-detail";
import { ScanTable } from "../src/components/scan-table";
import { translator } from "../src/lib/i18n";
import { scanSchema, type Scan } from "../src/lib/schema";
import { visualReviewState } from "../src/components/scan-risk";

// Authored profile fixture: only the public biography was collected, no media.
const profile = scanSchema.parse({
  id: "text-only-profile", url: "https://www.instagram.com/fixture_profile/", title: "Fixture profile",
  platform: "instagram", mode: "live", status: "completed", stage: "completed",
  created_at: "2026-10-27T00:00:00Z", completed_at: "2026-10-27T00:00:01Z",
  score: 0, level: "low", category: "unknown", text: "Public biography", error: null, review: null, agent_id: null,
  metadata: { origin: "public_url", collector: "public_http", content_scope: "public_instagram_profile_metadata" },
  analysis: {
    score: 0, level: "low", category: "unknown", summary: "No text indicators matched.", method: "rules", language: "ru",
    evidence: [], recommendations: [], limitations: [],
  },
});

function render(element: ReactElement) {
  return renderToStaticMarkup(createElement(Providers, { children: element }));
}
function renderBoth(scan: Scan) {
  return [render(createElement(ScanTable, { scans: [scan] })), render(createElement(ScanContent, { scan }))];
}

test("zero-score public biography renders a neutral result with visible scope in the row and detail", () => {
  const before = JSON.stringify(profile);
  const [row, detail] = renderBoth(profile);
  for (const html of [row, detail]) {
    assert.match(html, /class="badge badge-neutral text-only-result"/);
    assert.match(html, /Нет признаков в тексте/);
    assert.doesNotMatch(html, /badge-low|score-low|>Низкий</);
  }
  assert.match(row, /<strong class="tabular-nums">0<\/strong>/);
  assert.ok(row.includes(translator("ru")("publicTextOnlyShort")));
  assert.ok(row.includes(`title="${translator("ru")("publicTextCoverage")}"`));
  assert.match(detail, /class="score-orbit score-neutral"><strong>0<\/strong><span>\/ 100<\/span>/);
  assert.ok(detail.includes(translator("ru")("public_instagram_profile_metadata")));
  assert.ok(detail.includes(translator("ru")("publicTextCoverage")));
  assert.equal(JSON.stringify(profile), before, "presentation must not rewrite score, category or analysis");
});

test("unclassified and nullable categories share the same limited text-only presentation", () => {
  for (const category of [null, "", "unclassified", "unknown"]) {
    for (const html of renderBoth({ ...profile, category })) {
      assert.match(html, /Нет признаков в тексте/);
    }
  }
});

test("nonzero low warnings and identified categories retain their original risk treatment", () => {
  for (const update of [
    { score: 10, level: "low", category: "unknown" },
    { score: 0, level: "low", category: "casino" },
    { score: 70, level: "high", category: "casino" },
  ]) {
    const scan = { ...profile, ...update, analysis: { ...profile.analysis!, ...update } };
    const [row, detail] = renderBoth(scan);
    for (const html of [row, detail]) {
      assert.match(html, new RegExp(`class="badge badge-${update.level}"`));
      assert.doesNotMatch(html, /Нет признаков в тексте|text-only-result/);
    }
    assert.ok(row.includes(`<strong class="tabular-nums">${update.score}</strong>`));
    assert.ok(detail.includes(`class="score-orbit score-${update.level}"><strong>${update.score}</strong>`));
  }
});

test("demo, manual, historical, unknown-scope and media scans never acquire a text-only assertion", () => {
  const media = {
    status: "completed" as const, analyzed_seconds: 2, has_video: true, has_audio: true,
    audio: { status: "completed" }, visual: { status: "completed" },
    frames: [], transcript: [], limitations: [],
  };
  const updates: Partial<Scan>[] = [
    { mode: "demo" },
    { platform: "manual", url: "" },
    { metadata: { ...profile.metadata, origin: "legacy_public_capture" } },
    { metadata: { ...profile.metadata, content_scope: "unknown" } },
    { metadata: { ...profile.metadata, media } },
  ];
  for (const update of updates) {
    for (const html of renderBoth({ ...profile, ...update })) {
      assert.doesNotMatch(html, /Нет признаков в тексте|text-only-result/);
      assert.ok(!html.includes(translator("ru")("publicTextOnlyShort")));
      assert.ok(!html.includes(translator("ru")("publicTextCoverage")));
    }
  }
});

test("unfinished and failed unscored scans are not presented as zero text findings", () => {
  for (const status of ["queued", "running", "blocked", "failed", "cancelled"] as const) {
    for (const html of renderBoth({ ...profile, status, score: null, level: null, category: null, analysis: null })) {
      assert.doesNotMatch(html, /Нет признаков в тексте|text-only-result|score-orbit/);
      assert.ok(!html.includes(translator("ru")("publicTextOnlyShort")));
    }
  }
});

test("text-only result and scope have explicit Russian, Kazakh and English copy", () => {
  const expected = {
    ru: ["Нет признаков в тексте", "Только текст · видео и звук не проверены"],
    kk: ["Мәтінде белгілер табылмады", "Тек мәтін · бейне мен дыбыс тексерілмеген"],
    en: ["No indicators in text", "Text only · video and audio not checked"],
  };
  for (const locale of ["ru", "kk", "en"] as const) {
    assert.equal(translator(locale)("noPublicTextIndicators"), expected[locale][0]);
    assert.equal(translator(locale)("publicTextOnlyShort"), expected[locale][1]);
  }
});

function visualScan(observations: string[], score: number | null = 0): Scan {
  return scanSchema.parse({ ...profile, score, level: score ? "high" : score === 0 ? "low" : null,
    category: score ? "casino" : "unknown",
    analysis: score == null ? null : { ...profile.analysis, score, level: score ? "high" : "low" },
    metadata: { origin: "uploaded_media", media: {
      status: "completed", has_image: true, has_video: false, has_audio: false,
      audio: { status: "not_present" }, visual: { status: "completed" }, transcript: [], limitations: [],
      frames: [{ at: 0, text: "", observations, visual_status: "completed" }],
    } },
  });
}

test("textless visual descriptions are neutral review candidates even for benign circles", () => {
  for (const observation of ["Slot machine reels", "A green circle"]) {
    const scan = visualScan([observation]);
    const before = JSON.stringify(scan);
    assert.equal(visualReviewState(scan), "required");
    for (const html of renderBoth(scan)) {
      assert.match(html, /badge-neutral visual-review-result/);
      assert.match(html, /Нужна проверка кадров/);
      assert.doesNotMatch(html, /badge-low|>Низкий</);
      assert.match(html, /не добавляют баллы риска/);
    }
    const detail = render(createElement(ScanContent, { scan }));
    assert.match(detail, /class="score-orbit score-neutral"/);
    assert.doesNotMatch(detail, /score-orbit score-low|<style>/);
    assert.equal(JSON.stringify(scan), before);
  }
});

test("OCR-only successful media exposes limited visual coverage rather than a green zero", () => {
  for (const html of renderBoth(visualScan([]))) {
    assert.match(html, /Проверка изображения ограничена/);
    assert.match(html, /Визуальное содержание проверено не полностью/);
    assert.doesNotMatch(html, /badge-low|>Низкий</);
  }
});

test("unscored visual observations render a review notice in the list", () => {
  for (const html of renderBoth(visualScan(["A circle"], null))) {
    assert.match(html, /Нужна проверка кадров/);
    assert.doesNotMatch(html, /badge-low|>Низкий</);
  }
});

test("unavailable Instagram media never renders a green zero", () => {
  const scan = visualScan([]);
  scan.platform = "instagram";
  scan.metadata.media!.status = "unavailable";
  scan.metadata.media!.frames = [];
  scan.metadata.media!.has_image = false;
  scan.metadata.media!.has_video = false;
  for (const html of renderBoth(scan)) {
    assert.match(html, /Проверка изображения ограничена/);
    assert.doesNotMatch(html, /badge-low|>Низкий</);
  }
});

test("visual observations never replace a nonzero rule score or its risk badge", () => {
  for (const html of renderBoth(visualScan(["A circle"], 75))) {
    assert.match(html, /badge-high/);
    assert.doesNotMatch(html, /visual-review-result/);
  }
});

test("visual review and limited coverage have RU KK EN translations", () => {
  const copy = {
    ru: ["Нужна проверка кадров", "Проверка изображения ограничена"],
    kk: ["Кадрларды тексеру қажет", "Суретті тексеру шектеулі"],
    en: ["Frames need review", "Visual coverage limited"],
  };
  for (const locale of ["ru", "kk", "en"] as const) {
    assert.equal(translator(locale)("visualReviewRequired"), copy[locale][0]);
    assert.equal(translator(locale)("visualCoverageLimited"), copy[locale][1]);
  }
});

test("image scope labels are translated and only public previews show the no-video notice", () => {
  for (const scope of ["uploaded_image_ocr_and_visual_observations", "public_preview_image_ocr_and_visual_observations"] as const) {
    const scan = visualScan(["A grid of game interfaces"]);
    scan.metadata.content_scope = scope;
    const html = render(createElement(ScanContent, { scan }));
    assert.ok(html.includes(translator("ru")(scope)));
    assert.equal(html.includes(translator("ru")("mediaPreviewOnlyNotice")), scope.startsWith("public_preview"));
    for (const locale of ["ru", "kk", "en"] as const) {
      assert.notEqual(translator(locale)(scope), scope);
      assert.ok(translator(locale)("mediaPreviewOnlyNotice").length > 30);
    }
  }
});
