import { z } from "zod";

export const locales = ["ru", "kk", "en"] as const;
export type Locale = (typeof locales)[number];
export type Mode = "live" | "demo";
export const levels = ["low", "medium", "high", "critical"] as const;
export const agentIds = ["tiktok", "instagram", "youtube", "threads", "telegram"] as const;
export type AgentId = (typeof agentIds)[number];
export const evidenceSchema = z.object({
  code: z.string(), label: z.string(), quote: z.string(), weight: z.number(), source_url: z.string(),
  modality: z.enum(["speech", "frame_text", "page_text"]).nullish(),
  start_seconds: z.number().nonnegative().nullish(), end_seconds: z.number().nonnegative().nullish(),
  model: z.string().nullish(),
}).passthrough();
export type Evidence = z.infer<typeof evidenceSchema>;
const mediaProcessorSchema = z.object({ status: z.string(), reason: z.string().nullish(), model: z.string().nullish() }).passthrough();
export const mediaSchema = z.object({
  status: z.enum(["completed", "partial", "unavailable"]), reason: z.string().nullish(),
  // Early download/decoder failures may have no duration or detected track data.
  duration_seconds: z.number().nonnegative().nullish(), analyzed_seconds: z.number().nonnegative().nullish(),
  truncated: z.boolean().nullish(), has_audio: z.boolean().nullish(), has_video: z.boolean().nullish(), has_image: z.boolean().nullish(),
  audio: mediaProcessorSchema, visual: mediaProcessorSchema,
  transcript: z.array(z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string() }).passthrough()),
  frames: z.array(z.object({
    at: z.number().nonnegative(), text: z.string(), observations: z.array(z.string()), visual_status: z.string(),
    thumbnail_url: z.string().nullish(), ocr_confidence: z.number().min(0).max(1).nullish(),
  }).passthrough()),
  limitations: z.array(z.string()),
}).passthrough();
export type Media = z.infer<typeof mediaSchema>;
export const analysisSchema = z.object({
  score: z.number(), level: z.string(), category: z.string(), summary: z.string(),
  evidence: z.array(evidenceSchema), recommendations: z.array(z.string()), method: z.string(),
  media_evidence: z.array(evidenceSchema).optional(),
  visual_review_required: z.boolean().optional(),
  visual_review: z.object({
    status: z.enum(["required", "coverage_limited"]), reason: z.string(), notice: z.string(),
    frames: z.array(z.object({ frame_index: z.number().int().nonnegative(), at: z.number().nonnegative(), observations: z.array(z.string()) })),
  }).optional(),
  limitations: z.array(z.string()), language: z.string(),
}).passthrough();
export const scanSchema = z.object({
  id: z.string(), url: z.string(), title: z.string(), platform: z.string(), mode: z.enum(["live", "demo"]),
  status: z.enum(["queued", "running", "completed", "blocked", "failed", "cancelled"]), stage: z.string(),
  created_at: z.string(), completed_at: z.string().nullable(), score: z.number().nullable(),
  level: z.string().nullable(), category: z.string().nullable(), text: z.string(),
  analysis: analysisSchema.nullable(), error: z.string().nullable(),
  review: z.record(z.string(), z.unknown()).nullable(), agent_id: z.string().nullable(),
  metadata: z.object({ media: mediaSchema.nullish() }).passthrough(),
});
export const agentSchema = z.object({
  id: z.string(), name: z.string(), platform: z.string(), enabled: z.boolean(),
  status: z.enum(["idle", "queued", "running", "blocked", "failed", "stopped"]), stage: z.string(), last_error: z.string().nullable(),
  last_run_at: z.string().nullable(), next_run_at: z.string().nullable(), seeds: z.array(z.string()),
  interval_seconds: z.number(), checked: z.number(), flagged: z.number(),
});
export const overviewSchema = z.object({
  mode: z.enum(["live", "demo"]),
  totals: z.object({ scanned: z.number(), suspicious: z.number(), critical: z.number(), active_agents: z.number() }),
  distribution: z.array(z.object({ level: z.string(), count: z.number() })),
  timeline: z.array(z.object({ date: z.string(), count: z.number(), suspicious: z.number() })),
  recent: z.array(scanSchema), agents: z.array(agentSchema),
});
export const sessionSchema = z.object({ authenticated: z.boolean(), login_enabled: z.boolean() });
// Known media flags are typed; runtime-specific capability keys remain open.
const mediaCapabilityFields = {
  video_analysis: z.boolean().optional(), audio_transcription: z.boolean().optional(),
  media_processing: z.record(z.string(), z.unknown()).optional(),
};
export const capabilitiesSchema = z.object(mediaCapabilityFields).passthrough();
export const healthSchema = z.object({ status: z.string(), database: z.unknown(), queue: z.unknown(), llm: z.unknown(), browser: z.unknown(), version: z.string(), capabilities: capabilitiesSchema.optional(), ...mediaCapabilityFields });
export const settingsSchema = z.object({ capabilities: capabilitiesSchema, retention_days: z.number(), mode: z.string(), queue: z.unknown(), llm: z.unknown(), browser: z.unknown(), ...mediaCapabilityFields });
export const reportSchema = z.object({ id: z.string(), scan_id: z.string(), created_at: z.string(), title: z.string(), markdown: z.string() });
export const logsSchema = z.object({ items: z.array(z.object({ id: z.union([z.string(), z.number()]), at: z.string(), stage: z.string(), message: z.string(), task_id: z.string().nullable() })) });
export const assistantSchema = z.object({ answer: z.string(), provider: z.string(), citations: z.array(z.string()), status: z.string() });
export type Scan = z.infer<typeof scanSchema>;
export type Agent = z.infer<typeof agentSchema>;
export type Overview = z.infer<typeof overviewSchema>;
export type Report = z.infer<typeof reportSchema>;
export type Analysis = z.infer<typeof analysisSchema>;

const publicTextScopes = new Set([
  "public_page_text_and_metadata", "official_public_snippet", "available page text only",
  "public_instagram_profile_metadata", "public_youtube_video_metadata", "public_youtube_channel_metadata",
  "public_instagram_page_metadata", "public_youtube_page_metadata",
  "public_telegram_post", "public_telegram_channel_posts", "public_telegram_profile_description",
  "public_threads_post", "public_threads_profile_metadata", "public_threads_profile_posts",
]);
export function isPublicTextScan(scan: Pick<Scan, "status" | "mode" | "url" | "platform" | "metadata">): boolean {
  const { origin, content_scope, collector, media } = scan.metadata;
  // Actual per-scan coverage takes precedence over collector/global capabilities.
  if (media != null) return false;
  if (scan.status !== "completed" || scan.mode !== "live" || !scan.url || scan.platform === "manual") return false;
  // Historical imports may include OCR; only describe known current URL collectors.
  if (origin != null && origin !== "public_url") return false;
  // An explicit unknown scope must not inherit a text-only claim from a collector.
  if (content_scope != null) return typeof content_scope === "string" && publicTextScopes.has(content_scope);
  return collector === "public_http" || collector === "youtube_data_api";
}

export function safeHref(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; }
}
export function sourceLabel(scan: Scan): string {
  if (!scan.url || scan.platform === "manual") return scan.title || "—";
  try { return new URL(scan.url).hostname; } catch { return scan.title || scan.url; }
}
export function downloadText(content: string, filename: string, type = "text/markdown;charset=utf-8") {
  const href = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a"); link.href = href; link.download = filename;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(href), 1000);
}
