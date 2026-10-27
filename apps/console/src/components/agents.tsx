"use client";
import { useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { Activity, ArrowUpRight, Pause, Play, RotateCcw, Settings2, Terminal } from "lucide-react";
import Link from "next/link";
import { api, json } from "@/lib/api";
import { agentIds, agentSchema, logsSchema, safeHref, type Agent } from "@/lib/schema";
import { dateTime, statusText } from "@/lib/i18n";
import { useAction, useWorkspace } from "./providers";
import { Badge, Button, EmptyState, ErrorState, Loading, Modal, Panel, PermissionNotice, PlatformIcon, StatusBadge } from "./ui";

const agentsSchema = z.object({ items: z.array(agentSchema) });
export function useAgents() { return useQuery({ queryKey: ["agents"], queryFn: ({ signal }) => api("/agents", agentsSchema, { signal }), refetchInterval: 5000 }); }

function ConfigureAgent({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const { t, canManage, mode } = useWorkspace();
  const [seeds, setSeeds] = useState(agent.seeds.join("\n"));
  const [interval, setInterval] = useState(String(agent.interval_seconds));
  const [error, setError] = useState("");
  const { pending, run } = useAction();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const urls = [...new Set(seeds.split("\n").map((s) => s.trim()).filter(Boolean))];
    if (urls.some((url) => !safeHref(url) || url.length > 2048)) { setError(t("invalidUrl")); return; }
    const seconds = Number(interval);
    if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400) return;
    const result = await run(() => api(`/agents/${agent.id}`, agentSchema, json("PATCH", { seeds: urls, interval_seconds: seconds })), t("saved"));
    if (result) onClose();
  };
  return <form onSubmit={submit} className="form-stack"><label className="field"><span>{t("seeds")}</span><textarea rows={6} value={seeds} onChange={(e) => { setSeeds(e.target.value); setError(""); }} placeholder={agent.platform === "telegram" ? "https://t.me/s/channel" : `https://${agent.platform === "threads" ? "www.threads.net" : `www.${agent.platform}.com`}/…`} aria-invalid={!!error} aria-describedby="seed-help" /><small id="seed-help">{t("seedsHelp")}</small></label>
    <label className="field"><span>{t("interval")}</span><input type="number" min={60} max={86400} step={1} required value={interval} onChange={(e) => setInterval(e.target.value)} /><small>60–86 400</small></label>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions"><Button onClick={onClose}>{t("cancel")}</Button><Button type="submit" variant="primary" busy={pending} disabled={!canManage || mode !== "live"}>{t("save")}</Button></div>
  </form>;
}

