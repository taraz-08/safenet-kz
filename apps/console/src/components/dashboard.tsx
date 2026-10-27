"use client";
import Link from "next/link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { ArrowRight, Bot, CircleAlert, Files, ScanLine, Search, ShieldAlert } from "lucide-react";
import { api } from "@/lib/api";
import { agentIds, levels, scanSchema } from "@/lib/schema";
import { levelText } from "@/lib/i18n";
import { AgentCard } from "./agents";
import { RiskChart, TrendChart } from "./charts";
import { useWorkspace } from "./providers";
import { Button, EmptyState, ErrorState, Loading, Panel } from "./ui";
import { ScanTable } from "./scan-table";

export const scanListSchema = z.object({ items: z.array(scanSchema), total: z.number() });
export function Metrics() {
  const { t, overview, locale } = useWorkspace();
  const data = overview.data?.totals;
  const cards = [
    { label: "scanned", detail: "persisted", value: data?.scanned, icon: Files, tone: "mint" },
    { label: "suspicious", detail: "humanReview", value: data?.suspicious, icon: ShieldAlert, tone: "amber" },
    { label: "critical", detail: "priority", value: data?.critical, icon: CircleAlert, tone: "rose" },
    { label: "activeAgents", detail: "configured", value: data?.active_agents, icon: Bot, tone: "blue" },
  ] as const;
  return <div className="metrics-grid">{cards.map((card) => <div className={`metric-card metric-${card.tone}`} key={card.label}><div className="metric-label"><span>{t(card.label)}</span><card.icon size={18} /></div><strong className="metric-value">{card.value === undefined ? <span className={overview.isPending ? "skeleton metric-skeleton" : ""}>{overview.isPending ? "" : "—"}</span> : card.value.toLocaleString(locale)}{card.label === "activeAgents" && card.value !== undefined && <small> / {overview.data?.agents.length ?? agentIds.length}</small>}</strong><span className="metric-detail"><i />{card.value === undefined && !overview.isPending ? t("unknown") : t(card.detail)}</span></div>)}</div>;
}
export function OverviewScreen({ analytics = false }: { analytics?: boolean }) {
  const { overview, t } = useWorkspace();
  const data = overview.data;
  return <div className="screen-stack">
    {overview.isError && <ErrorState error={overview.error} retry={() => overview.refetch()} stale={!!data} />}
    <Metrics />
    {overview.isPending && <Loading rows={3} />}
    {data && <><div className="charts-grid"><TrendChart data={data.timeline} /><RiskChart data={data.distribution} /></div>
      {!analytics && <><section className="fleet-section"><div className="section-heading"><h2><span className="live-dot" />{t("browserFleet")}</h2><Link href="/agents">{t("manage")}<ArrowRight size={14} /></Link></div><div className="fleet-grid">{agentIds.map((id) => <AgentCard key={id} id={id} agent={data.agents.find((agent) => agent.id === id)} compact />)}</div></section>
      <Panel title={t("recent")} aside={<Link className="text-link" href="/detections">{t("viewAll")}<ArrowRight size={14} /></Link>}><ScanTable scans={data.recent} emptyAction={<Link href="/scanner" className="button button-primary"><ScanLine size={16} />{t("analyze")}</Link>} /></Panel></>}
      {analytics && <Panel title={t("allScans")} description={t("persisted")}><ScanTable scans={data.recent} emptyAction={<Link href="/scanner" className="button button-primary">{t("analyze")}</Link>} /></Panel>}
    </>}
  </div>;
}
export function DetectionsScreen() {
  const { t, mode } = useWorkspace();
  const params = useSearchParams();
  const [platform, setPlatform] = useState(params.get("platform") || "");
  const [level, setLevel] = useState("");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const limit = 25;
  const query = useQuery({ queryKey: ["scans", mode, platform, level, offset], queryFn: ({ signal }) => api(`/scans?${new URLSearchParams({ mode, platform, level, offset: String(offset), limit: String(limit) })}`, scanListSchema, { signal }), refetchInterval: 5000 });
  const visible = query.data?.items.filter((scan) => `${scan.title} ${scan.url} ${scan.text} ${scan.category || ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())) || [];
  const reset = () => { setPlatform(""); setLevel(""); setSearch(""); setOffset(0); };
  return <div className="screen-stack"><Panel><div className="filter-bar"><label className="search-field"><Search size={17} /><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t("search")} aria-label={t("search")} /></label><label className="sr-only" htmlFor="platform-filter">{t("platform")}</label><select id="platform-filter" value={platform} onChange={(e) => { setPlatform(e.target.value); setOffset(0); }}><option value="">{t("allPlatforms")}</option>{[...agentIds, "web", "manual"].map((item) => <option key={item} value={item}>{item === "manual" ? t("manual") : item}</option>)}</select><label className="sr-only" htmlFor="risk-filter">{t("score")}</label><select id="risk-filter" value={level} onChange={(e) => { setLevel(e.target.value); setOffset(0); }}><option value="">{t("allLevels")}</option>{levels.map((item) => <option key={item} value={item}>{levelText(item, t)}</option>)}</select></div>
    {query.isError && <ErrorState error={query.error} retry={() => query.refetch()} stale={!!query.data} />}
    {query.isPending ? <Loading rows={5} /> : query.data && (visible.length || !(platform || level || search) ? <ScanTable scans={visible} emptyAction={<Link href="/scanner" className="button button-primary">{t("analyze")}</Link>} /> : <EmptyState title={t("noResults")} action={<Button onClick={reset}>{t("resetFilters")}</Button>} />)}
    {query.data && <div className="pagination"><span>{t("total")}: <strong>{query.data.total}</strong> · {t("page")} {Math.floor(offset / limit) + 1}</span><div><Button onClick={() => setOffset(Math.max(0, offset - limit))} disabled={offset === 0}>{t("previous")}</Button><Button onClick={() => setOffset(offset + limit)} disabled={offset + limit >= query.data.total}>{t("next")}</Button></div></div>}
  </Panel></div>;
}
