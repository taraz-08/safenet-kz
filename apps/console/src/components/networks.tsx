"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { ArrowRight, GitFork, Link2, Network, RefreshCw, ScanLine, ShieldCheck, Users } from "lucide-react";
import { api } from "@/lib/api";
import { dateTime } from "@/lib/i18n";
import { networkCopy } from "@/lib/networks-i18n";
import { networksSchema, type NetworkNode, type NetworkEdge } from "@/lib/networks";
import { useWorkspace } from "./providers";
import { Badge, Button, EmptyState, ErrorState, ExternalLink, Loading, Panel, PlatformIcon, RiskBadge } from "./ui";

function ConnectionMap({ nodes, edges, selected, select }: { nodes: NetworkNode[]; edges: NetworkEdge[]; selected: string; select: (id: string) => void }) {
  const marker = useId().replace(/:/g, "");
  const { locale } = useWorkspace();
  const c = networkCopy(locale);
  const linked = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  const visible = nodes.filter((node) => linked.has(node.id)).slice(0, 32);
  const positions = new Map(visible.map((node, i) => {
    const angle = i / visible.length * Math.PI * 2 - Math.PI / 2;
    return [node.id, { x: 380 + Math.cos(angle) * 255, y: 230 + Math.sin(angle) * 167 }];
  }));
  const drawn = new Set<string>();
  return <div className="network-map"><svg viewBox="0 0 760 460" role="group" aria-label={c.graph}>
    <title>{c.graph}</title><desc>{c.graphHint}</desc>
    <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="currentColor" /></marker></defs>
    <circle className="network-orbit" cx="380" cy="230" r="105" />
    {edges.map((edge) => {
      const from = positions.get(edge.source), to = positions.get(edge.target);
      const pair = [edge.source, edge.target, edge.kind === "citation" ? "direct" : "shared"].join("|");
      if (!from || !to || drawn.has(pair)) return null;
      drawn.add(pair);
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      const dx = (to.x - from.x) / length * 21, dy = (to.y - from.y) / length * 21;
      return <line key={edge.id} x1={from.x + dx} y1={from.y + dy} x2={to.x - dx} y2={to.y - dy}
        className={`network-line ${edge.kind === "citation" ? "network-direct" : "network-shared"} ${selected && (edge.source === selected || edge.target === selected) ? "network-line-active" : ""}`}
        markerEnd={edge.kind === "citation" ? `url(#${marker})` : undefined} />;
    })}
    {visible.map((node) => {
      const pos = positions.get(node.id)!;
      return <g key={node.id} transform={`translate(${pos.x},${pos.y})`} role="button" tabIndex={0}
        aria-label={`${node.label} · ${node.platform}`} aria-pressed={selected === node.id}
        className={`network-node ${selected === node.id ? "network-node-selected" : ""}`}
        onClick={() => select(selected === node.id ? "" : node.id)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(selected === node.id ? "" : node.id); } }}>
        <title>{node.label} · {node.platform}</title><circle r="19" /><text className="network-node-symbol" textAnchor="middle" y="5">{node.label.slice(1, 2).toUpperCase()}</text>
        <text className="network-node-label" textAnchor={pos.x < 280 ? "end" : pos.x > 480 ? "start" : "middle"} x={pos.x < 280 ? -27 : pos.x > 480 ? 27 : 0} y={pos.x < 280 || pos.x > 480 ? 4 : pos.y < 230 ? -29 : 37}>{node.label.length > 19 ? node.label.slice(0, 17) + "…" : node.label}</text>
      </g>;
    })}
  </svg><div className="network-map-caption"><span><i />{c.citation}</span><span><i className="network-dashed" />{c.promo} / {c.referral}</span><span>{c.shown}: {visible.length} / {linked.size}</span></div></div>;
}

