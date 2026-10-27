"use client";

import { useState } from "react";
import { mediaMessage, statusText, type Translate } from "@/lib/i18n";
import { frameThumbnail, mediaRange, mediaTime, type mediaCapabilities } from "@/lib/media";
import type { Evidence, Media } from "@/lib/schema";
import { Badge, ExternalLink } from "./ui";

export function MediaRuntime({ value, t }: { value: unknown; t: Translate }) {
  if (value == null) return <span>{t("capabilityUnknown")}</span>;
  if (typeof value === "boolean") return <span>{t(value ? "enabled" : "disabled")}</span>;
  if (Array.isArray(value)) return <ul className="media-runtime-list">{value.map((item, i) => <li key={i}><MediaRuntime value={item} t={t} /></li>)}</ul>;
  if (typeof value === "object") return <dl className="media-runtime-list">{Object.entries(value).map(([key, item]) => <div key={key}><dt>{statusText(key, t)}</dt><dd><MediaRuntime value={item} t={t} /></dd></div>)}</dl>;
  return <span>{statusText(String(value), t)}</span>;
}

export function MediaCapabilities({ capabilities, t }: { capabilities: ReturnType<typeof mediaCapabilities>; t: Translate }) {
  return <div className="media-capabilities"><strong>{t("mediaCapabilities")}</strong><dl>{(["video_analysis", "audio_transcription"] as const).map((key) => <div key={key}><dt>{t(key)}</dt><dd><Badge tone="neutral">{t(capabilities[key] == null ? "capabilityUnknown" : capabilities[key] ? "enabled" : "disabled")}</Badge></dd></div>)}</dl>
    {capabilities.media_processing != null && <details><summary>{t("media_processing")}</summary><MediaRuntime value={capabilities.media_processing} t={t} /></details>}
  </div>;
}

function FramePreview({ scanId, index, at, t, image = false }: { scanId: string; index: number; at: number; t: Translate; image?: boolean }) {
  const [failed, setFailed] = useState(false);
  return <div className="media-frame-preview">{failed ? <span>{t("mediaPreviewMissing")}</span> : <img src={frameThumbnail(scanId, index)} width={240} height={135} loading="lazy" decoding="async" alt={image ? t("mediaImage") : `${t("mediaFrame")} ${mediaTime(at)}`} onError={() => setFailed(true)} />}</div>;
}

export function MediaEvidence({ evidence, t }: { evidence: Evidence[]; t: Translate }) {
  return <section className="detail-section"><h3>{t("mediaEvidence")} <span className="count-label">{evidence.length}</span></h3><p className="notice subtle">{t("mediaEvidenceNotice")}</p><ol className="evidence-list media-window-evidence">{evidence.map((item, index) => <li key={`${item.code}-${index}`}><div className="evidence-heading"><strong>{item.label}</strong>{item.modality && <Badge>{t(item.modality)}</Badge>}</div><blockquote>{item.quote}</blockquote><div className="evidence-source"><code>{item.code}</code>{mediaRange(item.start_seconds, item.end_seconds) != null && <span className="mono">{mediaRange(item.start_seconds, item.end_seconds)}</span>}{item.model && <span>{t("mediaModel")}: {item.model}</span>}{item.source_url && <ExternalLink href={item.source_url}>{t("source")}</ExternalLink>}</div></li>)}</ol></section>;
}