export function AgentLogs({ id, compact = false }: { id: string; compact?: boolean }) {
  const { t, locale } = useWorkspace();
  const query = useQuery({ queryKey: ["agent-logs", id], queryFn: ({ signal }) => api(`/agents/${id}/logs`, logsSchema, { signal }), refetchInterval: 4000 });
  return <div className={compact ? "log-compact" : "log-full"}>{query.isPending ? <Loading /> : <>
    {query.isError && <ErrorState error={query.error} retry={() => query.refetch()} stale={!!query.data} />}
    {query.data && (query.data.items.length ? <ol className="activity-log">{query.data.items.slice(0, compact ? 6 : 100).map((log) => <li key={log.id}><span className="log-marker" /><div><div className="log-meta"><span>{log.stage}</span><time dateTime={log.at}>{dateTime(log.at, locale, true)}</time></div><p>{log.message}</p>{log.task_id && <small className="mono muted">{log.task_id}</small>}</div></li>)}</ol> : <EmptyState compact title={t("noLogs")} description={t("logDesc")} icon={<Terminal size={24} />} />)}
  </>}</div>;
}
export function AgentCard({ agent, id, compact = false }: { agent?: Agent; id: string; compact?: boolean }) {
  const { t, mode, canManage, locale } = useWorkspace();
  const [dialog, setDialog] = useState<"config" | "logs" | null>(null);
  const { run, pending } = useAction();
  const action = (verb: "start" | "stop" | "restart") => run(() => api(`/agents/${id}/${verb}`, agentSchema, json("POST")), t("done"));
  const running = agent?.enabled && ["queued", "running", "idle"].includes(agent.status);
  const disabled = !agent || !canManage || mode !== "live";
  return <article className={`agent-card ${compact ? "agent-compact" : ""}`}>
    <div className="agent-heading"><PlatformIcon platform={id} /><div><h3>{agent?.name || `${id === "tiktok" ? "TikTok" : id === "youtube" ? "YouTube" : id === "instagram" ? "Instagram" : id === "telegram" ? "Telegram" : "Threads"} Monitor`}</h3><span className="agent-id">{id.toUpperCase()} / {t("browser")}</span></div>{agent && <StatusBadge status={agent.status} />}</div>
    {agent ? <>
      <div className="agent-stage"><Activity size={14} /><span>{agent.stage ? statusText(agent.stage, t) : (agent.seeds.length ? t("idle") : t("noSeeds"))}</span></div>
      {agent.last_error && <p className="agent-error">{agent.last_error}</p>}
      {!compact && <><div className="agent-stats"><div><span>{t("checked")}</span><strong>{agent.checked.toLocaleString(locale)}</strong></div><div><span>{t("flagged")}</span><strong className="amber-text">{agent.flagged.toLocaleString(locale)}</strong></div><div><span>{t("seeds")}</span><strong>{agent.seeds.length}</strong></div></div>
        <dl className="agent-times"><div><dt>{t("lastRun")}</dt><dd>{dateTime(agent.last_run_at, locale)}</dd></div><div><dt>{t("nextRun")}</dt><dd>{dateTime(agent.next_run_at, locale)}</dd></div></dl>
        <div className="agent-controls"><Button variant={running ? "secondary" : "primary"} disabled={disabled || (!running && !agent.seeds.length)} busy={pending} onClick={() => action(running ? "stop" : "start")}>{running ? <Pause size={15} /> : <Play size={15} />}{t(running ? "stop" : "start")}</Button><Button disabled={disabled || !agent.seeds.length} onClick={() => action("restart")} busy={pending} aria-label={`${t("restart")} ${agent.name}`}><RotateCcw size={15} /></Button><Button variant="ghost" onClick={() => setDialog("config")} disabled={disabled} aria-label={`${t("configure")} ${agent.name}`}><Settings2 size={16} /></Button><Button variant="ghost" onClick={() => setDialog("logs")}><Terminal size={15} />{t("logs")}</Button></div>
        <div className="agent-footer"><Link href={`/detections?platform=${encodeURIComponent(id)}`}>{t("viewAll")}<ArrowUpRight size={14} /></Link></div>
      </>}
    </> : <p className="agent-stage muted">{t("noAgent")}</p>}
    <Modal open={dialog === "config"} onOpenChange={(open) => !open && setDialog(null)} title={`${t("configure")} · ${agent?.name || id}`} description={t("publicOnly")}>{agent && dialog === "config" && <ConfigureAgent agent={agent} onClose={() => setDialog(null)} />}</Modal>
    <Modal open={dialog === "logs"} onOpenChange={(open) => !open && setDialog(null)} title={`${t("logs")} · ${agent?.name || id}`} description={t("logDesc")}>{dialog === "logs" && <AgentLogs id={id} />}</Modal>
  </article>;
}
export function AgentsScreen() {
  const { t, mode, canManage } = useWorkspace();
  const query = useAgents();
  const { run, pending } = useAction();
  const all = (verb: "start" | "stop") => run(() => api(`/agents/${verb}`, agentsSchema, json("POST")), t("done"));
  return <div className="screen-stack"><PermissionNotice />
    <div className="toolbar"><p className="muted text-sm">{t("publicOnly")}</p><div className="toolbar-actions"><Button variant="primary" disabled={!canManage || mode !== "live" || !query.data} busy={pending} onClick={() => all("start")}><Play size={15} />{t("startAll")}</Button><Button disabled={!canManage || mode !== "live" || !query.data} busy={pending} onClick={() => all("stop")}><Pause size={15} />{t("stopAll")}</Button></div></div>
    {mode === "demo" && <div className="notice">{t("agentsLiveOnly")}</div>}
    {query.isError && <ErrorState error={query.error} retry={() => query.refetch()} stale={!!query.data} />}
    {query.isPending ? <Loading rows={agentIds.length} /> : <div className="agent-grid">{agentIds.map((id) => <AgentCard key={id} id={id} agent={query.data?.items.find((agent) => agent.id === id)} />)}</div>}
  </div>;
}
export function MonitoringScreen() {
  const { t, overview, mode } = useWorkspace();
  const query = useAgents();
  const [selected, setSelected] = useState<string>("tiktok");
  return <div className="screen-stack">{mode === "demo" && <div className="notice">{t("agentsLiveOnly")}</div>}
    {query.isError && <ErrorState error={query.error} retry={() => query.refetch()} stale={!!query.data} />}
    <div className="fleet-grid">{agentIds.map((id) => <AgentCard key={id} id={id} agent={query.data?.items.find((a) => a.id === id)} compact />)}</div>
    <Panel title={t("logs")} aside={<Badge tone={overview.connection === "live" ? "running" : "neutral"}>{t(overview.connection === "live" ? "connectLive" : "connectPolling")}</Badge>}>
      <div className="segmented log-tabs" aria-label={t("platform")}>{agentIds.map((id) => <button key={id} aria-pressed={selected === id} onClick={() => setSelected(id)} className="capitalize">{id}</button>)}</div>
      <AgentLogs key={selected} id={selected} />
    </Panel>
  </div>;
}