export function NetworksScreen() {
  const { locale, mode, t, openScan } = useWorkspace();
  const c = networkCopy(locale);
  const query = useQuery({ queryKey: ["networks", mode], queryFn: ({ signal }) => api(`/networks?mode=${mode}`, networksSchema, { signal }), refetchInterval: 15000 });
  const [selected, setSelected] = useState("");
  const [page, setPage] = useState(0);
  const [accountPage, setAccountPage] = useState(0);
  const select = (id: string) => { setSelected(id); setPage(0); };
  if (query.isPending) return <Loading rows={4} />;
  if (!query.data) return <ErrorState error={query.error} retry={() => query.refetch()} />;
  const { nodes, edges, summary } = query.data;
  const labels = new Map(nodes.map((node) => [node.id, node.label]));
  const filtered = selected ? edges.filter((edge) => edge.source === selected || edge.target === selected) : edges;
  const pages = Math.max(1, Math.ceil(filtered.length / 10));
  const current = Math.min(page, pages - 1);
  const accountPages = Math.max(1, Math.ceil(nodes.length / 20));
  const currentAccount = Math.min(accountPage, accountPages - 1);
  return <div className="screen-stack">
    {query.isError && <ErrorState error={query.error} stale retry={() => query.refetch()} />}
    <div className="metrics-grid">{[
      { label: c.accounts, value: summary.accounts, Icon: Users, tone: "mint" },
      { label: c.connections, value: summary.connections, Icon: Link2, tone: "blue" },
      { label: c.connected, value: summary.connected_accounts, Icon: GitFork, tone: "amber" },
      { label: c.scans, value: summary.scans_included, Icon: ScanLine, tone: "mint" },
    ].map(({ label, value, Icon, tone }) => <div className={`metric-card metric-${tone}`} key={label}><div className="metric-label"><span>{label}</span><Icon size={18} /></div><strong className="metric-value">{value}</strong><span className="metric-detail">{mode.toUpperCase()}</span></div>)}</div>
    <div className="network-method"><ShieldCheck size={18} /><p>{c.notice}</p></div>
    <Panel title={<><Network size={17} />{c.graph}</>} description={c.graphHint} aside={<Button variant="ghost" busy={query.isFetching} onClick={() => query.refetch()} aria-label={t("refresh")}><RefreshCw size={15} /></Button>}>
      {edges.length ? <ConnectionMap nodes={nodes} edges={edges} selected={selected} select={select} /> : <EmptyState icon={<Network size={28} />} title={nodes.length ? c.noLinks : c.empty} description={mode === "demo" ? c.demoHint : nodes.length ? c.noLinksHint : c.emptyHint} action={<Link className="button button-secondary" href="/scanner"><ScanLine size={16} />{t("analyze")}</Link>} />}
    </Panel>
    {!!edges.length && <Panel title={c.evidence} aside={<label className="network-filter"><span className="sr-only">{c.accounts}</span><select value={selected} onChange={(event) => select(event.target.value)}><option value="">{c.all}</option>{nodes.map((node) => <option key={node.id} value={node.id}>{node.label} · {node.platform}</option>)}</select></label>}>
      {!filtered.length && <EmptyState compact title={c.noLinks} />}
      <div className="network-evidence">{filtered.slice(current * 10, current * 10 + 10).map((edge) => <article key={edge.id} className="network-evidence-card">
        <div className="network-edge-heading"><strong>{labels.get(edge.source)}</strong>{edge.kind === "citation" ? <ArrowRight size={15} /> : <Link2 size={15} />}<strong>{labels.get(edge.target)}</strong><Badge tone={edge.kind === "citation" ? "low" : "medium"}>{c[edge.kind]}</Badge></div>
        <code className="network-match">{edge.value}</code>
        <div className="network-citations">{edge.citations.map((citation) => <div key={`${citation.scan_id}-${citation.account_id}`}>
          <div className="network-citation-heading"><span>{labels.get(citation.account_id)}</span>{citation.provenance === "historical_public" && <Badge>{c.historical}</Badge>}{citation.captured_at && <time dateTime={citation.captured_at}>{dateTime(citation.captured_at, locale)}</time>}</div>
          <blockquote>{citation.quote}</blockquote><div className="network-citation-actions"><Button variant="secondary" onClick={() => openScan(citation.scan_id)}>{c.openScan}</Button><ExternalLink href={citation.source_url}>{c.source}</ExternalLink></div>
        </div>)}</div>
      </article>)}</div>
      {pages > 1 && <div className="network-pagination"><Button disabled={current === 0} onClick={() => setPage(current - 1)}>{c.previous}</Button><span>{c.page} {current + 1} / {pages}</span><Button disabled={current + 1 >= pages} onClick={() => setPage(current + 1)}>{c.next}</Button></div>}
    </Panel>}
    {!!nodes.length && <Panel title={c.accounts}><div className="table-scroll"><table className="scan-table"><thead><tr><th>{c.accounts}</th><th>{c.latestScore}</th><th>{c.captures}</th><th>{c.openScan}</th></tr></thead><tbody>{nodes.slice(currentAccount * 20, currentAccount * 20 + 20).map((node) => <tr key={node.id}><td><div className="network-account"><PlatformIcon platform={node.platform} size="small" /><ExternalLink href={node.url}>{node.label}</ExternalLink>{node.provenance === "historical_public" && <Badge>{c.historical}</Badge>}</div></td><td>{node.score === 0 ? <Badge>{c.noRuleSignals}</Badge> : <RiskBadge score={node.score} level={node.level} />}</td><td>{node.scan_count}</td><td><Button variant="ghost" onClick={() => openScan(node.scan_id)}>{c.openScan}</Button></td></tr>)}</tbody></table></div>
      {accountPages > 1 && <div className="network-pagination"><Button disabled={currentAccount === 0} onClick={() => setAccountPage(currentAccount - 1)}>{c.previous}</Button><span>{c.page} {currentAccount + 1} / {accountPages}</span><Button disabled={currentAccount + 1 >= accountPages} onClick={() => setAccountPage(currentAccount + 1)}>{c.next}</Button></div>}
    </Panel>}
    <p className="network-window">{c.window} {summary.scans_considered} / {summary.scan_limit}{(summary.window_full || summary.edges_truncated) && <> · {c.capped}</>}</p>
  </div>;
}
