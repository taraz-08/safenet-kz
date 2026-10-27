"use client";
import { ArrowUpRight, FileSearch } from "lucide-react";
import { dateTime, categoryText } from "@/lib/i18n";
import { isPublicTextScan, sourceLabel, type Scan } from "@/lib/schema";
import { useWorkspace } from "./providers";
import { EmptyState, PlatformIcon, StatusBadge } from "./ui";
import { ScanRiskBadge } from "./scan-risk";

export function ScanTable({ scans, emptyAction }: { scans: Scan[]; emptyAction?: React.ReactNode }) {
  const { t, locale, openScan } = useWorkspace();
  if (!scans.length) return <EmptyState description={t("noScansDesc")} action={emptyAction} icon={<FileSearch size={26} />} />;
  return <div className="table-scroll" tabIndex={0} aria-label={t("allScans")}><table className="scan-table"><thead><tr><th scope="col">{t("source")}</th><th scope="col">{t("platform")}</th><th scope="col">{t("score")}</th><th scope="col">{t("status")}</th><th scope="col">{t("created")}</th><th scope="col"><span className="sr-only">{t("action")}</span></th></tr></thead>
    <tbody>{scans.map((scan) => <tr key={scan.id}>
      <td><button className="source-button" onClick={() => openScan(scan.id)}><PlatformIcon platform={scan.platform} size="small" /><span><strong>{scan.title || sourceLabel(scan)}</strong><small>{scan.url || t("manual")}</small></span></button></td>
      <td><span className="capitalize muted">{scan.platform === "manual" ? t("manual") : scan.platform}</span></td>
      <td><ScanRiskBadge scan={scan} showScore /><span className="table-pattern">{scan.status === "completed" && categoryText(scan.category, t)}</span>{isPublicTextScan(scan) && <span className="table-pattern" title={t("publicTextCoverage")}>{t("publicTextOnlyShort")}</span>}</td><td><StatusBadge status={scan.status} /></td>
      <td className="time-cell">{dateTime(scan.created_at, locale)}</td>
      <td><button className="icon-button" aria-label={`${t("inspect")}: ${scan.title || scan.id}`} onClick={() => openScan(scan.id)}><ArrowUpRight size={17} /></button></td>
    </tr>)}</tbody></table></div>;
}