export function MediaDetails({ media, scanId, t, canViewFrames = false }: { media: Media; scanId: string; t: Translate; canViewFrames?: boolean }) {
  return <section className="media-details" aria-label={t("mediaCoverage")}>
    <div className="media-heading"><h3>{t("mediaCoverage")}</h3><Badge tone={media.status === "completed" ? "neutral" : "medium"}>{t(media.status === "completed" ? (media.has_image ? "mediaImageCompleted" : "mediaCompleted") : media.status === "partial" ? "mediaPartial" : "mediaUnavailable")}</Badge></div>
    {media.reason && <p className="notice subtle">{mediaMessage(media.reason, t)}</p>}
    <dl className="media-coverage-grid">
      {!media.has_image && <><div><dt>{t("mediaDuration")}</dt><dd className="mono">{mediaTime(media.duration_seconds)}</dd></div>
      <div><dt>{t("mediaAnalyzed")}</dt><dd className="mono">{media.analyzed_seconds != null && media.analyzed_seconds > 0 ? mediaRange(0, media.analyzed_seconds) : mediaTime(media.analyzed_seconds)}</dd></div>
      <div><dt>{t("mediaAudio")}</dt><dd>{t(media.has_audio == null ? "unknown" : media.has_audio ? "trackPresent" : "trackAbsent")}</dd></div>
      </>}<div><dt>{t(media.has_image ? "mediaImage" : "mediaVisual")}</dt><dd>{t(media.has_image ? "trackPresent" : media.has_video == null ? "unknown" : media.has_video ? "trackPresent" : "trackAbsent")}</dd></div>
    </dl>
    <p className="muted media-caution">{t("mediaLimits")}</p>
    {media.truncated && <p className="notice">{t("mediaTruncated")}</p>}
    <p className="notice subtle">{t(media.has_image ? "mediaImageCaution" : media.has_video !== false ? "mediaSampled" : "mediaAudioCaution")}</p>
    <div className="media-processors">{(["audio", "visual"] as const).filter((key) => !media.has_image || key === "visual").map((key) => <div key={key}><h4>{t(key === "audio" ? "audio_transcription" : media.has_image ? "mediaImage" : "video_analysis")}</h4><Badge tone={media[key].status === "completed" ? "neutral" : "medium"}>{mediaMessage(media[key].status, t)}</Badge><p className="muted">{t("mediaModel")}: <span>{media[key].model || t("unknown")}</span></p>{media[key].reason && <p>{mediaMessage(media[key].reason, t)}</p>}</div>)}</div>
    {(media.has_audio || media.transcript.length > 0) && <div className="detail-section"><h3>{t("mediaTranscript")} <span className="count-label">{media.transcript.length}</span></h3>{media.transcript.length ? <ol className="media-transcript">{media.transcript.map((segment, i) => <li key={i}><span className="mono media-timestamp">{mediaRange(segment.start, segment.end)}</span><p>{segment.text}</p></li>)}</ol> : <p className="muted">{t("mediaNoTranscript")}</p>}</div>}
    {(media.has_image || media.has_video || media.frames.length > 0) && <div className="detail-section">{media.frames.length ? <details className="media-frames-disclosure"><summary>{t(media.has_image ? "mediaImage" : "mediaFrames")} <span className="count-label">{media.frames.length}</span></summary><p className="muted media-caution">{t("mediaObservationsNotice")}</p><ol className="media-frames">{media.frames.map((frame, index) => <li key={index}>
      {canViewFrames && frame.thumbnail_url ? <FramePreview key={`${scanId}-${index}-${frame.thumbnail_url}`} scanId={scanId} index={index} at={frame.at} t={t} image={!!media.has_image} /> : <div className="media-frame-preview"><span>{t(canViewFrames ? "mediaPreviewMissing" : "mediaPreviewLogin")}</span></div>}
      <div className="media-frame-content"><div className="media-heading"><strong>{t(media.has_image ? "mediaImage" : "mediaFrame")} {index + 1}{!media.has_image && <> · <span className="mono">{mediaTime(frame.at)}</span></>}</strong><Badge>{t("mediaSceneAnalysis")}: {mediaMessage(frame.visual_status, t)}</Badge></div>
        <h4>{t("mediaFrameText")}</h4><p className="media-frame-text">{frame.text || t("mediaNoFrameText")}</p>
        {frame.ocr_confidence != null && <small className="muted">{t("mediaOcrConfidence")}: {Math.round(frame.ocr_confidence * 100)}%</small>}
        {!!frame.observations.length && <aside className="media-observations"><h4>{t("mediaObservations")}</h4><ul>{frame.observations.map((observation, i) => <li key={i}>{observation}</li>)}</ul></aside>}
      </div>
    </li>)}</ol></details> : <><h3>{t(media.has_image ? "mediaImage" : "mediaFrames")} <span className="count-label">0</span></h3><p className="muted">{t("mediaNoFrames")}</p></>}</div>}
    {!!media.limitations.length && <div className="detail-section"><h3>{t("limitations")}</h3><ul className="limitations">{media.limitations.map((limitation, i) => <li key={i}>{mediaMessage(limitation, t)}</li>)}</ul></div>}
  </section>;
}
