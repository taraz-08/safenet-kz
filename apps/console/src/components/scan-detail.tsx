"use client";
import { useState, type FormEvent } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { Download, FileText, MessageSquare, ShieldCheck, LoaderCircle, CircleAlert } from "lucide-react";
import { api, json } from "@/lib/api";
import { dateTime, statusText, categoryText, mediaMessage } from "@/lib/i18n";
import { downloadText, isPublicTextScan, reportSchema, scanSchema, type Scan } from "@/lib/schema";
import { useAction, useWorkspace } from "./providers";
import { Badge, Button, ErrorState, ExternalLink, Loading, Modal, StatusBadge } from "./ui";
import { hasNoPublicTextIndicators, ScanRiskBadge, visualReviewState } from "./scan-risk";
import { isUploadedMedia, mediaRange } from "@/lib/media";
import { MediaDetails, MediaEvidence } from "./media-details";

export function useScan(id: string | null) { return useQuery({ queryKey: ["scan", id], queryFn: ({ signal }) => api(`/scans/${encodeURIComponent(id!)}`, scanSchema, { signal }), enabled: !!id, refetchInterval: (query) => ["queued", "running"].includes(query.state.data?.status || "queued") ? 2000 : 10000 }); }

function ReviewForm({ scan }: { scan: Scan }) {
  const { t, canManage } = useWorkspace();
  const [decision, setDecision] = useState(String(scan.review?.decision || "needs_context"));
  const [note, setNote] = useState(String(scan.review?.note || ""));
  const { run, pending } = useAction();
  const submit = (event: FormEvent) => { event.preventDefault(); void run(() => api(`/scans/${scan.id}/review`, scanSchema, json("POST", { decision, note })), t("reviewSaved")); };
  return <form className="review-form" onSubmit={submit}><h3><ShieldCheck size={18} />{t("review")}</h3>
    {scan.review && <p className="review-existing"><Badge tone="low">{statusText(String(scan.review.decision || ""), t)}</Badge></p>}
    <div className="review-fields"><label className="field"><span>{t("decision")}</span><select value={decision} onChange={(e) => setDecision(e.target.value)} disabled={!canManage}>{["needs_context", "confirmed_signals", "false_positive"].map((option) => <option key={option} value={option}>{statusText(option, t)}</option>)}</select></label><label className="field"><span>{t("note")}</span><textarea rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} disabled={!canManage} /></label></div>
    <Button type="submit" variant="primary" busy={pending} disabled={!canManage}>{t("saveReview")}</Button>
  </form>;
}
export function ScanContent({ scan }: { scan: Scan }) {
  const { t, locale, canManage, openScan } = useWorkspace();
  const { run, pending } = useAction();
  const analysis = scan.analysis;
  const media = scan.metadata.media;
  const visualReview = visualReviewState(scan);
  const neutralScore = hasNoPublicTextIndicators(scan) || ((scan.score == null || scan.score === 0) && visualReview != null);
  const uploaded = isUploadedMedia(scan);
  const report = async () => { const result = await run(() => api("/reports", reportSchema, json("POST", { scan_id: scan.id })), t("reportCreated")); if (result) downloadText(result.markdown, `safenet-${result.id}.md`); };
  return <div className="scan-content">
    <div className="scan-meta"><StatusBadge status={scan.status} /><Badge tone={scan.mode === "demo" ? "medium" : "neutral"}>{scan.mode.toUpperCase()}</Badge><span>{dateTime(scan.created_at, locale)}</span><span className="mono">#{scan.id.slice(0, 8)}</span></div>
    <div className="scan-source"><ExternalLink href={scan.url}>{scan.url || t(uploaded ? "uploadedMedia" : "manual")}</ExternalLink></div>
    {uploaded && <p className="notice subtle">{t("uploadedMediaNotice")}</p>}
    {scan.metadata.origin === "legacy_public_capture" && <aside className="historical-notice"><h3>{t("historicalCapture")}</h3><dl><div><dt>{t("capturedAt")}</dt><dd>{dateTime(typeof scan.metadata.captured_at === "string" ? scan.metadata.captured_at : null, locale)}</dd></div><div><dt>{t("importedAt")}</dt><dd>{dateTime(typeof scan.metadata.imported_at === "string" ? scan.metadata.imported_at : null, locale)}</dd></div></dl><p>{t("notFresh")}</p></aside>}
    {scan.metadata.content_scope != null && <p className="content-scope"><strong>{t("contentScope")}: </strong>{typeof scan.metadata.content_scope === "string" ? statusText(scan.metadata.content_scope, t) : JSON.stringify(scan.metadata.content_scope)}</p>}
    {scan.metadata.content_scope === "public_preview_image_ocr_and_visual_observations" && <p className="notice subtle">{t("mediaPreviewOnlyNotice")}</p>}
    {!analysis && visualReview && <div className="visual-review-notice"><ScanRiskBadge scan={scan} /></div>}
    {visualReview && scan.score != null && scan.score > 0 && <p className="notice subtle">{t(visualReview === "required" ? "visualReviewNotice" : "visualCoverageNotice")}</p>}
    {isPublicTextScan(scan) && <p className="notice subtle">{t("publicTextCoverage")}</p>}
    {!media && !uploaded && (!scan.url || scan.platform === "manual") && <p className="notice subtle">{t("manualNotice")}</p>}
    {["queued", "running"].includes(scan.status) && <div className="processing" role="status" aria-live="polite"><LoaderCircle className="spin" size={28} /><div><h3>{t("processing")}</h3><p>{scan.stage ? statusText(scan.stage, t) : t("processingDesc")}</p></div></div>}
    {["blocked", "failed", "cancelled"].includes(scan.status) && <div className="blocked-result"><CircleAlert size={22} /><div><h3>{t(media ? "mediaCheckIncomplete" : "notCollected")}</h3><p>{media || uploaded ? mediaMessage(scan.error || scan.stage, t) : scan.error || scan.stage}</p><Link href="/scanner" onClick={() => openScan(null)}>{t("analyzeText")}</Link></div></div>}
    {analysis && <>
      <div className="analysis-summary"><div className={`score-orbit score-${neutralScore ? "neutral" : scan.level || "low"}`}><strong>{scan.score ?? "—"}</strong><span>/ 100</span></div><div><ScanRiskBadge scan={scan} /><h3>{categoryText(scan.category, t)}</h3><p>{analysis.summary}</p><small>{t("method")}: {statusText(analysis.method, t)}</small></div></div>
      <div className="detail-section"><h3>{t("evidence")} <span className="count-label">{analysis.evidence.length}</span></h3>{analysis.evidence.length ? <ol className="evidence-list">{analysis.evidence.map((evidence, index) => <li key={`${evidence.code}-${index}`}><div className="evidence-heading"><strong>{evidence.label}</strong><Badge tone={evidence.weight > 0 ? "medium" : "low"}>{evidence.weight > 0 ? "+" : ""}{evidence.weight} {t("points")}</Badge></div><blockquote>{evidence.quote}</blockquote><div className="evidence-source"><code>{evidence.code}</code>{evidence.modality && <Badge>{t(evidence.modality)}</Badge>}{mediaRange(evidence.start_seconds, evidence.end_seconds) != null && <span className="mono">{mediaRange(evidence.start_seconds, evidence.end_seconds)}</span>}{evidence.model && <span>{t("mediaModel")}: {evidence.model}</span>}{evidence.source_url && <ExternalLink href={evidence.source_url}>{t("source")}</ExternalLink>}</div></li>)}</ol> : <p className="muted">{t("noEvidence")}</p>}</div>
      {!!analysis.media_evidence?.length && <MediaEvidence evidence={analysis.media_evidence} t={t} />}
      {!!analysis.recommendations.length && <div className="detail-section"><h3>{t("recommendations")}</h3><ul className="recommendations">{analysis.recommendations.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
      {!!analysis.limitations.length && <div className="detail-section"><h3>{t("limitations")}</h3><ul className="limitations">{analysis.limitations.map((item, i) => <li key={i}>{mediaMessage(item, t)}</li>)}</ul></div>}
    </>}
    {media && <MediaDetails media={media} scanId={scan.id} t={t} canViewFrames={canManage} />}
    {scan.text && <details className="original-text"><summary>{t("original")}</summary><pre>{scan.text}</pre></details>}
    <p className="score-disclaimer"><ShieldCheck size={16} />{t("scoreNotice")}</p>
    {scan.status === "completed" && <><div className="detail-actions"><Button onClick={report} busy={pending} disabled={!canManage}><FileText size={16} />{t("createReport")}</Button><Button onClick={() => downloadText(JSON.stringify(scan, null, 2), `safenet-scan-${scan.id}.json`, "application/json;charset=utf-8")}><Download size={16} />{t("downloadJson")}</Button><Link href={`/assistant?scan=${encodeURIComponent(scan.id)}`} className="button button-ghost" onClick={() => openScan(null)}><MessageSquare size={16} />{t("ask")}</Link></div><ReviewForm key={`${scan.id}-${JSON.stringify(scan.review)}`} scan={scan} /></>}
  </div>;
}
export function ScanDetails({ id }: { id: string }) { const query = useScan(id); return query.isPending ? <Loading rows={5} /> : <>{query.isError && <ErrorState error={query.error} retry={() => query.refetch()} stale={!!query.data} />}{query.data && <ScanContent scan={query.data} />}</>; }
export function ScanDialog() {
  const { selectedScan, openScan, t } = useWorkspace();
  return <Modal open={!!selectedScan} onOpenChange={(open) => !open && openScan(null)} title={t("inspect")} description={t("detectionsDesc")} wide>{selectedScan && <ScanDetails id={selectedScan} />}</Modal>;
}
