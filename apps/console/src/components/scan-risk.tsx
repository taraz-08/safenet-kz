"use client";

import { isPublicTextScan, type Scan } from "@/lib/schema";
import { useWorkspace } from "./providers";
import { Badge, RiskBadge } from "./ui";

export function hasNoPublicTextIndicators(scan: Scan): boolean {
  return scan.score === 0
    && (scan.category == null || ["", "unknown", "unclassified"].includes(scan.category))
    && isPublicTextScan(scan);
}

export function visualReviewState(scan: Scan): "required" | "coverage_limited" | null {
  // Historical results need the same honest presentation before being reprocessed.
  const media = scan.metadata.media;
  if (!media || ["queued", "running"].includes(scan.status)) return null;
  const hasObservations = media.frames.some(frame => frame.observations.some(value => value.trim()));
  if (scan.analysis?.visual_review_required || hasObservations) return "required";
  if (scan.analysis?.visual_review) return scan.analysis.visual_review.status;
  return media.has_image || media.has_video || media.frames.length || (media.status === "unavailable" && ["instagram", "tiktok"].includes(scan.platform)) ? "coverage_limited" : null;
}

export function ScanRiskBadge({ scan, showScore = false }: { scan: Scan; showScore?: boolean }) {
  const { t } = useWorkspace();
  const visual = visualReviewState(scan);
  if (visual && (scan.score == null || scan.score === 0)) return <>
    <Badge tone="neutral" className="visual-review-result">{t(visual === "required" ? "visualReviewRequired" : "visualCoverageLimited")}</Badge>
    <span className="table-pattern">{t(visual === "required" ? "visualReviewNotice" : "visualCoverageNotice")}</span>
  </>;
  if (!hasNoPublicTextIndicators(scan)) return <RiskBadge level={scan.level} score={showScore ? scan.score : undefined} />;
  return <Badge tone="neutral" className="text-only-result">
    {showScore && <strong className="tabular-nums">{scan.score}</strong>}
    {t("noPublicTextIndicators")}
  </Badge>;
}
