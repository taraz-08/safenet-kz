"use client";
import { useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ArrowUpRight, Download, FileText } from "lucide-react";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/i18n";
import { downloadText, reportSchema } from "@/lib/schema";
import { useWorkspace } from "./providers";
import { Badge, Button, EmptyState, ErrorState, Loading, Modal, Panel } from "./ui";

function ReportPreview({ id }: { id: string }) {
  const { t, openScan } = useWorkspace();
  const query = useQuery({ queryKey: ["report", id], queryFn: ({ signal }) => api(`/reports/${id}`, reportSchema, { signal }) });
  return query.isPending ? <Loading /> : <>{query.isError && <ErrorState error={query.error} retry={() => query.refetch()} />}{query.data && <><div className="detail-actions"><Button variant="primary" onClick={() => downloadText(query.data!.markdown, `safenet-${id}.md`)}><Download size={16} />{t("download")}</Button><Button onClick={() => openScan(query.data!.scan_id)}>{t("inspect")}<ArrowUpRight size={16} /></Button></div><pre className="report-markdown">{query.data.markdown}</pre></>}</>;
}
export function ReportsScreen() {
  const { t, locale } = useWorkspace();
  const [selected, setSelected] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["reports"], queryFn: ({ signal }) => api("/reports", z.object({ items: z.array(reportSchema) }), { signal }), refetchInterval: 10000 });
  return <div className="screen-stack"><p className="muted text-sm">{t("reportsAllModes")}</p><Panel title={t("reports")} aside={query.data && <Badge>{query.data.items.length}</Badge>}>
    {query.isError && <ErrorState error={query.error} retry={() => query.refetch()} stale={!!query.data} />}
    {query.isPending ? <Loading rows={4} /> : query.data && (query.data.items.length ? <div className="report-list">{query.data.items.map((report) => <article className="report-row" key={report.id}><div className="report-icon"><FileText size={22} /></div><div className="report-info"><button onClick={() => setSelected(report.id)}>{report.title}</button><div><time>{dateTime(report.created_at, locale)}</time><span className="mono">#{report.scan_id.slice(0, 8)}</span>{/^Mode: (live|demo)$/m.exec(report.markdown)?.[1] && <Badge>{/^Mode: (live|demo)$/m.exec(report.markdown)![1].toUpperCase()}</Badge>}</div></div><Button onClick={() => downloadText(report.markdown, `safenet-${report.id}.md`)} aria-label={`${t("download")}: ${report.title}`}><Download size={16} /><span className="desktop-label">Markdown</span></Button><Button variant="ghost" onClick={() => setSelected(report.id)} aria-label={t("preview")}><ArrowUpRight size={18} /></Button></article>)}</div> : <EmptyState title={t("noReports")} description={t("noReportsDesc")} icon={<FileText size={28} />} action={<Link className="button button-primary" href="/detections">{t("viewAll")}</Link>} />)}
  </Panel><Modal open={!!selected} onOpenChange={(open) => !open && setSelected(null)} title={t("preview")} wide>{selected && <ReportPreview id={selected} />}</Modal></div>;
}
